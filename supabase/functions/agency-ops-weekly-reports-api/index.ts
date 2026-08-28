import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row=Record<string,any>;
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization,apikey","access-control-allow-methods":"GET,POST,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const clean=(value:unknown,max=1600)=>String(value??"").trim().slice(0,max);
const shift=(day:string,delta:number)=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);};
const localDate=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
function narrative(value:any){const steps=Array.isArray(value?.next_steps)?value.next_steps.map((x:unknown)=>clean(x,500)).filter(Boolean).slice(0,6):[];return{headline:clean(value?.headline,500),body:clean(value?.body,2400),key_insight:clean(value?.key_insight,1200),next_steps:steps};}
function lastClosedWeek(){const today=localDate(),d=new Date(`${today}T12:00:00Z`),dow=d.getUTCDay(),back=dow===0?7:dow,end=shift(today,-back),start=shift(end,-6);return{start,end};}
function errorMessage(error:any){if(error instanceof Error)return clean(error.message)||"Falha inesperada.";if(typeof error==="string")return clean(error)||"Falha inesperada.";const message=clean(error?.message||error?.details||error?.hint);if(message)return message;try{return clean(JSON.stringify(error))||"Falha inesperada.";}catch{return"Falha inesperada.";}}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),anonKey=Deno.env.get("SUPABASE_ANON_KEY"),serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceRole)return json({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);
  const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}}});const{data:authData,error:authError}=await auth.auth.getUser();if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const{data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",authData.user.id).maybeSingle();const person=String(pref?.collaborator_person||"").trim();
  const{data:roster}=await ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle();const role=String(roster?.role||"").toUpperCase();if(!person||!roster||!["MGMT","GT"].includes(role))return json({error:"not_found"},404);
  const profile={person,role,scope:role==="GT"?"WALLET":"ALL"};const url=new URL(req.url);if(req.method==="GET"&&url.searchParams.get("probe")==="1")return json({ok:true,profile});
  try{
    if(req.method==="POST"){
      const body=await req.json().catch(()=>({})),action=String(body?.action||"generate").toLowerCase();
      if(action==="edit_narrative"){
        const reportId=clean(body?.report_id,80);if(!reportId)return json({error:"report_id_required"},400);
        let q=ops.from("weekly_client_reports").select("id,gt_owner,status,audit_status,snapshot,editorial_narrative").eq("id",reportId);if(role==="GT")q=q.eq("gt_owner",person);const{data:report,error}=await q.maybeSingle();if(error)throw error;if(!report)return json({error:"report_not_found"},404);
        const next=narrative(body?.narrative);if(!next.headline||!next.body||!next.key_insight)return json({error:"narrative_required_fields"},400);
        const before=report.editorial_narrative||report.snapshot?.narrative||null;const{error:historyError}=await ops.from("weekly_report_editorial_history").insert({report_id:reportId,editor:person,before_narrative:before,after_narrative:next});if(historyError)throw historyError;
        const{error:updateError}=await ops.from("weekly_client_reports").update({editorial_narrative:next,editorial_status:"EDITED",edited_by:person,edited_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",reportId);if(updateError)throw updateError;
        return json({ok:true,report_id:reportId,narrative:next,edited_by:person});
      }
      if(action==="mark_shared"){
        const reportId=clean(body?.report_id,80);let q=ops.from("weekly_client_reports").select("id,gt_owner,status,audit_status").eq("id",reportId);if(role==="GT")q=q.eq("gt_owner",person);const{data:report}=await q.maybeSingle();if(!report||report.status!=="READY"||report.audit_status!=="PASS")return json({error:"report_not_shareable"},409);await ops.from("weekly_client_reports").update({shared_at:new Date().toISOString()}).eq("id",reportId);return json({ok:true});
      }
      if(action==="snapshot"){
        if(role!=="MGMT")return json({error:"forbidden"},403);let runId=clean(body?.meta_run_id,80);if(!runId){const{data:runs,error}=await ops.from("meta_performance_runs").select("id").in("status",["COMPLETED","COMPLETED_WITH_ERRORS"]).order("snapshot_date",{ascending:false}).limit(1);if(error)throw error;runId=String(runs?.[0]?.id||"");}if(!runId)return json({error:"no_completed_meta_run"},404);const{data,error}=await ops.rpc("invoke_weekly_client_reports",{p_meta_run_id:runId});if(error)throw error;return json({ok:true,meta_run_id:runId,request_id:data});
      }
      const defaults=lastClosedWeek(),from=clean(body?.date_from||defaults.start,10),to=clean(body?.date_to||defaults.end,10);if(!DATE.test(from)||!DATE.test(to)||from>to)return json({error:"invalid_period",detail:"Período inválido."},400);if(to>localDate())return json({error:"future_period_not_allowed",detail:"A data final não pode ser futura."},400);
      let scope=String(body?.scope_type||"ALL").toUpperCase(),scopeValue=clean(body?.scope_value,120);if(!["ALL","GT","CLIENT"].includes(scope))return json({error:"invalid_scope"},400);
      if(role==="GT"){
        if(scope==="ALL"||scope==="GT"){scope="GT";scopeValue=person;}
        if(scope==="CLIENT"){const{data:client}=await ops.from("clients").select("id").eq("id",scopeValue).eq("lifecycle","ACTIVE").eq("gt_owner",person).maybeSingle();if(!client)return json({error:"client_not_in_wallet"},403);}
      }else if(scope==="GT"&&!scopeValue)return json({error:"gt_required"},400);else if(scope==="CLIENT"&&!scopeValue)return json({error:"client_required"},400);
      const{data,error}=await ops.rpc("invoke_weekly_client_reports_custom",{p_date_from:from,p_date_to:to,p_scope_type:scope,p_scope_value:scopeValue||null,p_requested_by:person});if(error)throw error;
      return json({ok:true,date_from:from,date_to:to,scope_type:scope,scope_value:scopeValue||null,request_id:data,partial_current_day:to===localDate()});
    }

    const requestedGt=clean(url.searchParams.get("gt"),120),selectedGt=role==="GT"?person:requestedGt;
    let clientsQ=ops.from("clients").select("id,display_name,gt_owner").eq("lifecycle","ACTIVE").order("display_name",{ascending:true});if(role==="GT")clientsQ=clientsQ.eq("gt_owner",person);const{data:clientRows,error:clientError}=await clientsQ.limit(500);if(clientError)throw clientError;
    const clients=(clientRows||[]).map((c:Row)=>({client_id:c.id,client_name:c.display_name,gt_owner:c.gt_owner}));
    let periodQ=ops.from("weekly_client_reports").select("period_start,period_end,report_kind,report_version,gt_owner").order("period_end",{ascending:false}).order("period_start",{ascending:false}).limit(1000);if(selectedGt)periodQ=periodQ.eq("gt_owner",selectedGt);const{data:periodRows,error:periodError}=await periodQ;if(periodError)throw periodError;
    const seen=new Set<string>(),periods:Row[]=[];for(const r of periodRows||[]){const key=`${r.period_start}:${r.period_end}:${r.report_kind}`;if(seen.has(key))continue;seen.add(key);periods.push({period_start:r.period_start,period_end:r.period_end,report_kind:r.report_kind});if(periods.length>=24)break;}
    const selectedStart=clean(url.searchParams.get("period_start")||periods[0]?.period_start,10),selectedEnd=clean(url.searchParams.get("period_end")||periods[0]?.period_end,10);
    if(!selectedStart||!selectedEnd)return json({profile,period:null,periods:[],clients,reports:[],summary:{ready:0,review:0,pending:0,error:0,total:0},gt_options:role==="MGMT"?[...new Set(clients.map((c:Row)=>c.gt_owner).filter(Boolean))]:[person],default_period:lastClosedWeek()});
    let q=ops.from("weekly_client_reports").select("id,client_id,client_name,gt_owner,period_start,period_end,week_start,week_end,report_kind,generation_source,report_version,public_token,status,audit_status,attempts,last_error,generated_at,snapshot,editorial_narrative,editorial_status,edited_by,edited_at,shared_at").eq("period_start",selectedStart).eq("period_end",selectedEnd).order("report_version",{ascending:false}).order("client_name",{ascending:true});if(selectedGt)q=q.eq("gt_owner",selectedGt);const{data:rawReports,error}=await q.limit(1000);if(error)throw error;
    const latest=new Map<string,Row>();for(const r of rawReports||[]){const id=String(r.client_id);if(!latest.has(id))latest.set(id,r);}const rows=[...latest.values()].map((r:Row)=>{const original=r.snapshot?.narrative||{},merged={...original,...(r.editorial_narrative||{})};return{id:r.id,client_id:r.client_id,client_name:r.client_name,gt_owner:r.gt_owner,period_start:r.period_start,period_end:r.period_end,report_kind:r.report_kind,generation_source:r.generation_source,report_version:r.report_version,status:r.status,audit_status:r.audit_status,attempts:r.attempts,last_error:r.last_error,generated_at:r.generated_at,editorial_status:r.editorial_status,edited_by:r.edited_by,edited_at:r.edited_at,shared_at:r.shared_at,public_path:r.status==="READY"&&r.audit_status==="PASS"?`/relatorio-semanal/${r.public_token}`:null,metrics:r.snapshot?.current||null,narrative:merged,original_narrative:original,creative_count:Array.isArray(r.snapshot?.creatives)?r.snapshot.creatives.length:0,audit:r.snapshot?.audit||null,partial_current_day:Boolean(r.snapshot?.partial_current_day||r.snapshot?.audit?.partial_current_day),data_locked:true};});
    const summary={ready:rows.filter((r:Row)=>r.status==="READY"&&r.audit_status==="PASS").length,review:rows.filter((r:Row)=>r.status==="REVIEW_REQUIRED"||r.audit_status==="FAIL").length,pending:rows.filter((r:Row)=>["PENDING","RUNNING"].includes(r.status)).length,error:rows.filter((r:Row)=>r.status==="ERROR").length,total:rows.length};
    const gtOptions=role==="MGMT"?[...new Set(clients.map((c:Row)=>String(c.gt_owner||"")).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR")):[person];
    return json({profile,selected_gt:selectedGt,gt_options:gtOptions,clients,period:{period_start:selectedStart,period_end:selectedEnd},periods,summary,reports:rows,default_period:lastClosedWeek(),generated_at:new Date().toISOString()});
  }catch(error){return json({error:"weekly_reports_api_failed",detail:errorMessage(error)},500);}
});
