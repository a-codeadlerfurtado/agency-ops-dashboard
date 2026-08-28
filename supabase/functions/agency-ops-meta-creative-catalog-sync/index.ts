import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Action = { action_type?: string; value?: string };

const GRAPH_VERSION = "v25.0";
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;
const BUCKET = "agency-meta-creative-previews";
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const PREVIEW_CONCURRENCY = 4;
const META_BATCH_CONCURRENCY = 2;
const MAX_PREVIEWS_PER_SYNC = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const div = (a: number, b: number) => b > 0 ? a / b : null;
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const shift = (day: string, delta: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); };
const norm = (v: unknown) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function settingText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const obj = value as Row;
    if (typeof obj.value === "string") return obj.value;
  }
  return String(value);
}
function actionValue(actions: Action[] | undefined, exact: string) {
  const row = (actions || []).find((a) => String(a.action_type || "").toLowerCase() === exact.toLowerCase());
  return row ? num(row.value) : 0;
}
function actionContains(actions: Action[] | undefined, needle: string) {
  let best = 0;
  for (const row of actions || []) if (String(row.action_type || "").toLowerCase().includes(needle.toLowerCase())) best = Math.max(best, num(row.value));
  return best;
}
function canonical(adName: string | null, actions: Action[] | undefined) {
  const lead = actionValue(actions,"lead") || actionValue(actions,"onsite_conversion.lead_grouped") || actionValue(actions,"offsite_complete_registration_add_meta_leads");
  const message = actionContains(actions,"messaging_conversation_started") || actionContains(actions,"total_messaging_connection");
  const useMessage = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test(String(adName || "").toLowerCase()) || (!lead && Boolean(message));
  return { leads:lead, results:useMessage?message:lead, result_type:(useMessage&&message)?"MENSAGEM":lead?"LEAD":null };
}
function creativeFormat(creative: Row, adName: unknown) {
  const objectType = String(creative?.object_type || "").toUpperCase();
  const spec = creative?.object_story_spec || {};
  const feed = creative?.asset_feed_spec || {};
  const n = norm(`${creative?.name || ""} ${adName || ""}`);
  if (objectType === "VIDEO" || spec?.video_data || (Array.isArray(feed?.videos) && feed.videos.length) || /\b(video|reels?)\b/.test(n)) return "VÍDEO";
  const children = spec?.link_data?.child_attachments;
  if ((Array.isArray(children) && children.length > 1) || /carrossel|carousel/.test(n)) return "CARROSSEL";
  return "ESTÁTICO";
}
function previewExt(contentType: string) {
  const t = contentType.toLowerCase().split(";")[0].trim();
  if (t === "image/png") return "png";
  if (t === "image/webp") return "webp";
  if (t === "image/gif") return "gif";
  return "jpg";
}
async function graph(url: string, retries = 3): Promise<any> {
  let last = "Meta API error";
  for (let i=0;i<retries;i++) {
    const r = await fetch(url);
    const b = await r.json().catch(()=>null);
    if (r.ok && b && !b.error) return b;
    last = String(b?.error?.message || `HTTP ${r.status}`).slice(0,700);
    if (![429,500,502,503,504].includes(r.status) || i===retries-1) break;
    await new Promise((resolve)=>setTimeout(resolve,400*Math.pow(2,i)));
  }
  throw new Error(last);
}
async function paged(url: string, max = 5000) {
  const rows:Row[]=[]; let next:string|null=url;
  while(next && rows.length<max) { const b=await graph(next); rows.push(...(b.data||[])); next=b.paging?.next||null; }
  return rows.slice(0,max);
}
async function batchGet(paths:string[], token:string) {
  const out=new Map<string,Row>();
  const chunks:string[][]=[];
  for(let offset=0;offset<paths.length;offset+=50) chunks.push(paths.slice(offset,offset+50));
  let cursor=0;
  const runners=Array.from({length:Math.min(META_BATCH_CONCURRENCY,Math.max(1,chunks.length))},async()=>{
    while(true){
      const index=cursor++;
      if(index>=chunks.length)return;
      const chunk=chunks[index];
      const body=new URLSearchParams({access_token:token,batch:JSON.stringify(chunk.map(relative_url=>({method:"GET",relative_url})))});
      const r=await fetch(GRAPH_ROOT,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
      const b=await r.json().catch(()=>null);
      if(!r.ok||!Array.isArray(b)) throw new Error(String(b?.error?.message||`Meta batch HTTP ${r.status}`));
      b.forEach((item:any,itemIndex:number)=>{if(Number(item?.code)<200||Number(item?.code)>=300)return;try{const parsed=JSON.parse(String(item.body||"{}"));if(parsed&&!parsed.error)out.set(chunk[itemIndex],parsed);}catch{}});
    }
  });
  await Promise.all(runners);
  return out;
}
async function insights(accountId:string,token:string) {
  const to=shift(localDate(),-1), from=shift(to,-6);
  const fields=["ad_id","ad_name","spend","impressions","clicks","reach","frequency","actions"].join(",");
  const range=encodeURIComponent(JSON.stringify({since:from,until:to}));
  const rows=await paged(`${GRAPH_ROOT}/act_${accountId}/insights?level=ad&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`,5000);
  const map=new Map<string,Row>();
  for(const r of rows){const m=canonical(r.ad_name||null,r.actions);const spend=num(r.spend),imp=num(r.impressions),clicks=num(r.clicks),reach=num(r.reach);map.set(String(r.ad_id),{spend_7d:spend,impressions_7d:Math.round(imp),clicks_7d:Math.round(clicks),ctr_7d:imp>0?clicks/imp*100:null,frequency_7d:num(r.frequency)||div(imp,reach),leads_7d:m.leads,results_7d:m.results,cost_per_result_7d:div(spend,m.results),result_type:m.result_type});}
  return map;
}
async function mirrorPreview(db:any,clientId:string,adId:string,sources:string[]) {
  for(const source of [...new Set(sources.map(String).map(s=>s.trim()).filter(Boolean))]) {
    try { const r=await fetch(source,{redirect:"follow"}); if(!r.ok)continue; const type=String(r.headers.get("content-type")||"").toLowerCase().split(";")[0].trim(); if(!type.startsWith("image/"))continue; const declared=Number(r.headers.get("content-length")||0); if(declared>MAX_PREVIEW_BYTES)continue; const buf=await r.arrayBuffer(); if(!buf.byteLength||buf.byteLength>MAX_PREVIEW_BYTES)continue; const path=`catalog/${clientId}/${adId}.${previewExt(type)}`; const {error}=await db.storage.from(BUCKET).upload(path,new Uint8Array(buf),{contentType:type,cacheControl:"31536000",upsert:true}); if(!error)return path; } catch {}
  }
  return null;
}
async function mapConcurrent<T,R>(values:T[],worker:(value:T,index:number)=>Promise<R>,concurrency=PREVIEW_CONCURRENCY){const out=new Array<R>(values.length);let cursor=0;const runners=Array.from({length:Math.min(concurrency,Math.max(1,values.length))},async()=>{while(true){const i=cursor++;if(i>=values.length)return;out[i]=await worker(values[i],i);}});await Promise.all(runners);return out;}
async function existingPreviews(ops:any,clientId:string) {
  const map=new Map<string,string>();
  for(let from=0;from<5000;from+=1000){
    const {data,error}=await ops.from("meta_creative_catalog").select("meta_ad_account_id,ad_id,preview_storage_path").eq("client_id",clientId).not("preview_storage_path","is",null).range(from,from+999);
    if(error)throw error;
    const rows=data||[];
    for(const row of rows){const path=String(row.preview_storage_path||"");if(path)map.set(`${row.meta_ad_account_id}:${row.ad_id}`,path);}
    if(rows.length<1000)break;
  }
  return map;
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),token=Deno.env.get("META_SYSTEM_USER_TOKEN");
  if(!url||!service||!token)return json({ok:false,error:"server_configuration"},500);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}); const ops=db.schema("agency_ops");
  const {data:secretRow}=await ops.from("automation_settings").select("value").eq("key","META_CAMPAIGN_SYNC_SECRET").maybeSingle();
  const expected=settingText(secretRow?.value).trim();
  if(!expected||req.headers.get("x-meta-campaign-secret")!==expected)return json({ok:false,error:"unauthorized"},401);
  const body=await req.json().catch(()=>({}));
  const clientId=String(body?.client_id||"").trim();
  const mode=String(body?.mode||"full").trim().toLowerCase();
  if(!clientId)return json({ok:false,error:"client_id_required"},400);

  let stage="client";
  try {
    const {data:client,error:clientError}=await ops.from("clients").select("id,display_name,lifecycle").eq("id",clientId).maybeSingle();
    if(clientError)throw clientError;
    if(!client)throw new Error("client_not_found");

    stage="integrations";
    const {data:integrations,error:intError}=await ops.from("client_integrations").select("meta_ad_account_id").eq("client_id",clientId).eq("system","META_BM").not("meta_ad_account_id","is",null);
    if(intError)throw intError;
    const accounts:string[]=[...new Set<string>((integrations||[]).map((x:Row)=>String(x.meta_ad_account_id||"").trim()).filter(Boolean))];

    if(mode==="dates_only"){
      let seen=0,updated=0;
      for(const accountId of accounts){
        stage=`dates:${accountId}`;
        const ads=await paged(`${GRAPH_ROOT}/act_${accountId}/ads?limit=500&fields=id,created_time,updated_time&access_token=${encodeURIComponent(token)}`,5000);
        seen+=ads.length;
        const rows=ads.map((a:Row)=>({meta_ad_account_id:accountId,ad_id:String(a.id||""),ad_created_at:a.created_time||null,ad_updated_at:a.updated_time||null})).filter((x:Row)=>x.ad_id);
        if(rows.length){
          const {data,error}=await ops.rpc("apply_meta_creative_ad_dates",{p_client_id:clientId,p_rows:rows});
          if(error)throw error;
          updated+=Number(data||0);
        }
      }
      return json({ok:true,mode:"dates_only",client_id:clientId,client_name:client.display_name,accounts:accounts.length,ads_seen:seen,rows_updated:updated});
    }

    const started=new Date().toISOString();
    await ops.from("meta_creative_catalog_sync_state").upsert({client_id:clientId,status:"RUNNING",started_at:started,finished_at:null,last_error:null,updated_at:started},{onConflict:"client_id"});

    stage="existing_previews";
    const existingPreviewMap=await existingPreviews(ops,clientId);
    let previewBudget=MAX_PREVIEWS_PER_SYNC;
    const collected:Row[]=[];
    for(const accountId of accounts) {
      stage=`ads:${accountId}`;
      const adFields="id,name,status,effective_status,created_time,updated_time,campaign{id,name,status,effective_status},adset{id,name},creative{id,name}";
      const ads=await paged(`${GRAPH_ROOT}/act_${accountId}/ads?limit=500&fields=${encodeURIComponent(adFields)}&access_token=${encodeURIComponent(token)}`,5000);
      stage=`insights:${accountId}`;
      const insightMap=await insights(accountId,token).catch(()=>new Map<string,Row>());
      stage=`creatives:${accountId}`;
      const creativeIds:string[]=[...new Set<string>(ads.map((a:Row)=>String(a.creative?.id||"")).filter(Boolean))];
      const creativeFields="id,name,thumbnail_url,image_url,effective_object_story_id,object_type,object_story_spec,asset_feed_spec";
      const paths=creativeIds.map(id=>`${id}?thumbnail_width=600&thumbnail_height=600&fields=${encodeURIComponent(creativeFields)}`);
      const batch=paths.length?await batchGet(paths,token).catch(()=>new Map<string,Row>()):new Map<string,Row>();
      const creativeMap=new Map<string,Row>();
      paths.forEach((p,i)=>{const v=batch.get(p);if(v)creativeMap.set(creativeIds[i],v);});
      stage=`catalog_rows:${accountId}`;
      const rows=await mapConcurrent(ads,async(a:Row)=>{
        const adId=String(a.id||"");
        const creativeId=String(a.creative?.id||"");
        const creative=creativeMap.get(creativeId)||a.creative||{};
        const metrics=insightMap.get(adId)||{};
        const remotePreview=String(creative.thumbnail_url||creative.image_url||"");
        let previewPath=existingPreviewMap.get(`${accountId}:${adId}`)||null;
        const hasRecentDelivery=num(metrics.spend_7d)>0||num(metrics.results_7d)>0||num(metrics.impressions_7d)>0;
        if(!previewPath&&remotePreview&&hasRecentDelivery&&previewBudget>0){previewBudget-=1;previewPath=await mirrorPreview(db,clientId,adId,[creative.thumbnail_url,creative.image_url]);}
        return {
          client_id:clientId,client_name:client.display_name,lifecycle:client.lifecycle,
          meta_ad_account_id:accountId,ad_id:adId,ad_name:a.name||null,ad_status:a.effective_status||a.status||null,
          ad_created_at:a.created_time||null,ad_updated_at:a.updated_time||null,
          adset_id:a.adset?.id||null,adset_name:a.adset?.name||null,
          campaign_id:a.campaign?.id||null,campaign_name:a.campaign?.name||null,campaign_status:a.campaign?.effective_status||a.campaign?.status||null,
          creative_id:creativeId||null,creative_name:creative.name||a.creative?.name||null,creative_format:creativeFormat(creative,a.name),effective_object_story_id:creative.effective_object_story_id||null,
          preview_storage_path:previewPath,thumbnail_url:creative.thumbnail_url||null,image_url:creative.image_url||null,
          ...metrics,last_seen_at:new Date().toISOString(),last_synced_at:new Date().toISOString(),is_current:true,
          metadata:{graph_api_version:GRAPH_VERSION,object_type:creative.object_type||null,preview_mirror_status:previewPath?"STORED":remotePreview?"REMOTE_ONLY":"UNAVAILABLE"}
        };
      });
      collected.push(...rows.filter((r:Row)=>r.ad_id));
    }
    stage="catalog_mark_current";
    await ops.from("meta_creative_catalog").update({is_current:false,last_synced_at:new Date().toISOString()}).eq("client_id",clientId);
    stage="catalog_upsert";
    for(let offset=0;offset<collected.length;offset+=500){
      const chunk=collected.slice(offset,offset+500);
      if(!chunk.length)continue;
      const {error}=await ops.from("meta_creative_catalog").upsert(chunk,{onConflict:"client_id,meta_ad_account_id,ad_id"});
      if(error)throw error;
    }
    const finished=new Date().toISOString();
    const mirroredThisSync=MAX_PREVIEWS_PER_SYNC-previewBudget;
    await ops.from("meta_creative_catalog_sync_state").upsert({client_id:clientId,status:"OK",ad_count:collected.length,account_count:accounts.length,last_error:null,finished_at:finished,updated_at:finished,metadata:{lifecycle:client.lifecycle,preview_mirror_limit:MAX_PREVIEWS_PER_SYNC,preview_mirrored_this_sync:mirroredThisSync,meta_batch_concurrency:META_BATCH_CONCURRENCY,ad_creation_dates:true}},{onConflict:"client_id"});
    return json({ok:true,client_id:clientId,client_name:client.display_name,accounts:accounts.length,ads:collected.length,previews_mirrored:mirroredThisSync});
  } catch(error) {
    let raw="";
    try{raw=error instanceof Error?error.message:JSON.stringify(error);}catch{raw=String(error);}
    const message=`${stage}: ${raw}`.slice(0,900);
    if(mode!=="dates_only"){
      const finished=new Date().toISOString();
      await ops.from("meta_creative_catalog_sync_state").upsert({client_id:clientId,status:"ERROR",last_error:message,finished_at:finished,updated_at:finished},{onConflict:"client_id"});
    }
    return json({ok:false,error:mode==="dates_only"?"date_backfill_failed":"catalog_sync_failed",detail:message},500);
  }
});
