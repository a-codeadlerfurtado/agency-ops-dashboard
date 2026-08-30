"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type UpdateItem = {
  sha: string;
  committed_at: string;
  title: string;
  subject?: string;
  added?: string[];
  fixed?: string[];
  removed?: string[];
  explanation?: string | null;
  target_roles?: string[];
  release_status?: "ACTIVE" | "REVERTED" | "REVERT";
  reverts_sha?: string | null;
  reverted_by_sha?: string | null;
};

type Payload = {
  ok: boolean;
  allowed?: boolean;
  excluded?: boolean;
  mode?: "NONE" | "DAILY" | "PREVIEW_STACK" | "HISTORY";
  preview?: boolean;
  person?: string;
  role?: string;
  edition_date?: string;
  updates?: UpdateItem[];
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-system-updates-api`;
const NAV_ATTR = "data-system-updates-nav";

const roleLabel: Record<string, string> = {
  ALL: "Todos os perfis", MGMT: "Gestão", GT: "GT", CS: "CS", DESIGN: "Design", AI: "IA", COMMERCIAL: "Comercial",
};

function formatDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00-03:00`) : new Date(value);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" }).format(date);
}
function section(title: string, icon: string, items?: string[]) {
  if (!items?.length) return null;
  return <div className="system-update-section"><div className="system-update-section-title"><span>{icon}</span>{title}</div><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>;
}
function UpdateCard({ item, compact = false, showDate = false }: { item: UpdateItem; compact?: boolean; showDate?: boolean }) {
  const scopes = item.target_roles?.length ? item.target_roles : ["ALL"];
  const status = item.release_status || "ACTIVE";
  return (
    <article className={`system-update-card ${compact ? "is-compact" : ""} status-${status.toLowerCase()}`}>
      <div className="system-update-card-head">
        <div>
          <div className="system-update-version">{showDate ? `${formatDate(item.committed_at)} · ` : "ATUALIZAÇÃO · "}{item.sha.slice(0, 7)}</div>
          <h3>{item.title || item.subject || "Atualização do sistema"}</h3>
          {status !== "ACTIVE" ? <span className={`system-update-status ${status.toLowerCase()}`}>{status === "REVERTED" ? "REVERTIDA" : "REVERT"}</span> : null}
        </div>
        <div className="system-update-scopes">{scopes.map((scope) => <span key={scope}>{roleLabel[scope] || scope}</span>)}</div>
      </div>
      <div className="system-update-card-grid">{section("Acrescentado", "+", item.added)}{section("Corrigido / melhorado", "✓", item.fixed)}{section("Retirado", "−", item.removed)}</div>
      {item.explanation ? <div className="system-update-connected"><b>Como isso se liga ao seu trabalho</b><p>{item.explanation}</p></div> : null}
      {status === "REVERTED" && item.reverted_by_sha ? <div className="system-update-revert-note">Esta alteração foi revertida posteriormente por {item.reverted_by_sha.slice(0, 7)}.</div> : null}
    </article>
  );
}

export default function SystemUpdateCenter() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [closing, setClosing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [navAllowed, setNavAllowed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<UpdateItem[]>([]);
  const [historyRole, setHistoryRole] = useState("");
  const [historySearch, setHistorySearch] = useState("");

  const api = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const response = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ action, ...extra }),
    });
    return response.json().catch(() => null);
  }, []);

  const check = useCallback(async () => {
    if (checking || payload) return;
    setChecking(true);
    try {
      const next = await api("CHECK") as Payload | null;
      setNavAllowed(Boolean(next?.ok && next.allowed && !next.excluded));
      if (!next?.ok || !next.allowed || !next.mode || next.mode === "NONE" || !next.updates?.length) return;
      setPayload(next);
      if (next.mode === "DAILY" && next.edition_date) void api("MARK_SHOWN", { edition_date: next.edition_date, commit_shas: next.updates.map((item) => item.sha) });
    } finally { setChecking(false); }
  }, [api, checking, payload]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await api("HISTORY", { limit: 160 }) as Payload | null;
      if (!result?.ok || !result.allowed) { setHistoryOpen(false); return; }
      setHistoryItems(result.updates || []);
      setHistoryRole(result.role || "");
    } finally { setHistoryLoading(false); }
  }, [api]);

  useEffect(() => {
    const first = window.setTimeout(() => void check(), 900);
    const interval = window.setInterval(() => void check(), 60_000);
    const onVisible = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(first); window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [check]);

  useEffect(() => {
    if (!navAllowed || window.location.pathname !== "/") return;
    let alive = true;
    const mount = () => {
      if (!alive) return;
      const nav = document.querySelector<HTMLElement>(".side-nav-items");
      if (!nav) return;
      let button = nav.querySelector<HTMLButtonElement>(`[${NAV_ATTR}]`);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.setAttribute(NAV_ATTR, "true");
        button.title = "Atualizações do sistema";
        button.innerHTML = `<span aria-hidden="true">↻</span><span>Atualizações</span>`;
        nav.appendChild(button);
      }
      button.onclick = () => { setHistoryOpen(true); void loadHistory(); };
    };
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(mount, 1800);
    return () => { alive = false; observer.disconnect(); window.clearInterval(timer); document.querySelectorAll(`[${NAV_ATTR}]`).forEach((node) => node.remove()); };
  }, [loadHistory, navAllowed]);

  const updates = payload?.updates || [];
  const editionTitle = useMemo(() => payload?.edition_date ? formatDate(payload.edition_date) : "Hoje", [payload?.edition_date]);
  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyItems;
    return historyItems.filter((item) => [item.title, item.subject, item.explanation, ...(item.added || []), ...(item.fixed || []), ...(item.removed || [])].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [historyItems, historySearch]);

  async function close() {
    if (!payload || closing) return;
    setClosing(true);
    try {
      if (payload.mode === "PREVIEW_STACK") await api("ACK_PREVIEW");
      else if (payload.mode === "DAILY" && payload.edition_date) await api("DISMISS_DAILY", { edition_date: payload.edition_date, commit_shas: updates.map((item) => item.sha) });
    } finally { setPayload(null); setClosing(false); }
  }

  return (
    <>
      {historyOpen ? (
        <div className="system-update-overlay system-update-history-overlay" role="dialog" aria-modal="true" aria-label="Central de atualizações">
          <div className="system-update-history-shell">
            <header className="system-update-history-head">
              <div><span className="system-update-kicker">HISTÓRICO PERMANENTE</span><h2>Central de Atualizações</h2><p>O que entrou, foi corrigido, retirado e como cada mudança se conecta ao seu trabalho.</p></div>
              <button type="button" onClick={() => setHistoryOpen(false)}>Fechar</button>
            </header>
            <div className="system-update-history-tools">
              <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Buscar atualização…" aria-label="Buscar atualização" />
              <span>{historyRole ? `Escopo: ${roleLabel[historyRole] || historyRole}` : ""}</span>
            </div>
            <div className="system-update-history-list">
              {historyLoading ? <div className="system-update-empty">Carregando histórico…</div> : filteredHistory.length ? filteredHistory.map((item) => <UpdateCard item={item} key={item.sha} showDate />) : <div className="system-update-empty">Nenhuma atualização encontrada.</div>}
            </div>
          </div>
        </div>
      ) : null}

      {payload && updates.length && payload.mode === "PREVIEW_STACK" ? (
        <div className="system-update-overlay system-update-preview" role="dialog" aria-modal="true" aria-label="Prévia das atualizações do sistema">
          <div className="system-update-preview-shell"><header className="system-update-preview-head"><div><span className="system-update-kicker">PRÉVIA · PERFIL ADLER</span><h2>É assim que as atualizações vão aparecer</h2><p>Últimos commits do Dashboard empilhados para você validar a experiência.</p></div><button type="button" onClick={close} disabled={closing}>Fechar prévia</button></header><div className="system-update-preview-stack">{updates.map((item, index) => <div className="system-update-preview-layer" style={{ zIndex: updates.length - index }} key={item.sha}><UpdateCard item={item} compact /></div>)}</div></div>
        </div>
      ) : null}

      {payload && updates.length && payload.mode === "DAILY" ? (
        <div className="system-update-overlay" role="dialog" aria-modal="true" aria-label="Atualização do sistema">
          <div className="system-update-modal"><header className="system-update-hero"><div className="system-update-kicker">PATCH NOTES · {editionTitle}</div><h2>O Dashboard foi atualizado</h2><p>{updates.length === 1 ? "1 mudança relevante para o seu perfil." : `${updates.length} mudanças relevantes para o seu perfil.`}</p></header><div className="system-update-list">{updates.map((item) => <UpdateCard item={item} key={item.sha} />)}</div><footer className="system-update-footer"><span>Este resumo aparece uma única vez por dia útil, a partir das 08:30. O histórico fica sempre disponível em Atualizações.</span><button type="button" onClick={close} disabled={closing}>{closing ? "Fechando…" : "Entendi, continuar"}</button></footer></div>
        </div>
      ) : null}
    </>
  );
}
