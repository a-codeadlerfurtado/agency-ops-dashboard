"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, supabase } from "./shared";

type Row = Record<string, any>;
type Mode = "queue" | "history" | null;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-ops-api`;
const money=(v:unknown)=>v===null||v===undefined||v===""?"—":formatMoney(v);
const number=(v:unknown,d=0)=>v===null||v===undefined||v===""?"—":formatNumber(v,d);
const outcomeLabel=(v:string)=>v==="IMPROVED"?"Sinal favorável":v==="WORSENED"?"Sinal desfavorável":v==="INCONCLUSIVE"?"Inconclusivo":"Aguardando 48h";
const priorityLabel=(v:string)=>v==="CRITICAL"?"Crítica":v==="HIGH"?"Alta":v==="MEDIUM"?"Média":"Baixa";
const formatDate=(v:unknown)=>{if(!v)return"—";const d=new Date(String(v));return Number.isNaN(d.getTime())?"—":d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})};

function parseAdsetId(modal: Element | null) {
  const href = modal?.querySelector<HTMLAnchorElement>('a[href*="selected_adset_ids="]')?.href || "";
  try { return new URL(href).searchParams.get("selected_adset_ids") || ""; } catch { return ""; }
}
function parseAdId(row: Element) {
  const text = row.querySelector("td:first-child small")?.textContent || "";
  return text.match(/ID\s+(\d{5,30})/)?.[1] || "";
}

export default function AdsIntelligenceOpsBridge() {
  const [session,setSession]=useState<Session|null>(null);
  const [root,setRoot]=useState<HTMLElement|null>(null);
  const [host,setHost]=useState<HTMLElement|null>(null);
  const [hero,setHero]=useState<HTMLElement|null>(null);
  const [mode,setMode]=useState<Mode>(null);
  const [clientName,setClientName]=useState("");
  const [queue,setQueue]=useState<Row>({items:[],summary:{}});
  const [history,setHistory]=useState<Row[]>([]);
  const [diagnosis,setDiagnosis]=useState<Row|null>(null);
  const [creative,setCreative]=useState<Row|null>(null);
  const [creativeLoading,setCreativeLoading]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [toast,setToast]=useState("");
  const loadedQueueAt=useRef(0);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>setSession(next));
    return()=>subscription.unsubscribe();
  },[]);
  const headers=useMemo(()=>session?.access_token?{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY}:null,[session?.access_token]);

  const getJson=useCallback(async(url:string)=>{
    if(!headers)throw new Error("Sessão indisponível.");
    const r=await fetch(url,{headers,cache:"no-store"});
    const b=await r.json().catch(()=>({}));
    if(!r.ok||b?.ok===false)throw new Error(String(b?.detail||b?.error||`API ${r.status}`));
    return b;
  },[headers]);

  const loadQueue=useCallback(async(force=false)=>{
    if(!headers)return;
    if(!force&&queue.items?.length&&Date.now()-loadedQueueAt.current<60_000)return;
    setLoading(true);setError("");
    try{const b=await getJson(`${API}?mode=queue`);setQueue(b);loadedQueueAt.current=Date.now();}
    catch(e){setError(e instanceof Error?e.message:"Falha ao carregar prioridades.");}
    finally{setLoading(false);}
  },[headers,getJson,queue.items?.length]);

  const loadHistory=useCallback(async(name:string)=>{
    if(!headers)return;setLoading(true);setError("");
    try{const qs=name?`&client_name=${encodeURIComponent(name)}`:"";const b=await getJson(`${API}?mode=history${qs}`);setHistory(b.events||[]);}
    catch(e){setError(e instanceof Error?e.message:"Falha ao carregar histórico.");}
    finally{setLoading(false);}
  },[headers,getJson]);

  const loadDiagnosis=useCallback(async(name:string)=>{
    if(!headers||!name){setDiagnosis(null);return;}
    try{const b=await getJson(`${API}?mode=client&client_name=${encodeURIComponent(name)}`);setDiagnosis(b.diagnosis||null);}
    catch{setDiagnosis(null);}
  },[headers,getJson]);

  const loadCreative=useCallback(async(name:string,adId:string)=>{
    if(!headers||!name||!adId)return;setCreativeLoading(true);setError("");
    try{const b=await getJson(`${API}?mode=creative&client_name=${encodeURIComponent(name)}&ad_id=${encodeURIComponent(adId)}`);setCreative(b.creative||null);}
    catch(e){setError(e instanceof Error?e.message:"Falha ao analisar criativo.");}
    finally{setCreativeLoading(false);}
  },[headers,getJson]);

  const recordRecommendation=useCallback(async(payload:Row,button:HTMLButtonElement)=>{
    if(!headers)return;
    if(!window.confirm("Marcar esta recomendação como aplicada? O Ads Intelligence vai guardar os KPIs de agora e reavaliar o sinal após 48h."))return;
    button.disabled=true;const old=button.textContent;button.textContent="Registrando…";setError("");
    try{
      const r=await fetch(API,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({action:"record",...payload}),cache:"no-store"});
      const b=await r.json().catch(()=>({}));if(!r.ok||b?.ok===false)throw new Error(String(b?.detail||b?.error||`API ${r.status}`));
      button.textContent="Aplicada ✓";button.dataset.recorded="true";setToast("Recomendação registrada. A comparação pós-ação será avaliada após 48h.");
    }catch(e){button.disabled=false;button.textContent=old||"Marcar aplicada";setError(e instanceof Error?e.message:"Falha ao registrar decisão.");}
  },[headers]);

  useEffect(()=>{
    if(!headers||window.location.pathname!=="/")return;
    let cleanup:(()=>void)|null=null;let scheduled=false;
    const install=()=>{
      scheduled=false;
      const currentRoot=document.querySelector<HTMLElement>(".ads-intelligence-host");
      const detail=currentRoot?.querySelector<HTMLElement>(".aii-detail");
      const tabs=currentRoot?.querySelector<HTMLElement>(".aii-tabs");
      const currentHero=currentRoot?.querySelector<HTMLElement>(".aii-client-hero");
      if(!currentRoot||!detail||!tabs){setRoot(null);setHost(null);setHero(null);return;}
      setRoot(currentRoot);setHost(detail);setHero(currentHero||null);
      const name=String(currentHero?.querySelector("h2")?.textContent||"").trim();
      if(name!==clientName){setClientName(name);setDiagnosis(null);if(name)void loadDiagnosis(name);}
      const ensure=(key:"queue"|"history",label:string)=>{
        let btn=tabs.querySelector<HTMLButtonElement>(`[data-aii-ops-tab="${key}"]`);
        if(!btn){btn=document.createElement("button");btn.type="button";btn.dataset.aiiOpsTab=key;btn.textContent=label;if(key==="queue")tabs.insertBefore(btn,tabs.firstChild);else tabs.appendChild(btn);}return btn;
      };
      const q=ensure("queue","Prioridades");const h=ensure("history","Histórico");
      const openQueue=()=>{setMode("queue");void loadQueue(false);};
      const openHistory=()=>{setMode("history");void loadHistory(name);};
      const onTabs=(event:Event)=>{const target=event.target instanceof Element?event.target.closest("button"):null;if(!target||target.hasAttribute("data-aii-ops-tab"))return;setMode(null);};
      cleanup?.();q.addEventListener("click",openQueue);h.addEventListener("click",openHistory);tabs.addEventListener("click",onTabs,true);
      cleanup=()=>{q.removeEventListener("click",openQueue);h.removeEventListener("click",openHistory);tabs.removeEventListener("click",onTabs,true);};

      document.querySelectorAll<HTMLElement>(".aii-rec").forEach(card=>{
        if(card.querySelector("[data-aii-record-decision]"))return;
        const button=document.createElement("button");button.type="button";button.dataset.aiiRecordDecision="true";button.className="aii-record-decision";button.textContent="Marcar aplicada";
        button.addEventListener("click",()=>{const category=String(card.querySelector(".aii-rec-top span")?.textContent||"").trim();const title=String(card.querySelector("h4")?.textContent||"").trim();const action=String(card.querySelector("p.action")?.textContent||"").trim();const reason=String(card.querySelector("p.reason")?.textContent||"").trim();const confidence=String(card.querySelector("footer span:last-child")?.textContent||"").replace(/Confiança\s*/i,"").trim();void recordRecommendation({client_name:name,object_type:"CLIENT",category,title,recommendation:action,reason,confidence},button);});
        card.appendChild(button);
      });
      document.querySelectorAll<HTMLElement>(".aii-field-rec").forEach(card=>{
        if(card.querySelector("[data-aii-record-decision]"))return;
        const modal=card.closest(".aii-advisor-modal");const objectId=parseAdsetId(modal);if(!objectId)return;
        const button=document.createElement("button");button.type="button";button.dataset.aiiRecordDecision="true";button.className="aii-record-decision";button.textContent="Marcar aplicada";
        button.addEventListener("click",()=>{const field=String(card.querySelector(".aii-field-rec-top b")?.textContent||"").trim();const action=String(card.querySelector("h4")?.textContent||"").trim();const reason=String(card.querySelector("p")?.textContent||"").trim();const confidence=String(card.querySelector(".aii-field-rec-top span")?.textContent||"").replace(/Confiança\s*/i,"").trim();const objectName=String(modal?.querySelector("header h3")?.textContent||"").trim();void recordRecommendation({client_name:name,object_type:"ADSET",object_id:objectId,object_name:objectName,field_name:field,title:field,recommendation:action,reason,confidence},button);});
        card.appendChild(button);
      });
      const structureTitle=String(currentRoot.querySelector(".aii-structure-head h3")?.textContent||"").trim();
      if(structureTitle==="Anúncios")currentRoot.querySelectorAll<HTMLTableRowElement>(".aii-structure-table tbody tr").forEach(row=>{
        if(row.querySelector("[data-aii-creative-intelligence]"))return;const adId=parseAdId(row);if(!adId)return;const cell=row.querySelector<HTMLTableCellElement>("td:last-child");if(!cell)return;
        const button=document.createElement("button");button.type="button";button.dataset.aiiCreativeIntelligence="true";button.className="aii-creative-intelligence-button";button.textContent="Inteligência";button.addEventListener("click",()=>void loadCreative(name,adId));cell.appendChild(button);
      });
    };
    const schedule=()=>{if(scheduled)return;scheduled=true;window.requestAnimationFrame(install);};
    install();const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    return()=>{observer.disconnect();cleanup?.();};
  },[headers,clientName,loadQueue,loadHistory,loadDiagnosis,loadCreative,recordRecommendation]);

  useEffect(()=>{
    if(!root)return;root.classList.toggle("aii-ops-active",Boolean(mode));
    root.querySelectorAll<HTMLButtonElement>("[data-aii-ops-tab]").forEach(b=>b.classList.toggle("active",b.dataset.aiiOpsTab===mode));
    return()=>root.classList.remove("aii-ops-active");
  },[root,mode]);

  const openClient=(name:string)=>{
    const rows=Array.from(document.querySelectorAll<HTMLButtonElement>(".ads-intelligence-host .aii-client-row"));
    const row=rows.find(x=>String(x.querySelector(".copy b")?.textContent||"").trim()===name);if(row){setMode(null);row.click();}
  };
  const metaAdUrl=creative?.ad?.account_id&&creative?.ad?.id?`https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(String(creative.ad.account_id).replace(/^act_/,""))}&selected_ad_ids=${encodeURIComponent(String(creative.ad.id))}`:"";

  return <>
    {hero&&diagnosis&&createPortal(<div className={`aii-bottleneck-chip ${diagnosis.primary?.tone||"info"}`} title={(diagnosis.evidence||[]).join(" ")}><span>Gargalo provável</span><b>{diagnosis.primary?.label}</b><em>{diagnosis.primary?.confidence} · baseado somente em evidência disponível</em></div>,hero)}
    {host&&mode&&createPortal(<section className="aii-ops-content">
      {error&&<div className="error-box">{error}</div>}{toast&&<div className="aii-toast">{toast}</div>}
      {mode==="queue"&&<>
        <div className="aii-ops-head"><div><span className="eyebrow">Recommendation Queue</span><h3>O que merece atenção hoje</h3><p>Só entram sinais objetivos: budget, saldo, leitura Meta, deterioração contra o próprio histórico e fadiga com evidência.</p></div><button className="button secondary" onClick={()=>void loadQueue(true)} disabled={loading}>Atualizar</button></div>
        <div className="aii-queue-summary"><div><small>Críticas</small><b>{number(queue.summary?.critical)}</b></div><div><small>Altas</small><b>{number(queue.summary?.high)}</b></div><div><small>Clientes afetados</small><b>{number(queue.summary?.clients)}</b></div><div><small>Sinais na fila</small><b>{number(queue.summary?.total)}</b></div></div>
        {loading&&!queue.items?.length?<div className="card aii-ops-loading"><span className="aii-spinner"/> Cruzando carteira…</div>:<div className="aii-queue-list">{(queue.items||[]).map((item:Row,index:number)=><article className={`card aii-queue-item ${String(item.priority).toLowerCase()}`} key={`${item.client_id}-${item.category}-${index}`}><div className="top"><span>{item.category}</span><em>{priorityLabel(item.priority)}</em></div><h4>{item.client_name}</h4><b>{item.title}</b><p>{item.reason}</p><footer><span>GT {item.gt_owner||"—"}{item.metric?` · ${item.metric}`:""}</span><button onClick={()=>openClient(String(item.client_name))}>Abrir cliente →</button></footer></article>)}</div>}
      </>}
      {mode==="history"&&<>
        <div className="aii-ops-head"><div><span className="eyebrow">Decision History</span><h3>{clientName?`Decisões · ${clientName}`:"Histórico de decisões"}</h3><p>Cada ação guarda o antes e, após 48h, mostra o sinal observado. O resultado não é tratado como prova causal.</p></div><button className="button secondary" onClick={()=>void loadHistory(clientName)} disabled={loading}>Atualizar</button></div>
        {loading&&!history.length?<div className="card aii-ops-loading"><span className="aii-spinner"/> Lendo decisões…</div>:<div className="aii-history-list">{history.map((ev:Row)=><article className="card aii-history-item" key={ev.id}><div className="top"><span>{ev.object_type}{ev.field_name?` · ${ev.field_name}`:""}</span><em className={String(ev.outcome||"pending").toLowerCase()}>{outcomeLabel(String(ev.outcome||""))}</em></div><h4>{ev.title}</h4><p className="decision">{ev.recommendation}</p><p className="reason">{ev.outcome_reason||`Avaliação prevista para ${formatDate(ev.followup_due_at)}.`}</p><footer><span>{formatDate(ev.applied_at||ev.created_at)} · {ev.applied_by_person||"—"}</span><span>Antes: CPR {money(ev.metrics_before?.cost_per_result??ev.metrics_before?.cpl)} · {number(ev.metrics_before?.results)} resultados</span></footer></article>)}{!history.length&&<div className="card aii-ops-empty">Nenhuma recomendação aplicada foi registrada para este escopo ainda.</div>}</div>}
      </>}
    </section>,host)}
    {creativeLoading&&createPortal(<div className="aii-creative-modal-backdrop"><div className="aii-creative-modal loading"><span className="aii-spinner"/><b>Analisando este anúncio no contexto certo…</b></div></div>,document.body)}
    {creative&&!creativeLoading&&createPortal(<div className="aii-creative-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCreative(null)}}><section className="aii-creative-modal"><header><div><span className="eyebrow">Creative Intelligence</span><h3>{creative.ad?.name}</h3><p>{creative.ad?.campaign_name} · {creative.ad?.adset_name}</p></div><button onClick={()=>setCreative(null)}>×</button></header><div className="body"><div className="preview">{creative.ad?.preview_url?<img src={creative.ad.preview_url} alt=""/>:<div>Sem frame</div>}</div><div className="analysis"><div className={`classification ${creative.classification?.tone||"info"}`}><small>CLASSIFICAÇÃO</small><h4>{creative.classification?.label}</h4><span>Confiança {String(creative.classification?.confidence||"").toLowerCase()}</span><p>{creative.classification?.why}</p></div><div className="metrics"><div><small>Gasto 7d</small><b>{money(creative.metrics?.spend)}</b></div><div><small>Resultados</small><b>{number(creative.metrics?.results)}</b></div><div><small>CPR</small><b>{money(creative.metrics?.cpr)}</b></div><div><small>CTR</small><b>{number(creative.metrics?.ctr,2)}%</b></div><div><small>Freq.</small><b>{number(creative.metrics?.frequency,2)}</b></div></div><div className="baseline"><b>Referência usada</b><p>{creative.baseline?.scope==="MESMO_CONJUNTO"?"Anúncios do mesmo conjunto":"Anúncios da mesma campanha"} · {number(creative.baseline?.peer_count)} pares. CPR mediano {money(creative.baseline?.median_cpr)} · CTR mediano {number(creative.baseline?.median_ctr,2)}%.</p></div><div className="next"><b>Próximo teste</b><p>{creative.classification?.next_test}</p></div><small className="method">{creative.methodology}</small></div></div><footer><button className="button secondary" onClick={()=>setCreative(null)}>Fechar</button>{metaAdUrl&&<a className="button aii-meta-primary" href={metaAdUrl} target="_blank" rel="noreferrer">Abrir anúncio na Meta ↗</a>}</footer></section></div>,document.body)}
  </>;
}
