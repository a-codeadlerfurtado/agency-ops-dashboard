import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

type MissingExtra={question?:string;line?:number};

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method)) return respond({error:"method_not_allowed"},405);

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey=Deno.env.get("SUPABASE_ANON_KEY");
  if(!supabaseUrl||!serviceRole||!anonKey) return respond({error:"server_configuration"},500);

  const authHeader=req.headers.get("Authorization")??"";
  if(!authHeader.startsWith("Bearer ")) return respond({error:"unauthorized"},401);
  const authClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData}=await authClient.auth.getUser();
  if(!userData?.user) return respond({error:"unauthorized"},401);

  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const userKey=userData.user.id;

  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",userKey).maybeSingle();
  const person=pref?.collaborator_person??null;
  if(!person) return respond({eligible:false,incidents:[]});
  const {data:roster}=await ops.from("team_roster").select("role,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||roster.role!=="GT") return respond({eligible:false,person,incidents:[]});

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const incidentId=String(body?.incident_id??"").trim();
    const action=String(body?.action??"acknowledge").trim();
    if(!incidentId) return respond({error:"incident_id_required"},400);

    const {data:incident,error:incidentError}=await ops.from("lead_dispatch_quality_incidents")
      .select("id,target_gt,status,notification_id,occurrence_no,client_id,client_name,product_label,product_key,missing_required,missing_extra_questions")
      .eq("id",incidentId).maybeSingle();
    if(incidentError) return respond({error:"query_failed",detail:incidentError.message},500);
    if(!incident) return respond({error:"not_found"},404);
    if(incident.target_gt!==person) return respond({error:"forbidden"},403);

    if(action==="suppress_field"){
      const fieldKind=String(body?.field_kind??"").trim();
      const fieldLabel=String(body?.field_label??"").trim();
      if(!incident.client_id) return respond({error:"client_required_for_exemption"},400);
      if(!["required","extra"].includes(fieldKind)) return respond({error:"invalid_field_kind"},400);
      if(!fieldLabel) return respond({error:"field_label_required"},400);

      const required=Array.isArray(incident.missing_required)?incident.missing_required.map(String):[];
      const extras=Array.isArray(incident.missing_extra_questions)?incident.missing_extra_questions as MissingExtra[]:[];
      const belongsToIncident=fieldKind==="required"
        ? required.includes(fieldLabel)
        : extras.some((item)=>String(item?.question??"")===fieldLabel);
      if(!belongsToIncident) return respond({error:"field_not_in_incident"},400);

      const now=new Date().toISOString();
      const {error:exemptionError}=await ops.from("lead_dispatch_quality_field_exemptions").upsert({
        client_id:incident.client_id,
        product_key:incident.product_key,
        product_label:incident.product_label,
        field_kind:fieldKind,
        field_label:fieldLabel,
        reason:"CLIENT_REQUEST",
        active:true,
        created_by_user_key:userKey,
        created_by_person:person,
        updated_at:now,
      },{onConflict:"client_id,product_key,field_kind,field_label"});
      if(exemptionError) return respond({error:"exemption_failed",detail:exemptionError.message},500);

      const {data:related,error:relatedError}=await ops.from("lead_dispatch_quality_incidents")
        .select("id,notification_id,missing_required,missing_extra_questions")
        .eq("client_id",incident.client_id).eq("product_key",incident.product_key).eq("status","OPEN");
      if(relatedError) return respond({error:"related_query_failed",detail:relatedError.message},500);

      for(const row of related??[]){
        const nextRequired=(Array.isArray(row.missing_required)?row.missing_required.map(String):[])
          .filter((field)=>!(fieldKind==="required"&&field===fieldLabel));
        const nextExtras=(Array.isArray(row.missing_extra_questions)?row.missing_extra_questions as MissingExtra[]:[])
          .filter((item)=>!(fieldKind==="extra"&&String(item?.question??"")===fieldLabel));
        const resolved=nextRequired.length===0&&nextExtras.length===0;
        const patch:Record<string,unknown>={
          missing_required:nextRequired,
          missing_extra_questions:nextExtras,
          updated_at:now,
        };
        if(resolved){
          patch.status="RESOLVED";
          patch.resolved_at=now;
        }
        await ops.from("lead_dispatch_quality_incidents").update(patch).eq("id",row.id);
        if(resolved&&row.notification_id){
          await ops.from("platform_notification_reads").upsert({notification_id:row.notification_id,user_key:userKey,read_at:now},{onConflict:"notification_id,user_key"});
        }
      }

      return respond({
        ok:true,
        exemption_saved:true,
        incident_id:incidentId,
        client_id:incident.client_id,
        product_key:incident.product_key,
        field_kind:fieldKind,
        field_label:fieldLabel,
        person,
      });
    }

    if(action!=="acknowledge") return respond({error:"invalid_action"},400);

    if(incident.status==="OPEN"){
      const {error:updateError}=await ops.from("lead_dispatch_quality_incidents").update({
        status:"ACKNOWLEDGED",
        acknowledged_by_user_key:userKey,
        acknowledged_by_person:person,
        acknowledged_at:new Date().toISOString(),
        updated_at:new Date().toISOString(),
      }).eq("id",incidentId).eq("status","OPEN");
      if(updateError) return respond({error:"ack_failed",detail:updateError.message},500);
    }
    if(incident.notification_id){
      await ops.from("platform_notification_reads").upsert({notification_id:incident.notification_id,user_key:userKey,read_at:new Date().toISOString()},{onConflict:"notification_id,user_key"});
    }
    return respond({ok:true,acknowledged:true,incident_id:incidentId,person});
  }

  const {data:incidents,error}=await ops.from("lead_dispatch_quality_incidents")
    .select("id,message_id,client_id,client_name,target_gt,product_label,missing_required,missing_extra_questions,occurrence_no,severity,status,raw_text,created_at")
    .eq("target_gt",person).eq("status","OPEN")
    .order("occurrence_no",{ascending:false}).order("created_at",{ascending:true}).limit(50);
  if(error) return respond({error:"query_failed",detail:error.message},500);
  return respond({eligible:true,person,incidents:incidents??[],generated_at:new Date().toISOString()});
});
