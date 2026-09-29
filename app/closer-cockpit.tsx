"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import { DailyReflection } from "./daily-reflection";

type Row = Record<string, any>;
type View = "home" | "funnel" | "followups" | "calls" | "clients" | "meetings" | "performance" | "playbook";

const API = SUPABASE_URL + "/functions/v1/agency-ops-closer-cockpit-api";
const AWAVE_API = SUPABASE_URL + "/functions/v1/agency-ops-awave-funnel-bridge";
const CALENDAR_API = SUPABASE_URL + "/functions/v1/agency-ops-google-calendar-api";
const STAGES = ["novo","qualificacao","reuniao","proposta","negociacao","fechado","perdido"];
const STAGE_LABEL: Record<string,string> = {novo:"Novo",qualificacao:"Qualificação",reuniao:"Reunião",proposta:"Proposta",negociacao:"Negociação",fechado:"Fechado",perdido:"Perdido"};
const NAV: Array<[View,string]> = [["home","Meu dia"],["funnel","Pipeline"],["followups","Follow-ups"],["calls","Calls & Relato"],["clients","Clientes que fechei"],["meetings","Agenda & reuniões"],["performance","Performance"],["playbook","Playbook"]];

const txt=(v:unknown,f="—")=>String(v??"").trim()||f;
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const num=(v:unknown)=>Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:1});
const money=(v:unknown)=>Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const when=(v:unknown)=>{if(!v)return"—";const d=new Date(String(v));return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",dateStyle:"short",timeStyle:"short"}).format(d);};
const day=(v:unknown)=>{if(!v)return"—";const s=String(v).slice(0,10),p=s.split("-").map(Number);return p.length===3?new Intl.DateTimeFormat("pt-BR").format(new Date(p[0],p[1]-1,p[2])):s;};
const list=(v:unknown)=>Array.isArray(v)?v.join(", "):txt(v,"");
const split=(v:string)=>v.split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean);
const phone=(v:unknown)=>String(v??"").replace(/\D/g,"");

async function post(body:Row){
  const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.detail||data?.error||("API "+response.status));
  return data;
}
async function postAwave(body:Row){
  const response=await authenticatedFetch(AWAVE_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.detail||data?.error||("Awave "+response.status));
  return data;
}
async function postCalendar(body:Row){
  const response=await authenticatedFetch(CALENDAR_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(data?.detail||data?.error||("Google Calendar "+response.status)) as Error&{status?:number;needsGoogle?:boolean};
    error.status=response.status;error.needsGoogle=Boolean(data?.needs_google);throw error;
  }
  return data;
}

function Kpi({label,value,hint,tone=""}:{label:string;value:string;hint:string;tone?:string}){
  return <article className={"cc-kpi "+tone}><span>{label}</span><b>{value}</b><small>{hint}</small></article>;
}

function Score({lead}:{lead:Row}){
  const score=Number(lead.score||0);
  const tone=score>=75?"hot":score>=55?"warm":score>=35?"watch":"cold";
  return <span className={"cc-score "+tone}><b>{score}</b><small>/100</small></span>;
}

function CallCard({call,onOutcome}:{call:Row;onOutcome:(call:Row,outcome:string)=>Promise<void>}){
  const [open,setOpen]=useState(false);
  const [detail,setDetail]=useState<Row|null>(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detailError,setDetailError]=useState("");
  const [current,setCurrent]=useState(0);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const shown=detail?{...call,...detail}:call;
  const segments:Row[]=shown.segments||[];
  const active=useMemo(()=>{let found=-1,ms=current*1000;for(let i=0;i<segments.length;i++){if(ms>=Number(segments[i].started_ms||0))found=i;else break;}return found;},[segments,current]);
  const seek=(ms:number)=>{const el=audioRef.current;if(!el)return;el.currentTime=Math.max(0,ms/1000);void el.play();};
  const toggle=async()=>{
    if(open){setOpen(false);return;}
    setOpen(true);
    if(detail||detailLoading)return;
    setDetailLoading(true);setDetailError("");
    try{
      const data=await post({action:"get_call_detail",call_id:call.id});
      setDetail(data?.call||null);
    }catch(e){setDetailError(e instanceof Error?e.message:"Falha ao carregar a call.");}
    finally{setDetailLoading(false);}
  };
  return <article className="cc-call">
    <div className="cc-call-head">
      <div><span>RELATO AI · {txt(call.sdr_person,"Comercial")}{call.is_test?" · TESTE":call.read_only?" · HISTÓRICO":""}</span><b>{txt(call.remote_name||call.transcript_summary,"Call comercial")}</b><small>{when(call.created_at)} · {call.duration_seconds?Math.round(Number(call.duration_seconds)/60)+" min":"duração não informada"}</small></div>
      <div className="cc-call-actions">
        <select disabled={Boolean(call.read_only)} title={call.read_only?"Histórico: o lead não está mais na carteira atual":undefined} value={String(call.outcome||"")} onChange={e=>void onOutcome(call,e.target.value)}><option value="">Outcome</option><option value="NAO_ATENDEU">Não atendeu</option><option value="REAGENDAMENTO">Reagendamento</option><option value="QUALIFICADO">Qualificado</option><option value="DESQUALIFICADO">Desqualificado</option><option value="REUNIAO_MARCADA">Reunião marcada</option><option value="PROPOSTA">Proposta</option><option value="NEGOCIACAO">Negociação</option><option value="GANHO">Ganho</option><option value="PERDIDO">Perdido</option><option value="TEST_CALL">Teste</option><option value="STABLE">Legado</option></select>
        <button onClick={()=>void toggle()}>{open?"Recolher":"Abrir"}</button>
      </div>
    </div>
    {open&&<div className="cc-call-body">
      {detailLoading?<div className="cc-empty">Carregando áudio e transcrição…</div>:detailError?<div className="cc-error">{detailError}</div>:<>
        {shown.audio?.play_url?<div className="cc-audio"><audio ref={audioRef} controls preload="metadata" src={String(shown.audio.play_url)} onTimeUpdate={e=>setCurrent(e.currentTarget.currentTime||0)}/><a href={String(shown.audio.download_url||shown.audio.play_url)} download>Baixar MP3</a></div>:<div className="cc-empty">Áudio ainda indisponível.</div>}
        <div className="cc-two">
          <section className="cc-mini"><h4>Resumo</h4><p>{txt(shown.transcript_summary||shown.ai_summary,"Sem resumo.")}</p><h4>Próximo passo</h4><p>{txt(shown.next_step,"Não registrado")}</p></section>
          <section className="cc-mini"><h4>Coaching baseado na call</h4>{Array.isArray(shown.coaching)&&shown.coaching.length?<ul>{shown.coaching.map((x:string,i:number)=><li key={i}>{x}</li>)}</ul>:<p>Nenhum alerta de coaching detectado.</p>}<h4>Decisões e compromissos</h4><p>{[...(shown.decisions||[]),...(shown.commitments||[])].map((x:any)=>typeof x==="string"?x:JSON.stringify(x)).join(" · ")||"Nenhum registro estruturado."}</p></section>
        </div>
        {segments.length?<div className="cc-transcript">{segments.map((s:Row,i:number)=><button key={String(s.sequence_no??i)} className={i===active?"active":""} onClick={()=>seek(Number(s.started_ms||0))}><time>{Math.floor(Number(s.started_ms||0)/60000)}:{String(Math.floor(Number(s.started_ms||0)/1000)%60).padStart(2,"0")}</time><span><b>{txt(s.speaker_name,"Participante")}</b>{txt(s.text,"")}</span></button>)}</div>:<pre className="cc-raw">{txt(shown.transcript_text,"Transcrição ainda indisponível.")}</pre>}
      </>}
    </div>}
  </article>;
}

function ProspectModal({lead,close,reload}:{lead:Row;close:()=>void;reload:()=>Promise<void>}){
  const p=lead.prospect_profile||{};
  const [tab,setTab]=useState("precall");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [form,setForm]=useState<Row>({
    primary_pain:p.primary_pain||"",pain_points:list(p.pain_points),goals:list(p.goals),objections:list(p.objections),
    buying_signals:list(p.buying_signals),closing_risks:list(p.closing_risks),decision_role:p.decision_role||"",urgency:p.urgency||"",
    current_structure:p.current_structure||"",marketing_investment:p.marketing_investment||"",qualification_summary:p.qualification_summary||"",
    closer_briefing:p.closer_briefing||"",next_step:p.next_step||"",next_step_at:p.next_step_at?String(p.next_step_at).slice(0,16):"",
    estimated_value:lead.estimated_value||"",monthly:lead.closed_monthly_value||"",setup:lead.closed_setup_value||"",term:lead.closed_term_months||"",payment:lead.closed_setup_payment||""
  });
  const save=async()=>{setBusy(true);setError("");try{await post({action:"update_prospect",lead_id:lead.id,primary_pain:form.primary_pain,pain_points:split(form.pain_points),goals:split(form.goals),objections:split(form.objections),buying_signals:split(form.buying_signals),closing_risks:split(form.closing_risks),decision_role:form.decision_role,urgency:form.urgency,current_structure:form.current_structure,marketing_investment:form.marketing_investment,qualification_summary:form.qualification_summary,closer_briefing:form.closer_briefing,next_step:form.next_step,next_step_at:form.next_step_at?new Date(form.next_step_at).toISOString():null});await post({action:"update_lead",lead_id:lead.id,stage:lead.stage,estimated_value:Number(form.estimated_value||0)});await reload();close();}catch(e){setError(e instanceof Error?e.message:"Falha ao salvar.");}finally{setBusy(false);}};
  const schedule=async(delta:number)=>{setBusy(true);setError("");try{const d=new Date();d.setDate(d.getDate()+delta);d.setHours(10,0,0,0);await post({action:"add_activity",lead_id:lead.id,title:form.next_step||lead.next_best_action||"Follow-up comercial",description:"Cadência criada no cockpit do closer",due_at:d.toISOString(),cadence:String(delta)+"d"});await reload();close();}catch(e){setError(e instanceof Error?e.message:"Falha ao agendar.");}finally{setBusy(false);}};
  const cadence137=async()=>{setBusy(true);setError("");try{await post({action:"create_cadence",lead_id:lead.id,title:form.next_step||lead.next_best_action||"Follow-up comercial"});await reload();close();}catch(e){setError(e instanceof Error?e.message:"Falha ao criar cadência.");}finally{setBusy(false);}};
  const changeStage=async(stage:string)=>{setBusy(true);setError("");try{
    if(lead.awave_deal_id&&(stage==="perdido"||stage==="fechado")){
      if(stage==="perdido"){const reason=window.prompt("Motivo da perda:");if(!reason){setBusy(false);return;}await postAwave({action:"mark_lost",negocio_id:lead.awave_deal_id,motivo:reason});}
      else await postAwave({action:"mark_won",negocio_id:lead.awave_deal_id});
    } else if(stage==="perdido"){const reason=window.prompt("Motivo da perda:");if(!reason){setBusy(false);return;}await post({action:"update_lead",lead_id:lead.id,stage,loss_reason:reason});}
    else if(stage==="fechado"){await post({action:"update_lead",lead_id:lead.id,stage,closed_monthly_value:Number(form.monthly),closed_setup_value:Number(form.setup),closed_term_months:Number(form.term),closed_setup_payment:form.payment});}
    else await post({action:"update_lead",lead_id:lead.id,stage,estimated_value:Number(form.estimated_value||0)});
    await reload();close();
  }catch(e){setError(e instanceof Error?e.message:"Falha ao atualizar.");}finally{setBusy(false);}};
  const digits=phone(lead.phone);
  const waMessage=lead.stage==="proposta"
    ?"Olá, "+txt(lead.name||lead.company,"")+"! Queria alinhar seu retorno sobre a proposta e combinar o próximo passo."
    :lead.stage==="negociacao"
      ?"Olá, "+txt(lead.name||lead.company,"")+"! Vamos alinhar os pontos pendentes para avançarmos na negociação?"
      :lead.stage==="reuniao"
        ?"Olá, "+txt(lead.name||lead.company,"")+"! Passando para confirmar nossa reunião e deixar o próximo passo alinhado."
        :"Olá, "+txt(lead.name||lead.company,"")+"! Passando para alinharmos o próximo passo: "+txt(form.next_step||lead.next_best_action,"seguirmos com a conversa")+".";
  const wa=digits?"https://wa.me/"+digits+"?text="+encodeURIComponent(waMessage):"";
  const client=lead.client_outcome;
  return <div className="cc-modal-bg" onMouseDown={e=>{if(e.currentTarget===e.target)close();}}><section className="cc-modal">
    <header><div><span>PROSPECT 360</span><h2>{txt(lead.company||lead.name)}</h2><p>{txt(lead.phone)} · {txt(lead.email)} · {txt(lead.source,"origem não informada")}</p></div><div><Score lead={lead}/><button className="cc-close" onClick={close}>×</button></div></header>
    <nav>{[["precall","Pré-call"],["qualification","Qualificação"],["calls","Calls"],["followup","Follow-up"],["closing","Fechamento"]].map(([k,l])=><button key={k} className={tab===k?"active":""} onClick={()=>setTab(k)}>{l}</button>)}</nav>
    <div className="cc-modal-body">
      {tab==="precall"&&<div className="cc-two"><section className="cc-mini"><h3>Briefing antes da call</h3><p>{txt(p.closer_briefing||p.qualification_summary||lead.last_call?.transcript_summary,"Ainda não há briefing automático.")}</p><dl><dt>Dor</dt><dd>{txt(p.primary_pain||list(p.pain_points))}</dd><dt>Objetivos</dt><dd>{txt(list(p.goals))}</dd><dt>Decisor</dt><dd>{txt(p.decision_role)}</dd><dt>Urgência</dt><dd>{txt(p.urgency)}</dd><dt>Investimento</dt><dd>{txt(p.marketing_investment||lead.orcamento_mkt)}</dd><dt>Próximo passo</dt><dd>{txt(p.next_step||lead.next_best_action)}</dd></dl></section><section className="cc-mini"><h3>Próxima melhor ação</h3><strong className="cc-next">{txt(lead.next_best_action)}</strong><p>{(lead.score_reasons||[]).join(" · ")||"Score calculado com estágio e atividade registrada."}</p><div className="cc-buttons">{wa&&<a href={wa} target="_blank" rel="noreferrer">Abrir WhatsApp</a>}<button onClick={()=>void schedule(1)}>Amanhã</button><button onClick={()=>void schedule(3)}>3 dias</button><button onClick={()=>void schedule(7)}>7 dias</button><button className="primary" onClick={()=>void cadence137()}>Cadência 1/3/7</button></div>{client&&<div className="cc-win"><b>Venda vinculada</b><span>{txt(client.display_name)} · {txt(client.lifecycle)}</span><small>Contrato: {txt(client.contract?.contract_state||client.contract?.document_status,"sem status")}</small></div>}</section></div>}
      {tab==="qualification"&&<div className="cc-form"><label>Dor principal<input value={form.primary_pain} onChange={e=>setForm({...form,primary_pain:e.target.value})}/></label><label>Decisor<input value={form.decision_role} onChange={e=>setForm({...form,decision_role:e.target.value})}/></label><label>Urgência<input value={form.urgency} onChange={e=>setForm({...form,urgency:e.target.value})}/></label><label>Investimento atual<input value={form.marketing_investment} onChange={e=>setForm({...form,marketing_investment:e.target.value})}/></label><label className="wide">Dores<textarea value={form.pain_points} onChange={e=>setForm({...form,pain_points:e.target.value})}/></label><label className="wide">Objetivos<textarea value={form.goals} onChange={e=>setForm({...form,goals:e.target.value})}/></label><label className="wide">Objeções<textarea value={form.objections} onChange={e=>setForm({...form,objections:e.target.value})}/></label><label className="wide">Sinais de compra<textarea value={form.buying_signals} onChange={e=>setForm({...form,buying_signals:e.target.value})}/></label><label className="wide">Riscos de fechamento<textarea value={form.closing_risks} onChange={e=>setForm({...form,closing_risks:e.target.value})}/></label><label className="wide">Resumo de qualificação<textarea value={form.qualification_summary} onChange={e=>setForm({...form,qualification_summary:e.target.value})}/></label><label className="wide">Briefing do closer<textarea value={form.closer_briefing} onChange={e=>setForm({...form,closer_briefing:e.target.value})}/></label></div>}
      {tab==="calls"&&<div className="cc-call-list">{(lead.calls||[]).length?(lead.calls||[]).map((c:Row)=><CallCard key={c.id} call={c} onOutcome={async(call,outcome)=>{await post({action:"update_call_outcome",call_id:call.id,outcome});await reload();}}/>):<div className="cc-empty">Nenhuma call vinculada.</div>}</div>}
      {tab==="followup"&&<div className="cc-two"><section className="cc-mini"><h3>Próximo passo</h3><label>Ação<input value={form.next_step} onChange={e=>setForm({...form,next_step:e.target.value})}/></label><label>Data e hora<input type="datetime-local" value={form.next_step_at} onChange={e=>setForm({...form,next_step_at:e.target.value})}/></label><div className="cc-buttons"><button onClick={()=>void schedule(1)}>Amanhã</button><button onClick={()=>void schedule(3)}>3 dias</button><button onClick={()=>void schedule(7)}>7 dias</button></div></section><section className="cc-mini"><h3>Histórico</h3>{(lead.activities||[]).map((a:Row)=><article className="cc-history" key={a.id}><b>{txt(a.title)}</b><small>{a.completed_at?"Concluído "+when(a.completed_at):a.due_at?"Prazo "+when(a.due_at):"Sem data"} · {txt(a.source)}</small></article>)}</section></div>}
      {tab==="closing"&&<div className="cc-two"><section className="cc-mini"><h3>Etapa e forecast</h3><label>Valor estimado<input type="number" value={form.estimated_value} onChange={e=>setForm({...form,estimated_value:e.target.value})}/></label>{lead.awave_deal_id?<p className="cc-note">A etapa intermediária é controlada pelo funil real do Awave. Mova o card na aba Pipeline.</p>:<div className="cc-stage-buttons">{STAGES.filter(s=>s!=="fechado"&&s!=="perdido").map(s=><button key={s} className={lead.stage===s?"active":""} onClick={()=>void changeStage(s)}>{STAGE_LABEL[s]}</button>)}</div>}<button className="danger" onClick={()=>void changeStage("perdido")}>Marcar perdido</button></section><section className="cc-mini"><h3>Fechar como ganho</h3><label>Mensalidade<input type="number" value={form.monthly} onChange={e=>setForm({...form,monthly:e.target.value})}/></label><label>Implementação<input type="number" value={form.setup} onChange={e=>setForm({...form,setup:e.target.value})}/></label><label>Prazo (meses)<input type="number" value={form.term} onChange={e=>setForm({...form,term:e.target.value})}/></label><label>Pagamento da implementação<input value={form.payment} onChange={e=>setForm({...form,payment:e.target.value})}/></label><button className="primary" onClick={()=>void changeStage("fechado")}>Confirmar fechamento</button></section></div>}
      {error&&<div className="cc-error">{error}</div>}
    </div>
    <footer><span>{busy?"Salvando…":"Tudo aqui é restrito ao pipeline do próprio closer."}</span><button disabled={busy} onClick={()=>void save()}>Salvar prospect</button></footer>
  </section></div>;
}

export default function CloserCockpit({session}:{session:Session}){
  const [view,setView]=useState<View>("home");
  const [data,setData]=useState<Row>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [selected,setSelected]=useState<Row|null>(null);
  const [search,setSearch]=useState("");
  const [searchOpen,setSearchOpen]=useState(false);
  const [awave,setAwave]=useState<Row>({});
  const [awaveLoading,setAwaveLoading]=useState(true);
  const [awaveError,setAwaveError]=useState("");
  const [pipelineId,setPipelineId]=useState("");
  const [calendar,setCalendar]=useState<Row>({events:[]});
  const [calendarLoading,setCalendarLoading]=useState(false);
  const [calendarError,setCalendarError]=useState("");
  const [clientFilter,setClientFilter]=useState<"ACTIVE"|"ONBOARDING"|"CHURNED"|"ALL">("ACTIVE");

  const load=useCallback(async()=>{setLoading(true);setError("");try{const r=await authenticatedFetch(API,{cache:"no-store"}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j?.detail||j?.error||("API "+r.status));setData(j);}catch(e){setError(e instanceof Error?e.message:"Falha ao carregar o cockpit.");}finally{setLoading(false);}},[]);
  const loadAwave=useCallback(async()=>{setAwaveLoading(true);setAwaveError("");try{const r=await authenticatedFetch(AWAVE_API,{cache:"no-store"}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j?.detail||j?.error||("Awave "+r.status));setAwave(j);setPipelineId((old)=>old||String(j.primary_pipeline_id||j.pipelines?.[0]?.id||""));}catch(e){setAwaveError(e instanceof Error?e.message:"Falha ao sincronizar Awave.");}finally{setAwaveLoading(false);}},[]);
  const loadCalendar=useCallback(async()=>{setCalendarLoading(true);setCalendarError("");try{const status=await postCalendar({action:"status"});if(status?.account?.status!=="ACTIVE"){setCalendar({...status,events:[]});return;}const listing=await postCalendar({action:"list_events",days_past:1,days_ahead:90,limit:150});setCalendar({...status,...listing,account:listing.account||status.account,events:Array.isArray(listing.events)?listing.events:[]});}catch(e){const message=e instanceof Error?e.message:"Falha ao carregar o Google Agenda.";setCalendarError(message);setCalendar((current:Row)=>({...current,events:current.events||[]}));}finally{setCalendarLoading(false);}},[]);
  const connectCalendar=useCallback(async()=>{setCalendarLoading(true);setCalendarError("");const popup=window.open("about:blank","google-calendar-oauth","popup,width=620,height=760");try{const start=await postCalendar({action:"start_oauth"});if(!start?.url)throw new Error("Google OAuth sem URL.");if(popup)popup.location.href=String(start.url);else window.open(String(start.url),"_blank");let tries=0;const id=window.setInterval(async()=>{tries++;try{const status=await postCalendar({action:"status"});if(status?.account?.status==="ACTIVE"){window.clearInterval(id);try{popup?.close();}catch{}await loadCalendar();return;}}catch{}if(tries>=60){window.clearInterval(id);setCalendarLoading(false);setCalendarError("A conexão do Google não foi concluída.");}},2000);}catch(e){try{popup?.close();}catch{}setCalendarLoading(false);setCalendarError(e instanceof Error?e.message:"Falha ao conectar o Google Agenda.");}},[loadCalendar]);
  useEffect(()=>{void load();const id=window.setInterval(()=>void load(),60000);return()=>window.clearInterval(id);},[load]);
  useEffect(()=>{void loadAwave();const id=window.setInterval(()=>void loadAwave(),view==="funnel"?3000:30000);return()=>window.clearInterval(id);},[loadAwave,view]);
  useEffect(()=>{if(view!=="meetings")return;void loadCalendar();const id=window.setInterval(()=>void loadCalendar(),60000);return()=>window.clearInterval(id);},[view,loadCalendar]);

  const leads:Row[]=data.leads||[],clients:Row[]=data.portfolio_clients||[],calls:Row[]=data.commercial_calls||[],activities:Row[]=data.commercial_activities||[];
  const clientCounts={ACTIVE:clients.filter(c=>c.lifecycle==="ACTIVE").length,ONBOARDING:clients.filter(c=>c.lifecycle==="ONBOARDING").length,CHURNED:clients.filter(c=>c.lifecycle==="CHURNED").length};
  const visibleClients=clientFilter==="ALL"?clients:clients.filter(c=>c.lifecycle===clientFilter);
  const summary=data.summary||{},quality=data.data_quality||{},awaveSummary=awave.summary||{};
  const awavePipelines:Row[]=awave.pipelines||[],awaveStages:Row[]=awave.stages||[],awaveDeals:Row[]=awave.deals||[];

  const results=useMemo(()=>{const q=norm(search);if(!q)return[];const out:any[]=[];for(const l of leads)out.push({kind:"Lead",label:txt(l.company||l.name),sub:txt(l.stage),lead:l});for(const c of clients)out.push({kind:"Cliente",label:txt(c.display_name),sub:txt(c.lifecycle)});for(const c of calls){const l=leads.find(x=>String(x.id)===String(c.lead_id));out.push({kind:"Call",label:txt(c.remote_name||c.transcript_summary,"Call"),sub:when(c.created_at),lead:l});}return out.filter(x=>norm(x.label+" "+x.sub).includes(q)).slice(0,12);},[search,leads,clients,calls]);

  const move=async(lead:Row,stage:string)=>{if(stage==="fechado"){setSelected(lead);return;}try{if(stage==="perdido"){const reason=window.prompt("Motivo da perda:");if(!reason)return;await post({action:"update_lead",lead_id:lead.id,stage,loss_reason:reason});}else await post({action:"update_lead",lead_id:lead.id,stage,estimated_value:lead.estimated_value});await load();}catch(e){window.alert(e instanceof Error?e.message:"Falha ao mover.");}};
  const complete=async(a:Row)=>{try{await post({action:"complete_activity",activity_id:a.id});await load();}catch(e){window.alert(e instanceof Error?e.message:"Falha ao concluir.");}};
  const outcome=async(call:Row,value:string)=>{if(!value)return;try{await post({action:"update_call_outcome",call_id:call.id,outcome:value});await load();}catch(e){window.alert(e instanceof Error?e.message:"Falha ao atualizar outcome.");}};

  const home=<div className="cc-stack"><DailyReflection token={session.access_token}/><section className="cc-kpis"><Kpi label="Ações agora" value={String((data.my_day||[]).length)} hint="prioridades automáticas" tone="accent"/><Kpi label="Awave abertos" value={String(awaveSummary.open??"—")} hint={String(awaveSummary.matched_crm||0)+" vinculados ao Relato"}/><Kpi label="Fechados · 30d" value={String(summary.canonical_closed_30d||0)} hint="base canônica"/><Kpi label="Follow-ups vencidos" value={String(summary.followups_overdue||0)} hint="ação necessária"/><Kpi label="Valor no Awave" value={money(awaveSummary.total_value||0)} hint={String(awaveSummary.total||0)+" negócios atribuídos"}/><Kpi label="Calls · 30d" value={String(summary.calls_30d||0)} hint="Relato AI"/></section><section className="cc-panel"><div className="cc-section-head"><div><span>MEU DIA</span><h2>O que precisa da sua atenção</h2></div><b>{(data.my_day||[]).length} ações</b></div><div className="cc-today">{(data.my_day||[]).slice(0,16).map((x:Row,i:number)=><button key={i} onClick={()=>{const l=leads.find(v=>String(v.id)===String(x.lead_id));if(l)setSelected(l);}}><i className={String(x.type||"").toLowerCase()}/><div><b>{txt(x.title)}</b><small>{txt(x.action)} · {txt(x.detail,"")}{x.due_at?" · "+when(x.due_at):""}</small></div><strong>›</strong></button>)}{!(data.my_day||[]).length&&<div className="cc-empty">Nenhuma prioridade automática agora.</div>}</div></section><div className="cc-two"><section className="cc-panel"><div className="cc-section-head"><div><span>PIPELINE</span><h3>Oportunidades mais quentes</h3></div></div>{leads.filter(l=>!["fechado","perdido"].includes(l.stage)).slice(0,8).map(l=><button className="cc-lead-row" key={l.id} onClick={()=>setSelected(l)}><Score lead={l}/><span><b>{txt(l.company||l.name)}</b><small>{STAGE_LABEL[l.stage]||l.stage} · {txt(l.next_best_action)}</small></span><strong>{Number(l.estimated_value)?money(l.estimated_value):"sem valor"}</strong></button>)}</section><section className="cc-panel"><div className="cc-section-head"><div><span>QUALIDADE DA VENDA</span><h3>Depois do fechamento</h3></div></div><div className="cc-quality"><article><b>{summary.active_clients||0}</b><span>ativos/onboarding</span></article><article><b>{summary.churned_clients||0}</b><span>churns</span></article><article><b>{summary.retention_30_pct==null?"—":summary.retention_30_pct+"%"}</b><span>retenção 30d</span></article><article><b>{summary.quick_churn_under_30||0}</b><span>churn &lt;30d</span></article></div><p className="cc-note">{quality.reconciliation_pending||0} venda(s) histórica(s) ainda sem vínculo exato com um lead. O KPI de vendas continua correto porque usa a base canônica de clientes.</p></section></div></div>;

  const pipelineStages=awaveStages.filter(s=>String(s.pipeline_id)===String(pipelineId)).sort((a,b)=>Number(a.ordem||0)-Number(b.ordem||0));
  const pipelineDeals=awaveDeals.filter(d=>String(d.pipeline_id)===String(pipelineId));
  const openAwave=(d:Row)=>String(d.status||"aberto")==="aberto";
  const openAwaveDeal=(d:Row)=>{const base=leads.find(l=>String(l.id)===String(d.crm_lead_id));if(base)setSelected({...base,awave_deal_id:d.id,awave_stage_id:d.etapa_id,awave_source:true});else window.open("https://crmoficial-crmoficial.yb4hto.easypanel.host/negocios/"+String(d.id),"_blank","noopener,noreferrer");};
  const moveAwave=async(d:Row,stageId:string)=>{if(!openAwave(d))return;try{await postAwave({action:"move_stage",negocio_id:d.id,etapa_id:stageId});await loadAwave();}catch(e){window.alert(e instanceof Error?e.message:"Falha ao mover no Awave.");}};
  const funnel=<section className="cc-board-wrap"><div className="cc-section-head"><div><span>AWAVE · TEMPO REAL</span><h2>Funil Comercial</h2><p>Esta tela usa os próprios negócios, pipelines e etapas do Awave. Alterações feitas aqui gravam direto no CRM.</p></div><div className="cc-awave-head"><select value={pipelineId} onChange={e=>setPipelineId(e.target.value)}>{awavePipelines.map(p=><option key={p.id} value={p.id}>{txt(p.nome)}</option>)}</select><b>{pipelineDeals.length} negócios</b><small className={awaveError?"bad":"ok"}>{awaveLoading?"Sincronizando…":awaveError?"Awave indisponível":"Ao vivo · atualiza em até 3s"}</small></div></div>{awaveError&&<div className="cc-error">{awaveError}</div>}<div className="cc-board awave-board">{pipelineStages.map(stage=><section className="cc-lane" key={stage.id} onDragOver={e=>e.preventDefault()} onDrop={e=>{const id=e.dataTransfer.getData("awave-deal");const d=pipelineDeals.find(x=>String(x.id)===id);if(d)void moveAwave(d,String(stage.id));}}><header><span>{txt(stage.nome)}</span><b>{pipelineDeals.filter(d=>String(d.etapa_id)===String(stage.id)).length}</b></header>{pipelineDeals.filter(d=>String(d.etapa_id)===String(stage.id)).map(d=><article key={d.id} draggable={openAwave(d)} onDragStart={e=>e.dataTransfer.setData("awave-deal",String(d.id))} onClick={()=>openAwaveDeal(d)} className={!openAwave(d)?"closed":""}><div><b>{txt(d.empresa?.nome||d.titulo)}</b><span className={"cc-awave-status "+String(d.status||"aberto")}>{String(d.status||"aberto")==="ganho"?"GANHO":String(d.status||"aberto")==="perdido"?"PERDIDO":d.sem_recurso?"SEM RECURSO":"ABERTO"}</span></div><p>{txt(d.contato?.nome||d.titulo)}{d.contato?.telefone?" · "+txt(d.contato.telefone):""}</p><footer><span>{d.crm_lead_id?"Relato/CRM vinculado":"Awave canônico"}</span><strong>{Number(d.valor)?money(d.valor):"sem valor"}</strong></footer></article>)}</section>)}</div>{!pipelineStages.length&&!awaveLoading&&<div className="cc-empty">Nenhuma etapa retornada pelo Awave para este funil.</div>}</section>;

  const followups=<section className="cc-panel"><div className="cc-section-head"><div><span>CADÊNCIA</span><h2>Follow-ups</h2><p>Vencidos primeiro. Pós-call sem data também vira pendência.</p></div></div><div className="cc-followups">{activities.filter(a=>!a.completed_at).sort((a,b)=>Date.parse(String(a.due_at||"2999"))-Date.parse(String(b.due_at||"2999"))).map(a=>{const l=leads.find(x=>String(x.id)===String(a.lead_id)),late=a.due_at&&Date.parse(String(a.due_at))<Date.now();return <article key={a.id} className={late?"late":a.due_at?"dated":"undated"}><div><span>{late?"VENCIDO":a.due_at?when(a.due_at):"SEM DATA"}</span><b>{txt(l?.company||l?.name,"Prospect")}</b><p>{txt(a.title)}</p><small>{txt(a.description,"")} · {txt(a.source)}</small></div><div><button onClick={()=>l&&setSelected(l)}>Abrir</button><button className="primary" onClick={()=>void complete(a)}>Concluir</button></div></article>})}{!activities.some(a=>!a.completed_at)&&<div className="cc-empty">Nenhum follow-up aberto.</div>}</div></section>;

  const callsView=<section className="cc-stack"><div className="cc-section-head"><div><span>RELATO AI</span><h2>Calls do handoff e comerciais</h2><p>Áudio, transcrição sincronizada, resumo, outcome, próximo passo e coaching.</p></div><b>{calls.length} calls</b></div><div className="cc-call-list">{calls.map(c=><CallCard key={c.id} call={c} onOutcome={outcome}/>)}</div></section>;

  const clientsView=<section className="cc-panel"><div className="cc-section-head"><div><span>CARTEIRA DO CLOSER</span><h2>Clientes que eu fechei</h2><p>Histórico canônico por closer de origem, separado por situação atual.</p></div><b>{clients.length} clientes</b></div><div className="cc-buttons" style={{marginBottom:14,flexWrap:"wrap"}}><button className={clientFilter==="ACTIVE"?"primary":""} onClick={()=>setClientFilter("ACTIVE")}>Ativos ({clientCounts.ACTIVE})</button><button className={clientFilter==="ONBOARDING"?"primary":""} onClick={()=>setClientFilter("ONBOARDING")}>Onboarding ({clientCounts.ONBOARDING})</button><button className={clientFilter==="CHURNED"?"primary":""} onClick={()=>setClientFilter("CHURNED")}>Churn ({clientCounts.CHURNED})</button><button className={clientFilter==="ALL"?"primary":""} onClick={()=>setClientFilter("ALL")}>Todos ({clients.length})</button></div><div className="cc-table"><table><thead><tr><th>Cliente</th><th>Status</th><th>Entrada</th><th>Tempo</th><th>Contrato</th><th>Campanha</th><th>Handoff</th></tr></thead><tbody>{visibleClients.map(c=><tr key={c.client_id}><td><b>{txt(c.display_name)}</b><small>{txt(c.service)}</small></td><td>{c.lifecycle==="ACTIVE"?"ATIVO":c.lifecycle==="ONBOARDING"?"ONBOARDING":c.lifecycle==="CHURNED"?"CHURN":"—"}</td><td>{day(c.entrada)}</td><td>{c.client_days==null?"—":c.client_days+"d"}</td><td>{txt(c.contract?.contract_state||c.contract?.document_status,"não vinculado")}</td><td>{c.campaign?String(c.campaign.active_campaigns||0)+" ativas":"sem campanha ativa"}</td><td>{c.handoff?<><b>{txt(c.handoff.urgency,"registrado")}</b><small>{txt(list(c.handoff.objections),"sem objeção")}</small></>:"—"}</td></tr>)}{!visibleClients.length&&<tr><td colSpan={7}><div className="cc-empty">Nenhum cliente neste filtro.</div></td></tr>}</tbody></table></div></section>;

  const googleAgenda:Row[]=(Array.isArray(calendar.events)?calendar.events:[]).map((e:Row)=>({id:"gcal:"+String(e.id),calendar_event_id:e.id,scheduled_for:e.start_time,calendar_title:e.title,meet_url:e.meet_url,calendar_html_link:e.html_link,chat_name:"Google Agenda",calendar_sync_status:"GOOGLE",source_label:"Google Agenda"}));
  const internalAgenda:Row[]=(data.agenda_events||[]).map((e:Row)=>({...e,id:"internal:"+String(e.id),source_label:"Agenda interna"}));
  const upcomingAgenda=[...googleAgenda,...internalAgenda].filter((e:Row)=>Date.parse(String(e.scheduled_for||""))>=Date.now()-86400000).sort((a:Row,b:Row)=>Date.parse(String(a.scheduled_for||""))-Date.parse(String(b.scheduled_for||""))).filter((e:Row,i:number,rows:Row[])=>rows.findIndex((x:Row)=>String(x.calendar_event_id||"")&&String(x.calendar_event_id)===String(e.calendar_event_id||""))===i||!e.calendar_event_id).slice(0,30);
  const donnah=data.integrations?.donnah||{};
  const googleConnected=calendar?.account?.status==="ACTIVE";
  const meetingsView=<div className="cc-stack"><section className="cc-integration-strip"><article className={donnah?.enabled&&donnah?.last_sync_status==="OK"?"ok":"warn"}><span>DONNAH / RELATO</span><b>{donnah?.enabled?"Conectado":"Não conectado"}</b><small>{donnah?.last_sync_at?"Último sync "+when(donnah.last_sync_at):"Sem sincronização registrada"}{donnah?.transcripts_ingested!=null?" · "+String(donnah.transcripts_ingested)+" transcrições":""}</small></article><article className={googleConnected?"ok":"warn"}><span>GOOGLE AGENDA</span><b>{googleConnected?"Conectado":"Conexão pendente"}</b><small>{googleConnected?txt(calendar.account?.account_email||calendar.account?.display_name,"Conta Google"):"Conecte a conta Google do próprio Vitor para importar os compromissos futuros."}</small>{!googleConnected&&<button onClick={()=>void connectCalendar()} disabled={calendarLoading}>{calendarLoading?"Conectando…":"Conectar Google Agenda"}</button>}{googleConnected&&<button onClick={()=>void loadCalendar()} disabled={calendarLoading}>{calendarLoading?"Atualizando…":"Atualizar agenda"}</button>}</article></section>{calendarError&&<div className="cc-error">{calendarError}</div>}<div className="cc-two"><section className="cc-panel"><div className="cc-section-head"><div><span>AGENDA</span><h2>Próximos compromissos</h2><p>Google Agenda do Vitor + reuniões internas detectadas.</p></div><b>{upcomingAgenda.length}</b></div>{upcomingAgenda.map((e:Row)=><article className="cc-meeting" key={String(e.id)}><time>{when(e.scheduled_for)}</time><div><b>{txt(e.calendar_title||e.topic)}</b><small>{txt(e.source_label||e.chat_name)}{e.chat_name&&e.source_label!=="Google Agenda"?" · "+txt(e.chat_name):""}</small></div>{e.meet_url?<a target="_blank" rel="noreferrer" href={String(e.meet_url)}>Meet</a>:e.calendar_html_link?<a target="_blank" rel="noreferrer" href={String(e.calendar_html_link)}>Agenda</a>:null}</article>)}{!upcomingAgenda.length&&!calendarLoading&&<div className="cc-empty">{googleConnected?"Nenhum compromisso futuro encontrado no Google Agenda.":"Google Agenda ainda não conectado. As reuniões já gravadas no Donnah continuam aparecendo ao lado."}</div>}</section><section className="cc-panel"><div className="cc-section-head"><div><span>RELATO AI · DONNAH</span><h2>Reuniões registradas</h2><p>Transcrições atribuídas ao Vitor.</p></div><b>{(data.meetings||[]).length}</b></div>{(data.meetings||[]).slice(0,50).map((m:Row)=><article className="cc-meeting" key={m.id}><time>{when(m.meeting_started_at)}</time><div><b>{txt(m.metadata?.donnah_title||m.client_name_raw||"Reunião comercial")}</b><small>{txt(m.summary,"Sem resumo")}</small></div></article>)}{!(data.meetings||[]).length&&<div className="cc-empty">Nenhuma reunião do Donnah encontrada para este closer.</div>}</section></div></div>;

  const performance=<div className="cc-stack"><section className="cc-kpis"><Kpi label="Fechados no mês" value={String(summary.canonical_closed_month||0)} hint={"mês anterior: "+String(summary.canonical_closed_prev_month||0)}/><Kpi label="Calls · 30d" value={String(summary.calls_30d||0)} hint={"30d anteriores: "+String(summary.calls_prev_30d||0)+" · testes fora"}/><Kpi label="Leads · 30d" value={String(summary.new_leads_30d||0)} hint={"30d anteriores: "+String(summary.new_leads_prev_30d||0)}/><Kpi label="Retenção 30d" value={summary.retention_30_pct==null?"—":summary.retention_30_pct+"%"} hint="qualidade pós-venda"/><Kpi label="Handoff documentado" value={String(summary.handoff_coverage_pct||0)+"%"} hint={String(summary.precall_briefing_calls||0)+" calls com briefing"}/><Kpi label="Reconciliação" value={String(summary.reconciliation_pending||0)} hint="vendas sem lead exato"/></section><div className="cc-two"><section className="cc-panel"><h3>Origem dos leads</h3>{(data.source_performance||[]).map((r:Row)=><div className="cc-stat" key={r.source}><span><b>{txt(r.source)}</b><small>{r.open} abertos · {r.advanced} avançados</small></span><strong>{r.leads} leads · {r.linked_wins} ganhos ligados</strong></div>)}</section><section className="cc-panel"><h3>Objeções registradas</h3>{(data.objection_summary||[]).map((r:Row)=><div className="cc-stat" key={r.label}><span><b>{txt(r.label)}</b></span><strong>{r.count}</strong></div>)}</section></div><div className="cc-two"><section className="cc-panel"><h3>Meta do mês</h3>{data.current_goal?<div className="cc-quality"><article><b>{summary.canonical_closed_month||0}/{data.current_goal.meta_clientes||0}</b><span>clientes</span></article><article><b>{money(data.current_goal.meta_mensalidade)}</b><span>mensalidade</span></article><article><b>{money(data.current_goal.meta_implementacao)}</b><span>implementação</span></article></div>:<div className="cc-empty">Meta do Vitor ainda não cadastrada pela gestão.</div>}</section><section className="cc-panel"><h3>Higiene do CRM</h3><div className="cc-quality"><article><b>{quality.stale_7d||0}</b><span>parados 7d+</span></article><article><b>{quality.missing_estimated_value||0}</b><span>sem valor</span></article><article><b>{quality.activities||0}</b><span>atividades</span></article><article><b>{quality.production_calls??quality.calls??0}</b><span>calls válidas</span></article></div></section></div><section className="cc-panel"><div className="cc-section-head"><div><span>RECUPERAÇÃO</span><h3>Perdas recuperáveis</h3></div><b>{(data.recoverable_losses||[]).length}</b></div>{(data.recoverable_losses||[]).length?(data.recoverable_losses||[]).map((r:Row)=><button className="cc-lead-row" key={r.lead_id} onClick={()=>{const l=leads.find(x=>String(x.id)===String(r.lead_id));if(l)setSelected(l);}}><span><b>{txt(r.name)}</b><small>{txt(r.loss_reason)} · {txt(r.next_best_action)}</small></span><strong>{r.days_since_update}d</strong></button>):<div className="cc-empty">Nenhuma perda recuperável identificada agora.</div>}</section></div>;

  const playbook=<div className="cc-two">{Object.entries(data.playbook||{}).map(([k,v])=><section className="cc-panel" key={k}><span className="cc-eyebrow">{({pre_call:"ANTES DA CALL",price_objection:"OBJEÇÃO DE PREÇO",thinking:"VOU PENSAR",partner:"PRECISO FALAR COM SÓCIO"} as Row)[k]||k}</span><h3>{({pre_call:"Checklist de preparação",price_objection:"Como trabalhar preço",thinking:"Transformar “vou pensar” em próximo passo",partner:"Como envolver o decisor"} as Row)[k]||k}</h3><ol>{(v as string[]).map((x,i)=><li key={i}>{x}</li>)}</ol></section>)}</div>;

  const content={home,funnel,followups,calls:callsView,clients:clientsView,meetings:meetingsView,performance,playbook}[view];

  return <div className="cc-root"><aside className="cc-side"><div className="cc-brand"><BrandMark/><span><b>Leonardo Imobi</b><small>Closer cockpit</small></span></div><nav>{NAV.map(([k,l])=><button key={k} className={view===k?"active":""} onClick={()=>setView(k)}>{l}{k==="followups"&&summary.followups_overdue?<em>{summary.followups_overdue}</em>:null}</button>)}</nav><div className="cc-person"><span>Perfil</span><b>{txt(data.profile?.person,"Vitor Feitoza")}</b><small>Somente pipeline próprio</small></div></aside><main className="cc-main"><header className="cc-top"><div><span>COCKPIT DE FECHAMENTO</span><h1>{NAV.find(([k])=>k===view)?.[1]}</h1><p>Prioridades, pipeline, Relato AI, follow-up e qualidade da venda.</p></div><div className="cc-top-actions"><div className="cc-search"><input value={search} onFocus={()=>setSearchOpen(true)} onChange={e=>{setSearch(e.target.value);setSearchOpen(true);}} placeholder="Buscar prospect, cliente ou call"/>{searchOpen&&search&&<div className="cc-search-results">{results.map((r:any,i:number)=><button key={i} onClick={()=>{setSearchOpen(false);setSearch("");if(r.lead)setSelected(r.lead);else setView("clients");}}><span>{r.kind}</span><b>{r.label}</b><small>{r.sub}</small></button>)}{!results.length&&<div>Nada encontrado.</div>}</div>}</div><button onClick={()=>void load()} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button><button className="ghost" onClick={()=>void supabase.auth.signOut({scope:"local"})}>Sair</button></div></header>{error&&<div className="cc-error cc-top-error">{error}</div>}<section className="cc-content">{loading&&!data.generated_at?<div className="cc-loading">Carregando cockpit…</div>:content}</section></main>{selected&&<ProspectModal lead={selected} close={()=>setSelected(null)} reload={load}/>}</div>;
}
