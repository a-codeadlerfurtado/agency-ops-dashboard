import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const num=(v:unknown)=>Number(v??0)||0;
const time=(v:unknown)=>v?new Date(String(v)).getTime():NaN;
const daysSince=(v:unknown)=>Number.isFinite(time(v))?Math.max(0,Math.floor((Date.now()-time(v))/86400000)):null;
const hoursSince=(v:unknown)=>Number.isFinite(time(v))?Math.max(0,Number(((Date.now()-time(v))/3600000).toFixed(1))):null;
const ownerLabel=(email:unknown)=>{const key=norm(email);if(key==="lakassessoriadigital@gmail.com")return"Leonardo Augusto";if(key==="feitozaluizvitor@gmail.com")return"Vitor Feitoza";if(!key)return"Não atribuído";return String(email).split("@")[0].replace(/[._-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase())};
const weight:Record<string,number>={novo:.10,qualificacao:.25,reuniao:.45,proposta:.65,negociacao:.80,fechado:1,perdido:0};
const rank:Record<string,number>={negociacao:0,proposta:1,reuniao:2,qualificacao:3,novo:4,fechado:5,perdido:6};
const meetingOwners=new Set(["leonardo augusto","vitor feitoza","luiz vitor feitoza"]);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return reply({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";if(!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});const{data:userData,error:authError}=await auth.auth.getUser();if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops"),crm=db.schema("crm");
  const[{data:pref},{data:approvals}]=await Promise.all([ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)]);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();if(!person||!(approvals||[]).length)return reply({error:"profile_locked"},403);
  const{data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).maybeSingle();if(!roster||roster.is_former)return reply({error:"forbidden"},403);
  if(person!=="Adler Furtado"&&!(person==="Leonardo Augusto"&&String(roster.role)==="COMMERCIAL"))return reply({error:"forbidden"},403);

  const{data:crmProfiles,error:profileError}=await db.from("profiles").select("id,email,sees_all_leads").eq("sees_all_leads",true);if(profileError)return reply({error:"crm_profiles_failed",detail:profileError.message},500);
  const ownerIds=(crmProfiles||[]).map((r:any)=>String(r.id)),ownerMap=new Map((crmProfiles||[]).map((r:any)=>[String(r.id),ownerLabel(r.email)]));
  const leadQuery=ownerIds.length?crm.from("leads").select("id,owner_id,name,company,stage,estimated_value,source,created_at,updated_at,closed_at,closed_monthly_value,closed_setup_value,closed_term_months,closed_monthly_first_month,closed_setup_first_month,closed_setup_payment,closed_setup_installment_values,archived_at").in("owner_id",ownerIds).order("updated_at",{ascending:false}).limit(2000):Promise.resolve({data:[],error:null});
  const[leadRes,goalRes,clientRes,campaignRes,meetingRes]=await Promise.all([
    leadQuery,
    ownerIds.length?crm.from("closer_goals").select("owner_id,ano,mes,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id",ownerIds).order("ano",{ascending:false}).order("mes",{ascending:false}):Promise.resolve({data:[],error:null}),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("entrada",{ascending:false}).limit(1200),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle",["ACTIVE","ONBOARDING"]).order("spend",{ascending:false}).limit(1200),
    ops.from("meeting_transcripts").select("id,meeting_started_at,ingested_at,client_id,match_status,participants,summary,metadata").order("ingested_at",{ascending:false}).limit(800)
  ]);
  const failed=[leadRes,goalRes,clientRes,campaignRes,meetingRes].find((r:any)=>r?.error);if(failed?.error)return reply({error:"query_failed",detail:failed.error.message},500);

  const leads=(leadRes.data||[]).filter((r:any)=>!r.archived_at).map((r:any)=>{const stage=norm(r.stage)||"novo",estimated=num(r.estimated_value);return{id:r.id,owner_id:r.owner_id,owner_name:ownerMap.get(String(r.owner_id))||"Não atribuído",name:r.name,company:r.company,stage,estimated_value:estimated,weighted_value:Number((estimated*(weight[stage]??.1)).toFixed(2)),source:r.source,created_at:r.created_at,updated_at:r.updated_at,closed_at:r.closed_at,closed_monthly_value:r.closed_monthly_value,closed_setup_value:r.closed_setup_value,closed_term_months:r.closed_term_months,closed_monthly_first_month:r.closed_monthly_first_month,closed_setup_first_month:r.closed_setup_first_month,closed_setup_payment:r.closed_setup_payment,closed_setup_installment_values:r.closed_setup_installment_values}}).sort((a:any,b:any)=>(rank[a.stage]??9)-(rank[b.stage]??9)||time(b.updated_at)-time(a.updated_at));
  const open=leads.filter((r:any)=>!["fechado","perdido"].includes(r.stage)),advanced=open.filter((r:any)=>["reuniao","proposta","negociacao"].includes(r.stage)),won30=leads.filter((r:any)=>r.stage==="fechado"&&(daysSince(r.closed_at||r.updated_at)??999)<=30);
  const perf=new Map<string,any>();for(const p of crmProfiles||[])perf.set(String(p.id),{owner_id:p.id,owner_name:ownerLabel(p.email),open_leads:0,meetings:0,proposals:0,negotiations:0,won:0,won_30d:0,weighted_value:0});
  for(const lead of leads){const b=perf.get(String(lead.owner_id));if(!b)continue;if(!["fechado","perdido"].includes(lead.stage))b.open_leads++;if(lead.stage==="reuniao")b.meetings++;if(lead.stage==="proposta")b.proposals++;if(lead.stage==="negociacao")b.negotiations++;if(lead.stage==="fechado")b.won++;if(lead.stage==="fechado"&&(daysSince(lead.closed_at||lead.updated_at)??999)<=30)b.won_30d++;if(!["fechado","perdido"].includes(lead.stage))b.weighted_value+=num(lead.weighted_value)}
  const performance=[...perf.values()].map((r:any)=>({...r,weighted_value:Number(r.weighted_value.toFixed(2))}));
  const stage_summary=Object.values(open.reduce((acc:Record<string,any>,r:any)=>{acc[r.stage]||={stage:r.stage,count:0,informed_value:0,weighted_value:0};acc[r.stage].count++;acc[r.stage].informed_value+=num(r.estimated_value);acc[r.stage].weighted_value+=num(r.weighted_value);return acc},{})).map((r:any)=>({...r,informed_value:Number(r.informed_value.toFixed(2)),weighted_value:Number(r.weighted_value.toFixed(2))})).sort((a:any,b:any)=>(rank[a.stage]??9)-(rank[b.stage]??9));

  const campaigns=campaignRes.data||[],campaignByClient=new Map(campaigns.map((r:any)=>[String(r.client_id),r]));
  const portfolio_clients=(clientRes.data||[]).map((r:any)=>{const c:any=campaignByClient.get(String(r.id)),start=time(r.entrada),end=r.lifecycle==="CHURNED"&&r.saida?time(r.saida):Date.now();return{client_id:r.id,display_name:r.display_name,lifecycle:r.lifecycle,service:r.service,entrada:r.entrada,saida:r.saida,cs_owner:r.cs_owner,gt_owner:r.gt_owner,client_days:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/86400000)):null,campaign:c?{latest_date:c.latest_date,active_campaigns:c.active_campaigns,spend:c.spend,leads:c.leads,ctr:c.ctr,cost_per_result:c.cost_per_result}:null}});
  const clientNames=new Map(portfolio_clients.map((r:any)=>[String(r.client_id),r.display_name]));
  const meetings=(meetingRes.data||[]).filter((r:any)=>meetingOwners.has(norm(r.metadata?.mcp_owner_person))).map((r:any)=>({id:r.id,title:r.metadata?.donnah_title||r.metadata?.tipo_reuniao||"Reunião comercial",summary:r.metadata?.donnah_summary||r.summary||"Sem resumo disponível.",type:r.metadata?.tipo_reuniao||null,owner:r.metadata?.mcp_owner_person||null,participants:Array.isArray(r.participants)?r.participants:[],client_id:r.client_id||null,client_name:r.client_id?clientNames.get(String(r.client_id))||null:null,match_status:r.match_status,meeting_started_at:r.meeting_started_at,ingested_at:r.ingested_at}));
  const now=new Date(),goals=(goalRes.data||[]).filter((r:any)=>Number(r.ano)===now.getFullYear()&&Number(r.mes)===now.getMonth()+1).map((r:any)=>({...r,owner_name:ownerMap.get(String(r.owner_id))||"Comercial"}));
  const latestCrm=leads.map((r:any)=>r.updated_at).filter(Boolean).sort().at(-1)||null,latestMeeting=meetings.map((r:any)=>r.ingested_at).filter(Boolean).sort().at(-1)||null,latestCampaign=campaigns.map((r:any)=>r.latest_date).filter(Boolean).sort().at(-1)||null,campaignReference=latestCampaign?`${latestCampaign}T23:59:59-03:00`:null;
  const crmAge=hoursSince(latestCrm),meetingAge=hoursSince(latestMeeting),campaignAge=hoursSince(campaignReference);

  return reply({
    profile:{person,role:roster.role,display_role:"Direção Comercial",access_level:"COMMERCIAL_READ_ONLY",read_only:true},
    summary:{open_leads:open.length,new_7d:open.filter((r:any)=>(daysSince(r.created_at)??999)<=7).length,advanced_opportunities:advanced.length,meetings_7d:meetings.filter((r:any)=>(daysSince(r.meeting_started_at||r.ingested_at)??999)<=7).length,won_30d:won30.length,won_monthly_30d:Number(won30.reduce((s:number,r:any)=>s+num(r.closed_monthly_value),0).toFixed(2)),won_setup_30d:Number(won30.reduce((s:number,r:any)=>s+num(r.closed_setup_value),0).toFixed(2)),informed_pipeline_value:Number(open.reduce((s:number,r:any)=>s+num(r.estimated_value),0).toFixed(2)),weighted_forecast_value:Number(open.reduce((s:number,r:any)=>s+num(r.weighted_value),0).toFixed(2)),active_clients:portfolio_clients.filter((r:any)=>["ACTIVE","ONBOARDING"].includes(String(r.lifecycle))).length,active_campaigns:campaigns.reduce((s:number,r:any)=>s+num(r.active_campaigns),0)},
    leads,stage_summary,performance,goals,campaigns,portfolio_clients,meetings,
    sources:{crm:{updated_at:latestCrm,age_hours:crmAge,stale:(crmAge??9999)>48},meetings:{updated_at:latestMeeting,age_hours:meetingAge,stale:(meetingAge??9999)>24},campaigns:{updated_at:latestCampaign,age_hours:campaignAge,stale:(campaignAge??9999)>72}},
    data_quality:{real_crm_owners:ownerIds.length,crm_leads:leads.length,note:"Fonte comercial única: CRM para funil, campanhas ativas e carteira básica. Nenhum dado de WhatsApp, saúde, ClickUp, alertas, compromissos ou onboarding é retornado."},generated_at:new Date().toISOString()
  });
});
