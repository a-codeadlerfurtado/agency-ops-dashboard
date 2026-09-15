"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-material-triage-api`;

function age(item: Row, now = Date.now()) {
  const raw = item.metadata?.received_at || item.created_at;
  const at = raw ? new Date(raw).getTime() : now;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  const severity = minutes >= 30 ? "critical" : minutes >= 15 ? "danger" : minutes >= 5 ? "warning" : "fresh";
  const label = minutes < 1 ? "Recebido agora" : minutes >= 30 ? `ESCALADO · ${minutes} min` : minutes >= 15 ? `URGENTE · ${minutes} min` : `Aguardando há ${minutes} min`;
  return { minutes, severity, label };
}

function summary(item: Row) {
  const meta = item.metadata || {};
  const kind = String(meta.triage_kind || "");
  if (kind === "PRODUCT_BRIEFING") return meta.entity_name ? `Briefing de produto · ${meta.entity_name}` : "Briefing de produto";
  if (kind === "PERSONA") return meta.entity_name ? `Persona · ${meta.entity_name}` : "Briefing de persona";
  const parts = [
    Number(meta.photo_count || 0) ? `${meta.photo_count} foto${Number(meta.photo_count) === 1 ? "" : "s"}` : "",
    Number(meta.video_count || 0) ? `${meta.video_count} vídeo${Number(meta.video_count) === 1 ? "" : "s"}` : "",
    Number(meta.document_count || 0) ? `${meta.document_count} arquivo${Number(meta.document_count) === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${Number(meta.item_count || 1)} material${Number(meta.item_count || 1) === 1 ? "" : "is"}`;
}

/** Pausa visual do popup depois de "Adiar 15 min". */
const COOLDOWN_POPUP_MS = 5_000;
/** Teto dos dois fetches da triagem. Sem isso um GET pendurado deixava
 *  loadRef travado em true e os polls seguintes eram ignorados para sempre. */
const TRIAGEM_TIMEOUT_MS = 12_000;

/**
 * Rotulo do botao de sequencia, derivado do dado.
 *
 * Exportado porque o painel de triagem tambem e' renderizado em
 * dashboard-native.tsx. Ate aqui os dois lugares divergiam -- la o texto era
 * fixo "Dar sequencia" e um MutationObserver corrigia depois, no DOM. Esse
 * observer travava a aba (ver comentario no lugar onde ele existia). Uma fonte
 * de verdade, renderizada pelo React nos dois pontos, elimina a necessidade.
 */
export function nextLabel(item: Row) {
  const kind = String(item.metadata?.triage_kind || "");
  if (kind === "PRODUCT_BRIEFING") return "Enviar para produção";
  if (kind === "PERSONA") return "Revisar persona";
  return "Criar demanda criativa";
}

function receivedAt(item: Row) {
  return new Date(item.metadata?.received_at || item.created_at || 0).getTime();
}

function receivedClock(item: Row) {
  const raw = item.metadata?.received_at || item.created_at;
  if (!raw) return "horário não informado";
  return `recebido às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(raw))}`;
}
function priorityRank(item: Row) {
  return ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>)[String(item.priority || "")] ?? 9;
}

/** "signal is aborted without reason" nao ajuda ninguem na tela. */
function mensagemDeFalha(caught: unknown, padrao: string): string {
  const nome = caught instanceof Error ? caught.name : "";
  if (nome === "TimeoutError" || nome === "AbortError") {
    return "A triagem demorou para responder. Tentando de novo no próximo ciclo.";
  }
  return caught instanceof Error ? caught.message : padrao;
}

const STYLE = `
.material-triage-panel{margin-bottom:14px!important;border-color:color-mix(in srgb,var(--blue) 34%,var(--line))!important;background:linear-gradient(145deg,var(--panel),color-mix(in srgb,var(--blue) 5%,var(--panel)))!important}
.material-triage-head-actions,.material-triage-actions,.material-triage-screen-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.material-triage-head-actions .btn{padding:7px 10px;font-size:11px}
.material-triage-error,.material-triage-screen-error{padding:9px 11px;border:1px solid color-mix(in srgb,var(--red) 42%,var(--line));border-radius:9px;background:color-mix(in srgb,var(--red) 9%,transparent);color:var(--red);font-size:11px;margin-bottom:10px}
.material-triage-empty{display:flex;align-items:center;gap:9px;padding:18px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}.material-triage-empty b{color:var(--green)}
.material-triage-list{display:grid;gap:9px}.material-triage-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:13px 14px;border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:12px;background:var(--panel2)}
.material-triage-item.warning{border-left-color:var(--yellow);background:color-mix(in srgb,var(--yellow) 7%,var(--panel2))}.material-triage-item.danger,.material-triage-item.critical{border-left-color:var(--red);background:color-mix(in srgb,var(--red) 7%,var(--panel2))}.material-triage-item.critical{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--red) 20%,transparent)}
.material-triage-item.claimed{border-left-color:var(--green);background:color-mix(in srgb,var(--green) 6%,var(--panel2))}.material-triage-item.snoozed{border-left-color:var(--purple);opacity:.78}.material-triage-main{min-width:0}.material-triage-client b,.material-triage-client span{display:block}.material-triage-client b{font-size:13px}.material-triage-client span{margin-top:4px;color:var(--text);font-size:12px}
.material-triage-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:10.5px;color:var(--muted)}.material-triage-meta strong{color:var(--yellow)}.material-triage-item.danger .material-triage-meta strong,.material-triage-item.critical .material-triage-meta strong{color:var(--red)}.material-triage-item.claimed .material-triage-meta strong{color:var(--green)}
.material-triage-actions{justify-content:flex-end}.material-triage-actions .btn,.material-triage-actions .primary{padding:7px 9px;font-size:10.5px}.material-triage-more{padding:8px 2px 0;color:var(--muted);font-size:11px;text-align:right}
.material-triage-screen{position:fixed;right:24px;bottom:82px;z-index:10020;width:min(470px,calc(100vw - 32px));padding:17px;border:1px solid color-mix(in srgb,var(--blue) 58%,var(--line));border-left:5px solid var(--blue);border-radius:16px;background:color-mix(in srgb,var(--panel) 97%,transparent);backdrop-filter:blur(20px);box-shadow:0 28px 95px rgba(0,0,0,.55);color:var(--text);animation:material-triage-in .28s ease both}
.material-triage-screen.warning{border-left-color:var(--yellow);border-color:color-mix(in srgb,var(--yellow) 52%,var(--line))}.material-triage-screen.danger,.material-triage-screen.critical{border-left-color:var(--red);border-color:color-mix(in srgb,var(--red) 58%,var(--line));background:linear-gradient(135deg,color-mix(in srgb,var(--red) 9%,var(--panel)),var(--panel))}.material-triage-screen.critical{animation:material-triage-critical 1.15s ease-in-out infinite alternate}
.material-triage-screen-kicker{font-size:10px;font-weight:900;letter-spacing:.13em;color:var(--blue)}.material-triage-screen.warning .material-triage-screen-kicker{color:var(--yellow)}.material-triage-screen.danger .material-triage-screen-kicker,.material-triage-screen.critical .material-triage-screen-kicker{color:var(--red)}
.material-triage-screen-title{margin-top:8px;font:800 21px/1.1 "Inter Tight",Inter,sans-serif}.material-triage-screen-summary{margin-top:5px;font-size:13px}.material-triage-screen-meta{display:flex;justify-content:space-between;gap:12px;margin-top:9px;color:var(--muted);font-size:11px}.material-triage-screen-meta strong{color:var(--yellow)}.material-triage-screen.danger .material-triage-screen-meta strong,.material-triage-screen.critical .material-triage-screen-meta strong{color:var(--red)}
.material-triage-screen-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.material-triage-screen-close{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;width:26px;height:26px;line-height:1;font-size:15px;cursor:pointer;flex:none}
.material-triage-screen-close:hover{color:var(--text);border-color:var(--text)}
.material-triage-screen-secondary{margin-top:8px}
.material-triage-ack{border-color:color-mix(in srgb,var(--green) 45%,var(--line))!important;color:var(--green)!important}
.material-triage-screen-actions{margin-top:14px}.material-triage-screen-actions button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;padding:8px 10px;font-size:11px;cursor:pointer}.material-triage-screen-actions button.primary{border-color:var(--accent);background:var(--accent);color:#1a0c02}.material-triage-screen-actions button:disabled{opacity:.5;cursor:default}.material-triage-screen-error{margin:10px 0 0}
@keyframes material-triage-in{from{opacity:0;transform:translateX(24px) scale(.98)}to{opacity:1;transform:none}}@keyframes material-triage-critical{from{box-shadow:0 28px 95px rgba(0,0,0,.55),0 0 0 0 color-mix(in srgb,var(--red) 18%,transparent)}to{box-shadow:0 28px 95px rgba(0,0,0,.55),0 0 0 7px color-mix(in srgb,var(--red) 8%,transparent)}}
@media(max-width:850px){.material-triage-item{grid-template-columns:1fr}.material-triage-actions{justify-content:flex-start}}@media(max-width:650px){.material-triage-screen{left:12px;right:12px;bottom:74px;width:auto}.material-triage-screen-meta{flex-direction:column;gap:4px}.material-triage-screen-actions button{flex:1}.material-triage-head-actions{align-items:flex-start}.material-triage-panel .section-head{gap:9px}}
`;

export default function MaterialTriageBridge({ session }: { session: Session }) {
  const [allowed, setAllowed] = useState(false);
  const [items, setItems] = useState<Row[]>([]);
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  /** Ate quando o popup fica calado depois de um "Adiar". 0 = sem pausa. */
  const [popupCooldownUntil, setPopupCooldownUntil] = useState(0);
  /**
   * Itens cujo POPUP o usuario fechou no X.
   *
   * Dispensa e' LOCAL e so' do popup: nao assume, nao adia, nao conclui e nao
   * altera nada no servidor. O item continua na fila do painel permanente, e o
   * poll seguinte nao o traz de volta para a tela.
   */
  const [dispensados, setDispensados] = useState<Set<string>>(new Set());
  const loadRef = useRef(false);

  const load = useCallback(async () => {
    if (loadRef.current) return;
    loadRef.current = true;
    try {
      const response = await fetch(API, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
        signal: AbortSignal.timeout(TRIAGEM_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 403) { setAllowed(false); setItems([]); return; }
      if (!response.ok) throw new Error(body.detail || body.error || `Triagem ${response.status}`);
      setAllowed(true);
      setItems(body.items || []);
      setPerson(String(body.person || ""));
      setError("");
    } catch (caught) {
      setError(mensagemDeFalha(caught, "Falha ao atualizar triagem."));
    } finally { loadRef.current = false; }
  }, [session.access_token]);

  useEffect(() => {
    void load();

    // Realtime seguro: o browser observa apenas um sinal minimo, sem dados de
    // cliente/material. Cada mudanca de MATERIAL_TRIAGE incrementa esse sinal
    // no Postgres; ai fazemos uma unica leitura pela API autorizada.
    let subscribedOnce = false;
    const channel = supabase
      .channel(`material-triage-signal:${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "material_triage_signal" },
        () => void load(),
      )
      .subscribe((status) => {
        // Se o websocket reconectar, refaz uma leitura para cobrir eventos que
        // possam ter ocorrido enquanto a aba ficou offline.
        if (status === "SUBSCRIBED") {
          if (subscribedOnce) void load();
          subscribedOnce = true;
        }
      });

    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Relogio apenas local para atualizar "ha X min"; nao toca na rede.
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(clock);
      void supabase.removeChannel(channel);
    };
  }, [load, session.user.id]);
  const action = useCallback(async (item: Row, kind: "CLAIM" | "OPENED" | "SNOOZE" | "ACKNOWLEDGE", extra: Row = {}) => {
    const key = `${item.id}:${kind}`;
    setBusy(key); setError("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, action: kind, ...extra }),
        signal: AbortSignal.timeout(TRIAGEM_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.claimed_by) throw new Error(`${body.claimed_by} já assumiu este material.`);
        throw new Error(body.detail || body.error || `Triagem ${response.status}`);
      }
      if (body.items) setItems(body.items); else await load();
      // Adiar precisa PARECER que funcionou. Sem esta pausa o proximo material
      // da fila toma o lugar no mesmo instante, e o popup parece nao ter
      // fechado -- reclamacao real de quem usa. A pausa e' so' de exibicao:
      // nenhum outro item muda de status, e o painel permanente segue listando
      // a fila inteira.
      if (kind === "SNOOZE") setPopupCooldownUntil(Date.now() + COOLDOWN_POPUP_MS);
      return true;
    } catch (caught) {
      setError(mensagemDeFalha(caught, "Não foi possível atualizar a triagem."));
      await load();
      return false;
    } finally { setBusy(""); }
  }, [load, session.access_token]);

  const openBriefing = useCallback((item: Row) => {
    const kind = String(item.metadata?.triage_kind || "");
    const entityType = kind === "PRODUCT_BRIEFING" ? "PRODUCT" : kind === "PERSONA" ? "PERSONA" : undefined;
    window.dispatchEvent(new CustomEvent("material-triage-open-briefing", { detail: {
      client_id: String(item.client_id || ""),
      tab: kind === "ASSET_BATCH" ? "materials" : entityType === "PERSONA" ? "personas" : "products",
      entity_type: entityType,
      entity_id: entityType ? String(item.metadata?.entity_id || "") : undefined,
    } }));
  }, []);

  const viewMaterial = useCallback(async (item: Row) => {
    if (await action(item, "OPENED")) openBriefing(item);
  }, [action, openBriefing]);

  const continueMaterial = useCallback(async (item: Row) => {
    const mine = item.status === "IN_PROGRESS" && item.target_person === person;
    // Assume ao seguir, mas NAO bloqueia a navegacao se o CLAIM falhar: abrir a
    // demanda e' leitura, e travar isso atras de uma mutacao foi o que fez
    // "Criar demanda criativa" morrer junto com o role mismatch.
    if (!mine) await action(item, "CLAIM");
    const kind = String(item.metadata?.triage_kind || "");
    const title = kind === "ASSET_BATCH" ? "Central Criativa" : kind === "PRODUCT_BRIEFING" ? "Produção de Roteiros" : "";
    const destination = title ? document.querySelector<HTMLButtonElement>(`.side-nav-items button[title="${title}"]`) : null;
    if (destination) { destination.click(); return; }
    openBriefing(item);
  }, [action, openBriefing, person]);

  const actionable = useMemo(() => items.filter((item) => item.status === "OPEN" || (item.status === "SNOOZED" && (!item.snoozed_until || new Date(item.snoozed_until).getTime() <= now)))
    .sort((a, b) => priorityRank(a) - priorityRank(b) || receivedAt(a) - receivedAt(b)), [items, now]);
  // AQUI EXISTIA UM MutationObserver QUE TRAVAVA A ABA. Nao recrie.
  //
  // Ele observava document.body com { subtree, childList, characterData } e o
  // callback reescrevia `button.textContent` das linhas .material-triage-item.
  // Escrever textContent E' uma mutacao de characterData -- ou seja, o callback
  // acordava a si mesmo, em laco, no main thread. A aba parava de responder a
  // mouse e teclado no instante em que o primeiro material entrava na lista, que
  // e' exatamente quando o popup aparece.
  //
  // Nao havia motivo para o observer existir: o rotulo sai de
  // `item.metadata.triage_kind`, que o React ja tem em maos nos dois lugares que
  // renderizam a lista. Agora ambos chamam `nextLabel`.

  // O relogio geral bate a cada 15s -- longe demais para devolver o popup em 5s.
  // Este efeito agenda um unico reveil no fim da pausa e some quando ela acaba.
  useEffect(() => {
    if (!popupCooldownUntil) return;
    const restante = popupCooldownUntil - Date.now();
    if (restante <= 0) { setPopupCooldownUntil(0); return; }
    const t = window.setTimeout(() => setPopupCooldownUntil(0), restante);
    return () => window.clearTimeout(t);
  }, [popupCooldownUntil]);

  const emPausa = popupCooldownUntil > 0 && Date.now() < popupCooldownUntil;
  const visiveis = actionable.filter((item: Row) => !dispensados.has(String(item.id)));
  const alert = allowed && !emPausa ? visiveis[0] || null : null;
  const alertAge = alert ? age(alert, now) : null;
  const itemBusy = Boolean(alert && busy.startsWith(`${alert.id}:`));
  if (typeof document === "undefined") return <style dangerouslySetInnerHTML={{ __html: STYLE }} />;

  return <>
    <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    {alert && alertAge && createPortal(<aside className={`material-triage-screen ${alertAge.severity}`} role="alert" aria-live="assertive">
      <div className="material-triage-screen-top">
        <div className="material-triage-screen-kicker">MATERIAL NOVO — AÇÃO NECESSÁRIA</div>
        <button
          type="button"
          className="material-triage-screen-close"
          aria-label="Fechar aviso deste material"
          title="Fecha só este aviso. O material continua na fila."
          onClick={() => setDispensados((atual) => new Set(atual).add(String(alert.id)))}
        >×</button>
      </div>
      <div className="material-triage-screen-title">{String(alert.client_display_name || "Cliente")}</div>
      <div className="material-triage-screen-summary">{summary(alert)}</div>
      <div className="material-triage-screen-meta"><span>{String(alert.metadata?.origin || alert.source || "Origem não informada")} · {receivedClock(alert)}</span><strong>{alertAge.label}</strong></div>
      <div className="material-triage-screen-actions">
        <button disabled={itemBusy} className="primary" onClick={() => void action(alert, "CLAIM")}>Assumir</button>
        <button disabled={itemBusy} onClick={() => void viewMaterial(alert)}>Ver material</button>
        <button disabled={itemBusy} onClick={() => void continueMaterial(alert)}>{nextLabel(alert)}</button>
        <button disabled={itemBusy} onClick={() => void action(alert, "SNOOZE", { minutes: 15 })}>Adiar 15 min</button>
      </div>
      <div className="material-triage-screen-actions material-triage-screen-secondary">
        <button
          disabled={itemBusy}
          className="material-triage-ack"
          title="Encerra a triagem deste material. O briefing/vídeo continua na origem."
          onClick={() => void action(alert, "ACKNOWLEDGE")}
        >{busy === `${alert.id}:ACKNOWLEDGE` ? "Ciente…" : "Ciente"}</button>
      </div>
      {error && <div className="material-triage-screen-error">{error}</div>}
    </aside>, document.body)}
  </>;
}
