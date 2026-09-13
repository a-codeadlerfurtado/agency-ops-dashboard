import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const txt=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:null};
async function sha256hex(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("")}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST") return json({error:"method_not_allowed"},405);
  const su=Deno.env.get("SUPABASE_URL")||"",sr=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!su||!sr) return json({error:"server_configuration"},500);
  const ops=createClient(su,sr,{auth:{persistSession:false,autoRefreshToken:false}}).schema("agency_ops");
  const [{data:hashRow},{data:legacyRow}]=await Promise.all([
    ops.from("automation_settings").select("value").eq("key","VIDEO_EDIT_WORKER_TOKEN_SHA256").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key","VIDEO_EDIT_WORKER_TOKEN").maybeSingle()
  ]);
  const expectedHash=typeof hashRow?.value==="string"?hashRow.value:txt(hashRow?.value).replace(/^\"|\"$/g,"");
  const legacy=typeof legacyRow?.value==="string"?legacyRow.value:txt(legacyRow?.value).replace(/^\"|\"$/g,"");
  const given=txt(req.headers.get("x-video-worker-token"));
  if(!given||!((expectedHash&&await sha256hex(given)===expectedHash)||(legacy&&given===legacy))) return json({error:"unauthorized"},401);
  const body=await req.json().catch(()=>({}));
  const action=txt(body?.action),worker=txt(body?.worker_id)||"leonardo-video-worker-v4-shadow";
  try{
    if(action==="health"){
      const {data:s}=await ops.from("automation_settings").select("key,value").in("key",["VIDEO_RENDERER_V4_ENABLED","VIDEO_RENDERER_V4_SHADOW"]);
      const values=Object.fromEntries((s||[]).map((r:any)=>[r.key,r.value]));
      return json({ok:true,enabled:values.VIDEO_RENDERER_V4_ENABLED===true,shadow:values.VIDEO_RENDERER_V4_SHADOW!==false,version:"video-v4-worker-api-v1"});
    }
    if(action==="worker_ping"){
      const state=["IDLE","WORKING","ANALYZING","ERROR"].includes(txt(body.state))?txt(body.state):"IDLE";
      const {error}=await ops.from("video_worker_heartbeats").upsert({worker_id:worker,worker_version:txt(body.worker_version)||null,state,current_job_id:txt(body.current_job_id)||null,last_seen_at:new Date().toISOString(),metadata:body.metadata||{},updated_at:new Date().toISOString()},{onConflict:"worker_id"});
      if(error) throw error; return json({ok:true,state});
    }
    if(action==="prepare"){
      const sourceJobId=txt(body.source_job_id); if(!sourceJobId) return json({error:"source_job_id_required"},400);
      const variant=txt(body.variant)||"v4_shadow";
      const {data:job,error:jobError}=await ops.from("video_edit_jobs").select("*").eq("id",sourceJobId).maybeSingle();
      if(jobError) throw jobError; if(!job) return json({error:"source_job_not_found"},404);
      if(job.test_mode!==true&&body.allow_production!==true) return json({error:"v4_prepare_requires_test_job"},409);
      const idem=`${sourceJobId}:${variant}`;
      const {data:existing}=await ops.from("video_v4_render_jobs").select("*").eq("idempotency_key",idem).maybeSingle();
      if(existing) return json({ok:true,reused:true,render_job:existing});
      const {data:inputs,error:inputsError}=await ops.from("video_edit_job_inputs").select("id,job_id,drive_file_id,file_name,duration_seconds,sort_order,analysis_id,asset_id,metadata").eq("job_id",sourceJobId).order("sort_order");
      if(inputsError) throw inputsError; if(!(inputs||[]).length) return json({error:"source_job_has_no_inputs"},409);
      await ops.from("video_timelines").update({is_active:false,updated_at:new Date().toISOString()}).eq("job_id",sourceJobId).eq("is_active",true);
      const skeleton={version:"timeline-v1",jobId:sourceJobId,createdAt:new Date().toISOString(),strategyVersion:job.strategy_version||"dynamic-strategy-v3",directorVersion:"creative-director-v4.0.0",style:"PERFORMANCE_AD",canvas:{width:1080,height:1920,fps:30,aspectRatio:"9:16",background:"#000000"},safeZone:{top:240,right:80,bottom:320,left:80},duration:Number(job.edit_strategy?.target_duration_seconds||18),assets:(inputs||[]).map((i:any)=>({id:String(i.asset_id||i.id),kind:"video",driveFileId:i.drive_file_id,fileName:i.file_name,duration:i.duration_seconds||undefined})),tracks:[],render:{container:"mp4",videoCodec:"h264",audioCodec:"aac",videoBitrateMbps:10,audioBitrateKbps:192,pixelFormat:"yuv420p"},metadata:{clientId:job.client_id||undefined,productId:job.product_id||undefined,contextVersion:job.context_version||undefined,generatedBy:"creative-director-v4",warnings:["pending_worker_temporal_analysis"]}};
      const {data:timeline,error:timelineError}=await ops.from("video_timelines").insert({job_id:sourceJobId,version:1,spec_version:"timeline-v1",director_version:"creative-director-v4.0.0",status:"DRAFT",is_active:true,timeline:skeleton,source:"AUTO",created_by:"video-v4-api",metadata:{variant}}).select("*").single();
      if(timelineError) throw timelineError;
      const {data:renderJob,error:renderError}=await ops.from("video_v4_render_jobs").insert({source_job_id:sourceJobId,timeline_id:timeline.id,variant,status:"QUEUED",priority:Number(body.priority||80),renderer_version:"leonardo-renderer-v4.0.0",idempotency_key:idem,render_metadata:{prepared_at:new Date().toISOString(),source_renderer:job.renderer_version||null}}).select("*").single();
      if(renderError) throw renderError; return json({ok:true,reused:false,render_job:renderJob,timeline});
    }
    if(action==="claim"){
      await ops.rpc("requeue_stale_video_v4_render_jobs",{p_stale_minutes:20,p_max_attempts:3});
      const {data:renderJob,error}=await ops.rpc("claim_video_v4_render_job",{p_worker_id:worker}); if(error) throw error;
      if(!renderJob?.id) return json({ok:true,render_job:null});
      const [{data:timeline},{data:sourceJob},{data:inputs}]=await Promise.all([
        ops.from("video_timelines").select("*").eq("id",renderJob.timeline_id).maybeSingle(),
        ops.from("video_edit_jobs").select("*").eq("id",renderJob.source_job_id).maybeSingle(),
        ops.from("video_edit_job_inputs").select("id,job_id,drive_file_id,file_name,duration_seconds,sort_order,analysis_id,asset_id,metadata").eq("job_id",renderJob.source_job_id).order("sort_order")
      ]);
      return json({ok:true,render_job:renderJob,timeline,source_job:sourceJob,inputs:inputs||[]});
    }
    const renderId=txt(body.render_job_id); if(!renderId) return json({error:"render_job_id_required"},400);
    const {data:rj,error:rjError}=await ops.from("video_v4_render_jobs").select("*").eq("id",renderId).maybeSingle(); if(rjError) throw rjError; if(!rj) return json({error:"render_job_not_found"},404);
    if(rj.worker_id&&rj.worker_id!==worker) return json({error:"worker_mismatch"},409);
    if(action==="heartbeat"||action==="progress"){
      const p=Math.max(0,Math.min(99,Math.round(num(body.progress_pct)??rj.progress_pct)));
      const stage=txt(body.stage)||rj.current_stage||"WORKING";
      const status=["CLAIMED","RENDERING","UPLOADING","QA"].includes(txt(body.status))?txt(body.status):rj.status;
      const {error}=await ops.from("video_v4_render_jobs").update({heartbeat_at:new Date().toISOString(),progress_pct:p,current_stage:stage,status,render_metadata:{...(rj.render_metadata||{}),...(body.metrics||{})},updated_at:new Date().toISOString()}).eq("id",renderId).eq("worker_id",worker); if(error) throw error;
      return json({ok:true});
    }
    if(action==="save_timeline"){
      if(!body.timeline||typeof body.timeline!=="object") return json({error:"timeline_required"},400);
      const {error}=await ops.from("video_timelines").update({timeline:body.timeline,timeline_hash:txt(body.timeline_hash)||null,status:"READY",director_version:txt(body.director_version)||"creative-director-v4.0.0",metadata:{...(body.metadata||{}),analyzed_at:new Date().toISOString()},updated_at:new Date().toISOString()}).eq("id",rj.timeline_id); if(error) throw error;
      return json({ok:true,timeline_id:rj.timeline_id});
    }
    if(action==="complete"){
      const o=body.output||{},q=o.qa_json||{};
      if(txt(o.qa_status)!=="PASS"||q.file_exists!==true||q.playable!==true||!txt(o.drive_file_id)||!txt(o.content_hash)) return json({error:"qa_pass_required"},409);
      const variant=txt(rj.variant)||"v4_shadow";
      const {data:out,error:outError}=await ops.from("video_edit_job_outputs").upsert({job_id:rj.source_job_id,variant,aspect_ratio:"9:16",drive_file_id:txt(o.drive_file_id),drive_url:txt(o.drive_url)||null,file_name:txt(o.file_name)||null,duration_seconds:num(o.duration_seconds),render_metadata:{...(o.render_metadata||{}),v4_render_job_id:rj.id,timeline_id:rj.timeline_id},qa_status:"PASS",qa_json:q,idempotency_key:txt(o.idempotency_key)||`${rj.id}:${variant}`,content_hash:txt(o.content_hash),size_bytes:num(o.size_bytes),video_codec:txt(o.video_codec)||null,audio_codec:txt(o.audio_codec)||null,width:num(o.width),height:num(o.height),fps:num(o.fps),renderer_version:txt(body.renderer_version)||"leonardo-renderer-v4.0.0",review_status:"REVIEW_REQUIRED"},{onConflict:"job_id,variant"}).select("id").single(); if(outError) throw outError;
      const {error}=await ops.from("video_v4_render_jobs").update({status:"DONE",progress_pct:100,current_stage:"DONE",heartbeat_at:new Date().toISOString(),finished_at:new Date().toISOString(),output_id:out.id,renderer_version:txt(body.renderer_version)||"leonardo-renderer-v4.0.0",render_metadata:{...(rj.render_metadata||{}),...(body.render_metadata||{}),completed_at:new Date().toISOString()},last_error:null,updated_at:new Date().toISOString()}).eq("id",renderId).eq("worker_id",worker); if(error) throw error;
      await ops.from("video_edit_job_events").insert({job_id:rj.source_job_id,event_type:"V4_COMPLETED",stage:"DONE",worker_id:worker,attempt_count:rj.attempt_count,progress_pct:100,metrics:{v4_render_job_id:rj.id,timeline_id:rj.timeline_id,output_id:out.id}});
      return json({ok:true,status:"DONE",output_id:out.id});
    }
    if(action==="fail"){
      const errorText=txt(body.error)||"v4_render_failed";
      await ops.from("video_v4_render_jobs").update({status:"FAILED",current_stage:"FAILED",heartbeat_at:new Date().toISOString(),finished_at:new Date().toISOString(),last_error:errorText,updated_at:new Date().toISOString()}).eq("id",renderId).eq("worker_id",worker);
      await ops.from("video_edit_job_events").insert({job_id:rj.source_job_id,event_type:"V4_FAILED",stage:"FAILED",worker_id:worker,attempt_count:rj.attempt_count,progress_pct:rj.progress_pct,error:errorText,metrics:{v4_render_job_id:rj.id,timeline_id:rj.timeline_id}});
      return json({ok:true,status:"FAILED"});
    }
    return json({error:"invalid_action"},400);
  }catch(e){return json({error:"video_v4_worker_api_failed",detail:e instanceof Error?e.message:String(e)},500)}
});
