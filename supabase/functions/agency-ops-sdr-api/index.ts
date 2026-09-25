import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin":"*",
  "access-control-allow-headers":"authorization,apikey,content-type",
  "access-control-allow-methods":"GET,POST,OPTIONS"
};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const clean=(v:unknown)=>String(v??"").trim();
const phoneDigits=(v:unknown)=>clean(v).replace(/\D/g,"");
const GENERIC_CONTACT_NAMES=new Set(["contato","contato whatsapp","contato whatsapp desktop","whatsapp"]);
const safeContactName=(v:unknown)=>{
  const name=clean(v);
  return name&&!GENERIC_CONTACT_NAMES.has(name.toLowerCase())?name:null;
};
const nameEvidence=(metadata:Row={},lead:Row|null=null,record:Row|null=null)=>{
  const identity:Row=metadata?.identity_resolution||{};
  const source=clean(identity?.source||metadata?.identity_source).toUpperCase();
  const explicit=metadata?.name_evidence||{};
  const whatsappSource =
    source.startsWith("WHATSAPP_") ||
    source.includes("PARTICIPANT_IDENTITY") ||
    source==="GROUP_PARTICIPANT_IDENTITY" ||
    source==="CLIENT_PHONE_REGISTRY";
  const postCallSource =
    source==="RELATO_MANUAL" ||
    source==="RELATO_MANUAL_FEEDBACK" ||
    source==="RELATO_COMMERCIAL" ||
    source==="RELATO_POST_CALL" ||
    clean(metadata?.feedback_binding?.source).toUpperCase()==="MANUAL";
  const transcriptSource=source==="TRANSCRIPT_DIRECT_ADDRESS";
  const whatsappName=safeContactName(
    explicit?.whatsapp?.name ||
    metadata?.whatsapp_name ||
    (whatsappSource?identity?.name:null) ||
    ((clean(metadata?.source).toUpperCase()==="WHATSAPP_WEB" || clean(metadata?.identity_source).toUpperCase()==="WHATSAPP_DESKTOP_UI")
      ? metadata?.contact_name : null)
  );
  const postCallName=safeContactName(
    explicit?.post_call?.name ||
    metadata?.post_call_name ||
    (postCallSource?identity?.name:null)
  );
  const autoName=safeContactName(
    explicit?.transcript?.name ||
    metadata?.transcript_inferred_name ||
    (transcriptSource?identity?.name:null)
  );
  const crmName=safeContactName(
    lead?.company || lead?.name ||
    explicit?.crm?.name ||
    metadata?.crm_name
  );
  const legacyName=safeContactName(record?.remote_name);
  const primaryName=whatsappName||crmName||postCallName||autoName||legacyName||null;
  const primarySource=whatsappName?"WHATSAPP":crmName?"CRM":postCallName?"POST_CALL":autoName?"TRANSCRIPT":legacyName?"LEGACY":null;
  return {
    whatsapp_name:whatsappName,
    post_call_name:postCallName,
    crm_name:crmName,
    auto_identified_name:autoName,
    prospect_name:primaryName,
    prospect_name_source:primarySource,
  };
};
const likelyWhisperHallucination=(value:unknown)=>{
  const raw=clean(value).toLowerCase();
  if(!raw) return false;
  const words=raw.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).filter(Boolean);
  if(words.length<12) return false;
  const uniqueRatio=new Set(words).size/words.length;
  if(words.length>=20&&uniqueRatio<=0.20) return true;
  for(const size of [2,3,4]){
    if(words.length<size*4) continue;
    const counts=new Map<string,number>();
    let max=0;
    for(let i=0;i<=words.length-size;i++){
      const key=words.slice(i,i+size).join(" ");
      const next=(counts.get(key)||0)+1;
      counts.set(key,next);
      if(next>max) max=next;
    }
    if(max>=4&&(max*size)/words.length>=0.45) return true;
  }
  return false;
};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method)) return reply({error:"method_not_allowed"},405);
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

  if(req.method==="POST"){
    const body:Row=await req.json().catch(()=>({}));
    const action=clean(body.action).toLowerCase();
    const sessionId=clean(body.session_id);
    if(!sessionId) return reply({error:"session_id_required"},400);
    const {data:session,error:sessionError}=await ops.from("meeting_capture_sessions")
      .select("id,device_id,owner_person,local_session_id,metadata,audio_mixed_path")
      .eq("id",sessionId).eq("owner_person",person).maybeSingle();
    if(sessionError) return reply({error:"audio_repair_session_failed",detail:sessionError.message},500);
    if(!session) return reply({error:"call_not_found"},404);
    const safeLocal=clean(session.local_session_id).replace(/[^a-zA-Z0-9._-]/g,"_")||"session";
    const mixedPath="calls/"+session.device_id+"/"+safeLocal+"/mixed.mp3";
    const storage=db.storage.from("relato-call-audio");

    if(action==="audio_repair_prepare"){
      const {data,error}=await storage.createSignedUploadUrl(mixedPath,{upsert:true});
      if(error||!data?.signedUrl) return reply({error:"audio_repair_upload_url_failed",detail:error?.message},500);
      return reply({ok:true,session_id:session.id,path:mixedPath,signed_url:data.signedUrl,mime_type:"audio/mpeg"});
    }

    if(action==="audio_repair_commit"){
      const suppliedPath=clean(body.path);
      if(suppliedPath!==mixedPath) return reply({error:"audio_repair_path_mismatch"},400);
      const folder=mixedPath.slice(0,mixedPath.lastIndexOf("/"));
      const filename=mixedPath.slice(mixedPath.lastIndexOf("/")+1);
      const {data:objects,error:listError}=await storage.list(folder,{limit:20,search:filename});
      if(listError) return reply({error:"audio_repair_verify_failed",detail:listError.message},500);
      const object=(objects||[]).find((row:Row)=>String(row.name)===filename);
      const bytes=Math.max(0,Math.round(Number(object?.metadata?.size||body.bytes||0)));
      if(!object||bytes<1000) return reply({error:"audio_repair_object_missing_or_empty"},400);
      const now=new Date().toISOString();
      const metadata={...(session.metadata||{}),audio_player:{path:mixedPath,bytes,mime_type:"audio/mpeg",codec:"mp3",generated_at:now,source:"SDR_REPAIR"}};
      const {error:updateError}=await ops.from("meeting_capture_sessions").update({
        audio_mixed_path:mixedPath,audio_mime_type:"audio/mpeg",audio_size_bytes:bytes,
        audio_status:"READY",audio_last_error:null,audio_updated_at:now,metadata,updated_at:now
      }).eq("id",session.id);
      if(updateError) return reply({error:"audio_repair_commit_failed",detail:updateError.message},500);
      return reply({ok:true,session_id:session.id,path:mixedPath,bytes,state:"READY"});
    }
    return reply({error:"unknown_action"},400);
  }

  const detailSessionId=clean(requestUrl.searchParams.get("session_id"));
  if(detailSessionId){
    const {data:sessionRow,error:sessionError}=await ops.from("meeting_capture_sessions")
      .select("id,owner_person,local_session_id,title,started_at,ended_at,state,capture_mode,transcript_id,metadata,audio_status,audio_source,audio_local_path,audio_remote_path,audio_mixed_path,audio_duration_ms,audio_size_bytes,audio_mime_type,audio_last_error,created_at,updated_at")
      .eq("id",detailSessionId).eq("owner_person",person).maybeSingle();
    if(sessionError) return reply({error:"detail_session_failed",detail:sessionError.message},500);
    if(!sessionRow||!String(sessionRow.capture_mode||"").toUpperCase().includes("WHATSAPP")) return reply({error:"call_not_found"},404);

    if(requestUrl.searchParams.get("audio")==="1"){
      if(!sessionRow.audio_mixed_path) return reply({error:"audio_not_ready"},404);
      const storage=db.storage.from("relato-call-audio");
      const {data:signed,error:signedError}=await storage.createSignedUrl(String(sessionRow.audio_mixed_path),120);
      if(signedError||!signed?.signedUrl) return reply({error:"audio_sign_failed",detail:signedError?.message},500);
      const upstream=await fetch(signed.signedUrl,{headers:{accept:"audio/mpeg"}});
      if(!upstream.ok||!upstream.body) return reply({error:"audio_fetch_failed",status:upstream.status},502);
      const headers=new Headers(CORS);
      headers.set("content-type",sessionRow.audio_mime_type||"audio/mpeg");
      headers.set("cache-control","private, no-store");
      const length=upstream.headers.get("content-length");
      if(length) headers.set("content-length",length);
      return new Response(upstream.body,{status:200,headers});
    }

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
    const safeSegments=(segments||[]).filter((row:Row)=>!likelyWhisperHallucination(row?.text));
    const clock=(value:unknown)=>{
      const total=Math.max(0,Math.floor(Number(value||0)/1000));
      const hh=String(Math.floor(total/3600)).padStart(2,"0");
      const mm=String(Math.floor((total%3600)/60)).padStart(2,"0");
      const ss=String(total%60).padStart(2,"0");
      return hh+":"+mm+":"+ss;
    };
    const safeTranscriptText=(segments||[]).length
      ? (safeSegments.length?safeSegments.map((row:Row)=>`[${clock(row.started_ms)}] ${clean(row.speaker_name||"Participante")}: ${clean(row.text)}`).join("\n\n"):null)
      : (transcript?.transcript_text&&!likelyWhisperHallucination(transcript.transcript_text)?transcript.transcript_text:null);

    const storage=db.storage.from("relato-call-audio");
    const audioPaths:Row={ mixed:sessionRow.audio_mixed_path||null };
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
    const detailNames=nameEvidence(sessionRow.metadata||{},detailLead,null);

    return reply({
      call:{
        id:sessionRow.id,session_id:sessionRow.id,local_session_id:sessionRow.local_session_id,
        title:sessionRow.title,started_at:sessionRow.started_at,ended_at:sessionRow.ended_at,
        state:sessionRow.state,capture_mode:sessionRow.capture_mode,
        remote_phone:sessionRow.metadata?.remote_phone||null,
        remote_name:safeContactName(sessionRow.metadata?.remote_name),
        whatsapp_name:detailNames.whatsapp_name,
        post_call_name:detailNames.post_call_name,
        crm_name:detailNames.crm_name,
        auto_identified_name:detailNames.auto_identified_name,
        prospect_name:detailNames.prospect_name,
        prospect_name_source:detailNames.prospect_name_source,
        prospect_lead_id:detailLead?.id||commercialLeadId||null,
        prospect_stage:detailLead?.stage||null,
        contact_name:sessionRow.metadata?.contact_name||null,
        identity_status:sessionRow.metadata?.identity_resolution?.status||"UNRESOLVED",
        review_classification:sessionRow.metadata?.backfill_review?.classification||null,
        review_reason:sessionRow.metadata?.backfill_review?.reason||null,
        commercial_sync_status:sessionRow.metadata?.commercial_sync?.status||null,
        duration_seconds:durationSeconds,
        transcript_id:sessionRow.transcript_id||null,
        transcript_text:safeTranscriptText,
        transcript_summary:transcript?.metadata?.donnah_summary||transcript?.summary||null,
        participants:Array.isArray(transcript?.participants)?transcript.participants:[],
        segments:safeSegments,
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
      .select("id,name,company,stage").in("id",leadIds).is("archived_at",null);
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
    const names=nameEvidence(session.metadata||{},lead,record);
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
      remote_name:safeContactName(session.metadata?.remote_name)||null,
      whatsapp_name:names.whatsapp_name,
      post_call_name:names.post_call_name,
      crm_name:names.crm_name,
      auto_identified_name:names.auto_identified_name,
      prospect_name:names.prospect_name,
      prospect_name_source:names.prospect_name_source,
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
      prospect_identified:Boolean(names.prospect_name),
      identity_status:session.metadata?.identity_resolution?.status||"UNRESOLVED",
      review_classification:session.metadata?.backfill_review?.classification||null,
      review_reason:session.metadata?.backfill_review?.reason||null,
      commercial_sync_status:session.metadata?.commercial_sync?.status||null,
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

  const requiredAgentVersion="desktop-0.5.0";
  const {data:latestDevice}=await ops.from("meeting_capture_devices")
    .select("extension_version,last_seen_at,device_name,status")
    .eq("owner_person",person)
    .eq("status","ACTIVE")
    .order("last_seen_at",{ascending:false,nullsFirst:false})
    .limit(1)
    .maybeSingle();
  const currentAgentVersion=clean(latestDevice?.extension_version)||null;

  return reply({
    profile:{person,role:"SDR",display_role:"SDR",access_level:"OWN_ACTIVITY_ONLY"},
    agent:{
      current_version:currentAgentVersion,
      required_version:requiredAgentVersion,
      update_required:currentAgentVersion!==requiredAgentVersion,
      last_seen_at:latestDevice?.last_seen_at||null,
      device_name:latestDevice?.device_name||null,
      release_url:"https://github.com/a-codeadlerfurtado/agency-ops-dashboard/releases/download/relato-package-v2026.09.25.5/RelatoAI-Desktop-SDR.exe"
    },
    summary:{meetings:meetings.length,calls:enrichedCalls.length},
    meetings,calls:enrichedCalls,sessions,
    generated_at:new Date().toISOString()
  });
});
