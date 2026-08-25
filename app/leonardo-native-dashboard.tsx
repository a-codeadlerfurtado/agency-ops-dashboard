"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  BrandMark,
  Metric,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  initials,
  supabase,
  text,
} from "./shared";

const CreativeCenter = lazy(() => import("./views/creative").then((m) => ({ default: m.CreativeCenter })));

type Row = Record<string, any>;
type Tab = "home" | "funnel" | "clients" | "campaigns" | "meetings" | "direction" | "creative" | "clickup";
type NavItem = { key: string; label: string; tab?: Tab; href?: string };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const CLICKUP_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-clickup-api`;
const NAV: NavItem[] = [
  { key: "home", label: "Home Comercial", tab: "home" },
  { key: "funnel", label: "Funil Comercial", tab: "funnel" },
  { key: "clients", label: "Clientes", tab: "clients" },
  { key: "campaigns", label: "Campanhas", tab: "campaigns" },
  { key: "meetings", label: "Reuniões", tab: "meetings" },
  { key: "direction", label: "Direção Comercial", tab: "direction" },
  { key: "finance", label: "Financeiro", href: "/finance" },
  { key: "onboarding", label: "Onboarding", href: "/leonardo-onboarding" },
  { key: "creative", label: "Central Criativa", tab: "creative" },
  { key: "work", label: "Central de Trabalho", href: "/leonardo-work" },
  { key: "clickup", label: "ClickUp", tab: "clickup" },
  { key: "diary", label: "Diário", href: "/leonardo-diary" },
  { key: "tasklog", label: "TaskLog", href: "/leonardo-diary?tab=tasklog" },
];

const stageLabel: Record<string, string> = {
  novo: "Novo", qualificacao: "Qualificação", reuniao: "Reunião", proposta: "Proposta",
  negociacao: "Negociação", fechado: "Fechado", perdido: "Perdido",
};
const lifecycleLabel: Record<string, string> = { ACTIVE: "Ativo", ONBOARDING: "Onboarding", CHURNED: "Churned" };
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const number = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const money = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const dateTime = (value: unknown) => {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(parsed);
};

function HomeView({ data }: { data: Row }) {
  const summary = data.summary || {};
  const stages: Row[] = data.stage_summary || [];
  const performance: Row[] = data.performance || [];
  return <div className="leo-native-stack">
    <section className="grid kpis leo-native-kpis">
      <Metric label="Leads abertos" value={number(summary.open_leads)} tone="blue" hint={`${number(summary.new_7d)} novos nos últimos 7 dias`} />
      <Metric label="Oportunidades avançadas" value={number(summary.advanced_opportunities)} tone="yellow" hint="reunião, proposta ou negociação" />
      <Metric label="Forecast ponderado" value={money(summary.weighted_forecast_value)} tone="blue" hint="pipeline comercial informado" />
      <Metric label="Fechados · 30 dias" value={number(summary.won_30d)} tone="green" hint={`${money(summary.won_monthly_30d)} em mensalidades`} />
      <Metric label="Clientes ativos" value={number(summary.active_clients)} tone="blue" hint="ativos + onboarding" />
      <Metric label="Campanhas ativas" value={number(summary.active_campaigns)} tone="green" hint={`${number(summary.meetings_7d)} reuniões em 7 dias`} />
    </section>
    <section className="leo-native-sources">
      {[["CRM Comercial", data.sources?.crm], ["Reuniões", data.sources?.meetings], ["Campanhas", data.sources?.campaigns]].map(([label, source]: any) => <article className="card section leo-native-source" key={label}>
        <div><span className={`dot ${source?.stale ? "loading" : ""}`} /><b>{label}</b></div>
        <strong className={source?.stale ? "yellow" : "green"}>{source?.stale ? "Fonte desatualizada" : "Fonte atual"}</strong>
        <small>{source?.updated_at ? dateTime(source.updated_at) : "Sem registro de atualização"}</small>
      </article>)}
    </section>
    <section className="leo-native-grid2">
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Pipeline</span><h3>Etapas do funil</h3></div></div>{stages.length ? stages.map((row) => <div className="leo-native-row" key={row.stage}><span><b>{stageLabel[row.stage] || text(row.stage)}</b><small>{number(row.count)} oportunidades</small></span><strong>{money(row.weighted_value)}</strong></div>) : <div className="empty">Sem oportunidades no funil.</div>}</article>
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Time comercial</span><h3>Resultado por responsável</h3></div></div>{performance.length ? performance.map((row) => <div className="leo-native-row" key={row.owner_id || row.owner_name}><span><b>{text(row.owner_name)}</b><small>{number(row.open_leads)} abertos · {number(row.proposals)} propostas · {number(row.negotiations)} negociações</small></span><span className="leo-native-right"><strong>{money(row.weighted_value)}</strong><small>{number(row.won_30d)} fechados em 30d</small></span></div>) : <div className="empty">Sem responsáveis comerciais encontrados.</div>}</article>
    </section>
  </div>;
}

function FunnelView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("OPEN");
  const leads: Row[] = data.leads || [];
  const visible = useMemo(() => leads.filter((row) => {
    const current = String(row.stage || "");
    const stageOk = stage === "ALL" || (stage === "OPEN" ? !["fechado", "perdido"].includes(current) : current === stage);
    const q = norm(query);
    return stageOk && (!q || norm(`${row.name || ""} ${row.company || ""} ${row.owner_name || ""} ${row.source || ""}`).includes(q));
  }), [leads, query, stage]);
  return <section className="card section workspace">
    <div className="workspace-head"><div><span className="eyebrow">CRM Comercial</span><h2>Funil Comercial</h2><p>Oportunidades e evolução do pipeline comercial.</p></div><span className="counter">{visible.length} oportunidades</span></div>
    <div className="toolbar leo-native-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar lead, empresa ou origem"/><select className="control" value={stage} onChange={(e) => setStage(e.target.value)}><option value="OPEN">Em aberto</option><option value="ALL">Todas</option>{Object.entries(stageLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    <div className="table-wrap"><table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Atualizado</th><th>Valor</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b>{row.company && <div className="small">{text(row.name)}</div>}</td><td>{text(row.owner_name)}</td><td>{stageLabel[row.stage] || text(row.stage)}</td><td>{text(row.source)}</td><td>{dateTime(row.updated_at)}</td><td>{Number(row.estimated_value || 0) ? money(row.estimated_value) : "não informado"}</td></tr>)}</tbody></table></div>
    {!visible.length && <div className="empty">Nenhuma oportunidade nesse filtro.</div>}
  </section>;
}

function ClientsView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("ACTIVE");
  const clients: Row[] = data.portfolio_clients || [];
  const visible = useMemo(() => clients.filter((row) => {
    const lifeOk = lifecycle === "ALL" || (lifecycle === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle)) : String(row.lifecycle) === lifecycle);
    const q = norm(query);
    return lifeOk && (!q || norm(`${row.display_name || ""} ${row.service || ""} ${row.cs_owner || ""} ${row.gt_owner || ""}`).includes(q));
  }), [clients, query, lifecycle]);
  return <section className="card section workspace">
    <div className="workspace-head"><div><span className="eyebrow">Carteira</span><h2>Clientes</h2><p>Visão comercial da carteira da agência.</p></div><span className="counter">{visible.length} clientes</span></div>
    <div className="toolbar leo-native-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, serviço ou responsável"/><select className="control" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="ACTIVE">Ativos + onboarding</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select></div>
    <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Tempo conosco</th><th>CS</th><th>GT</th><th>Campanhas</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{lifecycleLabel[row.lifecycle] || text(row.lifecycle)}</td><td>{text(row.service)}</td><td>{row.client_days == null ? "—" : `${number(row.client_days)}d`}</td><td>{text(row.cs_owner)}</td><td>{text(row.gt_owner)}</td><td>{row.campaign ? `${number(row.campaign.active_campaigns)} ativas` : "sem campanha ativa"}</td></tr>)}</tbody></table></div>
  </section>;
}

function CampaignsView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const campaigns: Row[] = data.campaigns || [];
  const visible = campaigns.filter((row) => !norm(query) || norm(`${row.display_name || ""} ${row.gt_owner || ""}`).includes(norm(query)));
  return <section className="card section workspace">
    <div className="workspace-head"><div><span className="eyebrow">Mídia</span><h2>Campanhas</h2><p>Performance das campanhas para contexto comercial.</p></div><span className="counter">{visible.length} clientes com mídia</span></div>
    <div className="toolbar leo-native-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou gestor"/></div>
    <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>GT</th><th>Campanhas ativas</th><th>Investimento</th><th>Leads</th><th>Custo/resultado</th><th>CTR</th><th>Referência</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{text(row.gt_owner)}</td><td>{number(row.active_campaigns)}</td><td>{money(row.spend)}</td><td>{number(row.leads)}</td><td>{Number(row.cost_per_result || 0) ? money(row.cost_per_result) : "—"}</td><td>{row.ctr == null ? "—" : `${number(row.ctr)}%`}</td><td>{text(row.reference_date)}</td></tr>)}</tbody></table></div>
  </section>;
}

function MeetingsView({ data }: { data: Row }) {
  const meetings: Row[] = data.meetings || [];
  return <section className="workspace">
    <div className="workspace-head"><div><span className="eyebrow">Agenda comercial</span><h2>Reuniões</h2><p>Histórico e contexto das reuniões do comercial.</p></div><span className="counter">{meetings.length} reuniões</span></div>
    <div className="leo-native-grid2">{meetings.length ? meetings.slice(0, 60).map((row) => <article className="card section" key={row.id}><div className="panel-heading"><div><span className="eyebrow">{text(row.owner)}</span><h3>{text(row.title)}</h3></div><small>{dateTime(row.meeting_started_at)}</small></div><p className="small leo-native-summary">{text(row.summary)}</p>{row.client_name && <div className="small"><b>Cliente:</b> {text(row.client_name)}</div>}</article>) : <article className="card section empty">Nenhuma reunião encontrada.</article>}</div>
  </section>;
}

function DirectionView({ data }: { data: Row }) {
  const summary = data.summary || {};
  const performance: Row[] = data.performance || [];
  const goals: Row[] = data.goals || [];
  return <div className="leo-native-stack">
    <section className="grid kpis leo-native-direction-kpis"><Metric label="Forecast ponderado" value={money(summary.weighted_forecast_value)} tone="blue" hint="pipeline aberto"/><Metric label="Mensalidades fechadas · 30d" value={money(summary.won_monthly_30d)} tone="green" hint={`${number(summary.won_30d)} contratos fechados`}/><Metric label="Implementações · 30d" value={money(summary.won_setup_30d)} tone="yellow" hint="valor confirmado no CRM"/><Metric label="Reuniões · 7d" value={number(summary.meetings_7d)} tone="blue" hint="Leonardo + Vitor"/></section>
    <section className="leo-native-grid2"><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Gestão do time</span><h3>Performance comercial</h3></div></div>{performance.length ? performance.map((row) => <div className="leo-native-row" key={row.owner_id || row.owner_name}><span><b>{text(row.owner_name)}</b><small>{number(row.open_leads)} abertos · {number(row.meetings)} reuniões · {number(row.proposals)} propostas · {number(row.negotiations)} negociações</small></span><span className="leo-native-right"><strong>{number(row.won_30d)} fechados</strong><small>{money(row.weighted_value)} forecast</small></span></div>) : <div className="empty">Sem dados de performance.</div>}</article><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Metas do mês</span><h3>Metas por closer</h3></div></div>{goals.length ? goals.map((row) => <div className="leo-native-row" key={`${row.owner_id}-${row.ano}-${row.mes}`}><span><b>{text(row.owner_name)}</b><small>Clientes: {number(row.meta_clientes)} · Mensalidade: {money(row.meta_mensalidade)}</small></span><strong>{money(row.meta_implementacao)}</strong></div>) : <div className="empty">Metas do mês ainda não cadastradas.</div>}</article></section>
  </div>;
}

function ClickUpExecutiveView({ data }: { data: Row }) {
  const monthly: Row[] = Array.isArray(data.monthly) ? data.monthly : [];
  const max = Math.max(1, ...monthly.map((row) => Number(row.completed || 0)));
  const lastSync = data.last_sync || {};
  return <div className="leo-native-stack">
    <section className="workspace-head"><div><span className="eyebrow">ClickUp · visão executiva</span><h2>Volume de tarefas da agência</h2><p>Indicadores consolidados. Este perfil não recebe nomes, rankings, assignees ou comparação entre colaboradores.</p></div><span className="counter">desde janeiro de {number(data.year || 2026)}</span></section>
    <section className="grid kpis leo-clickup-kpis">
      <Metric label="Concluídas registradas" value={`${number(data.completed_since_jan)} tarefas`} tone="green" hint={`desde janeiro de ${number(data.year || 2026)}`} />
      <Metric label="Criadas desde janeiro" value={`${number(data.created_since_jan)} tarefas`} tone="blue" hint="volume total registrado" />
      <Metric label="Concluídas · 30 dias" value={`${number(data.completed_30d)} tarefas`} tone="blue" hint={`${number(data.completed_7d)} nos últimos 7 dias`} />
      <Metric label="Em aberto agora" value={`${number(data.open_now)} tarefas`} tone="yellow" hint="consolidado da agência" />
      <Metric label="Vencidas agora" value={`${number(data.overdue_now)} tarefas`} tone={Number(data.overdue_now || 0) ? "red" : "green"} hint="sem detalhamento individual" />
      <Metric label="Vinculadas a clientes" value={`${number(data.completed_linked_to_client)} tarefas`} tone="blue" hint="concluídas desde janeiro" />
    </section>
    <section className="leo-native-grid2">
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Evolução mensal</span><h3>Tarefas concluídas</h3></div><b>{number(data.completion_rate_pct)}%</b></div><p className="small">Relação consolidada entre tarefas concluídas e criadas desde janeiro.</p><div className="leo-clickup-months">{monthly.map((row) => <div className="leo-clickup-month" key={row.month}><span>{String(row.month || "").split("-").reverse().join("/")}</span><div><i style={{ width: `${Math.max(3, Math.round((Number(row.completed || 0) / max) * 100))}%` }} /></div><b>{number(row.completed)}</b></div>)}</div>{!monthly.length && <div className="empty">Sem série mensal disponível.</div>}</article>
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Sincronização</span><h3>Estado da fonte</h3></div><span className={`chip ${String(lastSync.status || "").toUpperCase() === "SUCCESS" ? "COMPLETE" : "PARTIAL"}`}>{text(lastSync.status || "Sem execução")}</span></div><div className="leo-clickup-sync"><div><span>Última sincronização das tarefas</span><b>{dateTime(data.last_task_sync)}</b></div><div><span>Última execução</span><b>{dateTime(lastSync.finished_at || lastSync.started_at)}</b></div><div><span>Tarefas vistas na execução</span><b>{number(lastSync.tasks_seen)}</b></div><div><span>Tarefas atualizadas</span><b>{number(lastSync.tasks_upserted)}</b></div></div><div className="source-banner leo-clickup-note"><span>Privacidade interna:</span> esta tela é deliberadamente agregada. Produtividade por pessoa, filtros por colaborador e ranking não fazem parte deste endpoint.</div></article>
    </section>
  </div>;
}

function CommercialContent({ tab, data, clickup, token }: { tab: Tab; data: Row; clickup: Row; token: string }) {
  if (tab === "creative") return <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando Central Criativa…</div>}><CreativeCenter token={token} /></Suspense>;
  if (tab === "clickup") return <ClickUpExecutiveView data={clickup} />;
  if (tab === "funnel") return <FunnelView data={data} />;
  if (tab === "clients") return <ClientsView data={data} />;
  if (tab === "campaigns") return <CampaignsView data={data} />;
  if (tab === "meetings") return <MeetingsView data={data} />;
  if (tab === "direction") return <DirectionView data={data} />;
  return <HomeView data={data} />;
}

export default function LeonardoNativeDashboard({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<Row>({});
  const [clickup, setClickup] = useState<Row>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const initialName = String(session.user.user_metadata?.name || session.user.user_metadata?.full_name || "Leonardo Augusto");
  const [displayName, setDisplayName] = useState(initialName);
  const [draftName, setDraftName] = useState(initialName);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => { try { const stored = window.localStorage.getItem("ops-theme"); if (stored === "light" || stored === "dark") setTheme(stored); } catch { /* ignore */ } }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { window.localStorage.setItem("ops-theme", theme); } catch { /* ignore */ } }, [theme]);
  useEffect(() => { document.documentElement.style.setProperty("--sidenav-width", sidebarOpen ? "224px" : "58px"); }, [sidebarOpen]);

  const load = useCallback(async () => {
    if (tab === "creative") { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const endpoint = tab === "clickup" ? CLICKUP_API : API;
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      if (tab === "clickup") setClickup(body?.clickup || {}); else setData(body || {});
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar dados."); }
    finally { setLoading(false); }
  }, [session.access_token, tab]);

  useEffect(() => { void load(); if (tab === "creative") return; const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [load, tab]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") { setProfileOpen(false); setSettingsOpen(false); setCommandOpen(false); setNotificationsOpen(false); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, []);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault(); const next = draftName.trim(); if (!next) return; setSavingProfile(true);
    try { const { error: updateError } = await supabase.auth.updateUser({ data: { name: next, full_name: next } }); if (updateError) throw updateError; setDisplayName(next); setSettingsOpen(false); setProfileOpen(false); }
    finally { setSavingProfile(false); }
  };
  const openItem = (item: NavItem) => { if (item.href) { window.location.assign(item.href); return; } if (item.tab) { setTab(item.tab); setProfileOpen(false); setNotificationsOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); } };
  const meetingNotifications: Row[] = (data.meetings || []).slice(0, 5);
  const hasCurrentData = tab === "clickup" ? Object.keys(clickup).length > 0 : Object.keys(data).length > 0;

  return <>
    <main className={`shell ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      <header className="top">
        <div className="brand"><div className="logo"><BrandMark /></div><div><span className="brand-name">Leonardo Imobi</span><h1>Central Comercial</h1><div className="subtitle">Vendas, clientes, campanhas, onboarding e gestão comercial em um só lugar</div></div></div>
        <div className="live"><span className={`dot ${loading ? "loading" : error ? "error" : ""}`} /><span role="status" aria-live="polite">{loading ? "Atualizando…" : error ? "Problema de sincronização" : "Sistemas sincronizados"}</span><button className="command-trigger" onClick={() => setCommandOpen(true)}>⌕ Pesquisar <kbd>Ctrl K</kbd></button><div className="leo-native-popover-wrap"><button className="icon-btn" onClick={() => setNotificationsOpen((value) => !value)} aria-label="Notificações">♢</button>{notificationsOpen && <div className="card leo-native-popover"><b>Reuniões recentes</b>{meetingNotifications.length ? meetingNotifications.map((row) => <button key={row.id} onClick={() => { setTab("meetings"); setNotificationsOpen(false); }}><span>{text(row.title)}</span><small>{dateTime(row.meeting_started_at)}</small></button>) : <small>Sem reuniões recentes.</small>}</div>}</div><button className="btn" onClick={() => void load()}>Atualizar</button><button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Alternar tema">{theme === "dark" ? "☀" : "☾"}</button><div className="leo-native-popover-wrap"><button className="profile-trigger" onClick={() => setProfileOpen((value) => !value)}><span className="avatar small-avatar">{initials(displayName)}</span><span><b>{displayName}</b><small>Direção Comercial</small></span></button>{profileOpen && <div className="card leo-native-profile-menu"><button onClick={() => { setDraftName(displayName); setSettingsOpen(true); }}>Perfil e preferências</button><button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Alternar tema</button><button onClick={() => void supabase.auth.signOut()}>Sair</button></div>}</div></div>
      </header>
      <div className="source-banner"><span>Visão executiva comercial.</span> Comercial, financeiro, onboarding e indicadores consolidados permanecem acessíveis; a operação geral continua fora deste perfil.</div>
      <aside className={`side-nav${sidebarOpen ? " open" : ""}`} aria-label="Visões do dashboard"><button className="side-nav-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "Recolher menu" : "Expandir menu"} title={sidebarOpen ? "Recolher menu" : "Expandir menu"}>{sidebarOpen ? "⟨" : "⟩"}</button><div className="side-nav-items">{NAV.map((item) => <button key={item.key} className={item.tab === tab && !item.href ? "active" : ""} onClick={() => openItem(item)} title={item.label}>{item.label}</button>)}</div></aside>
      {error && <div className="error-box">{error}</div>}
      {loading && !hasCurrentData && tab !== "creative" ? <div className="auth-loading"><span className="dot loading"/> Carregando…</div> : <CommercialContent tab={tab} data={data} clickup={clickup} token={session.access_token} />}
    </main>

    {commandOpen && <div className="leo-native-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandOpen(false); }}><section className="card leo-native-command" role="dialog" aria-modal="true"><div className="workspace-head"><div><span className="eyebrow">Navegação rápida</span><h2>Pesquisar no perfil</h2></div><button className="theme-btn" onClick={() => setCommandOpen(false)}>×</button></div><div className="leo-native-command-grid">{NAV.map((item) => <button key={item.key} onClick={() => { openItem(item); setCommandOpen(false); }}>{item.label}</button>)}</div></section></div>}
    {settingsOpen && <div className="leo-native-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false); }}><form className="card leo-native-settings" onSubmit={saveProfile}><div className="workspace-head"><div><span className="eyebrow">Perfil</span><h2>Perfil e preferências</h2><p>Altere o nome exibido no dashboard.</p></div><button type="button" className="theme-btn" onClick={() => setSettingsOpen(false)}>×</button></div><label>Nome exibido<input className="control" value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label><label>E-mail<input className="control" value={session.user.email || ""} readOnly /></label><div className="leo-native-settings-actions"><button type="button" className="btn" onClick={() => setSettingsOpen(false)}>Cancelar</button><button className="btn" disabled={savingProfile}>{savingProfile ? "Salvando…" : "Salvar perfil"}</button></div></form></div>}

    <style>{`
      .leo-native-stack{display:grid;gap:14px}.leo-native-kpis{grid-template-columns:repeat(6,minmax(130px,1fr))}.leo-native-direction-kpis{grid-template-columns:repeat(4,minmax(150px,1fr))}.leo-clickup-kpis{grid-template-columns:repeat(6,minmax(130px,1fr))}
      .leo-native-sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.leo-native-source>div{display:flex;align-items:center;gap:8px}.leo-native-source strong,.leo-native-source small{display:block;margin-top:7px}.leo-native-source small{color:var(--muted)}
      .leo-native-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.leo-native-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 2px;border-bottom:1px solid var(--line)}.leo-native-row:last-child{border-bottom:0}.leo-native-row>span{display:flex;flex-direction:column;min-width:0}.leo-native-row small{color:var(--muted);font-size:11px;margin-top:3px}.leo-native-right{text-align:right}.leo-native-toolbar{margin-bottom:14px}.leo-native-summary{white-space:normal;line-height:1.55;max-width:none}
      .leo-clickup-months{display:grid;gap:10px;margin-top:18px}.leo-clickup-month{display:grid;grid-template-columns:58px 1fr 54px;align-items:center;gap:10px}.leo-clickup-month>span,.leo-clickup-month>b{font-size:11px}.leo-clickup-month>b{text-align:right}.leo-clickup-month>div{height:8px;background:var(--panel2);border-radius:999px;overflow:hidden}.leo-clickup-month i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--blue),var(--green))}.leo-clickup-sync{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:17px}.leo-clickup-sync>div{padding:12px;border:1px solid var(--line);background:var(--panel2);border-radius:11px}.leo-clickup-sync span,.leo-clickup-sync b{display:block}.leo-clickup-sync span{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.leo-clickup-sync b{margin-top:5px;font-size:13px}.leo-clickup-note{margin:14px 0 0}
      .leo-native-popover-wrap{position:relative}.leo-native-popover,.leo-native-profile-menu{position:absolute;right:0;top:calc(100% + 9px);z-index:90;min-width:260px;padding:10px}.leo-native-popover>b{display:block;padding:5px 7px 9px}.leo-native-popover button,.leo-native-profile-menu button{display:flex;width:100%;flex-direction:column;gap:3px;text-align:left;border:0;border-radius:8px;background:transparent;color:var(--text);padding:9px;cursor:pointer}.leo-native-profile-menu button{display:block}.leo-native-popover button:hover,.leo-native-profile-menu button:hover{background:var(--wash)}.leo-native-popover small{color:var(--muted)}
      .leo-native-modal-backdrop{position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.62);display:grid;place-items:center;padding:20px}.leo-native-command,.leo-native-settings{width:min(620px,96vw);padding:20px;max-height:84vh;overflow:auto}.leo-native-command-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.leo-native-command-grid button{border:1px solid var(--line);border-radius:10px;background:var(--panel2);color:var(--text);padding:12px;text-align:left;cursor:pointer}.leo-native-command-grid button:hover{border-color:var(--blue)}.leo-native-settings label{display:grid;gap:6px;margin:12px 0;color:var(--muted);font-size:12px}.leo-native-settings .control{width:100%}.leo-native-settings-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
      @media(max-width:1100px){.leo-native-kpis,.leo-clickup-kpis{grid-template-columns:repeat(3,minmax(130px,1fr))}.leo-native-sources,.leo-native-grid2{grid-template-columns:1fr}.live>span[role=status]{display:none}}
      @media(max-width:720px){.leo-native-kpis,.leo-native-direction-kpis,.leo-clickup-kpis{grid-template-columns:repeat(2,minmax(120px,1fr))}.command-trigger{display:none}.leo-native-command-grid,.leo-clickup-sync{grid-template-columns:1fr}}
    `}</style>
  </>;
}
