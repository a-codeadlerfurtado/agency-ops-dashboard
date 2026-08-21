import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,x-dashboard-key,authorization,apikey","access-control-allow-methods":"GET,POST,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const errorStatus=(message:string)=>message.includes("forbidden")?403:message.includes("unauthorized")?401:message.includes("required")||message.includes("invalid")?400:500;

function aggregateTaskLog(rows:any[]){
  const by_category:Record<string,number>={};
  const by_collaborator:Record<string,{total:number;by_category:Record<string,number>}>={};
  for(const row of rows){
    by_category[row.category]=(by_category[row.category]??0)+1;
    const bucket=by_collaborator[row.collaborator_name]??{total:0,by_category:{}};
    bucket.total+=1; bucket.by_category[row.category]=(bucket.by_category[row.category]??0)+1; by_collaborator[row.collaborator_name]=bucket;
  }
  return {total:rows.length,by_category,by_collaborator,recent:rows.slice(0,100)};
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey=Deno.env.get("SUPABASE_ANON_KEY");
  if(!supabaseUrl||!serviceRole||!anonKey) return json({error:"server_configuration"},500);
  const url=new URL(req.url); const view=url.searchParams.get("view")??"home";
  const authHeader=req.headers.get("Authorization")??"";
  let actor:string|null=null;
  if(authHeader.startsWith("Bearer ")){
    const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data}=await auth.auth.getUser(); actor=data.user?.id??null;
  }
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");

  if(view==="diary" || view==="adjustment-create" || view==="adjustment-update" || view==="tasklog-create"){
    if(!actor) return json({error:"unauthorized"},401);
    try{
      if(req.method==="GET"&&view==="diary"){
        const scope=url.searchParams.get("scope")==="all"?"all":"mine";
        const filters:any={};
        for(const key of ["author_user_id","client_id","category_code","subcategory_code","responsible_area","status","since","until"]){const v=url.searchParams.get(key); if(v) filters[key]=v;}
        const {data,error}=await ops.rpc("diary_get",{p_actor:actor,p_scope:scope,p_filters:filters});
        if(error) return json({error:"diary_query_failed",detail:error.message},errorStatus(error.message));
        return json(data??{});
      }
      if(req.method!=="POST") return json({error:"method_not_allowed"},405);
      const body=await req.json().catch(()=>({}));
      if(view==="adjustment-create"){
        const {data,error}=await ops.rpc("diary_create_adjustment",{p_actor:actor,p_payload:body});
        if(error) return json({error:"adjustment_create_failed",detail:error.message},errorStatus(error.message));
        return json({ok:true,adjustment:data});
      }
      if(view==="adjustment-update"){
        const id=Number(body.id??0); if(!id) return json({error:"missing_fields",required:["id"]},400);
        const patch={...body}; delete patch.id;
        const {data,error}=await ops.rpc("diary_update_adjustment",{p_actor:actor,p_id:id,p_patch:patch});
        if(error) return json({error:"adjustment_update_failed",detail:error.message},errorStatus(error.message));
        return json({ok:true,adjustment:data});
      }
      const {data,error}=await ops.rpc("diary_create_tasklog",{p_actor:actor,p_payload:body});
      if(error) return json({error:"tasklog_create_failed",detail:error.message},errorStatus(error.message));
      return json({ok:true,entry:data});
    }catch(e){return json({error:"diary_gateway_error",detail:e instanceof Error?e.message:String(e)},500);}
  }

  const target=new URL(`${supabaseUrl}/functions/v1/agency-ops-dashboard-api`);
  for(const [k,v] of url.searchParams) target.searchParams.set(k,v);
  const headers=new Headers();
  for(const key of ["authorization","apikey","x-dashboard-key","content-type"]){const v=req.headers.get(key); if(v) headers.set(key,v);}
  const init:RequestInit={method:req.method,headers};
  if(!["GET","HEAD"].includes(req.method)) init.body=await req.text();
  const upstream=await fetch(target,init);
  if(view!=="home"||req.method!=="GET"||!upstream.ok||!actor){
    const h=new Headers(upstream.headers); Object.entries(CORS).forEach(([k,v])=>h.set(k,v)); h.set("cache-control","no-store");
    return new Response(upstream.body,{status:upstream.status,headers:h});
  }
  const body=await upstream.json();
  const {data:diary,error}=await ops.rpc("diary_get",{p_actor:actor,p_scope:"mine",p_filters:{}});
  if(!error&&diary){
    body.adjustments=diary.adjustments??[];
    body.operations=body.operations??{};
    body.operations.task_log=aggregateTaskLog(diary.task_log??[]);
    body.diary={counts:diary.counts??{adjustments:0,tasks:0},can_view_all:Boolean(diary.can_view_all)};
  }else{
    body.adjustments=[]; body.operations=body.operations??{}; body.operations.task_log=aggregateTaskLog([]);
  }
  return json(body,upstream.status);
});
