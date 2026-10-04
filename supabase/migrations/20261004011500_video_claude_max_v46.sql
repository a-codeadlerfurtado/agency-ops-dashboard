begin;

insert into agency_ops.automation_settings(key,value,description,updated_at)
values
  ('VIDEO_CLAUDE_ENABLED','false'::jsonb,'Kill switch do cérebro Claude Max no renderer V4.6',now()),
  ('VIDEO_CLAUDE_VARIANT','"v4_claude_test"'::jsonb,'Variante isolada usada pelo worker Claude',now())
on conflict (key) do nothing;

create index if not exists video_v4_render_jobs_variant_claim_idx
  on agency_ops.video_v4_render_jobs(variant, priority desc, available_at, created_at)
  where status in ('QUEUED','RETRY');

create or replace function agency_ops.claim_video_v4_render_job_variant(
  p_worker_id text,
  p_variant text
)
returns agency_ops.video_v4_render_jobs
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
declare
  j agency_ops.video_v4_render_jobs;
  v4_enabled boolean := false;
  claude_enabled boolean := false;
begin
  if nullif(btrim(coalesce(p_variant,'')),'') is null then
    return null;
  end if;

  select coalesce((value #>> '{}')::boolean,false)
    into v4_enabled
    from agency_ops.automation_settings
   where key='VIDEO_RENDERER_V4_ENABLED';

  if not coalesce(v4_enabled,false) then
    return null;
  end if;

  if p_variant like 'v4_claude%' then
    select coalesce((value #>> '{}')::boolean,false)
      into claude_enabled
      from agency_ops.automation_settings
     where key='VIDEO_CLAUDE_ENABLED';

    if not coalesce(claude_enabled,false) then
      return null;
    end if;
  end if;

  select * into j
    from agency_ops.video_v4_render_jobs
   where status in ('QUEUED','RETRY')
     and available_at <= now()
     and variant = p_variant
   order by priority desc, created_at asc
   for update skip locked
   limit 1;

  if j.id is null then
    return null;
  end if;

  update agency_ops.video_v4_render_jobs
     set status='CLAIMED',
         worker_id=p_worker_id,
         locked_at=now(),
         heartbeat_at=now(),
         attempt_count=attempt_count+1,
         current_stage='PREPARING',
         progress_pct=2,
         updated_at=now()
   where id=j.id
   returning * into j;

  insert into agency_ops.video_edit_job_events(
    job_id,event_type,stage,worker_id,attempt_count,progress_pct,metrics
  )
  values(
    j.source_job_id,
    case when p_variant like 'v4_claude%' then 'V46_CLAUDE_CLAIMED' else 'V4_CLAIMED' end,
    'PREPARING',
    p_worker_id,
    j.attempt_count,
    j.progress_pct,
    jsonb_build_object(
      'v4_render_job_id',j.id,
      'timeline_id',j.timeline_id,
      'variant',j.variant
    )
  );

  return j;
end
$$;

create or replace function agency_ops.sync_v4_claude_source_job_status()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
begin
  if new.variant not like 'v4_claude%' then
    return new;
  end if;

  if new.status in ('CLAIMED','RENDERING') then
    update agency_ops.video_edit_jobs
       set status='RENDERING',
           current_stage='CLAUDE_'||coalesce(new.current_stage,new.status),
           progress_pct=greatest(progress_pct,least(99,new.progress_pct)),
           worker_id=new.worker_id,
           heartbeat_at=coalesce(new.heartbeat_at,now()),
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='UPLOADING' then
    update agency_ops.video_edit_jobs
       set status='UPLOADING',
           current_stage='CLAUDE_UPLOADING',
           progress_pct=greatest(progress_pct,90),
           worker_id=new.worker_id,
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='QA' then
    update agency_ops.video_edit_jobs
       set status='QA',
           current_stage='CLAUDE_QA',
           progress_pct=greatest(progress_pct,84),
           worker_id=new.worker_id,
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='COMPLETED' then
    update agency_ops.video_edit_jobs
       set status='REVIEW_REQUIRED',
           current_stage='REVIEW_REQUIRED',
           progress_pct=100,
           finished_at=coalesce(finished_at,now()),
           worker_id=new.worker_id,
           heartbeat_at=now(),
           renderer_version=coalesce(new.renderer_version,'4.6.0'),
           review_mode='RENDER_REVIEW',
           approval_status='PENDING',
           last_error=null,
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='FAILED' then
    update agency_ops.video_edit_jobs
       set status='FAILED',
           current_stage='CLAUDE_FAILED',
           finished_at=coalesce(finished_at,now()),
           worker_id=new.worker_id,
           heartbeat_at=now(),
           last_error=coalesce(new.last_error,'claude_v46_failed'),
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='CANCELLED' then
    update agency_ops.video_edit_jobs
       set status='CANCELLED',
           current_stage='CLAUDE_CANCELLED',
           finished_at=coalesce(finished_at,now()),
           updated_at=now()
     where id=new.source_job_id;
  elsif new.status='RETRY' then
    update agency_ops.video_edit_jobs
       set status='RENDERING',
           current_stage='CLAUDE_RETRY',
           last_error=new.last_error,
           updated_at=now()
     where id=new.source_job_id;
  end if;

  return new;
end
$$;

drop trigger if exists trg_sync_v4_claude_source_job_status on agency_ops.video_v4_render_jobs;
create trigger trg_sync_v4_claude_source_job_status
after insert or update of status,progress_pct,current_stage,worker_id,last_error
on agency_ops.video_v4_render_jobs
for each row execute function agency_ops.sync_v4_claude_source_job_status();

commit;
