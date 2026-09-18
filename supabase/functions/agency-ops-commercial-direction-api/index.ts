import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const num=(v:unknown)=>Number(v??0)||0;
const time=(v:unknown)=>v?new Date(String(v)).getTime():NaN;
const daysSince=(v:unknown)=>Number.isFinite(time(v))?Math.max(0,Math.floor((Date.now()-time(v))/86400000)):null;
const hoursSince=(v:unknown)=>Number.isFinite(time(v))?Math.max(0,Number(((Date.now()-time(v))/3600000).toFixed(1))):null;
const ownerLabel=(email:unknown)=>{const key=norm(email);if(key==="lakassessoriadigital@gmail.com")return"Leonardo Augusto";if(key==="feitozaluizvitor@gmail.com")return"Vitor Feitoza";if(!key)return"Não atribuído";return String(email).split("@")[0].replace(/[._-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase())};
const weight:Record<string,number>={novo:.10,qualificacao:.25,reuniao:.45,proposta:.65,negociacao:.80,fechado:1,perdido:0};
const rank:Record<string,number>={negociacao:0,proposta:1,reuniao:2,qualificacao:3,novo:4,fechado:5,perdido:6};
const allowedStages=new Set(Object.keys(weight));
const allowedWorkStatuses=new Set(["OPEN","IN_PROGRESS","SNOOZED","COMPLETED"]);
const meetingOwners=new Set(["leonardo augusto","vitor feitoza","luiz vitor feitoza"]);

type Row=Record<string,any>;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return reply({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";if(!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});const{data:userData,error:authError}=await auth.auth.getUser();if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops"),crm=db.schema("crm");
  const[{data:pref},{data:approvals}]=await Promise.all([ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)]);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();if(!person||!(approvals||[]).length)return reply({error:"profile_locked"},403);
  const{data:roster}=await ops.from("team_roster").select("person,role,access_level,is_former").eq("person",person).maybeSingle();if(!roster||roster.is_former)return reply({error:"forbidden"},403);
  const role=String(roster.role||"").toUpperCase();
  const isLeonardo=person==="Leonardo Augusto"&&role==="COMMERCIAL";
  const isCloser=role==="CLOSER";
  const isAdler=person==="Adler Furtado"&&role==="MGMT";
  if(!isAdler&&!isLeonardo&&!isCloser)return reply({error:"forbidden"},403);

  const{data:crmProfiles,error:profileError}=await db.from("profiles").select("id,email,sees_all_leads");if(profileError)return reply({error:"crm_profiles_failed",detail:profileError.message},500);
  const directionProfiles=(crmProfiles||[]).filter((r:Row)=>r.sees_all_leads===true);
  const allOwnerIds=directionProfiles.map((r:Row)=>String(r.id));
  const ownerMap=new Map((crmProfiles||[]).map((r:Row)=>[String(r.id),ownerLabel(r.email)]));
  const currentOwner=(crmProfiles||[]).find((r:Row)=>String(r.id)===String(userData.user.id));
  const ownerIds=isCloser?(currentOwner?[String(currentOwner.id)]:[]): allOwnerIds;

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const action=String(body?.action||"");
    if(action==="update_lead"){
      const leadId=String(body?.lead_id||"");
      const stage=norm(body?.stage);
      if(!leadId||!allowedStages.has(stage))return reply({error:"invalid_lead_update"},400);
      const{data:existing}=await crm.from("leads").select("id,owner_id").eq("id",leadId).maybeSingle();
      if(!existing||!ownerIds.includes(String(existing.owner_id)))return reply({error:"lead_not_available"},404);
      const patch:Row={stage,updated_at:new Date().toISOString()};
      if(body?.estimated_value!==undefined){const value=Number(body.estimated_value);if(!Number.isFinite(value)||value<0)return reply({error:"invalid_estimated_value"},400);patch.estimated_value=value;}
      if(stage==="fechado")patch.closed_at=new Date().toISOString();
      const{data:saved,error}=await crm.from("leads").update(patch).eq("id",leadId).select("id,stage,estimated_value,updated_at,closed_at").single();
      if(error)return reply({error:"lead_update_failed",detail:error.message},500);
      return reply({ok:true,action,lead:saved,updated_by:person});
    }
    if(action==="update_prospect"){
      const leadId=String(body?.lead_id||"");
      const{data:existing}=await crm.from("leads").select("id,owner_id").eq("id",leadId).maybeSingle();
      if(!existing||!ownerIds.includes(String(existing.owner_id)))return reply({error:"lead_not_available"},404);
      const allowed=["city","region","website","decision_role","current_structure","marketing_investment","urgency","qualification_summary","closer_briefing","next_step","next_step_at"];
      const patch:Row={lead_id:leadId,closer_person:ownerMap.get(String(existing.owner_id))||person,updated_at:new Date().toISOString()};
      for(const key of allowed)if(body?.[key]!==undefined)patch[key]=body[key]===null?null:String(body[key]).slice(0,key==="qualification_summary"||key==="closer_briefing"?6000:2000);
      for(const key of ["pain_points","goals","services_interest","objections"])if(body?.[key]!==undefined)patch[key]=Array.isArray(body[key])?body[key].map((v:unknown)=>String(v).trim()).filter(Boolean).slice(0,30):[];
      if(body?.broker_count!==undefined){const n=Number(body.broker_count);patch.broker_count=Number.isFinite(n)&&n>=0?Math.round(n):null;}
      const{data:saved,error}=await ops.from("commercial_prospect_profiles").upsert(patch,{onConflict:"lead_id"}).select("*").single();
      if(error)return reply({error:"prospect_update_failed",detail:error.message},500);
      return reply({ok:true,action,prospect:saved,updated_by:person});
    }
    if(action==="add_activity"){
      const leadId=String(body?.lead_id||"");
      const{data:existing}=await crm.from("leads").select("id,owner_id").eq("id",leadId).maybeSingle();
      if(!existing||!ownerIds.includes(String(existing.owner_id)))return reply({error:"lead_not_available"},404);
      const title=String(body?.title||"").trim().slice(0,500);if(!title)return reply({error:"activity_title_required"},400);
      const due=body?.due_at?new Date(String(body.due_at)):null;if(due&&Number.isNaN(due.getTime()))return reply({error:"invalid_due_at"},400);
      const{data:saved,error}=await ops.from("commercial_activities").insert({lead_id:leadId,activity_type:String(body?.activity_type||"FOLLOW_UP").toUpperCase().slice(0,60),title,description:String(body?.description||"").trim().slice(0,3000)||null,owner_person:person,due_at:due?.toISOString()||null,source:"DASH_OPS"}).select("*").single();
      if(error)return reply({error:"activity_create_failed",detail:error.message},500);
      return reply({ok:true,action,activity:saved,created_by:person});
    }
        if(action==="update_work_item"){
      const itemId=String(body?.item_id||"");const status=String(body?.status||"").toUpperCase();
      if(!itemId||!allowedWorkStatuses.has(status))return reply({error:"invalid_work_update"},400);
      const{data:item}=await ops.from("work_items").select("id,target_person,status").eq("id",itemId).eq("target_person",person).maybeSingle();
      if(!item)return reply({error:"work_item_not_available"},404);
      const now=new Date().toISOString();const patch:Row={status,updated_at:now};
      if(status==="IN_PROGRESS")patch.started_at=now;
      if(status==="SNOOZED"){const until=body?.snoozed_until?new Date(String(body.snoozed_until)):null;if(!until||Number.isNaN(until.getTime()))return reply({error:"invalid_snooze"},400);patch.snoozed_until=until.toISOString();}
      if(status==="COMPLETED"){patch.completed_at=now;patch.completed_by=person;patch.resolution=String(body?.resolution||"Concluído pelo responsável").slice(0,2000);}
      if(status==="OPEN"){patch.completed_at=null;patch.completed_by=null;patch.resolution=null;patch.snoozed_until=null;}
      const{data:saved,error}=await ops.from("work_items").update(patch).eq("id",itemId).eq("target_person",person).select("*").single();
      if(error)return reply({error:"work_update_failed",detail:error.message},500);
      return reply({ok:true,action,item:saved,updated_by:person});
    }
    return reply({error:"unknown_action"},400);
  }

  const leadQuery=ownerIds.length?crm.from("leads").select("id,owner_id,name,company,email,phone,instagram,orcamento_mkt,atuacao,ticket_medio,notes,stage,estimated_value,source,created_at,updated_at,closed_at,closed_monthly_value,closed_setup_value,closed_term_months,closed_monthly_first_month,closed_setup_first_month,closed_setup_payment,closed_setup_installment_values,archived_at").in("owner_id",ownerIds).order("updated_at",{ascending:false}).limit(2000):Promise.resolve({data:[],error:null});
  const prospectQuery=isCloser?ops.from("commercial_prospect_profiles").select("*").eq("closer_person",person).order("updated_at",{ascending:false}).limit(2000):ops.from("commercial_prospect_profiles").select("*").order("updated_at",{ascending:false}).limit(2000);
  const callQuery=isCloser?ops.from("commercial_call_records").select("*").eq("closer_person",person).order("created_at",{ascending:false}).limit(2000):ops.from("commercial_call_records").select("*").order("created_at",{ascending:false}).limit(2000);
  const[leadRes,goalRes,clientRes,campaignRes,meetingRes,workRes,prospectRes,callRes,activityRes]=await Promise.all([
    leadQuery,
    ownerIds.length?crm.from("closer_goals").select("owner_id,ano,mes,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id",ownerIds).order("ano",{ascending:false}).order("mes",{ascending:false}):Promise.resolve({data:[],error:null}),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("entrada",{ascending:false}).limit(1200),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle",["ACTIVE","ONBOARDING"]).order("spend",{ascending:false}).limit(1200),
    ops.from("meeting_transcripts").select("id,meeting_started_at,ingested_at,client_id,client_name_raw,match_status,participants,summary,decisions,commitments,ai_signals,metadata,owner_person").order("ingested_at",{ascending:false}).limit(1200),
    isLeonardo?ops.from("work_items").select("id,client_id,type,status,priority,title,description,source,due_at,snoozed_until,started_at,completed_at,resolution,created_at,updated_at").eq("target_person",person).order("updated_at",{ascending:false}).limit(300):Promise.resolve({data:[],error:null}),
    prospectQuery,callQuery,ops.from("commercial_activities").select("*").order("created_at",{ascending:false}).limit(3000)
  ]);
  const failed=[leadRes,goalRes,clientRes,campaignRes,meetingRes,workRes,prospectRes,callRes,activityRes].find((r:any)=>r?.error);if(failed?.error)return reply({error:"query_failed",detail:failed.error.message},500);

  const leads=(leadRes.data||[]).filter((r:Row)=>!r.archived_at).map((r:Row)=>{const stage=norm(r.stage)||"novo",estimated=num(r.estimated_value);return{id:r.id,owner_id:r.owner_id,owner_name:ownerMap.get(String(r.owner_id))||"Não atribuído",name:r.name,company:r.company,email:r.email,phone:r.phone,instagram:r.instagram,orcamento_mkt:r.orcamento_mkt,atuacao:r.atuacao,ticket_medio:r.ticket_medio,notes:r.notes,stage,estimated_value:estimated,weighted_value:Number((estimated*(weight[stage]??.1)).toFixed(2)),source:r.source,created_at:r.created_at,updated_at:r.updated_at,closed_at:r.closed_at,closed_monthly_value:r.closed_monthly_value,closed_setup_value:r.closed_setup_value,closed_term_months:r.closed_term_months,closed_monthly_first_month:r.closed_monthly_first_month,closed_setup_first_month:r.closed_setup_first_month,closed_setup_payment:r.closed_setup_payment,closed_setup_installment_values:r.closed_setup_installment_values}}).sort((a:Row,b:Row)=>(rank[a.stage]??9)-(rank[b.stage]??9)||time(b.updated_at)-time(a.updated_at));
  const open=leads.filter((r:Row)=>!["fechado","perdido"].includes(r.stage)),advanced=open.filter((r:Row)=>["reuniao","proposta","negociacao"].includes(r.stage)),won30=leads.filter((r:Row)=>r.stage==="fechado"&&(daysSince(r.closed_at||r.updated_at)??999)<=30);
  const perf=new Map<string,Row>();for(const p of (crmProfiles||[]).filter((r:Row)=>ownerIds.includes(String(r.id))))perf.set(String(p.id),{owner_id:p.id,owner_name:ownerLabel(p.email),open_leads:0,meetings:0,proposals:0,negotiations:0,won:0,won_30d:0,weighted_value:0});
  for(const lead of leads){const b=perf.get(String(lead.owner_id));if(!b)continue;if(!["fechado","perdido"].includes(lead.stage))b.open_leads++;if(lead.stage==="reuniao")b.meetings++;if(lead.stage==="proposta")b.proposals++;if(lead.stage==="negociacao")b.negotiations++;if(lead.stage==="fechado")b.won++;if(lead.stage==="fechado"&&(daysSince(lead.closed_at||lead.updated_at)??999)<=30)b.won_30d++;if(!["fechado","perdido"].includes(lead.stage))b.weighted_value+=num(lead.weighted_value)}
  const performance=[...perf.values()].map((r:Row)=>({...r,weighted_value:Number(r.weighted_value.toFixed(2))}));
  const stage_summary=Object.values(open.reduce((acc:Record<string,Row>,r:Row)=>{acc[r.stage]||={stage:r.stage,count:0,informed_value:0,weighted_value:0};acc[r.stage].count++;acc[r.stage].informed_value+=num(r.estimated_value);acc[r.stage].weighted_value+=num(r.weighted_value);return acc},{})).map((r:Row)=>({...r,informed_value:Number(r.informed_value.toFixed(2)),weighted_value:Number(r.weighted_value.toFixed(2))})).sort((a:Row,b:Row)=>(rank[a.stage]??9)-(rank[b.stage]??9));

  const campaigns=campaignRes.data||[],campaignByClient=new Map(campaigns.map((r:Row)=>[String(r.client_id),r]));
  const portfolio_clients=(clientRes.data||[]).map((r:Row)=>{const c:any=campaignByClient.get(String(r.id)),start=time(r.entrada),end=r.lifecycle==="CHURNED"&&r.saida?time(r.saida):Date.now();return{client_id:r.id,display_name:r.display_name,lifecycle:r.lifecycle,service:r.service,entrada:r.entrada,saida:r.saida,cs_owner:r.cs_owner,gt_owner:r.gt_owner,client_days:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/86400000)):null,campaign:c?{latest_date:c.latest_date,active_campaigns:c.active_campaigns,spend:c.spend,leads:c.leads,ctr:c.ctr,cost_per_result:c.cost_per_result}:null}});
  const clientNames=new Map(portfolio_clients.map((r:Row)=>[String(r.client_id),r.display_name]));
  const leadIds=new Set(leads.map((r:Row)=>String(r.id)));
  const prospect_profiles=(prospectRes.data||[]).filter((r:Row)=>leadIds.has(String(r.lead_id)));
  const profileByLead=new Map(prospect_profiles.map((r:Row)=>[String(r.lead_id),r]));
  const commercial_calls=(callRes.data||[]).filter((r:Row)=>leadIds.has(String(r.lead_id)));
  const commercial_activities=(activityRes.data||[]).filter((r:Row)=>leadIds.has(String(r.lead_id)));
  const transcriptById=new Map((meetingRes.data||[]).map((r:Row)=>[String(r.id),r]));
  for(const call of commercial_calls){const tr:any=call.transcript_id?transcriptById.get(String(call.transcript_id)):null;if(tr){call.transcript_summary=tr.metadata?.donnah_summary||tr.summary||null;call.decisions=tr.decisions||[];call.commitments=tr.commitments||[];call.ai_signals=tr.ai_signals||{};}}
  const callsByLead=new Map<string,Row[]>(),activitiesByLead=new Map<string,Row[]>();
  for(const row of commercial_calls){const key=String(row.lead_id);const list=callsByLead.get(key)||[];list.push(row);callsByLead.set(key,list);}
  for(const row of commercial_activities){const key=String(row.lead_id);const list=activitiesByLead.get(key)||[];list.push(row);activitiesByLead.set(key,list);}
  for(const lead of leads){const key=String(lead.id),profile:any=profileByLead.get(key)||null,calls=callsByLead.get(key)||[],activities=activitiesByLead.get(key)||[];lead.prospect_profile=profile;lead.call_count=calls.length;lead.last_call=calls[0]||null;lead.activity_count=activities.length;lead.followup_overdue=Boolean(profile?.next_step_at&&time(profile.next_step_at)<Date.now()&&!["fechado","perdido"].includes(lead.stage));lead.no_activity=!calls.length&&!activities.length&&(daysSince(lead.created_at)??0)>=1;}
  const callByTranscript=new Map(commercial_calls.filter((r:Row)=>r.transcript_id).map((r:Row)=>[String(r.transcript_id),r]));
  const meetings=(meetingRes.data||[]).filter((r:Row)=>{const owner=norm(r.metadata?.mcp_owner_person||r.owner_person);const linked=callByTranscript.has(String(r.id));return isCloser?(owner===norm(person)||linked):(meetingOwners.has(owner)||linked);}).map((r:Row)=>{const call:any=callByTranscript.get(String(r.id));const lead=call?leads.find((l:Row)=>String(l.id)===String(call.lead_id)):null;return{id:r.id,title:r.metadata?.donnah_title||r.metadata?.tipo_reuniao||(lead?("Call comercial · "+(lead.company||lead.name)):"Reunião comercial"),summary:r.metadata?.donnah_summary||r.summary||call?.ai_summary||"Sem resumo disponível.",type:r.metadata?.tipo_reuniao||(call?"PROSPECT_CALL":null),owner:call?.sdr_person||r.metadata?.mcp_owner_person||r.owner_person||null,closer:call?.closer_person||null,prospect_id:lead?.id||null,prospect_name:lead?(lead.company||lead.name):null,participants:Array.isArray(r.participants)?r.participants:[],client_id:r.client_id||null,client_name:r.client_id?clientNames.get(String(r.client_id))||null:null,match_status:r.match_status,meeting_started_at:r.meeting_started_at,ingested_at:r.ingested_at,decisions:r.decisions||[],commitments:r.commitments||[],ai_signals:r.ai_signals||{}}});
  const now=new Date(),goals=(goalRes.data||[]).filter((r:Row)=>Number(r.ano)===now.getFullYear()&&Number(r.mes)===now.getMonth()+1).map((r:Row)=>({...r,owner_name:ownerMap.get(String(r.owner_id))||"Comercial"}));

  const my_work=(workRes.data||[]).map((r:Row)=>({...r,client_name:r.client_id?clientNames.get(String(r.client_id))||null:null}));
  const creativeClientIds=[...new Set(my_work.map((r:Row)=>String(r.client_id||"")).filter(Boolean))];
  let creative_clients:Row[]=[];
  if(creativeClientIds.length){
    const[brandRes,ruleRes,learningRes]=await Promise.all([
      ops.from("creative_brand_profiles").select("client_id,color_palette,fonts,logo_rules,visual_direction,asset_links,status,source_type,last_verified_at,updated_at").in("client_id",creativeClientIds),
      ops.from("creative_client_rules").select("id,client_id,classification,rule_kind,rule_text,product_scope,status,confidence,source_type,observed_at,last_confirmed_at,updated_at").in("client_id",creativeClientIds).order("updated_at",{ascending:false}),
      ops.from("creative_learning_client_summary").select("client_id,coverage_pct,conflict_count,learned_count,weak_signal_count,last_signal_at,evidence_count,evidence_sources,learned_items,questions,profile_status").in("client_id",creativeClientIds)
    ]);
    const creativeFail=[brandRes,ruleRes,learningRes].find((r:any)=>r?.error);if(creativeFail?.error)return reply({error:"creative_query_failed",detail:creativeFail.error.message},500);
    const brandMap=new Map((brandRes.data||[]).map((r:Row)=>[String(r.client_id),r])),learnMap=new Map((learningRes.data||[]).map((r:Row)=>[String(r.client_id),r]));
    creative_clients=creativeClientIds.map(id=>({client_id:id,display_name:clientNames.get(id)||"Cliente",brand:brandMap.get(id)||null,learning:learnMap.get(id)||null,rules:(ruleRes.data||[]).filter((r:Row)=>String(r.client_id)===id)}));
  }

  const latestCrm=leads.map((r:Row)=>r.updated_at).filter(Boolean).sort().at(-1)||null,latestMeeting=meetings.map((r:Row)=>r.ingested_at).filter(Boolean).sort().at(-1)||null,latestCampaign=campaigns.map((r:Row)=>r.latest_date).filter(Boolean).sort().at(-1)||null,campaignReference=latestCampaign?`${latestCampaign}T23:59:59-03:00`:null;
  const crmAge=hoursSince(latestCrm),meetingAge=hoursSince(latestMeeting),campaignAge=hoursSince(campaignReference);

  return reply({
    profile:{person,role:roster.role,display_role:isCloser?"Closer":"Direção Comercial",access_level:isCloser?"CLOSER_OWN_PIPELINE":isLeonardo?"COMMERCIAL_MANAGER":"MANAGEMENT",read_only:false,can_edit:true,can_view_direction:!isCloser},
    summary:{open_leads:open.length,new_7d:open.filter((r:Row)=>(daysSince(r.created_at)??999)<=7).length,advanced_opportunities:advanced.length,meetings_7d:meetings.filter((r:Row)=>(daysSince(r.meeting_started_at||r.ingested_at)??999)<=7).length,won_30d:won30.length,won_monthly_30d:Number(won30.reduce((s:number,r:Row)=>s+num(r.closed_monthly_value),0).toFixed(2)),won_setup_30d:Number(won30.reduce((s:number,r:Row)=>s+num(r.closed_setup_value),0).toFixed(2)),informed_pipeline_value:Number(open.reduce((s:number,r:Row)=>s+num(r.estimated_value),0).toFixed(2)),weighted_forecast_value:Number(open.reduce((s:number,r:Row)=>s+num(r.weighted_value),0).toFixed(2)),followups_overdue:open.filter((r:Row)=>r.followup_overdue).length,prospects_with_calls:leads.filter((r:Row)=>Number(r.call_count||0)>0).length,active_clients:portfolio_clients.filter((r:Row)=>["ACTIVE","ONBOARDING"].includes(String(r.lifecycle))).length,active_campaigns:campaigns.reduce((s:number,r:Row)=>s+num(r.active_campaigns),0),my_work_open:my_work.filter((r:Row)=>!["COMPLETED","CANCELLED"].includes(String(r.status))).length},
    leads,prospect_profiles,commercial_calls,commercial_activities,stage_summary,performance,goals,campaigns,portfolio_clients,meetings,my_work,creative_clients,
    sources:{crm:{updated_at:latestCrm,age_hours:crmAge,stale:(crmAge??9999)>48},meetings:{updated_at:latestMeeting,age_hours:meetingAge,stale:(meetingAge??9999)>24},campaigns:{updated_at:campaignReference,age_hours:campaignAge,stale:(campaignAge??9999)>72}},
    data_quality:{real_crm_owners:ownerIds.length,crm_leads:leads.length,note:isCloser?"Escopo do closer: somente o próprio pipeline, prospects, calls, reuniões e contexto comercial. Operação, financeiro administrativo, acessos, WhatsApp de clientes e gestão geral ficam excluídos.":"Escopo da direção: comercial completo; operação geral, WhatsApp, saúde, ClickUp e alertas continuam excluídos."},generated_at:new Date().toISOString()
  });
});
