export type ProviderPage={rows:any[];cursor:string|null;creditCost:number;creditsRemaining:number|null};
export type ProviderAdapter={name:string;configured:boolean;missingCode:string;missingDetail:string;search:(query:string,limit:number)=>Promise<ProviderPage>;expandAdvertisers:(ids:string[],limit:number)=>Promise<ProviderPage>};
const clean=(v:unknown,n=1000)=>String(v??"").trim().slice(0,n);
async function parse(res:Response):Promise<ProviderPage>{
  const payload=await res.json().catch(()=>({data:[],error:{message:"invalid_json"}}));
  if(!res.ok){const e:any=new Error(clean(payload?.error?.message||payload?.error||res.statusText,300)||("provider_http_"+res.status));e.status=res.status;throw e}
  const rem=Number(res.headers.get("x-credits-remaining")||NaN);
  return {rows:Array.isArray(payload?.data)?payload.data:[],cursor:clean(payload?.metadata?.cursor,1000)||null,creditCost:Number(res.headers.get("x-credit-cost")||0)||0,creditsRemaining:Number.isFinite(rem)?rem:null};
}
function foreplay():ProviderAdapter{
  const key=Deno.env.get("FOREPLAY_API_KEY")||"";
  return {name:"FOREPLAY",configured:Boolean(key),missingCode:"FOREPLAY_API_KEY_MISSING",missingDetail:"FOREPLAY_API_KEY não está configurada. Nenhuma coleta externa foi simulada.",
    async search(query,limit){const p=new URLSearchParams({query,limit:String(Math.min(250,limit)),order:"most_relevant"});p.append("niches","real estate");p.append("languages","pt");p.append("publisher_platform","facebook");p.append("publisher_platform","instagram");return parse(await fetch("https://public.api.foreplay.co/api/discovery/ads?"+p.toString(),{headers:{Authorization:key},signal:AbortSignal.timeout(20000)}))},
    async expandAdvertisers(ids,limit){const p=new URLSearchParams({brand_ids:ids.join(","),limit:String(Math.min(25,limit)),order:"most_relevant"});p.append("languages","pt");return parse(await fetch("https://public.api.foreplay.co/api/brand/getAdsByBrandId?"+p.toString(),{headers:{Authorization:key},signal:AbortSignal.timeout(20000)}))}
  };
}

const pickUrl=(v:any)=>{if(typeof v==="string")return v;if(!v||typeof v!=="object")return "";return clean(v.url||v.src||v.video_url||v.image_url||v.original_image_url||v.resized_image_url||v.thumbnail_url,3000)};
const apifyRow=(r:any)=>{
  const images=(Array.isArray(r?.images)?r.images:[]).map(pickUrl).filter(Boolean),videos=(Array.isArray(r?.videos)?r.videos:[]).map(pickUrl).filter(Boolean);
  const cards=[...images.slice(1).map((url:string)=>({image:url})),...videos.slice(1).map((url:string)=>({video:url}))];
  const adId=clean(r?.ad_id||r?.id,400),pageId=clean(r?.page_id||r?.resolved_page_id||r?.pageId,300);
  return {brand_id:pageId||"unknown",ad_id:adId,id:adId,name:clean(r?.page_name||r?.title,500),description:clean(r?.body_text||r?.link_description||r?.caption,5000),headline:clean(r?.title,1000),link_url:clean(r?.link_url,3000),cta_title:clean(r?.cta_text,300),cta_type:clean(r?.cta_type,300),display_format:clean(r?.display_format,100),publisher_platform:Array.isArray(r?.publisher_platform)?r.publisher_platform:(r?.publisher_platform?[r.publisher_platform]:[]),live:typeof r?.is_active==="boolean"?r.is_active:true,started_running:r?.start_date||null,image:images[0]||"",video:videos[0]||"",thumbnail:"",cards,avatar:clean(r?.page_profile_picture_url,3000),source_url:adId?"https://www.facebook.com/ads/library/?id="+encodeURIComponent(adId):"",provider_payload:{country:r?.country||r?.country_iso_code||null,query:r?.query||null,collation_id:r?.collation_id||null,impressions_text:r?.impressions_text||null,spend_text:r?.spend_text||null}};
};
async function apifyCall(token:string,input:any){
  const u="https://api.apify.com/v2/acts/s-r~meta-ads-library/run-sync-get-dataset-items?token="+encodeURIComponent(token);
  const res=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
  const payload=await res.json().catch(()=>[]);
  if(!res.ok){const e:any=new Error(clean((payload as any)?.error?.message||(payload as any)?.error||res.statusText,300)||("apify_http_"+res.status));e.status=res.status;throw e}
  const rows=Array.isArray(payload)?payload.map(apifyRow).filter((x:any)=>x.ad_id):[];
  return {rows,cursor:null,creditCost:0,creditsRemaining:null};
}
function apify():ProviderAdapter{
  const key=Deno.env.get("APIFY_TOKEN")||Deno.env.get("APIFY_API_TOKEN")||"";
  return {name:"APIFY",configured:Boolean(key),missingCode:"APIFY_TOKEN_MISSING",missingDetail:"APIFY_TOKEN não está configurado. Nenhuma coleta externa foi simulada.",
    search:(query,limit)=>apifyCall(key,{search:query,country:"BR",active_only:true,max_ads:Math.min(250,limit)}),
    async expandAdvertisers(ids,limit){if(!ids.length)return {rows:[],cursor:null,creditCost:0,creditsRemaining:null};return apifyCall(key,{page_id:ids[0],country:"BR",active_only:true,max_ads:Math.min(25,limit)})}
  };
}

const metaBrowserRow=(r:any)=>{
  const cs=Array.isArray(r?.creatives)?r.creatives:[],firstImage=cs.find((c:any)=>c?.kind==="image"),firstVideo=cs.find((c:any)=>c?.kind==="video");
  const image=clean(firstImage?.imageUrl||firstImage?.imageResizedUrl,3000),video=clean(firstVideo?.videoHdUrl||firstVideo?.videoSdUrl,3000),thumbnail=clean(firstVideo?.previewImageUrl,3000);
  const mainIndex=image?cs.indexOf(firstImage):video?cs.indexOf(firstVideo):-1;
  const cards=cs.filter((_:any,i:number)=>i!==mainIndex).map((c:any)=>({image:clean(c?.imageUrl||c?.imageResizedUrl,3000)||undefined,video:clean(c?.videoHdUrl||c?.videoSdUrl,3000)||undefined,thumbnail:clean(c?.previewImageUrl,3000)||undefined})).filter((c:any)=>c.image||c.video);
  const adId=clean(r?.libraryId,400),pageId=clean(r?.pageId,300);
  return {brand_id:pageId||"unknown",ad_id:adId,id:adId,name:clean(r?.pageName,500),description:clean(r?.body||r?.linkDescription||r?.caption,5000),headline:clean(r?.title,1000),link_url:clean(r?.linkUrl,3000),cta_title:clean(r?.ctaText,300),cta_type:clean(r?.ctaType,300),display_format:clean(r?.displayFormat,100),publisher_platform:Array.isArray(r?.platforms)?r.platforms:[],live:typeof r?.isActive==="boolean"?r.isActive:true,started_running:r?.startedRunning||null,image,video,thumbnail,cards,avatar:clean(r?.pageProfilePictureUrl,3000),source_url:clean(r?.adDetailsUrl,3000)||("https://www.facebook.com/ads/library/?id="+encodeURIComponent(adId)),provider_payload:{countries:r?.countries||[],categories:r?.categories||[],page_categories:r?.pageCategories||[],days_active:r?.daysActive??null,variants_using_creative:r?.variantsUsingCreative??null,link_domain:r?.linkDomain||null,source:r?.source||"browser"}};
};
async function metaBrowserCall(input:any):Promise<ProviderPage>{
  const base=clean(Deno.env.get("RADAR_COLLECTOR_URL"),2000).replace(/\/+$/,""),token=clean(Deno.env.get("RADAR_COLLECTOR_TOKEN"),4000);
  if(!base||!token){const e:any=new Error("Radar Meta Browser collector não está configurado.");e.status=503;throw e}
  let res:Response|undefined,lastNetwork:any;
  for(let attempt=0;attempt<3;attempt++){
    try{res=await fetch(base+"/search",{method:"POST",headers:{"content-type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(input),signal:AbortSignal.timeout(90000)});break}
    catch(e:any){lastNetwork=e;if(attempt<2)await new Promise(r=>setTimeout(r,1500*(attempt+1)))}
  }
  if(!res){const e:any=new Error("meta_browser_network: "+clean(lastNetwork?.message||lastNetwork,240));e.status=0;throw e}
  const payload=await res.json().catch(()=>({}));
  if(!res.ok){const e:any=new Error(clean(payload?.detail||payload?.error||res.statusText,300)||("meta_browser_http_"+res.status));e.status=res.status;throw e}
  const rows=(Array.isArray(payload?.ads)?payload.ads:[]).map(metaBrowserRow).filter((x:any)=>x.ad_id);
  return {rows,cursor:clean(payload?.cursor,1000)||null,creditCost:0,creditsRemaining:null};
}
function metaBrowser():ProviderAdapter{
  const url=clean(Deno.env.get("RADAR_COLLECTOR_URL"),2000),token=clean(Deno.env.get("RADAR_COLLECTOR_TOKEN"),4000);
  return {name:"META_BROWSER",configured:Boolean(url&&token),missingCode:"META_BROWSER_NOT_CONFIGURED",missingDetail:"Coletor gratuito da Meta Ads Library não está configurado.",
    search:(query,limit)=>metaBrowserCall({query,country:"BR",limit:Math.min(30,Math.max(1,limit))}),
    async expandAdvertisers(ids,limit){if(!ids.length)return {rows:[],cursor:null,creditCost:0,creditsRemaining:null};return metaBrowserCall({page_id:ids[0],country:"BR",limit:Math.min(30,Math.max(1,limit))})}
  };
}

function auto():ProviderAdapter{
  const b=metaBrowser();if(b.configured)return b;
  const f=foreplay();if(f.configured)return f;
  const a=apify();if(a.configured)return a;
  return {name:"AUTO",configured:false,missingCode:"RADAR_PROVIDER_UNAVAILABLE",missingDetail:"Nenhuma fonte de coleta do Radar está disponível. O coletor Meta Browser gratuito, Foreplay e Apify estão indisponíveis.",search:async()=>({rows:[],cursor:null,creditCost:0,creditsRemaining:null}),expandAdvertisers:async()=>({rows:[],cursor:null,creditCost:0,creditsRemaining:null})};
}

function unsupported(name:string):ProviderAdapter{
  const n=clean(name,80).toUpperCase()||"UNKNOWN",fail=async()=>{const e:any=new Error("Provider "+n+" ainda não possui adapter ativo.");e.status=501;throw e};
  return {name:n,configured:false,missingCode:"PROVIDER_ADAPTER_UNAVAILABLE",missingDetail:"Provider "+n+" ainda não possui adapter ativo. Configure um adapter suportado antes de habilitar a coleta.",search:fail,expandAdvertisers:fail};
}
export function providerAdapter(name:unknown):ProviderAdapter{const n=clean(name,80).toUpperCase();if(n==="AUTO")return auto();if(n==="META_BROWSER")return metaBrowser();if(n==="FOREPLAY")return foreplay();if(n==="APIFY")return apify();return unsupported(n)}
export function providerErrorCode(error:any,providerName:string){const s=Number(error?.status||0);if(providerName==="META_BROWSER"){if(s===429)return "META_BROWSER_RATE_LIMIT";if(s===401||s===403)return "META_BROWSER_AUTH";if(s===502||s===503)return "META_BROWSER_TEMPORARY";if(s)return "META_BROWSER_HTTP_"+s}if(providerName==="FOREPLAY"){if(s===402)return "FOREPLAY_CREDITS_EXHAUSTED";if(s===429)return "FOREPLAY_RATE_LIMIT";if(s===401||s===403)return "FOREPLAY_AUTH";if(s)return "FOREPLAY_HTTP_"+s}if(providerName==="APIFY"){if(s===402)return "APIFY_CREDITS_EXHAUSTED";if(s===429)return "APIFY_RATE_LIMIT";if(s===401||s===403)return "APIFY_AUTH";if(s)return "APIFY_HTTP_"+s}return s?"PROVIDER_HTTP_"+s:"NETWORK_ERROR"}
