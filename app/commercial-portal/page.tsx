"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";
import "./portal.css";

type Row = Record<string, any>;
type PortalPayload = {
  access: Row; client: Row; brokers: Row[]; days: Row[]; entries: Row[];
  reference_date: string; current_day_id?: string | null; metric_labels: Record<string,string>;
};
const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-portal-api`;
const TZ = "America/Sao_Paulo";

declare global {
  interface Window { webkitSpeechRecognition?: any; SpeechRecognition?: any; }
}

function dateBR(v?:string|null){ if(!v)return "—"; const s=String(v).slice(0,10); return s.split("-").reverse().join("/"); }
function periodBR(d?:Row|null){ if(!d)return ""; const a=String(d.period_start||d.report_date||""),b=String(d.period_end||d.report_date||""); return a&&b&&a!==b?`${dateBR(a)} a ${dateBR(b)}`:dateBR(a||b); }
function when(v?:string|null){ if(!v)return "—"; const d=new Date(v); return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:TZ}).format(d); }
function num(v:any){ const n=Number(v); return Number.isFinite(n)?n:0; }
function pct(a:number,b:number){ return b>0?Math.round(a*100/b):0; }
function brokerOf(entry:Row){ return Array.isArray(entry.commercial_followup_brokers)?entry.commercial_followup_brokers[0]:entry.commercial_followup_brokers||{}; }
export default function CommercialPortalPage(){
  const [session,setSession]=useState<Session|null>(null);
  const [authReady,setAuthReady]=useState(false);
  const [data,setData]=useState<PortalPayload|null>(null);
  const [error,setError]=useState(""); const [loading,setLoading]=useState(false);
  const [magic,setMagic]=useState(""); const [clientKey,setClientKey]=useState("");

  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    setMagic(params.get("t")||""); setClientKey(params.get("client")||"");
    let active=true;
    supabase.auth.getSession().then(({data})=>{if(active){setSession(data.session);setAuthReady(true);}}).catch(()=>{if(active)setAuthReady(true);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,current)=>{if(active){setSession(current);setAuthReady(true);}});
    return()=>{active=false;subscription.unsubscribe();};
  },[]);

  const headers=useMemo(()=>{
    const h:Record<string,string>={apikey:SUPABASE_ANON_KEY};
    if(magic)h["x-portal-token"]=magic;
    else if(session?.access_token)h.Authorization=`Bearer ${session.access_token}`;
    return h;
  },[magic,session?.access_token]);

  const load=useCallback(async()=>{
    if(!magic&&!session?.access_token)return;
    setLoading(true);setError("");
    try{ const suffix=clientKey?`?client=${encodeURIComponent(clientKey)}`:""; const r=await fetch(`${API}${suffix}`,{headers,cache:"no-store"}); const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b.error||`API ${r.status}`); setData(b); }
    catch(e){setData(null);setError(e instanceof Error?e.message:"Não foi possível abrir o portal.");}
    finally{setLoading(false);}
  },[clientKey,headers,magic,session?.access_token]);

  useEffect(()=>{if(authReady&&(magic||session))void load();},[authReady,magic,session,load]);
  useEffect(()=>{
    if(!session?.access_token)return;
    const channel=supabase.channel("commercial-portal-live")
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"commercial_followup_signal",filter:"id=eq.1"},()=>void load())
      .subscribe();
    return()=>{void supabase.removeChannel(channel);};
  },[session?.access_token,load]);
  if(!authReady)return <div className="cp-loading">Abrindo portal comercial…</div>;
  if(!magic&&!session)return <LoginScreen/>;
  if(loading&&!data)return <div className="cp-loading">Carregando sua operação comercial…</div>;
  if(error&&!data)return <ErrorScreen message={error} onRetry={()=>void load()}/>;
  if(!data)return <div className="cp-loading">Preparando portal…</div>;
  return data.access?.role==="BROKER"?<BrokerPortal data={data} headers={headers} reload={load}/>:<ManagerPortal data={data} headers={headers} reload={load}/>;
}
function LoginScreen(){
  const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState("");
  const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setMessage("");try{const {error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;}catch(e){setMessage(e instanceof Error?e.message:"Não foi possível entrar.");}finally{setBusy(false);}};
  const reset=async()=>{if(!email.trim()){setMessage("Informe seu e-mail primeiro.");return;}setBusy(true);setMessage("");try{const {error}=await supabase.auth.resetPasswordForEmail(email.trim(),{redirectTo:`${window.location.origin}/commercial-portal`});if(error)throw error;setMessage("Enviamos o link de recuperação para seu e-mail.");}catch(e){setMessage(e instanceof Error?e.message:"Não foi possível enviar a recuperação.");}finally{setBusy(false);}};
  return <main className="cp-auth-shell"><section className="cp-login-card">
    <div className="cp-logo-mark">LI</div><span className="cp-kicker">PORTAL COMERCIAL</span>
    <h1>Seu comercial, sem planilha.</h1><p>Acompanhe corretores, funil, pendências e evolução em um único lugar.</p>
    <form onSubmit={submit}><label>E-mail<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Senha<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="cp-primary" disabled={busy}>{busy?"Entrando…":"Entrar"}</button></form>
    <button className="cp-link" disabled={busy} onClick={()=>void reset()}>Esqueci minha senha</button>
    {message&&<div className="cp-auth-message">{message}</div>}
    <small>Acesso exclusivo à operação da sua imobiliária.</small>
  </section></main>;
}
function ErrorScreen({message,onRetry}:{message:string;onRetry:()=>void}){return <main className="cp-auth-shell"><section className="cp-login-card"><span className="cp-kicker">PORTAL COMERCIAL</span><h1>Não foi possível abrir agora.</h1><p>{message}</p><button className="cp-primary" onClick={onRetry}>Tentar novamente</button></section></main>;}
function ManagerPortal({data,headers,reload}:{data:PortalPayload;headers:Record<string,string>;reload:()=>Promise<void>}){
  const [period,setPeriod]=useState<7|30>(7); const [editing,setEditing]=useState<Row|null>(null);
  const client=data.client, keys=(Array.isArray(client.questions)?client.questions:[]).filter((k:string)=>k!=="notes");
  const cutoff=useMemo(()=>{const d=new Date(`${data.reference_date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-(period-1));return d.toISOString().slice(0,10);},[data.reference_date,period]);
  const periodDays=data.days.filter(d=>String(d.report_date)>=cutoff&&String(d.report_date)<=data.reference_date);
  const dayIds=new Set(periodDays.map(d=>d.id)); const entries=data.entries.filter(e=>dayIds.has(e.followup_day_id));
  const latestDay=data.days.find(d=>d.id===data.current_day_id)||data.days[0];
  const latestEntries=latestDay?data.entries.filter(e=>e.followup_day_id===latestDay.id):[];
  const totals=aggregate(entries,keys), team=teamRows(data.brokers,entries,keys), attention=attentionRows(data.brokers,latestEntries);
  const responded=entries.filter(e=>e.status==="RESPONDIDO").length, expected=entries.filter(e=>e.status!=="JUSTIFICADO").length;
  return <main className="cp-app">
    <PortalHeader data={data} reload={reload}/>
    <section className="cp-manager-hero"><div><span className="cp-kicker">VISÃO DA GESTÃO</span><h1>O que precisa da sua atenção está aqui.</h1><p>Sem procurar linha, fórmula ou aba. O portal consolida atualização, pendência e funil para você.</p></div><div className="cp-period"><button className={period===7?"active":""} onClick={()=>setPeriod(7)}>7 dias</button><button className={period===30?"active":""} onClick={()=>setPeriod(30)}>30 dias</button></div></section>
    <section className="cp-kpis"><PortalKpi label="Leads" value={totals.leads_received||0} hint="registrados no período"/><PortalKpi label="Visitas" value={totals.visits_completed||0} hint={`${totals.visits_scheduled||0} agendadas`}/><PortalKpi label="Propostas" value={totals.proposals||0} hint="informadas"/><PortalKpi label="Vendas" value={totals.sales||0} hint="informadas"/><PortalKpi label="Adesão" value={`${pct(responded,expected)}%`} hint={`${responded}/${expected} reportes completos`} tone={pct(responded,expected)>=80?"good":"warn"}/></section>
    <section className="cp-manager-grid"><AttentionPanel rows={attention}/><FunnelPanel totals={totals}/></section>
    <TeamPanel client={client} rows={team} keys={keys} labels={data.metric_labels} onEdit={b=>setEditing(b)}/>
    <HistoryStrip days={data.days} entries={data.entries}/>
    {editing&&<ManagerEditModal broker={editing} data={data} headers={headers} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await reload();}}/>}
  </main>;
}

function PortalHeader({data,reload}:{data:PortalPayload;reload:()=>Promise<void>}){
  const internal=data.access?.kind==="INTERNAL";
  return <header className="cp-topbar"><div className="cp-brand"><div className="cp-brand-mark">LI</div><div><b>{data.client.display_name}</b><span>Acompanhamento Comercial</span></div></div><div className="cp-top-actions"><button onClick={()=>void reload()}>Atualizar</button>{internal?<a href="/">Voltar ao dashboard</a>:<button onClick={()=>void supabase.auth.signOut()}>Sair</button>}</div></header>;
}
function PortalKpi({label,value,hint,tone=""}:{label:string;value:any;hint:string;tone?:string}){return <article className={`cp-kpi ${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>;}
function aggregate(entries:Row[],keys:string[]){
  const totals:Row={}; for(const k of keys)totals[k]=0;
  for(const e of entries){for(const k of keys){const v=e.metrics?.[k];if(v!==undefined&&v!==null&&Number.isFinite(Number(v)))totals[k]+=Number(v);}}
  return totals;
}
function teamRows(brokers:Row[],entries:Row[],keys:string[]){
  return brokers.map(b=>{
    const es=entries.filter(e=>e.broker_id===b.id); const valid=es.filter(e=>e.status!=="JUSTIFICADO"); const complete=valid.filter(e=>e.status==="RESPONDIDO").length;
    const metrics=aggregate(es,keys); const latest=[...es].sort((a,c)=>String(c.updated_at).localeCompare(String(a.updated_at)))[0];
    return {...b,metrics,expected:valid.length,complete,adherence:pct(complete,valid.length),latest};
  }).sort((a,b)=>b.adherence-a.adherence||num(b.metrics.sales)-num(a.metrics.sales));
}
function attentionRows(brokers:Row[],latestEntries:Row[]){
  const out:Row[]=[];
  for(const b of brokers){
    const e=latestEntries.find(x=>x.broker_id===b.id);
    const paused=b.paused_until&&new Date(b.paused_until).getTime()>Date.now();
    if(paused){out.push({tone:"info",title:b.display_name,text:`Pausado até ${when(b.paused_until)}${b.pause_reason?` · ${b.pause_reason}`:""}`});continue;}
    if(!e){out.push({tone:"bad",title:b.display_name,text:"Sem reporte criado para a referência atual."});continue;}
    if(e.status==="AGUARDANDO"||e.status==="NAO_RESPONDEU")out.push({tone:"bad",title:b.display_name,text:e.status==="NAO_RESPONDEU"?"Não respondeu dentro da janela.":"Atualização pendente."});
    else if(e.status==="PARCIAL")out.push({tone:"warn",title:b.display_name,text:"Atualização parcial; ainda faltam dados."});
    const arr=Array.isArray(e.anomalies)?e.anomalies:[]; if(arr.length)out.push({tone:"warn",title:b.display_name,text:arr[0].message});
  }
  return out.slice(0,8);
}
function AttentionPanel({rows}:{rows:Row[]}){
  return <section className="cp-card cp-attention"><header><div><span>ATENÇÃO HOJE</span><h2>Quem precisa de ação</h2></div><b>{rows.length}</b></header>{rows.length?rows.map((r,i)=><article key={`${r.title}-${i}`} className={`cp-attention-row ${r.tone}`}><i></i><div><b>{r.title}</b><span>{r.text}</span></div></article>):<div className="cp-empty-state"><b>Operação em dia.</b><span>Nenhuma pendência relevante na referência atual.</span></div>}</section>;
}
function FunnelPanel({totals}:{totals:Row}){
  const stages=[
    ["Leads",num(totals.leads_received)],
    ["Acionados",num(totals.leads_contacted)],
    ["Ligações atendidas",num(totals.calls_answered)],
    ["Visitas",num(totals.visits_completed||totals.visits_scheduled)],
    ["Propostas",num(totals.proposals)],["Vendas",num(totals.sales)],
  ] as [string,number][];
  const max=Math.max(1,...stages.map(x=>x[1]));
  return <section className="cp-card cp-funnel"><header><div><span>FUNIL</span><h2>Onde o comercial está travando</h2></div></header><div className="cp-funnel-list">{stages.map(([label,value],i)=>{const prev=i?stages[i-1][1]:0;return <article key={label}><div><span>{label}</span><b>{value}</b>{i>0&&<small>{pct(value,prev)}% da etapa anterior</small>}</div><div className="cp-funnel-track"><i style={{width:`${Math.max(value?7:0,value*100/max)}%`}}/></div></article>})}</div></section>;
}
function TeamPanel({client,rows,keys,labels,onEdit}:{client:Row;rows:Row[];keys:string[];labels:Record<string,string>;onEdit:(b:Row)=>void}){
  const visible=keys.filter(k=>["leads_received","leads_contacted","calls_made","calls_answered","visits_completed","proposals","sales"].includes(k));
  return <section className="cp-card cp-team"><header><div><span>EQUIPE</span><h2>Desempenho por corretor</h2><p>Dados não informados continuam como não informados; nunca viram zero automaticamente.</p></div></header><div className="cp-table-scroll"><table><thead><tr><th>Corretor</th>{visible.map(k=><th key={k}>{labels[k]||k}</th>)}<th>Adesão</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.display_name}</b><small>{r.latest?`Última atualização ${when(r.latest.updated_at)}`:r.legacy_last_reported_on?`Último registro legado ${dateBR(r.legacy_last_reported_on)}`:"Sem atualização"}</small></td>{visible.map(k=><td key={k}>{r.metrics[k]??"—"}</td>)}<td><span className={`cp-adherence ${r.adherence>=80?"good":r.adherence>=50?"warn":"bad"}`}>{r.adherence}%</span></td><td><button className="cp-small-btn" onClick={()=>onEdit(r)}>Atualizar</button></td></tr>)}</tbody></table></div>{client.expose_ranking===false&&<small className="cp-footnote">Ranking público desativado para este cliente.</small>}</section>;
}
function HistoryStrip({days,entries}:{days:Row[];entries:Row[]}){
  return <section className="cp-card cp-history"><header><div><span>HISTÓRICO</span><h2>Últimos fechamentos</h2></div></header><div className="cp-history-grid">{days.slice(0,10).map(d=>{const es=entries.filter(e=>e.followup_day_id===d.id),valid=es.filter(e=>e.status!=="JUSTIFICADO"),ok=valid.filter(e=>e.status==="RESPONDIDO").length;return <article key={d.id}><span>{dateBR(d.report_date)}</span><b>{pct(ok,valid.length)}%</b><small>{ok}/{valid.length} completos</small><i className={pct(ok,valid.length)>=80?"good":pct(ok,valid.length)>=50?"warn":"bad"}/></article>})}</div></section>;
}

function ManagerEditModal({broker,data,headers,onClose,onSaved}:{broker:Row;data:PortalPayload;headers:Record<string,string>;onClose:()=>void;onSaved:()=>Promise<void>}){
  const dayRow=data.days.find(d=>d.id===data.current_day_id)||data.days[0];
  const entry=dayRow?data.entries.find(e=>e.followup_day_id===dayRow.id&&e.broker_id===broker.id):null;
  return <div className="cp-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="cp-modal"><button className="cp-modal-close" onClick={onClose}>×</button><span className="cp-kicker">ATUALIZAÇÃO MANUAL</span><h2>{broker.display_name}</h2><p>Corrija ou complete o acompanhamento. O portal registra a origem como ajuste da gestão.</p><ReportForm data={data} headers={headers} broker={broker} entry={entry||null} reportDate={dayRow?.report_date||data.reference_date} onSaved={onSaved}/></section></div>;
}
function BrokerPortal({data,headers,reload}:{data:PortalPayload;headers:Record<string,string>;reload:()=>Promise<void>}){
  const broker=data.brokers.find(b=>b.id===data.access?.broker_id)||data.brokers[0];
  const dayRow=data.days.find(d=>d.id===data.current_day_id)||data.days[0];
  const entry=broker&&dayRow?data.entries.find(e=>e.followup_day_id===dayRow.id&&e.broker_id===broker.id):null;
  const weekCutoff=useMemo(()=>{const d=new Date(`${data.reference_date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-6);return d.toISOString().slice(0,10);},[data.reference_date]);
  const ids=new Set(data.days.filter(d=>String(d.report_date)>=weekCutoff&&String(d.report_date)<=data.reference_date).map(d=>d.id));
  const mine=data.entries.filter(e=>e.broker_id===broker?.id&&ids.has(e.followup_day_id));
  const totals=aggregate(mine,(Array.isArray(data.client.questions)?data.client.questions:[]).filter((k:string)=>k!=="notes"));
  return <main className="cp-app cp-broker-app"><PortalHeader data={data} reload={reload}/>
    <section className="cp-broker-hero"><span className="cp-kicker">SUA ATUALIZAÇÃO</span><h1>Olá, {broker?.display_name||data.access?.actor}.</h1><p>Feche o comercial de <b>{periodBR(dayRow)||dateBR(data.reference_date)}</b>. Você pode digitar os números ou falar sua atualização.</p></section>
    <section className="cp-broker-layout"><section className="cp-card cp-report-card"><ReportForm data={data} headers={headers} broker={broker} entry={entry||null} reportDate={dayRow?.report_date||data.reference_date} onSaved={reload}/></section><BrokerWeekCard totals={totals} entries={mine}/></section>
  </main>;
}

function BrokerWeekCard({totals,entries}:{totals:Row;entries:Row[]}){
  const complete=entries.filter(e=>e.status==="RESPONDIDO").length;
  const insight=totals.visits_completed>0?`Você realizou ${totals.visits_completed} visita${totals.visits_completed===1?"":"s"} nesta semana.`:totals.calls_made>0?`Você registrou ${totals.calls_made} ligações nesta semana. O próximo passo é transformar contato em visita.`:"Assim que você atualizar os dias, sua evolução aparece aqui.";
  return <aside className="cp-card cp-week-card"><span className="cp-kicker">MINHA SEMANA</span><h2>Seu desempenho</h2><div className="cp-week-grid"><div><span>Leads</span><b>{totals.leads_received||0}</b></div><div><span>Ligações</span><b>{totals.calls_made||0}</b></div><div><span>Visitas</span><b>{totals.visits_completed||0}</b></div><div><span>Propostas</span><b>{totals.proposals||0}</b></div><div><span>Vendas</span><b>{totals.sales||0}</b></div><div><span>Reportes</span><b>{complete}</b></div></div><div className="cp-personal-insight"><b>Próximo foco</b><p>{insight}</p></div></aside>;
}
function ReportForm({data,headers,broker,entry,reportDate,onSaved}:{data:PortalPayload;headers:Record<string,string>;broker?:Row;entry:Row|null;reportDate:string;onSaved:()=>Promise<void>}){
  const keys=(Array.isArray(data.client.questions)?data.client.questions:[]).filter((k:string)=>k!=="notes");
  const [draft,setDraft]=useState<Row>({...entry?.metrics}); const [notes,setNotes]=useState(entry?.notes||"");
  const [speech,setSpeech]=useState(""); const [busy,setBusy]=useState(false); const [listening,setListening]=useState(false); const [status,setStatus]=useState("");
  useEffect(()=>{setDraft({...entry?.metrics});setNotes(entry?.notes||"");setSpeech("");setStatus("");},[entry?.id,broker?.id]);
  const post=async(body:Row)=>{const r=await fetch(API,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body)});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||`API ${r.status}`);return b;};
  const save=async(silent=false)=>{if(!broker?.id)return;setBusy(true);if(!silent)setStatus("");try{await post({action:"save_metrics",broker_id:broker.id,report_date:reportDate,metrics:draft,notes});if(!silent)setStatus("Atualização salva ✓");await onSaved();}catch(e){if(!silent)setStatus(e instanceof Error?e.message:"Falha ao salvar.");}finally{setBusy(false);}};
  const parseText=async(text:string)=>{if(!text.trim())return;setBusy(true);setStatus("Interpretando sua atualização…");try{const b=await post({action:"parse_text",text});setDraft((d:Row)=>{const next={...d};for(const [k,v] of Object.entries(b.metrics||{}))if(v!==null&&v!==undefined)next[k]=v;return next;});setStatus(b.found?`${b.found} dado${b.found===1?"":"s"} identificado${b.found===1?"":"s"}. Revise e confirme.`:"Não encontrei números suficientes. Você pode preencher abaixo.");}catch(e){setStatus(e instanceof Error?e.message:"Não foi possível interpretar.");}finally{setBusy(false);}};
  const startVoice=()=>{const Ctor=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Ctor){setStatus("Seu navegador não oferece reconhecimento de voz. Use o campo de texto abaixo.");return;}const rec=new Ctor();rec.lang="pt-BR";rec.interimResults=false;rec.maxAlternatives=1;rec.onstart=()=>{setListening(true);setStatus("Ouvindo…")};rec.onerror=()=>{setListening(false);setStatus("Não consegui ouvir. Tente novamente ou digite.")};rec.onend=()=>setListening(false);rec.onresult=(ev:any)=>{const text=String(ev.results?.[0]?.[0]?.transcript||"");setSpeech(text);void parseText(text);};rec.start();};
  return <div className="cp-report-form">
    <div className="cp-voice-box"><button type="button" className={`cp-voice-btn ${listening?"listening":""}`} onClick={startVoice} disabled={busy}>{listening?"● Ouvindo…":"🎙 Falar minha atualização"}</button><div><b>Ou escreva do seu jeito</b><span>Ex.: “Recebi 6 leads, acionei 5, fiz 8 ligações, 2 visitas e 1 proposta.”</span></div></div>
    <div className="cp-natural-row"><textarea value={speech} onChange={e=>setSpeech(e.target.value)} placeholder="Digite sua atualização em uma frase…"/><button type="button" disabled={busy||!speech.trim()} onClick={()=>void parseText(speech)}>Preencher</button></div>
    <div className="cp-fields">{keys.map(k=><label key={k}><span>{data.metric_labels[k]||k}</span><input inputMode="numeric" type="number" min="0" value={draft[k]??""} onChange={e=>setDraft((d:Row)=>({...d,[k]:e.target.value===""?undefined:Number(e.target.value)}))} onBlur={()=>void save(true)}/></label>)}</div>
    <label className="cp-notes"><span>Observações</span><textarea value={notes} onChange={e=>setNotes(e.target.value)} onBlur={()=>void save(true)} placeholder="Algo importante sobre atendimentos, visitas ou negociações?"/></label>
    <div className="cp-form-footer"><div>{status&&<span className="cp-status">{status}</span>}<small>Os dados são salvos também ao sair de cada campo.</small></div><button className="cp-primary" disabled={busy||!broker?.id} onClick={()=>void save(false)}>{busy?"Salvando…":"Salvar atualização"}</button></div>
  </div>;
}
