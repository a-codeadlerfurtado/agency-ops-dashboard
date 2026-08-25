"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { CreativeCenter } from "./views/creative";
import { Metric, SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase, text } from "./shared";

type Row = Record<string, any>;
type Tab = "home" | "funnel" | "clients" | "campaigns" | "meetings" | "direction" | "creative";

type NavItem = { key: string; label: string; tab?: Tab; href?: string };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
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
  { key: "diary", label: "Diário", href: "/leonardo-diary" },
  { key: "tasklog", label: "TaskLog", href: "/leonardo-diary?tab=tasklog" },
];

const stageLabel: Record<string, string> = {
  novo: "Novo", qualificacao: "Qualificação", reuniao: "Reunião", proposta: "Proposta",
  negociacao: "Negociação", fechado: "Fechado", perdido: "Perdido",
};
const lifecycleLabel: Record<string, string> = { ACTIVE: "Ativo", ONBOARDING: "Onboarding", CHURNED: "Churned" };
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const num = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const money = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const dateTime = (value: unknown) => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(String(value))) : "—";

function CommercialHome({ data }: { data: Row }) {
  const s = data.summary || {};
  const stages: Row[] = data.stage_summary || [];
  const performance: Row[] = data.performance || [];
  return <div className="leo-unified-stack">
    <section className="grid kpis leo-commercial-kpis">
      <Metric label="Leads abertos" value={num(s.open_leads)} tone="blue" hint={`${num(s.new_7d)} novos nos últimos 7 dias`} />
      <Metric label="Oportunidades avançadas" value={num(s.advanced_opportunities)} tone="yellow" hint="reunião, proposta ou negociação" />
      <Metric label="Forecast ponderado" value={money(s.weighted_forecast_value)} tone="blue" hint="pipeline comercial informado" />
      <Metric label="Fechados · 30 dias" value={num(s.won_30d)} tone="green" hint={`${money(s.won_monthly_30d)} em mensalidades`} />
      <Metric label="Clientes ativos" value={num(s.active_clients)} tone="blue" hint="ativos + onboarding" />
      <Metric label="Campanhas ativas" value={num(s.active_campaigns)} tone="green" hint={`${num(s.meetings_7d)} reuniões em 7 dias`} />
    </section>
    <section className="leo-source-grid">
      {[["CRM Comercial", data.sources?.crm], ["Reuniões", data.sources?.meetings], ["Campanhas", data.sources?.campaigns]].map(([name, source]: any) => <article className="card section leo-source" key={name}><div><span className={`dot ${source?.stale ? "loading" : ""}`} /><b>{name}</b></div><strong className={source?.stale ? "yellow" : "green"}>{source?.stale ? "Fonte desatualizada" : "Fonte atual"}</strong><small>{source?.updated_at ? dateTime(source.updated_at) : "Sem registro de atualização"}</small></article>)}
    </section>
    <section className="leo-grid2">
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Pipeline</span><h3>Etapas do funil</h3></div></div>{stages.length ? stages.map((row) => <div className="leo-row" key={row.stage}><span><b>{stageLabel[row.stage] || text(row.stage)}</b><small>{num(row.count)} oportunidades</small></span><strong>{money(row.weighted_value)}</strong></div>) : <div className="empty">Sem oportunidades no funil.</div>}</article>
      <article className="card section"><div className="panel-heading"><div><span className="eyebrow">Time comercial</span><h3>Resultado por responsável</h3></div></div>{performance.length ? performance.map((row) => <div className="leo-row" key={row.owner_id || row.owner_name}><span><b>{text(row.owner_name)}</b><small>{num(row.open_leads)} abertos · {num(row.proposals)} propostas · {num(row.negotiations)} negociações</small></span><span className="leo-row-right"><strong>{money(row.weighted_value)}</strong><small>{num(row.won_30d)} fechados em 30d</small></span></div>) : <div className="empty">Sem responsáveis comerciais encontrados.</div>}</article>
    </section>
  </div>;
}

function Funnel({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("OPEN");
  const leads: Row[] = data.leads || [];
  const visible = useMemo(() => leads.filter((row) => {
    const stageOk = stage === "ALL" || (stage === "OPEN" ? !["fechado", "perdido"].includes(String(row.stage)) : String(row.stage) === stage);
    return stageOk && (!norm(query) || norm(`${row.name} ${row.company} ${row.owner_name} ${row.source}`).includes(norm(query)));
  }), [leads, query, stage]);
  return <section className="card section"><div className="workspace-head"><div><span className="eyebrow">CRM Comercial</span><h2>Funil Comercial</h2><p>Oportunidades e evolução do pipeline comercial.</p></div><span className="counter">{visible.length} oportunidades</span></div><div className="toolbar leo-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar lead, empresa ou origem"/><select className="control" value={stage} onChange={(e) => setStage(e.target.value)}><option value="OPEN">Em aberto</option><option value="ALL">Todas</option>{Object.entries(stageLabel).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Atualizado</th><th>Valor</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b>{row.company && <div className="small">{text(row.name)}</div>}</td><td>{text(row.owner_name)}</td><td>{stageLabel[row.stage] || text(row.stage)}</td><td>{text(row.source)}</td><td>{dateTime(row.updated_at)}</td><td>{Number(row.estimated_value || 0) ? money(row.estimated_value) : "não informado"}</td></tr>)}</tbody></table></div>{!visible.length && <div className="empty">Nenhuma oportunidade nesse filtro.</div>}</section>;
}

function Clients({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [life, setLife] = useState("ACTIVE");
  const rows: Row[] = data.portfolio_clients || [];
  const visible = useMemo(() => rows.filter((row) => {
    const lifeOk = life === "ALL" || (life === "ACTIVE" ? ["ACTIVE","ONBOARDING"].includes(String(row.lifecycle)) : String(row.lifecycle) === life);
    return lifeOk && (!norm(query) || norm(`${row.display_name} ${row.service} ${row.cs_owner} ${row.gt_owner}`).includes(norm(query)));
  }), [rows, query, life]);
  return <section className="card section"><div className="workspace-head"><div><span className="eyebrow">Carteira</span><h2>Clientes</h2><p>Visão comercial da carteira da agência.</p></div><span className="counter">{visible.length} clientes</span></div><div className="toolbar leo-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, serviço ou responsável"/><select className="control" value={life} onChange={(e) => setLife(e.target.value)}><option value="ACTIVE">Ativos + onboarding</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select></div><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Tempo conosco</th><th>CS</th><th>GT</th><th>Campanhas</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{lifecycleLabel[row.lifecycle] || text(row.lifecycle)}</td><td>{text(row.service)}</td><td>{row.client_days == null ? "—" : `${num(row.client_days)}d`}</td><td>{text(row.cs_owner)}</td><td>{text(row.gt_owner)}</td><td>{row.campaign ? `${num(row.campaign.active_campaigns)} ativas` : "sem campanha ativa"}</td></tr>)}</tbody></table></div></section>;
}

function Campaigns({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const rows: Row[] = data.campaigns || [];
  const visible = rows.filter((row) => !norm(query) || norm(`${row.display_name} ${row.gt_owner}`).includes(norm(query)));
  return <section className="card section"><div className="workspace-head"><div><span className="eyebrow">Mídia</span><h2>Campanhas</h2><p>Performance das campanhas para contexto comercial.</p></div><span className="counter">{visible.length} clientes com mídia</span></div><div className="toolbar leo-toolbar"><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou gestor"/></div><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>GT</th><th>Campanhas ativas</th><th>Investimento</th><th>Leads</th><th>Custo/resultado</th><th>CTR</th><th>Referência</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{text(row.gt_owner)}</td><td>{num(row.active_campaigns)}</td><td>{money(row.spend)}</td><td>{num(row.leads)}</td><td>{Number(row.cost_per_result || 0) ? money(row.cost_per_result) : "—"}</td><td>{row.ctr == null ? "—" : `${num(row.ctr)}%`}</td><td>{text(row.reference_date)}</td></tr>)}</tbody></table></div></section>;
}

function Meetings({ data }: { data: Row }) {
  const rows: Row[] = data.meetings || [];
  return <section><div className="workspace-head"><div><span className="eyebrow">Agenda comercial</span><h2>Reuniões</h2><p>Histórico e contexto das reuniões do comercial.</p></div><span className="counter">{rows.length} reuniões</span></div><div className="leo-grid2">{rows.length ? rows.slice(0, 60).map((row) => <article className="card section" key={row.id}><div className="panel-heading"><div><span className="eyebrow">{text(row.owner)}</span><h3>{text(row.title)}</h3></div><small>{dateTime(row.meeting_started_at)}</small></div><p className="small leo-meeting-summary">{text(row.summary)}</p>{row.client_name && <div className="small"><b>Cliente:</b> {text(row.client_name)}</div>}</article>) : <div className="card section empty">Nenhuma reunião encontrada.</div>}</div></section>;
}

function Direction({ data }: { data: Row }) {
  const s = data.summary || {};
  const performance: Row[] = data.performance || [];
  const goals: Row[] = data.goals || [];
  return <div className="leo-unified-stack"><section className="grid kpis leo-direction-kpis"><Metric label="Forecast ponderado" value={money(s.weighted_forecast_value)} tone="blue" hint="pipeline aberto"/><Metric label="Mensalidades fechadas · 30d" value={money(s.won_monthly_30d)} tone="green" hint={`${num(s.won_30d)} contratos fechados`}/><Metric label="Implementações · 30d" value={money(s.won_setup_30d)} tone="yellow" hint="valor confirmado no CRM"/><Metric label="Reuniões · 7d" value={num(s.meetings_7d)} tone="blue" hint="Leonardo + Vitor"/></section><section className="leo-grid2"><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Gestão do time</span><h3>Performance comercial</h3></div></div>{performance.map((row) => <div className="leo-row" key={row.owner_id || row.owner_name}><span><b>{text(row.owner_name)}</b><small>{num(row.open_leads)} abertos · {num(row.meetings)} reuniões · {num(row.proposals)} propostas · {num(row.negotiations)} negociações</small></span><span className="leo-row-right"><strong>{num(row.won_30d)} fechados</strong><small>{money(row.weighted_value)} forecast</small></span></div>)}</article><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Metas do mês</span><h3>Metas por closer</h3></div></div>{goals.length ? goals.map((row) => <div className="leo-row" key={`${row.owner_id}-${row.ano}-${row.mes}`}><span><b>{text(row.owner_name)}</b><small>Clientes: {num(row.meta_clientes)} · Mensalidade: {money(row.meta_mensalidade)}</small></span><strong>{money(row.meta_implementacao)}</strong></div>) : <div className="empty">Metas do mês ainda não cadastradas.</div>}</article></section></div>;
}

function CommercialContent({ tab, data, token }: { tab: Tab; data: Row; token: string }) {
  if (tab === "creative") return <CreativeCenter token={token} />;
  if (tab === "funnel") return <Funnel data={data}/>;
  if (tab === "clients") return <Clients data={data}/>;
  if (tab === "campaigns") return <Campaigns data={data}/>;
  if (tab === "meetings") return <Meetings data={data}/>;
  if (tab === "direction") return <Direction data={data}/>;
  return <CommercialHome data={data}/>;
}

export default function LeonardoUnifiedShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [isLeonardo, setIsLeonardo] = useState(false);
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<Row>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: auth }) => setSession(auth.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setIsLeonardo(false); return; }
    let active = true;
    loadProfileLite().then((body) => { if (active) setIsLeonardo(String(body?.profile?.person || "") === "Leonardo Augusto" && String(body?.profile?.role || "").toUpperCase() === "COMMERCIAL"); }).catch(() => { if (active) setIsLeonardo(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  const load = useCallback(async () => {
    if (!session?.access_token || !isLeonardo || tab === "creative") return;
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setData(body || {});
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar dados comerciais."); }
    finally { setLoading(false); }
  }, [session?.access_token, isLeonardo, tab]);

  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer); }, [load]);

  useEffect(() => {
    if (!isLeonardo || window.location.pathname !== "/") { setShell(null); setNavTarget(null); return; }
    let frame = 0;
    const locate = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { setShell(document.querySelector<HTMLElement>("main.shell")); setNavTarget(document.querySelector<HTMLElement>(".side-nav-items")); }); };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [isLeonardo]);

  useEffect(() => {
    if (!isLeonardo || !shell) return;
    document.documentElement.classList.add("leonardo-unified-profile");
    const applyHeader = () => {
      const title = shell.querySelector<HTMLElement>(".top .brand h1");
      const subtitle = shell.querySelector<HTMLElement>(".top .brand .subtitle");
      if (title) title.textContent = "Central Comercial";
      if (subtitle) subtitle.textContent = "Vendas, clientes, campanhas, onboarding e gestão comercial em um só lugar";
      const status = shell.querySelector<HTMLElement>(".top .live [role='status']");
      if (status) status.textContent = loading ? "Atualizando…" : error ? "Problema de sincronização" : "Sistemas sincronizados";
    };
    applyHeader();
    const observer = new MutationObserver(applyHeader);
    observer.observe(shell, { childList: true, subtree: true, characterData: true });
    const updateButton = shell.querySelector<HTMLButtonElement>(".top .live .btn");
    const onUpdate = () => { void load(); };
    updateButton?.addEventListener("click", onUpdate);
    return () => { observer.disconnect(); updateButton?.removeEventListener("click", onUpdate); document.documentElement.classList.remove("leonardo-unified-profile"); };
  }, [isLeonardo, shell, loading, error, load]);

  if (!isLeonardo || !session || !shell || !navTarget) return null;

  return <>
    <style>{styles}</style>
    {createPortal(<div className="leo-unified-nav">{NAV.map((item) => <button key={item.key} className={item.tab === tab && !item.href ? "active" : ""} title={item.label} onClick={() => { if (item.href) window.location.assign(item.href); else if (item.tab) setTab(item.tab); }}>{item.label}</button>)}</div>, navTarget)}
    {createPortal(<section className="leo-unified-content">{error && <div className="error-box">{error}</div>}{loading && !Object.keys(data).length && <div className="auth-loading"><span className="dot loading"/> Carregando Central Comercial…</div>}<CommercialContent tab={tab} data={data} token={session.access_token}/></section>, shell)}
  </>;
}

const styles = `
html.leonardo-unified-profile .shell>.source-banner,
html.leonardo-unified-profile .shell>.error-box,
html.leonardo-unified-profile .shell>.grid,
html.leonardo-unified-profile .shell>.workspace,
html.leonardo-unified-profile .shell>.card,
html.leonardo-unified-profile .shell>details,
html.leonardo-unified-profile .shell>.compact,
html.leonardo-unified-profile .shell>.standalone,
html.leonardo-unified-profile .shell>.executive-grid,
html.leonardo-unified-profile .shell>.media-section,
html.leonardo-unified-profile .shell>.split,
html.leonardo-unified-profile .shell>.health,
html.leonardo-unified-profile .shell>.funnel,
html.leonardo-unified-profile .shell>.action-columns{display:none!important}
html.leonardo-unified-profile .side-nav-items>:not(.leo-unified-nav){display:none!important}
html.leonardo-unified-profile .leo-unified-nav{display:flex;flex-direction:column;gap:4px}
html.leonardo-unified-profile .leo-unified-nav button{display:block;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:0;background:transparent;color:var(--muted);padding:10px 12px;border-radius:8px;cursor:pointer;text-align:left;font-size:13px}
html.leonardo-unified-profile .leo-unified-nav button:hover{color:var(--text);background:rgba(62,146,220,.07)}
html.leonardo-unified-profile .leo-unified-nav button.active{background:rgba(3,89,166,.24);color:var(--text);box-shadow:inset 3px 0 var(--accent)}
html.leonardo-unified-profile .leo-unified-content{display:block!important;margin-top:0;padding-bottom:60px}
html.leonardo-unified-profile .leo-unified-stack{display:grid;gap:14px}
html.leonardo-unified-profile .leo-source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
html.leonardo-unified-profile .leo-source{display:grid;gap:6px;padding:14px 16px}
html.leonardo-unified-profile .leo-source>div{display:flex;align-items:center;gap:8px}.leo-source small{color:var(--muted);font-size:11px}
html.leonardo-unified-profile .leo-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
html.leonardo-unified-profile .leo-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 2px;border-bottom:1px solid var(--line)}
html.leonardo-unified-profile .leo-row:last-child{border-bottom:0}.leo-row>span{display:flex;flex-direction:column;min-width:0}.leo-row small{color:var(--muted);font-size:11px;margin-top:3px}.leo-row-right{text-align:right}.leo-row-right strong{color:var(--text)}
html.leonardo-unified-profile .leo-toolbar{margin-bottom:14px}.leo-toolbar .control{min-width:220px}
html.leonardo-unified-profile .leo-meeting-summary{white-space:normal;line-height:1.55;max-width:none}
html.leonardo-unified-profile .leo-direction-kpis{grid-template-columns:repeat(4,minmax(130px,1fr))}
@media(max-width:1000px){html.leonardo-unified-profile .leo-source-grid,html.leonardo-unified-profile .leo-grid2{grid-template-columns:1fr}html.leonardo-unified-profile .leo-commercial-kpis{grid-template-columns:repeat(3,minmax(130px,1fr))}}
@media(max-width:700px){html.leonardo-unified-profile .leo-commercial-kpis,html.leonardo-unified-profile .leo-direction-kpis{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;
