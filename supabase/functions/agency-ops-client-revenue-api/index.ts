import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const ALLOWED=new Set(["Adler Furtado"]);
const num=(v:unknown)=>v===null||v===undefined||v===""?null:Number(v);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method)) return json({ok:false,error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const authHeader=req.headers.get("Authorization")||"";
  if(!url||!anon||!service||!authHeader.startsWith("Bearer ")) return json({ok:false,error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData}=await auth.auth.getUser();
  if(!userData?.user) return json({ok:false,error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops"),crm=db.schema("crm");
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",userData.user.id).maybeSingle();
  const person=String(pref?.collaborator_person||"").trim();
  if(!ALLOWED.has(person)) return json({ok:false,error:"forbidden"},403);

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const clientId=String(body?.client_id||"").trim();
    if(!clientId) return json({ok:false,error:"client_required"},400);
    const {data:client}=await ops.from("clients").select("id,display_name").eq("id",clientId).maybeSingle();
    if(!client) return json({ok:false,error:"client_not_found"},404);
    const monthly=num(body.monthly_value),implementation=num(body.implementation_value),term=num(body.term_months);
    if((monthly!==null&&!Number.isFinite(monthly))||(implementation!==null&&!Number.isFinite(implementation))||(term!==null&&!Number.isFinite(term))) return json({ok:false,error:"invalid_number"},400);
    if((monthly??0)<0||(implementation??0)<0||(term??0)<0) return json({ok:false,error:"negative_value"},400);
    const patch={
      client_id:clientId,
      monthly_value:monthly,
      implementation_value:implementation,
      term_months:term===null?null:Math.round(term),
      implementation_payment:body.implementation_payment?String(body.implementation_payment).slice(0,120):null,
      implementation_installments:Array.isArray(body.implementation_installments)?body.implementation_installments.map((x:unknown)=>Number(x)).filter((x:number)=>Number.isFinite(x)&&x>=0):null,
      notes:body.notes?String(body.notes).slice(0,2000):null,
      source:"MANUAL",
      source_crm_lead_id:null,
      updated_by:person,
      updated_at:new Date().toISOString(),
    };
    const {data,error}=await ops.from("client_commercial_terms").upsert(patch,{onConflict:"client_id"}).select().single();
    if(error) return json({ok:false,error:"save_failed"},500);
    return json({ok:true,term:data});
  }

  const [clientsRes,termsRes]=await Promise.all([
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,cs_owner,gt_owner,crm_lead_id").order("display_name"),
    ops.from("client_commercial_terms").select("*")
  ]);
  if(clientsRes.error||termsRes.error) return json({ok:false,error:"query_failed"},500);
  const clients=clientsRes.data||[],terms=termsRes.data||[];
  const crmIds=[...new Set(clients.map((c:any)=>c.crm_lead_id).filter(Boolean).map(String))];
  let crmRows:any[]=[];
  if(crmIds.length){const r=await crm.from("leads").select("id,name,company,stage,closed_at,closed_monthly_value,closed_setup_value,closed_term_months,closed_setup_payment,closed_setup_installment_values").in("id",crmIds);if(!r.error)crmRows=r.data||[];}
  const termMap=new Map(terms.map((r:any)=>[String(r.client_id),r]));
  const crmMap=new Map(crmRows.map((r:any)=>[String(r.id),r]));
  const rows=clients.map((c:any)=>{
    const manual:any=termMap.get(String(c.id))||null;
    const lead:any=c.crm_lead_id?crmMap.get(String(c.crm_lead_id))||null:null;
    const crmMonthly=lead?.closed_monthly_value==null?null:Number(lead.closed_monthly_value);
    const crmImplementation=lead?.closed_setup_value==null?null:Number(lead.closed_setup_value);
    const monthly=manual?.monthly_value!=null?Number(manual.monthly_value):crmMonthly;
    const implementation=manual?.implementation_value!=null?Number(manual.implementation_value):crmImplementation;
    const source=manual?"MANUAL":(crmMonthly!=null||crmImplementation!=null?"CRM_VINCULADO":"NAO_INFORMADO");
    return {
      client_id:c.id,display_name:c.display_name,lifecycle:c.lifecycle,service:c.service,entrada:c.entrada,cs_owner:c.cs_owner,gt_owner:c.gt_owner,crm_lead_id:c.crm_lead_id,
      monthly_value:monthly,implementation_value:implementation,
      term_months:manual?.term_months??lead?.closed_term_months??null,
      implementation_payment:manual?.implementation_payment??lead?.closed_setup_payment??null,
      implementation_installments:manual?.implementation_installments??lead?.closed_setup_installment_values??null,
      notes:manual?.notes??null,source,updated_by:manual?.updated_by??null,updated_at:manual?.updated_at??lead?.closed_at??null,
      crm_stage:lead?.stage??null,crm_lead_name:lead?.name??null,
    };
  });
  const current=rows.filter((r:any)=>["ACTIVE","ONBOARDING"].includes(String(r.lifecycle)));
  const knownMonthly=current.filter((r:any)=>r.monthly_value!=null);
  const knownImplementation=current.filter((r:any)=>r.implementation_value!=null);
  return json({ok:true,person,can_edit:true,summary:{current_clients:current.length,known_monthly:knownMonthly.length,known_implementation:knownImplementation.length,mrr_known:knownMonthly.reduce((s:number,r:any)=>s+Number(r.monthly_value||0),0),implementation_known:knownImplementation.reduce((s:number,r:any)=>s+Number(r.implementation_value||0),0),missing_both:current.filter((r:any)=>r.monthly_value==null&&r.implementation_value==null).length},rows,generated_at:new Date().toISOString()});
});