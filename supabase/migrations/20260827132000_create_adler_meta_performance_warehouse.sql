-- Adler-only historical Meta performance warehouse.
-- A Thursday cron only starts the run; work is drained by event-chained Edge workers.

create table if not exists agency_ops.meta_performance_runs (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  window_end date not null,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','ERROR')),
  total_clients integer not null default 0,
  processed_clients integer not null default 0,
  successful_clients integer not null default 0,
  error_clients integer not null default 0,
  no_meta_clients integer not null default 0,
  no_data_clients integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists agency_ops.meta_performance_queue (
  id bigint generated always as identity primary key,
  run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text,
  entrada date,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','DONE','ERROR')),
  attempts integer not null default 0,
  locked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, client_id)
);
create index if not exists meta_performance_queue_claim_idx on agency_ops.meta_performance_queue(run_id,status,id);
create index if not exists meta_performance_queue_client_idx on agency_ops.meta_performance_queue(client_id,created_at desc);

create table if not exists agency_ops.meta_performance_snapshots (
  id bigint generated always as identity primary key,
  run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text,
  snapshot_date date not null,
  period_days smallint not null check (period_days in (3,7,14,30)),
  date_from date not null,
  date_to date not null,
  requested_period_days smallint not null,
  available_period_days smallint not null default 0,
  is_partial_period boolean not null default false,
  meta_ad_account_ids jsonb not null default '[]'::jsonb,
  account_count integer not null default 0,
  spend numeric(16,2), impressions bigint, reach bigint, clicks bigint,
  ctr numeric(12,6), cpc numeric(16,6), cpm numeric(16,6), frequency numeric(12,6),
  leads numeric(16,2), results numeric(16,2), cpl numeric(16,6), cost_per_result numeric(16,6),
  campaign_count integer not null default 0,
  active_campaigns integer not null default 0,
  paused_campaigns integer not null default 0,
  data_status text not null,
  collected_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(run_id, client_id, period_days)
);
create index if not exists meta_performance_snapshots_client_idx on agency_ops.meta_performance_snapshots(client_id,snapshot_date desc,period_days);
create index if not exists meta_performance_snapshots_run_idx on agency_ops.meta_performance_snapshots(run_id,period_days,client_name);

create table if not exists agency_ops.meta_campaign_performance_snapshots (
  id bigint generated always as identity primary key,
  run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text,
  snapshot_date date not null,
  period_days smallint not null check (period_days in (3,7,14,30)),
  date_from date not null, date_to date not null,
  meta_ad_account_id text not null,
  campaign_id text not null,
  campaign_name text, campaign_status text, objective text,
  spend numeric(16,2), impressions bigint, reach bigint, clicks bigint,
  ctr numeric(12,6), cpc numeric(16,6), cpm numeric(16,6), frequency numeric(12,6),
  leads numeric(16,2), results numeric(16,2), cpl numeric(16,6), cost_per_result numeric(16,6),
  result_type text, result_source text,
  data_status text not null default 'OK',
  collected_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(run_id, client_id, period_days, meta_ad_account_id, campaign_id)
);
create index if not exists meta_campaign_performance_snapshots_client_idx on agency_ops.meta_campaign_performance_snapshots(client_id,snapshot_date desc,period_days);
create index if not exists meta_campaign_performance_snapshots_run_idx on agency_ops.meta_campaign_performance_snapshots(run_id,period_days,client_name);

create or replace function agency_ops.invoke_meta_performance_weekly(p_mode text default 'start')
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  v_secret := agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET');
  if v_secret is null or length(trim(v_secret)) < 20 then
    raise exception 'META_CAMPAIGN_SYNC_SECRET missing from Vault';
  end if;
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meta-performance-weekly',
    headers := jsonb_build_object('Content-Type','application/json','x-meta-campaign-secret',v_secret),
    body := jsonb_build_object('mode',coalesce(nullif(p_mode,''),'start')),
    timeout_milliseconds := 120000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function agency_ops.invoke_meta_performance_weekly(text) from public;

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values('meta_performance','PERSON','Adler Furtado',true,'Performance Meta e histórico semanal: exclusivo do Adler',now())
on conflict (view_key,scope_type,scope_value) do update set allowed=excluded.allowed,note=excluded.note,updated_at=now();

select cron.unschedule(jobid) from cron.job where jobname='meta-performance-weekly-thursday';
select cron.schedule('meta-performance-weekly-thursday','20 12 * * 4',$$select agency_ops.invoke_meta_performance_weekly('start');$$);
