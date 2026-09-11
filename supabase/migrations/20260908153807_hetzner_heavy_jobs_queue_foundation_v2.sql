create schema if not exists pgmq;
create extension if not exists pgmq with schema pgmq;

create table if not exists agency_ops.heavy_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  progress smallint not null default 0 check (progress between 0 and 100),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists heavy_jobs_claim_idx
  on agency_ops.heavy_jobs(status, available_at, created_at)
  where status in ('PENDING','FAILED');

create unique index if not exists heavy_jobs_active_dedupe_uidx
  on agency_ops.heavy_jobs(job_type, dedupe_key)
  where dedupe_key is not null and status in ('PENDING','RUNNING');

revoke all on agency_ops.heavy_jobs from public, anon, authenticated;
grant select, insert, update, delete on agency_ops.heavy_jobs to service_role;

select pgmq.create('agency_heavy_jobs')
where not exists (select 1 from pgmq.meta where queue_name = 'agency_heavy_jobs');
