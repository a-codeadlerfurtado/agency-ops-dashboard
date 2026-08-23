"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const META_API = `${SUPABASE_URL}/functions/v1/agency-ops-campaigns-api`;
const DISPATCH_API = `${SUPABASE_URL}/functions/v1/agency-ops-lead-dispatch-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type Range = { since: string; until: string; label: string };
type Period = "TODAY" | "YESTERDAY" | "LAST_7D" | "THIS_MONTH" | "CUSTOM";
type ViewFilter = "ALL" | "LOW" | "ZERO" | "DIVERGENT" | "OK";
type SortKey = "LEADS_DESC" | "DISPATCH_DESC" | "CPL_ASC" | "SPEND_DESC" | "MATCH_FIRST" | "DIFF_DESC" | "LEADS_ASC" | "NAME_ASC";

function todaySP() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shift(day: string, delta: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function monthStart(day: string) { return `${day.slice(0, 8)}01`; }
function rangeFor(period: Exclude<Period, "CUSTOM">): Range {
  const today = todaySP();
  if (period === "TODAY") return { since: today, until: today, label: "Hoje" };
  if (period === "YESTERDAY") { const yesterday = shift(today, -1); return { since: yesterday, until: yesterday, label: "Ontem" }; }
  if (period === "LAST_7D") return { since: shift(today, -6), until: today, label: "Últimos 7 dias" };
  return { since: monthStart(today), until: today, label: "Este mês" };
}
function number(value: unknown, digits = 0) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0)); }
function money(value: unknown, digits = 0) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value || 0)); }
function dateLabel(day: string) { const [y,m,d] = day.split("-").map(Number); return new Intl.DateTimeFormat("pt-BR").format(new Date(y,m-1,d)); }
function dateTime(value: unknown) { return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(String(value))) : "—"; }

const deliveryLabel: Record<string,string> = {
  ACTIVE_DELIVERY: "Com entrega", NO_META_ACCOUNT: "Sem conta Meta", NO_DELIVERY: "Ativa sem entrega",
  NO_ACTIVE_CAMPAIGN: "Sem campanha ativa", NO_CAMPAIGNS: "Sem campanhas", CHURNED_WITH_DELIVERY: "Churned com entrega",
};

function reconciliationStatus(row: Row) {
  if (row.delivery_status === "NO_META_ACCOUNT") return "NO_META";
  if (row.partial_data) return "PARTIAL";
  if (row.meta_leads === 0 && Number(row.spend || 0) > 0) return "ZERO";
  if (row.meta_leads > 0 && row.dispatches === 0) return "NO_DISPATCH";
  if (row.meta_leads !== row.dispatches) return "DIVERGENT";
  if (row.meta_leads === 0 && row.dispatches === 0) return "NO_ACTIVITY";
  return "OK";
}
function statusText(status: string) {
  return ({ OK:"Batendo", DIVERGENT:"Conferir diferença", ZERO:"Zero leads", NO_DISPATCH:"Meta com leads · sem disparo", NO_META:"Sem conta Meta", PARTIAL:"Meta parcial", NO_ACTIVITY:"Sem movimento" } as Record<string,string>)[status] || status;
}
function statusTone(status: string) {
  return ({ OK:"ok", DIVERGENT:"warn", ZERO:"bad", NO_DISPATCH:"bad", NO_META:"muted", PARTIAL:"warn", NO_ACTIVITY:"muted" } as Record<string,string>)[status] || "muted";
}
function rowCpl(row: Row) {
  const leads = Number(row.meta_leads || 0);
  return leads > 0 ? Number(row.spend || 0) / leads : Number.POSITIVE_INFINITY;
}

export default function LeadConferencePage() {
  const initial = rangeFor("TODAY");
  const [session,setSession] = useState<Session|null>(null);
  const [ready,setReady] = useState(false);
  const [meta,setMeta] = useState<Row|null>(null);
  const [dispatch,setDispatch] = useState<Row|null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [period,setPeriod] = useState<Period>("TODAY");
  const [range,setRange] = useState<Range>(initial);
  const [customSince,setCustomSince] = useState(initial.since);
  const [customUntil,setCustomUntil] = useState(initial.until);
  const [query,setQuery] = useState("");
  const [filter,setFilter] = useState<ViewFilter>("ALL");
  const [gtFilter,setGtFilter] = useState("ALL");
  const [sortKey,setSortKey] = useState<SortKey>("LEADS_DESC");
  const [lowThreshold,setLowThreshold] = useState(3);
  const [expanded,setExpanded] = useState<string|null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  },[]);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const metaUrl = new URL(META_API);
      metaUrl.searchParams.set("lifecycle","ACTIVE");
      metaUrl.searchParams.set("details","1");
      metaUrl.searchParams.set("since",range.since);
      metaUrl.searchParams.set("until",range.until);
      metaUrl.searchParams.set("period_label",range.label);
      const dispatchUrl = new URL(DISPATCH_API);
      dispatchUrl.searchParams.set("since",range.since);
      dispatchUrl.searchParams.set("until",range.until);
      const headers = { Authorization:`Bearer ${session.access_token}`, apikey:SUPABASE_ANON_KEY };
      const [metaResponse,dispatchResponse] = await Promise.all([
        fetch(metaUrl,{headers,cache:"no-store"}),
        fetch(dispatchUrl,{headers,cache:"no-store"}),
      ]);
      const [metaBody,dispatchBody] = await Promise.all([metaResponse.json().catch(()=>({})),dispatchResponse.json().catch(()=>({}))]);
      if (!metaResponse.ok) throw new Error(metaBody.detail || metaBody.error || `Meta API ${metaResponse.status}`);
      if (!dispatchResponse.ok) throw new Error(dispatchBody.detail || dispatchBody.error || `Disparos API ${dispatchResponse.status}`);
      setMeta(metaBody); setDispatch(dispatchBody);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar a conferência de leads."); }
    finally { setLoading(false); }
  },[session?.access_token,range.since,range.until,range.label]);

  useEffect(() => { load(); },[load]);

  function changePeriod(next: Period) {
    setPeriod(next);
    if (next !== "CUSTOM") setRange(rangeFor(next));
  }
  function applyCustom() {
    if (!customSince || !customUntil || customSince > customUntil) { setError("Confira o período personalizado."); return; }
    setError(""); setRange({since:customSince,until:customUntil,label:"Personalizado"});
  }

  const dispatchClient = useMemo(() => new Map<string,Row>((dispatch?.clients || []).map((row:Row) => [String(row.client_id),row] as [string,Row])),[dispatch]);
  const dispatchCampaign = useMemo(() => new Map<string,Row>((dispatch?.campaigns || []).map((row:Row) => [`${row.client_id}:${row.campaign_id}`,row] as [string,Row])),[dispatch]);
  const gtOptions = useMemo(() => [...new Set((meta?.clients || []).map((row:Row) => String(row.gt_owner || "").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR")),[meta]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (meta?.clients || []).map((client:Row) => {
      const wa:Row = dispatchClient.get(String(client.client_id)) || {};
      const metaLeads = Number(client.leads || 0);
      const dispatches = Number(wa.dispatches || 0);
      const merged = {
        ...client,
        meta_leads:metaLeads,
        dispatches,
        difference:metaLeads-dispatches,
        campaign_matched:Number(wa.campaign_matched || 0),
        campaign_unmatched:Number(wa.campaign_unmatched || 0),
        routing_conflicts:Number(wa.routing_conflicts || 0),
        dispatch_products:wa.products || [],
      };
      return {...merged,status:reconciliationStatus(merged)};
    }).filter((row:Row) => {
      if (needle && ![row.display_name,row.gt_owner,row.configured_account_names].join(" ").toLocaleLowerCase("pt-BR").includes(needle)) return false;
      if (gtFilter !== "ALL" && String(row.gt_owner || "") !== gtFilter) return false;
      if (filter === "LOW" && !(row.meta_leads <= lowThreshold)) return false;
      if (filter === "ZERO" && row.meta_leads !== 0) return false;
      if (filter === "DIVERGENT" && !["DIVERGENT","NO_DISPATCH"].includes(row.status)) return false;
      if (filter === "OK" && row.status !== "OK") return false;
      return true;
    }).sort((a:Row,b:Row) => {
      if (sortKey === "LEADS_DESC") return b.meta_leads-a.meta_leads || b.dispatches-a.dispatches || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      if (sortKey === "DISPATCH_DESC") return b.dispatches-a.dispatches || b.meta_leads-a.meta_leads || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      if (sortKey === "CPL_ASC") return rowCpl(a)-rowCpl(b) || b.meta_leads-a.meta_leads || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      if (sortKey === "SPEND_DESC") return Number(b.spend||0)-Number(a.spend||0) || b.meta_leads-a.meta_leads;
      if (sortKey === "MATCH_FIRST") {
        const rank:Record<string,number> = { OK:0, DIVERGENT:1, NO_DISPATCH:2, PARTIAL:3, ZERO:4, NO_ACTIVITY:5, NO_META:6 };
        return (rank[a.status]??9)-(rank[b.status]??9) || b.meta_leads-a.meta_leads || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      }
      if (sortKey === "DIFF_DESC") return Math.abs(Number(b.difference||0))-Math.abs(Number(a.difference||0)) || b.meta_leads-a.meta_leads;
      if (sortKey === "LEADS_ASC") return a.meta_leads-b.meta_leads || Number(b.spend||0)-Number(a.spend||0) || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      return String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
    });
  },[meta,dispatchClient,query,filter,gtFilter,sortKey,lowThreshold]);

  const allMerged = useMemo(() => {
    return (meta?.clients || []).map((client:Row) => {
      const wa:Row = dispatchClient.get(String(client.client_id)) || {};
      const metaLeads=Number(client.leads||0), dispatches=Number(wa.dispatches||0);
      const base={...client,meta_leads:metaLeads,dispatches,difference:metaLeads-dispatches};
      return {...base,status:reconciliationStatus(base)};
    });
  },[meta,dispatchClient]);

  const totals = useMemo(() => ({
    clients:allMerged.length,
    meta:allMerged.reduce((sum:number,row:Row)=>sum+row.meta_leads,0),
    dispatches:allMerged.reduce((sum:number,row:Row)=>sum+row.dispatches,0),
    zero:allMerged.filter((row:Row)=>row.meta_leads===0).length,
    low:allMerged.filter((row:Row)=>row.meta_leads<=lowThreshold).length,
    divergent:allMerged.filter((row:Row)=>["DIVERGENT","NO_DISPATCH"].includes(row.status)).length,
  }),[allMerged,lowThreshold]);

  function campaignRows(client: Row) {
    const id=String(client.client_id);
    const metaRows=(meta?.campaigns||[]).filter((row:Row)=>String(row.client_id)===id);
    const waRows=(dispatch?.campaigns||[]).filter((row:Row)=>String(row.client_id)===id);
    const keys=new Set<string>([...metaRows.map((row:Row)=>String(row.campaign_id)),...waRows.map((row:Row)=>String(row.campaign_id))]);
    return [...keys].map((campaignId) => {
      const m:Row=metaRows.find((row:Row)=>String(row.campaign_id)===campaignId)||{};
      const w:Row=dispatchCampaign.get(`${id}:${campaignId}`)||waRows.find((row:Row)=>String(row.campaign_id)===campaignId)||{};
      const metaLeads=Number(m.leads_estimate||0), wa=Number(w.dispatches||0);
      return {
        campaign_id:campaignId,
        campaign_name:m.campaign_name||w.campaign_name||campaignId,
        campaign_status:m.campaign_status||null,
        spend:Number(m.spend||0),
        leads:metaLeads,
        cpl:m.cost_per_lead_estimate==null?null:Number(m.cost_per_lead_estimate),
        dispatches:wa,
        difference:metaLeads-wa,
        products:w.products||[],
        has_delivery:Boolean(m.has_delivery),
      };
    }).filter((row:Row)=>row.spend>0||row.leads>0||row.dispatches>0||row.has_delivery)
      .sort((a:Row,b:Row)=>b.leads-a.leads||b.dispatches-a.dispatches||b.spend-a.spend);
  }

  if (!ready) return <main className="lc-loading">Validando sessão…</main>;
  const sourceSummary:Row=dispatch?.summary||{};
  const metaSummary:Row=meta?.summary||{};

  return <main className="lc-shell"><style>{styles}</style>
    <header className="lc-top">
      <div><span className="lc-kicker">CONFERÊNCIA DIÁRIA · META + DISPAROS DE LEADS</span><h1>Conferência de Leads</h1><p>Veja quantos leads cada cliente recebeu no Meta e confira contra os disparos reais identificados no WhatsApp. Expanda o cliente para conferir campanha por campanha.</p></div>
      <div className="lc-actions"><span>{loading?"Atualizando…":`Meta ao vivo · ${dateTime(metaSummary.fetched_at)}`}</span><button onClick={load} disabled={loading}>{loading?"Consultando…":"Atualizar agora"}</button></div>
    </header>

    <section className="lc-controls">
      <label>Período<select value={period} onChange={(e)=>changePeriod(e.target.value as Period)}><option value="TODAY">Hoje</option><option value="YESTERDAY">Ontem</option><option value="LAST_7D">Últimos 7 dias</option><option value="THIS_MONTH">Este mês</option><option value="CUSTOM">Personalizado</option></select></label>
      {period==="CUSTOM"&&<div className="lc-custom"><input type="date" value={customSince} onChange={(e)=>setCustomSince(e.target.value)}/><span>até</span><input type="date" value={customUntil} onChange={(e)=>setCustomUntil(e.target.value)}/><button onClick={applyCustom}>Aplicar</button></div>}
      <label>GT<select value={gtFilter} onChange={(e)=>setGtFilter(e.target.value)}><option value="ALL">Todos os GTs</option>{gtOptions.map((gt)=><option key={gt} value={gt}>{gt}</option>)}</select></label>
      <label>Ordenar por<select className="lc-sort" value={sortKey} onChange={(e)=>setSortKey(e.target.value as SortKey)}><option value="LEADS_DESC">Mais leads primeiro</option><option value="DISPATCH_DESC">Mais disparos primeiro</option><option value="CPL_ASC">Menor CPL primeiro</option><option value="SPEND_DESC">Maior gasto primeiro</option><option value="MATCH_FIRST">Meta x WPP batendo primeiro</option><option value="DIFF_DESC">Maior diferença primeiro</option><option value="LEADS_ASC">Poucos leads primeiro</option><option value="NAME_ASC">Nome A–Z</option></select></label>
      <label className="lc-search">Buscar<input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Cliente ou GT"/></label>
      <label>Poucos leads ≤<input className="lc-threshold" type="number" min="0" max="100" value={lowThreshold} onChange={(e)=>setLowThreshold(Math.max(0,Number(e.target.value||0)))}/></label>
    </section>

    <div className="lc-period">{range.label} · {dateLabel(range.since)}{range.since!==range.until?` → ${dateLabel(range.until)}`:""} · {rows.length} cliente(s) exibido(s)</div>
    {error&&<div className="lc-error">{error}</div>}

    <section className="lc-metrics">
      <article><small>CLIENTES</small><b>{number(totals.clients)}</b><span>no escopo atual</span></article>
      <article className="blue"><small>LEADS META</small><b>{number(totals.meta)}</b><span>API ao vivo</span></article>
      <article className="orange"><small>DISPAROS WHATSAPP</small><b>{number(totals.dispatches)}</b><span>fromMe classificados como lead</span></article>
      <article className={totals.low?"warn":""}><small>POUCOS LEADS</small><b>{number(totals.low)}</b><span>até {lowThreshold} no período</span></article>
      <article className={totals.divergent?"warn":""}><small>DIVERGÊNCIAS</small><b>{number(totals.divergent)}</b><span>Meta x disparos</span></article>
      <article className={totals.zero?"bad":""}><small>ZERO LEADS</small><b>{number(totals.zero)}</b><span>inclui sem movimento</span></article>
    </section>

    {(Number(sourceSummary.unknown_client_dispatches||0)>0||Number(sourceSummary.campaign_unmatched||0)>0||Number(sourceSummary.routing_conflicts||0)>0)&&<section className="lc-coverage">
      <b>Cobertura da conferência</b>
      <span>{number(sourceSummary.campaign_unmatched||0)} disparos sem campanha conciliada · {number(sourceSummary.unknown_client_dispatches||0)} sem cliente identificado · {number(sourceSummary.routing_conflicts||0)} conflito(s) de roteamento.</span>
      <small>Esses casos ficam explícitos e não são atribuídos a uma campanha no chute.</small>
    </section>}

    <div className="lc-filter-tabs">{([['ALL','Todos'],['LOW','Poucos leads'],['ZERO','Zero leads'],['DIVERGENT','Divergências'],['OK','Batendo']] as [ViewFilter,string][]).map(([key,label])=><button key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{label}</button>)}</div>

    <section className="lc-table">
      <div className="lc-head"><span>Cliente</span><span>Meta</span><span>Disparos</span><span>Meta − WPP</span><span>Gasto</span><span>CPL Meta</span><span>Status</span></div>
      {rows.map((row:Row,index:number)=>{const open=expanded===String(row.client_id);const campaigns=campaignRows(row);const cpl=row.meta_leads>0?Number(row.spend||0)/row.meta_leads:null;return <article className={`lc-client ${open?"open":""}`} key={row.client_id}>
        <button className="lc-client-main" onClick={()=>setExpanded(open?null:String(row.client_id))}>
          <span className="lc-name"><b>{sortKey==="LEADS_DESC"&&index<3?<em className={`lc-rank rank-${index+1}`}>#{index+1}</em>:null}{row.display_name}</b><small>{row.gt_owner||"Sem GT"} · {deliveryLabel[row.delivery_status]||row.delivery_status||"—"}</small></span>
          <strong className="blue-text">{number(row.meta_leads)}</strong>
          <strong className="orange-text">{number(row.dispatches)}</strong>
          <strong className={row.difference===0?"ok-text":"warn-text"}>{row.difference>0?"+":""}{number(row.difference)}</strong>
          <span>{money(row.spend)}</span>
          <span>{cpl==null?"—":money(cpl,2)}</span>
          <span className={`lc-status ${statusTone(row.status)}`}>{statusText(row.status)}</span>
        </button>
        {open&&<div className="lc-detail">
          <div className="lc-detail-title"><div><b>Campanhas</b><span>{campaigns.length} com movimento no período</span></div><div><small>Disparos conciliados</small><b>{number(row.campaign_matched||0)}</b></div><div><small>Não conciliados</small><b>{number(row.campaign_unmatched||0)}</b></div></div>
          <div className="lc-campaign-table"><div className="lc-campaign-head"><span>Campanha</span><span>Gasto</span><span>Leads Meta</span><span>CPL</span><span>Disparos</span><span>Diferença</span></div>
            {campaigns.map((campaign:Row)=><div className="lc-campaign-row" key={campaign.campaign_id}><span><b>{campaign.campaign_name}</b><small>{campaign.campaign_status||"status não informado"}</small></span><span>{money(campaign.spend)}</span><strong className="blue-text">{number(campaign.leads)}</strong><span>{campaign.cpl==null?"—":money(campaign.cpl,2)}</span><strong className="orange-text">{number(campaign.dispatches)}</strong><strong className={campaign.difference===0?"ok-text":"warn-text"}>{campaign.difference>0?"+":""}{number(campaign.difference)}</strong></div>)}
            {!campaigns.length&&<div className="lc-empty">Nenhuma campanha com movimento neste período.</div>}
          </div>
          {row.campaign_unmatched>0&&<div className="lc-unmatched"><b>{row.campaign_unmatched} disparo(s) sem campanha conciliada</b><span>{(row.dispatch_products||[]).slice(0,8).map((p:Row)=>`${p.label} (${p.count})`).join(" · ")||"Produto não identificado"}</span></div>}
          {row.routing_conflicts>0&&<div className="lc-conflict">⚠ {row.routing_conflicts} disparo(s) com conflito de roteamento detectado.</div>}
        </div>}
      </article>})}
      {!loading&&!rows.length&&<div className="lc-empty big">Nenhum cliente encontrado neste filtro.</div>}
      {loading&&!meta&&<div className="lc-empty big">Consultando Meta e disparos de leads…</div>}
    </section>

    <footer className="lc-source"><b>Como a conferência conta os dados</b><p><strong>Meta:</strong> ação de lead retornada pela Marketing API, consultada ao vivo no período e no nível de campanha. <strong>WhatsApp:</strong> somente mensagens <code>fromMe=true</code> classificadas pelo parser oficial como disparo de lead — padrão “NOVO LEAD” + nome + telefone. Mensagens comuns da equipe não entram na conta.</p><p>A diferença é sinal de conferência, não acusação automática de perda: disparos sem vínculo forte permanecem como “não conciliados” e dados Meta parciais são marcados.</p></footer>
  </main>;
}

const styles=`
.lc-shell{min-height:100vh;background:#050d16;color:#eaf2fb;padding:26px 30px 70px;font-family:Inter,system-ui,sans-serif}.lc-loading{min-height:100vh;display:grid;place-items:center;background:#050d16;color:#a9bfd2;font-family:Inter,system-ui,sans-serif}.lc-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.lc-kicker{font-size:10px;letter-spacing:.14em;font-weight:900;color:#f1874e}.lc-top h1{font:800 clamp(30px,4vw,48px)/1 Inter Tight,Inter,sans-serif;margin:7px 0 8px}.lc-top p{color:#91a8bc;max-width:850px;line-height:1.5;margin:0}.lc-actions{display:flex;align-items:center;gap:10px}.lc-actions span{font-size:11px;color:#86a0b7}.lc-actions button,.lc-custom button{border:1px solid #bb5a27;background:#2a1710;color:#ffd8c2;border-radius:10px;padding:9px 12px;font-weight:800;cursor:pointer}.lc-actions button:hover,.lc-custom button:hover{background:#3a1e12}.lc-controls{margin-top:22px;display:flex;gap:10px;align-items:end;flex-wrap:wrap;background:#091725;border:1px solid #18364f;border-radius:15px;padding:12px}.lc-controls label{display:flex;flex-direction:column;gap:5px;color:#7892aa;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.lc-controls select,.lc-controls input{height:38px;box-sizing:border-box;border:1px solid #24445f;background:#07131f;color:#e9f4fc;border-radius:9px;padding:0 10px;font:600 12px Inter,system-ui,sans-serif;outline:none}.lc-controls select:focus,.lc-controls input:focus{border-color:#64c9ff;box-shadow:0 0 0 2px rgba(100,201,255,.1)}.lc-search{min-width:220px;flex:1}.lc-sort{min-width:205px}.lc-threshold{width:84px}.lc-custom{display:flex;gap:6px;align-items:center}.lc-custom span{font-size:11px;color:#718aa0}.lc-period{margin:9px 2px 0;color:#7090aa;font-size:11px}.lc-error{margin-top:12px;border:1px solid #783747;background:#28131b;color:#ffd2da;padding:12px 14px;border-radius:12px}.lc-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0}.lc-metrics article{background:#0a1928;border:1px solid #19384f;border-radius:14px;padding:14px;position:relative;overflow:hidden}.lc-metrics article:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#334d61}.lc-metrics article.blue:before{background:#63caff}.lc-metrics article.orange:before{background:#f26b21}.lc-metrics article.warn:before{background:#f1ba4e}.lc-metrics article.bad:before{background:#ff6677}.lc-metrics small{display:block;color:#7891a7;font-size:9px;letter-spacing:.1em;font-weight:900}.lc-metrics b{display:block;font-size:28px;margin:5px 0 2px}.lc-metrics span{font-size:10px;color:#8ea6b9}.lc-coverage{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;border:1px solid #564525;background:#1b170d;border-radius:12px;padding:10px 12px;color:#f3d590;font-size:11px}.lc-coverage b{color:#ffe1a0}.lc-coverage small{color:#a99469}.lc-filter-tabs{display:flex;gap:6px;margin:16px 0 10px;flex-wrap:wrap}.lc-filter-tabs button{border:1px solid #203c53;background:#091522;color:#8fa8bb;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;cursor:pointer}.lc-filter-tabs button.active{border-color:#c05c28;color:#fff;background:linear-gradient(135deg,rgba(242,107,33,.22),rgba(71,184,255,.1))}.lc-table{border:1px solid #18364d;background:#07131f;border-radius:16px;overflow:hidden}.lc-head,.lc-client-main{display:grid;grid-template-columns:minmax(260px,2fr) 80px 90px 95px 105px 105px minmax(150px,.9fr);gap:10px;align-items:center}.lc-head{padding:9px 14px;background:#0c1b2c;color:#6f899f;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.08em}.lc-client{border-top:1px solid #142b3d}.lc-client:first-of-type{border-top:0}.lc-client-main{width:100%;border:0;background:#081622;color:#dceaf4;padding:12px 14px;text-align:left;cursor:pointer}.lc-client-main:hover{background:#0b1c2c}.lc-client.open .lc-client-main{background:linear-gradient(90deg,rgba(242,107,33,.08),rgba(82,188,255,.05))}.lc-client-main>span,.lc-client-main>strong{font-size:12px}.lc-name b,.lc-name small{display:block}.lc-name b{font-size:13px;color:#eef8ff}.lc-name small{margin-top:3px;color:#7590a6;font-size:10px}.lc-rank{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;margin-right:7px;border-radius:7px;background:#142b3d;color:#9fb7c9;font-style:normal;font-size:9px;font-weight:900;vertical-align:1px}.lc-rank.rank-1{background:#473516;color:#ffd66f}.lc-rank.rank-2{background:#29323c;color:#dce7ef}.lc-rank.rank-3{background:#3a271b;color:#e5aa78}.blue-text{color:#7ed3ff!important}.orange-text{color:#ff9b61!important}.ok-text{color:#71d5aa!important}.warn-text{color:#f6c768!important}.lc-status{display:inline-flex;width:max-content;max-width:100%;border-radius:999px;padding:5px 8px;font-size:9px!important;font-weight:900;white-space:nowrap}.lc-status.ok{background:#12352c;color:#78dfb6}.lc-status.warn{background:#3b3018;color:#f2ce73}.lc-status.bad{background:#451c27;color:#ff9bad}.lc-status.muted{background:#182634;color:#879daf}.lc-detail{background:#06101a;border-top:1px solid #233c50;padding:14px 16px 18px}.lc-detail-title{display:flex;gap:18px;align-items:end;margin-bottom:10px}.lc-detail-title>div:first-child{margin-right:auto}.lc-detail-title b,.lc-detail-title span,.lc-detail-title small{display:block}.lc-detail-title>div:first-child b{font-size:14px}.lc-detail-title>div:first-child span{color:#7991a5;font-size:10px;margin-top:2px}.lc-detail-title>div:not(:first-child){text-align:right}.lc-detail-title small{color:#6f899f;font-size:9px;text-transform:uppercase}.lc-detail-title>div:not(:first-child) b{font-size:17px;margin-top:2px}.lc-campaign-table{border:1px solid #153047;border-radius:11px;overflow:hidden}.lc-campaign-head,.lc-campaign-row{display:grid;grid-template-columns:minmax(260px,2fr) 90px 90px 90px 90px 90px;gap:8px;align-items:center}.lc-campaign-head{background:#0b1927;padding:8px 10px;color:#678298;font-size:8px;font-weight:900;text-transform:uppercase}.lc-campaign-row{padding:9px 10px;border-top:1px solid #11283a;color:#bcd0df;font-size:11px}.lc-campaign-row>span:first-child b,.lc-campaign-row>span:first-child small{display:block}.lc-campaign-row>span:first-child b{color:#e1edf5;font-size:11px}.lc-campaign-row>span:first-child small{color:#647f94;font-size:9px;margin-top:2px}.lc-unmatched,.lc-conflict{margin-top:9px;border-radius:9px;padding:9px 10px;font-size:10px}.lc-unmatched{border:1px solid #4d4025;background:#17150d;color:#d6bd7d}.lc-unmatched b,.lc-unmatched span{display:block}.lc-unmatched span{margin-top:3px;color:#9f906c}.lc-conflict{border:1px solid #6d3040;background:#241017;color:#ffacb9}.lc-empty{padding:13px;text-align:center;color:#738da2;font-size:11px}.lc-empty.big{padding:35px}.lc-source{margin-top:16px;border-top:1px solid #193349;padding-top:14px;color:#7891a6;font-size:10px;line-height:1.5}.lc-source b{color:#a8c0d2}.lc-source p{margin:5px 0}.lc-source strong{color:#bcd1df}.lc-source code{color:#8cd7ff;background:#0c1d2b;padding:1px 4px;border-radius:4px}@media(max-width:1100px){.lc-metrics{grid-template-columns:repeat(3,1fr)}.lc-head,.lc-client-main{grid-template-columns:minmax(220px,2fr) 70px 80px 85px 90px minmax(130px,1fr)}.lc-head span:nth-child(6),.lc-client-main>span:nth-child(6){display:none}.lc-campaign-head,.lc-campaign-row{grid-template-columns:minmax(220px,2fr) 80px 80px 80px 80px}.lc-campaign-head span:nth-child(4),.lc-campaign-row>span:nth-child(4){display:none}}@media(max-width:760px){.lc-shell{padding:18px 12px 70px}.lc-top{flex-direction:column}.lc-actions{width:100%;justify-content:space-between}.lc-metrics{grid-template-columns:1fr 1fr}.lc-head{display:none}.lc-client-main{grid-template-columns:1fr 62px 72px;gap:6px}.lc-client-main>*:nth-child(4),.lc-client-main>*:nth-child(5),.lc-client-main>*:nth-child(6){display:none}.lc-status{grid-column:1/-1}.lc-campaign-head{display:none}.lc-campaign-row{grid-template-columns:1fr 65px 65px;gap:5px}.lc-campaign-row>*:nth-child(2),.lc-campaign-row>*:nth-child(4),.lc-campaign-row>*:nth-child(6){display:none}.lc-detail-title{flex-wrap:wrap}.lc-custom{flex-wrap:wrap}.lc-controls label,.lc-search{min-width:min(100%,180px);flex:1}.lc-sort{min-width:180px}}
`;