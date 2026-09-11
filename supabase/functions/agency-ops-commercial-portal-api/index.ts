import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const allowedOrigin=(origin?:string|null)=>!!origin&&(ORIGINS.has(origin)||/^https:\/\/[a-f0-9]{8}-agency-ops-dashboard\.lakassessoriadigital\.workers\.dev$/i.test(origin));
const TZ = "America/Sao_Paulo";
const METRICS: Record<string,string> = {
  leads_received:"Leads recebidos", leads_contacted:"Leads acionados",
  leads_in_conversation:"Leads em conversa", calls_made:"Ligações feitas",
  calls_answered:"Ligações atendidas", visits_scheduled:"Visitas agendadas",
  visits_completed:"Visitas realizadas", proposals:"Propostas", sales:"Vendas",
  properties_prospected:"Imóveis captados", properties_listed:"Imóveis cadastrados",
};

function json(body:unknown,status=200,origin?:string|null){
  const h:Record<string,string>={"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-headers":"authorization,apikey,content-type,x-portal-token","access-control-allow-methods":"GET,POST,OPTIONS"};
  if(allowedOrigin(origin)){h["access-control-allow-origin"]=String(origin);h.vary="Origin";}
  return new Response(JSON.stringify(body),{status,headers:h});
}
const digits=(v:unknown)=>String(v??"").replace(/\D/g,"");const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const localDate=(d=new Date())=>new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
const shiftDate=(day:string,delta:number)=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);};
const localWeekday=(d=new Date())=>{const x=new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short"}).format(d);return x==="Sun"?0:["Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(x)+1;};
const reportPeriod=()=>{const today=localDate(),dow=localWeekday();if(dow===1)return {start:shiftDate(today,-3),end:shiftDate(today,-1)};if(dow===6){const d=shiftDate(today,-2);return {start:d,end:d};}if(dow===0){const d=shiftDate(today,-3);return {start:d,end:d};}const d=shiftDate(today,-1);return {start:d,end:d};};
const reportReferenceDate=()=>reportPeriod().end;
const sha256=async(value:string)=>{const bytes=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");};

function readNum(t:string,patterns:RegExp[],zero:RegExp[]=[]){
  for(const rx of zero) if(rx.test(t)) return 0;
  for(const rx of patterns){const m=t.match(rx);if(m){const n=Number(m[1]);if(Number.isFinite(n)&&n>=0)return n;}}
  return null;
}
function parseMetrics(raw:string){
  const t=norm(raw).replace(/\s+/g," "),m:Row={};
  m.leads_received=readNum(t,[/recebi\s+(\d+)\s+leads?/,/(\d+)\s+leads?\s+(?:recebidos?|entraram?)/]);
  m.leads_contacted=readNum(t,[/(?:acionei|atendi|contatei)\s+(\d+)(?:\s+leads?)?/,/(\d+)\s+leads?\s+(?:acionados?|atendidos?|contatados?)/]);
  m.leads_in_conversation=readNum(t,[/(\d+)\s+leads?\s+(?:em\s+)?conversa/,/(?:conversando|em conversa)\s+com\s+(\d+)/]);
  m.calls_made=readNum(t,[/(?:fiz|efetuei)\s+(\d+)\s+liga/,/(\d+)\s+ligacoes?\s+(?:feitas|efetuadas)/,/(\d+)\s+ligacoes?/]);
  m.calls_answered=readNum(t,[/(\d+)\s+(?:ligacoes?\s+)?(?:atendidas|atenderam)/,/liga(?:cao|coes)\s+atendidas?\D{0,8}(\d+)/]);
  m.visits_scheduled=readNum(t,[/(?:marquei|agendei)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:agendadas|marcadas)/]);  m.visits_completed=readNum(t,[/(?:realizei|fiz)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:realizadas|feitas)/]);
  m.proposals=readNum(t,[/(?:fiz|enviei|emiti)\s+(\d+)\s+propostas?/,/(\d+)\s+propostas?/],[/nenhuma\s+proposta/,/sem\s+proposta/]);
  m.sales=readNum(t,[/(?:vendi|fechei)\s+(\d+)/,/(\d+)\s+vendas?/],[/nenhuma\s+venda/,/sem\s+venda/]);
  m.properties_prospected=readNum(t,[/(?:captei|prospectei)\s+(\d+)/,/(\d+)\s+(?:captacoes?|imoveis?\s+(?:captados|prospectados))/]);
  m.properties_listed=readNum(t,[/cadastrei\s+(\d+)/,/(\d+)\s+(?:cadastros?|imoveis?\s+cadastrados)/]);
  const found=Object.values(m).filter(v=>v!==null).length;
  return {metrics:m,found,confidence:Math.min(1,found/6)};
}
function anomalies(metrics:Row){
  const out:Row[]=[];const flag=(code:string,message:string)=>out.push({code,severity:"REVISAR",message});
  if(metrics.calls_answered!=null&&metrics.calls_made!=null&&metrics.calls_answered>metrics.calls_made)flag("CALLS_OVER_MADE","Ligações atendidas acima das ligações feitas.");
  if(metrics.visits_completed!=null&&metrics.visits_scheduled!=null&&metrics.visits_completed>metrics.visits_scheduled)flag("VISITS_OVER_SCHEDULED","Visitas realizadas acima das agendadas neste reporte; pode incluir agenda anterior.");
  if(metrics.sales!=null&&metrics.proposals!=null&&metrics.sales>metrics.proposals)flag("SALES_OVER_PROPOSALS","Vendas acima das propostas neste reporte; revisar a janela temporal.");
  if(metrics.leads_contacted!=null&&metrics.leads_received!=null&&metrics.leads_contacted>metrics.leads_received)flag("CONTACTED_OVER_RECEIVED","Acionados acima dos leads recebidos; pode incluir carteira antiga.");
  return out;
}

async function resolveAccess(req:Request,ops:any,anon:string,service:string){
  const url=new URL(req.url), portalToken=req.headers.get("x-portal-token")||url.searchParams.get("t")||"";
  if(portalToken){
    const hash=await sha256(portalToken);
    const {data:link}=await ops.from("commercial_portal_magic_links").select("*,commercial_followup_clients(*),commercial_followup_brokers(*)").eq("token_hash",hash).is("revoked_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
    if(!link)return null;
    const client=Array.isArray(link.commercial_followup_clients)?link.commercial_followup_clients[0]:link.commercial_followup_clients;
    const broker=Array.isArray(link.commercial_followup_brokers)?link.commercial_followup_brokers[0]:link.commercial_followup_brokers;
    return {kind:"MAGIC",role:"BROKER",actor:broker?.display_name||"Corretor",client,broker,link,user_id:null};
  }
  const authHeader=req.headers.get("authorization")||"";
  if(!authHeader.startsWith("Bearer "))return null;
  const sbUrl=Deno.env.get("SUPABASE_URL")!;
  const auth=createClient(sbUrl,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:u}=await auth.auth.getUser();
  if(!u?.user)return null;
  const requested=url.searchParams.get("client")||"";
  const {data:accessRows}=await ops.from("commercial_portal_access").select("*,commercial_followup_clients(*),commercial_followup_brokers(*)").eq("auth_user_id",u.user.id).eq("active",true);
  let access=(accessRows||[]).find((a:Row)=>{const c=Array.isArray(a.commercial_followup_clients)?a.commercial_followup_clients[0]:a.commercial_followup_clients;return requested&&[c?.id,c?.slug].includes(requested);})||(accessRows||[])[0]||null;
  if(access){
    const client=Array.isArray(access.commercial_followup_clients)?access.commercial_followup_clients[0]:access.commercial_followup_clients;
    const broker=Array.isArray(access.commercial_followup_brokers)?access.commercial_followup_brokers[0]:access.commercial_followup_brokers;
    return {kind:"LOGIN",role:String(access.portal_role),actor:access.display_name||u.user.email||"Usuário",client,broker,user_id:u.user.id,access};
  }
  const {data:p}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",u.user.id).maybeSingle();
  const person=String(p?.collaborator_person||"");
  const {data:r}=person?await ops.from("team_roster").select("role,is_former").eq("person",person).maybeSingle():{data:null};
  const internalRole=String(r?.role||"").toUpperCase();
  if(!r||r.is_former||!["MGMT","CS"].includes(internalRole))return null;
  let q=ops.from("commercial_followup_clients").select("*").eq("portal_enabled",true);
  if(requested)q=q.or(`id.eq.${requested},slug.eq.${requested}`);
  const {data:client}=await q.order("display_name").limit(1).maybeSingle();
  if(!client)return null;
  return {kind:"INTERNAL",role:internalRole,actor:person,client,broker:null,user_id:u.user.id,access:null};
}

function scopedBrokerIds(access:Row,brokers:Row[]){
  if(access.role==="BROKER")return access.broker?.id?[access.broker.id]:[];
  return brokers.map(b=>b.id);
}
async function portalPayload(ops:any,access:Row){
  const client=access.client;
  if(!client?.portal_enabled)return {error:"portal_disabled",status:403};
  const since=shiftDate(localDate(),-60);
  const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",client.id).eq("active",true).order("display_name");
  const allowedIds=scopedBrokerIds(access,brokers||[]);
  const {data:days}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",client.id).gte("report_date",since).order("report_date",{ascending:false}).limit(90);
  const dayIds=(days||[]).map((d:Row)=>d.id);
  let entries:Row[]=[];
  if(dayIds.length&&allowedIds.length){
    const {data:e}=await ops.from("commercial_followup_entries").select("*,commercial_followup_brokers(display_name,phone_e164,paused_until,pause_reason,legacy_last_reported_on)").in("followup_day_id",dayIds).in("broker_id",allowedIds).order("updated_at",{ascending:false});
    entries=e||[];
  }
  const reference=reportReferenceDate();
  const current=(days||[]).find((d:Row)=>String(d.report_date)===reference)||(days||[])[0]||null;
  return {ok:true,access:{kind:access.kind,role:access.role,actor:access.actor,broker_id:access.broker?.id||null},client,brokers:access.role==="BROKER"?(brokers||[]).filter((b:Row)=>b.id===access.broker?.id):(brokers||[]),days:days||[],entries,reference_date:reference,current_day_id:current?.id||null,metric_labels:METRICS};
}

async function ensureEntry(ops:any,client:Row,brokerId:string,reportDate:string){
  let {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",client.id).eq("report_date",reportDate).maybeSingle();
  if(!day){
    const x=await ops.from("commercial_followup_days").insert({followup_client_id:client.id,report_date:reportDate,period_start:(reportDate===reportReferenceDate()?reportPeriod().start:reportDate),period_end:reportDate,status:"PORTAL_OPEN",source_payload:{created_by:"portal",created_at:new Date().toISOString()}}).select("*").single();
    if(x.error||!x.data)throw new Error(x.error?.message||"day_create_failed");
    day=x.data;
  }
  let {data:entry}=await ops.from("commercial_followup_entries").select("*").eq("followup_day_id",day.id).eq("broker_id",brokerId).maybeSingle();
  if(!entry){
    const x=await ops.from("commercial_followup_entries").insert({followup_day_id:day.id,broker_id:brokerId,status:"AGUARDANDO"}).select("*").single();
    if(x.error||!x.data)throw new Error(x.error?.message||"entry_create_failed");
    entry=x.data;
  }
  return {day,entry};
}

function canEditBroker(access:Row,brokerId:string){
  if(access.role==="BROKER")return access.broker?.id===brokerId;
  return ["OWNER","MANAGER","MGMT","CS"].includes(access.role);
}
async function saveMetrics(ops:any,access:Row,body:Row){
  const client=access.client, brokerId=String(body.broker_id||access.broker?.id||"");
  if(!brokerId||!canEditBroker(access,brokerId))throw new Error("forbidden_broker");
  const {data:broker}=await ops.from("commercial_followup_brokers").select("*").eq("id",brokerId).eq("followup_client_id",client.id).maybeSingle();
  if(!broker)throw new Error("broker_not_found");
  let reportDate=String(body.report_date||reportReferenceDate()).slice(0,10);
  if(access.kind==="MAGIC"&&access.link?.report_date)reportDate=String(access.link.report_date);
  const {day,entry}=await ensureEntry(ops,client,brokerId,reportDate);
  const allowed=(Array.isArray(client.questions)?client.questions:[]).filter((k:string)=>k!=="notes");
  const incoming:Row={};
  for(const k of allowed){if(body.metrics?.[k]!==undefined&&body.metrics?.[k]!==null&&body.metrics?.[k]!==""){const n=Number(body.metrics[k]);if(Number.isFinite(n)&&n>=0)incoming[k]=n;}}
  const metrics={...(entry.metrics||{}),...incoming},provenance={...(entry.provenance||{})};
  const source=access.role==="BROKER"?"PORTAL_CORRETOR":"PORTAL_GESTAO";
  const now=new Date().toISOString();
  for(const k of Object.keys(incoming))provenance[k]={source,actor:access.actor,at:now};
  const complete=allowed.length>0&&allowed.every((k:string)=>metrics[k]!==undefined&&metrics[k]!==null);
  const notes=body.notes!==undefined?String(body.notes||"").trim()||null:entry.notes;
  const {data:saved,error}=await ops.from("commercial_followup_entries").update({metrics,provenance,anomalies:anomalies(metrics),notes,status:complete?"RESPONDIDO":"PARCIAL",first_response_at:entry.first_response_at||now,responded_at:complete?now:entry.responded_at,updated_at:now}).eq("id",entry.id).select("*").single();
  if(error)throw new Error(error.message);
  await ops.from("commercial_followup_events").insert({followup_client_id:client.id,followup_day_id:day.id,broker_id:brokerId,event_type:complete?"PORTAL_REPORT_SUBMITTED":"PORTAL_REPORT_SAVED_PARTIAL",actor:access.actor,payload:{source,metrics:incoming,notes:body.notes!==undefined}});
  return {day,entry:saved,complete};
}

async function justifyEntry(ops:any,access:Row,body:Row){
  if(!["OWNER","MANAGER","MGMT","CS"].includes(access.role))throw new Error("forbidden");
  const entryId=String(body.entry_id||""),notes=String(body.notes||"").trim();
  if(!entryId||!notes)throw new Error("entry_and_notes_required");
  const {data:entry}=await ops.from("commercial_followup_entries").select("*,commercial_followup_days(followup_client_id)").eq("id",entryId).maybeSingle();
  const d=Array.isArray(entry?.commercial_followup_days)?entry.commercial_followup_days[0]:entry?.commercial_followup_days;
  if(!entry||d?.followup_client_id!==access.client.id)throw new Error("entry_not_found");
  const {data:saved,error}=await ops.from("commercial_followup_entries").update({status:"JUSTIFICADO",notes,updated_at:new Date().toISOString()}).eq("id",entryId).select("*").single();
  if(error)throw new Error(error.message);
  return saved;
}
async function pauseBroker(ops:any,access:Row,body:Row){
  if(!["OWNER","MANAGER","MGMT","CS"].includes(access.role))throw new Error("forbidden");
  const brokerId=String(body.broker_id||"");if(!brokerId)throw new Error("broker_required");
  const {data:broker}=await ops.from("commercial_followup_brokers").select("*").eq("id",brokerId).eq("followup_client_id",access.client.id).maybeSingle();
  if(!broker)throw new Error("broker_not_found");
  const pausedUntil=body.paused_until?new Date(body.paused_until).toISOString():null;
  const reason=pausedUntil?String(body.pause_reason||"").trim()||"Pausa operacional":null;
  const {data:saved,error}=await ops.from("commercial_followup_brokers").update({paused_until:pausedUntil,pause_reason:reason,updated_at:new Date().toISOString()}).eq("id",brokerId).select("*").single();
  if(error)throw new Error(error.message);
  await ops.from("commercial_followup_events").insert({followup_client_id:access.client.id,broker_id:brokerId,event_type:pausedUntil?"PORTAL_BROKER_PAUSED":"PORTAL_BROKER_REACTIVATED",actor:access.actor,payload:{paused_until:pausedUntil,reason}});
  return saved;
}

Deno.serve(async(req)=>{
  const origin=req.headers.get("origin");
  if(req.method==="OPTIONS")return json({ok:true},200,origin);
  if(origin&&!allowedOrigin(origin))return json({error:"origin_not_allowed"},403,origin);
  const sbUrl=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!sbUrl||!anon||!service)return json({error:"server_configuration"},500,origin);
  const db=createClient(sbUrl,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const access=await resolveAccess(req,ops,anon,service);
  if(!access)return json({error:"unauthorized"},401,origin);
  if(req.method==="GET"){
    const payload=await portalPayload(ops,access);
    if((payload as Row).error)return json({error:(payload as Row).error},Number((payload as Row).status||400),origin);
    return json(payload,200,origin);
  }
  if(req.method!=="POST")return json({error:"method_not_allowed"},405,origin);
  const body=await req.json().catch(()=>({})),action=String(body.action||"");
  try{
    if(action==="parse_text")return json({ok:true,...parseMetrics(String(body.text||""))},200,origin);
    if(action==="save_metrics")return json({ok:true,...await saveMetrics(ops,access,body)},200,origin);
    if(action==="justify_entry")return json({ok:true,entry:await justifyEntry(ops,access,body)},200,origin);
    if(action==="pause_broker")return json({ok:true,broker:await pauseBroker(ops,access,body)},200,origin);
    return json({error:"unknown_action"},400,origin);
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    const status=message.startsWith("forbidden")?403:message.includes("not_found")?404:400;
    return json({error:message},status,origin);
  }
});
