"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authenticatedFetch, SUPABASE_URL, supabase } from "../../shared";
import "./monthly-report.css";

type Row=Record<string,any>;
const API=`${SUPABASE_URL}/functions/v1/agency-ops-monthly-client-report-api`;
const money=(v:unknown)=>Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const num=(v:unknown,d=0)=>Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:d});
const monthLabel=(key:string)=>{const x=new Intl.DateTimeFormat("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${key}-01T12:00:00Z`));return x.charAt(0).toUpperCase()+x.slice(1);};
const delta=(v:unknown,inverse=false)=>{const x=Number(v);if(!Number.isFinite(x))return{txt:"sem base",cls:"muted"};const good=inverse?x<0:x>0;return{txt:`${x>0?"↑":x<0?"↓":"="} ${Math.abs(x).toFixed(0)}%`,cls:good?"good":x===0?"muted":"bad"};};

export default function MonthlyReportsPage(){
  const[session,setSession]=useState<Session|null>(null),[ready,setReady]=useState(false);
  const[month,setMonth]=useState(""),[months,setMonths]=useState<string[]>([]);
  const[clients,setClients]=useState<Row[]>([]),[reports,setReports]=useState<Row[]>([]);
  const[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState("");
  const[busy,setBusy]=useState<Record<string,boolean>>({}),[copied,setCopied]=useState("");
  useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);if(!data.session)location.replace("/");});},[]);
  const load=useCallback(async(target?:string)=>{
    if(!session?.access_token)return;setLoading(true);setError("");
    try{
      const url=new URL(API);if(target||month)url.searchParams.set("month",target||month);
      const response=await authenticatedFetch(url.toString(),{cache:"no-store"});const body=await response.json().catch(()=>({}));
      if(!response.ok||!body.ok)throw new Error(body.detail||body.error||`API ${response.status}`);
      setClients(body.clients||[]);setReports(body.reports||[]);setMonths(body.months||[]);setMonth(body.month||target||month);
    }catch(e){setError(e instanceof Error?e.message:"Falha ao carregar relatórios mensais.");}
    finally{setLoading(false);}
  },[session?.access_token,month]);
  useEffect(()=>{if(ready&&session?.access_token&&!month)void load();},[ready,session?.access_token,month,load]);
  useEffect(()=>{if(month&&session?.access_token)void load(month);},[month,session?.access_token]);

  const byClient=useMemo(()=>new Map(reports.map(r=>[String(r.client_id),r])),[reports]);
  const visible=useMemo(()=>{const q=query.trim().toLocaleLowerCase("pt-BR");return clients.filter(c=>!q||`${c.display_name} ${c.gt_owner||""}`.toLocaleLowerCase("pt-BR").includes(q));},[clients,query]);
  async function generate(client:Row){
    const id=String(client.id);setBusy(x=>({...x,[id]:true}));setError("");
    try{const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"generate",client_id:id,month})});const body=await response.json().catch(()=>({}));if(!response.ok||!body.ok)throw new Error(body.detail||body.error||`API ${response.status}`);setReports(rows=>[...rows.filter(r=>String(r.client_id)!==id),body.report]);}
    catch(e){setError(e instanceof Error?e.message:"Falha ao gerar apresentação.");}
    finally{setBusy(x=>({...x,[id]:false}));}
  }
  const publicUrl=(report:Row)=>`${window.location.origin}/relatorio-mensal/${report.public_token}`;
  async function copyLink(report:Row){
    const url=publicUrl(report);await navigator.clipboard.writeText(url);setCopied(String(report.id));setTimeout(()=>setCopied(""),1600);
    void authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"mark_shared",client_id:report.client_id,month})}).catch(()=>null);
  }
  if(!ready||!session)return <main className="mr-state">Carregando…</main>;
  return <main className="mr-shell">
    <header className="mr-top"><div><span>FECHAMENTO CLIENTE · META ADS</span><h1>Relatórios Mensais</h1><p>Uma apresentação por cliente, consolidando os fechamentos semanais, comparando as semanas e o mês anterior, com campanhas e criativos reais.</p></div>
      <div className="mr-actions-top"><label>Mês<select value={month} onChange={e=>setMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select></label><button onClick={()=>load(month)} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button></div>
    </header>
    <section className="mr-toolbar"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente ou GT"/><div><b>{visible.length}</b><span>clientes no período</span></div><div><b>{reports.length}</b><span>apresentações geradas</span></div></section>
    {error&&<div className="mr-error">{error}</div>}
    <section className="mr-list">
      {visible.map(client=>{
        const report=byClient.get(String(client.id)),snap=report?.snapshot||{},cov=snap.coverage||{},cur=snap.current||{},tr=snap.trends||{};
        const resultDelta=delta(tr.results?.delta),cprDelta=delta(tr.cpr?.delta,true);
        return <article className="mr-card" key={client.id}>
          <div className="mr-card-main"><div><small>{client.gt_owner||"Sem GT"}</small><h2>{client.display_name}</h2><p>{report?`${cov.current_week_count||0}/${cov.expected_weeks||4} semanas consolidadas · ${cov.previous_week_count||0} semanas no mês anterior`:"Ainda não gerado para este mês."}</p></div>
            {report&&<span className={`mr-status ${report.audit_status?.toLowerCase()}`}>{report.is_final?"FECHAMENTO":"PRÉVIA"} · {report.audit_status}</span>}
          </div>
          {report&&<div className="mr-kpis"><div><small>Investimento</small><b>{money(cur.spend)}</b></div><div><small>Resultados</small><b>{num(cur.results)}</b><em className={resultDelta.cls}>{resultDelta.txt}</em></div><div><small>CPR</small><b>{cur.cpr==null?"—":money(cur.cpr)}</b><em className={cprDelta.cls}>{cprDelta.txt}</em></div><div><small>Semanas</small><b>{cov.current_week_count||0}</b><em className="muted">comparadas</em></div></div>}
          <div className="mr-card-actions">
            <button onClick={()=>generate(client)} disabled={busy[String(client.id)]}>{busy[String(client.id)]?"Gerando…":report?"Regerar":"Gerar apresentação"}</button>
            {report?.public_token&&<><a className="primary" href={`/relatorio-mensal/${report.public_token}`} target="_blank" rel="noreferrer">Abrir apresentação</a><button onClick={()=>copyLink(report)}>{copied===String(report.id)?"✓ Link copiado":"Copiar link"}</button></>}
          </div>
        </article>;
      })}
      {!loading&&!visible.length&&<div className="mr-empty">Nenhum cliente encontrado neste período.</div>}
    </section>
  </main>;
}
