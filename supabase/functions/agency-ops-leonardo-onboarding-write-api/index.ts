import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const STAGE_STATUS=new Set(["PENDING","SCHEDULED","IN_PROGRESS","DONE","BLOCKED","SKIPPED"]);
const RISKS=new Set(["OK","ATTENTION","HIGH","CRITICAL"]);
type Row=Record<string,any>;

function optionalDate(value:unknown){
  if(value===null||value===undefined||value==="")return null;
  const date=new Date(String(value));
  if(Number.isNaN(date.getTime()))throw new Error("invalid_date");
  return date.toISOString();
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return reply({error:"server_configuration"},500);
  const authorization=req.headers.get("Authorization")||"";
  if(!authorization.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
  const{data:userData,error:userError}=await auth.auth.getUser();
  if(userError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const userId=userData.user.id;
  const[{data:pref},{data:approval}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userId).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userId).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)
  ]);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();
  if(!(approval||[]).length||person!=="Leonardo Augusto")return reply({error:"forbidden"},403);
  const{data:roster}=await ops.from("team_roster").select("role,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||String(roster.role)!=="COMMERCIAL")return reply({error:"forbidden"},403);
  if(req.method==="GET")return reply({ok:true,person,can_edit:true});

  const body=await req.json().catch(()=>({}));
  const caseId=Number(body?.case_id||0);
  if(!Number.isInteger(caseId)||caseId<=0)return reply({error:"case_required"},400);
  const{data:caseRow,error:caseError}=await ops.from("onboarding_cases").select("*").eq("id",caseId).eq("status","OPEN").maybeSingle();
  if(caseError)return reply({error:"case_lookup_failed",detail:caseError.message},500);
  if(!caseRow)return reply({error:"case_not_found"},404);
  const{data:client}=await ops.from("clients").select("id,display_name,gt_owner").eq("id",caseRow.client_id).maybeSingle();
  const{data:stages}=await ops.from("onboarding_stages").select("*").eq("case_id",caseId).order("id");
  const before={case:caseRow,stages:stages||[],client};
  const action=String(body?.action||"update_case");
  const patch:Row={};

  try{
    if(action==="update_case"){
      if(body.current_stage!==undefined){
        const stage=String(body.current_stage||"").trim();
        const{data:def}=await ops.from("onboarding_stage_definitions").select("code").eq("code",stage).maybeSingle();
        if(!def)return reply({error:"invalid_stage"},400);
        patch.current_stage=stage;
      }
      if(body.next_action!==undefined)patch.next_action=String(body.next_action||"").trim().slice(0,1200)||null;
      if(body.next_action_due!==undefined)patch.next_action_due=optionalDate(body.next_action_due);
      if(body.onboarding_risk!==undefined){const risk=String(body.onboarding_risk||"").toUpperCase();if(!RISKS.has(risk))return reply({error:"invalid_risk"},400);patch.onboarding_risk=risk;}
      patch.updated_at=new Date().toISOString();
      const{error}=await ops.from("onboarding_cases").update(patch).eq("id",caseId);if(error)return reply({error:"case_update_failed",detail:error.message},500);
    }else if(action==="update_stage"){
      const stageCode=String(body?.stage_code||"").trim();
      if(!stageCode)return reply({error:"stage_required"},400);
      const{data:stageRow}=await ops.from("onboarding_stages").select("*").eq("case_id",caseId).eq("stage_code",stageCode).maybeSingle();
      if(!stageRow)return reply({error:"stage_not_found"},404);
      if(body.status!==undefined){const status=String(body.status||"").toUpperCase();if(!STAGE_STATUS.has(status))return reply({error:"invalid_status"},400);patch.status=status;const now=new Date().toISOString();if(status==="IN_PROGRESS"&&!stageRow.started_at)patch.started_at=now;if(["DONE","SKIPPED"].includes(status))patch.completed_at=now;if(!["DONE","SKIPPED"].includes(status))patch.completed_at=null;}
      if(body.due_at!==undefined)patch.due_at=optionalDate(body.due_at);
      if(body.notes!==undefined)patch.notes=String(body.notes||"").trim().slice(0,2000)||null;
      const{error}=await ops.from("onboarding_stages").update(patch).eq("id",stageRow.id);if(error)return reply({error:"stage_update_failed",detail:error.message},500);
      if(body.status!==undefined&&["IN_PROGRESS","SCHEDULED"].includes(String(body.status).toUpperCase()))await ops.from("onboarding_cases").update({current_stage:stageCode,updated_at:new Date().toISOString()}).eq("id",caseId);
    }else if(action==="assign_gt"){
      const gt=String(body?.gt_owner||"").trim();
      if(!gt)return reply({error:"gt_required"},400);
      const{data:gtRow}=await ops.from("team_roster").select("person").eq("person",gt).eq("role","GT").eq("is_former",false).maybeSingle();
      if(!gtRow)return reply({error:"invalid_gt"},400);
      patch.gt_owner=gt;
      const{error}=await ops.from("clients").update({gt_owner:gt}).eq("id",caseRow.client_id);if(error)return reply({error:"gt_update_failed",detail:error.message},500);
    }else return reply({error:"unknown_action"},400);
  }catch(error){return reply({error:error instanceof Error?error.message:"invalid_payload"},400);}

  const[{data:afterCase},{data:afterStages},{data:afterClient}]=await Promise.all([
    ops.from("onboarding_cases").select("*").eq("id",caseId).single(),
    ops.from("onboarding_stages").select("*").eq("case_id",caseId).order("id"),
    ops.from("clients").select("id,display_name,gt_owner").eq("id",caseRow.client_id).single()
  ]);
  const after={case:afterCase,stages:afterStages||[],client:afterClient};
  await ops.from("onboarding_admin_command_audit").insert({case_id:caseId,client_id:caseRow.client_id,actor_user_id:userId,actor_person:person,command_text:`LEONARDO_UI:${action}`,patch:{action,...patch},before_state:before,after_state:after});
  return reply({ok:true,action,client:{id:caseRow.client_id,display_name:client?.display_name||"Cliente"},before,after,updated_by:person,generated_at:new Date().toISOString()});
});
