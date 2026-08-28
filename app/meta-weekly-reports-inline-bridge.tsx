"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, supabase } from "./shared";

type Row=Record<string,any>;
const API=`${SUPABASE_URL}/functions/v1/agency-ops-weekly-reports-api`;

function dateLabel(value:unknown){if(!value)return "—";const d=new Date(`${String(value)}T12:00:00`);return new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit"}).format(d);}
function statusLabel(value:string){return ({READY:"Pronto para enviar",REVIEW_REQUIRED:"Revisar antes de enviar",PENDING:"Na fila",RUNNING:"Gerando",ERROR:"Erro"} as Row)[value]||value;}
function pct(value:unknown){const n=Number(value);if(!Number.isFinite(n))return "sem comparação";return `${n>0?"↑":n<0?"↓":"="} ${Math.abs(n).toFixed(0)}%`;}

export default function MetaWeeklyReportsInlineBridge(){
  const[session,setSession]=useState<Session|null>(null);
  const[allowed,setAllowed]=useState(false);
  const[role,setRole]=useState("");
  const[mode,setMode]=useState<"consultor"|"weekly">("consultor");
  const[panelHost,setPanelHost]=useState<HTMLElement|null>(null);
  const[data,setData]=useState<Row>({reports:[],summary:{}});
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState("");
  const[gt,setGt]=useState("");
  const[query,setQuery]=useState("");
  const[copied,setCopied]=useState("");
  const[generating,setGenerating]=useState(false);

  useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session));const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>setSession(next));return()=>subscription.unsubscribe();},[]);
  const headers=useMemo(()=>session?.access_token?{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY}:null,[session?.access_token]);
  useEffect(()=>{if(!headers){setAllowed(false);return;}let alive=true;fetch(`${API}?probe=1`,{headers,cache:"no-store"}).then(async r=>{if(!alive||!r.ok){setAllowed(false);return;}const b=await r.json();setAllowed(true);setRole(String(b?.profile?.role||""));}).catch(()=>setAllowed(false));return()=>{alive=false;};},[headers]);

  const load=useCallback(async(selectedGt=gt)=>{if(!headers)return;setLoading(true);setError("");try{const p=new URLSearchParams();if(selectedGt)p.set("gt",selectedGt);const r=await fetch(`${API}?${p}`,{headers,cache:"no-store"});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);setData(b);if(!selectedGt&&b.selected_gt)setGt(String(b.selected_gt));}catch(e){setError(e instanceof Error?e.message:"Falha ao carregar relatórios.");}finally{setLoading(false);}},[headers,gt]);

  useEffect(()=>{if(mode==="weekly"&&allowed)void load(gt);},[mode,allowed,headers]);

  useEffect(()=>{
    if(!allowed||window.location.pathname!=="/")return;
    let cleanup:()=>void=()=>{};
    const install=()=>{
      const host=document.querySelector<HTMLElement>(".meta-consultant-host");
      if(!host){setPanelHost(null);return;}
      let nav=host.querySelector<HTMLElement>("[data-weekly-report-tabs]");
      if(!nav){
        nav=document.createElement("nav");nav.dataset.weeklyReportTabs="true";nav.className="weekly-report-tabs";
        const consultor=document.createElement("button"),weekly=document.createElement("button");
        consultor.type="button";weekly.type="button";consultor.textContent="Consultor";weekly.textContent="Relatório semanal";
        consultor.dataset.weeklyTab="consultor";weekly.dataset.weeklyTab="weekly";
        nav.append(consultor,weekly);
        const first=host.querySelector(".mc-workspace-head");host.insertBefore(nav,first||host.firstChild);
      }
      let panel=host.querySelector<HTMLElement>("[data-weekly-reports-panel]");
      if(!panel){panel=document.createElement("div");panel.dataset.weeklyReportsPanel="true";panel.className="weekly-reports-panel-host";nav.insertAdjacentElement("afterend",panel);}
      setPanelHost(panel);
      const click=(event:Event)=>{const btn=(event.target as HTMLElement)?.closest?.("[data-weekly-tab]") as HTMLElement|null;if(!btn)return;setMode(btn.dataset.weeklyTab==="weekly"?"weekly":"consultor");};
      nav.addEventListener("click",click);cleanup();cleanup=()=>nav?.removeEventListener("click",click);
    };
    install();const observer=new MutationObserver(install);observer.observe(document.body,{childList:true,subtree:true});return()=>{observer.disconnect();cleanup();document.querySelectorAll("[data-weekly-report-tabs],[data-weekly-reports-panel]").forEach(n=>n.remove());};
  },[allowed]);

  useEffect(()=>{const host=document.querySelector<HTMLElement>(".meta-consultant-host");if(!host)return;host.classList.toggle("weekly-report-mode",mode==="weekly");host.querySelectorAll<HTMLElement>("[data-weekly-tab]").forEach(btn=>btn.classList.toggle("active",btn.dataset.weeklyTab===mode));return()=>host.classList.remove("weekly-report-mode");},[mode,panelHost]);

  const reports:Row[]=data.reports||[];
  const visible=reports.filter(r=>!query.trim()||[r.client_name,r.gt_owner].join(" ").toLowerCase().includes(query.trim().toLowerCase()));

  async function copyLink(report:Row){if(!report.public_path)return;const link=`${window.location.origin}${report.public_path}`;await navigator.clipboard.writeText(link);setCopied(String(report.id));window.setTimeout(()=>setCopied(""),1600);}
  async function generateNow(){if(!headers||role!=="MGMT")return;setGenerating(true);setError("");try{const r=await fetch(API,{method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}"});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);window.setTimeout(()=>void load(gt),1800);}catch(e){setError(e instanceof Error?e.message:"Falha ao iniciar geração.");}finally{setGenerating(false);}}

  if(!allowed||!panelHost)return null;
  return createPortal(<section className="weekly-reports-workspace">
    <div className="wr-head">
      <div><span className="eyebrow">Entrega ao cliente</span><h2>Relatório semanal</h2><p>Relatórios fechados da semana, com campanhas, criativos e leitura executiva. Copie o link e envie no grupo do cliente.</p></div>
      <div className="wr-actions">
        {role==="MGMT"&&<select className="control" value={gt} onChange={e=>{setGt(e.target.value);void load(e.target.value);}}><option value="">Todos os GTs</option>{(data.gt_options||[]).map((name:string)=><option key={name} value={name}>{name}</option>)}</select>}
        <button className="btn" onClick={()=>load(gt)} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button>
        {role==="MGMT"&&<button className="btn wr-secondary" onClick={generateNow} disabled={generating}>{generating?"Iniciando…":"Gerar agora"}</button>}
      </div>
    </div>

    {data.week&&<div className="wr-week"><b>Semana {dateLabel(data.week.week_start)} → {dateLabel(data.week.week_end)}</b><span>Snapshot fechado · o link não muda depois de enviado</span></div>}
    <div className="wr-summary">
      <article><small>Prontos</small><b>{data.summary?.ready||0}</b></article>
      <article><small>Revisar</small><b>{data.summary?.review||0}</b></article>
      <article><small>Gerando</small><b>{data.summary?.pending||0}</b></article>
      <article><small>Erros</small><b>{data.summary?.error||0}</b></article>
    </div>
    <div className="wr-toolbar"><input className="control" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente…"/><span>{visible.length} relatório{visible.length===1?"":"s"}</span></div>
    {error&&<div className="error-box">{error}</div>}
    <div className="wr-list">
      {visible.map(report=>{const m=report.metrics||{},d=report.narrative?.deltas||{};return <article className={`wr-row ${String(report.status).toLowerCase()}`} key={report.id}>
        <div className="wr-client"><b>{report.client_name}</b><small>{report.gt_owner||"GT não definido"}</small><em className={`wr-status ${String(report.status).toLowerCase()}`}>{statusLabel(String(report.status))}</em></div>
        <div className="wr-metrics"><span><small>Resultados</small><b>{m.results==null?"—":formatNumber(m.results)}</b><em>{pct(d.results)}</em></span><span><small>CPR</small><b>{m.cpr==null?"—":formatMoney(m.cpr)}</b><em>{pct(d.cpr)}</em></span><span><small>Investimento</small><b>{m.spend==null?"—":formatMoney(m.spend)}</b><em>{pct(d.spend)}</em></span><span><small>Criativos</small><b>{report.creative_count||0}</b><em>no relatório</em></span></div>
        <div className="wr-row-actions">{report.public_path?<><button className="btn" onClick={()=>copyLink(report)}>{copied===String(report.id)?"Link copiado ✓":"Copiar link"}</button><a className="btn wr-secondary" href={report.public_path} target="_blank" rel="noreferrer">Abrir</a></>:<small>{report.status==="REVIEW_REQUIRED"?"Não liberar para o cliente antes da revisão.":report.last_error||"Aguardando geração."}</small>}</div>
      </article>;})}
      {!loading&&!visible.length&&<div className="empty">Ainda não há relatórios para este filtro.</div>}
    </div>
  </section>,panelHost);
}
