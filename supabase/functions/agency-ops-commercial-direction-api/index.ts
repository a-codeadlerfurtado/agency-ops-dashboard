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
  const{data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).maybeSingle();if(!roster||roster.is_former)return reply({error:"forbidden"},403);
  const isLeonardo=person==="Leonardo Augusto"&&String(roster.role)==="COMMERCIAL";
  if(person!=="Adler Furtado"&&!isLeonardo)return reply({error:"forbidden"},403);

  const{data:crmProfiles,error:profileError}=await db.from("profiles").select("id,email,sees_all_leads").eq("sees_all_leads",true);if(profileError)return reply({error:"crm_profiles_failed",detail:profileError.message},500);
  const ownerIds=(crmProfiles||[]).map((r:Row)=>String(r.id)),ownerMap=new Map((crmProfiles||[]).map((r:Row)=>[String(r.id),ownerLabel(r.email)]));

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

  const leadQuery=ownerIds.length?crm.from("leads").select("id,owner_id,name,company,stage,estimated_value,source,created_at,updated_at,closed_at,closed_monthly_value,closed_setup_value,closed_term_months,closed_monthly_first_month,closed_setup_first_month,closed_setup_payment,closed_setup_installment_values,archived_at").in("owner_id",ownerIds).order("updated_at",{ascending:false}).limit(2000):Promise.resolve({data:[],error:null});
  const[leadRes,goalRes,clientRes,campaignRes,meetingRes,workRes]=await Promise.all([
    leadQuery,
    ownerIds.length?crm.from("closer_goals").select("owner_id,ano,mes,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id",ownerIds).order("ano",{ascending:false}).order("mes",{ascending:false}):Promise.resolve({data:[],error:null}),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("entrada",{ascending:false}).limit(1200),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle",["ACTIVE","ONBOARDING"]).order("spend",{ascending:false}).limit(1200),
    ops.from("meeting_transcripts").select("id,meeting_started_at,ingested_at,client_id,match_status,participants,summary,metadata").order("ingested_at",{ascending:false}).limit(800),
    isLeonardo?ops.from("work_items").select("id,client_id,type,status,priority,title,description,source,due_at,snoozed_until,started_at,completed_at,resolution,created_at,updated_at").eq("target_person",person).order("updated_at",{ascending:false}).limit(300):Promise.resolve({data:[],error:null})
  ]);
  const failed=[leadRes,goalRes,clientRes,campaignRes,meetingRes,workRes].find((r:any)=>r?.error);if(failed?.error)return reply({error:"query_failed",detail:failed.error.message},500);

  const leads=(leadRes.data||[]).filter((r:Row)=>!r.archived_at).map((r:Row)=>{const stage=norm(r.stage)||"novo",estimated=num(r.estimated_value);return{id:r.id,owner_id:r.owner_id,owner_name:ownerMap.get(String(r.owner_id))||"Não atribuído",name:r.name,company:r.company,stage,estimated_value:estimated,weighted_value:Number((estimated*(weight[stage]??.1)).toFixed(2)),source:r.source,created_at:r.created_at,updated_at:r.updated_at,closed_at:r.closed_at,closed_monthly_value:r.closed_monthly_value,closed_setup_value:r.closed_setup_value,closed_term_months:r.closed_term_months,closed_monthly_first_month:r.closed_monthly_first_month,closed_setup_first_month:r.closed_setup_first_month,closed_setup_payment:r.closed_setup_payment,closed_setup_installment_values:r.closed_setup_installment_values}}).sort((a:Row,b:Row)=>(rank[a.stage]??9)-(rank[b.stage]??9)||time(b.updated_at)-time(a.updated_at));
  const open=leads.filter((r:Row)=>!["fechado","perdido"].includes(r.stage)),advanced=open.filter((r:Row)=>["reuniao","proposta","negociacao"].includes(r.stage)),won30=leads.filter((r:Row)=>r.stage==="fechado"&&(daysSince(r.closed_at||r.updated_at)??999)<=30);
  const perf=new Map<string,Row>();for(const p of crmProfiles||[])perf.set(String(p.id),{owner_id:p.id,owner_name:ownerLabel(p.email),open_leads:0,meetings:0,proposals:0,negotiations:0,won:0,won_30d:0,weighted_value:0});
  for(const lead of leads){const b=perf.get(String(lead.owner_id));if(!b)continue;if(!["fechado","perdido"].includes(lead.stage))b.open_leads++;if(lead.stage==="reuniao")b.meetings++;if(lead.stage==="proposta")b.proposals++;if(lead.stage==="negociacao")b.negotiations++;if(lead.stage==="fechado")b.won++;if(lead.stage==="fechado"&&(daysSince(lead.closed_at||lead.updated_at)??999)<=30)b.won_30d++;if(!["fechado","perdido"].includes(lead.stage))b.weighted_value+=num(lead.weighted_value)}
  const performance=[...perf.values()].map((r:Row)=>({...r,weighted_value:Number(r.weighted_value.toFixed(2))}));
  const stage_summary=Object.values(open.reduce((acc:Record<string,Row>,r:Row)=>{acc[r.stage]||={stage:r.stage,count:0,informed_value:0,weighted_value:0};acc[r.stage].count++;acc[r.stage].informed_value+=num(r.estimated_value);acc[r.stage].weighted_value+=num(r.weighted_value);return acc},{})).map((r:Row)=>({...r,informed_value:Number(r.informed_value.toFixed(2)),weighted_value:Number(r.weighted_value.toFixed(2))})).sort((a:Row,b:Row)=>(rank[a.stage]??9)-(rank[b.stage]??9));

  const campaigns=campaignRes.data||[],campaignByClient=new Map(campaigns.map((r:Row)=>[String(r.client_id),r]));
  const portfolio_clients=(clientRes.data||[]).map((r:Row)=>{const c:any=campaignByClient.get(String(r.id)),start=time(r.entrada),end=r.lifecycle==="CHURNED"&&r.saida?time(r.saida):Date.now();return{client_id:r.id,display_name:r.display_name,lifecycle:r.lifecycle,service:r.service,entrada:r.entrada,saida:r.saida,cs_owner:r.cs_owner,gt_owner:r.gt_owner,client_days:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/86400000)):null,campaign:c?{latest_date:c.latest_date,active_campaigns:c.active_campaigns,spend:c.spend,leads:c.leads,ctr:c.ctr,cost_per_result:c.cost_per_result}:null}});
  const clientNames=new Map(portfolio_clients.map((r:Row)=>[String(r.client_id),r.display_name]));
  const meetings=(meetingRes.data||[]).filter((r:Row)=>meetingOwners.has(norm(r.metadata?.mcp_owner_person))).map((r:Row)=>({id:r.id,title:r.metadata?.donnah_title||r.metadata?.tipo_reuniao||"Reunião comercial",summary:r.metadata?.donnah_summary||r.summary||"Sem resumo disponível.",type:r.metadata?.tipo_reuniao||null,owner:r.metadata?.mcp_owner_person||null,participants:Array.isArray(r.participants)?r.participants:[],client_id:r.client_id||null,client_name:r.client_id?clientNames.get(String(r.client_id))||null:null,match_status:r.match_status,meeting_started_at:r.meeting_started_at,ingested_at:r.ingested_at}));
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
    profile:{person,role:roster.role,display_role:"Direção Comercial",access_level:isLeonardo?"COMMERCIAL_MANAGER":"MANAGEMENT",read_only:false,can_edit:true},
    summary:{open_leads:open.length,new_7d:open.filter((r:Row)=>(daysSince(r.created_at)??999)<=7).length,advanced_opportunities:advanced.length,meetings_7d:meetings.filter((r:Row)=>(daysSince(r.meeting_started_at||r.ingested_at)??999)<=7).length,won_30d:won30.length,won_monthly_30d:Number(won30.reduce((s:number,r:Row)=>s+num(r.closed_monthly_value),0).toFixed(2)),won_setup_30d:Number(won30.reduce((s:number,r:Row)=>s+num(r.closed_setup_value),0).toFixed(2)),informed_pipeline_value:Number(open.reduce((s:number,r:Row)=>s+num(r.estimated_value),0).toFixed(2)),weighted_forecast_value:Number(open.reduce((s:number,r:Row)=>s+num(r.weighted_value),0).toFixed(2)),active_clients:portfolio_clients.filter((r:Row)=>["ACTIVE","ONBOARDING"].includes(String(r.lifecycle))).length,active_campaigns:campaigns.reduce((s:number,r:Row)=>s+num(r.active_campaigns),0),my_work_open:my_work.filter((r:Row)=>!["COMPLETED","CANCELLED"].includes(String(r.status))).length},
    leads,stage_summary,performance,goals,campaigns,portfolio_clients,meetings,my_work,creative_clients,
    sources:{crm:{updated_at:latestCrm,age_hours:crmAge,stale:(crmAge??9999)>48},meetings:{updated_at:latestMeeting,age_hours:meetingAge,stale:(meetingAge??9999)>24},campaigns:{updated_at:campaignReference,age_hours:campaignAge,stale:(campaignAge??9999)>72}},
    data_quality:{real_crm_owners:ownerIds.length,crm_leads:leads.length,note:"Escopo do Leonardo: comercial completo; trabalho e criativos somente quando atribuídos diretamente a ele. Operação geral, WhatsApp, saúde, ClickUp e alertas continuam excluídos."},generated_at:new Date().toISOString()
  });
});
