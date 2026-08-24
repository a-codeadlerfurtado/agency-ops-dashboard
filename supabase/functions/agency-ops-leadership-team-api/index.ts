import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const ALLOWED=new Set(["Adler Furtado","Leonardo Augusto"]);
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});if(req.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
 const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",ah=req.headers.get("Authorization")||"";
 if(!url||!anon||!service||!ah.startsWith("Bearer "))return json({ok:false,error:"unauthorized"},401);
 const auth=createClient(url,anon,{global:{headers:{Authorization:ah}},auth:{persistSession:false,autoRefreshToken:false}});const {data:u}=await auth.auth.getUser();if(!u?.user)return json({ok:false,error:"unauthorized"},401);
 const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
 const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",u.user.id).maybeSingle();const person=String(pref?.collaborator_person||"").trim();if(!ALLOWED.has(person))return json({ok:false,error:"forbidden"},403);
 const [teamRes,clientsRes,walletsRes,rosterRes]=await Promise.all([
  ops.from("team_overview").select("*").order("role_order").order("tasks_done",{ascending:false}),
  ops.from("dashboard_client_overview").select("client_id,display_name,lifecycle,priority,next_step,data_coverage,gt_owner,entrada,client_days").limit(500),
  ops.from("wallet_overview").select("*").order("ordem"),
  ops.from("team_roster").select("person,role,access_level").eq("is_former",false)
 ]);
 if(teamRes.error||clientsRes.error||walletsRes.error||rosterRes.error)return json({ok:false,error:"query_failed"},500);
 const clients=clientsRes.data||[],wallets=walletsRes.data||[],access=new Map((rosterRes.data||[]).map((r:any)=>[String(r.person),r.access_level]));const walletByOwner=new Map(wallets.map((r:any)=>[String(r.gt_owner),r.carteira]));
 const team=(teamRes.data||[]).map((m:any)=>({...m,access_level:access.get(String(m.person))||null,carteira:m.role==="GT"?(walletByOwner.get(String(m.person))||null):null,portfolio:m.role==="GT"?clients.filter((c:any)=>c.gt_owner===m.person&&["ACTIVE","ONBOARDING"].includes(String(c.lifecycle))).map((c:any)=>({client_id:c.client_id,display_name:c.display_name,priority:c.priority,lifecycle:c.lifecycle,next_step:c.next_step,data_coverage:c.data_coverage})):[]}));
 const unassigned=clients.filter((c:any)=>["ACTIVE","ONBOARDING"].includes(String(c.lifecycle))&&!String(c.gt_owner||"").trim()).sort((a:any,b:any)=>String(a.display_name).localeCompare(String(b.display_name),"pt-BR"));
 return json({ok:true,person,team,unassigned_clients:unassigned,wallets,summary:{team_members:team.filter((r:any)=>r.in_roster&&!r.is_former).length,unassigned_clients:unassigned.length},generated_at:new Date().toISOString()});
});