"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
type ContextPayload = {
  ok?: boolean;
  explanation?: string;
  origin_at?: string | null;
  latest_session?: Row[];
  origin_thread?: Row[];
};

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-manager-attention-context`;
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

function fmt(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createMessage(row: Row) {
  const article = document.createElement("article");
  article.className = `mgr-radar-context-message ${row.is_team ? "team" : "client"}`;

  const head = document.createElement("div");
  head.className = "mgr-radar-context-message-head";
  const sender = document.createElement("b");
  sender.textContent = String(row.sender_name || (row.is_team ? "Equipe" : "Cliente"));
  const meta = document.createElement("span");
  meta.textContent = `${row.role ? `${row.role} · ` : ""}${fmt(row.event_at)}`;
  head.append(sender, meta);

  const body = document.createElement("p");
  body.textContent = String(row.body || `[${row.message_type || "mensagem"}]`);
  article.append(head, body);
  return article;
}

function messagesOverlap(a: Row[], b: Row[]) {
  if (!a.length || !b.length) return false;
  const ids = new Set(a.map((row) => String(row.id)));
  return b.some((row) => ids.has(String(row.id)));
}

export default function ManagerAttentionContextBridge() {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let sequence = 0;
    const cache = new Map<string, ContextPayload>();

    const schedule = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void renderContext(); }, 90);
    };

    const renderContext = async () => {
      const card = document.querySelector<HTMLElement>(".mgr-radar-card");
      if (!card) return;
      const clientName = card.querySelector<HTMLElement>(".mgr-radar-client strong")?.textContent?.trim() || "";
      const contextText = card.querySelector<HTMLElement>(".mgr-radar-block p")?.textContent?.trim() || "";
      const actionText = card.querySelector<HTMLElement>(".mgr-radar-grid .action p")?.textContent?.trim() || "";
      if (!clientName) return;

      const visualKey = `${clientName}|${norm(contextText)}|${norm(actionText)}`;
      const currentSection = card.querySelector<HTMLElement>("[data-manager-attention-context]");
      if (currentSection?.dataset.visualKey === visualKey) return;

      const callSequence = ++sequence;
      const { data: rows, error } = await supabase
        .schema("agency_ops")
        .from("manager_attention_alerts")
        .select("id,client_name,context,situation,charge_action,first_seen_at,last_seen_at,status")
        .eq("client_name", clientName)
        .eq("status", "OPEN")
        .order("first_seen_at", { ascending: true })
        .limit(10);
      if (disposed || callSequence !== sequence || error || !rows?.length) return;

      const row = (rows as Row[]).find((item) => norm(item.context) === norm(contextText) && norm(item.charge_action) === norm(actionText))
        || (rows as Row[]).find((item) => norm(item.context) === norm(contextText))
        || (rows as Row[])[0];
      if (!row?.id) return;

      let payload = cache.get(String(row.id));
      if (!payload) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const response = await fetch(`${API_URL}?alert_id=${encodeURIComponent(String(row.id))}`, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.ok) return;
        cache.set(String(row.id), payload);
      }
      if (disposed || callSequence !== sequence) return;

      const activeCard = document.querySelector<HTMLElement>(".mgr-radar-card");
      const activeClient = activeCard?.querySelector<HTMLElement>(".mgr-radar-client strong")?.textContent?.trim() || "";
      if (!activeCard || activeClient !== clientName) return;

      activeCard.querySelector("[data-manager-attention-context]")?.remove();
      const section = document.createElement("section");
      section.dataset.managerAttentionContext = "true";
      section.dataset.visualKey = visualKey;
      section.className = "mgr-radar-live-context";

      const label = document.createElement("small");
      label.className = "mgr-radar-live-context-label";
      label.textContent = "CONVERSA QUE EXPLICA A COBRANÇA";
      const explanation = document.createElement("p");
      explanation.className = "mgr-radar-live-context-explanation";
      explanation.textContent = String(payload.explanation || "Contexto da conversa recuperado do WhatsApp.");
      section.append(label, explanation);

      const latest = Array.isArray(payload.latest_session) ? payload.latest_session : [];
      if (latest.length) {
        const timeline = document.createElement("div");
        timeline.className = "mgr-radar-context-timeline";
        latest.forEach((message) => timeline.appendChild(createMessage(message)));
        section.appendChild(timeline);
      }

      const origin = Array.isArray(payload.origin_thread) ? payload.origin_thread : [];
      if (origin.length && !messagesOverlap(latest, origin)) {
        const details = document.createElement("details");
        details.className = "mgr-radar-origin-details";
        const summary = document.createElement("summary");
        summary.textContent = payload.origin_at ? `Ver conversa que originou o alerta · ${fmt(payload.origin_at)}` : "Ver conversa que originou o alerta";
        const timeline = document.createElement("div");
        timeline.className = "mgr-radar-context-timeline origin";
        origin.forEach((message) => timeline.appendChild(createMessage(message)));
        details.append(summary, timeline);
        section.appendChild(details);
      }

      const anchor = activeCard.querySelector<HTMLElement>(".mgr-radar-block");
      if (anchor?.parentElement) anchor.insertAdjacentElement("beforebegin", section);
      else activeCard.appendChild(section);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();

    return () => {
      disposed = true;
      sequence++;
      observer.disconnect();
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  return <style>{styles}</style>;
}

const styles = `
.mgr-radar-live-context{margin-top:11px;padding:17px 18px;border:1px solid rgba(91,174,255,.27);border-radius:13px;background:linear-gradient(180deg,rgba(24,78,139,.16),rgba(11,24,42,.72));box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}
.mgr-radar-live-context-label{display:block;color:#79c4ff;font-size:9px;font-weight:900;letter-spacing:.13em}
.mgr-radar-live-context-explanation{margin:8px 0 0;color:#e5effb;font-size:14px;font-weight:650;line-height:1.52}
.mgr-radar-context-timeline{display:grid;gap:7px;margin-top:12px}
.mgr-radar-context-message{padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025)}
.mgr-radar-context-message.client{border-left:3px solid rgba(255,108,108,.75);background:rgba(145,50,50,.08)}
.mgr-radar-context-message.team{border-left:3px solid rgba(88,185,255,.78);background:rgba(48,111,174,.08)}
.mgr-radar-context-message-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mgr-radar-context-message-head b{color:#f1f6fc;font-size:11px}.mgr-radar-context-message-head span{color:#748aa8;font-size:9px;white-space:nowrap}
.mgr-radar-context-message p{margin:5px 0 0!important;color:#cdd9e7!important;font-size:12px!important;line-height:1.45!important;white-space:pre-wrap}
.mgr-radar-origin-details{margin-top:11px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px}
.mgr-radar-origin-details summary{color:#91a9c7;font-size:10px;font-weight:800;cursor:pointer;user-select:none}.mgr-radar-origin-details[open] summary{color:#b9d7ef}
.mgr-radar-context-timeline.origin{margin-top:9px;max-height:260px;overflow:auto;padding-right:3px}
@media(max-width:720px){.mgr-radar-context-message-head{align-items:flex-start;flex-direction:column;gap:3px}.mgr-radar-live-context{padding:14px}}
`;
