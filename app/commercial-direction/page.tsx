"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, supabase } from "../shared";
import "./commercial-direction.css";
import "./commercial-direction-v2.css";

type Row = Record<string, any>;
type Area = "cockpit" | "commercial" | "revenue" | "acquisition" | "postsale" | "intelligence";
type Sub =
  | "overview" | "decisions"
  | "pipeline" | "agenda" | "meetings" | "team"
  | "targets" | "forecast" | "won"
  | "sources" | "campaigns" | "quality"
  | "handoff" | "formalization" | "retention" | "salequality"
  | "losses" | "signals" | "patterns";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const stageLabel: Record<string,string> = { novo:"Novo",qualificacao:"Qualificação",reuniao:"Reunião",proposta:"Proposta",negociacao:"Negociação",fechado:"Fechado",perdido:"Perdido" };
const handoffLabel: Record<string,string> = { CAMPAIGN_LIVE:"Campanha no ar",ONBOARDING_DONE:"Onboarding concluído",ONBOARDING:"Em onboarding",WAITING_ONBOARDING:"Aguardando onboarding" };
const areas: {key:Area;label:string;sub:[Sub,string][]}[] = [
  { key:"cockpit", label:"Cockpit", sub:[["overview","Visão executiva"],["decisions","Decisões"]] },
  { key:"commercial", label:"Comercial", sub:[["pipeline","Pipeline"],["agenda","Agenda"],["meetings","Reuniões"],["team","Time comercial"]] },
  { key:"revenue", label:"Receita", sub:[["targets","Metas & Receita"],["forecast","Forecast"],["won","Vendas ganhas"]] },
  { key:"acquisition", label:"Aquisição", sub:[["sources","Origens"],["campaigns","Campanhas"],["quality","Lead Quality"]] },
  { key:"postsale", label:"Pós-venda", sub:[["handoff","Handoff"],["formalization","Formalização"],["retention","Retenção"],["salequality","Qualidade da venda"]] },
  { key:"intelligence", label:"Inteligência", sub:[["losses","Perdas & objeções"],["signals","Sinais das calls"],["patterns","Padrões executivos"]] },
];

function money(v: unknown) { return Number(v || 0).toLocaleString("pt-BR", { style:"currency", currency:"BRL", maximumFractionDigits:0 }); }
function num(v: unknown) { return Number(v || 0).toLocaleString("pt-BR"); }
function pct(v: unknown) { const x=Number(v); return Number.isFinite(x) ? `${x.toLocaleString("pt-BR",{maximumFractionDigits:1})}%` : "—"; }
function text(v: unknown, fallback="—") { const s=String(v ?? "").trim(); return s || fallback; }
function date(v: unknown, withTime=false) { if(!v) return "—"; const d=new Date(String(v)); if(Number.isNaN(d.getTime())) return "—"; return new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",year:"2-digit",...(withTime?{hour:"2-digit",minute:"2-digit"}:{})}).format(d); }
function tone(stage: unknown) { const s=String(stage||"").toLowerCase(); return s==="negociacao"||s==="fechado"||s==="campaign_live"?"good":s==="proposta"||s==="reuniao"||s==="onboarding"?"warm":s==="perdido"||s==="critical"||s==="high"?"bad":"muted"; }
function n(v:unknown){ return Number(v||0)||0; }
function sum(rows:Row[], key:string){ return rows.reduce((acc,row)=>acc+n(row?.[key]),0); }
function monthMatches(v:unknown){ if(!v) return false; const d=new Date(String(v)); const now=new Date(); return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth(); }

function Kpi({label,value,hint,tone="neutral"}:{label:string;value:string|number;hint?:string;tone?:string}) {
  return <article className={`cd-kpi ${tone}`}><span>{label}</span><b>{value}</b>{hint&&<small>{hint}</small>}</article>;
}
function Empty({children}:{children?:any}) { return <div className="cd-empty">{children}</div>; }
function StagePill({value}:{value:string}) { return <span className={`cd-pill ${tone(value)}`}>{stageLabel[String(value||"").toLowerCase()]||text(value)}</span>; }
function Progress({value}:{value:number}) { const safe=Math.max(0,Math.min(100,value||0)); return <div className="cd-progress"><i style={{width:`${safe}%`}}/></div>; }
function CardTitle({eyebrow,title,right}:{eyebrow:string;title:string;right?:React.ReactNode}) { return <div className="cd-card-head"><div><span>{eyebrow}</span><h2>{title}</h2></div>{right}</div>; }

export default function CommercialDirectionPage() {
  const [session,setSession]=useState<Session|null>(null);
  const [authReady,setAuthReady]=useState(false);
  const [payload,setPayload]=useState<Row>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [area,setArea]=useState<Area>("cockpit");
  const [sub,setSub]=useState<Sub>("overview");
  const [query,setQuery]=useState("");
  const [owner,setOwner]=useState("ALL");

  useEffect(()=>{ supabase.auth.getSession().then(({data})=>{setSession(data.session);setAuthReady(true)}); const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>{setSession(next);setAuthReady(true)}); return()=>subscription.unsubscribe(); },[]);
  async function load(){ setLoading(true);setError(""); try{ const r=await authenticatedFetch(API,{cache:"no-store"}); const b=await r.json().catch(()=>({})); if(!r.ok) throw new Error(b.detail||b.error||`API ${r.status}`); setPayload(b||{}); }catch(e){setError(e instanceof Error?e.message:"Não foi possível carregar a direção comercial.");}finally{setLoading(false)} }
  useEffect(()=>{ if(!authReady)return; if(!session){window.location.assign("/");return;} load(); },[authReady,session?.access_token]);

  const leads:Row[]=payload.leads||[];
  const summary=payload.summary||{};
  const goals:Row[]=payload.goals||[];
  const performance:Row[]=payload.performance||[];
  const meetings:Row[]=payload.meetings||[];
  const campaigns:Row[]=payload.campaigns||[];
  const wonClients:Row[]=payload.won_clients||[];
  const handoffs:Row[]=payload.handoffs||[];
  const churns:Row[]=payload.retention?.churns||[];
  const owners=useMemo(()=>[...new Set(leads.map(r=>String(r.owner_name||"")).filter(Boolean))], [leads]);
  const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase("pt-BR");return leads.filter(r=>(owner==="ALL"||r.owner_name===owner)&&(!q||`${r.name||""} ${r.company||""} ${r.email||""} ${r.phone||""}`.toLocaleLowerCase("pt-BR").includes(q)));},[leads,query,owner]);

  const wonMonth=useMemo(()=>leads.filter(r=>String(r.stage).toLowerCase()==="fechado"&&monthMatches(r.closed_at||r.updated_at)),[leads]);
  const targetClients=sum(goals,"meta_clientes"), targetMonthly=sum(goals,"meta_mensalidade"), targetSetup=sum(goals,"meta_implementacao");
  const soldClients=wonMonth.length, soldMonthly=sum(wonMonth,"closed_monthly_value"), soldSetup=sum(wonMonth,"closed_setup_value");
  const clientProgress=targetClients?100*soldClients/targetClients:0, monthlyProgress=targetMonthly?100*soldMonthly/targetMonthly:0, setupProgress=targetSetup?100*soldSetup/targetSetup:0;
  const forecastWithSold=soldMonthly+n(summary.weighted_forecast_value);
  const gapMonthly=Math.max(0,targetMonthly-forecastWithSold);

  const sourceRows=useMemo(()=>{
    const map=new Map<string,Row>();
    for(const r of leads){ const key=text(r.utm_source||r.source,"Sem origem"); const cur=map.get(key)||{source:key,leads:0,advanced:0,won:0,value:0}; cur.leads++; if(["reuniao","proposta","negociacao"].includes(String(r.stage).toLowerCase()))cur.advanced++; if(String(r.stage).toLowerCase()==="fechado"){cur.won++;cur.value+=n(r.closed_monthly_value||r.estimated_value);} map.set(key,cur); }
    return [...map.values()].sort((a,b)=>b.leads-a.leads);
  },[leads]);

  const upcoming=useMemo(()=>leads.filter(r=>r.next_action_at&&!r.followup_overdue&&!["fechado","perdido"].includes(String(r.stage).toLowerCase())).sort((a,b)=>new Date(a.next_action_at).getTime()-new Date(b.next_action_at).getTime()).slice(0,30),[leads]);
  const overdue=useMemo(()=>leads.filter(r=>r.followup_overdue&&!["fechado","perdido"].includes(String(r.stage).toLowerCase())).sort((a,b)=>new Date(a.next_action_at).getTime()-new Date(b.next_action_at).getTime()).slice(0,30),[leads]);

  const lossReasons=useMemo(()=>{
    const map=new Map<string,number>();
    for(const r of leads.filter(x=>String(x.stage).toLowerCase()==="perdido")){ const reason=text(r.lost_reason,"Não informado"); map.set(reason,(map.get(reason)||0)+1); }
    return [...map.entries()].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count);
  },[leads]);

  const callSignals=useMemo(()=>{
    const defs=[
      ["Preço / investimento",/pre[cç]o|valor|caro|investimento|or[cç]amento/i],
      ["Prazo / timing",/prazo|tempo|quando|depois|agora n[aã]o|momento/i],
      ["Resultado / qualidade",/resultado|lead|qualidade|convers[aã]o|venda|retorno/i],
      ["Contrato / condição",/contrato|condi[cç][aã]o|parcela|pagamento|mensalidade/i],
      ["Confiança / prova",/confian[cç]a|case|prova|refer[eê]ncia|cliente|experi[eê]ncia/i],
    ] as const;
    return defs.map(([label,re])=>({label,count:meetings.filter(m=>re.test(`${m.summary||""} ${JSON.stringify(m.decisions||[])} ${JSON.stringify(m.ai_signals||{})}`)).length})).sort((a,b)=>b.count-a.count);
  },[meetings]);

  const saleQuality=useMemo(()=>wonClients.map(w=>{
    const client=w.client||null; const clientId=client?.id||null;
    const handoff=handoffs.find(h=>String(h.crm_lead_id||"")===String(w.id)||clientId&&String(h.client_id)===String(clientId));
    const churn=clientId?churns.find(c=>String(c.client_id)===String(clientId)):null;
    const state=churn?"CHURN":handoff?.handoff_status||client?.lifecycle||"SEM_VINCULO";
    return {...w,client,handoff,churn,quality_state:state};
  }),[wonClients,handoffs,churns]);

  function pickArea(next:Area){ const found=areas.find(x=>x.key===next)!; setArea(next);setSub(found.sub[0][0]); }
  const currentArea=areas.find(x=>x.key===area)!;

  if(!authReady||!session) return <main className="cd-loading">Carregando…</main>;
  return <main className="cd-shell cd-v2">
    <header className="cd-top"><button onClick={()=>window.location.assign("/")}>← Dashboard</button><div className="cd-brand"><BrandMark/><span><small>Leonardo Imobi</small><b>Direção Comercial</b></span></div><div className="cd-profile"><b>{text(payload.profile?.person,"Direção")}</b><small>{text(payload.profile?.display_role,"Direção Comercial")} · cockpit executivo</small></div></header>

    <section className="cd-hero"><div><span>DIREÇÃO · RECEITA + COMERCIAL + AQUISIÇÃO + PÓS-VENDA</span><h1>Decida com contexto. <em>Sem microgestão.</em></h1><p>Um cockpit para acompanhar venda, previsibilidade, qualidade da aquisição e o que acontece depois do fechamento.</p></div><div className="cd-refresh"><small>Atualizado {date(payload.generated_at,true)}</small><button onClick={load} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button></div></section>

    <nav className="cd-main-tabs">{areas.map(x=><button key={x.key} className={area===x.key?"active":""} onClick={()=>pickArea(x.key)}>{x.label}</button>)}</nav>
    <nav className="cd-sub-tabs">{currentArea.sub.map(([key,label])=><button key={key} className={sub===key?"active":""} onClick={()=>setSub(key)}>{label}</button>)}</nav>
    {error&&<div className="cd-error">{error}</div>}

    {area==="cockpit"&&sub==="overview"&&<>
      <section className="cd-kpis"><Kpi label="Vendido no mês" value={money(soldMonthly)} hint={`${soldClients} clientes fechados`} tone="good"/><Kpi label="Forecast + vendido" value={money(forecastWithSold)} hint={gapMonthly?`${money(gapMonthly)} para cobrir a meta`:"meta coberta pelo forecast"}/><Kpi label="Oportunidades avançadas" value={num(summary.advanced_opportunities)} hint="reunião, proposta e negociação"/><Kpi label="Follow-ups vencidos" value={num(summary.overdue_followups)} hint={`${num(summary.stale_leads)} negócios parados`} tone={summary.overdue_followups?"bad":"good"}/><Kpi label="Reuniões · 7 dias" value={num(summary.meetings_7d)} hint="Donnah comercial"/><Kpi label="Pós-venda pendente" value={num(handoffs.filter(h=>h.handoff_status!=="CAMPAIGN_LIVE"&&h.handoff_status!=="ONBOARDING_DONE").length)} hint="fechados ainda em transição"/></section>
      <section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="DECISÕES" title="O que merece atenção agora" right={<b>{num((payload.executive_alerts||[]).length)}</b>}/>{(payload.executive_alerts||[]).length?(payload.executive_alerts||[]).slice(0,12).map((a:Row,i:number)=><div className="cd-alert" key={`${a.type}-${a.lead_id||a.client_id||i}`}><i className={a.severity==="HIGH"?"bad":"warm"}/><div><b>{text(a.title)}</b><small>{text(a.detail)}{a.owner?` · ${a.owner}`:""}</small></div></div>):<Empty>Sem exceções executivas relevantes agora.</Empty>}</article>
      <article className="cd-card"><CardTitle eyebrow="META DO MÊS" title="Receita contratada"/><div className="cd-target-line"><span>Mensalidade</span><b>{money(soldMonthly)} / {money(targetMonthly)}</b><Progress value={monthlyProgress}/></div><div className="cd-target-line"><span>Implementação</span><b>{money(soldSetup)} / {money(targetSetup)}</b><Progress value={setupProgress}/></div><div className="cd-target-line"><span>Clientes</span><b>{soldClients} / {num(targetClients)}</b><Progress value={clientProgress}/></div></article></section>
      <section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="TIME COMERCIAL" title="Performance do funil"/>{performance.map(p=><div className="cd-owner" key={p.owner_id}><div><b>{p.owner_name}</b><small>{num(p.leads)} leads · {num(p.meetings)} reuniões · {num(p.proposals)} propostas · {num(p.won)} ganhos</small></div><div><b>{pct(p.close_rate)}</b><small>taxa de fechamento · {money(p.weighted_value)} forecast</small></div></div>)}</article><article className="cd-card"><CardTitle eyebrow="PÓS-VENDA" title="Últimos handoffs"/>{handoffs.slice(0,8).map(h=><div className="cd-quality" key={h.client_id}><div><b>{h.display_name}</b><small>{h.commercial_owner||"Closer não vinculado"}</small></div><span className={`cd-pill ${tone(h.handoff_status)}`}>{handoffLabel[h.handoff_status]||h.handoff_status}</span></div>)}</article></section>
    </>}

    {area==="cockpit"&&sub==="decisions"&&<section className="cd-card"><CardTitle eyebrow="FILA EXECUTIVA" title="Decisões e exceções" right={<b>{num((payload.executive_alerts||[]).length)}</b>}/>{(payload.executive_alerts||[]).map((a:Row,i:number)=><div className="cd-alert cd-alert-large" key={`${a.type}-${i}`}><i className={a.severity==="HIGH"?"bad":"warm"}/><div><b>{text(a.title)}</b><small>{text(a.detail)}{a.owner?` · responsável: ${a.owner}`:""}</small></div><span>{text(a.type)}</span></div>)}{!(payload.executive_alerts||[]).length&&<Empty>Nenhuma decisão crítica pendente.</Empty>}</section>}

    {area==="commercial"&&sub==="pipeline"&&<section className="cd-card"><CardTitle eyebrow="CRM COMERCIAL" title="Pipeline completo" right={<b>{filtered.length}</b>}/><div className="cd-filters"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar lead, empresa, e-mail ou telefone…"/><select value={owner} onChange={e=>setOwner(e.target.value)}><option value="ALL">Todos os responsáveis</option>{owners.map(o=><option key={o}>{o}</option>)}</select></div><div className="cd-table"><table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Tempo</th><th>Última atividade</th><th>Próxima ação</th><th>Valor</th></tr></thead><tbody>{filtered.map(r=><tr key={r.id}><td><b>{text(r.company||r.name)}</b><small>{r.company?text(r.name):text(r.source)}</small></td><td>{text(r.owner_name)}</td><td><StagePill value={r.stage}/></td><td>{num(r.stage_age_days)}d</td><td>{r.no_activity?<span className="cd-danger">Sem atividade</span>:<><b>{text(r.last_activity_type)}</b><small>{date(r.last_activity_at,true)}</small></>}</td><td>{r.followup_overdue?<span className="cd-danger">Vencido · {date(r.next_action_at,true)}</span>:<>{text(r.next_action,"Sem próxima ação")}{r.next_action_at&&<small>{date(r.next_action_at,true)}</small>}</>}</td><td>{r.estimated_value?money(r.estimated_value):"não informado"}</td></tr>)}</tbody></table></div></section>}

    {area==="commercial"&&sub==="agenda"&&<section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="ATRASADOS" title="Follow-ups vencidos" right={<b>{overdue.length}</b>}/>{overdue.map(r=><div className="cd-agenda" key={r.id}><div><b>{text(r.company||r.name)}</b><small>{text(r.owner_name)} · {text(r.next_action,"Ação pendente")}</small></div><span className="cd-danger">{date(r.next_action_at,true)}</span></div>)}{!overdue.length&&<Empty>Nenhum follow-up vencido.</Empty>}</article><article className="cd-card"><CardTitle eyebrow="PRÓXIMAS AÇÕES" title="Agenda comercial" right={<b>{upcoming.length}</b>}/>{upcoming.map(r=><div className="cd-agenda" key={r.id}><div><b>{text(r.company||r.name)}</b><small>{text(r.owner_name)} · {text(r.next_action,"Próxima ação")}</small></div><span>{date(r.next_action_at,true)}</span></div>)}{!upcoming.length&&<Empty>Nenhuma próxima ação registrada.</Empty>}</article></section>}

    {area==="commercial"&&sub==="meetings"&&<section className="cd-card"><CardTitle eyebrow="DONNAH" title="Reuniões comerciais" right={<b>{meetings.length}</b>}/><div className="cd-meetings">{meetings.slice(0,80).map(m=><article key={m.id}><div className="cd-meeting-top"><span><b>{m.owner}</b><small>{date(m.meeting_started_at,true)}</small></span>{m.crm_stage&&<StagePill value={m.crm_stage}/>}</div><h3>{text(m.title)}</h3><p>{text(m.summary,"Resumo ainda não disponível.")}</p><footer><span>{m.crm_lead_name?`Lead: ${m.crm_lead_name}`:m.client_name?`Cliente: ${m.client_name}`:"Lead/cliente ainda não identificado"}</span><span>{Array.isArray(m.participants)?m.participants.join(" · "):""}</span></footer></article>)}</div></section>}

    {area==="commercial"&&sub==="team"&&<><section className="cd-kpis"><Kpi label="Leads no CRM" value={num(leads.length)} hint="responsáveis reais"/><Kpi label="Avançados" value={num(summary.advanced_opportunities)} hint="reunião+"/><Kpi label="Ganhos no mês" value={num(soldClients)} hint={money(soldMonthly)} tone="good"/><Kpi label="Follow-ups vencidos" value={num(summary.overdue_followups)} hint="exigem ação" tone={summary.overdue_followups?"bad":"good"}/></section><section className="cd-card"><CardTitle eyebrow="TIME COMERCIAL" title="Comparativo por responsável"/>{performance.map(p=><div className="cd-team-row" key={p.owner_id}><div><b>{p.owner_name}</b><small>{p.email}</small></div><span><small>Leads</small><b>{num(p.leads)}</b></span><span><small>Reuniões</small><b>{num(p.meetings)}</b></span><span><small>Propostas</small><b>{num(p.proposals)}</b></span><span><small>Ganhos</small><b>{num(p.won)}</b></span><span><small>Conversão</small><b>{pct(p.close_rate)}</b></span><span><small>Forecast</small><b>{money(p.weighted_value)}</b></span></div>)}</section></>}

    {area==="revenue"&&sub==="targets"&&<><section className="cd-kpis"><Kpi label="Mensalidade vendida" value={money(soldMonthly)} hint={`${monthlyProgress.toFixed(0)}% da meta`} tone="good"/><Kpi label="Implementação vendida" value={money(soldSetup)} hint={`${setupProgress.toFixed(0)}% da meta`}/><Kpi label="Clientes ganhos" value={num(soldClients)} hint={`${clientProgress.toFixed(0)}% da meta`}/><Kpi label="Gap pelo forecast" value={money(gapMonthly)} hint={gapMonthly?"ainda não coberto":"meta coberta"} tone={gapMonthly?"warm":"good"}/></section><section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="META CONSOLIDADA" title="Progresso do mês"/><div className="cd-target-line"><span>Mensalidade recorrente</span><b>{money(soldMonthly)} / {money(targetMonthly)}</b><Progress value={monthlyProgress}/></div><div className="cd-target-line"><span>Implementação</span><b>{money(soldSetup)} / {money(targetSetup)}</b><Progress value={setupProgress}/></div><div className="cd-target-line"><span>Clientes</span><b>{soldClients} / {num(targetClients)}</b><Progress value={clientProgress}/></div></article><article className="cd-card"><CardTitle eyebrow="POR CLOSER" title="Metas individuais"/>{goals.length?goals.map(g=><div className="cd-goal" key={`${g.owner_id}-${g.ano}-${g.mes}`}><b>{g.owner_name}</b><div><span>Clientes <b>{num(g.meta_clientes)}</b></span><span>Mensalidade <b>{money(g.meta_mensalidade)}</b></span><span>Implementação <b>{money(g.meta_implementacao)}</b></span></div></div>):<Empty>Nenhuma meta cadastrada para o mês atual.</Empty>}</article></section></>}

    {area==="revenue"&&sub==="forecast"&&<><section className="cd-kpis"><Kpi label="Pipeline informado" value={money(summary.informed_pipeline_value)} hint="somente valores preenchidos"/><Kpi label="Forecast ponderado" value={money(summary.weighted_forecast_value)} hint="probabilidade por estágio" tone="good"/><Kpi label="Vendido + forecast" value={money(forecastWithSold)} hint="visão provável do mês"/><Kpi label="Negócios parados" value={num(summary.stale_leads)} hint="sem avanço recente" tone={summary.stale_leads?"bad":"good"}/></section><section className="cd-card"><CardTitle eyebrow="PIPELINE" title="Distribuição por estágio"/>{(payload.stage_summary||[]).map((s:Row)=><div className="cd-stage-row" key={s.stage}><StagePill value={s.stage}/><div><b>{num(s.count)} oportunidades</b><small>{money(s.informed_value)} informado · {money(s.weighted_value)} ponderado</small></div></div>)}</section></>}

    {area==="revenue"&&sub==="won"&&<section className="cd-card"><CardTitle eyebrow="VENDAS GANHAS" title="Receita fechada" right={<b>{wonClients.length}</b>}/><div className="cd-table"><table><thead><tr><th>Cliente</th><th>Closer</th><th>Fechamento</th><th>Mensalidade</th><th>Implementação</th><th>Prazo</th></tr></thead><tbody>{wonClients.map(w=><tr key={w.id}><td><b>{text(w.company||w.name)}</b><small>{text(w.client?.display_name,"sem cliente vinculado")}</small></td><td>{text(w.owner_name)}</td><td>{date(w.closed_at||w.updated_at)}</td><td>{money(w.closed_monthly_value)}</td><td>{money(w.closed_setup_value)}</td><td>{w.closed_term_months?`${num(w.closed_term_months)} meses`:"—"}</td></tr>)}</tbody></table></div></section>}

    {area==="acquisition"&&sub==="sources"&&<><section className="cd-kpis"><Kpi label="Origens identificadas" value={num(sourceRows.length)} hint="source/UTM"/><Kpi label="Leads totais" value={num(leads.length)} hint="base comercial"/><Kpi label="Ganhos" value={num(leads.filter(r=>String(r.stage).toLowerCase()==="fechado").length)} hint="todos os períodos" tone="good"/><Kpi label="Sem origem" value={num(sourceRows.find(r=>r.source==="Sem origem")?.leads||0)} hint="dados a melhorar"/></section><section className="cd-card"><CardTitle eyebrow="AQUISIÇÃO" title="Origem → avanço → venda"/><div className="cd-table"><table><thead><tr><th>Origem</th><th>Leads</th><th>Avançados</th><th>Ganhos</th><th>Lead → ganho</th><th>Mensalidade ganha</th></tr></thead><tbody>{sourceRows.map(r=><tr key={r.source}><td><b>{r.source}</b></td><td>{num(r.leads)}</td><td>{num(r.advanced)}</td><td>{num(r.won)}</td><td>{pct(r.leads?100*r.won/r.leads:0)}</td><td>{money(r.value)}</td></tr>)}</tbody></table></div></section></>}

    {area==="acquisition"&&sub==="campaigns"&&<section className="cd-card"><CardTitle eyebrow="META ADS" title="Leitura executiva das campanhas" right={<b>{campaigns.length}</b>}/><div className="cd-table"><table><thead><tr><th>Cliente</th><th>Ativas</th><th>Investimento</th><th>Leads</th><th>CPL</th><th>CTR</th><th>Status</th></tr></thead><tbody>{campaigns.map((r,i)=><tr key={`${r.client_id}-${i}`}><td><b>{text(r.display_name)}</b><small>{text(r.gt_owner)}</small></td><td>{num(r.active_campaigns)}</td><td>{money(r.spend)}</td><td>{num(r.leads)}</td><td>{money(r.cost_per_result)}</td><td>{pct(r.ctr)}</td><td><span className={`cd-pill ${n(r.active_campaigns)>0?"good":"bad"}`}>{text(r.delivery_status,n(r.active_campaigns)>0?"Ativa":"Sem entrega")}</span></td></tr>)}</tbody></table></div></section>}

    {area==="acquisition"&&sub==="quality"&&<><section className="cd-kpis"><Kpi label="Sem atividade" value={num(summary.no_activity)} hint="CRM sem histórico útil" tone={summary.no_activity?"bad":"good"}/><Kpi label="Follow-up vencido" value={num(summary.overdue_followups)} hint="ação comercial pendente" tone={summary.overdue_followups?"bad":"good"}/><Kpi label="Oportunidades paradas" value={num(summary.stale_leads)} hint="tempo excessivo na etapa"/><Kpi label="Campanhas sem entrega" value={num(summary.campaigns_inactive)} hint="clientes ativos/onboarding"/></section><section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="HIGIENE DO CRM" title="O que está escapando"/>{[...(payload.lead_quality?.overdue_followups||[]),...(payload.lead_quality?.stale_leads||[])].filter((r:Row,i:number,a:Row[])=>a.findIndex(x=>x.id===r.id)===i).slice(0,30).map((r:Row)=><div className="cd-quality" key={r.id}><div><b>{text(r.company||r.name)}</b><small>{r.owner_name} · {stageLabel[String(r.stage).toLowerCase()]||r.stage}</small></div><span>{r.followup_overdue?"Follow-up vencido":`${num(r.stage_age_days)}d parado`}</span></div>)}</article><article className="cd-card"><CardTitle eyebrow="CLIENTES" title="Meta × comercial"/>{(payload.lead_quality?.client_crosscheck||[]).slice(0,25).map((r:Row)=><div className="cd-quality" key={r.id}><div><b>{text(r.client_name)}</b><small>Semana {date(r.week_start)}–{date(r.week_end)}</small></div><span>{num(r.commercial_leads)} comercial · {num(r.meta_leads)} Meta</span></div>)}</article></section></>}

    {area==="postsale"&&sub==="handoff"&&<section className="cd-card"><CardTitle eyebrow="COMERCIAL → OPERAÇÃO" title="Entrega do vendido" right={<b>{handoffs.length}</b>}/><div className="cd-handoff-grid">{handoffs.map(h=><article key={h.client_id}><b>{h.display_name}</b><small>{h.commercial_owner||"Origem comercial não vinculada"} · {date(h.entrada)}</small><span className={`cd-pill ${tone(h.handoff_status)}`}>{handoffLabel[h.handoff_status]||h.handoff_status}</span><p>{h.onboarding?.next_action||h.onboarding?.blocked_by||"Acompanhamento executivo"}</p></article>)}</div></section>}

    {area==="postsale"&&sub==="formalization"&&<><div className="cd-private-note"><b>Formalização executiva</b><span>Mostra apenas dados comerciais registrados no CRM. Documentos contratuais privados continuam restritos ao Adler.</span></div><section className="cd-card"><CardTitle eyebrow="CONDIÇÕES VENDIDAS" title="O que foi formalizado no CRM"/><div className="cd-table"><table><thead><tr><th>Venda</th><th>Closer</th><th>Mensalidade</th><th>Setup</th><th>Prazo</th><th>1ª mensalidade</th><th>1º setup</th></tr></thead><tbody>{wonClients.map(w=><tr key={w.id}><td><b>{text(w.company||w.name)}</b><small>{date(w.closed_at)}</small></td><td>{text(w.owner_name)}</td><td>{money(w.closed_monthly_value)}</td><td>{money(w.closed_setup_value)}</td><td>{w.closed_term_months?`${num(w.closed_term_months)}m`:"—"}</td><td>{money(w.closed_monthly_first_month)}</td><td>{money(w.closed_setup_first_month)}</td></tr>)}</tbody></table></div></section></>}

    {area==="postsale"&&sub==="retention"&&<><section className="cd-kpis"><Kpi label="Clientes em alto risco" value={num(summary.clients_high_risk)} hint="saúde consolidada" tone={summary.clients_high_risk?"bad":"good"}/><Kpi label="Churns · 90 dias" value={num(summary.churns_90d)} hint="confirmados" tone={summary.churns_90d?"bad":"good"}/><Kpi label="Onboarding" value={num(summary.clients_onboarding)} hint="em transição"/><Kpi label="Campanhas inativas" value={num(summary.campaigns_inactive)} hint="ativos/onboarding"/></section><section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="RISCO" title="Clientes que merecem atenção"/>{(payload.retention?.high_risk_clients||[]).map((r:Row)=><div className="cd-quality" key={r.client_id}><div><b>{text(r.display_name)}</b><small>{text(r.external_summary||r.sinais_alerta,"Sinal de risco consolidado")}</small></div><span className="cd-danger">{text(r.external_risk_level||r.internal_band,"RISCO")}</span></div>)}</article><article className="cd-card"><CardTitle eyebrow="CHURN" title="Motivos recorrentes"/>{(payload.retention?.churn_reasons||[]).slice(0,20).map((r:Row)=><div className="cd-stage-row" key={r.reason}><span>{text(r.reason)}</span><b>{num(r.count)}</b></div>)}</article></section></>}

    {area==="postsale"&&sub==="salequality"&&<section className="cd-card"><CardTitle eyebrow="QUALIDADE DA VENDA" title="Quem vendeu e o que aconteceu depois" right={<b>{saleQuality.length}</b>}/><div className="cd-table"><table><thead><tr><th>Venda</th><th>Closer</th><th>Mensalidade</th><th>Cliente vinculado</th><th>Pós-venda</th><th>Leitura</th></tr></thead><tbody>{saleQuality.map(r=><tr key={r.id}><td><b>{text(r.company||r.name)}</b><small>{date(r.closed_at)}</small></td><td>{text(r.owner_name)}</td><td>{money(r.closed_monthly_value)}</td><td>{text(r.client?.display_name,"Não vinculado")}</td><td><span className={`cd-pill ${r.quality_state==="CHURN"?"bad":tone(r.quality_state)}`}>{handoffLabel[r.quality_state]||text(r.quality_state)}</span></td><td>{r.churn?text(r.churn.motivo,"Churn confirmado"):r.handoff?.onboarding?.blocked_by?text(r.handoff.onboarding.blocked_by):r.handoff?.handoff_status==="CAMPAIGN_LIVE"?"Venda já chegou à operação ativa":"Acompanhar transição"}</td></tr>)}</tbody></table></div></section>}

    {area==="intelligence"&&sub==="losses"&&<section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="PERDAS" title="Motivos comerciais registrados"/>{lossReasons.map(r=><div className="cd-stage-row" key={r.reason}><span>{r.reason}</span><b>{num(r.count)}</b></div>)}{!lossReasons.length&&<Empty>Nenhum motivo de perda estruturado.</Empty>}</article><article className="cd-card"><CardTitle eyebrow="PÓS-VENDA" title="Motivos de churn"/>{(payload.retention?.churn_reasons||[]).map((r:Row)=><div className="cd-stage-row" key={r.reason}><span>{text(r.reason)}</span><b>{num(r.count)}</b></div>)}</article></section>}

    {area==="intelligence"&&sub==="signals"&&<><section className="cd-kpis">{callSignals.slice(0,5).map(s=><Kpi key={s.label} label={s.label} value={num(s.count)} hint="calls com esse sinal" tone={s.count?"warm":"neutral"}/>)}</section><section className="cd-card"><CardTitle eyebrow="DONNAH" title="Sinais encontrados nas reuniões"/><p className="cd-explain">Leitura determinística das transcrições e resumos: conta presença de temas nas calls, sem inventar classificação.</p>{meetings.slice(0,30).map(m=><div className="cd-intel-row" key={m.id}><div><b>{text(m.crm_lead_name||m.client_name||m.title)}</b><small>{text(m.owner)} · {date(m.meeting_started_at,true)}</small></div><p>{text(m.summary,"Resumo ainda não disponível.")}</p></div>)}</section></>}

    {area==="intelligence"&&sub==="patterns"&&<section className="cd-grid two"><article className="cd-card"><CardTitle eyebrow="CONVERSÃO" title="Onde o funil perde força"/>{(payload.stage_summary||[]).map((s:Row)=><div className="cd-stage-row" key={s.stage}><StagePill value={s.stage}/><div><b>{num(s.count)} oportunidades</b><small>{money(s.weighted_value)} forecast ponderado</small></div></div>)}</article><article className="cd-card"><CardTitle eyebrow="PRIORIDADES" title="Sinais executivos recorrentes"/>{(payload.executive_alerts||[]).reduce((acc:Row[],a:Row)=>{const existing=acc.find(x=>x.type===a.type);if(existing)existing.count++;else acc.push({type:a.type,count:1,title:a.title});return acc;},[]).sort((a:Row,b:Row)=>b.count-a.count).map((r:Row)=><div className="cd-stage-row" key={r.type}><span>{text(r.type).replaceAll("_"," ")}</span><b>{num(r.count)}</b></div>)}</article></section>}
  </main>;
}
