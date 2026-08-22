import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method)) return respond({error:"method_not_allowed"},405);

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey=Deno.env.get("SUPABASE_ANON_KEY");
  if(!supabaseUrl||!serviceRole||!anonKey) return respond({error:"server_configuration"},500);

  const authHeader=req.headers.get("Authorization")??"";
  if(!authHeader.startsWith("Bearer ")) return respond({error:"unauthorized"},401);
  const authClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData}=await authClient.auth.getUser();
  if(!userData?.user) return respond({error:"unauthorized"},401);

  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const userKey=userData.user.id;

  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",userKey).maybeSingle();
  const person=pref?.collaborator_person??null;
  if(!person) return respond({eligible:false,incidents:[]});
  const {data:roster}=await ops.from("team_roster").select("role,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||roster.role!=="GT") return respond({eligible:false,person,incidents:[]});

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const incidentId=String(body?.incident_id??"").trim();
    if(!incidentId) return respond({error:"incident_id_required"},400);
    const {data:incident,error:incidentError}=await ops.from("lead_dispatch_quality_incidents")
      .select("id,target_gt,status,notification_id,occurrence_no")
      .eq("id",incidentId).maybeSingle();
    if(incidentError) return respond({error:"query_failed",detail:incidentError.message},500);
    if(!incident) return respond({error:"not_found"},404);
    if(incident.target_gt!==person) return respond({error:"forbidden"},403);
    if(incident.status==="OPEN"){
      const {error:updateError}=await ops.from("lead_dispatch_quality_incidents").update({
        status:"ACKNOWLEDGED",
        acknowledged_by_user_key:userKey,
        acknowledged_by_person:person,
        acknowledged_at:new Date().toISOString(),
        updated_at:new Date().toISOString(),
      }).eq("id",incidentId).eq("status","OPEN");
      if(updateError) return respond({error:"ack_failed",detail:updateError.message},500);
    }
    if(incident.notification_id){
      await ops.from("platform_notification_reads").upsert({notification_id:incident.notification_id,user_key:userKey,read_at:new Date().toISOString()},{onConflict:"notification_id,user_key"});
    }
    return respond({ok:true,acknowledged:true,incident_id:incidentId,person});
  }

  const {data:incidents,error}=await ops.from("lead_dispatch_quality_incidents")
    .select("id,message_id,client_id,client_name,target_gt,product_label,missing_required,missing_extra_questions,occurrence_no,severity,status,raw_text,created_at")
    .eq("target_gt",person).eq("status","OPEN")
    .order("occurrence_no",{ascending:false}).order("created_at",{ascending:true}).limit(50);
  if(error) return respond({error:"query_failed",detail:error.message},500);
  return respond({eligible:true,person,incidents:incidents??[],generated_at:new Date().toISOString()});
});
