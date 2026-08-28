import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization,apikey","access-control-allow-methods":"GET,POST,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),anonKey=Deno.env.get("SUPABASE_ANON_KEY"),serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceRole)return json({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);
  const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}}});
  const {data:authData,error:authError}=await auth.auth.getUser();
  if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",authData.user.id).maybeSingle();
  const person=String(pref?.collaborator_person||"").trim();
  const {data:roster}=await ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle();
  const role=String(roster?.role||"").toUpperCase();
  if(!person||!roster||!["MGMT","GT"].includes(role))return json({error:"not_found"},404);
  const profile={person,role,scope:role==="GT"?"WALLET":"ALL"};
  const url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("probe")==="1")return json({ok:true,profile});

  try{
    if(req.method==="POST"){
      if(role!=="MGMT")return json({error:"forbidden"},403);
      const body=await req.json().catch(()=>({}));
      let runId=String(body?.meta_run_id||"").trim();
      if(!runId){
        const {data:runs,error}=await ops.from("meta_performance_runs").select("id,snapshot_date,window_end,status").in("status",["COMPLETED","COMPLETED_WITH_ERRORS"]).order("snapshot_date",{ascending:false}).limit(1);
        if(error)throw error;
        runId=String(runs?.[0]?.id||"");
      }
      if(!runId)return json({error:"no_completed_meta_run"},404);
      const {data,error}=await ops.rpc("invoke_weekly_client_reports",{p_meta_run_id:runId});
      if(error)throw error;
      return json({ok:true,meta_run_id:runId,request_id:data});
    }

    const requestedGt=String(url.searchParams.get("gt")||"").trim();
    const selectedGt=role==="GT"?person:requestedGt;
    const {data:weeks,error:weekError}=await ops.from("weekly_client_reports").select("week_end,week_start,meta_run_id").order("week_end",{ascending:false}).limit(1);
    if(weekError)throw weekError;
    const weekEnd=String(url.searchParams.get("week_end")||weeks?.[0]?.week_end||"");
    if(!weekEnd)return json({profile,week:null,reports:[],summary:{ready:0,review:0,pending:0,error:0,total:0},gt_options:role==="MGMT"?[]:[person]});
    let q=ops.from("weekly_client_reports").select("id,client_id,client_name,gt_owner,week_start,week_end,public_token,status,attempts,last_error,generated_at,snapshot").eq("week_end",weekEnd).order("client_name",{ascending:true});
    if(selectedGt)q=q.eq("gt_owner",selectedGt);
    const {data:reports,error}=await q.limit(500);if(error)throw error;
    let gtOptions:string[]=[];
    if(role==="MGMT"){
      const {data:all}=await ops.from("weekly_client_reports").select("gt_owner").eq("week_end",weekEnd).not("gt_owner","is",null).limit(1000);
      gtOptions=[...new Set((all||[]).map((r:Row)=>String(r.gt_owner||"")).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
    }else gtOptions=[person];
    const rows=(reports||[]).map((r:Row)=>({
      id:r.id,client_id:r.client_id,client_name:r.client_name,gt_owner:r.gt_owner,week_start:r.week_start,week_end:r.week_end,status:r.status,attempts:r.attempts,last_error:r.last_error,generated_at:r.generated_at,
      public_path:r.status==="READY"?`/relatorio-semanal/${r.public_token}`:null,
      metrics:r.snapshot?.current||null,narrative:r.snapshot?.narrative||null,creative_count:Array.isArray(r.snapshot?.creatives)?r.snapshot.creatives.length:0,
    }));
    const summary={ready:rows.filter((r:Row)=>r.status==="READY").length,review:rows.filter((r:Row)=>r.status==="REVIEW_REQUIRED").length,pending:rows.filter((r:Row)=>["PENDING","RUNNING"].includes(r.status)).length,error:rows.filter((r:Row)=>r.status==="ERROR").length,total:rows.length};
    return json({profile,selected_gt:selectedGt,gt_options:gtOptions,week:{week_start:weeks?.[0]?.week_start||rows[0]?.week_start||null,week_end:weekEnd,meta_run_id:weeks?.[0]?.meta_run_id||null},summary,reports:rows,generated_at:new Date().toISOString()});
  }catch(error){return json({error:"weekly_reports_api_failed",detail:String(error instanceof Error?error.message:error)},500);}
});
