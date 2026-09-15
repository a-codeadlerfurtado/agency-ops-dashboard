import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const time=(v:unknown)=>v?new Date(String(v)).getTime():NaN;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const authHeader=req.headers.get("Authorization")||"";if(!url||!anon||!service)return reply({error:"server_configuration"},500);if(!authHeader.startsWith("Bearer "))return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});const{data:userData,error:authError}=await auth.auth.getUser();if(authError||!userData?.user?.id)return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const[{data:pref},{data:signup}]=await Promise.all([ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)]);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();if(!person||!(signup||[]).length)return reply({error:"profile_locked"},403);
  const{data:roster}=await ops.from("team_roster").select("person,role,is_former").eq("person",person).maybeSingle();if(!roster||roster.is_former)return reply({error:"forbidden"},403);
  if(person!=="Adler Furtado"&&!(person==="Leonardo Augusto"&&roster.role==="COMMERCIAL"))return reply({error:"forbidden"},403);

  const[clientsRes,campaignRes]=await Promise.all([
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("display_name"),
    ops.from("campaign_client_latest").select("client_id,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle",["ACTIVE","ONBOARDING"])
  ]);
  if(clientsRes.error||campaignRes.error)return reply({error:"query_failed",detail:clientsRes.error?.message||campaignRes.error?.message},500);
  const campaignByClient=new Map((campaignRes.data||[]).map((r:any)=>[String(r.client_id),r]));
  const clients=(clientsRes.data||[]).map((r:any)=>{const campaign:any=campaignByClient.get(String(r.id)),start=time(r.entrada),end=r.lifecycle==="CHURNED"&&r.saida?time(r.saida):Date.now();return{client_id:r.id,display_name:r.display_name,lifecycle:r.lifecycle,service:r.service,entrada:r.entrada,saida:r.saida,cs_owner:r.cs_owner,gt_owner:r.gt_owner,client_days:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.floor((end-start)/86400000)):null,campaign:campaign?{latest_date:campaign.latest_date,active_campaigns:campaign.active_campaigns,spend:campaign.spend,leads:campaign.leads,ctr:campaign.ctr,cost_per_result:campaign.cost_per_result}:null}});
  return reply({ok:true,profile:{person,role:roster.role,mode:"COMMERCIAL_CLIENTS_SAFE"},summary:{active:clients.filter((r:any)=>r.lifecycle==="ACTIVE").length,onboarding:clients.filter((r:any)=>r.lifecycle==="ONBOARDING").length,churned:clients.filter((r:any)=>r.lifecycle==="CHURNED").length,total:clients.length},clients,generated_at:new Date().toISOString()});
});
