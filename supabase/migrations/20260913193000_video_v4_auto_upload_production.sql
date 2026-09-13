begin;

insert into agency_ops.automation_settings(key,value,description,updated_at) values
('VIDEO_AUTO_EDIT_ON_UPLOAD','true'::jsonb,'Novos videos detectados no Drive entram automaticamente no renderer V4',now()),
('VIDEO_AUTO_UPLOAD_BATCH_SECONDS','90'::jsonb,'Janela para agrupar takes do mesmo cliente antes do render V4',now())
on conflict (key) do update set value=excluded.value,description=excluded.description,updated_at=now();

create or replace function agency_ops.enqueue_auto_video_v4_from_raw_upload()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
declare v_auto boolean:=false; v_v4 boolean:=false; v_batch_seconds integer:=90; v_output_folder text;
        v_client_name text; v_job_id uuid; v_render_id uuid; v_timeline_id uuid; v_input_count integer:=0;
begin
  if new.file_kind<>'VIDEO' or new.client_id is null then return new; end if;
  select coalesce((value#>>'{}')::boolean,false) into v_auto from agency_ops.automation_settings where key='VIDEO_AUTO_EDIT_ON_UPLOAD';
  select coalesce((value#>>'{}')::boolean,false) into v_v4 from agency_ops.automation_settings where key='VIDEO_RENDERER_V4_ENABLED';
  if not coalesce(v_auto,false) or not coalesce(v_v4,false) then return new; end if;
  if not exists(select 1 from agency_ops.client_drive_bindings b where b.client_id=new.client_id and b.binding_status='VERIFIED') then return new; end if;
  select greatest(30,least(300,coalesce((value#>>'{}')::integer,90))) into v_batch_seconds from agency_ops.automation_settings where key='VIDEO_AUTO_UPLOAD_BATCH_SECONDS';
  v_batch_seconds:=coalesce(v_batch_seconds,90);
  select nullif(value#>>'{}','') into v_output_folder from agency_ops.automation_settings where key='VIDEO_EDIT_TRIAGE_FOLDER_ID';
  if v_output_folder is null then return new; end if;
  select display_name into v_client_name from agency_ops.clients where id=new.client_id;
  v_client_name:=coalesce(v_client_name,new.client_folder_name,'Cliente');
  perform pg_advisory_xact_lock(hashtextextended(new.client_id::text,87144));
  select j.id,r.id into v_job_id,v_render_id
  from agency_ops.video_edit_jobs j join agency_ops.video_v4_render_jobs r on r.source_job_id=j.id and r.variant='v4_auto'
  where j.client_id=new.client_id and coalesce((j.metadata->>'auto_upload_batch')::boolean,false)=true
    and j.created_at>now()-interval '10 minutes' and r.status='QUEUED' and r.available_at>now()-interval '15 seconds'
  order by j.created_at desc limit 1;
  if v_job_id is null then
    insert into agency_ops.video_edit_jobs(client_id,product_name,status,priority,output_drive_root_id,output_drive_folder_id,
      requested_formats,product_context,client_context,edit_strategy,requested_by,available_at,metadata,progress_pct,current_stage,
      worker_id,test_mode,analysis_version,strategy_version,renderer_version,review_mode,approval_status,idempotency_key)
    values(new.client_id,left(regexp_replace(coalesce(new.file_name,'Video'),'\\.[^.]+$','','i'),120),'RENDERING',70,
      v_output_folder,v_output_folder,array['9:16'::text],jsonb_build_object('source_file_name',new.file_name,'source_drive_file_id',new.drive_file_id),
      jsonb_build_object('client',jsonb_build_object('id',new.client_id,'name',v_client_name),'source','auto_raw_upload'),
      jsonb_build_object('target_duration_seconds',18,'batch_mode',true,'source','v4_auto_upload'),'AUTO_RAW_UPLOAD',now(),
      jsonb_build_object('auto_upload_batch',true,'batch_file_count',1,'first_raw_upload_id',new.id,'last_raw_upload_id',new.id,'source','client_raw_material_uploads'),
      1,'V4_BATCHING_INPUTS','leonardo-video-worker-v4-shadow',false,'video-temporal-v4.3','creative-director-v4.4.0','4.4.0',
      'RENDER_REVIEW','PENDING','v4-auto-upload:'||new.drive_file_id) returning id into v_job_id;
    insert into agency_ops.video_timelines(job_id,spec_version,director_version,status,is_active,timeline,source,created_by,metadata)
    values(v_job_id,'timeline-v1','creative-director-v4.4.0','READY',true,
      jsonb_build_object('version','timeline-v1','jobId',v_job_id,'status','PENDING_ANALYSIS','tracks',jsonb_build_array(),'assets',jsonb_build_array()),
      'AUTO','auto-raw-upload',jsonb_build_object('pending_worker_temporal_analysis',true)) returning id into v_timeline_id;
    insert into agency_ops.video_v4_render_jobs(source_job_id,timeline_id,variant,status,priority,available_at,renderer_version,render_metadata,idempotency_key)
    values(v_job_id,v_timeline_id,'v4_auto','QUEUED',70,now()+make_interval(secs=>v_batch_seconds),'leonardo-renderer-v4.4.0',
      jsonb_build_object('auto_upload',true,'batch_seconds',v_batch_seconds),v_job_id::text||':v4_auto') returning id into v_render_id;
  else
    update agency_ops.video_v4_render_jobs set available_at=now()+make_interval(secs=>v_batch_seconds),updated_at=now(),
      render_metadata=coalesce(render_metadata,'{}'::jsonb)||jsonb_build_object('last_raw_upload_id',new.id,'batch_seconds',v_batch_seconds)
    where id=v_render_id;
    update agency_ops.video_edit_jobs set metadata=jsonb_set(jsonb_set(coalesce(metadata,'{}'::jsonb),'{last_raw_upload_id}',to_jsonb(new.id),true),
      '{batch_file_count}',to_jsonb(coalesce((metadata->>'batch_file_count')::integer,0)+1),true),updated_at=now(),current_stage='V4_BATCHING_INPUTS'
    where id=v_job_id;
  end if;
  insert into agency_ops.video_edit_job_inputs(job_id,drive_file_id,file_name,mime_type,sort_order,metadata,input_status)
  select v_job_id,new.drive_file_id,new.file_name,new.mime_type,
    coalesce((select max(sort_order)+1 from agency_ops.video_edit_job_inputs where job_id=v_job_id),0),
    jsonb_build_object('raw_upload_id',new.id,'source',new.source,'drive_folder_id',new.drive_folder_id),'PENDING'
  on conflict (job_id,drive_file_id) do nothing;
  select count(*) into v_input_count from agency_ops.video_edit_job_inputs where job_id=v_job_id;
  update agency_ops.video_edit_jobs set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{batch_file_count}',to_jsonb(v_input_count),true),updated_at=now() where id=v_job_id;
  insert into agency_ops.video_edit_job_events(job_id,event_type,stage,worker_id,progress_pct,metrics)
  values(v_job_id,'V4_AUTO_INPUT_ADDED','V4_BATCHING_INPUTS','leonardo-video-worker-v4-shadow',1,
    jsonb_build_object('raw_upload_id',new.id,'drive_file_id',new.drive_file_id,'batch_file_count',v_input_count,'render_job_id',v_render_id));
  return new;
end $$;

drop trigger if exists trg_auto_video_v4_from_raw_upload on agency_ops.client_raw_material_uploads;
create trigger trg_auto_video_v4_from_raw_upload after insert on agency_ops.client_raw_material_uploads
for each row execute function agency_ops.enqueue_auto_video_v4_from_raw_upload();
create or replace function agency_ops.sync_v4_auto_source_job_status()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
begin
  if new.variant<>'v4_auto' then return new; end if;
  if new.status in ('CLAIMED','RENDERING') then
    update agency_ops.video_edit_jobs set status='RENDERING',current_stage='V4_'||coalesce(new.current_stage,new.status),
      progress_pct=greatest(progress_pct,least(99,new.progress_pct)),worker_id=new.worker_id,heartbeat_at=coalesce(new.heartbeat_at,now()),updated_at=now()
    where id=new.source_job_id;
  elsif new.status='UPLOADING' then
    update agency_ops.video_edit_jobs set status='UPLOADING',current_stage='V4_UPLOADING',progress_pct=greatest(progress_pct,90),worker_id=new.worker_id,updated_at=now() where id=new.source_job_id;
  elsif new.status='QA' then
    update agency_ops.video_edit_jobs set status='QA',current_stage='V4_QA',progress_pct=greatest(progress_pct,84),worker_id=new.worker_id,updated_at=now() where id=new.source_job_id;
  elsif new.status='COMPLETED' then
    update agency_ops.video_edit_jobs set status='REVIEW_REQUIRED',current_stage='REVIEW_REQUIRED',progress_pct=100,finished_at=coalesce(finished_at,now()),
      worker_id=new.worker_id,heartbeat_at=now(),renderer_version='4.4.0',last_error=null,updated_at=now() where id=new.source_job_id;
  elsif new.status='FAILED' then
    update agency_ops.video_edit_jobs set status='FAILED',current_stage='V4_FAILED',finished_at=coalesce(finished_at,now()),worker_id=new.worker_id,
      heartbeat_at=now(),last_error=coalesce(new.last_error,'v4_auto_failed'),updated_at=now() where id=new.source_job_id;
  elsif new.status='CANCELLED' then
    update agency_ops.video_edit_jobs set status='CANCELLED',current_stage='V4_CANCELLED',finished_at=coalesce(finished_at,now()),updated_at=now() where id=new.source_job_id;
  elsif new.status='RETRY' then
    update agency_ops.video_edit_jobs set status='RENDERING',current_stage='V4_RETRY',last_error=new.last_error,updated_at=now() where id=new.source_job_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_v4_auto_source_job_status on agency_ops.video_v4_render_jobs;
create trigger trg_sync_v4_auto_source_job_status after insert or update of status,progress_pct,current_stage,worker_id,last_error
on agency_ops.video_v4_render_jobs for each row execute function agency_ops.sync_v4_auto_source_job_status();

create or replace function agency_ops.suppress_legacy_drive_watch_render_when_v4_auto()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
declare v_auto boolean:=false;
begin
  select coalesce((value#>>'{}')::boolean,false) into v_auto from agency_ops.automation_settings where key='VIDEO_AUTO_EDIT_ON_UPLOAD';
  if coalesce(v_auto,false) and coalesce(new.idempotency_key,'') like 'DRIVE_WATCH:%'
     and coalesce(new.requested_by,'')='SYSTEM' and coalesce(new.metadata->>'source','')='agency-ops-video-edit-api' then
    new.status:='CANCELLED'; new.current_stage:='SUPERSEDED_BY_V4_AUTO'; new.cancel_requested:=true; new.finished_at:=now();
    new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('suppressed_by','VIDEO_AUTO_EDIT_ON_UPLOAD',
      'legacy_render_suppressed',true,'v4_auto_primary',true);
  end if;
  return new;
end $$;

drop trigger if exists trg_suppress_legacy_drive_watch_render_when_v4_auto on agency_ops.video_edit_jobs;
create trigger trg_suppress_legacy_drive_watch_render_when_v4_auto before insert on agency_ops.video_edit_jobs
for each row execute function agency_ops.suppress_legacy_drive_watch_render_when_v4_auto();

create or replace function agency_ops.enrich_v4_auto_from_legacy_context()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
declare v_drive_file_id text; v_auto_job_id uuid;
begin
  if coalesce(new.metadata->>'suppressed_by','')<>'VIDEO_AUTO_EDIT_ON_UPLOAD' then return new; end if;
  v_drive_file_id:=split_part(coalesce(new.idempotency_key,''),':',2);
  if v_drive_file_id='' then return new; end if;
  select j.id into v_auto_job_id from agency_ops.video_edit_job_inputs i join agency_ops.video_edit_jobs j on j.id=i.job_id
  where i.drive_file_id=v_drive_file_id and coalesce((j.metadata->>'auto_upload_batch')::boolean,false)=true
    and j.status in ('RENDERING','UPLOADING','QA') order by j.created_at desc limit 1;
  if v_auto_job_id is null then return new; end if;
  update agency_ops.video_edit_jobs j set
    product_id=coalesce(new.product_id,j.product_id),
    product_name=case when new.product_name is not null and new.product_name<>'' then new.product_name else j.product_name end,
    product_context=case when new.product_context is not null and new.product_context<>'{}'::jsonb then new.product_context else j.product_context end,
    client_context=case when new.client_context is not null and new.client_context<>'{}'::jsonb then new.client_context else j.client_context end,
    benchmark_context=case when new.benchmark_context is not null and new.benchmark_context<>'{}'::jsonb then new.benchmark_context else j.benchmark_context end,
    edit_strategy=case when new.edit_strategy is not null and new.edit_strategy<>'{}'::jsonb then new.edit_strategy else j.edit_strategy end,
    context_snapshot_id=coalesce(new.context_snapshot_id,j.context_snapshot_id),briefing_version=coalesce(new.briefing_version,j.briefing_version),
    context_version=coalesce(new.context_version,j.context_version),benchmark_version=coalesce(new.benchmark_version,j.benchmark_version),
    metadata=coalesce(j.metadata,'{}'::jsonb)||jsonb_build_object('context_enriched',true,'context_source_job_id',new.id,'context_drive_file_id',v_drive_file_id),updated_at=now()
  where j.id=v_auto_job_id;
  return new;
end $$;

drop trigger if exists trg_enrich_v4_auto_from_legacy_context on agency_ops.video_edit_jobs;
create trigger trg_enrich_v4_auto_from_legacy_context after insert on agency_ops.video_edit_jobs
for each row execute function agency_ops.enrich_v4_auto_from_legacy_context();

create or replace function agency_ops.sync_v4_auto_input_from_legacy_input()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
declare v_parent agency_ops.video_edit_jobs; v_auto_job_id uuid;
begin
  select * into v_parent from agency_ops.video_edit_jobs where id=new.job_id;
  if v_parent.id is null or coalesce(v_parent.metadata->>'suppressed_by','')<>'VIDEO_AUTO_EDIT_ON_UPLOAD' then return new; end if;
  select j.id into v_auto_job_id from agency_ops.video_edit_job_inputs i join agency_ops.video_edit_jobs j on j.id=i.job_id
  where i.drive_file_id=new.drive_file_id and j.id<>new.job_id and coalesce((j.metadata->>'auto_upload_batch')::boolean,false)=true
    and j.status in ('RENDERING','UPLOADING','QA') order by j.created_at desc limit 1;
  if v_auto_job_id is null then return new; end if;
  update agency_ops.video_edit_job_inputs set asset_id=coalesce(new.asset_id,asset_id),analysis_id=coalesce(new.analysis_id,analysis_id),
    duration_seconds=coalesce(new.duration_seconds,duration_seconds),content_hash=coalesce(new.content_hash,content_hash),
    fingerprint=coalesce(new.fingerprint,fingerprint),input_status=case when new.asset_id is not null then 'VERIFIED' else input_status end,
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('enriched_from_legacy_input',new.id)
  where job_id=v_auto_job_id and drive_file_id=new.drive_file_id;
  return new;
end $$;

drop trigger if exists trg_sync_v4_auto_input_from_legacy_input on agency_ops.video_edit_job_inputs;
create trigger trg_sync_v4_auto_input_from_legacy_input after insert on agency_ops.video_edit_job_inputs
for each row execute function agency_ops.sync_v4_auto_input_from_legacy_input();

create or replace function agency_ops.mark_drive_polling_watcher_active()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public','pg_catalog' as $$
begin
  if coalesce(new.source,'')='drive_watch' then
    update agency_ops.drive_change_watch_state set status='ACTIVE',
      last_notification_at=greatest(coalesce(last_notification_at,'epoch'::timestamptz),coalesce(new.detected_at,now())),
      last_success_at=greatest(coalesce(last_success_at,'epoch'::timestamptz),coalesce(new.detected_at,now())),last_error=null,
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('watcher_mode','N8N_POLLING','workflow','VideoDriveWatcherV1','interval_minutes',5),updated_at=now()
    where account_key='lakassessoriadigital';
  end if;
  return new;
end $$;
drop trigger if exists trg_mark_drive_polling_watcher_active on agency_ops.client_raw_material_uploads;
create trigger trg_mark_drive_polling_watcher_active after insert or update of detected_at on agency_ops.client_raw_material_uploads
for each row execute function agency_ops.mark_drive_polling_watcher_active();

update agency_ops.drive_change_watch_state s set status='ACTIVE',
  last_notification_at=coalesce((select max(r.detected_at) from agency_ops.client_raw_material_uploads r where r.source='drive_watch'),s.last_notification_at),
  last_success_at=coalesce((select max(r.detected_at) from agency_ops.client_raw_material_uploads r where r.source='drive_watch'),s.last_success_at),
  last_error=null,metadata=coalesce(s.metadata,'{}'::jsonb)||jsonb_build_object('watcher_mode','N8N_POLLING','workflow','VideoDriveWatcherV1','interval_minutes',5),updated_at=now()
where account_key='lakassessoriadigital';

create or replace function agency_ops.get_video_pipeline_health()
returns jsonb language sql security definer set search_path to 'agency_ops','public' as $$
with jobs as (
 select count(*) filter(where status='QUEUED') queued,count(*) filter(where status in ('ANALYZING','PLANNING','RENDERING','UPLOADING','QA')) processing,
 count(*) filter(where status='FAILED' and updated_at>now()-interval '24 hours') failed_24h,min(created_at) filter(where status='QUEUED') oldest_queued_at
 from agency_ops.video_edit_jobs),
analyses as (
 select count(*) filter(where analysis_status in ('PENDING','RETRY')) pending,count(*) filter(where analysis_status='RUNNING') running,
 count(*) filter(where analysis_status='FAILED' and updated_at>now()-interval '24 hours') failed_24h from agency_ops.creative_video_analysis),
ingests as (
 select jsonb_object_agg(source,jsonb_build_object('last_seen_at',last_seen_at,'ready',ready,'waiting',waiting)) sources from
 (select source,max(created_at) last_seen_at,count(*) filter(where status='READY') ready,count(*) filter(where status='WAITING_FOR_CONTEXT') waiting
  from agency_ops.video_ingest_events group by source)s),
workers as (
 select coalesce(jsonb_agg(jsonb_build_object('worker_id',worker_id,'worker_version',worker_version,'state',state,'current_job_id',current_job_id,
 'last_seen_at',last_seen_at,'stale',last_seen_at<now()-interval '2 minutes') order by last_seen_at desc),'[]'::jsonb) rows from agency_ops.video_worker_heartbeats),
drive_watch as (
 select jsonb_build_object('status',status,'mode',coalesce(metadata->>'watcher_mode',case when channel_id is not null then 'PUSH_CHANNEL' else 'UNKNOWN' end),
 'channel_active',status='ACTIVE' and ((channel_id is not null and (channel_expires_at is null or channel_expires_at>now())) or metadata->>'watcher_mode'='N8N_POLLING'),
 'expires_at',channel_expires_at,'last_notification_at',last_notification_at,'last_success_at',last_success_at,'last_error',last_error,'root_folder_id',root_folder_id) state
 from agency_ops.drive_change_watch_state where account_key='lakassessoriadigital' limit 1)
select jsonb_build_object(
 'generated_at',now(),
 'edit_enabled',coalesce((select value from agency_ops.automation_settings where key='VIDEO_EDIT_ENABLED' limit 1),'false'::jsonb),
 'v4_enabled',coalesce((select value from agency_ops.automation_settings where key='VIDEO_RENDERER_V4_ENABLED' limit 1),'false'::jsonb),
 'auto_edit_on_upload',coalesce((select value from agency_ops.automation_settings where key='VIDEO_AUTO_EDIT_ON_UPLOAD' limit 1),'false'::jsonb),
 'analysis_enabled',coalesce((select value from agency_ops.automation_settings where key='VIDEO_ANALYSIS_ENABLED' limit 1),'false'::jsonb),
 'jobs',jsonb_build_object('queued',jobs.queued,'processing',jobs.processing,'failed_24h',jobs.failed_24h,'oldest_queued_at',jobs.oldest_queued_at),
 'analysis',jsonb_build_object('pending',analyses.pending,'running',analyses.running,'failed_24h',analyses.failed_24h),
 'ingest_sources',coalesce((select sources from ingests),'{}'::jsonb),
 'workers',(select rows from workers),
 'drive_watch',coalesce((select state from drive_watch),jsonb_build_object('status','MISSING','channel_active',false)))
from jobs,analyses;
$$;

commit;
