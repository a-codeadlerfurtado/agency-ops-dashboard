import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const j=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const clean=(v:unknown,n=4000)=>String(v??"").trim().slice(0,n);
const fold=(v:unknown)=>clean(v,12000).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR").replace(/\s+/g," ").trim();
const safeHttp=(v:unknown)=>{try{const u=new URL(clean(v,4000));return ["http:","https:"].includes(u.protocol)?u.toString():""}catch{return ""}};
const dateIso=(v:unknown)=>{const s=clean(v,100);if(!s)return null;const d=new Date(s.length===10?s+"T00:00:00Z":s);return Number.isNaN(d.getTime())?null:d.toISOString()};
const uniq=<T>(xs:T[])=>[...new Set(xs)];

function classify(ad:any,entity:any){
  const name=fold(entity?.canonical_name),city=fold(entity?.city),builder=fold(entity?.builder||entity?.developer);
  const hay=fold([ad?.ad_title,ad?.ad_body,ad?.link_description,ad?.page_name,ad?.link_url].filter(Boolean).join(" | "));
  const evidence:any[]=[];
  if(name&&hay.includes(name))evidence.push({type:"EXACT_NAME_IN_TEXT",value:entity.canonical_name});
  if(city&&hay.includes(city))evidence.push({type:"CITY_IN_TEXT",value:entity.city});
  if(builder&&hay.includes(builder))evidence.push({type:"BUILDER_IN_TEXT",value:entity.builder||entity.developer});
  let officialDomain="";try{officialDomain=entity?.official_site_url?new URL(entity.official_site_url).hostname.replace(/^www\./,""):""}catch{}
  if(officialDomain&&clean(ad?.link_url).includes(officialDomain))evidence.push({type:"OFFICIAL_DOMAIN_DESTINATION",value:officialDomain});
  if(evidence.some(x=>x.type==="EXACT_NAME_IN_TEXT"))return {category:"POSSIBLE",label:evidence.length>=2?"STRONG_EVIDENCE":"NAME_EVIDENCE",evidence};
  if(city&&hay.includes(city))return {category:"REGIONAL_COMPETITOR",label:"REGIONAL_EVIDENCE",evidence};
  return {category:"EXECUTION_REFERENCE",label:"EXECUTION_ONLY",evidence:[{type:"QUERY_RETURNED",value:true}]};
}
async function setRun(ops:any,id:string,patch:any){await ops.from("ad_radar_runs").update({...patch,updated_at:new Date().toISOString()}).eq("id",id)}

async function ingest(ops:any,run:any,ctx:any,entity:any,raw:any){
  const provider="LOCAL_META_LIBRARY",now=new Date().toISOString();
  const pageId=clean(raw?.page_id,300)||("page:"+clean(raw?.page_name,250))||"unknown";
  const {data:adv,error:ae}=await ops.from("ad_radar_advertisers").upsert({
    provider,external_id:pageId,name:clean(raw?.page_name,500)||null,page_url:safeHttp(raw?.page_profile_uri)||null,
    metadata:{page_like_count:raw?.page_like_count??null,page_categories:raw?.page_categories||[],avatar:safeHttp(raw?.page_profile_picture_url)||null},last_seen_at:now
  },{onConflict:"provider,external_id"}).select("id").single();if(ae)throw ae;
  const external=clean(raw?.ad_archive_id,400);if(!external)throw new Error("local_ad_without_id");
  const source="https://www.facebook.com/ads/library/?id="+encodeURIComponent(external);
  const {data:ad,error:de}=await ops.from("ad_radar_ads").upsert({
    provider,external_ad_id:external,advertiser_id:adv.id,source_url:source,provider_url:source,
    destination_url:safeHttp(raw?.link_url)||null,ad_name:clean(raw?.ad_title||raw?.page_name,500)||null,
    primary_text:clean(raw?.ad_body,5000)||null,headline:clean(raw?.ad_title,1000)||null,
    description:clean(raw?.link_description||raw?.ad_body,5000)||null,cta:clean(raw?.cta_text||raw?.cta_type,300)||null,
    display_format:clean(raw?.display_format,100)||null,
    platforms:Array.isArray(raw?.publisher_platform)?raw.publisher_platform.map((x:any)=>clean(x,80)).filter(Boolean):[],
    live_state:raw?.is_active===true?"LIVE":raw?.is_active===false?"NOT_LIVE":"UNKNOWN",
    started_at:dateIso(raw?.start_date),last_seen_at:now,
    raw_metadata:{source:"META_PUBLIC_LIBRARY_BROWSER",page_id:raw?.page_id||null,page_name:raw?.page_name||null,force_score:raw?.force_score??null,force_tier:raw?.force_tier??null,days_running:raw?.days_running??null,collation_count:raw?.collation_count??null}
  },{onConflict:"provider,external_ad_id"}).select("*").single();if(de)throw de;

  const media:any[]=[];
  const push=(key:string,pos:number,type:string,url:unknown)=>{const v=safeHttp(url);if(v)media.push({ad_id:ad.id,media_key:key,position:pos,media_type:type,provider_url:v,availability:"REMOTE",last_verified_at:now})};
  (Array.isArray(raw?.images)?raw.images:[]).forEach((x:any,i:number)=>push("image:"+i,i,"IMAGE",x?.original_url||x?.resized_url||x));
  (Array.isArray(raw?.videos)?raw.videos:[]).forEach((x:any,i:number)=>{push("video:"+i,i,"VIDEO",x?.video_hd_url||x?.video_sd_url||x);push("video:"+i+":thumb",i,"THUMBNAIL",x?.video_preview_image_url)});
  for(const m of media){const {error}=await ops.from("ad_radar_media").upsert(m,{onConflict:"ad_id,media_key"});if(error)throw error}
  const {data:override}=await ops.from("ad_radar_match_overrides").select("category,actor,updated_at").eq("context_id",ctx.id).eq("ad_id",ad.id).maybeSingle();
  const auto=classify(raw,entity),category=override?.category||auto.category;
  const {error:me}=await ops.from("ad_radar_matches").upsert({run_id:run.id,context_id:ctx.id,ad_id:ad.id,category,evidence:auto.evidence,confidence_label:override?"HUMAN_OVERRIDE":auto.label,decision_source:override?"HUMAN":"AUTO",decided_by:override?.actor||null,decided_at:override?.updated_at||null},{onConflict:"run_id,ad_id"});if(me)throw me;
  await ops.from("ad_radar_observations").upsert({run_id:run.id,ad_id:ad.id,observed_at:now,provider_live_state:raw?.is_active===false?"NOT_LIVE":"LIVE",present_in_collection:true,metadata:{source:"browser_public_library"}},{onConflict:"run_id,ad_id"});
  return media.length;
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return j({ok:false,error:"method_not_allowed"},405);
  const expected=Deno.env.get("RADAR_COLLECTOR_TOKEN")||"",provided=req.headers.get("x-radar-collector-token")||"";
  if(!expected||provided!==expected)return j({ok:false,error:"unauthorized"},401);
  const url=Deno.env.get("SUPABASE_URL")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!service)return j({ok:false,error:"server_configuration"},500);
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=admin.schema("agency_ops");
  const body=await req.json().catch(()=>({})),action=clean(body?.action,40).toLowerCase();
  try{
    const {data:cfg,error:ce}=await ops.from("ad_radar_runtime_config").select("*").eq("id",1).single();if(ce)throw ce;
    if(action==="health")return j({ok:true,provider:cfg.provider,enabled:cfg.external_collection_enabled===true});
    if(String(cfg.provider||"").toUpperCase()!=="LOCAL_META_LIBRARY"||cfg.external_collection_enabled!==true)return j({ok:true,disabled:true});
    if(action==="claim"){
      await ops.rpc("recover_stale_ad_radar_runs");
      const {data:runs,error}=await ops.rpc("claim_ad_radar_runs",{p_limit:1});if(error)throw error;
      const run=(runs||[])[0];if(!run)return j({ok:true,job:null});
      const {data:ctx,error:xe}=await ops.from("ad_radar_product_contexts").select("*").eq("id",run.context_id).single();if(xe)throw xe;
      const {data:entity,error:ee}=await ops.from("ad_radar_product_entities").select("*").eq("id",ctx.product_entity_id).single();if(ee)throw ee;
      return j({ok:true,job:{run_id:run.id,context_id:ctx.id,briefing_product_id:ctx.briefing_product_id,entity,max_queries:Number(cfg.max_queries_per_run||4),max_ads_per_query:Number(cfg.max_ads_per_query||25)}});
    }
    const runId=clean(body?.run_id,80);if(!runId)return j({ok:false,error:"run_required"},400);
    const {data:run,error:re}=await ops.from("ad_radar_runs").select("*").eq("id",runId).single();if(re)throw re;
    if(action==="fail"){
      const terminal=Number(run.attempts||0)>=Number(run.max_attempts||4);
      await setRun(ops,runId,{status:terminal?"ACTION_REQUIRED":"FAILED_RECOVERABLE",available_at:terminal?run.available_at:new Date(Date.now()+Math.min(60,5*Math.max(1,Number(run.attempts||1)))*60000).toISOString(),locked_at:null,error_code:clean(body?.error_code,100)||"LOCAL_COLLECTOR_FAILURE",error_detail:clean(body?.error_detail,500)||"Falha no coletor local.",elapsed_ms:Number(body?.elapsed_ms||0)||null});
      return j({ok:true});
    }
    if(action==="complete"){
      const ads=Array.isArray(body?.ads)?body.ads.slice(0,500):[],started=Date.now();
      const {data:ctx,error:xe}=await ops.from("ad_radar_product_contexts").select("*").eq("id",run.context_id).single();if(xe)throw xe;
      const {data:entity,error:ee}=await ops.from("ad_radar_product_entities").select("*").eq("id",ctx.product_entity_id).single();if(ee)throw ee;
      let media=0;for(const ad of ads)media+=await ingest(ops,run,ctx,entity,ad);
      const {count:distinct}=await ops.from("ad_radar_matches").select("ad_id",{count:"exact",head:true}).eq("run_id",runId);
      const elapsed=Number(body?.elapsed_ms||0)||Date.now()-started,status=Number(distinct||0)>0?"AVAILABLE":"NO_RESULTS";
      await setRun(ops,runId,{provider:"LOCAL_META_LIBRARY",status,completed_at:new Date().toISOString(),locked_at:null,is_partial:false,query_count:Number(body?.query_count||0),ads_found:Number(distinct||0),distinct_creatives:Number(distinct||0),media_available:media,provider_credit_cost:0,elapsed_ms:elapsed,error_code:null,error_detail:null});
      await ops.from("ad_radar_pilot_cases").update({state:"AUTOMATIC_COLLECTED",automatic_sample_count:Number(distinct||0),media_available:media,elapsed_ms:elapsed,observed_cost:0,updated_at:new Date().toISOString()}).eq("briefing_product_id",ctx.briefing_product_id);
      return j({ok:true,status,ads_found:Number(distinct||0),media_available:media});
    }
    return j({ok:false,error:"unknown_action"},400);
  }catch(e:any){console.error(e);return j({ok:false,error:"internal_error",detail:clean(e?.message||e,300)},500)}
});