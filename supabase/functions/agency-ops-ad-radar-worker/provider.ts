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
function unsupported(name:string):ProviderAdapter{
  const n=clean(name,80).toUpperCase()||"UNKNOWN",fail=async()=>{const e:any=new Error("Provider "+n+" ainda não possui adapter ativo.");e.status=501;throw e};
  return {name:n,configured:false,missingCode:"PROVIDER_ADAPTER_UNAVAILABLE",missingDetail:"Provider "+n+" ainda não possui adapter ativo. Configure um adapter suportado antes de habilitar a coleta.",search:fail,expandAdvertisers:fail};
}
export function providerAdapter(name:unknown):ProviderAdapter{const n=clean(name,80).toUpperCase();return n==="FOREPLAY"?foreplay():unsupported(n)}
export function providerErrorCode(error:any,providerName:string){const s=Number(error?.status||0);if(providerName==="FOREPLAY"){if(s===402)return "FOREPLAY_CREDITS_EXHAUSTED";if(s===429)return "FOREPLAY_RATE_LIMIT";if(s===401||s===403)return "FOREPLAY_AUTH";if(s)return "FOREPLAY_HTTP_"+s}return s?"PROVIDER_HTTP_"+s:"NETWORK_ERROR"}
