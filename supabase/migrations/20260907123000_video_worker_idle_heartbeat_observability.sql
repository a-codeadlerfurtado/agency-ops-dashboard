create table if not exists agency_ops.video_worker_heartbeats (
  worker_id text primary key,
  worker_version text,
  state text not null default 'IDLE' check (state in ('IDLE','WORKING','ANALYZING','ERROR')),
  current_job_id uuid,
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table agency_ops.video_worker_heartbeats enable row level security;
revoke all on table agency_ops.video_worker_heartbeats from public, anon, authenticated;
grant all on table agency_ops.video_worker_heartbeats to service_role;

create index if not exists video_worker_heartbeats_last_seen_idx
  on agency_ops.video_worker_heartbeats(last_seen_at desc);

comment on table agency_ops.video_worker_heartbeats is
  'Heartbeat operacional dos renderers de vídeo; permite detectar worker offline mesmo sem job em andamento.';
