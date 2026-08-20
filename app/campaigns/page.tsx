"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaigns-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type Payload = { clients: Row[]; campaigns: Row[]; summary: Row; profile?: Row; generated_at?: string };

type LifeFilter = "ACTIVE" | "CHURNED" | "ALL";
type DeliveryFilter = "ALL" | "ACTIVE_DELIVERY" | "NO_META_ACCOUNT" | "NO_INSIGHTS" | "NO_DELIVERY" | "NO_ACTIVE_CAMPAIGN" | "STALE" | "CHURNED_WITH_DELIVERY";

function money(value: unknown, precise = false) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: precise ? 2 : 0, maximumFractionDigits: precise ? 2 : 0 }).format(Number(value || 0));
}
function num(value: unknown, digits = 0) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0)); }
function day(value: unknown) { if (!value) return "—"; const raw=String(value).slice(0,10); const [y,m,d]=raw.split("-").map(Number); return y&&m&&d ? new Intl.DateTimeFormat("pt-BR").format(new Date(y,m-1,d)) : raw; }
function dateTime(value: unknown) { return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(new Date(String(value))) : "—"; }

const statusText: Record<string,string> = {
  ACTIVE_DELIVERY:"Com entrega", NO_META_ACCOUNT:"Sem conta Meta", NO_INSIGHTS:"Conectado · sem insights",
  NO_DELIVERY:"Sem entrega", NO_ACTIVE_CAMPAIGN:"Sem campanha ativa", STALE:"Dados atrasados",
  CHURNED_WITH_DELIVERY:"Churned com entrega", ACTIVE:"Ativa", PAUSED:"Pausada", CHURNED:"Churned", ONBOARDING:"Onboarding"
};
const statusTone: Record<string,string> = {
  ACTIVE_DELIVERY:"ok", NO_META_ACCOUNT:"bad", NO_INSIGHTS:"warn", NO_DELIVERY:"warn", NO_ACTIVE_CAMPAIGN:"muted", STALE:"warn", CHURNED_WITH_DELIVERY:"bad",
  ACTIVE:"ok", PAUSED:"muted", CHURNED:"bad", ONBOARDING:"warn"
};

function Pill({ value }: { value: unknown }) { const raw=String(value||"—"); return <span className={`mc-pill ${statusTone[raw]||"muted"}`}>{statusText[raw]||raw.replaceAll("_"," ")}</span>; }

export default function CampaignsPage() {
  const [session,setSession]=useState<Session|null>(null);
  const [ready,setReady]=useState(false);
  const [payload,setPayload]=useState<Payload|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [life,setLife]=useState<LifeFilter>("ACTIVE");
  const [delivery,setDelivery]=useState<DeliveryFilter>("ALL");
  const [query,setQuery]=useState("");
  const [expanded,setExpanded]=useState<string|null>(null);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{ setSession(data.session); setReady(true); if(!data.session) window.location.replace("/"); });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>{setSession(next); if(!next) window.location.replace("/");});
    return ()=>subscription.unsubscribe();
  },[]);

  const load=useCallback(async()=>{
    if(!session?.access_token) return;
    setLoading(true); setError("");
    try{
      const url=new URL(API_URL); url.searchParams.set("lifecycle",life); url.searchParams.set("details","1");
      const response=await fetch(url,{headers:{Authorization:`Bearer ${session.access_token}`},cache:"no-store"});
      const body=await response.json();
      if(!response.ok) throw new Error(body.detail||body.error||`API ${response.status}`);
      setPayload(body);
    }catch(e){setError(e instanceof Error?e.message:"Falha ao carregar campanhas");}
    finally{setLoading(false);}
  },[session?.access_token,life]);
  useEffect(()=>{load();},[load]);

  const rows=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase("pt-BR");
    return (payload?.clients||[]).filter(row=>(delivery==="ALL"||row.delivery_status===delivery) && (!needle||[row.display_name,row.gt_owner,row.configured_account_names].join(" ").toLocaleLowerCase("pt-BR").includes(needle)))
      .sort((a,b)=>{
        const rank:Record<string,number>={CHURNED_WITH_DELIVERY:0,NO_META_ACCOUNT:1,STALE:2,NO_INSIGHTS:3,NO_DELIVERY:4,NO_ACTIVE_CAMPAIGN:5,ACTIVE_DELIVERY:6};
        return (rank[a.delivery_status]??9)-(rank[b.delivery_status]??9)||String(a.display_name).localeCompare(String(b.display_name),"pt-BR");
      });
  },[payload,delivery,query]);
  const campaignByClient=useMemo(()=>{const map=new Map<string,Row[]>(); for(const row of payload?.campaigns||[]) map.set(row.client_id,[...(map.get(row.client_id)||[]),row]); return map;},[payload]);
  const s=payload?.summary||{};

  if(!ready) return <main className="mc-loading">Validando sessão…</main>;
  return <main className="mc-shell">
    <style>{styles}</style>
    <header className="mc-top">
      <div><button className="mc-back" onClick={()=>window.location.assign("/")}>← Central de Operações</button><span className="mc-kicker">META ADS · FONTE CANÔNICA</span><h1>Campanhas</h1><p>Performance real da última referência fechada da Meta, com cobertura da carteira e diagnóstico sem duplicar conversões.</p></div>
      <div className="mc-top-actions"><span className={`mc-live ${loading?"loading":""}`}>{loading?"Atualizando…":`Sincronizado · ${dateTime(s.checked_at)}`}</span><button onClick={load}>Atualizar</button></div>
    </header>

    <section className="mc-tabs">
      {([['ACTIVE','Ativos'],['CHURNED','Churned'],['ALL','Todos']] as [LifeFilter,string][]).map(([key,label])=><button key={key} className={life===key?"active":""} onClick={()=>{setLife(key);setExpanded(null);}}>{label}</button>)}
    </section>

    {error&&<div className="mc-error"><b>Falha na leitura das campanhas</b><span>{error}</span></div>}

    <section className="mc-metrics">
      <article><small>Investimento</small><strong>{money(s.spend)}</strong><span>referência {day(s.reference_date)}</span></article>
      <article><small>Resultados</small><strong>{num(s.results)}</strong><span>lead ou conversa, conforme campanha</span></article>
      <article><small>Custo por resultado</small><strong>{s.cost_per_result==null?"—":money(s.cost_per_result,true)}</strong><span>investimento ÷ resultado canônico</span></article>
      <article><small>CTR</small><strong>{s.ctr==null?"—":`${num(s.ctr,2)}%`}</strong><span>cliques ÷ impressões</span></article>
    </section>

    <section className="mc-coverage">
      <button className={delivery==="ACTIVE_DELIVERY"?"active":""} onClick={()=>setDelivery(delivery==="ACTIVE_DELIVERY"?"ALL":"ACTIVE_DELIVERY")}><i className="ok"/><span><b>{num(s.active_delivery)}</b> com entrega</span></button>
      <button className={delivery==="NO_INSIGHTS"?"active":""} onClick={()=>setDelivery(delivery==="NO_INSIGHTS"?"ALL":"NO_INSIGHTS")}><i className="warn"/><span><b>{num(s.connected_no_insights)}</b> conectados sem insights</span></button>
      <button className={delivery==="NO_META_ACCOUNT"?"active":""} onClick={()=>setDelivery(delivery==="NO_META_ACCOUNT"?"ALL":"NO_META_ACCOUNT")}><i className="bad"/><span><b>{num(s.no_meta_account)}</b> sem conta Meta</span></button>
      <button className={delivery==="NO_DELIVERY"?"active":""} onClick={()=>setDelivery(delivery==="NO_DELIVERY"?"ALL":"NO_DELIVERY")}><i className="warn"/><span><b>{num(s.no_delivery)}</b> sem entrega</span></button>
      {(Number(s.stale)>0)&&<button className={delivery==="STALE"?"active":""} onClick={()=>setDelivery(delivery==="STALE"?"ALL":"STALE")}><i className="warn"/><span><b>{num(s.stale)}</b> atrasados</span></button>}
      {(Number(s.churned_with_delivery)>0)&&<button className={delivery==="CHURNED_WITH_DELIVERY"?"active":""} onClick={()=>setDelivery(delivery==="CHURNED_WITH_DELIVERY"?"ALL":"CHURNED_WITH_DELIVERY")}><i className="bad"/><span><b>{num(s.churned_with_delivery)}</b> churned com entrega</span></button>}
    </section>

    <section className="mc-panel">
      <div className="mc-panel-head"><div><h2>Diagnóstico por cliente</h2><p>{rows.length} de {num(s.clients_total)} clientes no filtro · clique para abrir as campanhas</p></div><div className="mc-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente, GT ou conta Meta"/>{delivery!=="ALL"&&<button onClick={()=>setDelivery("ALL")}>Limpar status</button>}</div></div>
      <div className="mc-table-wrap"><table><thead><tr><th>Cliente / conta</th><th>Situação</th><th>Campanhas</th><th>Investimento</th><th>Resultados</th><th>Custo/result.</th><th>CTR</th><th>Referência</th></tr></thead><tbody>
        {rows.map(row=>{
          const details=campaignByClient.get(row.client_id)||[]; const isOpen=expanded===row.client_id;
          return <FragmentRow key={row.client_id} row={row} details={details} open={isOpen} toggle={()=>setExpanded(isOpen?null:row.client_id)}/>;
        })}
        {!rows.length&&!loading&&<tr><td colSpan={8} className="mc-empty">Nenhum cliente nesse filtro.</td></tr>}
      </tbody></table></div>
    </section>

    <footer className="mc-note"><b>Como ler:</b> “Resultados” não soma eventos duplicados da Meta. Campanhas de formulário usam uma única conversão canônica de lead; campanhas de WhatsApp/mensagem usam conversa iniciada/conexão como resultado quando aplicável. Clientes sem conta ou sem insights permanecem visíveis em vez de desaparecer da aba.</footer>
  </main>;
}

function FragmentRow({row,details,open,toggle}:{row:Row;details:Row[];open:boolean;toggle:()=>void}){
  const hasDetails=details.length>0;
  return <>
    <tr className={`mc-client-row ${row.delivery_status==='CHURNED_WITH_DELIVERY'?'danger':''}`} onClick={hasDetails?toggle:undefined}>
      <td><div className="mc-client"><span className="mc-chevron">{hasDetails?(open?'−':'+'):'·'}</span><span><b>{row.display_name}</b><small>{row.configured_account_names||"Conta Meta não configurada"}{row.gt_owner?` · GT ${row.gt_owner}`:""}</small></span></div></td>
      <td><Pill value={row.delivery_status}/></td>
      <td><b>{num(row.active_campaigns)}</b><small> ativas / {num(row.campaign_count)} total</small></td>
      <td>{money(row.spend)}</td><td>{num(row.results)}</td><td>{Number(row.results)>0?money(row.cost_per_result,true):"—"}</td><td>{row.ctr==null?"—":`${num(row.ctr,2)}%`}</td><td>{day(row.latest_date)}<small className="mc-block">{row.checked_at?dateTime(row.checked_at):"sem leitura"}</small></td>
    </tr>
    {open&&<tr className="mc-detail-row"><td colSpan={8}><div className="mc-detail"><div className="mc-detail-title">Campanhas · última referência disponível</div>{details.map(c=><div className="mc-campaign" key={c.campaign_id}><div className="mc-campaign-name"><Pill value={c.campaign_status}/><span><b>{c.campaign_name||c.campaign_id}</b><small>{c.objective||"objetivo não informado"} · {c.account_key}</small></span></div><span><small>Invest.</small><b>{money(c.spend,true)}</b></span><span><small>Resultado</small><b>{c.result_count==null?"—":num(c.result_count)}</b><em>{c.result_type||"—"}</em></span><span><small>Custo/result.</small><b>{c.cost_per_result==null?"—":money(c.cost_per_result,true)}</b></span><span><small>CTR</small><b>{c.ctr==null?"—":`${num(c.ctr,2)}%`}</b></span><span><small>CPM</small><b>{c.cpm==null?"—":money(c.cpm,true)}</b></span></div>)}</div></td></tr>}
  </>;
}

const styles=`
:root{--mc-bg:#06111f;--mc-panel:#0a1727;--mc-panel2:#0e1e31;--mc-line:rgba(149,176,210,.14);--mc-text:#edf5ff;--mc-muted:#8094ad;--mc-blue:#73a7ff;--mc-green:#31d49b;--mc-yellow:#f7c95c;--mc-red:#ff6b75}
[data-theme="light"]{--mc-bg:#f5f8fc;--mc-panel:#fff;--mc-panel2:#f7f9fc;--mc-line:#dce5ef;--mc-text:#142033;--mc-muted:#617085}
body{background:var(--mc-bg)}.mc-shell{min-height:100vh;padding:34px 38px 90px;color:var(--mc-text);background:radial-gradient(circle at 75% -20%,rgba(46,108,190,.16),transparent 38%),var(--mc-bg);font-family:Inter,system-ui,sans-serif}.mc-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;max-width:1500px;margin:auto}.mc-back{border:0;background:transparent;color:var(--mc-muted);padding:0;margin:0 0 28px;cursor:pointer;font-size:12px}.mc-kicker{display:block;font-size:10px;letter-spacing:.16em;color:var(--mc-blue);font-weight:800}.mc-top h1{font:800 clamp(34px,5vw,58px)/1 Inter Tight,Inter,sans-serif;margin:8px 0}.mc-top p{max-width:760px;color:var(--mc-muted);font-size:13px;line-height:1.6}.mc-top-actions{display:flex;align-items:center;gap:10px;margin-top:10px}.mc-top-actions button,.mc-search button{background:var(--mc-panel2);color:var(--mc-text);border:1px solid var(--mc-line);border-radius:9px;padding:9px 13px;cursor:pointer}.mc-live{font-size:10px;color:var(--mc-green)}.mc-live.loading{color:var(--mc-yellow)}.mc-tabs{max-width:1500px;margin:30px auto 14px;display:flex;gap:6px;border-bottom:1px solid var(--mc-line)}.mc-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--mc-muted);padding:10px 15px;cursor:pointer;font-weight:700;font-size:12px}.mc-tabs button.active{color:var(--mc-text);border-color:var(--mc-blue)}.mc-error{max-width:1500px;margin:12px auto;padding:12px 14px;border:1px solid rgba(255,107,117,.35);background:rgba(255,107,117,.08);border-radius:10px;display:flex;gap:12px;font-size:12px}.mc-metrics{max-width:1500px;margin:18px auto 10px;display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.mc-metrics article{background:var(--mc-panel);border:1px solid var(--mc-line);border-radius:13px;padding:16px}.mc-metrics small{display:block;color:var(--mc-muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em}.mc-metrics strong{display:block;font-size:26px;margin:8px 0 4px}.mc-metrics span{font-size:10px;color:var(--mc-muted)}.mc-coverage{max-width:1500px;margin:10px auto 18px;display:flex;flex-wrap:wrap;gap:7px}.mc-coverage button{display:flex;align-items:center;gap:7px;border:1px solid var(--mc-line);background:var(--mc-panel);color:var(--mc-muted);border-radius:999px;padding:7px 11px;cursor:pointer;font-size:10px}.mc-coverage button.active{outline:1px solid var(--mc-blue);color:var(--mc-text)}.mc-coverage i{width:7px;height:7px;border-radius:50%;background:var(--mc-muted)}.mc-coverage i.ok{background:var(--mc-green)}.mc-coverage i.warn{background:var(--mc-yellow)}.mc-coverage i.bad{background:var(--mc-red)}.mc-panel{max-width:1500px;margin:auto;background:var(--mc-panel);border:1px solid var(--mc-line);border-radius:14px;overflow:hidden}.mc-panel-head{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px 18px;border-bottom:1px solid var(--mc-line)}.mc-panel-head h2{font-size:14px;margin:0}.mc-panel-head p{font-size:10px;color:var(--mc-muted);margin:4px 0 0}.mc-search{display:flex;gap:6px}.mc-search input{min-width:260px;border:1px solid var(--mc-line);background:var(--mc-panel2);color:var(--mc-text);border-radius:9px;padding:9px 11px;font-size:11px;outline:none}.mc-table-wrap{overflow:auto}.mc-table-wrap table{width:100%;border-collapse:collapse;font-size:11px}.mc-table-wrap th{position:sticky;top:0;background:var(--mc-panel);z-index:1;text-align:left;color:var(--mc-muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:10px 12px;border-bottom:1px solid var(--mc-line)}.mc-table-wrap td{padding:11px 12px;border-bottom:1px solid var(--mc-line);white-space:nowrap}.mc-client-row{cursor:pointer}.mc-client-row:hover{background:rgba(115,167,255,.035)}.mc-client-row.danger{background:rgba(255,107,117,.045)}.mc-client{display:flex;align-items:center;gap:8px;min-width:245px}.mc-client span span,.mc-client>span:last-child{display:grid}.mc-client small{color:var(--mc-muted);margin-top:3px;font-size:9px}.mc-chevron{width:17px;height:17px;border-radius:5px;background:var(--mc-panel2);display:grid;place-items:center;color:var(--mc-muted)}.mc-pill{display:inline-block;padding:4px 7px;border-radius:6px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;background:rgba(128,148,173,.1);color:var(--mc-muted)}.mc-pill.ok{background:rgba(49,212,155,.09);color:var(--mc-green)}.mc-pill.warn{background:rgba(247,201,92,.09);color:var(--mc-yellow)}.mc-pill.bad{background:rgba(255,107,117,.09);color:var(--mc-red)}.mc-block{display:block;color:var(--mc-muted);font-size:8px;margin-top:2px}.mc-detail-row td{padding:0 14px 14px;background:rgba(0,0,0,.08)}.mc-detail{border:1px solid var(--mc-line);border-radius:10px;overflow:hidden}.mc-detail-title{padding:8px 10px;color:var(--mc-muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em;background:var(--mc-panel2)}.mc-campaign{display:grid;grid-template-columns:minmax(280px,2.2fr) repeat(5,minmax(80px,.55fr));gap:10px;align-items:center;padding:10px;border-top:1px solid var(--mc-line)}.mc-campaign:first-of-type{border-top:0}.mc-campaign-name{display:flex;gap:9px;align-items:center}.mc-campaign-name>span{display:grid}.mc-campaign-name small,.mc-campaign>span small{display:block;color:var(--mc-muted);font-size:8px}.mc-campaign>span b{display:block;margin-top:3px}.mc-campaign em{font-style:normal;color:var(--mc-muted);font-size:7px}.mc-empty{text-align:center!important;color:var(--mc-muted);padding:30px!important}.mc-note{max-width:1500px;margin:12px auto;color:var(--mc-muted);font-size:10px;line-height:1.55;padding:12px 14px;border:1px dashed var(--mc-line);border-radius:10px}.mc-loading{min-height:100vh;display:grid;place-items:center;background:#06111f;color:#8094ad}
@media(max-width:900px){.mc-shell{padding:22px 14px 70px}.mc-top{flex-direction:column}.mc-top-actions{width:100%;justify-content:space-between}.mc-metrics{grid-template-columns:1fr 1fr}.mc-panel-head{align-items:stretch;flex-direction:column}.mc-search input{min-width:0;width:100%}.mc-campaign{grid-template-columns:1fr 1fr}.mc-campaign-name{grid-column:1/-1}}
`;