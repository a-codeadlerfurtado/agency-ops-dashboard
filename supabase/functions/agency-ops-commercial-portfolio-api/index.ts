import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const n=(v:unknown)=>Number(v??0)||0;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET") return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader=req.headers.get("Authorization")||"";
  if(!url||!anon||!service) return reply({error:"server_configuration"},500);
  if(!authHeader.startsWith("Bearer ")) return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData,error:authError}=await auth.auth.getUser();
  if(authError||!userData?.user?.id) return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const [{data:pref},{data:approvals}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED")
  ]);
  const person=pref?.collaborator_person||pref?.name||null;
  if(!person||!(approvals||[]).length) return reply({error:"profile_locked"},403);
  const {data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former) return reply({error:"forbidden"},403);
  if(person!=="Adler Furtado"&&!(person==="Leonardo Augusto"&&String(roster.role)==="COMMERCIAL")) return reply({error:"forbidden"},403);

  const [liveRes,timelineRes,statusRes,tenureRes,auditRes,churnRes,survivalRes,gtRetentionRes,longRes,signalRes,walletRes,clientsRes,healthRes]=await Promise.all([
    ops.from("portfolio_live").select("*"),
    ops.from("portfolio_timeline").select("*").order("month",{ascending:false}),
    ops.from("portfolio_client_status").select("*"),
    ops.from("portfolio_tenure_distribution").select("*"),
    ops.from("portfolio_audit_log").select("*").order("occurred_at",{ascending:false}).limit(100),
    ops.from("client_churn_log").select("*").order("saida",{ascending:false}).limit(200),
    ops.from("portfolio_survival").select("*").order("ordem"),
    ops.from("portfolio_gt_retention").select("*"),
    ops.from("portfolio_monthly_computed").select("*").gte("month","2026-01-01").order("month"),
    ops.from("portfolio_operational_signal").select("*"),
    ops.from("wallet_overview").select("*").order("ordem"),
    ops.from("dashboard_client_overview").select("*").limit(300),
    ops.from("client_health_scores").select("*").order("date",{ascending:false}).limit(1000)
  ]);
  const all=[liveRes,timelineRes,statusRes,tenureRes,auditRes,churnRes,survivalRes,gtRetentionRes,longRes,signalRes,walletRes,clientsRes,healthRes];
  const failed=all.find((r:any)=>r.error); if(failed?.error) return reply({error:"query_failed",detail:failed.error.message},500);
  const live=liveRes.data||[], timeline=timelineRes.data||[], pfClients=statusRes.data||[], tenure=tenureRes.data||[], audit=auditRes.data||[], churns=churnRes.data||[], survival=survivalRes.data||[], gtRetention=gtRetentionRes.data||[], longSeries=longRes.data||[], signals=signalRes.data||[], wallets=walletRes.data||[], rawClients=clientsRes.data||[], health=healthRes.data||[];
  const walletByOwner=new Map(wallets.map((r:any)=>[String(r.gt_owner||""),r.carteira??null]));
  const latestHealth=new Map<string,any>(); for(const r of health) if(r.client_id&&!latestHealth.has(String(r.client_id))) latestHealth.set(String(r.client_id),r);
  const clients=rawClients.map(({briefing_profile:_ignored,...c}:any)=>({...c,carteira:walletByOwner.get(String(c.gt_owner||""))??null,health:latestHealth.get(String(c.client_id))??null}));
  const sum=(field:string)=>live.reduce((acc:number,r:any)=>acc+n(r[field]),0);
  const portfolio={
    reference:new Date().toISOString().slice(0,10),
    total_active:sum("active_clients"),
    sectors:live,
    status_summary:{inadimplentes:sum("inadimplentes"),juridico:sum("juridico"),churn_previsto:sum("churn_previsto")},
    transitions:pfClients.filter((r:any)=>r.urgencia==="urgente").sort((a:any,b:any)=>n(a.dias_para_proxima)-n(b.dias_para_proxima)),
    clients:pfClients,
    tenure_distribution:tenure,
    timeline,
    churns,
    audit,
    survival,
    gt_retention:gtRetention,
    long_series:longSeries,
    operational_signal:signals.filter((r:any)=>r.sinal!=="ativo"&&r.sinal!=="churned"),
    signal_summary:signals.filter((r:any)=>["ACTIVE","ONBOARDING"].includes(String(r.lifecycle))).reduce((acc:any,r:any)=>{acc[r.sinal]=(acc[r.sinal]??0)+1;return acc;},{}),
  };
  return reply({ok:true,profile:{person,role:roster.role,mode:"COMMERCIAL_CLIENTS_ADLER_PARITY"},portfolio,clients,generated_at:new Date().toISOString()});
});