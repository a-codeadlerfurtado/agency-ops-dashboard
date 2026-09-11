"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";
import { ViewOncallCenter } from "./view-oncall";
import "./commercial-followup.css";

type Row = Record<string, any>;
type Payload = { clients:Row[]; brokers:Row[]; days:Row[]; entries:Row[]; events:Row[]; portal_access?:Row[]; view_adapter?:Row; role?:string };
const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-followup-api`;
const CLIENT_ORDER = ["view-imoveis","murano","wall-street","lopes-chaves","imperial-imoveis","nexus"];
const METRICS:Record<string,string>={
  leads_received:"Leads recebidos",leads_contacted:"Leads acionados",leads_in_conversation:"Leads em conversa",
  calls_made:"Ligações feitas",calls_answered:"Ligações atendidas",visits_scheduled:"Visitas agendadas",
  visits_completed:"Visitas realizadas",proposals:"Propostas",sales:"Vendas",
  properties_prospected:"Imóveis captados",properties_listed:"Imóveis cadastrados",notes:"Observações",
};
const MODE:Record<string,string>={PLANTAO:"Por plantão",PLANILHA:"Planilha + WhatsApp",GRUPO_MANUAL:"Portal + WhatsApp",CRM_INTEGRADO:"CRM integrado",HIBRIDO:"CRM + portal"};
const TZ="America/Sao_Paulo";
function day(v:any){ if(!v)return "—"; const s=String(v).slice(0,10); return s.split("-").reverse().join("/"); }
function when(v:any){ if(!v)return "—"; const d=new Date(v); return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:TZ}).format(d); }
function elapsed(v:any){ if(!v)return "—"; const m=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/60000)); if(m<60)return `${m} min`; if(m<1440)return `${Math.floor(m/60)}h ${m%60}min`; return `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h`; }
export function CommercialFollowupCenter({ token }: { token:string }) {
  const [data,setData]=useState<Payload>({clients:[],brokers:[],days:[],entries:[],events:[]});
  const [selected,setSelected]=useState("view-imoveis");
  const [loading,setLoading]=useState(true); const [error,setError]=useState(""); const [busy,setBusy]=useState("");
  const load=useCallback(async()=>{ setError(""); try{
    const r=await fetch(API,{headers:{Authorization:`Bearer ${token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"});
    const b=await r.json().catch(()=>({})); if(!r.ok) throw new Error(b.error||`API ${r.status}`); setData(b);
  }catch(e){setError(e instanceof Error?e.message:"Falha ao carregar acompanhamento.");} finally{setLoading(false);} },[token]);
  useEffect(()=>{
    void load();
    const channel=supabase.channel("commercial-followup-dashboard")
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"commercial_followup_signal",filter:"id=eq.1"},()=>void load())
      .subscribe();
    const focus=()=>void load(); const visible=()=>{if(document.visibilityState==="visible")void load();};
    window.addEventListener("focus",focus); document.addEventListener("visibilitychange",visible);
    return()=>{window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",visible);void supabase.removeChannel(channel);};
  },[load]);

  const clients=useMemo(()=>[...data.clients].sort((a,b)=>CLIENT_ORDER.indexOf(a.slug)-CLIENT_ORDER.indexOf(b.slug)),[data.clients]);
  const viewClient=clients.find(c=>c.slug==="view-imoveis");
  const selectedClient=clients.find(c=>c.slug===selected);
  const call=useCallback(async(body:Row)=>{setBusy(String(body.action||"save")); setError(""); try{
    const r=await fetch(API,{method:"POST",headers:{Authorization:`Bearer ${token}`,apikey:SUPABASE_ANON_KEY,"content-type":"application/json"},body:JSON.stringify(body)});
    const b=await r.json().catch(()=>({})); if(!r.ok) throw new Error(b.error||`API ${r.status}`); await load(); return b;
  }catch(e){setError(e instanceof Error?e.message:"Falha na ação.");return null;}finally{setBusy("");}},[token,load]);

  const overview=clients.map(c=>clientStats(c,data));
  return <section className="cfc-shell">
    <header className="cfc-head"><div><span>OPERAÇÃO COMERCIAL</span><h1>Acompanhamento Comercial</h1><p>Portal, plantões, pendências, respostas, aderência e funil comercial em um único lugar.</p></div><div className="cfc-head-actions"><button onClick={()=>void load()} disabled={loading}>Atualizar</button>{data.role==="MGMT"&&<AddClientButton call={call}/>}</div></header>
    {error&&<div className="cfc-error">{error}</div>}
    <section className="cfc-overview">{overview.map(s=><OverviewCard key={s.slug} stat={s} active={selected===s.slug} onClick={()=>setSelected(s.slug)}/>)}</section>
    <nav className="cfc-tabs" aria-label="Clientes do acompanhamento comercial">
      {clients.map(c=><button key={c.id} className={selected===c.slug?"active":""} onClick={()=>setSelected(c.slug)}><span>{c.display_name}</span>{c.automation_enabled?<i className="on">ON</i>:<i>OFF</i>}</button>)}
    </nav>
    {loading&&<div className="cfc-loading">Carregando acompanhamento comercial…</div>}
    {!loading&&selected==="view-imoveis"&&<section className="cfc-client-wrap"><ClientModeStrip client={selectedClient||viewClient} role={data.role||""} call={call} busy={busy}/><ViewOncallCenter token={token}/></section>}
    {!loading&&selected!=="view-imoveis"&&selectedClient&&<GenericClientPanel client={selectedClient} data={data} role={data.role||""} call={call} busy={busy}/>} 
  </section>;
}

function clientStats(client:Row,data:Payload){
  if(client.slug==="view-imoveis"){
    const monitor=data.view_adapter?.monitor||[];
    const waiting=monitor.filter((x:Row)=>["NO_RESPONSE","NO_RESPONSE_2H_PLUS","NO_RESPONSE_REMINDER_SENT","WAITING_TO_SEND"].includes(x.response_state)).length;
    const answered=monitor.filter((x:Row)=>x.response_state==="ANSWERED").length;
    return {slug:client.slug,name:client.display_name,mode:"Por plantão",enabled:client.automation_enabled,pending:waiting,responded:answered,adherence:answered+waiting?Math.round(answered*100/(answered+waiting)):100,status:"Colibra"};
  }
  const days=data.days.filter(d=>d.followup_client_id===client.id).sort((a,b)=>String(b.report_date).localeCompare(String(a.report_date)));
  const latest=days[0]; const entries=latest?data.entries.filter(e=>e.followup_day_id===latest.id):[];
  const valid=entries.filter(e=>e.status!=="JUSTIFICADO"), responded=valid.filter(e=>e.status==="RESPONDIDO").length;
  const pending=valid.filter(e=>["AGUARDANDO","PARCIAL","NAO_RESPONDEU"].includes(e.status)).length;
  return {slug:client.slug,name:client.display_name,mode:MODE[client.collection_mode]||client.collection_mode,enabled:client.automation_enabled,pending,responded,adherence:valid.length?Math.round(responded*100/valid.length):0,status:client.portal_enabled?"Portal ativo":client.group_chat_id?"WhatsApp mapeado":"Configuração pendente"};
}
function OverviewCard({stat,active,onClick}:{stat:Row;active:boolean;onClick:()=>void}){
  return <button className={`cfc-overview-card ${active?"active":""}`} onClick={onClick}>
    <div><b>{stat.name}</b><span>{stat.mode}</span></div>
    <div className="cfc-mini-row"><strong>{stat.pending}</strong><small>pendentes</small><strong>{stat.responded}</strong><small>respondidos</small></div>
    <footer><span className={stat.enabled?"cfc-live":"cfc-off"}>{stat.enabled?"Automação ON":"Automação OFF"}</span><span>{stat.status}</span></footer>
  </button>;
}

function ClientModeStrip({client,role="",call,busy=""}:{client?:Row;role?:string;call?:(body:Row)=>Promise<any>;busy?:string}){
  if(!client)return null;
  const enabled=client.automation_enabled===true;
  const canToggle=role==="MGMT"&&!!call;
  return <div className="cfc-mode-strip">
    <div><span>Modo</span><b>{MODE[client.collection_mode]||client.collection_mode}</b></div>
    <div className="cfc-auto-cell"><span>Automação</span><div className="cfc-auto-state"><b className={enabled?"good":"muted"}>{enabled?"Ativa":"Desativada"}</b>{canToggle&&<button className={`cfc-auto-toggle ${enabled?"stop":"start"}`} disabled={!!busy} onClick={()=>{const next=!enabled; if(window.confirm(`${next?"Ativar":"Desativar"} a automação de acompanhamento comercial de ${client.display_name}?`))void call!({action:"set_automation",id:client.id,enabled:next});}}>{busy==="set_automation"?"Salvando…":enabled?"Desativar":"Ativar"}</button>}</div></div>
    {client.group_chat_name&&<div><span>Grupo comercial</span><b>{client.group_chat_name}</b></div>}
    <div><span>Origem principal</span><b>{client.collection_mode==="PLANTAO"?"Colibra + WhatsApp":client.collection_mode==="CRM_INTEGRADO"?"CRM/API":client.collection_mode==="PLANILHA"?"Google Sheets + WhatsApp":"Portal + WhatsApp"}</b></div>
  </div>;
}
function GenericClientPanel({client,data,role,call,busy}:{client:Row;data:Payload;role:string;call:(body:Row)=>Promise<any>;busy:string}){
  const [tab,setTab]=useState("today");
  const days=data.days.filter(d=>d.followup_client_id===client.id).sort((a,b)=>String(b.report_date).localeCompare(String(a.report_date)));
  const latest=days[0];
  const entries=latest?data.entries.filter(e=>e.followup_day_id===latest.id):[];
  const brokers=data.brokers.filter(b=>b.followup_client_id===client.id);
  const active=brokers.filter(b=>b.active!==false);
  const valid=entries.filter(e=>e.status!=="JUSTIFICADO");
  const responded=valid.filter(e=>e.status==="RESPONDIDO").length;
  const partial=valid.filter(e=>e.status==="PARCIAL").length;
  const missing=valid.filter(e=>["AGUARDANDO","NAO_RESPONDEU"].includes(e.status)).length;
  const adherence=valid.length?Math.round(responded*100/valid.length):0;
  return <section className="cfc-client-panel">
    <ClientModeStrip client={client} role={role} call={call} busy={busy}/>
    <header className="cfc-client-head"><div><span>{client.display_name.toUpperCase()}</span><h2>Acompanhamento dos corretores</h2><p>{client.portal_enabled?"Portal do cliente ativo":client.group_chat_name||"Configuração comercial pendente"}</p></div><div className="cfc-client-actions">{role==="MGMT"&&client.group_chat_id&&<button className="secondary" disabled={!!busy} onClick={()=>{if(confirm(`Enviar a cobrança de ${client.display_name} agora?`))void call({action:"send_group_now",followup_client_id:client.id});}}>{client.collection_mode==="PLANILHA"?"Enviar relatório agora":"Enviar cobrança agora"}</button>}</div></header>
    <section className="cfc-kpis"><Kpi label="Corretores" value={active.length}/><Kpi label="Respondidos" value={responded}/><Kpi label="Parciais" value={partial}/><Kpi label="Sem resposta" value={missing} tone={missing?"bad":"good"}/><Kpi label="Adesão" value={`${adherence}%`} tone={adherence>=80?"good":adherence?"warn":""}/></section>
    <nav className="cfc-inner-tabs"><button className={tab==="today"?"active":""} onClick={()=>setTab("today")}>Hoje</button><button className={tab==="history"?"active":""} onClick={()=>setTab("history")}>Histórico</button><button className={tab==="brokers"?"active":""} onClick={()=>setTab("brokers")}>Corretores</button><button className={tab==="config"?"active":""} onClick={()=>setTab("config")}>Configurações</button></nav>
    {tab==="today"&&<TodayPanel client={client} dayRow={latest} entries={entries} call={call} busy={busy}/>} 
    {tab==="history"&&<HistoryPanel client={client} days={days} entries={data.entries} call={call} role={role}/>} 
    {tab==="brokers"&&<BrokersPanel client={client} brokers={brokers} role={role} call={call}/>} 
    {tab==="config"&&<ConfigPanel client={client} data={data} role={role} call={call} busy={busy}/>} 
  </section>;
}

function Kpi({label,value,tone=""}:{label:string;value:any;tone?:string}){return <article className={`cfc-kpi ${tone}`}><span>{label}</span><strong>{value}</strong></article>}
function TodayPanel({client,dayRow,entries,call,busy}:{client:Row;dayRow?:Row;entries:Row[];call:(b:Row)=>Promise<any>;busy:string}){
  if(!dayRow)return <div className="cfc-empty"><b>Nenhum fechamento criado ainda.</b><span>O primeiro ciclo automático será criado no horário configurado.</span></div>;
  const pending=entries.filter(e=>["AGUARDANDO","PARCIAL","NAO_RESPONDEU"].includes(e.status));
  const answered=entries.filter(e=>e.status==="RESPONDIDO");
  return <div className="cfc-today">
    <section className="cfc-day-banner"><div><span>Referência</span><b>{day(dayRow.report_date)}</b></div><div><span>Cobrança</span><b>{dayRow.asked_at?when(dayRow.asked_at):`prevista ${String(client.checkin_time).slice(0,5)}`}</b></div><div><span>Status</span><b>{dayRow.status}</b></div><div><span>Último consolidado</span><b>{dayRow.consolidated_message_id?"Enviado":"Ainda não enviado"}</b></div></section>
    <div className="cfc-two-col"><section className="cfc-card"><header><div><span>PENDÊNCIAS</span><h3>Quem ainda não respondeu</h3></div><b className={pending.length?"count-bad":"count-good"}>{pending.length}</b></header>{pending.length?pending.map(e=><PendingRow key={e.id} entry={e} askedAt={dayRow.asked_at} call={call} busy={busy}/>):<div className="cfc-empty small"><b>Todo mundo em dia.</b><span>Nenhuma pendência neste fechamento.</span></div>}</section>
    <section className="cfc-card"><header><div><span>RESPOSTAS</span><h3>Dados recebidos</h3></div><b>{answered.length}</b></header>{answered.length?answered.map(e=><ResponseCard key={e.id} entry={e} client={client}/>):<div className="cfc-empty small"><b>Aguardando respostas.</b><span>Os dados aparecerão aqui assim que forem registrados no portal, CRM ou WhatsApp.</span></div>}</section></div>
    {dayRow.source_payload?.summary_send_error&&<div className="cfc-warning">Falha no último envio do consolidado: {String(dayRow.source_payload.summary_send_error)}</div>}
  </div>;
}

function PendingRow({entry,askedAt,call,busy}:{entry:Row;askedAt:any;call:(b:Row)=>Promise<any>;busy:string}){
  const b=Array.isArray(entry.commercial_followup_brokers)?entry.commercial_followup_brokers[0]:entry.commercial_followup_brokers||{};
  const label=entry.status==="PARCIAL"?"Resposta parcial":entry.status==="NAO_RESPONDEU"?"Não respondeu":"Aguardando";
  return <article className="cfc-pending-row"><div><b>{b.display_name||"Corretor"}</b><span>{label} · {askedAt?elapsed(askedAt):"ainda não enviado"}</span>{entry.reminder_sent_at&&<small>Lembrete enviado {when(entry.reminder_sent_at)}</small>}</div><button disabled={!!busy} onClick={()=>{const notes=prompt("Motivo da justificativa (ex.: férias até dia 15):"); if(notes)void call({action:"justify_entry",id:entry.id,notes});}}>Justificar</button></article>;
}
function ResponseCard({entry,client}:{entry:Row;client:Row}){
  const b=Array.isArray(entry.commercial_followup_brokers)?entry.commercial_followup_brokers[0]:entry.commercial_followup_brokers||{};
  const keys=(Array.isArray(client.questions)?client.questions:[]).filter((k:string)=>k!=="notes");
  const anomaliesList=Array.isArray(entry.anomalies)?entry.anomalies:[];
  return <article className="cfc-response"><header><div><b>{b.display_name||"Corretor"}</b><span>Respondido {when(entry.responded_at||entry.first_response_at)}</span></div>{anomaliesList.length>0&&<i>⚠ revisar</i>}</header>
    <div className="cfc-metric-grid">{keys.map(k=>{const p=entry.provenance?.[k]; const v=entry.metrics?.[k]; return <div key={k}><span>{METRICS[k]||k}</span><b>{v===undefined||v===null?"—":v}</b>{p&&<small>{p.source==="DECLARADO_WHATSAPP"?"WhatsApp":p.source==="AJUSTE_MANUAL"?"Ajuste manual":p.source==="PLANILHA_GOOGLE"?"Planilha":p.source}</small>}</div>})}</div>
    {entry.notes&&<p>{entry.notes}</p>}
    {anomaliesList.length>0&&<details><summary>Ver pontos para revisão</summary><ul>{anomaliesList.map((a:Row,i:number)=><li key={i}>{a.message}</li>)}</ul></details>}
  </article>;
}

function HistoryPanel({client,days,entries,call,role}:{client:Row;days:Row[];entries:Row[];call:(b:Row)=>Promise<any>;role:string}){
  return <section className="cfc-card cfc-history"><header><div><span>HISTÓRICO</span><h3>Fechamentos recentes</h3></div></header><div className="cfc-table-wrap"><table><thead><tr><th>Data</th><th>Status</th><th>Respondidos</th><th>Pendentes</th><th>Adesão</th><th>Grupo</th></tr></thead><tbody>{days.slice(0,30).map(d=>{const es=entries.filter(e=>e.followup_day_id===d.id); const valid=es.filter(e=>e.status!=="JUSTIFICADO"); const ok=valid.filter(e=>e.status==="RESPONDIDO").length; const pend=valid.length-ok; const adh=valid.length?Math.round(ok*100/valid.length):0; return <tr key={d.id}><td>{day(d.report_date)}</td><td>{d.status}</td><td>{ok}/{valid.length}</td><td>{pend}</td><td>{adh}%</td><td>{d.consolidated_message_id?"✅ enviado":role==="MGMT"&&d.status==="CLOSED"?<button onClick={()=>void call({action:"resend_summary",day_id:d.id})}>Reenviar</button>:"—"}</td></tr>})}</tbody></table></div></section>;
}
function BrokersPanel({client,brokers,role,call}:{client:Row;brokers:Row[];role:string;call:(b:Row)=>Promise<any>}){
  const [name,setName]=useState(""); const [phone,setPhone]=useState("");
  return <section className="cfc-card"><header><div><span>CORRETORES</span><h3>Equipe monitorada</h3></div></header>
    <div className="cfc-broker-list">{brokers.map(b=>{const paused=b.paused_until&&new Date(b.paused_until).getTime()>Date.now();return <article key={b.id}><div><b>{b.display_name}</b><span>{b.phone_e164||"telefone será aprendido pelas respostas do grupo"}</span><small>Último registro legado: {day(b.legacy_last_reported_on)}</small></div><div>{paused?<span className="cfc-pause">Pausado até {when(b.paused_until)}</span>:<span className="cfc-active">Ativo</span>}{["MGMT","CS"].includes(role)&&<button onClick={()=>{if(paused){void call({action:"pause_broker",id:b.id,paused_until:null,pause_reason:null});return;} const until=prompt("Pausar até quando? Use AAAA-MM-DD (deixe vazio para cancelar)"); if(!until)return; const reason=prompt("Motivo (ex.: férias, viagem, afastamento)")||"Pausa operacional"; void call({action:"pause_broker",id:b.id,paused_until:`${until}T23:59:59-03:00`,pause_reason:reason});}}>{paused?"Reativar":"Pausar"}</button>}</div></article>})}</div>
    {role==="MGMT"&&<div className="cfc-add-broker"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Nome do corretor"/><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="WhatsApp (opcional)"/><button disabled={!name.trim()} onClick={async()=>{const ok=await call({action:"upsert_broker",followup_client_id:client.id,display_name:name,phone_e164:phone});if(ok){setName("");setPhone("");}}}>Adicionar corretor</button></div>}
  </section>;
}

const ALL_METRICS=Object.keys(METRICS);
function ConfigPanel({client,data,role,call,busy}:{client:Row;data:Payload;role:string;call:(b:Row)=>Promise<any>;busy:string}){
  const [form,setForm]=useState<Row>({...client,questions:Array.isArray(client.questions)?client.questions:[]});
  useEffect(()=>setForm({...client,questions:Array.isArray(client.questions)?client.questions:[]}),[client]);
  if(role!=="MGMT")return <div className="cfc-empty"><b>Configuração protegida.</b><span>CS pode acompanhar e justificar ausências; mudanças estruturais ficam com MGMT.</span></div>;
  const toggleQ=(k:string)=>setForm((f:Row)=>({...f,questions:f.questions.includes(k)?f.questions.filter((x:string)=>x!==k):[...f.questions,k]}));
  return <section className="cfc-card cfc-config"><header><div><span>CONFIGURAÇÃO</span><h3>Regra deste cliente</h3></div></header>
    <div className="cfc-config-grid">
      <label>Modo de coleta<select value={form.collection_mode||"GRUPO_MANUAL"} onChange={e=>setForm((f:Row)=>({...f,collection_mode:e.target.value}))}><option value="PLANILHA">Planilha + WhatsApp</option><option value="GRUPO_MANUAL">Portal + apoio no WhatsApp</option><option value="CRM_INTEGRADO">CRM integrado</option><option value="HIBRIDO">CRM + portal</option></select></label>
      <label>Horário da cobrança<input type="time" value={String(form.checkin_time||"08:15").slice(0,5)} onChange={e=>setForm((f:Row)=>({...f,checkin_time:e.target.value}))}/></label>
      <label>Lembrete após (min)<input type="number" min="15" step="15" value={form.reminder_after_minutes??120} onChange={e=>setForm((f:Row)=>({...f,reminder_after_minutes:Number(e.target.value)}))}/></label>
      <label>Fechamento após (min)<input type="number" min="30" step="30" value={form.close_after_minutes??240} onChange={e=>setForm((f:Row)=>({...f,close_after_minutes:Number(e.target.value)}))}/></label>
      <label>Grupo comercial<input value={form.group_chat_name||""} onChange={e=>setForm((f:Row)=>({...f,group_chat_name:e.target.value}))} placeholder="Nome do grupo"/></label>
      <label>ID do grupo<input value={form.group_chat_id||""} onChange={e=>setForm((f:Row)=>({...f,group_chat_id:e.target.value}))} placeholder="...-group"/></label>
    </div>
    <div className="cfc-switch-row"><label><input type="checkbox" checked={form.portal_enabled!==false} onChange={e=>setForm((f:Row)=>({...f,portal_enabled:e.target.checked}))}/> Portal do cliente ativo</label><label><input type="checkbox" checked={!!form.automation_enabled} onChange={e=>setForm((f:Row)=>({...f,automation_enabled:e.target.checked}))}/> Cobranças automáticas</label></div>
    <div className="cfc-question-box"><b>Métricas deste cliente</b><div className="cfc-question-grid">{ALL_METRICS.map(k=><label key={k}><input type="checkbox" checked={form.questions.includes(k)} onChange={()=>toggleQ(k)}/><span>{METRICS[k]}</span></label>)}</div></div>
    <div className="cfc-config-actions"><button className="primary" disabled={!!busy} onClick={()=>void call({action:"update_client",id:client.id,collection_mode:form.collection_mode,automation_enabled:!!form.automation_enabled,portal_enabled:form.portal_enabled!==false,group_chat_id:form.group_chat_id||null,group_chat_name:form.group_chat_name||null,checkin_time:form.checkin_time,reminder_after_minutes:Number(form.reminder_after_minutes||120),close_after_minutes:Number(form.close_after_minutes||240),questions:form.questions})}>{busy?"Salvando…":"Salvar configuração"}</button>{form.portal_enabled!==false&&<a className="cfc-portal-link" href={`/commercial-portal?client=${client.slug}`} target="_blank" rel="noreferrer">Abrir portal</a>}</div>
    <PortalAccessPanel client={client} access={(data.portal_access||[]).filter(a=>a.followup_client_id===client.id)} call={call} busy={busy}/>
  </section>;
}

function PortalAccessPanel({client,access,call,busy}:{client:Row;access:Row[];call:(b:Row)=>Promise<any>;busy:string}){
  const [email,setEmail]=useState(""); const [name,setName]=useState(""); const [role,setRole]=useState("MANAGER");
  return <div className="cfc-access-box"><header><div><span>ACESSOS DO PORTAL</span><h4>Usuários do cliente</h4></div><b>{access.filter(a=>a.active!==false).length}</b></header>
    {access.length>0&&<div className="cfc-access-list">{access.map(a=><div key={a.id}><div><b>{a.display_name||a.email}</b><span>{a.email} · {a.portal_role}</span></div><button disabled={!!busy} onClick={()=>void call({action:"set_portal_access_active",id:a.id,active:a.active===false})}>{a.active===false?"Reativar":"Desativar"}</button></div>)}</div>}
    <div className="cfc-access-create"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Nome"/><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="E-mail do gestor"/><select value={role} onChange={e=>setRole(e.target.value)}><option value="OWNER">Proprietário</option><option value="MANAGER">Gestor</option></select><button disabled={!!busy||!email.trim()} onClick={async()=>{const r=await call({action:"provision_portal_user",followup_client_id:client.id,email,display_name:name||email,portal_role:role});if(r){setEmail("");setName("");if(r.temporary_password)alert(`Acesso criado. Senha temporária: ${r.temporary_password}`);}}}>Criar acesso</button></div>
  </div>;
}
function AddClientButton({call}:{call:(b:Row)=>Promise<any>}){
  return <button onClick={()=>{const name=prompt("Nome do cliente"); if(!name?.trim())return; void call({action:"create_client",display_name:name.trim()});}}>Adicionar cliente</button>;
}
