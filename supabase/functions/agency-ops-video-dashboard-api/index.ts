import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS","cache-control":"no-store"};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
const ADLER_USER_ID="794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";
const TRIAGE_FALLBACK="1uddoWTdo-f6ahyPWMca5mSZ2rO3FuS9i";
const keys=["VIDEO_EDIT_ENABLED","VIDEO_ANALYSIS_ENABLED","VIDEO_EDIT_TRIAGE_FOLDER_ID"] as const;

function asBool(value:unknown){return value===true||String(value).toLowerCase()==="true";}
async function authorize(req:Request,url:string,anon:string){
  const header=req.headers.get("authorization")||"";
  if(!header.startsWith("Bearer ")) return null;
  const auth=createClient(url,anon,{global:{headers:{Authorization:header}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await auth.auth.getUser();
  return !error&&data.user?.id===ADLER_USER_ID?data.user:null;
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service) return json({error:"server_configuration"},500);
  if(!await authorize(req,url,anon)) return json({error:"not_found"},404);
  const ops=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}).schema("agency_ops");
  try{
    if(req.method==="POST"){
      const body=await req.json().catch(()=>({}));
      if(body?.action!=="set_edit_enabled"||typeof body?.enabled!=="boolean") return json({error:"invalid_action"},400);
      const {error}=await ops.from("automation_settings").upsert({key:"VIDEO_EDIT_ENABLED",value:body.enabled,description:"Kill switch do render automático de vídeo",updated_at:new Date().toISOString()},{onConflict:"key"});
      if(error) throw error;
      return json({ok:true,video_edit_enabled:body.enabled});
    }
    if(req.method!=="GET") return json({error:"method_not_allowed"},405);
    const [{data:settings,error:settingsError},{data:worker,error:workerError},{data:jobs,error:jobsError}]=await Promise.all([
      ops.from("automation_settings").select("key,value,updated_at").in("key",keys as unknown as string[]),
      ops.from("video_worker_heartbeats").select("worker_id,worker_version,state,current_job_id,last_seen_at,updated_at").eq("worker_id","leonardo-video-worker-v3").maybeSingle(),
      ops.from("video_edit_jobs").select("id,client_id,product_name,status,test_mode,progress_pct,current_stage,attempt_count,last_error,created_at,updated_at,finished_at,output_drive_folder_id").order("created_at",{ascending:false}).limit(60)
    ]);
    if(settingsError||workerError||jobsError) throw settingsError||workerError||jobsError;
    const ids=(jobs||[]).map((job:any)=>job.id);
    const {data:outputs,error:outputsError}=ids.length?await ops.from("video_edit_job_outputs").select("job_id,drive_url,qa_status,file_name,duration_seconds,width,height,fps,review_status,created_at").in("job_id",ids):{data:[],error:null};
    if(outputsError) throw outputsError;
    const values=Object.fromEntries((settings||[]).map((row:any)=>[row.key,row.value]));
    const triageId=String(values.VIDEO_EDIT_TRIAGE_FOLDER_ID||TRIAGE_FALLBACK).replace(/^"|"$/g,"");
    return json({ok:true,controls:{video_edit_enabled:asBool(values.VIDEO_EDIT_ENABLED),video_analysis_enabled:asBool(values.VIDEO_ANALYSIS_ENABLED),analysis_control:"GUARDED_BATCH_ONLY"},worker:worker||null,jobs:jobs||[],outputs:outputs||[],triage_url:`https://drive.google.com/drive/folders/${triageId}`,generated_at:new Date().toISOString()});
  }catch(error){return json({error:"video_dashboard_api_failed",detail:error instanceof Error?error.message:String(error)},500);}
});