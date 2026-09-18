import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin":"*",
  "access-control-allow-headers":"authorization,apikey,content-type",
  "access-control-allow-methods":"GET,OPTIONS"
};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const clean=(v:unknown)=>String(v??"").trim();

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET") return reply({error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"";
  const anon=Deno.env.get("SUPABASE_ANON_KEY")||"";
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service) return reply({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer ")) return reply({error:"unauthorized"},401);
  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:userData,error:authError}=await auth.auth.getUser();
  if(authError||!userData?.user?.id) return reply({error:"unauthorized"},401);
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const crm=db.schema("crm");

  const [{data:pref},{data:approval}] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)
  ]);
  const person=clean(pref?.collaborator_person||pref?.name);
  if(!person||(approval||[]).length===0) return reply({error:"profile_locked"},403);
  const {data:roster}=await ops.from("team_roster")
    .select("person,role,access_level,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||String(roster.role).toUpperCase()!=="SDR") return reply({error:"forbidden"},403);

  const [sessionRes,transcriptRes,callRes]=await Promise.all([
    ops.from("meeting_capture_sessions")
      .select("id,local_session_id,title,started_at,ended_at,state,capture_mode,transcript_id,metadata,created_at")
      .eq("owner_person",person).order("started_at",{ascending:false}).limit(500),
    ops.from("meeting_transcripts")
      .select("id,source_url,meeting_started_at,meeting_ended_at,duration_seconds,participants,summary,decisions,commitments,ai_signals,metadata,created_at,owner_person")
      .eq("owner_person",person).order("meeting_started_at",{ascending:false}).limit(500),
    ops.from("commercial_call_records")
      .select("id,lead_id,transcript_id,channel,remote_phone,remote_name,outcome,notes,next_step,next_step_at,metadata,created_at")
      .eq("sdr_person",person).order("created_at",{ascending:false}).limit(500)
  ]);
  const failed=[sessionRes,transcriptRes,callRes].find((r:any)=>r?.error);
  if(failed?.error) return reply({error:"query_failed",detail:failed.error.message},500);

  const calls=(callRes.data||[]) as Row[];
  const leadIds=[...new Set(calls.map(r=>String(r.lead_id||"")).filter(Boolean))];
  let leadMap=new Map<string,Row>();
  if(leadIds.length){
    const {data:leadRows,error:leadError}=await crm.from("leads")
      .select("id,name,company,stage").in("id",leadIds);
    if(leadError) return reply({error:"lead_lookup_failed",detail:leadError.message},500);
    leadMap=new Map((leadRows||[]).map((r:Row)=>[String(r.id),r]));
  }

  const transcriptMap=new Map((transcriptRes.data||[]).map((r:Row)=>[String(r.id),r]));
  const enrichedCalls=calls.map((r:Row)=>{
    const lead:any=leadMap.get(String(r.lead_id))||null;
    const transcript:any=r.transcript_id?transcriptMap.get(String(r.transcript_id)):null;
    return {...r,prospect_name:lead?.company||lead?.name||r.remote_name||null,stage:lead?.stage||null,
      transcript_summary:transcript?.metadata?.donnah_summary||transcript?.summary||null,
      decisions:transcript?.decisions||[],commitments:transcript?.commitments||[],ai_signals:transcript?.ai_signals||{}};
  });
  const sessions=(sessionRes.data||[]).map((r:Row)=>({
    ...r,
    kind:String(r.capture_mode||"").toUpperCase().includes("WHATSAPP")?"CALL":"MEETING"
  }));
  const meetings=(transcriptRes.data||[]).map((r:Row)=>({
    id:r.id,
    title:r.metadata?.donnah_title||r.metadata?.tipo_reuniao||"Reunião",
    started_at:r.meeting_started_at,
    ended_at:r.meeting_ended_at,
    duration_seconds:r.duration_seconds,
    participants:Array.isArray(r.participants)?r.participants:[],
    summary:r.metadata?.donnah_summary||r.summary||null,
    decisions:r.decisions||[],
    commitments:r.commitments||[],
    ai_signals:r.ai_signals||{},
    source_url:r.source_url||null
  }));

  return reply({
    profile:{person,role:"SDR",display_role:"SDR",access_level:"OWN_ACTIVITY_ONLY"},
    summary:{meetings:meetings.length,calls:enrichedCalls.length},
    meetings,calls:enrichedCalls,sessions,
    generated_at:new Date().toISOString()
  });
});
