"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;
type Tab = "catalog" | "creativeRanking" | "designerRanking" | "method";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-creative-intelligence-api-v2`;

const STYLE = `
.rv2-designer.ci3-active>header,.rv2-designer.ci3-active>.rv2-designer-grid,.rv2-designer.ci3-active>.rv2-loading,.rv2-designer.ci3-active>.rv2-error{display:none!important}
.rv2-designer.ci3-active{padding:0!important;max-width:none!important;background:#071827;min-height:100vh}
.ci3{min-height:100vh;padding:30px 34px 60px;color:#eef6fb;font-family:Inter,system-ui,sans-serif}.ci3 *{box-sizing:border-box}
.ci3-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:1px solid rgba(141,190,218,.14);padding-bottom:20px}
.ci3-back{display:inline-flex;color:#62c6ff;text-decoration:none;font-size:12px;font-weight:800;margin-bottom:12px}.ci3-kicker{font-size:10px;font-weight:900;color:#4ab7f5;letter-spacing:.09em}
.ci3 h1{font-family:"Inter Tight",Inter,sans-serif;font-size:38px;line-height:1.02;margin:7px 0 6px;letter-spacing:-.03em}.ci3-sub{margin:0;color:#7fa7bd;font-size:13px;max-width:790px}
.ci3-stats{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.ci3-stat{min-width:108px;padding:11px 13px;border:1px solid rgba(126,180,210,.16);border-radius:13px;background:rgba(8,30,46,.88)}.ci3-stat b{display:block;font-size:22px}.ci3-stat span{font-size:8px;text-transform:uppercase;letter-spacing:.08em;color:#7198ae}
.ci3-coverage{margin:16px 0;display:flex;justify-content:space-between;align-items:center;gap:14px;padding:13px 15px;border:1px solid rgba(74,183,245,.2);border-radius:13px;background:#0b2030}.ci3-coverage strong{font-size:12px}.ci3-coverage p{margin:3px 0 0;color:#789fb4;font-size:10px}
.ci3-btn{border:1px solid rgba(85,189,245,.35);background:#12364d;color:#eefdff;padding:9px 13px;border-radius:9px;font-weight:850;font-size:10px;cursor:pointer}.ci3-btn:disabled{opacity:.5;cursor:wait}
.ci3-tabs{display:flex;gap:6px;margin:18px 0 14px;flex-wrap:wrap}.ci3-tabs button{border:1px solid rgba(126,180,210,.15);background:#0b2030;color:#84a9bd;padding:9px 14px;border-radius:999px;font-weight:850;font-size:11px;cursor:pointer}.ci3-tabs button.active{background:#12364d;color:#fff;border-color:#2b89bd}
.ci3-filters{display:grid;grid-template-columns:minmax(220px,1.3fr) minmax(180px,.9fr) minmax(180px,.9fr) 150px 170px 175px;gap:8px;margin-bottom:10px}.ci3-filters input,.ci3-filters select{min-width:0;width:100%;height:40px;border-radius:10px;border:1px solid rgba(126,180,210,.16);background:#0b2030;color:#eaf5fb;padding:0 11px;outline:none;font-size:10px}
.ci3-filter-row{display:flex;gap:7px;align-items:center;margin-bottom:14px}.ci3-filter-row button{border:0;background:transparent;color:#65c6ff;font-size:10px;font-weight:800;cursor:pointer}.ci3-filter-row span{color:#6d95aa;font-size:10px}
.ci3-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.ci3-card{border:1px solid rgba(126,180,210,.16);border-radius:15px;overflow:hidden;background:#0b2030;cursor:pointer;transition:transform .15s,border-color .15s}.ci3-card:hover{transform:translateY(-2px);border-color:rgba(70,174,232,.5)}
.ci3-img{aspect-ratio:1.2/1;position:relative;background:#102b3c;overflow:hidden}.ci3-img img{width:100%;height:100%;object-fit:cover}.ci3-img-empty{height:100%;display:grid;place-items:center;color:#759aae;font-size:10px}.ci3-format{position:absolute;top:9px;left:9px;padding:5px 7px;border-radius:7px;background:#23506b;color:#c9efff;font-size:8px;font-weight:900}.ci3-status{position:absolute;top:9px;right:9px;padding:5px 7px;border-radius:7px;background:rgba(4,15,23,.82);font-size:8px;font-weight:900;color:#92b6c9}.ci3-status.active{color:#5ee2a0}
.ci3-card-body{padding:12px}.ci3-client{font-size:11px;font-weight:900}.ci3-campaign{font-size:9px;color:#6e99af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.ci3-title{font-size:11px;line-height:1.35;margin:9px 0;color:#dcecf4;min-height:29px}.ci3-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding-top:8px;border-top:1px solid rgba(126,180,210,.11)}.ci3-kpis small{display:block;color:#648da4;font-size:7px;text-transform:uppercase}.ci3-kpis b{font-size:10px}.ci3-author{margin-top:9px;padding-top:8px;border-top:1px solid rgba(126,180,210,.1);display:flex;justify-content:space-between;gap:8px;align-items:center}.ci3-author strong{font-size:9px}.ci3-author span{font-size:8px;color:#6d98ad}.ci3-author .trusted{color:#54dd99}.ci3-author .warn{color:#ffad66}
.ci3-pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:18px}.ci3-pagination button{border:1px solid rgba(126,180,210,.16);background:#0b2030;color:#d8edf7;border-radius:8px;padding:8px 11px;cursor:pointer}.ci3-pagination button:disabled{opacity:.35}.ci3-pagination span{font-size:10px;color:#779eb3}
.ci3-ranking-note{padding:13px 15px;border:1px solid rgba(84,221,153,.18);background:rgba(30,90,65,.12);border-radius:12px;margin-bottom:13px;color:#9fc7b5;font-size:10px;line-height:1.5}
.ci3-podium{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.ci3-rank{border:1px solid rgba(126,180,210,.16);border-radius:15px;background:#0b2030;padding:16px}.ci3-rank.top{border-color:rgba(255,174,81,.35);background:linear-gradient(145deg,rgba(47,42,27,.65),#0b2030)}.ci3-rank-head{display:flex;justify-content:space-between;gap:10px}.ci3-rank-pos{font-size:26px;font-weight:950;color:#ffad66}.ci3-rank h3{margin:2px 0 0;font-size:15px}.ci3-rank-score{text-align:right}.ci3-rank-score b{display:block;font-size:24px}.ci3-rank-score small{color:#6f98ad;font-size:8px}.ci3-rank dl{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:15px 0 0}.ci3-rank dt{font-size:7px;color:#648da4;text-transform:uppercase}.ci3-rank dd{margin:3px 0 0;font-size:11px;font-weight:850}
.ci3-creative-podium{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.ci3-creative-rank{border:1px solid rgba(126,180,210,.16);border-radius:15px;background:#0b2030;overflow:hidden;cursor:pointer}.ci3-creative-rank:first-child{border-color:rgba(255,174,81,.42)}.ci3-creative-rank-media{position:relative;aspect-ratio:1.55/1;background:#102b3c;overflow:hidden}.ci3-creative-rank-media img{width:100%;height:100%;object-fit:cover}.ci3-creative-rank-position{position:absolute;left:10px;top:10px;padding:7px 9px;border-radius:9px;background:rgba(3,14,22,.84);font-size:18px;font-weight:950;color:#ffad66}.ci3-creative-rank-score{position:absolute;right:10px;top:10px;padding:7px 9px;border-radius:9px;background:rgba(3,14,22,.84);font-size:13px;font-weight:950;color:#eef6fb}.ci3-creative-rank-body{padding:13px}.ci3-creative-rank-body h3{font-size:12px;line-height:1.35;margin:5px 0 3px}.ci3-creative-rank-body p{font-size:9px;color:#769db2;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ci3-proof{display:inline-flex;margin-top:9px;padding:5px 7px;border-radius:7px;background:rgba(74,183,245,.11);color:#8dd6ff;font-size:8px;font-weight:900}
.ci3-rank-table{border:1px solid rgba(126,180,210,.14);border-radius:13px;overflow:hidden}.ci3-rank-row{display:grid;grid-template-columns:55px minmax(160px,1fr) 90px 90px 90px 90px 105px;gap:8px;align-items:center;padding:11px 13px;border-top:1px solid rgba(126,180,210,.08);font-size:10px}.ci3-rank-row:first-child{border-top:0}.ci3-rank-row.head{color:#6c94aa;font-size:8px;text-transform:uppercase;background:#0a1d2c}.ci3-rank-row b{font-size:11px}.ci3-rank-row.clickable{cursor:pointer}.ci3-rank-row.clickable:hover{background:#0d2638}.ci3-creative-row{grid-template-columns:50px minmax(230px,1.6fr) minmax(150px,1fr) 70px 85px 85px 85px}.ci3-creative-cell strong{display:block;font-size:10px}.ci3-creative-cell small{display:block;color:#688fa5;font-size:8px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ci3-method{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ci3-method article{border:1px solid rgba(126,180,210,.16);border-radius:14px;background:#0b2030;padding:16px}.ci3-method h3{margin:0 0 7px;font-size:14px}.ci3-method p{margin:0;color:#8cafc1;font-size:10px;line-height:1.6}
.ci3-loading,.ci3-empty{padding:36px;text-align:center;color:#76a4ba;border:1px dashed rgba(126,180,210,.16);border-radius:13px}.ci3-error{padding:12px;border:1px solid rgba(255,91,82,.3);border-radius:10px;background:rgba(255,91,82,.08);color:#ff9b94;margin:12px 0}
.ci3-backdrop{position:fixed;inset:0;z-index:10050;background:rgba(1,9,16,.78);display:flex;justify-content:flex-end}.ci3-drawer{width:min(680px,94vw);height:100%;overflow:auto;background:#081b2a;border-left:1px solid rgba(126,180,210,.18);padding:24px}.ci3-close{float:right;border:0;background:transparent;color:#9bc0d2;font-size:24px;cursor:pointer}.ci3-drawer h2{font-size:22px;margin:5px 36px 3px 0}.ci3-drawer-sub{font-size:10px;color:#789fb4;margin:0 0 14px}.ci3-preview{width:100%;max-height:330px;object-fit:contain;background:#0b2030;border-radius:12px}.ci3-detail-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:12px 0}.ci3-detail-grid div,.ci3-panel{border:1px solid rgba(126,180,210,.14);background:#0b2030;border-radius:10px;padding:11px}.ci3-detail-grid small,.ci3-panel small{display:block;font-size:7px;color:#648da4;text-transform:uppercase}.ci3-detail-grid b{display:block;margin-top:3px;font-size:11px}.ci3-panel{margin-top:8px}.ci3-panel h3{font-size:12px;margin:4px 0 8px}.ci3-panel p{font-size:10px;color:#8cafc1;line-height:1.5;margin:5px 0}.ci3-evidence{padding:8px 0;border-top:1px solid rgba(126,180,210,.1);font-size:9px}.ci3-evidence a{color:#62c6ff}.ci3-warning{color:#ffad66!important}
@media(max-width:1350px){.ci3-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.ci3-filters{grid-template-columns:1.2fr 1fr 1fr 140px 160px}.ci3-filters select:last-child{grid-column:1/-1}}
@media(max-width:1000px){.ci3-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ci3-filters{grid-template-columns:repeat(2,1fr)}.ci3-podium,.ci3-creative-podium,.ci3-method{grid-template-columns:1fr}.ci3-rank-row{grid-template-columns:40px 1fr 70px 70px}.ci3-rank-row>*:nth-child(5),.ci3-rank-row>*:nth-child(6),.ci3-rank-row>*:nth-child(7){display:none}.ci3-creative-row{grid-template-columns:40px 1.6fr 1fr 65px}.ci3-creative-row>*:nth-child(5),.ci3-creative-row>*:nth-child(6),.ci3-creative-row>*:nth-child(7){display:none}}
@media(max-width:650px){.ci3{padding:20px 13px 45px}.ci3-top{flex-direction:column;align-items:flex-start}.ci3 h1{font-size:30px}.ci3-stats{justify-content:flex-start}.ci3-grid,.ci3-filters{grid-template-columns:1fr}.ci3-coverage{align-items:flex-start;flex-direction:column}.ci3-detail-grid{grid-template-columns:repeat(2,1fr)}}
`;

const finite=(v:unknown)=>{const n=Number(v);return v===null||v===undefined||v===""||!Number.isFinite(n)?null:n;};
const money=(v:unknown)=>{const n=finite(v);return n===null?"—":n.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});};
const num=(v:unknown,d=0)=>{const n=finite(v);return n===null?"—":n.toLocaleString("pt-BR",{maximumFractionDigits:d,minimumFractionDigits:d});};
const pct=(v:unknown,d=0)=>{const n=finite(v);return n===null?"—":`${num(n,d)}%`;};
const proofLabel=(v:unknown)=>({VENCEDOR_COMPROVADO:"Vencedor",FORTE_CANDIDATO:"Em ascensão",ACIMA_DA_MEDIA:"Acima da média",EM_FADIGA:"Em fadiga",AMOSTRA_INSUFICIENTE:"Amostra pequena",SEM_DADOS_7D:"Sem entrega 7d"} as Row)[String(v)]||String(v||"—");

export default function CreativeIntelligenceBridge(){
  const [mount,setMount]=useState<HTMLElement|null>(null);
  const [payload,setPayload]=useState<Row>({});
  const [creativeRankPayload,setCreativeRankPayload]=useState<Row>({});
  const [loading,setLoading]=useState(false);
  const [rankLoading,setRankLoading]=useState(false);
  const [error,setError]=useState("");
  const [rankError,setRankError]=useState("");
  const [tab,setTab]=useState<Tab>("catalog");
  const [query,setQuery]=useState("");
  const [client,setClient]=useState("");
  const [campaign,setCampaign]=useState("");
  const [format,setFormat]=useState("");
  const [designer,setDesigner]=useState("");
  const [proof,setProof]=useState("");
  const [status,setStatus]=useState("");
  const [page,setPage]=useState(1);
  const [detail,setDetail]=useState<Row|null>(null);
  const [refreshing,setRefreshing]=useState(false);

  useEffect(()=>{
    const inspect=()=>setMount(document.querySelector("main.rv2-designer") as HTMLElement|null);
    inspect();
    const observer=new MutationObserver(inspect);
    observer.observe(document.body,{childList:true,subtree:true});
    return()=>observer.disconnect();
  },[]);

  useEffect(()=>{
    if(!mount)return;
    mount.classList.add("ci3-active");
    return()=>mount.classList.remove("ci3-active");
  },[mount]);

  useEffect(()=>{setPage(1);},[query,client,campaign,format,designer,proof,status]);
  useEffect(()=>{
    if(client&&campaign&&!((payload.filters?.campaigns||[]) as Row[]).some((x:Row)=>String(x.campaign_id)===campaign&&String(x.client_id)===client))setCampaign("");
  },[client,campaign,payload.filters?.campaigns]);

  const requestUrl=useMemo(()=>{
    const p=new URLSearchParams({page:String(page),page_size:"72"});
    if(query.trim())p.set("q",query.trim());
    if(client)p.set("client",client);
    if(campaign)p.set("campaign",campaign);
    if(format)p.set("format",format);
    if(designer)p.set("designer",designer);
    if(proof)p.set("proof",proof);
    if(status)p.set("status",status);
    return `${API}?${p}`;
  },[page,query,client,campaign,format,designer,proof,status]);

  useEffect(()=>{
    if(!mount)return;
    const timer=window.setTimeout(()=>{
      setLoading(true);setError("");
      authenticatedFetch(requestUrl,{cache:"no-store"})
        .then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);setPayload(b);})
        .catch(e=>setError(e instanceof Error?e.message:"Falha ao carregar catálogo criativo."))
        .finally(()=>setLoading(false));
    },query?250:0);
    return()=>clearTimeout(timer);
  },[mount,requestUrl]);

  useEffect(()=>{
    if(!mount||tab!=="creativeRanking"||creativeRankPayload.generated_at)return;
    setRankLoading(true);setRankError("");
    authenticatedFetch(`${API}?page=1&page_size=96`,{cache:"no-store"})
      .then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);setCreativeRankPayload(b);})
      .catch(e=>setRankError(e instanceof Error?e.message:"Falha ao carregar ranking de criativos."))
      .finally(()=>setRankLoading(false));
  },[mount,tab,creativeRankPayload.generated_at]);

  async function refreshCatalog(){
    setRefreshing(true);setError("");
    try{
      const r=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"refresh_catalog",limit:12})});
      const b=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(b.detail||b.error||"Falha ao atualizar catálogo");
      window.setTimeout(()=>window.location.reload(),1400);
    }catch(e){setError(e instanceof Error?e.message:"Falha ao atualizar catálogo.");}
    finally{setRefreshing(false);}
  }

  const campaigns=useMemo(()=>((payload.filters?.campaigns||[]) as Row[]).filter((x:Row)=>!client||String(x.client_id)===client),[payload.filters?.campaigns,client]);
  const s=payload.summary||{};
  const rows:Row[]=payload.creatives||[];
  const ranking:Row[]=payload.ranking||[];
  const creativeRanking=useMemo(()=>{
    const seen=new Set<string>();
    return ((creativeRankPayload.creatives||[]) as Row[])
      .filter(r=>(finite(r.spend_7d)||0)>0||(finite(r.results_7d)||0)>0)
      .filter(r=>{const key=String(r.creative_id||r.ad_id||"");if(!key||seen.has(key))return false;seen.add(key);return true;})
      .slice(0,50)
      .map((r,i)=>({...r,creative_rank:i+1}));
  },[creativeRankPayload.creatives]);

  const clearFilters=()=>{setQuery("");setClient("");setCampaign("");setFormat("");setDesigner("");setProof("");setStatus("");};
  if(!mount)return null;

  return createPortal(<>
    <style>{STYLE}</style>
    <section className="ci3">
      <header className="ci3-top">
        <div>
          <a className="ci3-back" href="/">← Voltar</a>
          <div className="ci3-kicker">INTELIGÊNCIA CRIATIVA · CATÁLOGO COMPLETO</div>
          <h1>Todos os criativos da operação</h1>
          <p className="ci3-sub">Catálogo, ranking das peças, ranking dos designers e performance dos últimos 7 dias. Tudo limitado ao trabalho feito depois da entrada de cada cliente na agência.</p>
        </div>
        <div className="ci3-stats">
          <Stat value={s.catalog_total||0} label="criativos"/>
          <Stat value={`${s.clients_covered||0}/${s.operational_meta_clients||0}`} label="clientes cobertos"/>
          <Stat value={s.campaigns_covered||0} label="campanhas"/>
          <Stat value={s.trusted_attribution||0} label="autorias confiáveis"/>
        </div>
      </header>

      <div className="ci3-coverage">
        <div><strong>Cobertura Meta: {s.synced_clients||0} de {s.operational_meta_clients||0} clientes sincronizados</strong><p>{s.sync_pending||0} em fila/processando · {s.sync_errors||0} com erro. O catálogo inclui campanhas pausadas e a atualização roda em lotes.</p></div>
        <button className="ci3-btn" disabled={refreshing} onClick={refreshCatalog}>{refreshing?"Enfileirando…":"Atualizar próximo lote"}</button>
      </div>

      <nav className="ci3-tabs">
        <button className={tab==="catalog"?"active":""} onClick={()=>setTab("catalog")}>Todos os criativos</button>
        <button className={tab==="creativeRanking"?"active":""} onClick={()=>setTab("creativeRanking")}>Ranking de criativos</button>
        <button className={tab==="designerRanking"?"active":""} onClick={()=>setTab("designerRanking")}>Ranking de designers</button>
        <button className={tab==="method"?"active":""} onClick={()=>setTab("method")}>Como é calculado</button>
      </nav>

      {error&&<div className="ci3-error">{error}</div>}

      {tab==="catalog"&&<>
        <div className="ci3-filters">
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente, campanha, anúncio…"/>
          <select value={client} onChange={e=>setClient(e.target.value)}><option value="">Todos os clientes</option>{(payload.filters?.clients||[]).map((x:Row)=><option key={x.client_id} value={x.client_id}>{x.client_name}</option>)}</select>
          <select value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">Todas as campanhas</option>{campaigns.map((x:Row)=><option key={`${x.client_id}:${x.campaign_id}`} value={x.campaign_id}>{x.client_name} · {x.campaign_name}</option>)}</select>
          <select value={format} onChange={e=>setFormat(e.target.value)}><option value="">Todos formatos</option>{(payload.filters?.formats||[]).map((x:string)=><option key={x}>{x}</option>)}</select>
          <select value={designer} onChange={e=>setDesigner(e.target.value)}><option value="">Todos designers</option>{(payload.filters?.designers||[]).map((x:string)=><option key={x}>{x}</option>)}</select>
          <select value={proof} onChange={e=>setProof(e.target.value)}><option value="">Toda performance</option>{(payload.filters?.proofs||[]).map((x:string)=><option key={x} value={x}>{proofLabel(x)}</option>)}</select>
        </div>
        <div className="ci3-filter-row"><span>{s.filtered_total||0} resultado(s)</span><button onClick={clearFilters}>Limpar filtros</button><select value={status} onChange={e=>setStatus(e.target.value)} style={{marginLeft:"auto",background:"#0b2030",color:"#d8edf7",border:"1px solid rgba(126,180,210,.16)",borderRadius:8,padding:"6px 8px",fontSize:9}}><option value="">Qualquer status</option><option value="ACTIVE">Ativas</option><option value="PAUSED">Pausadas</option></select></div>
        {loading?<div className="ci3-loading">Cruzando catálogo Meta e ClickUp…</div>:rows.length?<div className="ci3-grid">{rows.map(r=><CreativeCard key={`${r.client_id}:${r.ad_id}`} row={r} onClick={()=>setDetail(r)}/>)}</div>:<div className="ci3-empty">Nenhum criativo encontrado com esses filtros.</div>}
        <div className="ci3-pagination"><button disabled={Number(payload.page||1)<=1||loading} onClick={()=>setPage(p=>Math.max(1,p-1))}>← Anterior</button><span>Página {payload.page||1} de {payload.pages||1}</span><button disabled={Number(payload.page||1)>=Number(payload.pages||1)||loading} onClick={()=>setPage(p=>p+1)}>Próxima →</button></div>
      </>}

      {tab==="creativeRanking"&&<CreativeRanking rows={creativeRanking} loading={rankLoading} error={rankError} onOpen={setDetail}/>} 
      {tab==="designerRanking"&&<DesignerRanking ranking={ranking}/>} 
      {tab==="method"&&<Method payload={payload}/>} 
      {detail&&<Detail row={detail} onClose={()=>setDetail(null)}/>} 
    </section>
  </>,mount);
}

function Stat({value,label}:{value:any;label:string}){return <div className="ci3-stat"><b>{value}</b><span>{label}</span></div>;}

function CreativeCard({row,onClick}:{row:Row;onClick:()=>void}){
  const active=String(row.campaign_status||row.ad_status||"").includes("ACTIVE"),attr=row.attribution||{};
  return <article className="ci3-card" onClick={onClick}>
    <div className="ci3-img">{row.preview_url||row.image_url?<img src={row.preview_url||row.image_url} alt="" loading="lazy"/>:<div className="ci3-img-empty">Prévia indisponível</div>}<span className="ci3-format">{row.creative_format||"—"}</span><span className={`ci3-status ${active?"active":""}`}>{row.campaign_status||row.ad_status||"—"}</span></div>
    <div className="ci3-card-body"><div className="ci3-client">{row.client_name}</div><div className="ci3-campaign" title={row.campaign_name}>{row.campaign_name||"Campanha sem nome"}</div><div className="ci3-title">{row.ad_name||row.creative_name||"Criativo sem nome"}</div><div className="ci3-kpis"><div><small>Resultados</small><b>{num(row.results_7d)}</b></div><div><small>CPR</small><b>{money(row.cost_per_result_7d)}</b></div><div><small>Invest.</small><b>{money(row.spend_7d)}</b></div><div><small>CTR</small><b>{pct(row.ctr_7d,2)}</b></div></div><div className="ci3-author"><div><strong className={attr.trusted?"trusted":attr.level==="FORMATO_INCOMPATIVEL"||attr.level==="CONFLITO"?"warn":""}>{attr.designer||"Autoria não confirmada"}</strong><span> · {attr.level||"NAO_IDENTIFICADO"}</span></div><span>{proofLabel(row.performance?.proof)}</span></div></div>
  </article>;
}

function CreativeRanking({rows,loading,error,onOpen}:{rows:Row[];loading:boolean;error:string;onOpen:(row:Row)=>void}){
  if(error)return <div className="ci3-error">{error}</div>;
  if(loading)return <div className="ci3-loading">Calculando os melhores criativos da operação…</div>;
  if(!rows.length)return <div className="ci3-empty">Ainda não existe amostra suficiente para ranquear criativos.</div>;
  const top=rows.slice(0,3);
  return <>
    <div className="ci3-ranking-note"><b>Ranking de criativos:</b> aqui a peça entra pelo resultado dela, mesmo que a autoria ainda não esteja confirmada. O score compara eficiência, volume, CTR, conversão e tamanho da amostra contra a referência do próprio cliente.</div>
    <div className="ci3-creative-podium">{top.map(r=><article className="ci3-creative-rank" key={`${r.client_id}:${r.ad_id}`} onClick={()=>onOpen(r)}><div className="ci3-creative-rank-media">{r.preview_url||r.image_url?<img src={r.preview_url||r.image_url} alt=""/>:<div className="ci3-img-empty">Prévia indisponível</div>}<span className="ci3-creative-rank-position">#{r.creative_rank}</span><span className="ci3-creative-rank-score">{r.performance?.score||0}/100</span></div><div className="ci3-creative-rank-body"><div className="ci3-client">{r.client_name}</div><h3>{r.ad_name||r.creative_name||"Criativo sem nome"}</h3><p>{r.campaign_name||"Campanha sem nome"}</p><span className="ci3-proof">{proofLabel(r.performance?.proof)}</span></div></article>)}</div>
    <div className="ci3-rank-table"><div className="ci3-rank-row ci3-creative-row head"><span>#</span><span>Criativo</span><span>Cliente / campanha</span><span>Score</span><span>Resultados</span><span>CPR</span><span>Invest.</span></div>{rows.map(r=><div className="ci3-rank-row ci3-creative-row clickable" key={`rank:${r.client_id}:${r.ad_id}`} onClick={()=>onOpen(r)}><b>#{r.creative_rank}</b><div className="ci3-creative-cell"><strong>{r.ad_name||r.creative_name||"Criativo sem nome"}</strong><small>{proofLabel(r.performance?.proof)} · {r.creative_format||"—"}{r.attribution?.designer?` · ${r.attribution.designer}`:""}</small></div><div className="ci3-creative-cell"><strong>{r.client_name}</strong><small>{r.campaign_name||"Campanha sem nome"}</small></div><b>{r.performance?.score||0}</b><span>{num(r.results_7d)}</span><span>{money(r.cost_per_result_7d)}</span><span>{money(r.spend_7d)}</span></div>)}</div>
  </>;
}

function DesignerRanking({ranking}:{ranking:Row[]}){
  const ranked=ranking.filter(r=>r.pieces>0),top=ranked.slice(0,3);
  return <>
    <div className="ci3-ranking-note"><b>Ranking de designers:</b> diferente do ranking das peças, aqui só entram criativos cuja autoria seja <b>FORTE ou CONFIRMADA</b>. Assim o resultado do designer não recebe crédito de uma peça que não conseguimos provar que foi feita por ele.</div>
    {top.length?<div className="ci3-podium">{top.map(r=><RankCard key={r.designer} row={r} top/>)}</div>:<div className="ci3-empty">Ainda não existe amostra de autoria forte suficiente para ranquear designers.</div>}
    <div className="ci3-rank-table"><div className="ci3-rank-row head"><span>#</span><span>Designer</span><span>Score</span><span>Peças</span><span>Vencedores</span><span>Resultados</span><span>Confiança</span></div>{ranking.map(r=><div className="ci3-rank-row" key={r.designer}><b>{r.rank?`#${r.rank}`:"—"}</b><b>{r.designer}</b><span>{r.ranking_score||0}</span><span>{r.pieces||0}</span><span>{r.proven||0}</span><span>{num(r.results)}</span><span>{r.ranking_confidence}</span></div>)}</div>
  </>;
}

function RankCard({row,top}:{row:Row;top?:boolean}){return <article className={`ci3-rank ${top?"top":""}`}><div className="ci3-rank-head"><div><div className="ci3-rank-pos">#{row.rank}</div><h3>{row.designer}</h3></div><div className="ci3-rank-score"><b>{row.ranking_score}</b><small>score / 100</small></div></div><dl><div><dt>Peças</dt><dd>{row.pieces}</dd></div><div><dt>Vencedores</dt><dd>{row.proven}</dd></div><div><dt>Taxa</dt><dd>{pct(row.winner_rate)}</dd></div><div><dt>Resultados</dt><dd>{num(row.results)}</dd></div></dl></article>;}

function Method({payload}:{payload:Row}){return <div className="ci3-method"><article><h3>Ranking de criativos</h3><p>A peça é avaliada pela performance dos últimos 7 dias usando eficiência, volume, CTR, conversão e força da amostra em relação à referência do próprio cliente. <b>Não precisa ter autoria confirmada</b> para aparecer nesse ranking.</p></article><article><h3>Ranking de designers</h3><p>{payload.methodology?.ranking||""} Aqui a autoria precisa ser FORTE ou CONFIRMADA, porque o objetivo é medir o trabalho da pessoa e não somente a peça.</p></article><article><h3>Autoria: mais rígida</h3><p>{payload.methodology?.attribution||""} Tasks chamadas <b>Campanha</b> ou <b>Ajuste na campanha</b> não dão autoria ao designer.</p></article><article><h3>Corte pós-entrada</h3><p>{payload.methodology?.catalog||""} Isso impede que criativos antigos do cliente entrem no catálogo ou em qualquer ranking como se fossem produção da agência.</p></article></div>;}

function Detail({row,onClose}:{row:Row;onClose:()=>void}){
  const attr=row.attribution||{};
  return <div className="ci3-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><aside className="ci3-drawer"><button className="ci3-close" onClick={onClose}>×</button><small>{row.client_name} · {row.creative_format}</small><h2>{row.ad_name||row.creative_name||"Criativo"}</h2><p className="ci3-drawer-sub">{row.campaign_name} · {row.adset_name||"Conjunto não identificado"}</p>{row.preview_url||row.image_url?<img className="ci3-preview" src={row.preview_url||row.image_url} alt=""/>:null}<div className="ci3-detail-grid"><div><small>Resultados 7d</small><b>{num(row.results_7d)}</b></div><div><small>CPR 7d</small><b>{money(row.cost_per_result_7d)}</b></div><div><small>Investimento</small><b>{money(row.spend_7d)}</b></div><div><small>CTR</small><b>{pct(row.ctr_7d,2)}</b></div></div><div className="ci3-panel"><small>Autoria</small><h3>{attr.designer||"Não confirmada"} · {attr.level||"NAO_IDENTIFICADO"}</h3><p>Confiança: {attr.confidence||0}% · Método: {attr.method||"sem evidência suficiente"}</p>{(attr.warnings||[]).map((w:string,i:number)=><p className="ci3-warning" key={i}>⚠ {w}</p>)}{(attr.evidences||[]).map((e:Row,i:number)=><div className="ci3-evidence" key={i}><b>{e.source}</b> · {e.label}{e.url?<><br/><a href={e.url} target="_blank" rel="noreferrer">Abrir evidência</a></>:null}</div>)}</div><div className="ci3-panel"><small>Performance</small><h3>{proofLabel(row.performance?.proof)} · score {row.performance?.score||0}/100</h3>{(row.performance?.reasons||[]).map((x:string,i:number)=><p key={i}>{x}</p>)}</div><div className="ci3-panel"><small>Meta</small><p>Campanha: {row.campaign_status||"—"} · Anúncio: {row.ad_status||"—"}</p><p>ID do anúncio: {row.ad_id} · ID do criativo: {row.creative_id||"—"}</p></div></aside></div>;
}
