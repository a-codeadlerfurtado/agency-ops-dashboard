import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row=Record<string,any>;
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const clean=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v??0)||0;
const at=(v:unknown)=>{const n=Date.parse(String(v||""));return Number.isFinite(n)?n:NaN};
const days=(v:unknown)=>Number.isFinite(at(v))?Math.max(0,Math.floor((Date.now()-at(v))/86400000)):null;
const stageWeight:Record<string,number>={novo:10,qualificacao:28,reuniao:48,proposta:68,negociacao:82,fechado:100,perdido:0};
const allowedStages=new Set(Object.keys(stageWeight));
const callOutcomes=new Set(["NAO_ATENDEU","REAGENDAMENTO","QUALIFICADO","DESQUALIFICADO","REUNIAO_MARCADA","PROPOSTA","NEGOCIACAO","GANHO","PERDIDO","TEST_CALL","STABLE"]);
const isTestCall=(r:Row)=>clean(r?.outcome).toUpperCase()==="TEST_CALL";
const array=(v:unknown)=>Array.isArray(v)?v.map(x=>clean(x)).filter(Boolean):[];
const flatten=(v:unknown):string[]=>{
  if(Array.isArray(v))return v.flatMap(flatten);
  if(v&&typeof v==="object")return Object.values(v as Row).flatMap(flatten);
  const s=clean(v).replace(/^\[|\]$/g,"");return s?s.split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean):[];
};
const brl=(v:unknown)=>{
  const s=clean(v);if(!s)return null;
  const raw=s.replace(/[^\d,.-]/g,"");
  const normalized=raw.includes(",")?raw.replace(/\./g,"").replace(",","."):raw;
  const n=Number(normalized);return Number.isFinite(n)?n:null;
};
const localDay=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const localMonth=()=>localDay().slice(0,7);

function scoreLead(lead:Row,profile:Row|null,calls:Row[],activities:Row[]){
  const stage=norm(lead.stage)||"novo";let score=stageWeight[stage]??10;const reasons:string[]=[];
  const last=Math.max(at(lead.updated_at)||0,at(profile?.last_call_at)||0,...calls.map(c=>at(c.created_at)||0),...activities.map(a=>at(a.updated_at||a.created_at)||0));
  const stale=last?Math.max(0,Math.floor((Date.now()-last)/86400000)):999;
  if(profile?.qualification_summary){score+=8;reasons.push("qualificação registrada");}
  if(profile?.decision_role){score+=6;reasons.push("decisor mapeado");}
  if(profile?.primary_pain||array(profile?.pain_points).length){score+=7;reasons.push("dor identificada");}
  if(profile?.urgency){score+=5;reasons.push("urgência registrada");}
  const signals=array(profile?.buying_signals);if(signals.length){score+=Math.min(12,signals.length*4);reasons.push("sinais de compra");}
  const risks=array(profile?.closing_risks);if(risks.length){score-=Math.min(12,risks.length*4);reasons.push("riscos de fechamento");}
  if(calls.length){score+=6;reasons.push("handoff/call disponível");}
  if(num(lead.estimated_value)>0){score+=5;reasons.push("valor informado");}
  const due=at(profile?.next_step_at);
  const overdue=Boolean(due&&due<Date.now()&&!["fechado","perdido"].includes(stage));
  if(due&&due>=Date.now()){score+=8;reasons.push("próximo passo agendado");}
  if(overdue){score-=12;reasons.push("follow-up vencido");}
  if(stale>=7){score-=15;reasons.push("sem atualização há 7d+");}else if(stale<=1){score+=5;reasons.push("atividade recente");}
  score=Math.max(0,Math.min(100,Math.round(score)));
  let next="Acompanhar normalmente";
  if(stage==="perdido")next=profile?.loss_reason?"Programar retomada futura":"Registrar motivo da perda";
  else if(overdue)next="Executar follow-up vencido agora";
  else if(!calls.length)next="Ligar e qualificar";
  else if(!profile?.qualification_summary)next="Completar qualificação";
  else if(!profile?.next_step)next="Definir próximo passo";
  else if(!profile?.next_step_at)next="Dar data ao próximo passo";
  else if(stage==="reuniao")next="Preparar proposta e confirmar decisor";
  else if(stage==="proposta")next="Cobrar retorno da proposta";
  else if(stage==="negociacao")next="Tratar objeção e fechar próximo passo";
  else if(stale>=3)next="Retomar contato";
  return {score,score_reasons:reasons,stale_days:stale,followup_overdue:overdue,next_best_action:next,priority:score>=75?"HOT":score>=55?"WARM":score>=35?"WATCH":"COLD"};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return reply({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";if(!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData,error:authError}=await auth.auth.getUser();if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops"),crm=db.schema("crm");
  const [{data:pref},{data:approval},{data:crmProfile}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1),
    db.from("profiles").select("id,email,sees_all_leads").eq("id",userData.user.id).maybeSingle()
  ]);
  const person=clean(pref?.collaborator_person||pref?.name);if(!person||!(approval||[]).length||!crmProfile)return reply({error:"profile_locked"},403);
  const {data:roster}=await ops.from("team_roster").select("person,role,access_level,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||String(roster.role||"").toUpperCase()!=="CLOSER")return reply({error:"forbidden"},403);
  const ownerId=String(userData.user.id);

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));const action=clean(body?.action);
    const leadId=clean(body?.lead_id);
    const ownLead=async(id:string)=>{if(!id)return null;const {data}=await crm.from("leads").select("id,owner_id,stage,closed_monthly_value,closed_setup_value,closed_term_months,closed_setup_payment").eq("id",id).eq("owner_id",ownerId).maybeSingle();return data as Row|null;};
    if(action==="update_lead"){
      const existing=await ownLead(leadId);if(!existing)return reply({error:"lead_not_available"},404);
      const stage=norm(body?.stage||existing.stage);if(!allowedStages.has(stage))return reply({error:"invalid_stage"},400);
      const patch:Row={stage};
      if(body?.estimated_value!==undefined){const n=Number(body.estimated_value);if(!Number.isFinite(n)||n<0)return reply({error:"invalid_estimated_value"},400);patch.estimated_value=n;}
      if(stage==="fechado"){
        const monthly=body?.closed_monthly_value??existing.closed_monthly_value,setup=body?.closed_setup_value??existing.closed_setup_value,term=body?.closed_term_months??existing.closed_term_months,payment=body?.closed_setup_payment??existing.closed_setup_payment;
        if(monthly===null||monthly===undefined||setup===null||setup===undefined||!Number(term)||!clean(payment))return reply({error:"closing_terms_required",detail:"Para fechar, informe mensalidade, implementação, prazo e forma de pagamento."},400);
        patch.closed_monthly_value=Number(monthly);patch.closed_setup_value=Number(setup);patch.closed_term_months=Number(term);patch.closed_setup_payment=clean(payment);patch.closed_at=new Date().toISOString();
      }
      if(stage==="perdido"&&!clean(body?.loss_reason))return reply({error:"loss_reason_required",detail:"Informe o motivo da perda."},400);
      const {data:saved,error}=await crm.from("leads").update(patch).eq("id",leadId).eq("owner_id",ownerId).select("*").single();
      if(error)return reply({error:"lead_update_failed",detail:error.message},500);
      if(stage==="perdido")await ops.from("commercial_prospect_profiles").upsert({lead_id:leadId,closer_person:person,loss_reason:clean(body.loss_reason),updated_at:new Date().toISOString()},{onConflict:"lead_id"});
      return reply({ok:true,lead:saved});
    }
    if(action==="update_prospect"){
      const existing=await ownLead(leadId);if(!existing)return reply({error:"lead_not_available"},404);
      const patch:Row={lead_id:leadId,closer_person:person,updated_at:new Date().toISOString()};
      for(const k of ["city","region","website","decision_role","current_structure","marketing_investment","urgency","qualification_summary","closer_briefing","next_step","next_step_at","primary_pain","loss_reason","cadence_status"])if(body?.[k]!==undefined)patch[k]=body[k]===null?null:clean(body[k]).slice(0,6000);
      for(const k of ["pain_points","secondary_pains","goals","services_interest","objections","buying_signals","closing_risks"])if(body?.[k]!==undefined)patch[k]=array(body[k]).slice(0,40);
      if(body?.broker_count!==undefined){const n=Number(body.broker_count);patch.broker_count=Number.isFinite(n)&&n>=0?Math.round(n):null;}
      const {data:saved,error}=await ops.from("commercial_prospect_profiles").upsert(patch,{onConflict:"lead_id"}).select("*").single();
      if(error)return reply({error:"prospect_update_failed",detail:error.message},500);return reply({ok:true,prospect:saved});
    }
    if(action==="add_activity"){
      const existing=await ownLead(leadId);if(!existing)return reply({error:"lead_not_available"},404);
      const title=clean(body?.title).slice(0,500);if(!title)return reply({error:"activity_title_required"},400);
      const due=body?.due_at?new Date(String(body.due_at)):null;if(due&&Number.isNaN(due.getTime()))return reply({error:"invalid_due_at"},400);
      const {data:saved,error}=await ops.from("commercial_activities").insert({lead_id:leadId,activity_type:clean(body?.activity_type||"FOLLOW_UP").toUpperCase().slice(0,60),title,description:clean(body?.description).slice(0,3000)||null,owner_person:person,due_at:due?.toISOString()||null,source:"DASH_OPS",metadata:{cadence:body?.cadence||null}}).select("*").single();
      if(error)return reply({error:"activity_create_failed",detail:error.message},500);
      if(body?.sync_next_step!==false)await ops.from("commercial_prospect_profiles").upsert({lead_id:leadId,closer_person:person,next_step:title,next_step_at:due?.toISOString()||null,updated_at:new Date().toISOString()},{onConflict:"lead_id"});
      return reply({ok:true,activity:saved});
    }
    if(action==="create_cadence"){
      const existing=await ownLead(leadId);if(!existing)return reply({error:"lead_not_available"},404);
      const baseTitle=clean(body?.title||"Follow-up comercial").slice(0,500),cadenceId=crypto.randomUUID(),now=new Date();
      const steps=[{days:1,type:"WHATSAPP",label:"WhatsApp · "+baseTitle},{days:3,type:"CALL",label:"Ligação · "+baseTitle},{days:7,type:"FOLLOW_UP",label:"Retomada · "+baseTitle}];
      const rows=steps.map((step)=>{
        const due=new Date(now);due.setDate(due.getDate()+step.days);due.setHours(10,0,0,0);
        return {lead_id:leadId,activity_type:step.type,title:step.label,description:"Cadência 1/3/7 criada no cockpit do closer",owner_person:person,due_at:due.toISOString(),source:"DASH_OPS",metadata:{cadence:"1/3/7",cadence_id:cadenceId,step_days:step.days}};
      });
      const {data:saved,error}=await ops.from("commercial_activities").insert(rows).select("*");
      if(error)return reply({error:"cadence_create_failed",detail:error.message},500);
      const first=(saved||[]).sort((a:Row,b:Row)=>at(a.due_at)-at(b.due_at))[0]||null;
      await ops.from("commercial_prospect_profiles").upsert({lead_id:leadId,closer_person:person,next_step:first?.title||baseTitle,next_step_at:first?.due_at||null,cadence_status:"ACTIVE",updated_at:new Date().toISOString()},{onConflict:"lead_id"});
      return reply({ok:true,cadence_id:cadenceId,activities:saved||[]});
    }
    if(action==="complete_activity"){
      const id=clean(body?.activity_id);if(!id)return reply({error:"activity_id_required"},400);
      const {data:item}=await ops.from("commercial_activities").select("id,lead_id").eq("id",id).eq("owner_person",person).maybeSingle();
      if(!item||!(await ownLead(String(item.lead_id))))return reply({error:"activity_not_available"},404);
      const {data:saved,error}=await ops.from("commercial_activities").update({completed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
      if(error)return reply({error:"activity_update_failed",detail:error.message},500);
      const {data:nextRows}=await ops.from("commercial_activities").select("title,due_at").eq("lead_id",String(item.lead_id)).is("completed_at",null).order("due_at",{ascending:true,nullsFirst:false}).limit(1);
      const next=(nextRows||[])[0]||null;
      await ops.from("commercial_prospect_profiles").upsert({lead_id:String(item.lead_id),closer_person:person,next_step:next?.title||null,next_step_at:next?.due_at||null,updated_at:new Date().toISOString()},{onConflict:"lead_id"});
      return reply({ok:true,activity:saved});
    }
    if(action==="update_call_outcome"){
      const callId=clean(body?.call_id),outcome=clean(body?.outcome).toUpperCase();if(!callId||!callOutcomes.has(outcome))return reply({error:"invalid_call_outcome"},400);
      const {data:call}=await ops.from("commercial_call_records").select("id,lead_id,closer_person").eq("id",callId).eq("closer_person",person).maybeSingle();
      if(!call||!(await ownLead(String(call.lead_id))))return reply({error:"call_not_available"},404);
      const {data:saved,error}=await ops.from("commercial_call_records").update({outcome,updated_at:new Date().toISOString()}).eq("id",callId).select("*").single();
      if(error)return reply({error:"call_update_failed",detail:error.message},500);return reply({ok:true,call:saved});
    }
    return reply({error:"unknown_action"},400);
  }

  const [{data:leadRows,error:leadError},{data:clientRows,error:clientError},{data:goalRows},{data:agendaRows}]=await Promise.all([
    crm.from("leads").select("*").eq("owner_id",ownerId).is("archived_at",null).order("updated_at",{ascending:false}).limit(2500),
    ops.from("clients").select("id,display_name,lifecycle,service,crm_lead_id,entrada,saida,cs_owner,gt_owner,closer_origin,closer_origin_status,closer_origin_source").ilike("closer_origin","%"+person+"%").order("entrada",{ascending:false}).limit(1000),
    crm.from("closer_goals").select("*").eq("owner_id",ownerId).order("ano",{ascending:false}).order("mes",{ascending:false}).limit(24),
    ops.from("meeting_agenda_events").select("*").order("scheduled_for",{ascending:false}).limit(500)
  ]);
  if(leadError||clientError)return reply({error:"base_query_failed",detail:leadError?.message||clientError?.message},500);
  const leads:Row[]=leadRows||[],leadIds=leads.map(r=>String(r.id)),clients:Row[]=clientRows||[],clientIds=clients.map(r=>String(r.id));
  const [{data:profiles},{data:calls},{data:activities},{data:links},{data:campaigns},{data:contracts},{data:handoffs},{data:meetingRows}]=await Promise.all([
    leadIds.length?ops.from("commercial_prospect_profiles").select("*").in("lead_id",leadIds).limit(2500):Promise.resolve({data:[]}),
    ops.from("commercial_call_records").select("*").eq("closer_person",person).order("created_at",{ascending:false}).limit(1000),
    leadIds.length?ops.from("commercial_activities").select("*").in("lead_id",leadIds).order("created_at",{ascending:false}).limit(5000):Promise.resolve({data:[]}),
    clientIds.length?ops.from("commercial_client_lead_links").select("*").in("client_id",clientIds):Promise.resolve({data:[]}),
    clientIds.length?ops.from("campaign_client_latest").select("*").in("client_id",clientIds).in("lifecycle",["ACTIVE","ONBOARDING"]):Promise.resolve({data:[]}),
    clientIds.length?ops.from("client_contract_status").select("*").in("client_id",clientIds):Promise.resolve({data:[]}),
    clientIds.length?ops.from("onboarding_group_sales_handoff").select("*").in("client_id",clientIds).order("created_at",{ascending:false}):Promise.resolve({data:[]}),
    ops.from("meeting_transcripts").select("id,meeting_started_at,meeting_ended_at,duration_seconds,ingested_at,client_id,client_name_raw,match_status,participants,summary,transcript_text,decisions,commitments,ai_signals,metadata,owner_person").order("ingested_at",{ascending:false}).limit(700)
  ]);

  const profileByLead=new Map((profiles||[]).map((r:Row)=>[String(r.lead_id),r]));
  const callsByLead=new Map<string,Row[]>(),activitiesByLead=new Map<string,Row[]>();
  for(const c of calls||[]){const k=String(c.lead_id),a=callsByLead.get(k)||[];a.push(c);callsByLead.set(k,a);}
  for(const a of activities||[]){const k=String(a.lead_id),v=activitiesByLead.get(k)||[];v.push(a);activitiesByLead.set(k,v);}
  const linkByLead=new Map((links||[]).map((r:Row)=>[String(r.lead_id),r]));
  const clientById=new Map(clients.map(r=>[String(r.id),r]));
  const contractByClient=new Map((contracts||[]).map((r:Row)=>[String(r.client_id),r]));
  const campaignByClient=new Map((campaigns||[]).map((r:Row)=>[String(r.client_id),r]));
  const handoffByClient=new Map<string,Row>();for(const h of handoffs||[])if(!handoffByClient.has(String(h.client_id)))handoffByClient.set(String(h.client_id),h);
  const enrichedClients=clients.map(c=>{const start=at(c.entrada),end=c.lifecycle==="CHURNED"&&c.saida?at(c.saida):Date.now();return{...c,client_id:c.id,client_days:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/86400000)):null,contract:contractByClient.get(String(c.id))||null,campaign:campaignByClient.get(String(c.id))||null,handoff:handoffByClient.get(String(c.id))||null};});

  const transcriptMap=new Map((meetingRows||[]).map((r:Row)=>[String(r.id),r]));
  const sessionIds=(calls||[]).map((r:Row)=>String(r.capture_session_id||"")).filter(Boolean);
  const transcriptIds=(calls||[]).map((r:Row)=>String(r.transcript_id||"")).filter(Boolean);
  const [{data:sessions},{data:segments}]=await Promise.all([
    sessionIds.length?ops.from("meeting_capture_sessions").select("id,owner_person,started_at,ended_at,capture_mode,transcript_id,audio_status,audio_mixed_path,audio_duration_ms,audio_mime_type").in("id",sessionIds):Promise.resolve({data:[]}),
    transcriptIds.length?ops.from("meeting_transcript_segments").select("transcript_id,sequence_no,started_ms,ended_ms,speaker_name,text,confidence,source").in("transcript_id",transcriptIds).order("sequence_no",{ascending:true}).limit(12000):Promise.resolve({data:[]})
  ]);
  const sessionMap=new Map((sessions||[]).map((r:Row)=>[String(r.id),r])),segmentsByTranscript=new Map<string,Row[]>();
  for(const s of segments||[]){const k=String(s.transcript_id),a=segmentsByTranscript.get(k)||[];a.push(s);segmentsByTranscript.set(k,a);}
  const storage=db.storage.from("relato-call-audio"),signedBySession=new Map<string,Row>();
  await Promise.all((sessions||[]).filter((s:Row)=>s.audio_mixed_path).map(async(s:Row)=>{
    const [play,download]=await Promise.all([storage.createSignedUrl(String(s.audio_mixed_path),900),storage.createSignedUrl(String(s.audio_mixed_path),900,{download:"relato-call-"+String(s.id)+".mp3"})]);
    if(play.data?.signedUrl)signedBySession.set(String(s.id),{play_url:play.data.signedUrl,download_url:download.data?.signedUrl||play.data.signedUrl,mime_type:s.audio_mime_type||"audio/mpeg",duration_ms:s.audio_duration_ms||null});
  }));

  const currentLeadSet=new Set(leadIds);
  const enrichedCalls=(calls||[]).map((c:Row)=>{
    const tr=transcriptMap.get(String(c.transcript_id))||null,session=sessionMap.get(String(c.capture_session_id))||null;
    const coaching:string[]=[];if(!clean(c.next_step))coaching.push("Fechar a call com próximo passo explícito.");if(!clean(c.primary_pain)&&!array(c.pain_points).length)coaching.push("Aprofundar a dor principal.");if(!array(c.objections).length)coaching.push("Registrar a objeção principal quando houver.");if(array(c.buying_signals).length)coaching.push("Sinais de compra detectados: "+array(c.buying_signals).join(", ")+".");if(array(c.closing_risks).length)coaching.push("Riscos detectados: "+array(c.closing_risks).join(", ")+".");
    return {...c,read_only:!currentLeadSet.has(String(c.lead_id)),is_test:isTestCall(c),transcript_summary:tr?.summary||c.ai_summary||null,transcript_text:tr?.transcript_text||null,decisions:tr?.decisions||[],commitments:tr?.commitments||[],ai_signals:tr?.ai_signals||{},segments:segmentsByTranscript.get(String(c.transcript_id))||[],audio:signedBySession.get(String(c.capture_session_id))||null,duration_seconds:num(tr?.duration_seconds)||Math.round(num(session?.audio_duration_ms)/1000),coaching};
  });
  const richCallsByLead=new Map<string,Row[]>();for(const c of enrichedCalls){const k=String(c.lead_id),a=richCallsByLead.get(k)||[];a.push(c);richCallsByLead.set(k,a);}

  const enrichedLeads=leads.map(l=>{
    const p:any=profileByLead.get(String(l.id))||null,cs=richCallsByLead.get(String(l.id))||[],as=activitiesByLead.get(String(l.id))||[];
    const scored=scoreLead(l,p,cs,as),link:any=linkByLead.get(String(l.id))||null,client=link?clientById.get(String(link.client_id))||null:null;
    return {...l,stage:norm(l.stage)||"novo",owner_name:person,estimated_value:num(l.estimated_value),weighted_value:Number((num(l.estimated_value)*((stageWeight[norm(l.stage)]??10)/100)).toFixed(2)),prospect_profile:p,calls:cs,activities:as,call_count:cs.length,open_activities:as.filter(a=>!a.completed_at),last_call:cs[0]||null,client_outcome:client?{...client,contract:contractByClient.get(String((client as Row).id))||null}:null,...scored};
  }).sort((a,b)=>b.score-a.score||at(b.updated_at)-at(a.updated_at));

  const open=enrichedLeads.filter(l=>!["fechado","perdido"].includes(l.stage)),advanced=open.filter(l=>["reuniao","proposta","negociacao"].includes(l.stage));
  const canonical30=enrichedClients.filter(c=>c.entrada&&Date.now()-at(c.entrada)<=30*86400000),canonicalMonth=enrichedClients.filter(c=>String(c.entrada||"").slice(0,7)===localMonth());
  const monthAnchor=new Date(localDay()+"T12:00:00Z");monthAnchor.setUTCMonth(monthAnchor.getUTCMonth()-1);const previousMonth=monthAnchor.toISOString().slice(0,7);
  const canonicalPrevMonth=enrichedClients.filter(c=>String(c.entrada||"").slice(0,7)===previousMonth);
  const productionCalls=enrichedCalls.filter(c=>!c.is_test),calls30=productionCalls.filter(c=>(days(c.created_at)??999)<=30),callsPrev30=productionCalls.filter(c=>{const d=days(c.created_at)??999;return d>30&&d<=60;});
  const leads30=enrichedLeads.filter(l=>(days(l.created_at)??999)<=30),leadsPrev30=enrichedLeads.filter(l=>{const d=days(l.created_at)??999;return d>30&&d<=60;});
  const activeClients=enrichedClients.filter(c=>["ACTIVE","ONBOARDING"].includes(String(c.lifecycle))),churned=enrichedClients.filter(c=>c.lifecycle==="CHURNED");
  const eligible30=enrichedClients.filter(c=>c.entrada&&Date.now()-at(c.entrada)>=30*86400000),retained30=eligible30.filter(c=>!(c.lifecycle==="CHURNED"&&(c.client_days??999)<30));
  const eligible60=enrichedClients.filter(c=>c.entrada&&Date.now()-at(c.entrada)>=60*86400000),retained60=eligible60.filter(c=>!(c.lifecycle==="CHURNED"&&(c.client_days??999)<60));
  const knownValues=enrichedClients.map(c=>brl(c.handoff?.commercial_value)).filter((n):n is number=>n!==null);
  const currentGoal=(goalRows||[]).find((g:Row)=>String(g.ano)+"-"+String(g.mes).padStart(2,"0")===localMonth())||null;

  const sourceMap=new Map<string,Row>();for(const l of enrichedLeads){const k=clean(l.source)||"Não informado",r=sourceMap.get(k)||{source:k,leads:0,open:0,advanced:0,linked_wins:0};r.leads++;if(!["fechado","perdido"].includes(l.stage))r.open++;if(["reuniao","proposta","negociacao"].includes(l.stage))r.advanced++;if(l.client_outcome)r.linked_wins++;sourceMap.set(k,r);}
  const objectionMap=new Map<string,number>();const addObs=(v:unknown)=>{for(const x of flatten(v)){const k=x.toLowerCase();objectionMap.set(k,(objectionMap.get(k)||0)+1);}};
  for(const p of profiles||[])addObs(p.objections);for(const c of calls||[])addObs(c.objections);for(const h of handoffs||[])addObs(h.objections);
  const objection_summary=[...objectionMap.entries()].map(([label,count])=>({label:label.replace(/\b\w/g,c=>c.toUpperCase()),count})).sort((a,b)=>b.count-a.count).slice(0,12);
  const recoverable_losses=enrichedLeads.filter(l=>l.stage==="perdido").filter(l=>{const reason=norm(l.prospect_profile?.loss_reason);return !/(sem recurso|desqualific|fraude|duplicad|fora do perfil)/.test(reason);}).map(l=>({lead_id:l.id,name:l.company||l.name,loss_reason:l.prospect_profile?.loss_reason||"Motivo não detalhado",days_since_update:l.stale_days,next_best_action:"Programar retomada em 15/30/60 dias"}));

  const agenda=(agendaRows||[]).filter((r:Row)=>norm(r.person)===norm(person)||norm(r.calendar_owner_person)===norm(person)).sort((a:Row,b:Row)=>at(a.scheduled_for)-at(b.scheduled_for));
  const linkedTranscriptIds=new Set(enrichedCalls.map(c=>String(c.transcript_id||"")).filter(Boolean));
  const meetings=(meetingRows||[]).filter((r:Row)=>norm(r.metadata?.mcp_owner_person||r.owner_person)===norm(person)||linkedTranscriptIds.has(String(r.id))).map((r:Row)=>({...r,source_label:"Relato AI"}));

  const myDay:Row[]=[];
  for(const l of open){
    const overdue=(l.open_activities||[]).filter((a:Row)=>a.due_at&&at(a.due_at)<Date.now());
    if(overdue.length)myDay.push({type:"OVERDUE",priority:100,lead_id:l.id,title:(l.company||l.name||"Prospect"),action:"Follow-up vencido",detail:overdue[0].title,due_at:overdue[0].due_at});
    else if((l.open_activities||[]).some((a:Row)=>!a.due_at))myDay.push({type:"SCHEDULE",priority:90,lead_id:l.id,title:(l.company||l.name||"Prospect"),action:"Dar data ao próximo passo",detail:l.next_best_action});
    else if(l.score>=70)myDay.push({type:"HOT",priority:80+l.score/10,lead_id:l.id,title:(l.company||l.name||"Prospect"),action:l.next_best_action,detail:"Score "+l.score+"/100"});
    else if(l.stale_days>=7)myDay.push({type:"STALE",priority:60,lead_id:l.id,title:(l.company||l.name||"Prospect"),action:"Retomar oportunidade",detail:"Sem atualização há "+l.stale_days+" dias"});
  }
  for(const e of agenda.filter((r:Row)=>at(r.scheduled_for)>=Date.now()&&at(r.scheduled_for)<=Date.now()+86400000))myDay.push({type:"MEETING",priority:95,title:e.calendar_title||e.topic||"Reunião",action:"Preparar reunião",detail:e.chat_name||"",due_at:e.scheduled_for});
  myDay.sort((a,b)=>b.priority-a.priority);

  return reply({
    profile:{person,role:"CLOSER",access_level:roster.access_level||"RESTRICTED",scope:"OWN_PIPELINE_ONLY"},
    summary:{open_leads:open.length,new_7d:open.filter(l=>(days(l.created_at)??999)<=7).length,new_leads_30d:leads30.length,new_leads_prev_30d:leadsPrev30.length,advanced_opportunities:advanced.length,hot_opportunities:open.filter(l=>l.score>=70).length,weighted_forecast_value:Number(open.reduce((s,l)=>s+num(l.weighted_value),0).toFixed(2)),forecast_coverage_pct:open.length?Math.round(100*open.filter(l=>num(l.estimated_value)>0).length/open.length):0,canonical_closed_total:enrichedClients.length,canonical_closed_30d:canonical30.length,canonical_closed_month:canonicalMonth.length,canonical_closed_prev_month:canonicalPrevMonth.length,active_clients:activeClients.length,churned_clients:churned.length,meetings_7d:meetings.filter((m:Row)=>(days(m.meeting_started_at||m.ingested_at)??999)<=7).length,followups_overdue:open.filter(l=>l.followup_overdue||(l.open_activities||[]).some((a:Row)=>a.due_at&&at(a.due_at)<Date.now())).length,calls_30d:calls30.length,calls_prev_30d:callsPrev30.length,test_calls:enrichedCalls.filter(c=>c.is_test).length,retention_30_pct:eligible30.length?Math.round(100*retained30.length/eligible30.length):null,retention_60_pct:eligible60.length?Math.round(100*retained60.length/eligible60.length):null,quick_churn_under_30:churned.filter(c=>(c.client_days??999)<30).length,linked_sales:(links||[]).length,reconciliation_pending:Math.max(0,enrichedClients.length-(links||[]).length),handoff_coverage_pct:enrichedClients.length?Math.round(100*enrichedClients.filter(c=>c.handoff).length/enrichedClients.length):0,precall_briefing_calls:productionCalls.filter(c=>clean(c.closer_briefing)||clean(c.transcript_summary)).length,known_commercial_value:Number(knownValues.reduce((a,b)=>a+b,0).toFixed(2)),known_commercial_value_count:knownValues.length},
    leads:enrichedLeads,commercial_calls:enrichedCalls,commercial_activities:activities||[],portfolio_clients:enrichedClients,campaigns:campaigns||[],meetings,agenda_events:agenda,source_performance:[...sourceMap.values()].sort((a,b)=>b.leads-a.leads),objection_summary,recoverable_losses,current_goal,
    my_day:myDay.slice(0,30),
    playbook:{pre_call:["Confirme decisor e urgência.","Aprofunde a dor com impacto concreto.","Entenda estrutura atual e investimento.","Saia da reunião com próximo passo e data."],price_objection:["Volte ao impacto da dor antes de defender preço.","Compare custo da inação com o investimento.","Valide se a objeção é preço, caixa ou percepção de valor."],thinking:["Pergunte o que exatamente precisa ser avaliado.","Defina critério e data para a decisão.","Agende o retorno antes de encerrar."],partner:["Mapeie quem decide junto.","Peça para incluir o decisor no próximo contato.","Envie resumo curto orientado à decisão."]},
    data_quality:{crm_leads:enrichedLeads.length,stale_7d:open.filter(l=>l.stale_days>=7).length,missing_estimated_value:open.filter(l=>num(l.estimated_value)<=0).length,profiles:profiles?.length||0,calls:enrichedCalls.length,production_calls:productionCalls.length,test_calls:enrichedCalls.filter(c=>c.is_test).length,activities:activities?.length||0,canonical_sales:enrichedClients.length,linked_sales:links?.length||0,reconciliation_pending:Math.max(0,enrichedClients.length-(links?.length||0)),note:"KPIs de venda usam a base canônica de clientes por closer. Calls TEST_CALL ficam fora dos KPIs. O pipeline só é fechado automaticamente quando existe vínculo CRM exato e os termos obrigatórios do fechamento estão completos."},
    generated_at:new Date().toISOString()
  });
});
