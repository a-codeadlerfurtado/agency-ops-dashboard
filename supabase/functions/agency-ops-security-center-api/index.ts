import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

type Row=Record<string,any>;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(req.method!=="POST") return reply({ok:false,error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service) return reply({ok:false,error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer ")) return reply({ok:false,error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData}=await auth.auth.getUser(); const user=userData?.user;
  if(!user) return reply({ok:false,error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person,name").eq("user_key",user.id).maybeSingle();
  const person=String(pref?.collaborator_person||pref?.name||"").trim();
  const {data:roster}=await ops.from("team_roster").select("role,is_former").eq("person",person).maybeSingle();
  if(!person||!roster||roster.is_former||String(roster.role).toUpperCase()!=="MGMT") return reply({ok:false,error:"forbidden"},403);
  const body=await req.json().catch(()=>({})); const action=String(body?.action||"SUMMARY").toUpperCase();

  async function snapshot(){
    const [{data:findings,error:fErr},{data:states,error:sErr}]=await Promise.all([
      ops.from("credential_exposure_findings").select("id,source_type,source_id,client_id,source_at,source_title,secret_type,severity,masked_context,status,detected_at,last_seen_at,resolved_at,resolution_note,resolved_by").order("status",{ascending:true}).order("source_at",{ascending:false,nullsFirst:false}).limit(250),
      ops.from("credential_exposure_scan_state").select("source_type,last_source_id,last_run_at,last_new_findings,updated_at").order("source_type")
    ]);
    if(fErr||sErr) throw new Error(fErr?.message||sErr?.message||"query_failed");
    const clientIds=[...new Set((findings||[]).map((r:Row)=>r.client_id).filter(Boolean))];
    let clients:Row[]=[]; if(clientIds.length){const {data}=await ops.from("clients").select("id,display_name,lifecycle").in("id",clientIds);clients=data||[];}
    const map=new Map(clients.map((c:Row)=>[c.id,c]));
    const rows=(findings||[]).map((r:Row)=>({...r,client:map.get(r.client_id)||null,fingerprint:undefined}));
    const open=rows.filter((r:Row)=>r.status==="OPEN");
    return {findings:rows,scan_state:states||[],summary:{open:open.length,high:open.filter((r:Row)=>r.severity==="HIGH").length,openai_keys:open.filter((r:Row)=>r.secret_type==="OPENAI_API_KEY").length,passwords:open.filter((r:Row)=>r.secret_type==="PASSWORD").length,tokens:open.filter((r:Row)=>r.secret_type==="TOKEN"||r.secret_type==="META_ACCESS_TOKEN").length}};
  }

  try{
    if(action==="SUMMARY"||action==="LIST") return reply({ok:true,allowed:true,person,...await snapshot()});
    if(action==="RUN_SCAN"){
      const {data,error}=await ops.rpc("run_credential_security_scan"); if(error) return reply({ok:false,error:"scan_failed",detail:error.message},500);
      return reply({ok:true,scan:data,...await snapshot()});
    }
    if(action==="RESOLVE"){
      const id=String(body?.id||""); const status=String(body?.status||"").toUpperCase(); const note=String(body?.note||"").trim().slice(0,1000);
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["ROTATED","IGNORED","OPEN"].includes(status)) return reply({ok:false,error:"invalid_resolution"},400);
      const patch:Row={status,resolution_note:note||null,resolved_by:status==="OPEN"?null:person,resolved_at:status==="OPEN"?null:new Date().toISOString()};
      const {error}=await ops.from("credential_exposure_findings").update(patch).eq("id",id); if(error) return reply({ok:false,error:"update_failed"},500);
      return reply({ok:true,...await snapshot()});
    }
    return reply({ok:false,error:"unknown_action"},400);
  }catch(error){return reply({ok:false,error:"security_center_failed",detail:String(error instanceof Error?error.message:error).slice(0,300)},500);}
});
