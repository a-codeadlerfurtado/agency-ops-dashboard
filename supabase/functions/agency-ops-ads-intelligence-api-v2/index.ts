import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const VERSION = "v21.0";
const UPSTREAM = "agency-ops-ads-intelligence-api";
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization,apikey","access-control-allow-methods":"GET,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const finite=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
const cleanAccount=(v:unknown)=>String(v||"").trim().replace(/^act_/,"");
const localDate=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

async function resolveMetaTokens(db:any){
  const env=String(Deno.env.get("META_SYSTEM_USER_TOKEN")||"").trim();
  const {data,error}=await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vault=!error&&typeof data==="string"?data.trim():"";
  const out:{token:string;source:string}[]=[];
  if(env) out.push({token:env,source:"ENV_OPERATIONAL"});
  if(vault&&vault!==env) out.push({token:vault,source:"VAULT_FALLBACK"});
  return out;
}

async function canonicalAccounts(ops:any,clientId:string){
  const {data:integrations}=await ops.from("client_integrations")
    .select("meta_ad_account_id,is_primary,confidence,created_at")
    .eq("client_id",clientId).eq("system","META_BM").not("meta_ad_account_id","is",null)
    .order("is_primary",{ascending:false}).order("created_at",{ascending:false}).limit(20);
  const primary=(integrations||[]).filter((r:Row)=>r.is_primary).map((r:Row)=>cleanAccount(r.meta_ad_account_id)).filter(Boolean);
  const integrated=(integrations||[]).map((r:Row)=>cleanAccount(r.meta_ad_account_id)).filter(Boolean);
  let ids=[...new Set(primary.length?primary:integrated)].filter(id=>/^\d{5,30}$/.test(id));
  let source=primary.length?"CLIENT_INTEGRATIONS_PRIMARY":integrated.length?"CLIENT_INTEGRATIONS":"";
  if(!ids.length){
    const {data:balances}=await ops.from("client_balance_overview").select("meta_ad_account_id,run_status,checked_at")
      .eq("client_id",clientId).not("meta_ad_account_id","is",null).limit(20);
    ids=[...new Set((balances||[]).map((r:Row)=>cleanAccount(r.meta_ad_account_id)).filter((id:string)=>/^\d{5,30}$/.test(id)))];
    source=ids.length?"BALANCE_OVERVIEW":"";
  }
  return {ids,source:source||"UNRESOLVED"};
}

async function fetchSpend(token:string,accountId:string,since:string,until:string){
  const range=encodeURIComponent(JSON.stringify({since,until}));
  const urls=[
    `https://graph.facebook.com/${VERSION}/act_${accountId}/insights?level=account&time_range=${range}&fields=spend&access_token=${encodeURIComponent(token)}`,
    `https://graph.facebook.com/${VERSION}/act_${accountId}/insights?level=account&date_preset=this_month&fields=spend&access_token=${encodeURIComponent(token)}`,
  ];
  let lastError="";
  for(const url of urls){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),6500);
    try{
      const r=await fetch(url,{signal:controller.signal});
      const b=await r.json().catch(()=>null);
      if(!r.ok||b?.error){lastError=String(b?.error?.message||`Meta HTTP ${r.status}`).slice(0,220);continue;}
      const row=b?.data?.[0]||null;
      return {ok:true,spend:row?finite(row.spend)||0:0,error:null};
    }catch(error){
      lastError=error instanceof DOMException&&error.name==="AbortError"?"Meta timeout":String(error instanceof Error?error.message:error).slice(0,220);
    }finally{clearTimeout(timer)}
  }
  return {ok:false,spend:null,error:lastError||"Meta spend unavailable"};
}

async function liveMtdSpend(db:any,ops:any,clientId:string,since:string,until:string){
  const tokens=await resolveMetaTokens(db);
  const canonical=await canonicalAccounts(ops,clientId);
  if(!tokens.length||!canonical.ids.length)return {spend:null,accounts:[],failures:canonical.ids.length||1,source:"UNAVAILABLE",account_source:canonical.source,credential_source:null};
  let spend=0,failures=0;
  const accounts:Row[]=[];
  const usedSources=new Set<string>();
  for(const id of canonical.ids){
    let ok=false,lastError="";
    for(const credential of tokens){
      const result=await fetchSpend(credential.token,id,since,until);
      if(result.ok){
        spend+=Number(result.spend||0);
        usedSources.add(credential.source);
        accounts.push({account_id:id,spend:Number(result.spend||0),status:"OK",credential_source:credential.source});
        ok=true;
        break;
      }
      lastError=String(result.error||"");
    }
    if(!ok){failures++;accounts.push({account_id:id,status:"ERROR",error:lastError||"Meta spend unavailable"});}
  }
  const successes=canonical.ids.length-failures;
  const source=successes===canonical.ids.length?"META_LIVE":successes>0&&canonical.ids.length>1?"META_LIVE_PARTIAL":"UNAVAILABLE";
  return {spend:successes>0?spend:null,accounts,failures,source,account_source:canonical.source,credential_source:[...usedSources].join("+")||null};
}

function budgetPacing(monthlyBudget:number|null,mtdSpend:number|null,today:string){
  const current=new Date(`${today}T12:00:00-03:00`),year=current.getFullYear(),month=current.getMonth(),day=current.getDate(),daysInMonth=new Date(year,month+1,0).getDate(),remainingDays=Math.max(0,daysInMonth-day),elapsedDays=day;
  if(monthlyBudget===null||monthlyBudget<=0)return{status:"NO_BUDGET",monthly_budget:monthlyBudget,mtd_spend:mtdSpend,remaining_budget:null,elapsed_days:elapsedDays,remaining_days:remainingDays,days_in_month:daysInMonth,ideal_daily_remaining:null,current_daily_pace:mtdSpend===null?null:mtdSpend/Math.max(1,elapsedDays),projected_month_spend:null,variance:null};
  if(mtdSpend===null)return{status:"MTD_UNAVAILABLE",monthly_budget:monthlyBudget,mtd_spend:null,remaining_budget:null,elapsed_days:elapsedDays,remaining_days:remainingDays,days_in_month:daysInMonth,ideal_daily_remaining:null,current_daily_pace:null,projected_month_spend:null,variance:null};
  const remaining=Math.max(0,monthlyBudget-mtdSpend),currentDaily=mtdSpend/Math.max(1,elapsedDays),idealRemaining=remainingDays>0?remaining/remainingDays:0,projected=mtdSpend+currentDaily*remainingDays,variance=projected-monthlyBudget,ratio=monthlyBudget>0?projected/monthlyBudget:1;
  let status="ON_PACE";if(mtdSpend>=monthlyBudget)status="BUDGET_REACHED";else if(ratio>1.08)status="OVER_PACE";else if(ratio<.82)status="UNDER_PACE";
  return{status,monthly_budget:monthlyBudget,mtd_spend:mtdSpend,remaining_budget:remaining,elapsed_days:elapsedDays,remaining_days:remainingDays,days_in_month:daysInMonth,ideal_daily_remaining:idealRemaining,current_daily_pace:currentDaily,projected_month_spend:projected,variance};
}

function patchBudgetRecommendations(body:Row,pacing:Row){
  const remove=new Set(["Pacing mensal sem leitura completa","Teto mensal atingido","Ritmo acima do budget","Há espaço dentro do budget"]);
  const out=(Array.isArray(body.recommendations)?body.recommendations:[]).filter((r:Row)=>!remove.has(String(r.title||"")));
  const add=(r:Row)=>out.unshift(r);
  if(pacing.status==="MTD_UNAVAILABLE")add({category:"BUDGET",priority:"HIGH",title:"Pacing mensal sem leitura completa",action:"Não aumentar o gasto total até recuperar o acumulado do mês.",reason:"A consulta financeira de gasto do mês não pôde ser confirmada na Meta.",budget_effect:"BLOCKED",confidence:"HIGH"});
  if(pacing.status==="BUDGET_REACHED")add({category:"BUDGET",priority:"CRITICAL",title:"Teto mensal atingido",action:"Não elevar orçamento; reduzir ritmo ou pausar frentes não prioritárias.",reason:"O gasto acumulado já atingiu o budget mensal cadastrado.",budget_effect:"REDUCE",confidence:"HIGH"});
  if(pacing.status==="OVER_PACE")add({category:"BUDGET",priority:"HIGH",title:"Ritmo acima do budget",action:`Ajustar o portfólio para aproximadamente R$ ${Number(pacing.ideal_daily_remaining||0).toFixed(2).replace(".",",")}/dia no restante do mês.`,reason:`A projeção supera o teto em cerca de R$ ${Math.max(0,Number(pacing.variance||0)).toFixed(2).replace(".",",")}.`,budget_effect:"REDUCE",confidence:"HIGH"});
  const benchmark=body.benchmark||{},current7=body.windows?.[7]||body.windows?.["7"]||null,cpr=finite(current7?.cpl??current7?.cost_per_result),bench=benchmark?.valid_for_recommendation?finite(benchmark?.cpl):null;
  if(pacing.status==="UNDER_PACE"&&benchmark?.valid_for_recommendation&&cpr!==null&&bench!==null&&cpr<=bench*1.1)add({category:"PACING",priority:"MEDIUM",title:"Há espaço dentro do budget",action:`Se a estabilidade se mantiver, o gasto diário total pode se aproximar de R$ ${Number(pacing.ideal_daily_remaining||0).toFixed(2).replace(".",",")}/dia, priorizando frentes eficientes.`,reason:"A projeção está abaixo do teto e a performance está compatível com a coorte contextual.",budget_effect:"WITHIN_BUDGET",confidence:"MEDIUM"});
  const order:Record<string,number>={CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3};
  return out.sort((a:Row,b:Row)=>(order[a.priority]??9)-(order[b.priority]??9)).slice(0,8);
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"",serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!supabaseUrl||!serviceRole)return json({error:"server_configuration"},500);
  const incoming=new URL(req.url);
  const upstreamUrl=`${supabaseUrl}/functions/v1/${UPSTREAM}${incoming.search}`;
  const upstream=await fetch(upstreamUrl,{headers:{Authorization:req.headers.get("Authorization")||"",apikey:req.headers.get("apikey")||""},cache:"no-store"});
  const body=await upstream.json().catch(()=>({}));
  if(!upstream.ok)return json(body,upstream.status);
  const clientId=String(incoming.searchParams.get("client_id")||"").trim();
  if(!clientId||incoming.searchParams.get("probe")==="1")return json(body,200);
  try{
    const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
    const today=localDate(),since=`${today.slice(0,8)}01`;
    const mtd=await liveMtdSpend(db,ops,clientId,since,today);
    const monthlyBudget=finite(body?.budget?.monthly_budget);
    const pacing=budgetPacing(monthlyBudget,finite(mtd.spend),today);
    body.pacing={...pacing,source:mtd.source,account_reads:mtd.accounts,failures:mtd.failures,account_source:mtd.account_source,credential_source:mtd.credential_source,as_of:today,financial_query:"SPEND_ONLY"};
    body.recommendations=patchBudgetRecommendations(body,body.pacing);
    body.mtd_diagnostic={canonical_account_source:mtd.account_source,credential_source:mtd.credential_source,account_count:mtd.accounts.length,successful_accounts:mtd.accounts.filter((r:Row)=>r.status==="OK").length,query:"account insights / spend only",as_of:today};
    console.log("[ads-intelligence-v2-mtd]",JSON.stringify({client_id:clientId,source:mtd.source,credential_source:mtd.credential_source,failures:mtd.failures,accounts:mtd.accounts.map((r:Row)=>({account_id:r.account_id,status:r.status,error:r.error?String(r.error).slice(0,140):null}))}));
    return json(body,200);
  }catch(error){
    console.error("[ads-intelligence-v2-mtd]",error);
    body.pacing={...(body.pacing||{}),source:"UNAVAILABLE",mtd_spend:null,status:"MTD_UNAVAILABLE",financial_query:"SPEND_ONLY_FAILED"};
    body.recommendations=patchBudgetRecommendations(body,body.pacing);
    return json(body,200);
  }
});