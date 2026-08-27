"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, apiPost, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;

const ENDPOINT = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;
const CARD_SELECTOR = [
  ".notification-panel .notification-list > button",
  ".notification-panel .notification-action",
  "button.toast",
  "button.win-pulse",
  ".nh-item",
  ".client-notifications-bridge-host .cn-item",
].join(",");

const COMMON_CONTEXT_KEYS = [
  "response_summary",
  "subject",
  "waiting_since",
  "meeting_title",
  "topic",
  "participant_names",
  "meeting_status",
  "product_label",
  "routing_status",
  "task_name",
  "task_description",
  "completion_note",
  "assignee_names",
  "creator_name",
  "due_date",
  "list",
  "folder",
  "reason",
  "context",
  "message",
  "detail",
  "last_action_detail",
] as const;

const HIDDEN_METADATA = /secret|token|password|authorization|apikey|api_key|service_role|raw_payload|headers/i;

function norm(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levelLabel(value: unknown) {
  const raw = String(value || "INFO").toUpperCase();
  const labels: Record<string, string> = {
    CRITICAL: "Crítica",
    HIGH: "Alta prioridade",
    ATTENTION: "Atenção",
    WARNING: "Atenção",
    WARN: "Atenção",
    MEDIUM: "Atenção",
    SUCCESS: "Sucesso",
    OK: "Sucesso",
    LOW: "Baixa prioridade",
    INFO: "Informativa",
  };
  return labels[raw] || text(raw);
}

function statusLabel(item: Row) {
  const raw = String(item.status || "").toUpperCase();
  if (raw === "RESOLVED") return "Resolvida";
  if (raw === "READ" || item.read_at) return "Lida";
  if (item.kind === "ALERT") return raw === "OPEN" || !raw ? "Aberta" : text(raw);
  return "Aberta";
}

function sourceLabel(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "Operação";
  return text(raw.replace(/_/g, " "));
}

function humanKey(value: string) {
  const labels: Record<string, string> = {
    response_summary: "Resposta aguardada",
    subject: "Assunto",
    waiting_since: "Aguardando desde",
    meeting_title: "Título da reunião",
    topic: "Tema",
    participant_names: "Com quem está",
    meeting_status: "Status da reunião",
    product_label: "Produto",
    routing_status: "Roteamento",
    task_name: "Tarefa",
    task_description: "Pedido original",
    completion_note: "Registro de conclusão",
    assignee_names: "Responsável",
    creator_name: "Criada por",
    due_date: "Prazo",
    list: "Lista",
    folder: "Pasta",
    reason: "Motivo",
    context: "Contexto",
    message: "Mensagem",
    detail: "Detalhe",
    last_action_detail: "Última ação",
    task_id: "ID da tarefa",
    work_item_id: "ID da demanda",
    alert_type: "Tipo de alerta",
    occurrence_no: "Ocorrência",
    incident_id: "ID da ocorrência",
    message_id: "ID da mensagem",
  };
  return labels[value] || value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scalar(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) return value.map(String).join(", ");
    return value.slice(0, 8).map((entry) => typeof entry === "object" ? JSON.stringify(entry) : String(entry)).join(" · ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Row).filter(([, nested]) => nested != null && nested !== "").slice(0, 12);
    return entries.map(([key, nested]) => `${humanKey(key)}: ${typeof nested === "object" ? JSON.stringify(nested) : String(nested)}`).join(" · ");
  }
  return String(value);
}

function dateish(key: string, value: string) {
  if (!value) return value;
  if (!/(^|_)(at|date|since|due|started|ended|closed|created|updated)$/i.test(key) && !/(time|timestamp)/i.test(key)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDate(value);
}

function safeHttps(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function cardTitle(card: HTMLElement) {
  return card.querySelector<HTMLElement>("h2,h4,b,strong")?.textContent?.trim() || "";
}

function cardDescription(card: HTMLElement) {
  return card.querySelector<HTMLElement>(".cn-description,p,small")?.textContent?.trim() || "";
}

function isNestedControl(target: HTMLElement | null, card: HTMLElement) {
  if (!target) return false;
  if (target.closest("[data-notification-resolve]")) return true;
  if (target.closest(".toast > i")) return true;
  const interactive = target.closest("a,button,input,select,textarea,summary,[role='button']") as HTMLElement | null;
  return Boolean(interactive && interactive !== card);
}

function deferToSpecialized(card: HTMLElement, title: string) {
  const inBell = card.matches(".notification-panel .notification-list > button");
  const isToast = card.matches("button.toast");
  if ((inBell || isToast) && /lead incompleto/i.test(title)) return true;
  if (inBell && (/^demanda conclu[ií]da\s*:/i.test(title) || /^tarefa conclu[ií]da\s*$/i.test(title))) return true;
  return false;
}

function scoreItem(item: Row, title: string, description: string, visible: string) {
  let score = 0;
  const it = norm(item.title);
  const id = norm(item.description);
  const ct = norm(item.client_name);
  const t = norm(title);
  const d = norm(description);
  const v = norm(visible);
  if (it && t && it === t) score += 100;
  else if (it && t && (it.includes(t) || t.includes(it))) score += 55;
  if (id && d && (id === d || id.includes(d.slice(0, 80)) || d.includes(id.slice(0, 80)))) score += 70;
  else if (id && v.includes(id.slice(0, Math.min(90, id.length)))) score += 45;
  if (ct && v.includes(ct)) score += 25;
  if (item.actor && v.includes(norm(item.actor))) score += 8;
  return score;
}

function matchItem(rows: Row[], card: HTMLElement) {
  const notificationId = String(card.dataset.notificationId || "").trim();
  if (notificationId) {
    const exact = rows.find((row) => String(row.id) === notificationId);
    if (exact) return exact;
  }

  const title = cardTitle(card);
  const description = cardDescription(card);
  const visible = card.textContent || "";
  const ranked = rows
    .map((item) => ({ item, score: scoreItem(item, title, description, visible) }))
    .filter((entry) => entry.score >= 70)
    .sort((a, b) => b.score - a.score || new Date(String(b.item.occurred_at || 0)).getTime() - new Date(String(a.item.occurred_at || 0)).getTime());
  return ranked[0]?.item || null;
}

function usefulMetadata(item: Row) {
  const metadata: Row = item.metadata || {};
  const common = COMMON_CONTEXT_KEYS
    .map((key) => {
      const raw = scalar(metadata[key]);
      if (!raw) return null;
      return { key, label: humanKey(key), value: dateish(key, raw), url: safeHttps(raw) };
    })
    .filter(Boolean) as { key: string; label: string; value: string; url: string }[];

  const used = new Set(common.map((entry) => entry.key));
  const extras = Object.entries(metadata)
    .filter(([key, value]) => !used.has(key) && !HIDDEN_METADATA.test(key) && value != null && value !== "")
    .map(([key, value]) => {
      let rendered = scalar(value);
      if (!rendered) return null;
      if (rendered.length > 700) rendered = `${rendered.slice(0, 697)}…`;
      return { key, label: humanKey(key), value: dateish(key, rendered), url: safeHttps(rendered) };
    })
    .filter(Boolean)
    .slice(0, 24) as { key: string; label: string; value: string; url: string }[];

  return { common, extras };
}

export default function NotificationDetailBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cacheRef = useRef<{ at: number; rows: Row[] }>({ at: 0, rows: [] });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) { setSelected(null); cacheRef.current = { at: 0, rows: [] }; }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadRows = useCallback(async (force = false) => {
    if (!session?.access_token) return [] as Row[];
    if (!force && Date.now() - cacheRef.current.at < 5000 && cacheRef.current.rows.length) return cacheRef.current.rows;
    const response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    const rows: Row[] = Array.isArray(body.items) ? body.items : [];
    cacheRef.current = { at: Date.now(), rows };
    return rows;
  }, [session?.access_token]);

  const openCard = useCallback(async (card: HTMLElement) => {
    const title = cardTitle(card) || "Notificação";
    const description = cardDescription(card) || card.textContent?.trim() || "";
    setError("");
    setLoading(true);
    setSelected({ title, description, metadata: {}, _temporary: true });
    try {
      let rows = await loadRows();
      let item = matchItem(rows, card);
      if (!item) {
        rows = await loadRows(true);
        item = matchItem(rows, card);
      }
      if (!item) throw new Error("Não consegui vincular esta linha a uma ocorrência única. A notificação não foi redirecionada para evitar abrir o contexto errado.");
      setSelected(item);
      if (item.kind === "NOTIFICATION" && !item.read_at && session?.access_token) {
        try {
          await apiPost("notifications-read", session.access_token, { id: item.id });
          item.read_at = new Date().toISOString();
          item.status = "READ";
          setSelected({ ...item });
        } catch {
          // Abrir o detalhe continua funcionando mesmo que a marcação como lida falhe.
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar o contexto desta notificação.");
    } finally {
      setLoading(false);
    }
  }, [loadRows, session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;

    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const card = target?.closest?.(CARD_SELECTOR) as HTMLElement | null;
      if (!card || isNestedControl(target, card)) return;
      const title = cardTitle(card);
      if (deferToSpecialized(card, title)) return;

      event.preventDefault();
      event.stopPropagation();
      (event as any).stopImmediatePropagation?.();
      void openCard(card);
    };

    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target as HTMLElement | null;
      const card = target?.closest?.(CARD_SELECTOR) as HTMLElement | null;
      if (!card || target !== card || card.matches("button")) return;
      const title = cardTitle(card);
      if (deferToSpecialized(card, title)) return;
      event.preventDefault();
      event.stopPropagation();
      void openCard(card);
    };

    const decorate = () => {
      document.querySelectorAll<HTMLElement>(CARD_SELECTOR).forEach((card) => {
        const title = cardTitle(card);
        if (deferToSpecialized(card, title)) return;
        card.dataset.notificationDetailReady = "1";
        card.setAttribute("title", "Clique para ver todos os detalhes desta notificação");
        if (!card.matches("button") && !card.hasAttribute("tabindex")) card.tabIndex = 0;
      });
    };

    const observer = new MutationObserver(decorate);
    observer.observe(document.body, { childList: true, subtree: true });
    decorate();
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [openCard, session?.access_token]);

  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape); };
  }, [selected]);

  const metadata = useMemo(() => selected ? usefulMetadata(selected) : { common: [], extras: [] }, [selected]);
  if (!selected) return <style>{cursorStyles}</style>;

  const responsible = text(selected.owner || selected.actor || selected.metadata?.assignee_names || "Sem responsável informado");
  const clientName = text(selected.client_name || "Operação geral");
  const clientHref = selected.client_id
    ? `/?client=${encodeURIComponent(String(selected.client_id))}&clientNotifications=1&notificationId=${encodeURIComponent(String(selected.id || ""))}&notification=${encodeURIComponent(String(selected.title || ""))}`
    : "";
  const externalLinks = [
    ["Abrir tarefa no ClickUp", safeHttps(selected.metadata?.url || selected.metadata?.clickup_url)],
    ["Abrir Google Meet", safeHttps(selected.metadata?.meet_url)],
  ].filter((entry) => entry[1]) as string[][];

  return <>
    <style>{cursorStyles + styles}</style>
    <div className="ndb-backdrop" role="dialog" aria-modal="true" aria-labelledby="ndb-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="ndb-card">
        <header className="ndb-head">
          <div>
            <span className={`ndb-level ${String(selected.level || "INFO").toLowerCase()}`}>{levelLabel(selected.level)}</span>
            <h2 id="ndb-title">{text(selected.title || "Notificação")}</h2>
            <p>{text(selected.description || "Sem descrição adicional registrada.")}</p>
          </div>
          <button type="button" className="ndb-close" onClick={() => setSelected(null)} aria-label="Fechar detalhes">×</button>
        </header>

        {loading ? <div className="ndb-loading"><span /> Carregando contexto completo…</div> : <>
          {error && <div className="ndb-error"><b>Não consegui carregar o registro completo.</b><span>{error}</span></div>}

          <div className="ndb-summary">
            <div><small>CLIENTE / ÁREA</small><b>{clientName}</b></div>
            <div><small>RESPONSÁVEL</small><b>{responsible}</b></div>
            <div><small>ORIGEM</small><b>{sourceLabel(selected.source_label || selected.source)}</b></div>
            <div><small>STATUS</small><b>{statusLabel(selected)}</b></div>
            <div><small>QUANDO</small><b>{selected.occurred_at ? formatDate(selected.occurred_at) : "Não informado"}</b></div>
            <div><small>TIPO</small><b>{text(selected.type || selected.kind || "Notificação")}</b></div>
          </div>

          {selected.next_action && <section className="ndb-next"><small>PRÓXIMA AÇÃO</small><p>{text(selected.next_action)}</p></section>}

          {metadata.common.length > 0 && <section className="ndb-section">
            <div className="ndb-section-title"><span>CONTEXTO REGISTRADO</span><h3>O que esta notificação está informando</h3></div>
            <div className="ndb-context-grid">{metadata.common.map((entry) => <div key={entry.key}><small>{entry.label}</small>{entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">Abrir informação ↗</a> : <p>{entry.value}</p>}</div>)}</div>
          </section>}

          {metadata.extras.length > 0 && <details className="ndb-more" open={metadata.common.length === 0}>
            <summary>Ver todos os dados registrados nesta ocorrência</summary>
            <div className="ndb-context-grid">{metadata.extras.map((entry) => <div key={entry.key}><small>{entry.label}</small>{entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">{entry.value} ↗</a> : <p>{entry.value}</p>}</div>)}</div>
          </details>}

          {!error && metadata.common.length === 0 && metadata.extras.length === 0 && <section className="ndb-empty-context">Não há campos extras nesta ocorrência. O título, descrição, responsável, origem, status e horário acima são todo o contexto registrado pelo evento.</section>}

          <div className="ndb-actions">
            {clientHref && <a href={clientHref}>Abrir cliente e histórico de notificações →</a>}
            {externalLinks.map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer">{label} ↗</a>)}
            <button type="button" onClick={() => setSelected(null)}>Fechar</button>
          </div>
        </>}
      </section>
    </div>
  </>;
}

const cursorStyles = `
[data-notification-detail-ready="1"]{cursor:pointer!important}
[data-notification-detail-ready="1"]:focus-visible{outline:2px solid rgba(108,190,255,.7)!important;outline-offset:2px!important}
`;

const styles = `
.ndb-backdrop{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;padding:20px;background:rgba(2,7,13,.84);backdrop-filter:blur(11px);font-family:Inter,system-ui,sans-serif;color:#eaf3fb}.ndb-card{width:min(1040px,100%);max-height:calc(100dvh - 40px);overflow:auto;border:1px solid rgba(105,168,216,.28);border-radius:20px;background:linear-gradient(180deg,#0d1926,#08111b);box-shadow:0 36px 120px rgba(0,0,0,.68);padding:22px}.ndb-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding-bottom:17px;border-bottom:1px solid rgba(111,157,194,.16)}.ndb-level{display:inline-flex;padding:5px 9px;border-radius:999px;border:1px solid rgba(93,164,220,.25);background:rgba(64,135,193,.12);color:#9fd6ff;font-size:9px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}.ndb-level.critical,.ndb-level.high{border-color:rgba(236,91,76,.38);background:rgba(160,42,36,.16);color:#ff9b90}.ndb-level.attention,.ndb-level.warning,.ndb-level.warn,.ndb-level.medium{border-color:rgba(221,166,74,.35);background:rgba(154,105,27,.14);color:#f1ca82}.ndb-level.success,.ndb-level.ok,.ndb-level.low{border-color:rgba(55,183,132,.32);background:rgba(39,139,101,.13);color:#94e2bd}.ndb-head h2{margin:8px 0 7px;font:800 clamp(25px,4vw,39px)/1.05 "Inter Tight",Inter,sans-serif;letter-spacing:-.035em}.ndb-head p{max-width:820px;margin:0;color:#9bb0c2;font-size:13px;line-height:1.55}.ndb-close{flex:0 0 auto;width:38px;height:38px;border:1px solid rgba(126,164,194,.22);border-radius:10px;background:rgba(255,255,255,.04);color:#c9d9e6;font-size:24px;cursor:pointer}.ndb-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:54px;color:#92aabd}.ndb-loading span{width:13px;height:13px;border:2px solid #63bdf4;border-top-color:transparent;border-radius:50%;animation:ndbspin .7s linear infinite}@keyframes ndbspin{to{transform:rotate(360deg)}}.ndb-error{display:flex;flex-direction:column;gap:4px;margin-top:14px;padding:12px 14px;border:1px solid rgba(232,91,78,.3);border-radius:11px;background:rgba(128,35,32,.12);color:#ffb2aa;font-size:11px}.ndb-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:15px}.ndb-summary>div{min-width:0;padding:11px 12px;border:1px solid rgba(101,149,188,.17);border-radius:11px;background:rgba(13,31,46,.72)}.ndb-summary small,.ndb-summary b{display:block}.ndb-summary small,.ndb-section-title>span{color:#6f8ba3;font-size:8px;font-weight:900;letter-spacing:.09em}.ndb-summary b{margin-top:4px;color:#dce9f3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ndb-next{margin-top:11px;padding:12px 14px;border:1px solid rgba(75,157,219,.22);border-radius:12px;background:rgba(47,119,176,.09)}.ndb-next small{color:#8abce0;font-size:8px;font-weight:900;letter-spacing:.1em}.ndb-next p{margin:5px 0 0;color:#d5e6f2;font-size:12px;line-height:1.5}.ndb-section{margin-top:13px;padding:14px;border:1px solid rgba(100,151,191,.17);border-radius:13px;background:rgba(8,23,35,.72)}.ndb-section-title h3{margin:4px 0 0;font-size:14px}.ndb-context-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:11px}.ndb-context-grid>div{min-width:0;padding:10px 11px;border-radius:10px;background:rgba(17,38,55,.7);border:1px solid rgba(95,146,186,.14)}.ndb-context-grid small{display:block;color:#7594ac;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.ndb-context-grid p,.ndb-context-grid a{display:block;margin:5px 0 0;color:#cbdbe7;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.ndb-context-grid a{color:#a7d9ff;text-decoration:none}.ndb-more{margin-top:11px;border:1px solid rgba(98,144,179,.15);border-radius:12px;background:rgba(8,21,32,.58);overflow:hidden}.ndb-more summary{padding:11px 13px;color:#8da7ba;font-size:10px;font-weight:800;cursor:pointer}.ndb-more>.ndb-context-grid{padding:0 12px 12px;margin-top:0}.ndb-empty-context{margin-top:12px;padding:12px 14px;border:1px dashed rgba(103,149,184,.18);border-radius:11px;color:#7f99ac;font-size:11px;line-height:1.5}.ndb-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.ndb-actions a,.ndb-actions button{border:1px solid rgba(89,153,201,.25);border-radius:9px;padding:9px 12px;background:rgba(43,111,163,.1);color:#cbeaff;text-decoration:none;font:800 10px/1.2 Inter,sans-serif;cursor:pointer}.ndb-actions button{margin-left:auto;background:rgba(255,255,255,.04);color:#a9bbc9}@media(max-width:760px){.ndb-backdrop{padding:7px;place-items:start center;overflow:auto}.ndb-card{max-height:none;min-height:calc(100dvh - 14px);padding:14px;border-radius:14px}.ndb-summary{grid-template-columns:1fr 1fr}.ndb-context-grid{grid-template-columns:1fr}.ndb-actions button{margin-left:0}.ndb-head h2{font-size:27px}}
`;
