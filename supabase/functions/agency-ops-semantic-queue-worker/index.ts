import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
function safeEqual(a:string,b:string){
  if(a.length!==b.length)return false;
  let d=0; for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
}

Deno.serve(async(req)=>{
  if(req.method==="GET")return reply({
    ok:true,service:"agency-ops-semantic-queue-worker",
    mode:"serialized_micro_transaction",max_passes:1,batch:1
  });
  if(req.method!=="POST")return reply({ok:false,error:"method_not_allowed"},405);

  const url=Deno.env.get("SUPABASE_URL")||"";
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!service)return reply({ok:false,error:"server_configuration"},500);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const {data:setting,error:se}=await ops.from("automation_settings")
    .select("value").eq("key","SEMANTIC_QUEUE_WORKER_SECRET").maybeSingle();
  if(se)return reply({ok:false,error:"secret_unavailable"},500);

  const expected=typeof setting?.value==="string"?setting.value:"";
  const supplied=req.headers.get("x-semantic-worker-key")||"";
  if(!expected||!supplied||!safeEqual(expected,supplied))
    return reply({ok:false,error:"unauthorized"},401);

  const {data,error}=await ops.rpc("process_operational_queue_serialized",{p_limit:1});
  if(error)return reply({ok:false,error:"queue_failed",detail:error.message},500);

  return reply({ok:true,processed:[Number(data||0)],transactions:1});
});
