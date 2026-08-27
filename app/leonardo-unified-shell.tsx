"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { CreativeCenter } from "./views/creative";
import LeonardoClientsTab from "./leonardo-clients-tab";
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

const stageLabel: Record<string, string> = { novo:"Novo", qualificacao:"Qualificação", reuniao:"Reunião", proposta:"Proposta", negociacao:"Negociação", fechado:"Fechado", perdido:"Perdido" };
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const num = (v: unknown) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const money = (v: unknown) => Number(v || 0).toLocaleString("pt-BR", { style:"currency", currency:"BRL", maximumFractionDigits:0 });
const dateTime = (v: unknown) => v ? new Intl.DateTimeFormat("pt-BR", { timeZone:"America/Sao_Paulo", dateStyle:"short", timeStyle:"short" }).format(new Date(String(v))) : "—";

function Home({ data }: { data: Row }) {
  const s = data.summary || {}; const stages: Row[] = data.stage_summary || []; const performance: Row[] = data.performance || [];
  return <div className="leo-stack">
    <section className="grid kpis leo-kpis"><Metric label="Leads abertos" value={num(s.open_leads)} tone="blue" hint={`${num(s.new_7d)} novos nos últimos 7 dias`} /><Metric label="Oportunidades avançadas" value={num(s.advanced_opportunities)} tone="yellow" hint="reunião, proposta ou negociação" /><Metric label="Forecast ponderado" value={money(s.weighted_forecast_value)} tone="blue" hint="pipeline comercial informado" /><Metric label="Fechados · 30 dias" value={num(s.won_30d)} tone="green" hint={`${money(s.won_monthly_30d)} em mensalidades`} /><Metric label="Clientes ativos" value={num(s.active_clients)} tone="blue" hint="ativos + onboarding" /><Metric label="Campanhas ativas" value={num(s.active_campaigns)} tone="green" hint={`${num(s.meetings_7d)} reuniões em 7 dias`} /></section>
    <section className="leo-grid2"><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Pipeline</span><h3>Etapas do funil</h3></div></div>{stages.map((r) => <div className="leo-row" key={r.stage}><span><b>{stageLabel[r.stage] || text(r.stage)}</b><small>{num(r.count)} oportunidades</small></span><strong>{money(r.weighted_value)}</strong></div>)}</article><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Time comercial</span><h3>Resultado por responsável</h3></div></div>{performance.map((r) => <div className="leo-row" key={r.owner_id || r.owner_name}><span><b>{text(r.owner_name)}</b><small>{num(r.open_leads)} abertos · {num(r.proposals)} propostas · {num(r.negotiations)} negociações</small></span><span className="leo-right"><strong>{money(r.weighted_value)}</strong><small>{num(r.won_30d)} fechados em 30d</small></span></div>)}</article></section>
  </div>;
}

function DataTable({ title, subtitle, rows, kind }: { title:string; subtitle:string; rows:Row[]; kind:"funnel"|"clients"|"campaigns" }) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => rows.filter((r) => !norm(query) || norm(`${r.name} ${r.company} ${r.display_name} ${r.owner_name} ${r.gt_owner} ${r.source}`).includes(norm(query))), [rows, query]);
  return <section className="card section"><div className="workspace-head"><div><span className="eyebrow">{kind === "funnel" ? "CRM Comercial" : kind === "campaigns" ? "Mídia" : "Carteira"}</span><h2>{title}</h2><p>{subtitle}</p></div><span className="counter">{visible.length}</span></div><div className="toolbar leo-toolbar"><input className="control" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar..."/></div><div className="table-wrap"><table><thead>{kind === "funnel" ? <tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Atualizado</th><th>Valor</th></tr> : kind === "campaigns" ? <tr><th>Cliente</th><th>GT</th><th>Campanhas</th><th>Investimento</th><th>Leads</th><th>CTR</th><th>Referência</th></tr> : <tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Tempo</th><th>CS</th><th>GT</th><th>Campanhas</th></tr>}</thead><tbody>{visible.map((r) => kind === "funnel" ? <tr key={r.id}><td><b>{text(r.company || r.name)}</b></td><td>{text(r.owner_name)}</td><td>{stageLabel[r.stage] || text(r.stage)}</td><td>{text(r.source)}</td><td>{dateTime(r.updated_at)}</td><td>{Number(r.estimated_value||0)?money(r.estimated_value):"—"}</td></tr> : kind === "campaigns" ? <tr key={r.client_id}><td><b>{text(r.display_name)}</b></td><td>{text(r.gt_owner)}</td><td>{num(r.active_campaigns)}</td><td>{money(r.spend)}</td><td>{num(r.leads)}</td><td>{r.ctr==null?"—":`${num(r.ctr)}%`}</td><td>{text(r.reference_date)}</td></tr> : <tr key={r.client_id}><td><b>{text(r.display_name)}</b></td><td>{text(r.lifecycle)}</td><td>{text(r.service)}</td><td>{r.client_days==null?"—":`${num(r.client_days)}d`}</td><td>{text(r.cs_owner)}</td><td>{text(r.gt_owner)}</td><td>{r.campaign?`${num(r.campaign.active_campaigns)} ativas`:"—"}</td></tr>)}</tbody></table></div></section>;
}

function Meetings({ data }: { data: Row }) { const rows:Row[] = data.meetings || []; return <section><div className="workspace-head"><div><span className="eyebrow">Agenda comercial</span><h2>Reuniões</h2><p>Histórico e contexto das reuniões.</p></div><span className="counter">{rows.length}</span></div><div className="leo-grid2">{rows.slice(0,60).map((r) => <article className="card section" key={r.id}><div className="panel-heading"><div><span className="eyebrow">{text(r.owner)}</span><h3>{text(r.title)}</h3></div><small>{dateTime(r.meeting_started_at)}</small></div><p className="small leo-summary">{text(r.summary)}</p></article>)}</div></section>; }

function Direction({ data }: { data: Row }) { const s=data.summary||{}; const perf:Row[]=data.performance||[]; return <div className="leo-stack"><section className="grid kpis leo-dir"><Metric label="Forecast ponderado" value={money(s.weighted_forecast_value)} tone="blue" hint="pipeline aberto"/><Metric label="Mensalidades · 30d" value={money(s.won_monthly_30d)} tone="green" hint={`${num(s.won_30d)} fechados`}/><Metric label="Implementações · 30d" value={money(s.won_setup_30d)} tone="yellow" hint="CRM"/><Metric label="Reuniões · 7d" value={num(s.meetings_7d)} tone="blue" hint="Leonardo + Vitor"/></section><article className="card section"><div className="panel-heading"><div><span className="eyebrow">Gestão do time</span><h3>Performance comercial</h3></div></div>{perf.map((r)=><div className="leo-row" key={r.owner_id||r.owner_name}><span><b>{text(r.owner_name)}</b><small>{num(r.open_leads)} abertos · {num(r.meetings)} reuniões · {num(r.proposals)} propostas · {num(r.negotiations)} negociações</small></span><span className="leo-right"><strong>{num(r.won_30d)} fechados</strong><small>{money(r.weighted_value)} forecast</small></span></div>)}</article></div>; }

function Content({ tab, data, token }: { tab:Tab; data:Row; token:string }) {
  if (tab === "creative") return <CreativeCenter token={token}/>;
  if (tab === "funnel") return <DataTable title="Funil Comercial" subtitle="Oportunidades e evolução do pipeline." rows={data.leads||[]} kind="funnel"/>;
  if (tab === "clients") return <LeonardoClientsTab rows={data.portfolio_clients||[]}/>;
  if (tab === "campaigns") return <DataTable title="Campanhas" subtitle="Performance das campanhas para contexto comercial." rows={data.campaigns||[]} kind="campaigns"/>;
  if (tab === "meetings") return <Meetings data={data}/>;
  if (tab === "direction") return <Direction data={data}/>;
  return <Home data={data}/>;
}

export default function LeonardoUnifiedShell() {
  const [session,setSession]=useState<Session|null>(null); const [isLeo,setIsLeo]=useState(false); const [shell,setShell]=useState<HTMLElement|null>(null); const [nav,setNav]=useState<HTMLElement|null>(null); const [tab,setTab]=useState<Tab>("home"); const [data,setData]=useState<Row>({}); const [loading,setLoading]=useState(false); const [error,setError]=useState("");

  useEffect(()=>{ supabase.auth.getSession().then(({data:a})=>setSession(a.session)); const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,n)=>setSession(n)); return()=>subscription.unsubscribe(); },[]);
  useEffect(()=>{ if(!session?.access_token){setIsLeo(false);return;} let active=true; loadProfileLite().then((b)=>{if(active)setIsLeo(String(b?.profile?.person||"")==="Leonardo Augusto"&&String(b?.profile?.role||"").toUpperCase()==="COMMERCIAL");}).catch(()=>{if(active)setIsLeo(false);}); return()=>{active=false}; },[session?.access_token]);

  const load=useCallback(async()=>{ if(!session?.access_token||!isLeo||tab==="creative")return; setLoading(true);setError(""); try{const r=await authenticatedFetch(API,{cache:"no-store"}); const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b?.detail||b?.error||`API ${r.status}`); setData(b||{});}catch(e){setError(e instanceof Error?e.message:"Falha ao carregar dados comerciais.");}finally{setLoading(false);} },[session?.access_token,isLeo,tab]);
  useEffect(()=>{void load(); const t=window.setInterval(()=>void load(),60000); return()=>window.clearInterval(t);},[load]);

  useEffect(()=>{ if(!isLeo||window.location.pathname!=="/"){setShell(null);setNav(null);return;} const locate=()=>{setShell(document.querySelector<HTMLElement>("main.shell"));setNav(document.querySelector<HTMLElement>(".side-nav-items"));}; locate(); const o=new MutationObserver(locate); o.observe(document.body,{childList:true,subtree:true}); return()=>o.disconnect(); },[isLeo]);

  useEffect(()=>{ if(!isLeo||!shell)return; document.documentElement.classList.add("leonardo-unified-profile"); const apply=()=>{const h=shell.querySelector<HTMLElement>(".top .brand h1");const sub=shell.querySelector<HTMLElement>(".top .brand .subtitle");const st=shell.querySelector<HTMLElement>(".top .live [role='status']"); if(h&&h.textContent!=="Central Comercial")h.textContent="Central Comercial"; const subText="Vendas, clientes, campanhas, onboarding e gestão comercial em um só lugar"; if(sub&&sub.textContent!==subText)sub.textContent=subText; const statusText=loading?"Atualizando…":error?"Problema de sincronização":"Sistemas sincronizados"; if(st&&st.textContent!==statusText)st.textContent=statusText;}; apply(); const o=new MutationObserver(apply); o.observe(shell,{childList:true,subtree:true}); const btn=shell.querySelector<HTMLButtonElement>(".top .live .btn"); const onUpdate=()=>void load(); btn?.addEventListener("click",onUpdate); return()=>{o.disconnect();btn?.removeEventListener("click",onUpdate);document.documentElement.classList.remove("leonardo-unified-profile");}; },[isLeo,shell,loading,error,load]);

  if(!isLeo||!session||!shell||!nav)return null;
  return <><style>{styles}</style>{createPortal(<div className="leo-unified-nav">{NAV.map((i)=><button key={i.key} className={i.tab===tab&&!i.href?"active":""} onClick={()=>i.href?window.location.assign(i.href):i.tab&&setTab(i.tab)}>{i.label}</button>)}</div>,nav)}{createPortal(<section className="leo-unified-content">{error&&<div className="error-box">{error}</div>}{loading&&!Object.keys(data).length&&<div className="auth-loading"><span className="dot loading"/> Carregando Central Comercial…</div>}<Content tab={tab} data={data} token={session.access_token}/></section>,shell)}</>;
}

const styles=`
html.leonardo-unified-profile .shell>*:not(.top):not(.side-nav):not(.leo-unified-content){display:none!important}
html.leonardo-unified-profile .side-nav-items>:not(.leo-unified-nav){display:none!important}
html.leonardo-unified-profile .leo-unified-nav{display:flex;flex-direction:column;gap:4px}
html.leonardo-unified-profile .leo-unified-nav button{display:block;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:0;background:transparent;color:var(--muted);padding:10px 12px;border-radius:8px;cursor:pointer;text-align:left;font-size:13px}
html.leonardo-unified-profile .leo-unified-nav button:hover{color:var(--text);background:rgba(62,146,220,.07)}
html.leonardo-unified-profile .leo-unified-nav button.active{background:rgba(3,89,166,.24);color:var(--text);box-shadow:inset 3px 0 var(--accent)}
html.leonardo-unified-profile .leo-unified-content{display:block!important;padding-bottom:60px}.leo-stack{display:grid;gap:14px}.leo-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.leo-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 2px;border-bottom:1px solid var(--line)}.leo-row:last-child{border-bottom:0}.leo-row>span{display:flex;flex-direction:column}.leo-row small{color:var(--muted);font-size:11px;margin-top:3px}.leo-right{text-align:right}.leo-toolbar{margin-bottom:14px}.leo-summary{white-space:normal;line-height:1.55;max-width:none}.leo-dir{grid-template-columns:repeat(4,minmax(130px,1fr))}
@media(max-width:1000px){.leo-grid2{grid-template-columns:1fr}.leo-kpis{grid-template-columns:repeat(3,minmax(130px,1fr))}}
@media(max-width:700px){.leo-kpis,.leo-dir{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;