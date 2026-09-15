import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization,apikey","access-control-allow-methods":"POST,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clean=(value:unknown,max=160)=>String(value??"").trim().slice(0,max);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="POST")return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),anonKey=Deno.env.get("SUPABASE_ANON_KEY"),serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceRole)return json({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);
  const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}}});
  const{data:authData,error:authError}=await auth.auth.getUser();
  if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const{data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",authData.user.id).maybeSingle();
  const person=clean(pref?.collaborator_person,120);
  const{data:roster}=await ops.from("team_roster").select("person,role").eq("person",person).eq("is_former",false).maybeSingle();
  const role=String(roster?.role||"").toUpperCase();
  if(!person||!roster||!["GT","MGMT"].includes(role))return json({error:"forbidden"},403);
  const body=await req.json().catch(()=>({}));
  const reportId=clean(body?.report_id,80);
  const sent=body?.sent===true;
  if(!reportId)return json({error:"report_id_required"},400);
  let q=ops.from("weekly_client_reports").select("id,gt_owner,report_kind,status,audit_status,shared_at").eq("id",reportId);
  if(role==="GT")q=q.eq("gt_owner",person);
  const{data:report,error:reportError}=await q.maybeSingle();
  if(reportError)return json({error:"report_lookup_failed",detail:clean(reportError.message,500)},500);
  if(!report)return json({error:"report_not_found"},404);
  if(report.report_kind!=="WEEKLY")return json({error:"weekly_only"},409);
  if(report.status!=="READY"||report.audit_status!=="PASS")return json({error:"report_not_shareable"},409);
  const sharedAt=sent?new Date().toISOString():null;
  const{error:updateError}=await ops.from("weekly_client_reports").update({shared_at:sharedAt,updated_at:new Date().toISOString()}).eq("id",reportId);
  if(updateError)return json({error:"update_failed",detail:clean(updateError.message,500)},500);
  return json({ok:true,report_id:reportId,sent,shared_at:sharedAt,updated_by:person});
});
