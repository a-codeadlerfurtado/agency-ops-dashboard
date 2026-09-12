"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber } from "./shared";

type Row=Record<string,any>;
const API=`${SUPABASE_URL}/functions/v1/agency-ops-monthly-client-report-api`;
const monthLabel=(key:string)=>{const x=new Intl.DateTimeFormat("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${key}-01T12:00:00Z`));return x.charAt(0).toUpperCase()+x.slice(1);};
const pct=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?`${n>0?"↑":n<0?"↓":"="} ${Math.abs(n).toFixed(0)}% vs mês anterior`:"sem base anterior";};

export default function MetaMonthlyReportsInline({session}:{session:Session|null}){
  const[data,setData]=useState<Row>({clients:[],reports:[],months:[]}),[month,setMonth]=useState(""),[query,setQuery]=useState("");
  const[loading,setLoading]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState<Record<string,boolean>>({}),[copied,setCopied]=useState("");
  const headers=useMemo(()=>session?.access_token?{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY}:null,[session?.access_token]);
  const load=useCallback(async(target?:string)=>{if(!headers)return;setLoading(true);setError("");try{const p=new URLSearchParams();if(target||month)p.set("month",target||month);const r=await fetch(`${API}?${p}`,{headers,cache:"no-store"}),b=await r.json().catch(()=>({}));if(!r.ok||!b.ok)throw new Error(b.detail||b.error||`API ${r.status}`);setData(b);setMonth(String(b.month||target||month));}catch(e){setError(e instanceof Error?e.message:"Falha ao carregar fechamentos mensais.");}finally{setLoading(false);}},[headers,month]);
  useEffect(()=>{if(headers&&!month)void load();},[headers,month,load]);
  const reports:Row[]=data.reports||[],clients:Row[]=data.clients||[],byClient=useMemo(()=>new Map(reports.map(r=>[String(r.client_id),r])),[reports]);
  const visible=clients.filter(c=>!query.trim()||[c.display_name,c.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")));
  async function post(body:Row){if(!headers)throw new Error("Sessão indisponível");const r=await fetch(API,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body)}),b=await r.json().catch(()=>({}));if(!r.ok||!b.ok)throw new Error(b.detail||b.error||`API ${r.status}`);return b;}
  async function generate(client:Row){const id=String(client.id);setBusy(x=>({...x,[id]:true}));setError("");try{const b=await post({action:"generate",client_id:id,month});setData((d:Row)=>({...d,reports:[...(d.reports||[]).filter((r:Row)=>String(r.client_id)!==id),b.report]}));}catch(e){setError(e instanceof Error?e.message:"Falha ao gerar fechamento mensal.");}finally{setBusy(x=>({...x,[id]:false}));}}
  async function copy(report:Row){const link=`${window.location.origin}/relatorio-mensal/${report.public_token}`;await navigator.clipboard.writeText(link);setCopied(String(report.id));void post({action:"mark_shared",client_id:report.client_id,month}).catch(()=>{});window.setTimeout(()=>setCopied(""),1600);}
  return <section className="monthly-reports-workspace">
    <div className="mwr-head"><div><span className="eyebrow">Fechamento do mês</span><h2>Relatório mensal de performance</h2><p>Consolida até 4 relatórios semanais auditados, compara semana a semana e com o mês anterior, e monta a apresentação automática do cliente.</p></div><div className="mwr-actions"><select className="control" value={month} onChange={e=>{setMonth(e.target.value);void load(e.target.value);}}>{(data.months||[]).map((m:string)=><option key={m} value={m}>{monthLabel(m)}</option>)}</select><button className="btn" onClick={()=>load(month)} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button></div></div>
    <div className="mwr-summary"><article><small>Clientes no período</small><b>{clients.length}</b></article><article><small>Apresentações geradas</small><b>{reports.length}</b></article><article><small>Fechamentos completos</small><b>{reports.filter(r=>r.audit_status==="PASS").length}</b></article><article><small>Parciais</small><b>{reports.filter(r=>r.audit_status==="PARTIAL").length}</b></article></div>
    <div className="mwr-toolbar"><input className="control" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente ou GT…"/><span>{visible.length} cliente{visible.length===1?"":"s"}</span></div>
    {error&&<div className="error-box">{error}</div>}
    <div className="mwr-list">{visible.map(client=>{const report=byClient.get(String(client.id)),snap=report?.snapshot||{},cur=snap.current||{},tr=snap.trends||{},cov=snap.coverage||{};return <article className="mwr-row" key={client.id}>
      <div className="mwr-client"><b>{client.display_name}</b><small>{client.gt_owner||"GT não definido"}</small>{report&&<em className={`mwr-status ${String(report.audit_status||"").toLowerCase()}`}>{report.is_final?"FECHAMENTO":"PRÉVIA"} · {report.audit_status}</em>}</div>
      <div className="mwr-metrics">{report?<><span><small>Resultados</small><b>{formatNumber(cur.results||0)}</b><em>{pct(tr.results?.delta)}</em></span><span><small>CPR</small><b>{cur.cpr==null?"—":formatMoney(cur.cpr)}</b><em>{pct(tr.cpr?.delta)}</em></span><span><small>Investimento</small><b>{formatMoney(cur.spend||0)}</b><em>{pct(tr.spend?.delta)}</em></span><span><small>Semanas</small><b>{cov.current_week_count||0}/4</b><em>mês anterior {cov.previous_week_count||0}/4</em></span></>:<span className="mwr-not-generated">Ainda não gerado.</span>}</div>
      <div className="mwr-row-actions"><button className="btn wr-secondary" onClick={()=>generate(client)} disabled={busy[String(client.id)]}>{busy[String(client.id)]?"Gerando…":report?"Regerar":"Gerar apresentação"}</button>{report?.public_token&&<><a className="btn" href={`/relatorio-mensal/${report.public_token}`} target="_blank" rel="noreferrer">Abrir apresentação</a><button className="btn wr-secondary" onClick={()=>copy(report)}>{copied===String(report.id)?"Link copiado ✓":"Copiar link"}</button></>}</div>
    </article>;})}{!loading&&!visible.length&&<div className="empty">Nenhum cliente encontrado neste mês.</div>}</div>
  </section>;
}
