import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const clean=(v:unknown,n=500)=>String(v??"").trim().slice(0,n);
const allowedOrigin=(origin:string|null)=>!origin || /^https:\/\/(?:[a-z0-9]+-)?agency-ops-dashboard\.lakassessoriadigital\.workers\.dev$/i.test(origin) || ["http://localhost:3000","http://localhost:5173"].includes(origin);

Deno.serve(async(req:Request)=>{
  const origin=req.headers.get("origin");
  const cors={
    ...(origin&&allowedOrigin(origin)?{"access-control-allow-origin":origin,"vary":"Origin"}:{}),
    "access-control-allow-headers":"authorization,apikey,content-type",
    "access-control-allow-methods":"GET,POST,OPTIONS",
    "access-control-max-age":"86400"
  };
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
  if(req.method==="OPTIONS") return new Response(null,{status:allowedOrigin(origin)?204:403,headers:cors});
  if(!allowedOrigin(origin)) return json({ok:false,error:"origin_not_allowed"},403);
  if(!["GET","POST"].includes(req.method)) return json({ok:false,error:"method_not_allowed"},405);

  const url=Deno.env.get("SUPABASE_URL")||"", anon=Deno.env.get("SUPABASE_ANON_KEY")||"", service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service) return json({ok:false,error:"server_configuration"},500);
  const authz=req.headers.get("authorization")||"";
  if(!authz.toLowerCase().startsWith("bearer ")) return json({ok:false,error:"unauthorized"},401);
  const userDb=createClient(url,anon,{global:{headers:{Authorization:authz}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await userDb.auth.getUser();
  if(userError||!userData?.user) return json({ok:false,error:"unauthorized"},401);

  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}), ops=admin.schema("agency_ops");
  const userKey=userData.user.id;
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",userKey).maybeSingle();
  const person=clean(pref?.collaborator_person,160);
  if(!person) return json({ok:false,error:"collaborator_required"},403);
  const {data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).eq("is_former",false).maybeSingle();
  const role=clean(roster?.role,40).toUpperCase();
  const isAdler=person==="Adler Furtado";
  if(!isAdler&&role!=="CS") return json({ok:false,error:"forbidden"},403);

  const list=async()=>{
    const {data,error}=await ops.from("work_items")
      .select("id,client_id,type,status,priority,title,description,source,source_id,target_role,target_person,snoozed_until,started_at,completed_at,completed_by,resolution,metadata,created_at,updated_at,clients(display_name,cs_owner,gt_owner,designer_owner)")
      .eq("type","MATERIAL_TRIAGE").in("status",["OPEN","IN_PROGRESS","SNOOZED"])
      .order("created_at",{ascending:false}).limit(120);
    if(error) throw error;
    const rank:Record<string,number>={CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3};
    return (data||[]).map((item:any)=>({
      ...item,
      client_display_name:item.clients?.display_name||null,
      cs_owner:item.clients?.cs_owner||null,
      gt_owner:item.clients?.gt_owner||null,
      clients:undefined
    })).sort((a:any,b:any)=>(rank[String(a.priority)]??9)-(rank[String(b.priority)]??9)||new Date(a.metadata?.received_at||a.created_at||0).getTime()-new Date(b.metadata?.received_at||b.created_at||0).getTime());
  };

  try{
    if(req.method==="GET") return json({ok:true,items:await list(),person,role,generated_at:new Date().toISOString()});
    const body=await req.json().catch(()=>({}));
    const id=clean(body.id,80), action=clean(body.action,30).toUpperCase();
    if(!id||!["CLAIM","OPENED","SNOOZE","COMPLETE","RELEASE"].includes(action)) return json({ok:false,error:"invalid_action"},400);
    const {data:current,error:ce}=await ops.from("work_items").select("*").eq("id",id).eq("type","MATERIAL_TRIAGE").maybeSingle();
    if(ce) throw ce; if(!current) return json({ok:false,error:"not_found"},404);
    const owner=clean(current.target_person,160), canControl=isAdler||!owner||owner===person;
    if(!canControl) return json({ok:false,error:"already_claimed",claimed_by:owner},409);

    const now=new Date().toISOString();
    const meta={...(current.metadata||{})} as Record<string,unknown>;
    if(!meta.first_action_at) meta.first_action_at=now;
    if(!meta.first_action_by) meta.first_action_by=person;
    let patch:Record<string,unknown>={metadata:meta,updated_at:now};
    let eventType=action;

    if(action==="OPENED"){
      meta.opened_by=person; meta.opened_at=now;
    }else if(action==="CLAIM"){
      if(current.status==="IN_PROGRESS"&&owner===person) return json({ok:true,item:current,idempotent:true});
      meta.claimed_by=person; meta.claimed_at=now;
      patch={...patch,status:"IN_PROGRESS",target_person:person,target_role:"CS",started_at:current.started_at||now,snoozed_until:null};
    }else if(action==="SNOOZE"){
      const minutes=Math.min(120,Math.max(5,Number(body.minutes)||15));
      meta.snoozed_by=person; meta.snoozed_at=now; meta.snooze_minutes=minutes;
      patch={...patch,status:"SNOOZED",target_person:owner||null,snoozed_until:new Date(Date.now()+minutes*60000).toISOString()};
    }else if(action==="COMPLETE"){
      if(!isAdler&&owner!==person) return json({ok:false,error:"claim_required"},409);
      const resolution=clean(body.resolution||"Triagem concluída e material encaminhado.",4000);
      meta.completed_by=person; meta.completed_at=now;
      patch={...patch,status:"COMPLETED",completed_at:now,completed_by:person,resolution,snoozed_until:null};
    }else if(action==="RELEASE"){
      if(!isAdler&&owner!==person) return json({ok:false,error:"claim_required"},409);
      meta.released_by=person; meta.released_at=now;
      patch={...patch,status:"OPEN",target_person:null,started_at:null,snoozed_until:null};
    }

    let updated=current;
    if(action==="OPENED"){
      const {data,error}=await ops.from("work_items").update(patch).eq("id",id).select().single(); if(error) throw error; updated=data;
    }else{
      let q=ops.from("work_items").update(patch).eq("id",id).eq("status",current.status);
      if(owner) q=q.eq("target_person",owner); else q=q.is("target_person",null);
      const {data,error}=await q.select().maybeSingle(); if(error) throw error;
      if(!data){
        const {data:fresh}=await ops.from("work_items").select("target_person,status").eq("id",id).maybeSingle();
        return json({ok:false,error:"state_changed",claimed_by:fresh?.target_person||null,status:fresh?.status||null},409);
      }
      updated=data;
    }

    await ops.from("work_item_events").insert({
      work_item_id:id,event_type:eventType,actor_user_key:userKey,actor_person:person,
      previous_status:current.status,new_status:updated.status,
      detail:action==="SNOOZE"?`Adiado por ${Number(body.minutes)||15} min`:action==="OPENED"?"Material aberto para revisão":null,
      metadata:{action,triage_kind:meta.triage_kind||null}
    });
    return json({ok:true,item:updated,items:await list()});
  }catch(e:any){console.error("material_triage_api",e); return json({ok:false,error:"internal_error",detail:clean(e?.message||e,260)},500);}
});
