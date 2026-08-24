"use client";

// Camada compartilhada: constantes, tipos, formatadores e primitivas visuais.
// Estava tudo no mesmo arquivo de 1600 linhas que as telas tambem ocupam, entao
// qualquer ajuste de layout disputava o mesmo arquivo com qualquer ajuste de
// formatacao. Aqui fica o que todo mundo importa e quase ninguem edita.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
export const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api`;
export const CONTRACTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-contracts-api`;
export const CLICKUP_API_URL = `${SUPABASE_URL}/functions/v1/clickup-sync-api`;
export const CS_CLIENTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-cs-clients-api`;
export const WORK_ITEM_CREATE_API = `${SUPABASE_URL}/functions/v1/agency-ops-work-item-create-api`;
const HOME_PROXY_URL = "/api/dashboard-home";
const HOME_REQUEST_TIMEOUT_MS = 15_000;
// Backend da IA roda na VPS Hostinger, atras do mesmo dominio do Dashboard.
// Same-origin de proposito: nenhum preflight de CORS e nenhuma credencial
// privilegiada precisa transitar pelo navegador.
export const AI_API_BASE = "/api/ai";
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// O dashboard aceita a mesma conta em mais de um computador. O logout padrao do
// Supabase pode revogar outras sessoes; aqui qualquer signOut() sem escopo passa a
// encerrar somente esta sessao/browser. Chamadas que precisem explicitamente de outro
// escopo ainda podem informa-lo normalmente.
const rawSignOut = supabase.auth.signOut.bind(supabase.auth);
supabase.auth.signOut = ((options?: Parameters<typeof rawSignOut>[0]) => rawSignOut(options ?? { scope: "local" })) as typeof supabase.auth.signOut;

export type Row = Record<string, any>;
export type TeamMember = {
  person: string;
  role: "GT" | "CS" | "DESIGN" | "AI" | "MGMT" | "UNASSIGNED" | "FORMER";
  in_roster: boolean;
  is_former: boolean;
  former_reason: string | null;
  clickup_user: string | null;
  carteira: string | null;
  missing_clickup_link: boolean;
  clients_active: number;
  clients_onboarding: number;
  tasks_done: number;
  tasks_open: number;
  tasks_overdue: number;
  tasks_done_30d: number;
  clients_touched: number;
  tasks_created_total: number;
  tasks_created_30d: number;
  portfolio: Array<{ client_id: string; display_name: string; priority: "ATTENTION" | "FOLLOW_UP" | "OK" | "DATA_INCOMPLETE" | "UNDETERMINED" | null; lifecycle: "ACTIVE" | "ONBOARDING"; next_step: string | null }>;
};
export type HomeData = {
  kpis: Row;
  clients: Row[];
  alerts: Row[];
  commitments?: Row[];
  conversations?: Row[];
  media: Row;
  health: Row;
  operations?: Row;
  clickup?: Row;
  campaigns?: Row[];
  notifications?: Row[];
  preclients?: Row[];
  won_events?: Row[];
  audit_runs?: Row[];
  audit_issues?: Row[];
  preferences?: Row;
  integration_health?: Row[];
  team?: TeamMember[];
  unassigned_clients?: Row[];
  portfolio?: Row | null;
  wallets?: Row[];
  adjustments?: Row[];
  stage_labels?: Record<string, string>;
  profile?: Row;
  access_requests_pending?: Row[];
  generated_at: string;
};

export type View = "overview" | "focus" | "work" | "clients" | "health" | "onboarding" | "campaigns" | "contracts" | "preclients" | "conversations" | "team" | "diary" | "clickup" | "evidence" | "audit" | "alerts" | "opsperf" | "creative";

export const pt: Record<string,string> = { ATTENTION:"Atenção",FOLLOW_UP:"Acompanhamento",UNDETERMINED:"Indeterminado",DATA_INCOMPLETE:"Dados incompletos",OK:"OK",ACTIVE:"Ativo",ONBOARDING:"Onboarding",CHURNED:"Churned",COMPLETE:"Completa",PARTIAL:"Parcial",INCOMPLETE:"Incompleta",SUCCESS:"Sucesso",ERROR:"Erro",RUNNING:"Em execução",OPEN:"Aberto",IN_PROGRESS:"Em andamento",WAITING:"Aguardando",SNOOZED:"Adiado",COMPLETED:"Concluído",DISMISSED:"Descartado",ABORTED:"Encerrado",CRITICAL:"Crítico",HIGH:"Alto",MEDIUM:"Médio",LOW:"Baixo",CONNECTED:"Conectado",CONECTADO:"Conectado",ESCALATION:"Escalonamento",CREATIVE_REQUEST:"Solicitação criativa",TECHNICAL:"Problema técnico",CLIENT_FOLLOWUP:"Acompanhamento",CLICKUP:"ClickUp",FINANCE:"Financeiro",GENERAL:"Geral" };

export const priorityRank: Record<string, number> = {
  ATTENTION: 0,
  FOLLOW_UP: 1,
  UNDETERMINED: 2,
  DATA_INCOMPLETE: 3,
  OK: 4,
};

export function formatNumber(value: unknown, digits = 1) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0));
}

export function formatMoney(value: unknown) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

// Simbolo da Leonardo Imobi: o retangulo com a haste esquerda estendida formando o
// "L", e as duas cunhas inclinadas. Inline em SVG para escalar sem arquivo externo.
export function BrandMark() {
  return <svg viewBox="0 0 276 390" role="img" aria-label="Leonardo Imobi" fill="none">
    <rect x="6.5" y="6.5" width="263" height="252" stroke="currentColor" strokeWidth="13" />
    <rect x="0" y="252" width="13" height="138" fill="currentColor" />
    <polygon points="68,223 276,247 276,253 68,253" fill="currentColor" />
    <polygon points="0,377 208,343 208,390 0,390" fill="currentColor" />
  </svg>;
}

export function formatDay(value: unknown) {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const [y, m, d] = raw.split("-").map(Number);
  if (!y || !m || !d) return raw;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(y, m - 1, d));
}

export function formatDate(value: unknown) {
  if (!value) return "sem registro";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
}

export function relativeDate(value: unknown) {
  if (!value) return "sem prazo";
  const days = Math.ceil((new Date(String(value)).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d atrasado`;
  if (days === 0) return "vence hoje";
  return `em ${days}d`;
}

export function daysSince(value: unknown) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(String(value)).getTime()) / 86_400_000));
}

export function healthScore(client: Row) {
  if (client.health?.score != null) return Math.round(Number(client.health.score));
  let score = 100;
  if (client.priority === "ATTENTION") score -= 42;
  if (client.priority === "FOLLOW_UP") score -= 22;
  if (["DATA_INCOMPLETE", "UNDETERMINED"].includes(client.priority)) score -= 16;
  score -= Math.min(24, Number(client.overdue_commitments || 0) * 8);
  score -= Math.min(18, Number(client.open_complaints || 0) * 9);
  if (client.data_coverage !== "COMPLETE") score -= 10;
  return Math.max(0, score);
}

// Painel sobreposto precisa prender o foco. Sem isso o Tab continua passeando pelo
// conteudo atras do painel: quem usa teclado perde a referencia de onde esta, e o
// leitor de tela le' a pagina inteira em vez do dialogo. Ao fechar, o foco volta
// para o elemento que abriu.
export function useDialogFocus(close: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    const focaveis = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((el) => el.offsetParent !== null);
    focaveis()[0]?.focus();
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") { evento.stopPropagation(); close(); return; }
      if (evento.key !== "Tab") return;
      const itens = focaveis();
      if (!itens.length) return;
      const primeiro = itens[0], ultimo = itens[itens.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener("keydown", aoTeclar);
    return () => { document.removeEventListener("keydown", aoTeclar); anterior?.focus?.(); };
  }, [close]);
  return ref;
}

// Alguns campos chegam com marcador interno do coletor, tipo
// "[SEM TEXTO RECONHECIDO - VER RAW_JSON]". Isso e' recado de sistema, nao assunto
// do cliente: quem le' a lista precisa de contexto, nao de um ponteiro para o log.
export const MARCADOR_INTERNO = /^\s*\[?\s*(sem texto reconhecido|ver raw_json|raw_json|sem conte[uú]do|sem texto|null|undefined)\b/i;
export function text(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value).trim();
  if (MARCADOR_INTERNO.test(raw)) return "Sem assunto identificado";
  return raw;
}

export function initials(value: unknown) {
  return String(value || "CO").trim().split(/\s+/).map((part) => part[0]).slice(0,2).join("").toUpperCase();
}

// Todas as chamadas autenticadas passam por esta camada. O token recebido pelos
// componentes serve apenas para compatibilidade com as assinaturas antigas; antes de
// sair para a rede consultamos a sessao atual do Supabase. Assim, uma aba antiga que
// ficou com um access token em um closure para imediatamente de bater nas APIs depois
// de logout. Se o access token apenas venceu, fazemos UM refresh compartilhado e
// repetimos a requisicao uma unica vez.
let refreshSessionPromise: Promise<string | null> | null = null;
let homeRequestPromise: Promise<Response> | null = null;

export class SessionExpiredError extends Error {
  code = "SESSION_EXPIRED";
  constructor() { super("Sessão encerrada. Entre novamente para continuar."); this.name = "SessionExpiredError"; }
}

export function isSessionExpiredError(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError || (error instanceof Error && (error as any).code === "SESSION_EXPIRED");
}

async function liveAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshSessionPromise) {
    refreshSessionPromise = (async () => {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session?.access_token) return null;
      return data.session.access_token;
    })().finally(() => { refreshSessionPromise = null; });
  }
  return refreshSessionPromise;
}

function authHeaders(init: RequestInit, token: string) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("apikey", SUPABASE_ANON_KEY);
  return headers;
}

export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const currentToken = await liveAccessToken();
  if (!currentToken) throw new SessionExpiredError();

  const request = (token: string) => fetch(input, { ...init, headers: authHeaders(init, token) });
  let response = await request(currentToken);
  if (response.status !== 401) return response;

  const refreshedToken = await refreshAccessToken();
  if (!refreshedToken) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    throw new SessionExpiredError();
  }

  response = await request(refreshedToken);
  if (response.status === 401) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    throw new SessionExpiredError();
  }
  return response;
}

async function dashboardHomeRequest(token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), HOME_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(HOME_PROXY_URL, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A Visão Geral não respondeu em 15 segundos.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function dashboardHomeResponse(token: string): Promise<Response> {
  // Gate compartilhado: page, enhancements, gate e sidebar podem pedir a home ao
  // mesmo tempo. Uma única chamada same-origin atende todos e elimina a rajada de
  // preflights concorrentes que deixava o mobile preso em Atualizando.
  if (!homeRequestPromise) {
    homeRequestPromise = (async () => {
      let response = await dashboardHomeRequest(token);
      if (response.status !== 401) return response;

      const refreshedToken = await refreshAccessToken();
      if (!refreshedToken) {
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        throw new SessionExpiredError();
      }

      response = await dashboardHomeRequest(refreshedToken);
      if (response.status === 401) {
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        throw new SessionExpiredError();
      }
      return response;
    })().finally(() => { homeRequestPromise = null; });
  }

  const shared = await homeRequestPromise;
  return shared.clone();
}

export async function api(view: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("view", view);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = view === "home"
    ? await dashboardHomeResponse(token || await liveAccessToken() || "")
    : await authenticatedFetch(url, { cache: "no-store" });

  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  const json = await response.json();

  // CS precisa abrir solicitações para qualquer cliente da operação. O endpoint
  // principal continua com o escopo histórico de CS, então enriquecemos o payload
  // do home por uma rota autenticada específica, sem elevar o perfil inteiro.
  if (view === "home" && json?.profile?.role === "CS") {
    try {
      const clientResponse = await authenticatedFetch(CS_CLIENTS_API, { cache: "no-store" });
      if (clientResponse.ok) {
        const extra = await clientResponse.json();
        if (Array.isArray(extra?.clients)) {
          const currentById = new Map<string, Row>((json.clients || []).map((client: Row) => [String(client.client_id), client] as [string, Row]));
          json.clients = extra.clients.map((client: Row) => ({ ...client, ...(currentById.get(String(client.client_id)) || {}) }));
        }
      }
    } catch {
      // Falha complementar não derruba o dashboard; a API principal continua válida.
    }
  }

  // Defesa em profundidade no navegador: GT nunca recebe na Central de Notificações
  // evento de cliente fora da própria carteira. Notificação sem client_id também não
  // entra para GT, evitando ruído genérico e vazamento entre carteiras. Alertas de
  // saldo seguem exatamente a mesma regra porque também carregam client_id.
  if (view === "home" && json?.profile?.role === "GT") {
    const walletIds = new Set((json.clients || []).map((client: Row) => String(client.client_id)).filter(Boolean));
    json.notifications = (json.notifications || []).filter((item: Row) => item?.client_id && walletIds.has(String(item.client_id)));
  }

  return json;
}

export async function apiPost(view: string, _token: string, body: Row = {}) {
  const endpoint = view === "work-item-create"
    ? WORK_ITEM_CREATE_API
    : `${API_URL}?view=${encodeURIComponent(view)}`;
  const response = await authenticatedFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function clickupAction(action: "register" | "sync", _token: string) {
  if (action === "register") {
    const response = await authenticatedFetch(`${CLICKUP_API_URL}?action=register`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    return body;
  }
  let pageStart = 0;
  const totals = { tasks_seen: 0, tasks_upserted: 0, tasks_closed: 0 };
  for (let batch = 0; batch < 100; batch++) {
    const response = await authenticatedFetch(`${CLICKUP_API_URL}?action=sync&since_days=180&page_start=${pageStart}&max_pages=5`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    totals.tasks_seen += Number(body.tasks_seen || 0);
    totals.tasks_upserted += Number(body.tasks_upserted || 0);
    totals.tasks_closed += Number(body.tasks_closed || 0);
    if (body.next_page == null) return { ...body, ...totals };
    pageStart = Number(body.next_page);
  }
  throw new Error("A importação atingiu o limite de páginas; tente novamente para continuar.");
}

export function Chip({ value }: { value: unknown }) {
  const raw = text(value);
  return <span className={`chip ${raw}`}>{pt[raw] || raw.replaceAll("_", " ")}</span>;
}

export function Metric({ label, value, tone = "", hint = "", loading = false }: { label: string; value: string; tone?: string; hint?: string; loading?: boolean }) {
  return (
    <article className="card metric" aria-busy={loading || undefined}>
      <div className="label">{label}</div>
      {loading
        ? <div className="value"><span className="skeleton skeleton-value" /></div>
        : <div className={`value ${tone}`}>{value}</div>}
      <div className="hint">{loading ? <span className="skeleton skeleton-line" /> : hint}</div>
    </article>
  );
}

// A notificacao de tarefa concluida carrega DUAS pessoas diferentes, e elas ja'
// foram confundidas na tela: quem fechou a task (actor, do evento real de
// mudanca de status no ClickUp) nao e' necessariamente o responsavel (assignee
// da task). Aqui a leitura separa as duas, para o painel nunca mais dizer que o
// responsavel concluiu.
const MARCA_RESPONSAVEL = " · Responsável pela task: ";
export function taskCompletion(item: Row) {
  const description = String(item?.description ?? "");
  const corte = description.indexOf(MARCA_RESPONSAVEL);
  if (corte < 0) return null;
  return {
    tarefa: description.slice(0, corte).trim(),
    responsavel: description.slice(corte + MARCA_RESPONSAVEL.length).trim() || null,
    concluidaPor: item?.actor ? String(item.actor) : null,
  };
}
