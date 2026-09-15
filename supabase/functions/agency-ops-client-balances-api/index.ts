import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
type Row=Record<string,any>;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return reply({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";if(!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const{data:userData,error:authError}=await auth.auth.getUser();if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const[{data:pref},{data:approvals}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)
  ]);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();if(!person||!(approvals||[]).length)return reply({error:"profile_locked"},403);
  const{data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).maybeSingle();
  const role=String(roster?.role||"").toUpperCase(),isAdler=person==="Adler Furtado"&&!roster?.is_former;
  if(!(isAdler||(["GT","CS"].includes(role)&&!roster?.is_former)))return reply({error:"forbidden"},403);
  if(req.method==="GET"&&new URL(req.url).searchParams.get("probe")==="1")return reply({ok:true,profile:{person,role,scope:isAdler?"ALL":"OWN_PORTFOLIO"}});

  async function load(){
    let q=ops.from("client_balance_overview").select("*").order("display_name",{ascending:true});
    if(!isAdler&&role==="GT")q=q.eq("gt_owner",person);if(!isAdler&&role==="CS")q=q.eq("cs_owner",person);
    const{data,error}=await q.limit(2000);if(error)throw error;const rows=(data||[]) as Row[];
    const{data:health}=await ops.from("automation_health").select("last_success_at,last_error_at,last_error,updated_at").eq("job_name","meta_balance_sync").maybeSingle();
    const lastSuccess=health?.last_success_at||null,ageMinutes=lastSuccess?Math.max(0,Math.round((Date.now()-new Date(lastSuccess).getTime())/60000)):null;
    const clients=new Set(rows.map(r=>String(r.client_id))).size,prepaid=rows.filter(r=>Number(r.funding_type)===20).length,cards=rows.filter(r=>Number(r.funding_type)===1).length;
    const noAccount=new Set(rows.filter(r=>!r.account_key).map(r=>String(r.client_id))).size,critical=rows.filter(r=>["NO_BALANCE","BLOCKED"].includes(String(r.run_status))).length;
    const attention=rows.filter(r=>["LOW_BALANCE","ATTENTION","UNKNOWN"].includes(String(r.run_status))).length;
    return{rows,summary:{clients,accounts:rows.filter(r=>r.account_key).length,prepaid,cards,no_account:noAccount,critical,attention},sync:{last_success_at:lastSuccess,last_error_at:health?.last_error_at||null,last_error:health?.last_error||null,age_minutes:ageMinutes,refresh_recommended:ageMinutes===null||ageMinutes>=60,fallback:"3h",event_cooldown_minutes:60}};
  }
  if(req.method==="GET"){try{const loaded=await load();return reply({ok:true,profile:{person,role,scope:isAdler?"ALL":"OWN_PORTFOLIO"},...loaded,generated_at:new Date().toISOString()});}catch(error){return reply({error:"query_failed",detail:error instanceof Error?error.message:String(error)},500);}}
  const body=await req.json().catch(()=>({}));if(String(body?.action||"")!=="refresh")return reply({error:"unknown_action"},400);
  try{const{data,error}=await ops.rpc("request_meta_balance_refresh",{p_cooldown_minutes:60});if(error)throw error;return reply({ok:true,refresh:data,requested_by:person,requested_at:new Date().toISOString()});}
  catch(error){return reply({error:"refresh_failed",detail:error instanceof Error?error.message:String(error)},500);}
});
