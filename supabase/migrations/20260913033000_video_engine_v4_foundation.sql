begin;

create table if not exists agency_ops.video_timelines (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references agency_ops.video_edit_jobs(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  spec_version text not null default 'timeline-v1',
  director_version text not null default 'creative-director-v4.0.0',
  status text not null default 'READY' check (status in ('DRAFT','READY','RENDERING','RENDERED','FAILED','SUPERSEDED')),
  is_active boolean not null default true,
  timeline jsonb not null,
  timeline_hash text,
  source text not null default 'AUTO' check (source in ('AUTO','HUMAN','HYBRID')),
  created_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, version)
);

create unique index if not exists video_timelines_one_active_per_job
  on agency_ops.video_timelines(job_id)
  where is_active;
create index if not exists video_timelines_job_created_idx
  on agency_ops.video_timelines(job_id, created_at desc);

create table if not exists agency_ops.video_v4_render_jobs (
  id uuid primary key default gen_random_uuid(),
  source_job_id uuid not null references agency_ops.video_edit_jobs(id) on delete cascade,
  timeline_id uuid not null references agency_ops.video_timelines(id) on delete cascade,
  variant text not null default 'v4_shadow',
  status text not null default 'QUEUED' check (status in ('QUEUED','RETRY','CLAIMED','RENDERING','UPLOADING','QA','COMPLETED','FAILED','CANCELLED')),
  priority smallint not null default 50,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  heartbeat_at timestamptz,
  worker_id text,
  attempt_count integer not null default 0,
  progress_pct smallint not null default 0 check (progress_pct between 0 and 100),
  current_stage text,
  last_error text,
  output_id bigint references agency_ops.video_edit_job_outputs(id) on delete set null,
  renderer_version text not null default 'leonardo-renderer-v4.0.0',
  render_metadata jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists video_v4_render_jobs_claim_idx
  on agency_ops.video_v4_render_jobs(priority desc, available_at, created_at)
  where status in ('QUEUED','RETRY');
create index if not exists video_v4_render_jobs_source_idx
  on agency_ops.video_v4_render_jobs(source_job_id, created_at desc);

alter table agency_ops.video_timelines enable row level security;
alter table agency_ops.video_v4_render_jobs enable row level security;

insert into agency_ops.automation_settings(key,value,description,updated_at)
values
  ('VIDEO_RENDERER_V4_ENABLED','false'::jsonb,'Kill switch do renderer profissional V4',now()),
  ('VIDEO_RENDERER_V4_SHADOW_ENABLED','true'::jsonb,'Gera V4 em paralelo sem substituir o renderer 3.0.5',now())
on conflict (key) do nothing;

create or replace function agency_ops.claim_video_v4_render_job(p_worker_id text)
returns agency_ops.video_v4_render_jobs
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
declare
  j agency_ops.video_v4_render_jobs;
  enabled boolean;
begin
  select coalesce((value #>> '{}')::boolean,false)
    into enabled
    from agency_ops.automation_settings
   where key='VIDEO_RENDERER_V4_ENABLED';
  if not coalesce(enabled,false) then return null; end if;

  select * into j
    from agency_ops.video_v4_render_jobs
   where status in ('QUEUED','RETRY') and available_at<=now()
   order by priority desc, created_at asc
   for update skip locked
   limit 1;
  if j.id is null then return null; end if;

  update agency_ops.video_v4_render_jobs
     set status='CLAIMED', worker_id=p_worker_id, locked_at=now(), heartbeat_at=now(),
         attempt_count=attempt_count+1, current_stage='PREPARING', progress_pct=2, updated_at=now()
   where id=j.id
   returning * into j;

  insert into agency_ops.video_edit_job_events(job_id,event_type,stage,worker_id,attempt_count,progress_pct,metrics)
  values(j.source_job_id,'V4_CLAIMED','PREPARING',p_worker_id,j.attempt_count,j.progress_pct,jsonb_build_object('v4_render_job_id',j.id,'timeline_id',j.timeline_id));
  return j;
end $$;

create or replace function agency_ops.requeue_stale_video_v4_render_jobs(p_stale_minutes integer default 20, p_max_attempts integer default 3)
returns integer
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
declare n integer;
begin
  with stale as (
    select id from agency_ops.video_v4_render_jobs
     where status in ('CLAIMED','RENDERING','UPLOADING','QA')
       and coalesce(heartbeat_at,locked_at,updated_at)<now()-make_interval(mins=>greatest(1,p_stale_minutes))
     for update skip locked
  ), upd as (
    update agency_ops.video_v4_render_jobs j set
      status=case when j.attempt_count<greatest(1,p_max_attempts) then 'RETRY' else 'FAILED' end,
      current_stage=case when j.attempt_count<greatest(1,p_max_attempts) then 'RECOVERING' else 'FAILED' end,
      worker_id=null, locked_at=null, heartbeat_at=null,
      available_at=case when j.attempt_count<greatest(1,p_max_attempts) then now()+interval '30 seconds' else j.available_at end,
      finished_at=case when j.attempt_count<greatest(1,p_max_attempts) then null else now() end,
      last_error='stale_v4_worker_recovered', updated_at=now()
    from stale s where j.id=s.id returning j.*
  )
  select count(*)::integer into n from upd;
  return n;
end $$;

commit;
