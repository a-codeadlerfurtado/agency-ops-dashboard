"use client";

/**
 * Dono unico dos dados de triagem.
 *
 * Antes existiam DOIS consumidores independentes -- MaterialTriageBridge e
 * dashboard-native -- cada um com fetch inicial proprio, canal Realtime proprio
 * e listener de visibilidade proprio. Uma aba aberta fazia tudo em dobro.
 * Trocar polling por Realtime sem unificar apenas trocou "polling duplicado"
 * por "Realtime duplicado".
 *
 * Aqui a assinatura, o fetch e o refresh vivem UMA vez por aba, com contagem de
 * referencia: o primeiro componente que monta liga o canal, o ultimo a
 * desmontar desliga. Os componentes so' leem o estado.
 *
 * Sem setInterval de rede. O relogio visual de cada componente continua local.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-material-triage-api`;
const TIMEOUT_MS = 12_000;
/** Rajada de mudancas vira UM refresh. */
const COALESCE_MS = 400;

type Estado = { items: Row[]; error: string; carregado: boolean; person: string; role: string };

let estado: Estado = { items: [], error: "", carregado: false, person: "", role: "" };
const ouvintes = new Set<() => void>();
let referencias = 0;
let canal: ReturnType<typeof supabase.channel> | null = null;
let sessionAtiva: Session | null = null;
let emVoo = false;
let timerCoalesce: number | null = null;
let removerVisibilidade: (() => void) | null = null;

function publicar(patch: Partial<Estado>) {
  estado = { ...estado, ...patch };
  for (const f of ouvintes) f();
}

function mensagemDeFalha(caught: unknown): string {
  const nome = caught instanceof Error ? caught.name : "";
  if (nome === "TimeoutError" || nome === "AbortError") {
    return "A triagem demorou para responder. Vou tentar de novo no próximo evento.";
  }
  return caught instanceof Error ? caught.message : "Falha ao atualizar triagem.";
}

/** Um fetch por vez. Chamada concorrente e' descartada, nao enfileirada. */
async function carregar(): Promise<void> {
  const token = sessionAtiva?.access_token;
  if (!token || emVoo) return;
  emVoo = true;
  try {
    const r = await fetch(API, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`Triagem ${r.status}`);
    const corpo = await r.json();
    // Falha NAO zera a fila: manter o ultimo estado conhecido e' melhor que
    // piscar uma lista vazia por causa de uma atualizacao que nao voltou.
    publicar({
      items: Array.isArray(corpo?.items) ? corpo.items : estado.items,
      person: String(corpo?.person ?? estado.person),
      role: String(corpo?.role ?? estado.role),
      error: "",
      carregado: true,
    });
  } catch (caught) {
    publicar({ error: mensagemDeFalha(caught), carregado: true });
  } finally {
    emVoo = false;
  }
}

/** Junta uma rajada de eventos num unico refresh. */
function agendarRefresh() {
  if (timerCoalesce !== null) window.clearTimeout(timerCoalesce);
  timerCoalesce = window.setTimeout(() => {
    timerCoalesce = null;
    void carregar();
  }, COALESCE_MS);
}

function ligar(session: Session) {
  sessionAtiva = session;
  void carregar();

  let assinouUmaVez = false;
  canal = supabase
    .channel(`material-triage:${session.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "material_triage_signal" }, agendarRefresh)
    .subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      // A primeira assinatura nao refaz o fetch -- `ligar` acabou de fazer um.
      // Reassinaturas (queda de WebSocket) SIM: enquanto estava fora do ar
      // podem ter chegado eventos que ninguem recebeu.
      if (assinouUmaVez) agendarRefresh();
      assinouUmaVez = true;
    });

  const aoVoltar = () => { if (document.visibilityState === "visible") agendarRefresh(); };
  document.addEventListener("visibilitychange", aoVoltar);
  window.addEventListener("focus", aoVoltar);
  removerVisibilidade = () => {
    document.removeEventListener("visibilitychange", aoVoltar);
    window.removeEventListener("focus", aoVoltar);
  };
}

function desligar() {
  if (timerCoalesce !== null) { window.clearTimeout(timerCoalesce); timerCoalesce = null; }
  removerVisibilidade?.();
  removerVisibilidade = null;
  if (canal) { void supabase.removeChannel(canal); canal = null; }
  sessionAtiva = null;
}

function inscrever(ouvinte: () => void, session: Session): () => void {
  ouvintes.add(ouvinte);
  referencias += 1;
  if (referencias === 1) ligar(session);
  return () => {
    ouvintes.delete(ouvinte);
    referencias -= 1;
    if (referencias === 0) desligar();
  };
}

const lerEstado = () => estado;

/** Snapshot estavel para o servidor: nada de Realtime na renderizacao do SSR. */
const ESTADO_SSR: Estado = { items: [], error: "", carregado: false, person: "", role: "" };

export function useMaterialTriage(session: Session) {
  const subscribe = useCallback((ouvinte: () => void) => inscrever(ouvinte, session), [session]);
  const estadoAtual = useSyncExternalStore(subscribe, lerEstado, () => ESTADO_SSR);
  const atualizar = useCallback(() => { void carregar(); }, []);
  return { ...estadoAtual, atualizar };
}

export type AcaoTriagem = "CLAIM" | "OPENED" | "SNOOZE" | "COMPLETE" | "RELEASE" | "ACKNOWLEDGE";

/**
 * Executa uma acao e aplica a lista devolvida pela API.
 *
 * A resposta do POST ja traz `items` atualizado, entao o item some da tela na
 * hora -- sem esperar o proximo evento de Realtime.
 */
export async function executarAcao(
  session: Session,
  item: Row,
  acao: AcaoTriagem,
  extra: Row = {},
): Promise<{ ok: boolean; erro?: string }> {
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: item.id, action: acao, ...extra }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 409 && corpo?.claimed_by) throw new Error(`${corpo.claimed_by} já assumiu este material.`);
      // Erro interno do banco nao vai cru para a tela: WORK_ITEM_ASSIGNEE_ROLE_MISMATCH
      // nao diz nada para quem esta usando.
      throw new Error(corpo?.error === "internal_error" ? "Não foi possível concluir a ação agora." : (corpo?.detail || corpo?.error || `Triagem ${r.status}`));
    }
    if (Array.isArray(corpo?.items)) publicar({ items: corpo.items, error: "" });
    else agendarRefresh();
    return { ok: true };
  } catch (caught) {
    const erro = mensagemDeFalha(caught);
    publicar({ error: erro });
    return { ok: false, erro };
  }
}
