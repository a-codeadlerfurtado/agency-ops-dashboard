import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type,x-dashboard-key","access-control-allow-methods":"GET,POST,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(value:unknown)=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
function isAiServiceEvent(row:any){
  if(!row||typeof row!=="object")return false;
  const meta=row.metadata&&typeof row.metadata==="object"?row.metadata:{};
  const strongAiOrigin=meta.ai_workspace===true||meta.n8n_verified===true||meta.created_inside_ai_work_center===true;
  const subject=norm([
    row.type,row.source,row.title,row.next_action,
    meta.service,meta.product,meta.category,meta.workspace,meta.source,meta.type,meta.title,meta.next_action,
    meta.task_name,meta.list,meta.clickup_list_name
  ].filter(Boolean).join(" "));
  const detail=norm([row.description,meta.description].filter(Boolean).join(" "));
  const combined=`${subject} ${detail}`.trim();
  const explicitTech=/\bn8n\b|agente de ia|agente virtual|chatbot|bot de atendimento|assistente virtual|\bllm\b|openai|prompt/.test(subject);
  const explicitAi=/\bia\b|inteligencia artificial/.test(subject);
  const automationContext=/\bautomacao\b/.test(subject)&&/(n8n|\bia\b|inteligencia artificial|agente|chatbot|bot|assistente virtual|webhook|whatsapp|lead|atendimento)/.test(combined);
  const integrationContext=/(webhook|integracao com whatsapp|whatsapp integrado)/.test(subject)&&/(n8n|\bia\b|inteligencia artificial|agente|chatbot|bot|assistente virtual|automacao)/.test(combined);
  const trafficOrMedia=/campanha|campaign|meta ads|google ads|trafego|gestor de trafego|anuncio|ads\b|criativo|creative|cpl\b|cpm\b|ctr\b|cpc\b|orcamento de midia|saldo de conta|saldo meta|conta de anuncio|conjunto de anuncio|adset/.test(combined);
  if(strongAiOrigin)return true;
  if(trafficOrMedia&&!(explicitTech||automationContext||integrationContext))return false;
  return explicitTech||explicitAi||automationContext||integrationContext;
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return reply({error:"method_not_allowed"},405);

  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const anonKey=Deno.env.get("SUPABASE_ANON_KEY")||"";
  const serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const auth=req.headers.get("Authorization")||"";
  if(!supabaseUrl||!anonKey||!serviceRole)return reply({error:"server_configuration"},500);
  if(!auth.startsWith("Bearer "))return reply({error:"unauthorized"},401);

  const token=auth.replace(/^Bearer\s+/i,"").trim();
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const {data:userData,error:userError}=await db.auth.getUser(token);
  if(userError||!userData.user)return reply({error:"unauthorized"},401);
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",userData.user.id).maybeSingle();
  if(pref?.collaborator_person!=="Gabriel Castro")return reply({error:"forbidden"},403);

  const bodyText=req.method==="POST"?await req.text():"";
  const incoming=new URL(req.url);
  const upstream=new URL(`${supabaseUrl}/functions/v1/agency-ops-dashboard-scope`);
  upstream.search=incoming.search;
  const upstreamResponse=await fetch(upstream,{method:req.method,headers:{Authorization:auth,apikey:anonKey,...(bodyText?{"content-type":req.headers.get("content-type")||"application/json"}:{})},body:req.method==="POST"?bodyText:undefined});
  const contentType=upstreamResponse.headers.get("content-type")||"";
  if(!upstreamResponse.ok||!contentType.includes("application/json"))return new Response(upstreamResponse.body,{status:upstreamResponse.status,headers:{...CORS,"content-type":contentType||"application/json","cache-control":"no-store"}});
  const raw:any=await upstreamResponse.json();

  const {data:groups,error:groupError}=await ops.from("whatsapp_group_registry").select("chat_id,chat_name").eq("group_kind","COMERCIAL");
  if(groupError)return reply({error:"commercial_scope_failed",detail:groupError.message},500);
  const commercialChatIds=new Set((groups||[]).map((r:any)=>String(r.chat_id||"")).filter(Boolean));
  const commercialChatNames=new Set((groups||[]).map((r:any)=>String(r.chat_name||"").trim().toLowerCase()).filter(Boolean));
  const commercialMessageRefs=new Set<string>();
  if(commercialChatIds.size){
    const {data:messages,error:messageError}=await ops.from("whatsapp_messages").select("id,message_id,chat_id").in("chat_id",[...commercialChatIds]);
    if(messageError)return reply({error:"commercial_message_scope_failed",detail:messageError.message},500);
    for(const row of messages||[]){
      if(row.id!=null)commercialMessageRefs.add(String(row.id));
      if(row.message_id)commercialMessageRefs.add(String(row.message_id));
    }
  }

  const isCommercialOrigin=(row:any)=>{
    if(!row||typeof row!=="object")return false;
    const meta=row.metadata&&typeof row.metadata==="object"?row.metadata:{};
    const kind=String(row.group_kind??row.source_group_kind??meta.group_kind??meta.source_group_kind??"").toUpperCase();
    if(kind==="COMERCIAL")return true;
    const chatCandidates=[row.chat_id,row.whatsapp_chat_id,row.source_chat_id,row.group_chat_id,meta.chat_id,meta.whatsapp_chat_id,meta.source_chat_id,meta.group_chat_id];
    if(chatCandidates.some(v=>v&&commercialChatIds.has(String(v))))return true;
    const nameCandidates=[row.chat_name,row.group_name,row.source_group_name,meta.chat_name,meta.group_name,meta.source_group_name];
    if(nameCandidates.some(v=>v&&commercialChatNames.has(String(v).trim().toLowerCase())))return true;
    const messageCandidates=[row.message_id,row.last_message_id,row.source_message_id,row.source_whatsapp_message_id,row.source_id,row.origem_ref,meta.message_id,meta.last_message_id,meta.source_message_id,meta.source_whatsapp_message_id,meta.source_id,meta.origem_ref];
    if(messageCandidates.some(v=>v!=null&&commercialMessageRefs.has(String(v))))return true;
    const text=[row.source,row.origem,meta.source,meta.origin].filter(Boolean).join(" ");
    for(const chatId of commercialChatIds)if(text.includes(chatId))return true;
    return false;
  };

  const DROP=Symbol("drop");
  const scrub=(value:any):any=>{
    if(Array.isArray(value))return value.map(scrub).filter(v=>v!==DROP);
    if(!value||typeof value!=="object")return value;
    if(isCommercialOrigin(value))return DROP;
    const out:Record<string,any>={};
    for(const [key,child] of Object.entries(value)){
      const next=scrub(child);
      if(next!==DROP)out[key]=next;
    }
    return out;
  };
  let result:any=scrub(raw);
  if(result===DROP)return reply({error:"not_found_or_forbidden"},404);

  const view=incoming.searchParams.get("view")||"home";
  if(view==="home"){
    result.conversations=[];
    result.notifications=(result.notifications||[]).filter((r:any)=>!isCommercialOrigin(r)&&isAiServiceEvent(r));
    result.commitments=(result.commitments||[]).filter((r:any)=>!isCommercialOrigin(r));
    result.alerts=(result.alerts||[]).filter((r:any)=>!isCommercialOrigin(r)&&isAiServiceEvent(r));
    if(result.operations?.sla){
      for(const key of ["waiting_agency","waiting_client","overdue_commitments"]){
        result.operations.sla[key]=(result.operations.sla[key]||[]).filter((r:any)=>!isCommercialOrigin(r));
      }
    }
    const overdue=(result.commitments||[]).filter((r:any)=>r.due_at&&new Date(r.due_at).getTime()<Date.now());
    result.kpis={...(result.kpis||{}),overdue_commitments:overdue.length,open_alerts:(result.alerts||[]).length,critical_alerts:(result.alerts||[]).filter((r:any)=>["CRITICAL","HIGH"].includes(String(r.severity))).length,semantic_review:0};
    result.profile={...(result.profile||{}),scope_model:"AI_SERVICE_STRICT_ONLY_NO_COMMERCIAL_GROUPS",commercial_groups_excluded:true,notifications_ai_service_only:true};
  }
  if(view==="work"){
    result.items=(result.items||[]).filter((r:any)=>!isCommercialOrigin(r));
    const open=result.items.filter((r:any)=>!["COMPLETED","DISMISSED"].includes(String(r.status)));
    result.summary={...(result.summary||{}),open:open.length,critical:open.filter((r:any)=>r.priority==="CRITICAL").length,overdue:open.filter((r:any)=>r.due_at&&new Date(r.due_at).getTime()<Date.now()).length,waiting:open.filter((r:any)=>["WAITING","SNOOZED"].includes(String(r.status))).length};
    result.scope_model="AI_N8N_CLIENTS_AI_DEMANDS_NO_COMMERCIAL_GROUPS";
  }
  return reply(result);
});
