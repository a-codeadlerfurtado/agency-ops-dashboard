import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
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
  if(req.method!=="GET")return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const auth=req.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const ac=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const {data:ud}=await ac.auth.getUser();
  if(!ud?.user)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const [{data:pref},{data:approval},{data:aiRows}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key",ud.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",ud.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1),
    ops.rpc("ai_ours_active_client_ids")
  ]);
  if(pref?.collaborator_person!=="Gabriel Castro"||!(approval||[]).length)return reply({error:"forbidden"},403);

  const incoming=new URL(req.url);
  const clientName=(incoming.searchParams.get("client_name")||"").trim();
  const clientId=(incoming.searchParams.get("client_id")||"").trim();
  if(!clientName&&!clientId)return reply({error:"client_required"},400);
  const clientQuery=ops.from("clients").select("id,display_name");
  const {data:client}=clientId?await clientQuery.eq("id",clientId).maybeSingle():await clientQuery.eq("display_name",clientName).maybeSingle();
  const allowed=new Set((aiRows||[]).map((r:any)=>String(r.client_id)));
  if(!client||!allowed.has(String(client.id)))return reply({error:"not_found_or_forbidden"},404);

  const {data:groups}=await ops.from("whatsapp_group_registry").select("chat_id,chat_name").eq("group_kind","COMERCIAL");
  const commercialChatIds=new Set((groups||[]).map((r:any)=>String(r.chat_id||"")).filter(Boolean));
  const commercialChatNames=new Set((groups||[]).map((r:any)=>String(r.chat_name||"").trim().toLowerCase()).filter(Boolean));
  const commercialMessageRefs=new Set<string>();
  if(commercialChatIds.size){
    const {data:messages}=await ops.from("whatsapp_messages").select("id,message_id,chat_id").in("chat_id",[...commercialChatIds]);
    for(const row of messages||[]){if(row.id!=null)commercialMessageRefs.add(String(row.id));if(row.message_id)commercialMessageRefs.add(String(row.message_id));}
  }
  const isCommercialOrigin=(row:any)=>{
    if(!row||typeof row!=="object")return false;
    const meta=row.metadata&&typeof row.metadata==="object"?row.metadata:{};
    if(String(row.group_kind??meta.group_kind??"").toUpperCase()==="COMERCIAL")return true;
    const chats=[row.chat_id,row.whatsapp_chat_id,row.source_chat_id,meta.chat_id,meta.whatsapp_chat_id,meta.source_chat_id];
    if(chats.some(v=>v&&commercialChatIds.has(String(v))))return true;
    const names=[row.chat_name,row.group_name,row.source_group_name,meta.chat_name,meta.group_name,meta.source_group_name];
    if(names.some(v=>v&&commercialChatNames.has(String(v).trim().toLowerCase())))return true;
    const refs=[row.message_id,row.last_message_id,row.source_message_id,row.source_whatsapp_message_id,row.source_id,row.origem_ref,meta.message_id,meta.last_message_id,meta.source_message_id,meta.source_whatsapp_message_id,meta.source_id,meta.origem_ref];
    if(refs.some(v=>v!=null&&commercialMessageRefs.has(String(v))))return true;
    const sourceText=[row.source,meta.source].filter(Boolean).join(" ");
    for(const chat of commercialChatIds)if(sourceText.includes(chat))return true;
    return false;
  };

  const target=new URL(`${url}/functions/v1/agency-ops-client-notifications`);target.search=incoming.search;
  const response=await fetch(target,{headers:{Authorization:auth,apikey:anon},cache:"no-store"});
  const contentType=response.headers.get("content-type")||"";
  if(!response.ok||!contentType.includes("application/json"))return new Response(response.body,{status:response.status,headers:{...CORS,"content-type":contentType||"application/json","cache-control":"no-store"}});
  const body:any=await response.json();
  const items=(body.items||[]).filter((r:any)=>!isCommercialOrigin(r)&&isAiServiceEvent(r));
  const unread=items.filter((r:any)=>r.kind==="NOTIFICATION"&&!r.read_at).length;
  const openAlerts=items.filter((r:any)=>r.kind==="ALERT"&&String(r.status).toUpperCase()!=="RESOLVED");
  const criticalOpen=openAlerts.filter((r:any)=>["CRITICAL","HIGH"].includes(String(r.level).toUpperCase())).length;
  return reply({...body,scope:"AI_SERVICE_STRICT_ONLY_NO_COMMERCIAL_GROUPS",items,summary:{...(body.summary||{}),unread,open_alerts:openAlerts.length,critical_open:criticalOpen,resolved_alerts:items.filter((r:any)=>r.kind==="ALERT").length-openAlerts.length,total:items.length},commercial_groups_excluded:true,notifications_ai_service_only:true,generated_at:new Date().toISOString()});
});
