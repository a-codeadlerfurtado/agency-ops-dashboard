create or replace function agency_ops.get_video_pipeline_health()
returns jsonb
language sql
security definer
set search_path to 'agency_ops','public'
as $function$
with jobs as (
  select
    count(*) filter (where status='QUEUED') as queued,
    count(*) filter (where status in ('ANALYZING','PLANNING','RENDERING','UPLOADING','QA')) as processing,
    count(*) filter (where status='FAILED' and updated_at > now()-interval '24 hours') as failed_24h,
    min(created_at) filter (where status='QUEUED') as oldest_queued_at
  from agency_ops.video_edit_jobs
), analyses as (
  select
    count(*) filter (where analysis_status in ('PENDING','RETRY')) as pending,
    count(*) filter (where analysis_status='RUNNING') as running,
    count(*) filter (where analysis_status='FAILED' and updated_at > now()-interval '24 hours') as failed_24h
  from agency_ops.creative_video_analysis
), ingests as (
  select jsonb_object_agg(source, jsonb_build_object('last_seen_at',last_seen_at,'ready',ready,'waiting',waiting)) as sources
  from (
    select source,max(created_at) as last_seen_at,
      count(*) filter (where status='READY') as ready,
      count(*) filter (where status='WAITING_FOR_CONTEXT') as waiting
    from agency_ops.video_ingest_events
    group by source
  ) s
), workers as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id',worker_id,
    'worker_version',worker_version,
    'state',state,
    'current_job_id',current_job_id,
    'last_seen_at',last_seen_at,
    'stale',last_seen_at < now()-interval '2 minutes'
  ) order by last_seen_at desc),'[]'::jsonb) as rows
  from agency_ops.video_worker_heartbeats
), drive_watch as (
  select jsonb_build_object(
    'status',status,
    'channel_active',status='ACTIVE' and channel_id is not null and (channel_expires_at is null or channel_expires_at>now()),
    'expires_at',channel_expires_at,
    'last_notification_at',last_notification_at,
    'last_success_at',last_success_at,
    'last_error',last_error,
    'root_folder_id',root_folder_id
  ) as state
  from agency_ops.drive_change_watch_state
  where account_key='lakassessoriadigital'
  limit 1
)
select jsonb_build_object(
  'generated_at',now(),
  'edit_enabled',coalesce((select value from agency_ops.automation_settings where key='VIDEO_EDIT_ENABLED' limit 1),'false'::jsonb),
  'analysis_enabled',coalesce((select value from agency_ops.automation_settings where key='VIDEO_ANALYSIS_ENABLED' limit 1),'false'::jsonb),
  'jobs',jsonb_build_object('queued',jobs.queued,'processing',jobs.processing,'failed_24h',jobs.failed_24h,'oldest_queued_at',jobs.oldest_queued_at),
  'analysis',jsonb_build_object('pending',analyses.pending,'running',analyses.running,'failed_24h',analyses.failed_24h),
  'ingest_sources',coalesce((select sources from ingests),'{}'::jsonb),
  'workers',(select rows from workers),
  'drive_watch',coalesce((select state from drive_watch),jsonb_build_object('status','MISSING','channel_active',false))
)
from jobs,analyses;
$function$;

revoke all on function agency_ops.get_video_pipeline_health() from public, anon, authenticated;
grant execute on function agency_ops.get_video_pipeline_health() to service_role;
