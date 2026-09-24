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
const phoneDigits=(v:unknown)=>clean(v).replace(/\D/g,"");

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
  const requestUrl=new URL(req.url);

  const [{data:pref},{data:approval}] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key",userData.user.id).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)
  ]);
  const person=clean(pref?.collaborator_person||pref?.name);
  if(!person||(approval||[]).length===0) return reply({error:"profile_locked"},403);
  const {data:roster}=await ops.from("team_roster")
    .select("person,role,access_level,is_former").eq("person",person).maybeSingle();
  if(!roster||roster.is_former||String(roster.role).toUpperCase()!=="SDR") return reply({error:"forbidden"},403);

  const detailSessionId=clean(requestUrl.searchParams.get("session_id"));
  if(detailSessionId){
    const {data:sessionRow,error:sessionError}=await ops.from("meeting_capture_sessions")
      .select("id,owner_person,local_session_id,title,started_at,ended_at,state,capture_mode,transcript_id,metadata,audio_status,audio_source,audio_local_path,audio_remote_path,audio_mixed_path,audio_duration_ms,audio_size_bytes,audio_mime_type,audio_last_error,created_at,updated_at")
      .eq("id",detailSessionId).eq("owner_person",person).maybeSingle();
    if(sessionError) return reply({error:"detail_session_failed",detail:sessionError.message},500);
    if(!sessionRow||!String(sessionRow.capture_mode||"").toUpperCase().includes("WHATSAPP")) return reply({error:"call_not_found"},404);

    let transcript:Row|null=null;
    if(sessionRow.transcript_id){
      const {data,error}=await ops.from("meeting_transcripts")
        .select("id,meeting_started_at,meeting_ended_at,duration_seconds,transcript_text,transcript_chars,participants,summary,decisions,commitments,ai_signals,metadata,created_at")
        .eq("id",sessionRow.transcript_id).maybeSingle();
      if(error) return reply({error:"detail_transcript_failed",detail:error.message},500);
      transcript=data as Row|null;
    }
    const {data:segments,error:segmentError}=sessionRow.transcript_id
      ? await ops.from("meeting_transcript_segments")
          .select("sequence_no,started_ms,ended_ms,speaker_key,speaker_name,text,confidence,source")
          .eq("transcript_id",sessionRow.transcript_id).order("sequence_no",{ascending:true})
      : {data:[],error:null};
    if(segmentError) return reply({error:"detail_segments_failed",detail:segmentError.message},500);

    const storage=db.storage.from("relato-call-audio");
    const audioPaths:Row={
      mixed:sessionRow.audio_mixed_path||null,
      local:sessionRow.audio_local_path||sessionRow.metadata?.audio_paths?.local||null,
      remote:sessionRow.audio_remote_path||sessionRow.metadata?.audio_paths?.remote||null,
    };
    const audio:Row[]=[];
    for(const [role,path] of Object.entries(audioPaths)){
      if(!path) continue;
      const mime=role==="mixed"?(sessionRow.audio_mime_type||"audio/mpeg"):"audio/wav";
      const ext=String(mime).includes("mpeg")?"mp3":String(path).toLowerCase().endsWith(".webm")?"webm":"wav";
      const [{data:play,error:playError},{data:download,error:downloadError}]=await Promise.all([
        storage.createSignedUrl(String(path),900,{download:false}),
        storage.createSignedUrl(String(path),900,{download:"relato-ligacao-"+role+"."+ext}),
      ]);
      if(!playError&&play?.signedUrl) audio.push({
        role,path,mime_type:mime,play_url:play.signedUrl,
        download_url:!downloadError&&download?.signedUrl?download.signedUrl:play.signedUrl,
        download_name:"relato-ligacao-"+role+"."+ext,
      });
    }

    const startedMs=Date.parse(String(sessionRow.started_at||transcript?.meeting_started_at||""));
    const endedMs=Date.parse(String(sessionRow.ended_at||transcript?.meeting_ended_at||""));
    const durationSeconds=Number(transcript?.duration_seconds||0)
      || (Number.isFinite(startedMs)&&Number.isFinite(endedMs)?Math.max(0,Math.round((endedMs-startedMs)/1000)):0)
      || Math.max(0,Math.round(Number(sessionRow.audio_duration_ms||0)/1000));

    const detailPhone=phoneDigits(sessionRow.metadata?.remote_phone);
    const commercialLeadId=clean(sessionRow.metadata?.commercial_prospect?.lead_id);
    let detailLead:Row|null=null;
    if(commercialLeadId){
      const {data}=await crm.from("leads").select("id,name,company,stage,phone").eq("id",commercialLeadId).maybeSingle();
      detailLead=data||null;
    }
    if(!detailLead&&detailPhone){
      const variants=[detailPhone,"+"+detailPhone];
      const {data}=await crm.from("leads").select("id,name,company,stage,phone").in("phone",variants).is("archived_at",null).order("updated_at",{ascending:false}).limit(1).maybeSingle();
      detailLead=data||null;
    }
    const resolvedDetailName=clean(detailLead?.company||detailLead?.name||sessionRow.metadata?.commercial_prospect?.name||sessionRow.metadata?.remote_name||sessionRow.metadata?.contact_name)||null;

    return reply({
      call:{
        id:sessionRow.id,session_id:sessionRow.id,local_session_id:sessionRow.local_session_id,
        title:sessionRow.title,started_at:sessionRow.started_at,ended_at:sessionRow.ended_at,
        state:sessionRow.state,capture_mode:sessionRow.capture_mode,
        remote_phone:sessionRow.metadata?.remote_phone||null,
        remote_name:sessionRow.metadata?.remote_name||sessionRow.metadata?.contact_name||null,
        prospect_name:resolvedDetailName,
        prospect_lead_id:detailLead?.id||commercialLeadId||null,
        prospect_stage:detailLead?.stage||null,
        contact_name:sessionRow.metadata?.contact_name||null,
        identity_status:sessionRow.metadata?.identity_resolution?.status||"UNRESOLVED",
        duration_seconds:durationSeconds,
        transcript_id:sessionRow.transcript_id||null,
        transcript_text:transcript?.transcript_text||null,
        transcript_summary:transcript?.metadata?.donnah_summary||transcript?.summary||null,
        participants:Array.isArray(transcript?.participants)?transcript.participants:[],
        segments:segments||[],
        audio,
        audio_status:sessionRow.audio_status||null,
        audio_last_error:sessionRow.audio_last_error||null,
      },
      generated_at:new Date().toISOString()
    });
  }

  const [sessionRes,transcriptRes,callRes]=await Promise.all([
    ops.from("meeting_capture_sessions")
      .select("id,local_session_id,title,started_at,ended_at,state,capture_mode,transcript_id,metadata,audio_status,audio_source,audio_local_path,audio_remote_path,audio_mixed_path,audio_duration_ms,audio_size_bytes,audio_mime_type,audio_last_error,created_at")
      .eq("owner_person",person).order("started_at",{ascending:false}).limit(500),
    ops.from("meeting_transcripts")
      .select("id,source_url,meeting_started_at,meeting_ended_at,duration_seconds,participants,summary,decisions,commitments,ai_signals,metadata,created_at,owner_person")
      .eq("owner_person",person).order("meeting_started_at",{ascending:false}).limit(500),
    ops.from("commercial_call_records")
      .select("id,lead_id,capture_session_id,transcript_id,channel,remote_phone,remote_name,outcome,notes,next_step,next_step_at,metadata,created_at")
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
  const callBySession=new Map(calls.filter((r:Row)=>r.capture_session_id).map((r:Row)=>[String(r.capture_session_id),r]));
  const callByTranscript=new Map(calls.filter((r:Row)=>r.transcript_id).map((r:Row)=>[String(r.transcript_id),r]));
  const sessions=(sessionRes.data||[]).map((r:Row)=>({
    ...r,
    kind:String(r.capture_mode||"").toUpperCase().includes("WHATSAPP")?"CALL":"MEETING"
  }));
  const callSessions=sessions.filter((r:Row)=>r.kind==="CALL");
  const sessionPhones=[...new Set(callSessions.map((r:Row)=>phoneDigits(r.metadata?.remote_phone)).filter(Boolean))];
  const phoneLeadMap=new Map<string,Row>();
  if(sessionPhones.length){
    const variants=[...new Set(sessionPhones.flatMap((p:string)=>[p,"+"+p]))];
    const {data:phoneLeads,error:phoneLeadError}=await crm.from("leads")
      .select("id,name,company,stage,phone,updated_at").in("phone",variants).is("archived_at",null)
      .order("updated_at",{ascending:false}).limit(1000);
    if(phoneLeadError) return reply({error:"phone_lead_lookup_failed",detail:phoneLeadError.message},500);
    for(const row of phoneLeads||[]){
      const key=phoneDigits(row.phone);
      if(key&&!phoneLeadMap.has(key)) phoneLeadMap.set(key,row);
    }
  }
  const enrichedCalls=callSessions.map((session:Row)=>{
    const record:any=callBySession.get(String(session.id))||callByTranscript.get(String(session.transcript_id||""))||null;
    const transcript:any=session.transcript_id?transcriptMap.get(String(session.transcript_id)):null;
    const recordLead:any=record?.lead_id?leadMap.get(String(record.lead_id))||null:null;
    const remotePhone=record?.remote_phone||session.metadata?.remote_phone||null;
    const phoneLead:any=phoneLeadMap.get(phoneDigits(remotePhone))||null;
    const metadataLeadId=clean(session.metadata?.commercial_prospect?.lead_id);
    const lead:any=recordLead||phoneLead||null;
    const candidateName=clean(
      lead?.company||lead?.name||
      session.metadata?.commercial_prospect?.company||session.metadata?.commercial_prospect?.name||
      record?.remote_name||session.metadata?.remote_name||session.metadata?.contact_name
    );
    const genericName=["Contato","Contato WhatsApp","Contato WhatsApp Desktop","WhatsApp"].includes(candidateName)?"":candidateName;
    const startedMs=Date.parse(String(session.started_at||""));
    const endedMs=Date.parse(String(session.ended_at||""));
    const durationSeconds=Number(transcript?.duration_seconds||0)
      || (Number.isFinite(startedMs)&&Number.isFinite(endedMs)?Math.max(0,Math.round((endedMs-startedMs)/1000)):0)
      || Math.max(0,Math.round(Number(session.audio_duration_ms||0)/1000));
    return {
      ...(record||{}),
      id:session.id,
      session_id:session.id,
      commercial_call_id:record?.id||null,
      transcript_id:session.transcript_id||record?.transcript_id||null,
      channel:record?.channel||"WHATSAPP_DESKTOP_CALL",
      capture_mode:session.capture_mode||null,
      remote_phone:remotePhone,
      remote_name:record?.remote_name||session.metadata?.remote_name||session.metadata?.contact_name||null,
      prospect_name:genericName||null,
      prospect_lead_id:lead?.id||metadataLeadId||null,
      stage:lead?.stage||null,
      notes:record?.notes||null,
      next_step:record?.next_step||null,
      next_step_at:record?.next_step_at||null,
      created_at:session.started_at||session.created_at,
      ended_at:session.ended_at||null,
      duration_seconds:durationSeconds,
      state:session.state,
      audio_status:session.audio_status||null,
      has_audio:Boolean(session.audio_mixed_path||session.audio_local_path||session.audio_remote_path||session.metadata?.audio_paths?.local||session.metadata?.audio_paths?.remote),
      has_transcript:Boolean(session.transcript_id||record?.transcript_id),
      prospect_identified:Boolean(genericName),
      identity_status:session.metadata?.identity_resolution?.status||"UNRESOLVED",
      transcript_summary:transcript?.metadata?.donnah_summary||transcript?.summary||record?.ai_summary||null,
      decisions:transcript?.decisions||[],commitments:transcript?.commitments||[],ai_signals:transcript?.ai_signals||{}
    };
  });
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
