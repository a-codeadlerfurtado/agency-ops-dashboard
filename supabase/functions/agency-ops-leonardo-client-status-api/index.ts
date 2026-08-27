import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
type Row=Record<string,any>;
const ALLOWED=new Set(["inadimplente","juridico"]);

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
  const isLeonardo=person==="Leonardo Augusto"&&String(roster?.role||"").toUpperCase()==="COMMERCIAL"&&!roster?.is_former;
  if(!isLeonardo)return reply({error:"forbidden"},403);

  async function load(){
    const[{data:clients,error:clientsError},{data:events,error:eventsError}]=await Promise.all([
      ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida").order("display_name",{ascending:true}).limit(1500),
      ops.from("client_operational_status").select("id,client_id,status,note,active,created_at,created_by,resolved_at,resolved_by,since,expected_at").in("status",["inadimplente","juridico"]).order("created_at",{ascending:false}).limit(5000)
    ]);
    if(clientsError)throw clientsError;if(eventsError)throw eventsError;
    const byClient=new Map<string,Row[]>();for(const e of events||[]){const key=String(e.client_id);const arr=byClient.get(key)||[];arr.push(e);byClient.set(key,arr);}
    const items=(clients||[]).map((c:Row)=>{const history=byClient.get(String(c.id))||[];const active=history.filter((e:Row)=>e.active);const inad=active.find((e:Row)=>e.status==="inadimplente")||null;const jur=active.find((e:Row)=>e.status==="juridico")||null;return{client_id:c.id,display_name:c.display_name,lifecycle:c.lifecycle,service:c.service,entrada:c.entrada,saida:c.saida,inadimplente:Boolean(inad),juridico:Boolean(jur),inadimplente_record:inad,juridico_record:jur,history:history.slice(0,20)};});
    return items;
  }

  if(req.method==="GET"){
    try{return reply({profile:{person,role:roster.role,can_edit:true},items:await load(),generated_at:new Date().toISOString()});}
    catch(error){return reply({error:"query_failed",detail:error instanceof Error?error.message:String(error)},500);}
  }

  const body=await req.json().catch(()=>({}));if(String(body?.action||"")!=="save_client_financial_legal")return reply({error:"unknown_action"},400);
  const clientId=String(body?.client_id||"").trim(),note=String(body?.note||"").trim().slice(0,2000),sinceRaw=String(body?.since||"").trim();
  if(!clientId)return reply({error:"invalid_client"},400);
  const desired:Record<string,boolean>={inadimplente:Boolean(body?.inadimplente),juridico:Boolean(body?.juridico)};
  const since=sinceRaw&&/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)?sinceRaw:new Date().toISOString().slice(0,10);
  const{data:client}=await ops.from("clients").select("id,display_name").eq("id",clientId).maybeSingle();if(!client)return reply({error:"client_not_found"},404);
  const now=new Date().toISOString();
  try{
    for(const status of ALLOWED){
      const{data:current,error:currentError}=await ops.from("client_operational_status").select("id,status,note,since,active").eq("client_id",clientId).eq("status",status).eq("active",true).maybeSingle();
      if(currentError)throw currentError;
      const wants=desired[status];
      if(!wants&&current){const{error}=await ops.from("client_operational_status").update({active:false,resolved_at:now,resolved_by:person}).eq("id",current.id);if(error)throw error;continue;}
      if(!wants)continue;
      const same=current&&String(current.note||"")===note&&String(current.since||"")===since;if(same)continue;
      if(current){const{error}=await ops.from("client_operational_status").update({active:false,resolved_at:now,resolved_by:person}).eq("id",current.id);if(error)throw error;}
      const{error}=await ops.from("client_operational_status").insert({client_id:clientId,status,note:note||null,active:true,created_at:now,created_by:person,since});if(error)throw error;
    }
    const items=await load();return reply({ok:true,client:items.find((x:Row)=>String(x.client_id)===clientId)||null,updated_by:person,updated_at:now});
  }catch(error){return reply({error:"save_failed",detail:error instanceof Error?error.message:String(error)},500);}
});