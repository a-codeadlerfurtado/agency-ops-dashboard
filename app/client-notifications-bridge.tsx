"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL, apiPost, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;
type Filter = "OPEN" | "CRITICAL" | "RESOLVED" | "ALL";

const ENDPOINT = `${SUPABASE_URL}/functions/v1/agency-ops-client-notifications`;

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function isLeadDiagnostic(title: string) {
  const value = norm(title);
  return value.includes("lead incompleto") || value.includes("dados incompletos do lead") || value.includes("lead com dados incompletos");
}

function sourceLabel(value: unknown) {
  const raw = String(value || "").toUpperCase();
  const labels: Record<string, string> = {
    META: "Meta Ads",
    META_ADS: "Meta Ads",
    WHATSAPP: "WhatsApp",
    CONVERSATION_STATE: "WhatsApp",
    CLICKUP: "ClickUp",
    ONBOARDING: "Onboarding",
    AGENCY_OPS: "Operação",
    NOTION_CLIENT_HEALTH: "Saúde do Cliente",
    CRM: "CRM",
    COMMERCIAL: "Comercial",
    AUTOMATION: "Automação",
    SUPABASE: "Sistema",
  };
  return labels[raw] || text(value || "Operação");
}

function severityClass(value: unknown) {
  const raw = String(value || "").toUpperCase();
  if (["CRITICAL", "HIGH", "ERROR"].includes(raw)) return "critical";
  if (["MEDIUM", "WARNING", "WARN", "ATTENTION"].includes(raw)) return "attention";
  if (["SUCCESS", "OK", "LOW"].includes(raw)) return "ok";
  return "info";
}

function statusLabel(item: Row) {
  if (item.kind === "ALERT") return String(item.status || "OPEN").toUpperCase() === "RESOLVED" ? "Resolvido" : (["CRITICAL", "HIGH"].includes(String(item.level || "").toUpperCase()) ? "Ação necessária" : "Atenção");
  return item.read_at ? "Informação" : "Nova";
}

function ageLabel(value: unknown) {
  const time = new Date(String(value || "")).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function inferredOwner(item: Row, client: Row) {
  if (item.actor) return text(item.actor);
  const haystack = norm(`${item.type || ""} ${item.source || ""} ${item.title || ""} ${item.next_action || ""}`);
  if (/meta|campanha|cpl|ctr|saldo|trafego/.test(haystack)) return client.gt_owner ? `GT · ${client.gt_owner}` : "GT · não cadastrado";
  if (/whatsapp|cliente aguardando|resposta|retorno|comercial/.test(haystack)) return client.cs_owner ? `CS · ${client.cs_owner}` : "CS · não cadastrado";
  if (/criativo|design|arte|layout/.test(haystack)) return client.designer_owner ? `Design · ${client.designer_owner}` : "Design · responsável por demanda";
  return "Operação";
}

function ClientNotificationsPane({ clientName, body, initialNotifications, highlightTitle }: { clientName: string; body: HTMLElement; initialNotifications: boolean; highlightTitle: string | null }) {
  const [active, setActive] = useState(initialNotifications ? "NOTIFICATIONS" : "OVERVIEW");
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [payload, setPayload] = useState<Row>({ summary: {}, client: {}, items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || !clientName) return;
    setLoading(true); setError("");
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("client_name", clientName);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const next = await response.json().catch(() => ({}));
      if (!response.ok || !next?.ok) throw new Error(next?.error || `HTTP ${response.status}`);
      setPayload(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar as notificações deste cliente.");
    } finally { setLoading(false); }
  }, [clientName]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    body.style.display = active === "OVERVIEW" ? "" : "none";
    return () => { body.style.display = ""; };
  }, [active, body]);

  const items: Row[] = payload.items || [];
  const summary: Row = payload.summary || {};
  const client: Row = payload.client || {};
  const visible = useMemo(() => items.filter((item) => {
    const resolved = item.kind === "ALERT" && String(item.status || "").toUpperCase() === "RESOLVED";
    const critical = item.kind === "ALERT" && !resolved && ["CRITICAL", "HIGH"].includes(String(item.level || "").toUpperCase());
    const open = (item.kind === "ALERT" && !resolved) || (item.kind === "NOTIFICATION" && !item.read_at);
    if (filter === "OPEN") return open;
    if (filter === "CRITICAL") return critical;
    if (filter === "RESOLVED") return resolved;
    return true;
  }), [items, filter]);

  async function markRead(item: Row) {
    if (item.kind !== "NOTIFICATION" || item.read_at) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    setBusy(String(item.id));
    try {
      await apiPost("notifications-read", session.access_token, { id: item.id });
      await load();
    } finally { setBusy(null); }
  }

  const openCount = Number(summary.open_alerts || 0) + Number(summary.unread || 0);
  const criticalCount = Number(summary.critical_open || 0);

  return <>
    <style>{styles}</style>
    <div className="cn-tabbar">
      <div className="cn-tabs">
        <button className={active === "OVERVIEW" ? "active" : ""} onClick={() => setActive("OVERVIEW")}>Visão geral</button>
        <button className={active === "NOTIFICATIONS" ? "active" : ""} onClick={() => setActive("NOTIFICATIONS")}>Notificações{openCount ? <b>{openCount}</b> : null}</button>
      </div>
      <div className={`cn-summary${criticalCount ? " critical" : ""}`}><span>🔔</span><b>{openCount}</b> abertas{criticalCount ? ` · ${criticalCount} críticas` : ""}</div>
    </div>

    {active === "NOTIFICATIONS" && <section className="cn-panel">
      <div className="cn-panel-head">
        <div><span className="eyebrow">Notificações do cliente</span><h3>O que aconteceu com {clientName}</h3><p>Alertas e notificações ligados somente a este cliente, com histórico operacional.</p></div>
        <button className="cn-refresh" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
      </div>

      <div className="cn-kpis">
        <article><small>ABERTAS</small><b>{openCount}</b><span>ação ou leitura pendente</span></article>
        <article className={criticalCount ? "danger" : ""}><small>CRÍTICAS</small><b>{criticalCount}</b><span>prioridade imediata</span></article>
        <article><small>RESOLVIDAS</small><b>{Number(summary.resolved_alerts || 0)}</b><span>alertas encerrados</span></article>
        <article><small>NÃO LIDAS</small><b>{Number(summary.unread || 0)}</b><span>notificações novas</span></article>
      </div>

      <div className="cn-filters">
        {([['OPEN','Abertas'],['CRITICAL','Críticas'],['RESOLVED','Resolvidas'],['ALL','Todas']] as [Filter,string][]).map(([key,label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}
      </div>

      {error && <div className="cn-error">{error}</div>}
      {!error && loading && !items.length && <div className="cn-empty">Carregando histórico…</div>}
      {!loading && !visible.length && !error && <div className="cn-empty">Nenhum item neste filtro.</div>}

      <div className="cn-list">{visible.map((item) => {
        const highlighted = !!highlightTitle && norm(item.title) === norm(highlightTitle);
        const tone = severityClass(item.level);
        return <article key={`${item.kind}:${item.id}`} className={`cn-item ${tone}${highlighted ? " highlighted" : ""}`}>
          <div className="cn-item-top">
            <div className="cn-badges"><span className={`cn-status ${tone}`}>{statusLabel(item)}</span><span className="cn-source">{sourceLabel(item.source)}</span></div>
            <time title={formatDate(item.occurred_at)}>{ageLabel(item.occurred_at)} · {formatDate(item.occurred_at)}</time>
          </div>
          <h4>{text(item.title)}</h4>
          <p className="cn-description">{text(item.description)}</p>
          <div className="cn-meta"><span><b>Responsável:</b> {inferredOwner(item, client)}</span>{item.kind === "ALERT" && item.first_detected_at && <span><b>Detectado:</b> {formatDate(item.first_detected_at)}</span>}</div>
          {item.next_action && <div className="cn-next"><b>Próxima ação</b><span>{text(item.next_action)}</span></div>}
          {item.kind === "ALERT" && String(item.status || "").toUpperCase() === "RESOLVED" && item.resolved_at && <div className="cn-resolved">Resolvido em {formatDate(item.resolved_at)}</div>}
          {item.kind === "NOTIFICATION" && !item.read_at && <div className="cn-actions"><button disabled={busy === String(item.id)} onClick={() => markRead(item)}>{busy === String(item.id) ? "Salvando…" : "Marcar como lida"}</button></div>}
        </article>;
      })}</div>
    </section>}
  </>;
}

export default function ClientNotificationsBridge() {
  useEffect(() => {
    let currentDrawer: HTMLElement | null = null;
    let currentName = "";
    let host: HTMLDivElement | null = null;
    let root: Root | null = null;
    let pending: { title: string; at: number } | null = null;

    const cleanup = () => {
      try { root?.unmount(); } catch {}
      host?.remove();
      if (currentDrawer) {
        const body = currentDrawer.querySelector<HTMLElement>(".drawer-body");
        if (body) body.style.display = "";
      }
      root = null; host = null; currentDrawer = null; currentName = "";
    };

    const mount = () => {
      const drawer = document.querySelector<HTMLElement>('.drawer.open[aria-label="Visão do cliente"]');
      if (!drawer) { if (currentDrawer) cleanup(); return; }
      const title = drawer.querySelector<HTMLElement>(".drawer-head h2");
      const name = title?.textContent?.trim() || "";
      const body = drawer.querySelector<HTMLElement>(".drawer-body");
      if (!name || !body || name.toLowerCase().includes("carregando")) return;
      if (drawer === currentDrawer && name === currentName) return;
      cleanup();
      currentDrawer = drawer; currentName = name;
      host = document.createElement("div");
      host.className = "client-notifications-bridge-host";
      body.parentElement?.insertBefore(host, body);
      const freshPending = pending && Date.now() - pending.at < 8000 ? pending : null;
      root = createRoot(host);
      root.render(<ClientNotificationsPane clientName={name} body={body} initialNotifications={!!freshPending} highlightTitle={freshPending?.title || null} />);
      if (freshPending) pending = null;
    };

    const captureNotificationClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const button = target?.closest?.(".notification-panel .notification-list > button") as HTMLButtonElement | null;
      if (!button) return;
      const title = button.querySelector("b")?.textContent?.trim() || "";
      if (!title || isLeadDiagnostic(title)) return; // o bridge de diagnóstico de lead continua dono desse fluxo.
      pending = { title, at: Date.now() };
      window.setTimeout(mount, 80);
      window.setTimeout(mount, 350);
      window.setTimeout(mount, 900);
    };

    document.addEventListener("click", captureNotificationClick, true);
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    mount();
    return () => {
      document.removeEventListener("click", captureNotificationClick, true);
      observer.disconnect();
      cleanup();
    };
  }, []);
  return null;
}

const styles = `
.client-notifications-bridge-host{border-bottom:1px solid rgba(135,166,198,.14);background:rgba(8,18,31,.78)}
.cn-tabbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 26px;border-top:1px solid rgba(135,166,198,.1);background:rgba(7,16,28,.74);backdrop-filter:blur(12px)}
.cn-tabs{display:flex;gap:5px}.cn-tabs button,.cn-filters button{border:1px solid transparent;background:transparent;color:#8fa6bd;border-radius:9px;padding:8px 12px;font:600 11px/1 Inter,sans-serif;cursor:pointer}.cn-tabs button:hover,.cn-filters button:hover{color:#dceaf7;background:rgba(78,146,209,.08)}.cn-tabs button.active,.cn-filters button.active{color:#eef8ff;background:rgba(62,146,220,.16);border-color:rgba(62,146,220,.25)}.cn-tabs button b{display:inline-flex;min-width:18px;height:18px;align-items:center;justify-content:center;margin-left:7px;padding:0 5px;border-radius:999px;background:#e15d43;color:white;font-size:9px}.cn-summary{font-size:10px;color:#86a0b8;white-space:nowrap}.cn-summary b{color:#d9e8f5;margin:0 3px}.cn-summary.critical{color:#f1a18f}.cn-summary.critical b{color:#ff8068}
.cn-panel{padding:22px 26px 34px;min-height:420px;background:linear-gradient(180deg,rgba(7,17,30,.97),rgba(6,14,25,.99))}.cn-panel-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:16px}.cn-panel-head .eyebrow{font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:#6f8aa4}.cn-panel-head h3{font:700 18px/1.2 'Inter Tight',Inter,sans-serif;color:#f2f7fb;margin:5px 0}.cn-panel-head p{font-size:11px;color:#7690a8;margin:0}.cn-refresh{border:1px solid rgba(135,166,198,.18);background:rgba(18,39,60,.62);color:#bcd0e1;border-radius:9px;padding:8px 11px;font-size:10px;cursor:pointer}.cn-refresh:disabled{opacity:.55}
.cn-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:0 0 14px}.cn-kpis article{padding:12px 13px;border:1px solid rgba(135,166,198,.13);border-radius:11px;background:rgba(17,36,55,.62)}.cn-kpis article.danger{border-color:rgba(239,91,64,.26);background:rgba(84,30,24,.2)}.cn-kpis small{display:block;font-size:8px;letter-spacing:.1em;color:#71899f}.cn-kpis b{display:block;font:700 22px/1.15 'Inter Tight',Inter,sans-serif;color:#edf6fd;margin:4px 0 1px}.cn-kpis span{font-size:9px;color:#6e879d}
.cn-filters{display:flex;gap:4px;padding:4px;border:1px solid rgba(135,166,198,.1);border-radius:11px;width:max-content;background:rgba(7,17,29,.7);margin-bottom:13px}.cn-filters button{padding:7px 10px;font-size:10px}
.cn-list{display:grid;gap:9px}.cn-item{position:relative;padding:14px 15px 13px;border:1px solid rgba(135,166,198,.13);border-left:3px solid #4c83ad;border-radius:11px;background:rgba(16,34,52,.62);transition:.16s ease}.cn-item.attention{border-left-color:#d8a73a}.cn-item.critical{border-left-color:#ec684f;background:rgba(57,27,29,.24)}.cn-item.ok{border-left-color:#3ebd91}.cn-item.highlighted{outline:2px solid rgba(80,172,246,.68);box-shadow:0 0 0 5px rgba(80,172,246,.08)}.cn-item-top{display:flex;justify-content:space-between;gap:10px;align-items:center}.cn-badges{display:flex;gap:6px;align-items:center}.cn-status,.cn-source{display:inline-flex;align-items:center;border-radius:999px;padding:4px 7px;font-size:8px;font-weight:700;letter-spacing:.03em}.cn-status{background:rgba(74,131,173,.13);color:#8fc3e9}.cn-status.attention{background:rgba(216,167,58,.12);color:#e5c36d}.cn-status.critical{background:rgba(236,104,79,.13);color:#f19987}.cn-status.ok{background:rgba(62,189,145,.12);color:#78d6b5}.cn-source{background:rgba(135,166,198,.08);color:#7792aa}.cn-item time{font-size:9px;color:#657f96}.cn-item h4{font:650 13px/1.35 Inter,sans-serif;color:#e7f0f8;margin:10px 0 4px}.cn-description{font-size:10.5px;line-height:1.5;color:#98adbf;margin:0}.cn-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:9px;color:#6f889f}.cn-meta b{color:#93a9bc}.cn-next{display:grid;gap:3px;margin-top:10px;padding:9px 10px;border-radius:8px;background:rgba(62,146,220,.07);border:1px solid rgba(62,146,220,.11)}.cn-next b{font-size:8px;color:#6e9fc7;text-transform:uppercase;letter-spacing:.08em}.cn-next span{font-size:10px;color:#b2c7d8}.cn-resolved{margin-top:9px;font-size:9px;color:#69bc9d}.cn-actions{display:flex;justify-content:flex-end;margin-top:10px}.cn-actions button{border:1px solid rgba(62,146,220,.2);background:rgba(62,146,220,.11);color:#9bc8ea;border-radius:8px;padding:6px 9px;font-size:9px;cursor:pointer}.cn-error,.cn-empty{padding:28px;text-align:center;border:1px dashed rgba(135,166,198,.16);border-radius:10px;color:#7791a8;font-size:11px}.cn-error{color:#e99a86;border-color:rgba(233,105,78,.2)}
@media(max-width:760px){.cn-tabbar{padding:9px 14px;align-items:flex-start;flex-direction:column}.cn-panel{padding:16px 14px 28px}.cn-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.cn-panel-head{flex-direction:column}.cn-summary{white-space:normal}}
`;
