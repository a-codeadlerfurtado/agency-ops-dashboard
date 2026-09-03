"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;
type Tab = "overview" | "products" | "personas" | "strategy" | "materials";
type DetailTab = "strategy" | "briefing" | "history";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-briefing-staff-api`;
const STRATEGY_API = `${SUPABASE_URL}/functions/v1/agency-ops-briefing-strategy-api`;
const ALLOWED_PEOPLE = new Set(["Adler Furtado", "Joel Antoniete", "Gustavo Lima"]);

const STYLE = `
.brief-staff-nav::before{content:""!important;width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;background:currentColor!important;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 3.8h10.5L19 7.3V20H5zM15.5 3.8v3.5H19M8 11h8M8 14.5h8M8 18h5' fill='none' stroke='black' stroke-width='1.8' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 3.8h10.5L19 7.3V20H5zM15.5 3.8v3.5H19M8 11h8M8 14.5h8M8 18h5' fill='none' stroke='black' stroke-width='1.8' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important;}
.brief-staff-nav{display:flex!important;align-items:center!important;gap:12px!important;order:150!important}
.brief-staff-shell{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147481500;background:#090e12;color:#edf4f8;overflow:auto;padding:24px 28px 48px}
.brief-staff-wrap{max-width:1480px;margin:0 auto}
.brief-staff-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}
.brief-staff-kicker{font:900 11px/1 Inter,sans-serif;letter-spacing:.12em;color:#ff9253;text-transform:uppercase}
.brief-staff-head h1{margin:5px 0 5px;font:800 30px/1.05 Inter Tight,Inter,sans-serif;letter-spacing:-.035em}
.brief-staff-sub{color:#97a6b1;font-size:13px;max-width:760px;line-height:1.45}
.brief-staff-close,.brief-staff-btn{border:1px solid #34414b;background:#141b20;color:#eaf1f5;border-radius:10px;padding:9px 12px;font:750 12px Inter,sans-serif;cursor:pointer}
.brief-staff-btn:hover,.brief-staff-close:hover{border-color:#5b7180;background:#182128}.brief-staff-btn.primary{border-color:#ff7a2f;background:#ff7a2f;color:#fff}.brief-staff-btn:disabled{opacity:.45;cursor:not-allowed}
.brief-staff-picker{display:grid;grid-template-columns:minmax(280px,1fr) auto;gap:10px;align-items:end;padding:14px;border:1px solid #293740;background:#0e151a;border-radius:14px;margin-bottom:14px}
.brief-staff-field label{display:block;color:#91a1ac;font-size:10px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}.brief-staff-field select,.brief-staff-field input{width:100%;border:1px solid #34434d;background:#0a1014;color:#eef5f8;border-radius:10px;padding:10px 12px;outline:none;font:600 13px Inter,sans-serif}.brief-staff-field select:focus,.brief-staff-field input:focus{border-color:#65bdf5;box-shadow:0 0 0 2px rgba(101,189,245,.08)}
.brief-staff-clientbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #293740;background:#10171c;border-radius:12px;margin-bottom:10px}.brief-staff-clientname{font:800 15px Inter,sans-serif}.brief-staff-clientmeta{font-size:11px;color:#8f9da7;margin-top:3px}.brief-staff-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.brief-staff-tab{border:1px solid #2b3942;background:#0e151a;color:#aebac2;border-radius:999px;padding:7px 11px;font:750 11px Inter,sans-serif;cursor:pointer}.brief-staff-tab.active{border-color:#ff7a2f;background:rgba(255,122,47,.12);color:#ffc09a}
.brief-staff-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.brief-staff-stat{border:1px solid #293740;background:#0f161b;border-radius:13px;padding:14px}.brief-staff-stat small{display:block;color:#82919c;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.07em}.brief-staff-stat b{display:block;font:800 22px/1 Inter Tight,Inter,sans-serif;margin-top:7px}.brief-staff-stat span{display:block;color:#9ba9b2;font-size:10px;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brief-staff-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}.brief-staff-card{border:1px solid #293740;background:linear-gradient(180deg,#121a20,#0f151a);border-radius:13px;padding:14px;color:inherit;text-align:left;min-height:132px;display:flex;flex-direction:column;gap:8px}.brief-staff-card.clickable{cursor:pointer}.brief-staff-card.clickable:hover{border-color:#506675;background:#151f25}.brief-staff-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.brief-staff-type{font:850 9px/1 Inter,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:#79c9ff}.brief-staff-card h3{margin:0;font:780 15px/1.2 Inter,sans-serif}.brief-staff-muted{color:#8e9ca6;font-size:11px;line-height:1.45}.brief-staff-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid #35434c;background:#0a1014;border-radius:999px;padding:4px 7px;color:#abb7bf;font-size:9px;font-weight:800;white-space:nowrap}.brief-staff-pill.ok{border-color:#23654f;color:#62d6a7;background:rgba(38,151,112,.08)}.brief-staff-pill.warn{border-color:#73431f;color:#ffab6d;background:rgba(255,122,47,.07)}
.brief-staff-empty{border:1px dashed #35434d;border-radius:14px;padding:28px;text-align:center;color:#91a0aa;font-size:12px}.brief-staff-section-title{display:flex;justify-content:space-between;align-items:end;gap:12px;margin:14px 0 9px}.brief-staff-section-title h2{margin:0;font:800 17px Inter,sans-serif}.brief-staff-section-title span{color:#85949e;font-size:10px}
.brief-staff-drive{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;border:1px solid #2c3a43;background:#0e151a;border-radius:13px;padding:14px;margin-bottom:12px}.brief-staff-drive b{display:block;font-size:13px}.brief-staff-drive code{display:block;color:#81919b;font-size:10px;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brief-staff-upload-note{border:1px solid #3b4650;background:#10161b;border-radius:13px;padding:14px;margin-bottom:12px}.brief-staff-upload-note strong{font-size:12px}.brief-staff-upload-note p{margin:5px 0 0;color:#95a3ad;font-size:11px;line-height:1.5}
.brief-staff-file{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border-bottom:1px solid #223039;padding:10px 2px}.brief-staff-file:last-child{border-bottom:0}.brief-staff-file b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.brief-staff-file span{display:block;color:#82919b;font-size:10px;margin-top:3px}.brief-staff-file a{font-size:10px;color:#83cfff;text-decoration:none}.brief-staff-file a:hover{text-decoration:underline}
.brief-staff-error{border:1px solid #6d3030;background:rgba(125,35,35,.12);border-radius:11px;padding:11px 12px;color:#ffaaaa;font-size:11px;margin-bottom:10px}
.brief-staff-loading{padding:28px;text-align:center;color:#94a3ad;font-size:12px}.brief-staff-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff7a2f;margin-right:7px;animation:briefpulse 1s ease-in-out infinite}@keyframes briefpulse{50%{opacity:.35;transform:scale(.72)}}
.brief-staff-drawer-bg{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147482500;background:rgba(0,0,0,.5);display:flex;justify-content:flex-end}.brief-staff-drawer{width:min(720px,94vw);height:100%;background:#0c1216;border-left:1px solid #33414b;overflow:auto;padding:20px;box-shadow:-20px 0 60px rgba(0,0,0,.35)}.brief-staff-drawer-head{position:sticky;top:-20px;background:#0c1216;border-bottom:1px solid #28343b;padding:20px 0 14px;z-index:2;display:flex;justify-content:space-between;gap:12px}.brief-staff-drawer h2{margin:4px 0 3px;font:800 22px/1.15 Inter Tight,Inter,sans-serif}.brief-staff-answer{padding:12px 0;border-bottom:1px solid #223039}.brief-staff-answer:last-child{border-bottom:0}.brief-staff-answer label{display:block;color:#96a5af;font-size:10px;font-weight:800;margin-bottom:5px}.brief-staff-answer div{font-size:12px;line-height:1.55;white-space:pre-wrap;color:#e0e7eb}.brief-staff-answer small{display:block;color:#71818b;font-size:9px;margin-top:5px}.brief-staff-section-chip{margin:16px 0 2px;color:#ff9b61;font:900 9px Inter,sans-serif;letter-spacing:.1em;text-transform:uppercase}
.brief-staff-strategy{display:grid;gap:12px}.brief-staff-strategy-hero{border:1px solid #2d4553;border-radius:14px;padding:16px;background:linear-gradient(120deg,rgba(18,93,132,.16),rgba(13,21,27,.95) 55%)}.brief-staff-strategy-hero h3{margin:4px 0 8px;font:800 18px/1.2 Inter,sans-serif}.brief-staff-strategy-hero p{margin:0;color:#c3d0d8;font-size:12px;line-height:1.6;white-space:pre-wrap}.brief-staff-strategy-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.brief-staff-copy{border:1px solid #2d3d47;background:#10191f;border-radius:13px;padding:13px}.brief-staff-copy-head{display:flex;justify-content:space-between;gap:8px;align-items:start}.brief-staff-copy h4{margin:0;font:800 13px/1.3 Inter,sans-serif}.brief-staff-copy p{margin:9px 0 0;color:#c3d1d9;font-size:11px;line-height:1.55;white-space:pre-wrap}.brief-staff-copy strong{display:block;margin-top:9px;color:#eff6f8;font-size:11px}.brief-staff-copy small{display:block;margin-top:5px;color:#8b9ca7;font-size:10px;line-height:1.45}.brief-staff-copy-btn{border:1px solid #3a5666;background:#112331;color:#a9ddfa;border-radius:7px;padding:5px 7px;font:800 10px Inter,sans-serif;cursor:pointer}.brief-staff-plan{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.brief-staff-plan-item{border:1px solid #293a43;background:#0e151a;border-radius:10px;padding:11px}.brief-staff-plan-item small{display:block;color:#84bfea;font-size:9px;font-weight:850;letter-spacing:.07em;text-transform:uppercase}.brief-staff-plan-item div{margin-top:5px;color:#d9e3e9;font-size:11px;line-height:1.45;white-space:pre-wrap}.brief-staff-benchmark{border:1px solid #26485a;background:rgba(28,95,132,.11);border-radius:10px;padding:10px 12px;color:#b8dbe9;font-size:11px;line-height:1.45}.brief-staff-map-wrap{overflow:auto;border:1px solid #2b3a44;border-radius:13px}.brief-staff-map{width:100%;min-width:620px;border-collapse:collapse;background:#0e151a}.brief-staff-map th,.brief-staff-map td{padding:11px;border-bottom:1px solid #23313a;border-right:1px solid #23313a;text-align:left;font-size:11px}.brief-staff-map th{color:#9fcff0;background:#101c24;font-size:10px;text-transform:uppercase;letter-spacing:.05em}.brief-staff-map td:first-child{font-weight:750;color:#eff5f7;min-width:170px}.brief-staff-map-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#44525a}.brief-staff-map-dot.linked{background:#63d6a4;box-shadow:0 0 0 3px rgba(99,214,164,.12)}.brief-staff-history{display:grid;gap:0;border:1px solid #293943;border-radius:12px;overflow:hidden}.brief-staff-history-item{padding:12px;border-bottom:1px solid #24323b}.brief-staff-history-item:last-child{border-bottom:0}.brief-staff-history-item b{display:block;font-size:12px}.brief-staff-history-item p{margin:4px 0 0;color:#a6b5be;font-size:11px;line-height:1.45}.brief-staff-history-item small{display:block;margin-top:5px;color:#71828e;font-size:10px}
@media(max-width:850px){.brief-staff-shell{left:58px;padding:18px 14px 36px}.brief-staff-drawer-bg{left:58px}.brief-staff-head{flex-direction:column}.brief-staff-picker{grid-template-columns:1fr}.brief-staff-stats{grid-template-columns:1fr 1fr}.brief-staff-drive{grid-template-columns:1fr}.brief-staff-drawer{width:100%}}
`;

function fmtDate(value: unknown) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value))); }
  catch { return String(value); }
}
function fmtBytes(value: unknown) {
  const n = Number(value || 0); if (!n) return "";
  const u = ["B","KB","MB","GB","TB"]; let x=n,i=0; while(x>=1024&&i<u.length-1){x/=1024;i++;}
  return `${x>=10||i===0?x.toFixed(0):x.toFixed(1)} ${u[i]}`;
}
function valueText(answer: Row | undefined) {
  if (!answer) return "Não respondido";
  const v = answer.value_json ?? answer.value_text;
  if (v === null || v === undefined || v === "") return "Não respondido";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function statusClass(value: unknown) {
  const v=String(value||"").toUpperCase(); return v.includes("COMPLE")||v.includes("COMPLETE") ? "ok" : "warn";
}
function summaryText(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(summaryText).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value as Row).map(summaryText).filter(Boolean).join("\n");
  return String(value);
}
function titleCase(value: string) {
  return value.replace(/[_-]+/g," ").replace(/\b\w/g,(letter)=>letter.toUpperCase());
}
function planEntries(value: unknown, prefix = ""): Array<[string,string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [[prefix, summaryText(value)]] : [];
  const rows: Array<[string,string]> = [];
  for (const [key, nested] of Object.entries(value as Row)) {
    const label = prefix ? `${prefix} · ${titleCase(key)}` : titleCase(key);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) rows.push(...planEntries(nested,label));
    else { const text = summaryText(nested); if (text) rows.push([label,text]); }
  }
  return rows;
}

export default function BriefingStaffBridge({ session: _session }: { session: Session }) {
  const [authorized,setAuthorized]=useState<boolean|null>(null);
  const [open,setOpen]=useState(false);
  const [boot,setBoot]=useState<Row|null>(null);
  const [clientId,setClientId]=useState("");
  const [clientData,setClientData]=useState<Row|null>(null);
  const [tab,setTab]=useState<Tab>("overview");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [detail,setDetail]=useState<Row|null>(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detailTab,setDetailTab]=useState<DetailTab>("strategy");
  const [strategy,setStrategy]=useState<Row|null>(null);
  const [strategyLoading,setStrategyLoading]=useState(false);
  const [relationMap,setRelationMap]=useState<Record<string,Set<string>>>({});
  const [mapLoading,setMapLoading]=useState(false);
  const buttonRef=useRef<HTMLButtonElement|null>(null);

  const call=useCallback(async(params:Record<string,string>)=>{
    const u=new URL(API); Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
    const r=await authenticatedFetch(u,{cache:"no-store"});
    const body=await r.json().catch(()=>({})); if(!r.ok) throw new Error(body.detail||body.error||`API ${r.status}`); return body;
  },[]);

  const loadClient=useCallback(async(id:string, nextTab?:Tab)=>{
    if(!id) return; setLoading(true); setError(""); setDetail(null);
    try{const body=await call({action:"client",client_id:id}); setClientData(body); setClientId(id); if(nextTab)setTab(nextTab);}
    catch(e){setError(e instanceof Error?e.message:"Falha ao carregar cliente");}
    finally{setLoading(false);}
  },[call]);

  const loadStrategy=useCallback(async(type:"PRODUCT"|"PERSONA",id:string,forClient=clientId)=>{
    if(!forClient) return;
    setStrategyLoading(true); setStrategy(null);
    try{
      const r=await authenticatedFetch(STRATEGY_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({client_id:forClient,type,id}),cache:"no-store"});
      const body=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(body.detail||body.error||`API ${r.status}`);
      setStrategy(body);
    }catch(e){setStrategy({error:e instanceof Error?e.message:"Não foi possível gerar a estratégia agora."});}
    finally{setStrategyLoading(false);}
  },[clientId]);

  const openEntity=useCallback(async(type:"PRODUCT"|"PERSONA",id:string)=>{
    setDetailLoading(true); setError(""); setDetailTab("strategy"); setStrategy(null);
    try{
      const body=await call({action:"entity",type,id});
      setDetail(body);
      void loadStrategy(type,id);
    }
    catch(e){setError(e instanceof Error?e.message:"Falha ao carregar briefing");}
    finally{setDetailLoading(false);}
  },[call,loadStrategy]);

  useEffect(()=>{
    let active=true;
    call({action:"bootstrap"}).then((body)=>{
      if(!active)return;
      const person=String(body.person||""),role=String(body.role||"").toUpperCase();
      const allowed=role==="GT"||ALLOWED_PEOPLE.has(person);
      setAuthorized(allowed); if(allowed)setBoot(body);
    }).catch(()=>{if(active)setAuthorized(false)});
    return()=>{active=false};
  },[call]);

  useEffect(()=>{
    if(!authorized)return;
    let cancelled=false, frame=0;
    const ensure=()=>{
      if(cancelled)return;
      const container=document.querySelector<HTMLElement>(".side-nav-items");
      if(!container){if(frame++<90)requestAnimationFrame(ensure);return;}
      let b=container.querySelector<HTMLButtonElement>("[data-briefing-staff-nav]");
      if(!b){b=document.createElement("button");b.type="button";b.dataset.briefingStaffNav="true";b.className="brief-staff-nav";b.title="Briefing Hub";b.textContent="Briefing Hub";b.style.order="150";container.appendChild(b);}
      const click=(ev:Event)=>{ev.preventDefault();ev.stopPropagation();setOpen(true)};
      b.addEventListener("click",click); buttonRef.current=b;
      return()=>b?.removeEventListener("click",click);
    };
    const cleanup=ensure();
    return()=>{cancelled=true; if(typeof cleanup==="function")cleanup(); document.querySelector("[data-briefing-staff-nav]")?.remove(); buttonRef.current=null;};
  },[authorized]);

  useEffect(()=>{buttonRef.current?.classList.toggle("active",open)},[open]);

  useEffect(()=>{
    if(!authorized)return;
    const p=new URLSearchParams(location.search); if(p.get("briefings")!=="1")return;
    const id=p.get("client_id")||""; const t=(p.get("tab")||"") as Tab;
    setOpen(true); if(id) void loadClient(id,t==="materials"?"materials":undefined);
    const et=String(p.get("entity_type")||"").toUpperCase(); const eid=p.get("entity_id")||"";
    if(eid&&(et==="PRODUCT"||et==="PERSONA")) window.setTimeout(()=>void openEntity(et as "PRODUCT"|"PERSONA",eid),350);
  },[authorized,loadClient,openEntity]);

  useEffect(()=>{
    const onClick=(ev:Event)=>{
      if(!open)return;
      const el=ev.target instanceof Element?ev.target.closest(".side-nav-items > button,.side-nav-items > a"):null;
      if(el&&!el.hasAttribute("data-briefing-staff-nav")&&!el.classList.contains("sidebar-ia-group-title"))setOpen(false);
    };
    document.addEventListener("click",onClick,true); return()=>document.removeEventListener("click",onClick,true);
  },[open]);

  useEffect(()=>{
    if(!open)return; const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape"){if(detail)setDetail(null);else setOpen(false)}};
    document.addEventListener("keydown",onKey);return()=>document.removeEventListener("keydown",onKey);
  },[open,detail]);

  const clients=boot?.clients||[];
  const selected=clientData?.client;
  const products=clientData?.products||[];
  const personas=clientData?.personas||[];
  const materials=clientData?.materials||[];
  const drive=clientData?.drive||clients.find((c:Row)=>String(c.id)===clientId)?.drive||null;
  const completeProducts=products.filter((x:Row)=>statusClass(x.completion_status)==="ok").length;
  const completePersonas=personas.filter((x:Row)=>statusClass(x.completion_status)==="ok").length;

  const answersByKey=useMemo(()=>new Map((detail?.answers||[]).map((a:Row)=>[String(a.question_key),a])),[detail]);
  const questions=detail?.questions||[];
  const history=detail?.history||[];
  const strategySummary=summaryText(strategy?.strategic_summary||strategy?.summary||strategy?.insight);
  const copyVariants=Array.isArray(strategy?.copies)?strategy.copies:[];
  const plan=planEntries(strategy?.media_plan||strategy?.plan||strategy?.campaign_plan);
  const loadRelationMap=useCallback(async()=>{
    if(!products.length||!personas.length) return;
    setMapLoading(true);
    try{
      const rows=await Promise.all(products.map(async(product:Row)=>({id:String(product.id),detail:await call({action:"entity",type:"PRODUCT",id:String(product.id)})})));
      const next:Record<string,Set<string>>={};
      for(const row of rows){
        const linked=new Set<string>();
        for(const link of row.detail?.links||[]){
          const raw=String(link.id||link.entity_id||link.persona_id||link.linked_entity_id||"");
          const byId=personas.find((persona:Row)=>String(persona.id)===raw);
          const byName=personas.find((persona:Row)=>String(persona.name||"").trim().toLowerCase()===String(link.name||link.entity_name||"").trim().toLowerCase());
          if(byId) linked.add(String(byId.id));
          if(byName) linked.add(String(byName.id));
        }
        next[row.id]=linked;
      }
      setRelationMap(next);
    }catch(e){setError(e instanceof Error?e.message:"Não foi possível montar o mapa Produto × Persona.");}
    finally{setMapLoading(false);}
  },[call,products,personas]);
  useEffect(()=>{if(tab==="strategy"&&selected)void loadRelationMap();},[tab,selected,loadRelationMap]);

  if(authorized!==true) return <style dangerouslySetInnerHTML={{__html:STYLE}}/>;
  if(typeof document==="undefined")return <style dangerouslySetInnerHTML={{__html:STYLE}}/>;

  return <>
    <style dangerouslySetInnerHTML={{__html:STYLE}}/>
    {open&&createPortal(<main className="brief-staff-shell" aria-label="Briefing Hub interno">
      <div className="brief-staff-wrap">
        <header className="brief-staff-head">
          <div><div className="brief-staff-kicker">Briefing Hub · Operação</div><h1>Briefings e materiais dos clientes</h1><div className="brief-staff-sub">Consulta central de Produto, Persona e materiais usando a mesma sessão do dashboard. O acesso aqui não amplia as permissões das outras áreas do sistema.</div></div>
          <button className="brief-staff-close" onClick={()=>setOpen(false)}>Fechar</button>
        </header>
        {error&&<div className="brief-staff-error">{error}</div>}
        <section className="brief-staff-picker">
          <div className="brief-staff-field"><label>Cliente</label><select value={clientId} onChange={(e)=>void loadClient(e.target.value)}><option value="">Selecione um cliente…</option>{clients.map((c:Row)=><option key={c.id} value={c.id}>{c.display_name} · {c.lifecycle}</option>)}</select></div>
          <button className="brief-staff-btn" disabled={!clientId||loading} onClick={()=>void loadClient(clientId)}>{loading?"Atualizando…":"Atualizar"}</button>
        </section>
        {loading&&!clientData&&<div className="brief-staff-loading"><span className="brief-staff-dot"/>Carregando Briefing Hub…</div>}
        {!selected&&!loading&&<div className="brief-staff-empty">Selecione um cliente para abrir seus briefings, personas e materiais.</div>}
        {selected&&<>
          <div className="brief-staff-clientbar"><div><div className="brief-staff-clientname">{selected.display_name}</div><div className="brief-staff-clientmeta">{selected.lifecycle} · GT: {selected.gt_owner||"não definido"} · CS: {selected.cs_owner||"não definido"}</div></div>{drive?.external_id&&<a className="brief-staff-btn" href={`https://drive.google.com/drive/folders/${drive.external_id}`} target="_blank" rel="noreferrer">Abrir Drive ↗</a>}</div>
          <nav className="brief-staff-tabs" aria-label="Áreas do Briefing Hub">{([['overview','Resumo'],['products','Produtos'],['personas','Personas'],['strategy','Estratégia'],['materials','Materiais']] as [Tab,string][]).map(([k,label])=><button key={k} className={`brief-staff-tab${tab===k?' active':''}`} onClick={()=>setTab(k)}>{label}</button>)}</nav>

          {tab==="overview"&&<>
            <div className="brief-staff-stats"><div className="brief-staff-stat"><small>Produtos</small><b>{products.length}</b><span>{completeProducts} completos</span></div><div className="brief-staff-stat"><small>Personas</small><b>{personas.length}</b><span>{completePersonas} completas</span></div><div className="brief-staff-stat"><small>Materiais</small><b>{materials.length}</b><span>registros recentes</span></div><div className="brief-staff-stat"><small>Drive</small><b>{drive?.external_id?'OK':'—'}</b><span>{drive?.external_name||'pasta não mapeada'}</span></div></div>
            <div className="brief-staff-section-title"><h2>Atualizados recentemente</h2><span>Clique para visualizar respostas</span></div>
            <div className="brief-staff-grid">{[...products.map((x:Row)=>({...x,_type:'PRODUCT'})),...personas.map((x:Row)=>({...x,_type:'PERSONA'}))].sort((a:Row,b:Row)=>new Date(b.updated_at||0).getTime()-new Date(a.updated_at||0).getTime()).slice(0,8).map((x:Row)=><button key={`${x._type}:${x.id}`} className="brief-staff-card clickable" onClick={()=>void openEntity(x._type,x.id)}><div className="brief-staff-card-top"><span className="brief-staff-type">{x._type==='PRODUCT'?'Produto':'Persona'}</span><span className={`brief-staff-pill ${statusClass(x.completion_status)}`}>{String(x.completion_status||'Pendente').replaceAll('_',' ')}</span></div><h3>{x.name||'Sem nome'}</h3><div className="brief-staff-muted">Atualizado {fmtDate(x.updated_at)}</div></button>)}</div>
          </>}

          {tab==="products"&&<><div className="brief-staff-section-title"><h2>Briefings de produto</h2><span>{products.length} produtos</span></div>{products.length?<div className="brief-staff-grid">{products.map((x:Row)=><button key={x.id} className="brief-staff-card clickable" onClick={()=>void openEntity('PRODUCT',x.id)}><div className="brief-staff-card-top"><span className="brief-staff-type">Produto</span><span className={`brief-staff-pill ${statusClass(x.completion_status)}`}>{String(x.completion_status||'Pendente').replaceAll('_',' ')}</span></div><h3>{x.name||'Sem nome'}</h3><div className="brief-staff-muted">Briefing: {String(x.briefing_status||'—').replaceAll('_',' ')}<br/>Atualizado {fmtDate(x.updated_at)}</div></button>)}</div>:<div className="brief-staff-empty">Nenhum produto cadastrado.</div>}</>}

          {tab==="personas"&&<><div className="brief-staff-section-title"><h2>Personas</h2><span>{personas.length} personas</span></div>{personas.length?<div className="brief-staff-grid">{personas.map((x:Row)=><button key={x.id} className="brief-staff-card clickable" onClick={()=>void openEntity('PERSONA',x.id)}><div className="brief-staff-card-top"><span className="brief-staff-type">Persona</span><span className={`brief-staff-pill ${statusClass(x.completion_status)}`}>{String(x.completion_status||'Pendente').replaceAll('_',' ')}</span></div><h3>{x.name||'Sem nome'}</h3><div className="brief-staff-muted">Atualizada {fmtDate(x.updated_at)}</div></button>)}</div>:<div className="brief-staff-empty">Nenhuma persona cadastrada.</div>}</>}

          {tab==="strategy"&&<>
            <div className="brief-staff-section-title"><h2>Mapa Produto × Persona</h2><span>{mapLoading?"Lendo vínculos…":"Relações que já estão no briefing"}</span></div>
            {!products.length||!personas.length?<div className="brief-staff-empty">Cadastre ao menos um produto e uma persona para visualizar o mapa estratégico.</div>:<div className="brief-staff-map-wrap"><table className="brief-staff-map"><thead><tr><th>Produto</th>{personas.map((persona:Row)=><th key={persona.id}>{persona.name||"Sem nome"}</th>)}</tr></thead><tbody>{products.map((product:Row)=><tr key={product.id}><td>{product.name||"Sem nome"}</td>{personas.map((persona:Row)=><td key={persona.id} title={relationMap[String(product.id)]?.has(String(persona.id))?"Vinculada":"Sem vínculo"}><span className={`brief-staff-map-dot ${relationMap[String(product.id)]?.has(String(persona.id))?"linked":""}`}/></td>)}</tr>)}</tbody></table></div>}
            <div className="brief-staff-benchmark">O mapa é montado a partir dos vínculos salvos no próprio Briefing Hub. Estratégia, cópias e configurações de campanha aparecem ao abrir um Produto ou Persona.</div>
          </>}

          {tab==="materials"&&<><div className="brief-staff-drive"><div><b>{drive?.external_name||'Pasta do Drive'}</b><code>{drive?.external_id||'Este cliente ainda não possui pasta DRIVE mapeada.'}</code></div>{drive?.external_id&&<a className="brief-staff-btn primary" href={`https://drive.google.com/drive/folders/${drive.external_id}`} target="_blank" rel="noreferrer">Abrir pasta</a>}</div><div className="brief-staff-upload-note"><strong>Materiais do cliente</strong><p>Os arquivos permanecem no Google Drive; o dashboard guarda somente metadados para histórico e notificações. A seleção de subpasta e o upload resumível serão habilitados aqui pelo mesmo bridge de Drive usado no portal do cliente.</p></div><div className="brief-staff-section-title"><h2>Arquivos registrados</h2><span>{materials.length} recentes</span></div>{materials.length?<div className="brief-staff-card">{materials.map((x:Row)=><div className="brief-staff-file" key={x.id}><div><b>{x.file_name}</b><span>{x.file_kind||'ARQUIVO'} {fmtBytes(x.file_size_bytes)?`· ${fmtBytes(x.file_size_bytes)}`:''} · {fmtDate(x.drive_uploaded_at||x.detected_at)}</span></div>{x.drive_file_id&&<a href={`https://drive.google.com/open?id=${x.drive_file_id}`} target="_blank" rel="noreferrer">Abrir ↗</a>}</div>)}</div>:<div className="brief-staff-empty">Nenhum material indexado para este cliente ainda.</div>}</>}
        </>}
      </div>
    </main>,document.body)}
    {detail&&createPortal(<div className="brief-staff-drawer-bg" onMouseDown={(e)=>{if(e.target===e.currentTarget)setDetail(null)}}><aside className="brief-staff-drawer"><div className="brief-staff-drawer-head"><div><div className="brief-staff-kicker">{detail.type==='PRODUCT'?'Produto':'Persona'}</div><h2>{detail.entity?.name||'Briefing'}</h2><div className="brief-staff-muted">{questions.length} perguntas · atualizado {fmtDate(detail.entity?.updated_at)}</div></div><button className="brief-staff-close" onClick={()=>setDetail(null)}>Fechar</button></div>
      <nav className="brief-staff-tabs" aria-label="Detalhes do briefing"><button className={`brief-staff-tab${detailTab==="strategy"?" active":""}`} onClick={()=>setDetailTab("strategy")}>Estratégia</button><button className={`brief-staff-tab${detailTab==="briefing"?" active":""}`} onClick={()=>setDetailTab("briefing")}>Briefing completo</button><button className={`brief-staff-tab${detailTab==="history"?" active":""}`} onClick={()=>setDetailTab("history")}>Histórico</button></nav>
      {detailTab==="strategy"&&<section className="brief-staff-strategy">
        {strategyLoading&&<div className="brief-staff-loading"><span className="brief-staff-dot"/>Cruzando briefing, contexto e benchmark interno…</div>}
        {strategy?.error&&<div className="brief-staff-error">{strategy.error}</div>}
        {!strategyLoading&&!strategy?.error&&<><div className="brief-staff-strategy-hero"><div className="brief-staff-kicker">Resumo estratégico vivo</div><h3>Leitura para criação e mídia</h3><p>{strategySummary||"Ainda não há contexto suficiente neste briefing para montar uma recomendação segura."}</p></div>
          {strategy?.benchmark&&<div className="brief-staff-benchmark">{summaryText(strategy.benchmark.methodology||strategy.benchmark.summary||strategy.benchmark)}</div>}
          <div className="brief-staff-section-title"><h2>3 versões de copy Meta</h2><span>Baseadas no briefing atual</span></div>
          {copyVariants.length?<div className="brief-staff-strategy-grid">{copyVariants.map((copy:Row,index:number)=>{const copyText=[copy.primary_text||copy.text||copy.copy,copy.headline&&`Título: ${copy.headline}`,copy.description&&`Descrição: ${copy.description}`].filter(Boolean).join("\n\n");return <article className="brief-staff-copy" key={index}><div className="brief-staff-copy-head"><h4>{copy.title||`Variação ${index+1}`}</h4><button className="brief-staff-copy-btn" onClick={()=>void navigator.clipboard?.writeText(copyText)}>Copiar</button></div><p>{copy.primary_text||copy.text||copy.copy||"Copy não disponível."}</p>{copy.headline&&<strong>{copy.headline}</strong>}{copy.description&&<small>{copy.description}</small>}{copy.cta&&<small>CTA: {copy.cta}</small>}</article>})}</div>:<div className="brief-staff-empty">As cópias aparecem quando o briefing tiver produto, público e diferencial suficientes.</div>}
          <div className="brief-staff-section-title"><h2>Plano de campanha Meta</h2><span>Campanha, conjunto e distribuição</span></div>
          {plan.length?<div className="brief-staff-plan">{plan.map(([label,value])=><div className="brief-staff-plan-item" key={label}><small>{label}</small><div>{value}</div></div>)}</div>:<div className="brief-staff-empty">A configuração detalhada aparece com contexto suficiente de produto, região e ticket.</div>}
        </>}
      </section>}
      {detailTab==="briefing"&&<>{detail.links?.length>0&&<div className="brief-staff-section-title"><h2>Relacionados</h2><span>{detail.links.map((x:Row)=>x.name).join(' · ')}</span></div>}{questions.map((q:Row,i:number)=>{const section=q.section?.title||'Informações';const prev=i?questions[i-1]?.section?.title:null;const a=answersByKey.get(String(q.question_key)) as Row|undefined;return <div key={q.question_key}>{section!==prev&&<div className="brief-staff-section-chip">{section}</div>}<div className="brief-staff-answer"><label>{q.label||q.question_key}</label><div>{valueText(a)}</div>{a?.updated_at&&<small>Atualizado {fmtDate(a.updated_at)}{a.updated_by_name?` por ${a.updated_by_name}`:''}</small>}</div></div>})}{!questions.length&&<div className="brief-staff-empty">Nenhuma pergunta compartilhada encontrada.</div>}</>}
      {detailTab==="history"&&<>{history.length?<div className="brief-staff-history">{history.map((entry:Row,index:number)=><article className="brief-staff-history-item" key={entry.id||index}><b>{entry.action||entry.event||entry.title||"Atualização do briefing"}</b><p>{entry.description||entry.summary||entry.detail||"Alteração registrada no histórico."}</p><small>{fmtDate(entry.created_at||entry.updated_at||entry.at)}{entry.actor_name||entry.updated_by_name?` · ${entry.actor_name||entry.updated_by_name}`:''}</small></article>)}</div>:<div className="brief-staff-empty">Ainda não há eventos de histórico disponíveis para este briefing.</div>}</>}
    </aside></div>,document.body)}
    {detailLoading&&createPortal(<div className="brief-staff-drawer-bg"><aside className="brief-staff-drawer"><div className="brief-staff-loading"><span className="brief-staff-dot"/>Abrindo briefing…</div></aside></div>,document.body)}
  </>;
}
