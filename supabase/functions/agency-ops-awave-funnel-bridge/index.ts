import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row=Record<string,any>;
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clean=(v:unknown)=>String(v??"").trim();
const normPhone=(v:unknown)=>clean(v).replace(/\D/g,"");
const normEmail=(v:unknown)=>clean(v).toLowerCase();
const money=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:0};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);

  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const anon=Deno.env.get("SUPABASE_ANON_KEY")||"";
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const authHeader=req.headers.get("Authorization")||"";
  if(!supabaseUrl||!anon||!service||!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);

  const auth=createClient(supabaseUrl,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData,error:authError}=await auth.auth.getUser();
  if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);

  const db=createClient(supabaseUrl,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops"),crm=db.schema("crm");

  const [{data:pref},{data:approval}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)
  ]);
  const person=clean(pref?.collaborator_person||pref?.name);
  if(!person||!(approval||[]).length)return reply({error:"profile_locked"},403);
  const {data:roster}=await ops.from("team_roster").select("person,role,access_level,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||String(roster.role||"").toUpperCase()!=="CLOSER")return reply({error:"forbidden"},403);

  const {data:settings}=await ops.from("automation_settings").select("key,value").in("key",["AWAVE_DASH_OPS_FUNNEL_URL","AWAVE_DASH_OPS_FUNNEL_SECRET"]);
  const map=new Map((settings||[]).map((r:Row)=>[String(r.key),typeof r.value==="string"?r.value:String(r.value??"").replace(/^"|"$/g,"")]));
  const url=clean(map.get("AWAVE_DASH_OPS_FUNNEL_URL"));
  const secret=clean(map.get("AWAVE_DASH_OPS_FUNNEL_SECRET"));
  if(!url||!secret)return reply({error:"awave_bridge_not_configured"},500);

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const action=clean(body?.action);
    if(!["move_stage","update_value","mark_won","mark_lost"].includes(action))return reply({error:"action_not_allowed"},400);
    const upstream=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-dash-ops-secret":secret},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const raw=await upstream.text();
    let parsed:unknown;try{parsed=JSON.parse(raw)}catch{parsed={error:"awave_invalid_response",detail:raw.slice(0,300)}}
    return reply(parsed,upstream.status);
  }

  const upstream=await fetch(url,{headers:{"x-dash-ops-secret":secret},signal:AbortSignal.timeout(12000)});
  const raw=await upstream.text();
  let awave:Row;try{awave=JSON.parse(raw)}catch{return reply({error:"awave_invalid_response"},502)}
  if(!upstream.ok||!awave?.ok)return reply({error:"awave_unavailable",detail:awave},upstream.status>=400?upstream.status:502);

  const {data:crmRows}=await crm.from("leads").select("id,name,company,email,phone,stage,estimated_value,source,created_at,updated_at,closed_at").eq("owner_id",userData.user.id).is("archived_at",null).limit(3000);
  const leads:Row[]=crmRows||[];

  const phoneBuckets=new Map<string,Row[]>(),emailBuckets=new Map<string,Row[]>();
  for(const l of leads){
    const p=normPhone(l.phone),e=normEmail(l.email);
    if(p){const a=phoneBuckets.get(p)||[];a.push(l);phoneBuckets.set(p,a)}
    if(e){const a=emailBuckets.get(e)||[];a.push(l);emailBuckets.set(e,a)}
  }

  const deals=(awave.deals||[]).map((d:Row)=>{
    const p=normPhone(d.contato?.telefone||d.contato?.chave_externa||d.chave_externa);
    const e=normEmail(d.contato?.email);
    const phoneMatch=p&&(phoneBuckets.get(p)||[]).length===1?(phoneBuckets.get(p)||[])[0]:null;
    const emailMatch=e&&(emailBuckets.get(e)||[]).length===1?(emailBuckets.get(e)||[])[0]:null;
    const matched=phoneMatch&&emailMatch&&phoneMatch.id!==emailMatch.id?null:(phoneMatch||emailMatch||null);
    return {...d,crm_lead_id:matched?.id||null,crm_stage:matched?.stage||null,crm_updated_at:matched?.updated_at||null,sync_match:matched?"MATCHED":"AWAVE_ONLY"};
  });

  const pipelines=awave.pipelines||[],stages=awave.stages||[];
  const open=deals.filter((d:Row)=>String(d.status)==="aberto"),won=deals.filter((d:Row)=>String(d.status)==="ganho"),lost=deals.filter((d:Row)=>String(d.status)==="perdido");
  const primary=(pipelines.find((p:Row)=>p.is_padrao)||pipelines[0]||null) as Row|null;
  const primaryDeals=primary?deals.filter((d:Row)=>String(d.pipeline_id)===String(primary.id)):deals;
  return reply({
    ok:true,source:"AWAVE_LIVE",generated_at:awave.generated_at||new Date().toISOString(),
    closer:awave.closer,pipelines,stages,deals,
    primary_pipeline_id:primary?.id||null,
    summary:{total:deals.length,open:open.length,won:won.length,lost:lost.length,primary_total:primaryDeals.length,matched_crm:deals.filter((d:Row)=>d.crm_lead_id).length,awave_only:deals.filter((d:Row)=>!d.crm_lead_id).length,total_value:deals.reduce((s:number,d:Row)=>s+money(d.valor),0)}
  });
});
