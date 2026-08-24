import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();

function isAiDomainTask(name:unknown,listName:unknown){
 const title=norm(name), list=norm(listName), combined=`${title} ${list}`;
 const obviouslyOtherTeam=/criativ|design|arte|video|copy|campanh|trafego pago|gestor de trafego/.test(list)||/- criativ|- campanha|- ajuste na campanha/.test(title);
 if(/\bagente\b|\bn8n\b|chatbot|bot de atendimento|automacao|webhook/.test(combined))return true;
 if(/\bia\b.{0,60}(lead|atendimento|agente|fluxo|whatsapp|automacao|integracao)|(?:lead|atendimento|agente|fluxo|whatsapp|automacao|integracao).{0,60}\bia\b/.test(combined))return true;
 return !obviouslyOtherTeam&&/(^| )ia( |$)/.test(combined);
}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
 if(req.method!=="GET")return reply({error:"method_not_allowed"},405);
 const url=Deno.env.get("SUPABASE_URL")!, anon=Deno.env.get("SUPABASE_ANON_KEY")!, service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const auth=req.headers.get("Authorization")??"";
 if(!auth.startsWith("Bearer "))return reply({error:"unauthorized"},401);
 const authClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});
 const {data:userData}=await authClient.auth.getUser(); const user=userData?.user;
 if(!user)return reply({error:"unauthorized"},401);
 const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}); const ops=db.schema("agency_ops");
 const [{data:pref},{data:approvals}]=await Promise.all([
   ops.from("user_preferences").select("collaborator_person").eq("user_key",user.id).maybeSingle(),
   ops.from("access_requests").select("id").eq("user_key",user.id).eq("kind","SIGNUP").eq("status","APPROVED")
 ]);
 const person=String(pref?.collaborator_person??""); if(!person||!(approvals??[]).length)return reply({error:"forbidden"},403);
 const {data:roster}=await ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle();
 if(!roster)return reply({error:"forbidden"},403);
 const isAdler=roster.person==="Adler Furtado", isGabriel=roster.person==="Gabriel Castro"&&roster.role==="AI";
 if(!isGabriel&&!isAdler)return reply({error:"forbidden"},403);

 const {data:services,error:serviceError}=await ops.from("client_services").select("client_id,service_status,agent_name,last_evidence_at,provider_current,owner_key,confidence").eq("service_key","IA").eq("owner_key","OURS").in("service_status",["ACTIVE","BUILDING"]);
 if(serviceError)return reply({error:"query_failed",detail:serviceError.message},500);
 const ids=(services??[]).map((r:any)=>r.client_id).filter(Boolean);
 if(!ids.length)return reply({profile:{person:roster.person,role:roster.role},summary:{total:0,n8n:0,building:0,attention:0,demands:0},agents:[],demands:[],generated_at:new Date().toISOString()});
 const [clientsRes,n8nRes,tasksRes,workRes]=await Promise.all([
   ops.from("clients").select("id,display_name,lifecycle,cs_owner,gt_owner").in("id",ids).in("lifecycle",["ACTIVE","ONBOARDING"]),
   ops.from("ai_source_registry").select("source_key,client_id,source_type,active,confidence,notes,updated_at").in("client_id",ids).eq("source_type","N8N_CHAT").eq("owner_hint","OURS").eq("active",true),
   ops.from("clickup_tasks").select("task_id,client_id,name,status,due_date,url,assignee_names,date_updated,list_name").in("client_id",ids).eq("is_closed",false).order("due_date",{ascending:true,nullsFirst:false}).limit(800),
   ops.from("work_items").select("id,client_id,title,description,status,priority,due_at,target_person,target_role,created_at,metadata").in("client_id",ids).in("status",["OPEN","IN_PROGRESS","WAITING","SNOOZED"]).limit(500)
 ]);
 const clients=clientsRes.data??[], n8n=n8nRes.data??[], tasks=tasksRes.data??[], work=workRes.data??[];
 const clientById=new Map(clients.map((c:any)=>[String(c.id),c]));
 const demands:any[]=[];
 for(const t of tasks){ if(!isAiDomainTask(t.name,t.list_name))continue; const client:any=clientById.get(String(t.client_id)); if(!client)continue; demands.push({id:`clickup:${t.task_id}`,source:"CLICKUP",client_id:t.client_id,display_name:client.display_name,title:t.name,status:t.status,priority:null,due_at:t.due_date,owner:t.assignee_names||null,url:t.url||null}); }
 for(const w of work){ if(!(w.target_role==="AI"||w.target_person==="Gabriel Castro"||w.metadata?.ai_workspace===true||isAiDomainTask(`${w.title} ${w.description??""}`,"")))continue; const client:any=clientById.get(String(w.client_id)); if(!client)continue; demands.push({id:`work:${w.id}`,source:"WORK",client_id:w.client_id,display_name:client.display_name,title:w.title,status:w.status,priority:w.priority,due_at:w.due_at,owner:w.target_person||w.target_role||null,url:w.metadata?.clickup_url??null}); }
 const byClientDemand=new Map<string,number>(); for(const d of demands)byClientDemand.set(String(d.client_id),(byClientDemand.get(String(d.client_id))??0)+1);
 const n8nByClient=new Map<string,any[]>(); for(const row of n8n){const k=String(row.client_id);n8nByClient.set(k,[...(n8nByClient.get(k)??[]),row]);}
 const serviceByClient=new Map((services??[]).map((s:any)=>[String(s.client_id),s]));
 const agents=clients.map((c:any)=>{const serviceRow:any=serviceByClient.get(String(c.id));const sources=n8nByClient.get(String(c.id))??[];const connected=sources.length>0;const state=serviceRow?.service_status==="BUILDING"?"BUILDING":connected?"ACTIVE":"MISSING_N8N";return {client_id:c.id,display_name:c.display_name,lifecycle:c.lifecycle,service_status:serviceRow?.service_status??null,state,n8n_connected:connected,n8n_sources:sources.length,agent_name:connected?(serviceRow?.agent_name??null):null,last_evidence_at:serviceRow?.last_evidence_at??null,confidence:serviceRow?.confidence??null,cs_owner:c.cs_owner??null,gt_owner:c.gt_owner??null,open_demands:byClientDemand.get(String(c.id))??0};}).sort((a:any,b:any)=>{const rank:any={MISSING_N8N:0,BUILDING:1,ACTIVE:2};return (rank[a.state]-rank[b.state])||String(a.display_name).localeCompare(String(b.display_name),"pt-BR")});
 return reply({profile:{person:roster.person,role:roster.role,access_level:roster.access_level},summary:{total:agents.length,n8n:agents.filter((a:any)=>a.n8n_connected).length,building:agents.filter((a:any)=>a.state==="BUILDING").length,attention:agents.filter((a:any)=>a.state==="MISSING_N8N").length,demands:demands.length},agents,demands:demands.sort((a,b)=>String(a.due_at??"9999").localeCompare(String(b.due_at??"9999"))).slice(0,100),generated_at:new Date().toISOString()});
});
