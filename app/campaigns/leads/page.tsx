"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, supabase } from "../../shared";

const META_API = `${SUPABASE_URL}/functions/v1/agency-ops-campaigns-api`;
const DISPATCH_API = `${SUPABASE_URL}/functions/v1/agency-ops-lead-dispatch-api`;

type Row = Record<string, any>;
type Range = { since: string; until: string; label: string };
type Period = "TODAY" | "YESTERDAY" | "LAST_7D" | "THIS_MONTH" | "CUSTOM";
type ViewFilter = "ALL" | "LOW" | "ZERO" | "DIVERGENT" | "OK";
type KpiKey = "LEADS" | "CPL" | "CTR" | "REACH" | "IMPRESSIONS" | "FREQUENCY" | "CLICKS" | "CPC" | "CPM" | "SPEND" | "RESULTS" | "CPR" | "DISPATCHES" | "DIFFERENCE";
type SortDirection = "DESC" | "ASC";

type KpiDefinition = {
  key: KpiKey;
  label: string;
  short: string;
  kind: "number" | "money" | "percent" | "decimal" | "signed";
};

const KPI_DEFS: KpiDefinition[] = [
  { key: "LEADS", label: "Leads", short: "Leads", kind: "number" },
  { key: "CPL", label: "CPL", short: "CPL", kind: "money" },
  { key: "CTR", label: "CTR", short: "CTR", kind: "percent" },
  { key: "REACH", label: "Alcance", short: "Alcance", kind: "number" },
  { key: "IMPRESSIONS", label: "Impressões", short: "Impressões", kind: "number" },
  { key: "FREQUENCY", label: "Frequência", short: "Freq.", kind: "decimal" },
  { key: "CLICKS", label: "Cliques", short: "Cliques", kind: "number" },
  { key: "CPC", label: "CPC", short: "CPC", kind: "money" },
  { key: "CPM", label: "CPM", short: "CPM", kind: "money" },
  { key: "SPEND", label: "Gasto", short: "Gasto", kind: "money" },
  { key: "RESULTS", label: "Resultados", short: "Resultados", kind: "number" },
  { key: "CPR", label: "Custo por resultado", short: "Custo/result.", kind: "money" },
  { key: "DISPATCHES", label: "Disparos WhatsApp", short: "Disparos", kind: "number" },
  { key: "DIFFERENCE", label: "Diferença Meta × WPP", short: "Meta − WPP", kind: "signed" },
];

const META_KPI_KEYS = new Set<KpiKey>(["LEADS","CPL","CTR","REACH","IMPRESSIONS","FREQUENCY","CLICKS","CPC","CPM","SPEND","RESULTS","CPR"]);

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
function finite(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }

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
function kpiDef(key: KpiKey) { return KPI_DEFS.find((item) => item.key === key) || KPI_DEFS[0]; }
function kpiValue(row: Row, key: KpiKey) {
  const spend = Number(row.spend || 0);
  const leads = Number(row.meta_leads ?? row.leads ?? 0);
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const results = Number(row.results ?? row.result_count ?? 0);
  const reach = Number(row.reach || 0);
  if (key === "LEADS") return leads;
  if (key === "CPL") return leads > 0 ? spend / leads : null;
  if (key === "CTR") return finite(row.ctr) ?? (impressions > 0 ? clicks / impressions * 100 : null);
  if (key === "REACH") return reach;
  if (key === "IMPRESSIONS") return impressions;
  if (key === "FREQUENCY") return finite(row.frequency) ?? (reach > 0 ? impressions / reach : null);
  if (key === "CLICKS") return clicks;
  if (key === "CPC") return finite(row.cpc) ?? (clicks > 0 ? spend / clicks : null);
  if (key === "CPM") return finite(row.cpm) ?? (impressions > 0 ? spend / impressions * 1000 : null);
  if (key === "SPEND") return spend;
  if (key === "RESULTS") return results;
  if (key === "CPR") return finite(row.cost_per_result) ?? (results > 0 ? spend / results : null);
  if (key === "DISPATCHES") return Number(row.dispatches || 0);
  return Number(row.difference || 0);
}
function formatKpi(value: number | null, key: KpiKey) {
  if (value == null || !Number.isFinite(value)) return "—";
  const def = kpiDef(key);
  if (def.kind === "money") return money(value, 2);
  if (def.kind === "percent") return `${number(value, 2)}%`;
  if (def.kind === "decimal") return number(value, 2);
  if (def.kind === "signed") return `${value > 0 ? "+" : ""}${number(value, 0)}`;
  return number(value, 0);
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
  const [kpi,setKpi] = useState<KpiKey>("LEADS");
  const [direction,setDirection] = useState<SortDirection>("DESC");
  const [kpiMin,setKpiMin] = useState("");
  const [kpiMax,setKpiMax] = useState("");
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
  const metaCampaignByClient = useMemo(() => {
    const map = new Map<string,Row[]>();
    for (const row of meta?.campaigns || []) {
      const id = String(row.client_id || "");
      if (!id) continue;
      map.set(id,[...(map.get(id)||[]),row]);
    }
    return map;
  },[meta]);
  const gtOptions = useMemo(() => [...new Set((meta?.clients || []).map((row:Row) => String(row.gt_owner || "").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR")),[meta]);

  const allMerged = useMemo(() => {
    return (meta?.clients || []).map((client:Row) => {
      const clientId = String(client.client_id);
      const wa:Row = dispatchClient.get(clientId) || {};
      const metaLeads=Number(client.leads||0), dispatches=Number(wa.dispatches||0);
      const campaignRows = metaCampaignByClient.get(clientId) || [];
      const reach = campaignRows.reduce((sum,row)=>sum+Number(row.reach||0),0);
      const base={
        ...client,
        meta_leads:metaLeads,
        dispatches,
        difference:metaLeads-dispatches,
        reach,
        frequency:reach>0?Number(client.impressions||0)/reach:null,
        campaign_matched:Number(wa.campaign_matched || 0),
        campaign_unmatched:Number(wa.campaign_unmatched || 0),
        routing_conflicts:Number(wa.routing_conflicts || 0),
        dispatch_products:wa.products || [],
      };
      return {...base,status:reconciliationStatus(base)};
    });
  },[meta,dispatchClient,metaCampaignByClient]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    const minValue = kpiMin.trim() === "" ? null : Number(kpiMin);
    const maxValue = kpiMax.trim() === "" ? null : Number(kpiMax);
    return allMerged.filter((row:Row) => {
      if (needle && ![row.display_name,row.gt_owner,row.configured_account_names].join(" ").toLocaleLowerCase("pt-BR").includes(needle)) return false;
      if (gtFilter !== "ALL" && String(row.gt_owner || "") !== gtFilter) return false;
      if (filter === "LOW" && !(row.meta_leads <= lowThreshold)) return false;
      if (filter === "ZERO" && row.meta_leads !== 0) return false;
      if (filter === "DIVERGENT" && !["DIVERGENT","NO_DISPATCH"].includes(row.status)) return false;
      if (filter === "OK" && row.status !== "OK") return false;
      const value = kpiValue(row,kpi);
      if (minValue != null && Number.isFinite(minValue) && (value == null || value < minValue)) return false;
      if (maxValue != null && Number.isFinite(maxValue) && (value == null || value > maxValue)) return false;
      return true;
    }).sort((a:Row,b:Row) => {
      const av=kpiValue(a,kpi), bv=kpiValue(b,kpi);
      if (av == null && bv == null) return String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      if (av == null) return 1;
      if (bv == null) return -1;
      const delta=direction === "DESC" ? bv-av : av-bv;
      return delta || Number(b.meta_leads||0)-Number(a.meta_leads||0) || String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
    });
  },[allMerged,query,gtFilter,filter,lowThreshold,kpi,kpiMin,kpiMax,direction]);

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
      const leads=Number(m.leads_estimate||0), wa=Number(w.dispatches||0), spend=Number(m.spend||0), impressions=Number(m.impressions||0), clicks=Number(m.clicks||0), reach=Number(m.reach||0), results=Number(m.result_count||0);
      return {
        campaign_id:campaignId,
        campaign_name:m.campaign_name||w.campaign_name||campaignId,
        campaign_status:m.campaign_status||null,
        spend,
        meta_leads:leads,
        leads,
        cpl:leads>0?spend/leads:null,
        result_count:results,
        results,
        cost_per_result:m.cost_per_result==null?(results>0?spend/results:null):Number(m.cost_per_result),
        impressions,
        reach,
        frequency:m.frequency==null?(reach>0?impressions/reach:null):Number(m.frequency),
        clicks,
        ctr:m.ctr==null?(impressions>0?clicks/impressions*100:null):Number(m.ctr),
        cpc:m.cpc==null?(clicks>0?spend/clicks:null):Number(m.cpc),
        cpm:m.cpm==null?(impressions>0?spend/impressions*1000:null):Number(m.cpm),
        dispatches:wa,
        difference:leads-wa,
        products:w.products||[],
        has_delivery:Boolean(m.has_delivery),
      };
    }).filter((row:Row)=>row.spend>0||row.leads>0||row.dispatches>0||row.has_delivery)
      .sort((a:Row,b:Row)=>{
        const av=kpiValue(a,kpi),bv=kpiValue(b,kpi);
        if(av==null&&bv==null)return String(a.campaign_name).localeCompare(String(b.campaign_name),"pt-BR");
        if(av==null)return 1;if(bv==null)return -1;
        return (direction==="DESC"?bv-av:av-bv)||b.leads-a.leads;
      });
  }

  const selectedKpi = kpiDef(kpi);
  if (!ready) return <main className="lc-loading">Validando sessão…</main>;
  const sourceSummary:Row=dispatch?.summary||{};
  const metaSummary:Row=meta?.summary||{};

  return <main className="lc-shell"><style>{styles}</style>
    <header className="lc-top">
      <div><span className="lc-kicker">CONFERÊNCIA DIÁRIA · META + DISPAROS DE LEADS</span><h1>Conferência de Leads</h1><p>Compare Meta × disparos e ordene toda a carteira pelos principais KPIs de mídia. Expanda qualquer cliente para analisar campanha por campanha.</p></div>
      <div className="lc-actions"><span>{loading?"Atualizando…":`Meta ao vivo · ${dateTime(metaSummary.fetched_at)}`}</span><button onClick={load} disabled={loading}>{loading?"Consultando…":"Atualizar agora"}</button></div>
    </header>

    <section className="lc-controls">
      <label>Período<select value={period} onChange={(e)=>changePeriod(e.target.value as Period)}><option value="TODAY">Hoje</option><option value="YESTERDAY">Ontem</option><option value="LAST_7D">Últimos 7 dias</option><option value="THIS_MONTH">Este mês</option><option value="CUSTOM">Personalizado</option></select></label>
      {period==="CUSTOM"&&<div className="lc-custom"><input type="date" value={customSince} onChange={(e)=>setCustomSince(e.target.value)}/><span>até</span><input type="date" value={customUntil} onChange={(e)=>setCustomUntil(e.target.value)}/><button onClick={applyCustom}>Aplicar</button></div>}
      <label>GT<select value={gtFilter} onChange={(e)=>setGtFilter(e.target.value)}><option value="ALL">Todos os GTs</option>{gtOptions.map((gt)=><option key={gt} value={gt}>{gt}</option>)}</select></label>
      <label>KPI<select className="lc-kpi" value={kpi} onChange={(e)=>{setKpi(e.target.value as KpiKey);setKpiMin("");setKpiMax("");}}><optgroup label="Meta Ads">{KPI_DEFS.filter((item)=>META_KPI_KEYS.has(item.key)).map((item)=><option key={item.key} value={item.key}>{item.label}</option>)}</optgroup><optgroup label="Conferência">{KPI_DEFS.filter((item)=>!META_KPI_KEYS.has(item.key)).map((item)=><option key={item.key} value={item.key}>{item.label}</option>)}</optgroup></select></label>
      <label>Ordem<select value={direction} onChange={(e)=>setDirection(e.target.value as SortDirection)}><option value="DESC">Maior → menor</option><option value="ASC">Menor → maior</option></select></label>
      <label className="lc-search">Buscar<input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Cliente ou GT"/></label>
      <label>Mín. {selectedKpi.short}<input className="lc-range-input" type="number" step="any" value={kpiMin} onChange={(e)=>setKpiMin(e.target.value)} placeholder="—"/></label>
      <label>Máx. {selectedKpi.short}<input className="lc-range-input" type="number" step="any" value={kpiMax} onChange={(e)=>setKpiMax(e.target.value)} placeholder="—"/></label>
      <label>Poucos leads ≤<input className="lc-threshold" type="number" min="0" max="100" value={lowThreshold} onChange={(e)=>setLowThreshold(Math.max(0,Number(e.target.value||0)))}/></label>
    </section>

    <div className="lc-period">{range.label} · {dateLabel(range.since)}{range.since!==range.until?` → ${dateLabel(range.until)}`:""} · {rows.length} cliente(s) exibido(s) · ordenado por {selectedKpi.label.toLowerCase()} ({direction==="DESC"?"maior primeiro":"menor primeiro"})</div>
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
      <div className="lc-head"><span>Cliente</span><span>Leads</span><span>Disparos</span><span>Meta − WPP</span><span>{selectedKpi.short}</span><span>Status</span></div>
      {rows.map((row:Row,index:number)=>{const open=expanded===String(row.client_id);const campaigns=campaignRows(row);const value=kpiValue(row,kpi);return <article className={`lc-client ${open?"open":""}`} key={row.client_id}>
        <button className="lc-client-main" onClick={()=>setExpanded(open?null:String(row.client_id))}>
          <span className="lc-name"><b>{index<3&&direction==="DESC"?<em className={`lc-rank rank-${index+1}`}>#{index+1}</em>:null}{row.display_name}</b><small>{row.gt_owner||"Sem GT"} · {deliveryLabel[row.delivery_status]||row.delivery_status||"—"}</small></span>
          <strong className="blue-text">{number(row.meta_leads)}</strong>
          <strong className="orange-text">{number(row.dispatches)}</strong>
          <strong className={row.difference===0?"ok-text":"warn-text"}>{row.difference>0?"+":""}{number(row.difference)}</strong>
          <strong className="lc-kpi-value">{formatKpi(value,kpi)}</strong>
          <span className={`lc-status ${statusTone(row.status)}`}>{statusText(row.status)}</span>
        </button>
        {open&&<div className="lc-detail">
          <div className="lc-detail-title"><div><b>Raio-X Meta do cliente</b><span>{campaigns.length} campanha(s) com movimento no período</span></div><div><small>Disparos conciliados</small><b>{number(row.campaign_matched||0)}</b></div><div><small>Não conciliados</small><b>{number(row.campaign_unmatched||0)}</b></div></div>
          <div className="lc-kpi-grid">
            {KPI_DEFS.filter((item)=>META_KPI_KEYS.has(item.key)).map((item)=><div key={item.key} className={item.key===kpi?"selected":""}><small>{item.label}</small><b>{formatKpi(kpiValue(row,item.key),item.key)}</b>{item.key==="REACH"&&<em>soma das campanhas</em>}</div>)}
          </div>
          <div className="lc-campaign-scroll"><div className="lc-campaign-table">
            <div className="lc-campaign-head"><span>Campanha</span><span>Gasto</span><span>Leads</span><span>CPL</span><span>Resultados</span><span>Custo/result.</span><span>CTR</span><span>CPC</span><span>CPM</span><span>Cliques</span><span>Impressões</span><span>Alcance</span><span>Freq.</span><span>Disparos</span><span>Diferença</span></div>
            {campaigns.map((campaign:Row)=><div className="lc-campaign-row" key={campaign.campaign_id}><span><b>{campaign.campaign_name}</b><small>{campaign.campaign_status||"status não informado"}</small></span><span>{money(campaign.spend)}</span><strong className="blue-text">{number(campaign.leads)}</strong><span>{formatKpi(kpiValue(campaign,"CPL"),"CPL")}</span><span>{number(campaign.results)}</span><span>{formatKpi(kpiValue(campaign,"CPR"),"CPR")}</span><span>{formatKpi(kpiValue(campaign,"CTR"),"CTR")}</span><span>{formatKpi(kpiValue(campaign,"CPC"),"CPC")}</span><span>{formatKpi(kpiValue(campaign,"CPM"),"CPM")}</span><span>{number(campaign.clicks)}</span><span>{number(campaign.impressions)}</span><span>{number(campaign.reach)}</span><span>{formatKpi(kpiValue(campaign,"FREQUENCY"),"FREQUENCY")}</span><strong className="orange-text">{number(campaign.dispatches)}</strong><strong className={campaign.difference===0?"ok-text":"warn-text"}>{campaign.difference>0?"+":""}{number(campaign.difference)}</strong></div>)}
            {!campaigns.length&&<div className="lc-empty">Nenhuma campanha com movimento neste período.</div>}
          </div></div>
          {row.campaign_unmatched>0&&<div className="lc-unmatched"><b>{row.campaign_unmatched} disparo(s) sem campanha conciliada</b><span>{(row.dispatch_products||[]).slice(0,8).map((p:Row)=>`${p.label} (${p.count})`).join(" · ")||"Produto não identificado"}</span></div>}
          {row.routing_conflicts>0&&<div className="lc-conflict">⚠ {row.routing_conflicts} disparo(s) com conflito de roteamento detectado.</div>}
        </div>}
      </article>})}
      {!loading&&!rows.length&&<div className="lc-empty big">Nenhum cliente encontrado neste filtro.</div>}
      {loading&&!meta&&<div className="lc-empty big">Consultando Meta e disparos de leads…</div>}
    </section>

    <footer className="lc-source"><b>Como a conferência conta os dados</b><p><strong>Meta:</strong> KPIs retornados pela Marketing API no período. Leads, gasto, impressões, cliques, CTR, CPC, CPM e resultados vêm do consolidado consultado ao vivo; a quebra por campanha usa os dados nativos de cada campanha. <strong>WhatsApp:</strong> somente mensagens <code>fromMe=true</code> classificadas pelo parser oficial como disparo de lead.</p><p><strong>Alcance no consolidado do cliente:</strong> soma do alcance das campanhas retornadas pela Meta; usuários podem aparecer em mais de uma campanha. Ao expandir, o alcance exibido em cada campanha é o valor nativo da Meta.</p></footer>
  </main>;
}

const styles=`
.lc-shell{min-height:100vh;background:#050d16;color:#eaf2fb;padding:26px 30px 70px;font-family:Inter,system-ui,sans-serif}.lc-loading{min-height:100vh;display:grid;place-items:center;background:#050d16;color:#a9bfd2;font-family:Inter,system-ui,sans-serif}.lc-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.lc-kicker{font-size:10px;letter-spacing:.14em;font-weight:900;color:#f1874e}.lc-top h1{font:800 clamp(30px,4vw,48px)/1 Inter Tight,Inter,sans-serif;margin:7px 0 8px}.lc-top p{color:#91a8bc;max-width:900px;line-height:1.5;margin:0}.lc-actions{display:flex;align-items:center;gap:10px}.lc-actions span{font-size:11px;color:#86a0b7}.lc-actions button,.lc-custom button{border:1px solid #bb5a27;background:#2a1710;color:#ffd8c2;border-radius:10px;padding:9px 12px;font-weight:800;cursor:pointer}.lc-actions button:hover,.lc-custom button:hover{background:#3a1e12}.lc-controls{margin-top:22px;display:flex;gap:10px;align-items:end;flex-wrap:wrap;background:#091725;border:1px solid #18364f;border-radius:15px;padding:12px}.lc-controls label{display:flex;flex-direction:column;gap:5px;color:#7892aa;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.lc-controls select,.lc-controls input{height:38px;box-sizing:border-box;border:1px solid #24445f;background:#07131f;color:#e9f4fc;border-radius:9px;padding:0 10px;font:600 12px Inter,system-ui,sans-serif;outline:none}.lc-controls select:focus,.lc-controls input:focus{border-color:#64c9ff;box-shadow:0 0 0 2px rgba(100,201,255,.1)}.lc-search{min-width:210px;flex:1}.lc-kpi{min-width:165px}.lc-threshold,.lc-range-input{width:92px}.lc-custom{display:flex;gap:6px;align-items:center}.lc-custom span{font-size:11px;color:#718aa0}.lc-period{margin:9px 2px 0;color:#7090aa;font-size:11px}.lc-error{margin-top:12px;border:1px solid #783747;background:#28131b;color:#ffd2da;padding:12px 14px;border-radius:12px}.lc-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0}.lc-metrics article{background:#0a1928;border:1px solid #19384f;border-radius:14px;padding:14px;position:relative;overflow:hidden}.lc-metrics article:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#334d61}.lc-metrics article.blue:before{background:#63caff}.lc-metrics article.orange:before{background:#f26b21}.lc-metrics article.warn:before{background:#f1ba4e}.lc-metrics article.bad:before{background:#ff6677}.lc-metrics small{display:block;color:#7891a7;font-size:9px;letter-spacing:.1em;font-weight:900}.lc-metrics b{display:block;font-size:28px;margin:5px 0 2px}.lc-metrics span{font-size:10px;color:#8ea6b9}.lc-coverage{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;border:1px solid #564525;background:#1b170d;border-radius:12px;padding:10px 12px;color:#f3d590;font-size:11px}.lc-coverage b{color:#ffe1a0}.lc-coverage small{color:#a99469}.lc-filter-tabs{display:flex;gap:6px;margin:16px 0 10px;flex-wrap:wrap}.lc-filter-tabs button{border:1px solid #203c53;background:#091522;color:#8fa8bb;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;cursor:pointer}.lc-filter-tabs button.active{border-color:#c05c28;color:#fff;background:linear-gradient(135deg,rgba(242,107,33,.22),rgba(71,184,255,.1))}.lc-table{border:1px solid #18364d;background:#07131f;border-radius:16px;overflow:hidden}.lc-head,.lc-client-main{display:grid;grid-template-columns:minmax(260px,2fr) 72px 85px 95px minmax(120px,.7fr) minmax(150px,.9fr);gap:10px;align-items:center}.lc-head{padding:9px 14px;background:#0c1b2c;color:#6f899f;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.08em}.lc-client{border-top:1px solid #142b3d}.lc-client:first-of-type{border-top:0}.lc-client-main{width:100%;border:0;background:#081622;color:#dceaf4;padding:12px 14px;text-align:left;cursor:pointer}.lc-client-main:hover{background:#0b1c2c}.lc-client.open .lc-client-main{background:linear-gradient(90deg,rgba(242,107,33,.08),rgba(82,188,255,.05))}.lc-client-main>span,.lc-client-main>strong{font-size:12px}.lc-name b,.lc-name small{display:block}.lc-name b{font-size:13px;color:#eef8ff;display:flex;align-items:center;gap:7px}.lc-name small{margin-top:3px;color:#7590a6;font-size:10px}.lc-rank{font-style:normal;font-size:9px;border:1px solid #32506a;border-radius:6px;padding:2px 4px;color:#a8c0d2}.lc-rank.rank-1{border-color:#d8994a;color:#ffd58c}.lc-rank.rank-2{border-color:#758ca0;color:#cfdae3}.lc-rank.rank-3{border-color:#9a6541;color:#e8b58d}.blue-text{color:#7ed3ff!important}.orange-text{color:#ff9b61!important}.ok-text{color:#71d5aa!important}.warn-text{color:#f6c768!important}.lc-kpi-value{color:#eef8ff;font-size:13px!important}.lc-status{display:inline-flex;width:max-content;max-width:100%;border-radius:999px;padding:5px 8px;font-size:9px!important;font-weight:900;white-space:nowrap}.lc-status.ok{background:#12352c;color:#78dfb6}.lc-status.warn{background:#3b3018;color:#f2ce73}.lc-status.bad{background:#451c27;color:#ff9bad}.lc-status.muted{background:#182634;color:#879daf}.lc-detail{background:#06101a;border-top:1px solid #233c50;padding:14px 16px 18px}.lc-detail-title{display:flex;gap:18px;align-items:end;margin-bottom:10px}.lc-detail-title>div:first-child{margin-right:auto}.lc-detail-title b,.lc-detail-title span,.lc-detail-title small{display:block}.lc-detail-title>div:first-child b{font-size:14px}.lc-detail-title>div:first-child span{color:#7991a5;font-size:10px;margin-top:2px}.lc-detail-title>div:not(:first-child){text-align:right}.lc-detail-title small{color:#6f899f;font-size:9px;text-transform:uppercase}.lc-detail-title>div:not(:first-child) b{font-size:17px;margin-top:2px}.lc-kpi-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px;margin-bottom:10px}.lc-kpi-grid div{border:1px solid #163149;background:#081723;border-radius:9px;padding:8px 9px}.lc-kpi-grid div.selected{border-color:#f07a3d;background:linear-gradient(135deg,rgba(242,107,33,.13),rgba(74,188,255,.07))}.lc-kpi-grid small,.lc-kpi-grid b,.lc-kpi-grid em{display:block}.lc-kpi-grid small{font-size:8px;text-transform:uppercase;color:#6f899f;font-weight:900}.lc-kpi-grid b{font-size:13px;margin-top:3px;color:#e7f2f9}.lc-kpi-grid em{font-size:8px;color:#7f91a0;font-style:normal;margin-top:2px}.lc-campaign-scroll{overflow-x:auto;border:1px solid #153047;border-radius:11px}.lc-campaign-table{min-width:1470px}.lc-campaign-head,.lc-campaign-row{display:grid;grid-template-columns:minmax(260px,2fr) 82px 65px 82px 74px 98px 65px 82px 82px 70px 92px 82px 60px 75px 76px;gap:7px;align-items:center}.lc-campaign-head{background:#0b1927;padding:8px 10px;color:#678298;font-size:8px;font-weight:900;text-transform:uppercase;position:sticky;top:0}.lc-campaign-row{padding:9px 10px;border-top:1px solid #11283a;color:#bcd0df;font-size:10px}.lc-campaign-row>span:first-child b,.lc-campaign-row>span:first-child small{display:block}.lc-campaign-row>span:first-child b{color:#e1edf5;font-size:10px}.lc-campaign-row>span:first-child small{color:#647f94;font-size:8px;margin-top:2px}.lc-unmatched,.lc-conflict{margin-top:9px;border-radius:9px;padding:9px 10px;font-size:10px}.lc-unmatched{border:1px solid #4d4025;background:#17150d;color:#d6bd7d}.lc-unmatched b,.lc-unmatched span{display:block}.lc-unmatched span{margin-top:3px;color:#9f906c}.lc-conflict{border:1px solid #6d3040;background:#241017;color:#ffacb9}.lc-empty{padding:13px;text-align:center;color:#738da2;font-size:11px}.lc-empty.big{padding:35px}.lc-source{margin-top:16px;border-top:1px solid #193349;padding-top:14px;color:#7891a6;font-size:10px;line-height:1.5}.lc-source b{color:#a8c0d2}.lc-source p{margin:5px 0}.lc-source strong{color:#bcd1df}.lc-source code{color:#8cd7ff;background:#0c1d2b;padding:1px 4px;border-radius:4px}@media(max-width:1180px){.lc-metrics{grid-template-columns:repeat(3,1fr)}.lc-kpi-grid{grid-template-columns:repeat(4,1fr)}}@media(max-width:760px){.lc-shell{padding:18px 12px 70px}.lc-top{flex-direction:column}.lc-actions{width:100%;justify-content:space-between}.lc-metrics{grid-template-columns:1fr 1fr}.lc-kpi-grid{grid-template-columns:1fr 1fr}.lc-head{display:none}.lc-client-main{grid-template-columns:1fr 62px 72px;gap:6px}.lc-client-main>*:nth-child(4),.lc-client-main>*:nth-child(5){display:none}.lc-status{grid-column:1/-1}.lc-detail-title{flex-wrap:wrap}.lc-custom{flex-wrap:wrap}}
`;