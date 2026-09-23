import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { providerAdapter, providerErrorCode } from "./provider.ts";

const j=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const clean=(v:unknown,n=4000)=>String(v??"").trim().slice(0,n);
const fold=(v:unknown)=>clean(v,10000).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR").replace(/\s+/g," ").trim();
const uniq=<T>(xs:T[])=>[...new Set(xs)];
const safeHttp=(v:unknown)=>{try{const u=new URL(clean(v,3000));return ["http:","https:"].includes(u.protocol)?u.toString():""}catch{return ""}};
const epochDate=(v:unknown)=>{const raw=clean(v,200);if(!raw)return null;const n=Number(raw),d=Number.isFinite(n)&&n>0?new Date(n>1e12?n:n*1000):new Date(raw);return Number.isNaN(d.getTime())?null:d.toISOString()};
const jwtRole=(v:string)=>{try{const token=v.replace(/^Bearer\s+/i,"");const p=token.split(".")[1];if(!p)return "";const b64=p.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(p.length/4)*4,"=");return clean(JSON.parse(atob(b64))?.role,80)}catch{return ""}};

type DB=ReturnType<typeof createClient>;
async function setRun(ops:any,id:string,patch:any){await ops.from("ad_radar_runs").update({...patch,updated_at:new Date().toISOString()}).eq("id",id)}

function classify(ad:any,entity:any){
  const name=fold(entity?.canonical_name),city=fold(entity?.city),builder=fold(entity?.builder||entity?.developer);
  const aliases=(Array.isArray(entity?.aliases)?entity.aliases:[]).map((x:any)=>fold(x)).filter(Boolean);
  const hay=fold([ad?.name,ad?.description,ad?.headline,ad?.full_transcription,ad?.link_url].filter(Boolean).join(" | "));
  const evidence:any[]=[];
  const nameHit=Boolean(name&&hay.includes(name)),aliasHit=aliases.find((x:string)=>hay.includes(x));
  if(nameHit)evidence.push({type:"EXACT_NAME_IN_TEXT",value:entity.canonical_name});
  if(aliasHit)evidence.push({type:"ALIAS_IN_TEXT",value:aliasHit});
  if(city&&hay.includes(city))evidence.push({type:"CITY_IN_TEXT",value:entity.city});
  if(builder&&hay.includes(builder))evidence.push({type:"BUILDER_IN_TEXT",value:entity.builder||entity.developer});
  let officialDomain="";try{officialDomain=entity?.official_site_url?new URL(entity.official_site_url).hostname.replace(/^www\./,""):""}catch{}
  if(officialDomain&&clean(ad?.link_url).includes(officialDomain))evidence.push({type:"OFFICIAL_DOMAIN_DESTINATION",value:officialDomain});
  const identityHit=nameHit||Boolean(aliasHit),corroborated=evidence.some(x=>["CITY_IN_TEXT","BUILDER_IN_TEXT","OFFICIAL_DOMAIN_DESTINATION"].includes(x.type));
  const genericName=name.split(/\s+/).filter(Boolean).length<=1&&name.length<12;
  if(identityHit&&(!genericName||corroborated))return {category:"POSSIBLE",label:corroborated?"STRONG_EVIDENCE":"NAME_EVIDENCE",evidence};
  if(identityHit&&genericName&&!corroborated)return {category:"EXECUTION_REFERENCE",label:"AMBIGUOUS_NAME_ONLY",evidence:[...evidence,{type:"IDENTITY_NEEDS_CORROBORATION",value:true}]};
  if(city&&hay.includes(city))return {category:"REGIONAL_COMPETITOR",label:"REGIONAL_EVIDENCE",evidence};
  return {category:"EXECUTION_REFERENCE",label:"EXECUTION_ONLY",evidence:[{type:"QUERY_RETURNED",value:true}]};
}

async function ingestAd(ops:any,run:any,ctx:any,entity:any,providerName:string,raw:any){
  const now=new Date().toISOString(),brand=clean(raw?.brand_id,300)||"unknown";
  const {data:adv,error:advErr}=await ops.from("ad_radar_advertisers").upsert({
    provider:providerName,external_id:brand,name:clean(raw?.name,500)||null,metadata:{avatar:safeHttp(raw?.avatar)||null},
    last_seen_at:now
  },{onConflict:"provider,external_id"}).select("id").single();if(advErr)throw advErr;
  const external=clean(raw?.ad_id||raw?.id,400);if(!external)throw new Error("provider_ad_without_id");
  const {data:ad,error:adErr}=await ops.from("ad_radar_ads").upsert({
    provider:providerName,external_ad_id:external,advertiser_id:adv.id,
    source_url:safeHttp(raw?.source_url||raw?.foreplay_url)||null,provider_url:safeHttp(raw?.source_url||raw?.foreplay_url)||null,
    destination_url:safeHttp(raw?.link_url)||null,ad_name:clean(raw?.name,500)||null,
    primary_text:clean(raw?.description,5000)||null,headline:clean(raw?.headline,1000)||null,
    description:clean(raw?.description,5000)||null,cta:clean(raw?.cta_title||raw?.cta_type,300)||null,
    display_format:clean(raw?.display_format||raw?.type,100)||null,
    platforms:Array.isArray(raw?.publisher_platform)?raw.publisher_platform.map((x:any)=>clean(x,80)).filter(Boolean):[],
    live_state:typeof raw?.live==="boolean"?(raw.live?"LIVE":"NOT_LIVE"):"UNKNOWN",
    started_at:epochDate(raw?.started_running),last_seen_at:now,
    raw_metadata:{provider:providerName,provider_id:raw?.id||null,brand_id:raw?.brand_id||null,languages:raw?.languages||[],niches:raw?.niches||[],full_transcription:clean(raw?.full_transcription,12000)||null,timestamped_transcription:raw?.timestamped_transcription||[],video_duration:raw?.video_duration??null,provider_payload:raw?.provider_payload||null}
  },{onConflict:"provider,external_ad_id"}).select("*").single();if(adErr)throw adErr;

  const media:any[]=[];
  const push=(key:string,pos:number,type:string,url:unknown,duration?:unknown)=>{const v=safeHttp(url);if(v)media.push({ad_id:ad.id,media_key:key,position:pos,media_type:type,provider_url:v,availability:"REMOTE",duration_seconds:Number(duration)||null,last_verified_at:now})};
  push("main:image",0,"IMAGE",raw?.image);push("main:video",0,"VIDEO",raw?.video,raw?.video_duration);push("main:thumbnail",0,"THUMBNAIL",raw?.thumbnail);
  if(Array.isArray(raw?.cards))raw.cards.forEach((c:any,i:number)=>{push(`card:${i}:image`,i+1,"IMAGE",c?.image);push(`card:${i}:video`,i+1,"VIDEO",c?.video,c?.video_duration)});
  for(const m of media){const {error}=await ops.from("ad_radar_media").upsert(m,{onConflict:"ad_id,media_key"});if(error)throw error}

  const {data:override}=await ops.from("ad_radar_match_overrides").select("category,note,actor,updated_at").eq("context_id",ctx.id).eq("ad_id",ad.id).maybeSingle();
  const auto=classify(raw,entity),category=override?.category||auto.category;
  const match={run_id:run.id,context_id:ctx.id,ad_id:ad.id,category,evidence:auto.evidence,confidence_label:override?"HUMAN_OVERRIDE":auto.label,decision_source:override?"HUMAN":"AUTO",decided_by:override?.actor||null,decided_at:override?.updated_at||null};
  const {error:me}=await ops.from("ad_radar_matches").upsert(match,{onConflict:"run_id,ad_id"});if(me)throw me;
  await ops.from("ad_radar_observations").upsert({run_id:run.id,ad_id:ad.id,observed_at:now,provider_live_state:typeof raw?.live==="boolean"?(raw.live?"LIVE":"NOT_LIVE"):"UNKNOWN",present_in_collection:true,metadata:{}},{onConflict:"run_id,ad_id"});
  return {adId:ad.id,mediaCount:media.length};
}

async function processRun(ops:any,run:any,cfg:any,provider:any){
  const started=Date.now();
  const {data:ctx,error:ce}=await ops.from("ad_radar_product_contexts").select("*").eq("id",run.context_id).single();if(ce)throw ce;
  const {data:entity,error:ee}=await ops.from("ad_radar_product_entities").select("*").eq("id",ctx.product_entity_id).single();if(ee)throw ee;
  if(!cfg.external_collection_enabled){await setRun(ops,run.id,{status:"ACTION_REQUIRED",completed_at:new Date().toISOString(),error_code:"EXTERNAL_COLLECTION_DISABLED",error_detail:"Coleta externa está desligada pelo kill switch. Referências manuais continuam disponíveis.",elapsed_ms:Date.now()-started});return "ACTION_REQUIRED"}
  if(!provider.configured){await setRun(ops,run.id,{status:"ACTION_REQUIRED",completed_at:new Date().toISOString(),error_code:provider.missingCode,error_detail:provider.missingDetail,elapsed_ms:Date.now()-started});return "ACTION_REQUIRED"}
  if(run.provider!==provider.name)await setRun(ops,run.id,{provider:provider.name});

  const maker=clean(entity.builder||entity.developer,200);
  const parts=[clean(entity.canonical_name,300),...(Array.isArray(entity.aliases)?entity.aliases:[]).map((x:any)=>clean(x,300)),entity.city?`${clean(entity.canonical_name,300)} ${clean(entity.city,200)}`:"",maker?`${clean(entity.canonical_name,300)} ${maker}`:""].filter(Boolean);
  const queries=uniq(parts).slice(0,Number(cfg.max_queries_per_run||4));
  let total=0,media=0,credits=0,failed=0,blockedCode="",blockedDetail="";
  const brandIds=new Set<string>();

  for(const q of queries){
    const qStart=Date.now();
    const {data:qrow,error:qe}=await ops.from("ad_radar_queries").insert({run_id:run.id,provider:provider.name,query_kind:"KEYWORD",query_text:q,status:"SEARCHING"}).select("*").single();if(qe)throw qe;
    let page:any;
    try{page=await provider.search(q,Number(cfg.max_ads_per_query||25))}
    catch(e:any){failed++;const code=providerErrorCode(e,provider.name);await ops.from("ad_radar_queries").update({status:"FAILED",error_code:code,error_detail:clean(e?.message||e,300),elapsed_ms:Date.now()-qStart,completed_at:new Date().toISOString()}).eq("id",qrow.id);if([401,402,403].includes(Number(e?.status||0))){blockedCode=code;blockedDetail=clean(e?.message||e,300);break}continue}
    const cost=Number(page.creditCost||0)||0;credits+=cost;
    const rows=Array.isArray(page.rows)?page.rows:[];
    for(const raw of rows){if(raw?.brand_id)brandIds.add(clean(raw.brand_id,300));const ing=await ingestAd(ops,run,ctx,entity,provider.name,raw);total++;media+=ing.mediaCount}
    await ops.from("ad_radar_queries").update({status:"DONE",result_count:rows.length,credit_cost:cost,cursor_out:page.cursor||null,elapsed_ms:Date.now()-qStart,completed_at:new Date().toISOString()}).eq("id",qrow.id);
    if(Number.isFinite(page.creditsRemaining))await setRun(ops,run.id,{provider_credits_remaining:page.creditsRemaining});
  }

  if(!blockedCode&&brandIds.size&&total>0){
    const ids=[...brandIds].slice(0,5);
    const qStart=Date.now(),{data:qrow}=await ops.from("ad_radar_queries").insert({run_id:run.id,provider:provider.name,query_kind:"ADVERTISER_EXPANSION",query_text:ids.join(","),status:"SEARCHING"}).select("*").single();
    try{
      const page=await provider.expandAdvertisers(ids,Number(cfg.max_ads_per_query||25)),cost=Number(page.creditCost||0)||0;credits+=cost;
      const rows=Array.isArray(page.rows)?page.rows:[];for(const raw of rows){const ing=await ingestAd(ops,run,ctx,entity,provider.name,raw);total++;media+=ing.mediaCount}
      await ops.from("ad_radar_queries").update({status:"DONE",result_count:rows.length,credit_cost:cost,cursor_out:page.cursor||null,elapsed_ms:Date.now()-qStart,completed_at:new Date().toISOString()}).eq("id",qrow.id)
    }catch(e:any){failed++;await ops.from("ad_radar_queries").update({status:"FAILED",error_code:providerErrorCode(e,provider.name),error_detail:clean(e?.message||e,300),elapsed_ms:Date.now()-qStart,completed_at:new Date().toISOString()}).eq("id",qrow.id)}
  }

  const {count:distinctAds}=await ops.from("ad_radar_matches").select("ad_id",{count:"exact",head:true}).eq("run_id",run.id);
  const {count:mediaCount}=await ops.from("ad_radar_media").select("id",{count:"exact",head:true}).in("ad_id",(await ops.from("ad_radar_matches").select("ad_id").eq("run_id",run.id)).data?.map((x:any)=>x.ad_id)||[]);
  const doneAt=new Date().toISOString(),base={completed_at:doneAt,locked_at:null,query_count:queries.length+(brandIds.size?1:0),ads_found:Number(distinctAds||0),distinct_creatives:Number(distinctAds||0),media_available:Number(mediaCount||media),provider_credit_cost:credits,elapsed_ms:Date.now()-started};
  if(blockedCode){await setRun(ops,run.id,{...base,status:"ACTION_REQUIRED",is_partial:total>0,error_code:blockedCode,error_detail:blockedDetail});return "ACTION_REQUIRED"}
  if(failed>0&&total>0){await setRun(ops,run.id,{...base,status:"PARTIAL",is_partial:true,error_code:"PARTIAL_PROVIDER_FAILURE",error_detail:`${failed} consulta(s) falharam; resultados anteriores e parciais foram preservados.`});return "PARTIAL"}
  if(failed>0&&total===0){const retry=run.attempts<run.max_attempts;await setRun(ops,run.id,{...base,status:retry?"FAILED_RECOVERABLE":"ACTION_REQUIRED",available_at:retry?new Date(Date.now()+Math.min(60,5*Math.max(1,run.attempts))*60000).toISOString():run.available_at,error_code:"PROVIDER_TEMPORARY_FAILURE",error_detail:`${failed} consulta(s) falharam.`});return retry?"FAILED_RECOVERABLE":"ACTION_REQUIRED"}
  await setRun(ops,run.id,{...base,status:total>0?"AVAILABLE":"NO_RESULTS",is_partial:false,error_code:null,error_detail:null});return total>0?"AVAILABLE":"NO_RESULTS";
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return j({ok:false,error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!service)return j({ok:false,error:"server_configuration"},500);
  if(jwtRole(req.headers.get("authorization")||"")!=="service_role")return j({ok:false,error:"unauthorized"},401);
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=admin.schema("agency_ops");
  try{
    await ops.rpc("recover_stale_ad_radar_runs");
    const {data:cfg,error:ce}=await ops.from("ad_radar_runtime_config").select("*").eq("id",1).single();if(ce)throw ce;
    if(!cfg.enabled)return j({ok:true,disabled:true,processed:[]});
    let scheduledEnqueued=0;
    if(cfg.external_collection_enabled&&cfg.scheduled_refresh_enabled===true){const {data,error}=await ops.rpc("enqueue_due_ad_radar_refreshes",{p_limit:Number(cfg.max_runs_per_tick||2)});if(error)throw error;scheduledEnqueued=Number(data||0)}
    const {data:runs,error:re}=await ops.rpc("claim_ad_radar_runs",{p_limit:Number(cfg.max_runs_per_tick||2)});if(re)throw re;
    const provider=providerAdapter(cfg.provider),processed:any[]=[];
    for(const run of runs||[]){try{processed.push({id:run.id,status:await processRun(ops,run,cfg,provider)})}catch(e:any){console.error(e);await setRun(ops,run.id,{status:run.attempts>=run.max_attempts?"ACTION_REQUIRED":"FAILED_RECOVERABLE",available_at:new Date(Date.now()+Math.min(60,5*Math.max(1,run.attempts))*60000).toISOString(),locked_at:null,error_code:"WORKER_EXCEPTION",error_detail:clean(e?.message||e,300)});processed.push({id:run.id,status:"FAILED_RECOVERABLE"})}}
    return j({ok:true,scheduled_enqueued:scheduledEnqueued,processed});
  }catch(e:any){console.error(e);return j({ok:false,error:"internal_error",detail:clean(e?.message||e,300)},500)}
});
