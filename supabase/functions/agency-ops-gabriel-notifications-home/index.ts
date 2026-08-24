import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(value:unknown)=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
function isAiServiceEvent(row:any){
  if(!row||typeof row!=="object")return false;
  const meta=row.metadata&&typeof row.metadata==="object"?row.metadata:{};
  const strongAiOrigin=meta.ai_workspace===true||meta.n8n_verified===true||meta.created_inside_ai_work_center===true;
  const combined=norm([
    row.type,row.source,row.title,row.description,row.next_action,row.owner,row.actor,
    meta.service,meta.product,meta.category,meta.workspace,meta.source,meta.type,meta.title,meta.description,meta.next_action
  ].filter(Boolean).join(" "));
  const explicitTech=/\bn8n\b|agente de ia|agente virtual|chatbot|bot de atendimento|assistente virtual|\bllm\b|openai|prompt|webhook|fluxo de atendimento|integracao com whatsapp|whatsapp integrado|donnah/.test(combined);
  const explicitAi=/\bia\b|inteligencia artificial/.test(combined);
  const automationContext=/\bautomacao\b/.test(combined)&&/(n8n|\bia\b|inteligencia artificial|agente|chatbot|bot|assistente virtual|webhook|whatsapp|lead|atendimento|donnah)/.test(combined);
  const trafficOrMedia=/campanha|campaign|meta ads|google ads|trafego|gestor de trafego|anuncio|ads\b|criativo|creative|cpl\b|cpm\b|ctr\b|cpc\b|orcamento de midia|saldo de conta|saldo meta|conta de anuncio|conjunto de anuncio|adset/.test(combined);
  if(strongAiOrigin)return true;
  if(trafficOrMedia&&!(explicitTech||automationContext))return false;
  return explicitTech||explicitAi||automationContext;
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return json({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",auth=req.headers.get("Authorization")||"";
  if(!url||!anon||!service)return json({ok:false,error:"SERVER_CONFIGURATION"},500);
  if(!auth.startsWith("Bearer "))return json({ok:false,error:"UNAUTHORIZED"},401);
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:authData,error:authError}=await userClient.auth.getUser();
  if(authError||!authData?.user)return json({ok:false,error:"UNAUTHORIZED"},401);
  const user=authData.user;
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=admin.schema("agency_ops");
  const [{data:pref},{data:approval},{data:aiRows}]=await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key",user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1),
    ops.rpc("ai_ours_active_client_ids")
  ]);
  if(pref?.collaborator_person!=="Gabriel Castro"||!(approval||[]).length)return json({ok:false,error:"FORBIDDEN"},403);
  const allowedIds=(aiRows||[]).map((r:any)=>String(r.client_id)).filter(Boolean);
  const allowedSet=new Set(allowedIds);
  if(!allowedIds.length)return json({ok:true,role:"AI",person:"Gabriel Castro",scope:"AI_SERVICE_STRICT_ONLY_NO_COMMERCIAL_GROUPS",items:[],generated_at:new Date().toISOString()});

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
    const sourceText=[row.source,meta.source].filter(Boolean).join(" ");for(const chat of commercialChatIds)if(sourceText.includes(chat))return true;
    return false;
  };

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const action=String(body?.action||"").toUpperCase(),notificationId=String(body?.notification_id||"").trim();
    if(action!=="RESOLVE"||!notificationId)return json({ok:false,error:"INVALID_ACTION"},400);
    const {data:n}=await ops.from("platform_notifications").select("id,client_id,type,level,title,description,source,actor,metadata").eq("id",notificationId).maybeSingle();
    if(!n||!n.client_id||!allowedSet.has(String(n.client_id))||isCommercialOrigin(n)||!isAiServiceEvent(n))return json({ok:false,error:"FORBIDDEN"},403);
    const resolvedAt=new Date().toISOString();
    const [{error:e1},{error:e2}]=await Promise.all([
      ops.from("platform_notification_resolutions").upsert({notification_id:notificationId,user_key:user.id,resolved_at:resolvedAt,resolved_by:"Gabriel Castro",resolution_note:body?.note?String(body.note).slice(0,1000):null},{onConflict:"notification_id,user_key"}),
      ops.from("platform_notification_reads").upsert({notification_id:notificationId,user_key:user.id,read_at:resolvedAt},{onConflict:"notification_id,user_key"})
    ]);
    if(e1||e2)return json({ok:false,error:e1?.message||e2?.message},500);
    return json({ok:true,notification_id:notificationId,status:"RESOLVED",resolved_at:resolvedAt,resolved_by:"Gabriel Castro"});
  }

  const [{data:clients},{data:notifs},{data:alerts},{data:reads},{data:resolutions}]=await Promise.all([
    ops.from("clients").select("id,display_name").in("id",allowedIds),
    ops.from("platform_notifications").select("id,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata").in("client_id",allowedIds).order("occurred_at",{ascending:false}).limit(300),
    ops.from("operational_alerts").select("id,client_id,type,severity,source,source_id,owner,title,description,next_action,status,first_detected_at,last_detected_at,resolved_at,metadata").in("client_id",allowedIds).order("last_detected_at",{ascending:false}).limit(300),
    ops.from("platform_notification_reads").select("notification_id,read_at").eq("user_key",user.id),
    ops.from("platform_notification_resolutions").select("notification_id,resolved_at,resolved_by,resolution_note").eq("user_key",user.id)
  ]);
  const clientMap=new Map((clients||[]).map((r:any)=>[String(r.id),r.display_name]));
  const readMap=new Map((reads||[]).map((r:any)=>[String(r.notification_id),r.read_at]));
  const resolutionMap=new Map((resolutions||[]).map((r:any)=>[String(r.notification_id),r]));
  const notifItems=(notifs||[]).filter((r:any)=>!isCommercialOrigin(r)&&isAiServiceEvent(r)).filter((r:any)=>{
    const tp=String(r?.metadata?.target_person||"").trim();const tr=String(r?.metadata?.target_role||"").trim().toUpperCase();
    if(tp&&tp!=="Gabriel Castro")return false;if(tr&&tr!=="AI")return false;return true;
  }).map((r:any)=>{const readAt=readMap.get(String(r.id))||r.read_at||null;const resolution:any=resolutionMap.get(String(r.id));return {...r,kind:"NOTIFICATION",read_at:readAt,resolved_at:resolution?.resolved_at||null,resolved_by:resolution?.resolved_by||null,resolution_note:resolution?.resolution_note||null,status:resolution?"RESOLVED":(readAt?"READ":"OPEN"),client_name:clientMap.get(String(r.client_id))||null,source_label:r.source||"IA"};});
  const alertItems=(alerts||[]).filter((r:any)=>!isCommercialOrigin(r)&&isAiServiceEvent(r)).map((r:any)=>({...r,kind:"ALERT",id:String(r.id),level:r.severity,occurred_at:r.last_detected_at||r.first_detected_at,read_at:null,client_name:clientMap.get(String(r.client_id))||null,source_label:r.source||"IA"}));
  const items=[...notifItems,...alertItems].sort((a:any,b:any)=>new Date(b.occurred_at||0).getTime()-new Date(a.occurred_at||0).getTime()).slice(0,400);
  return json({ok:true,role:"AI",person:"Gabriel Castro",scope:"AI_SERVICE_STRICT_ONLY_NO_COMMERCIAL_GROUPS",commercial_groups_excluded:true,notifications_ai_service_only:true,items,generated_at:new Date().toISOString()});
});
