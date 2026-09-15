-- Weekly client-facing HTML reports.
-- Monday Meta snapshot -> event-chained report queue -> tokenized public HTML.

create table if not exists agency_ops.weekly_client_reports (
  id uuid primary key default gen_random_uuid(),
  meta_run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text,
  week_start date not null,
  week_end date not null,
  public_token uuid not null default gen_random_uuid() unique,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','READY','REVIEW_REQUIRED','ERROR')),
  attempts integer not null default 0,
  locked_at timestamptz,
  snapshot jsonb not null default '{}'::jsonb,
  last_error text,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, week_end)
);

create index if not exists weekly_client_reports_week_idx
  on agency_ops.weekly_client_reports(week_end desc,status,gt_owner,client_name);
create index if not exists weekly_client_reports_claim_idx
  on agency_ops.weekly_client_reports(meta_run_id,status,attempts,id);
create index if not exists weekly_client_reports_client_idx
  on agency_ops.weekly_client_reports(client_id,week_end desc);

create or replace function agency_ops.invoke_weekly_client_reports(p_meta_run_id uuid)
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
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-weekly-client-reports',
    headers := jsonb_build_object('Content-Type','application/json','x-meta-campaign-secret',v_secret),
    body := jsonb_build_object('mode','start','meta_run_id',p_meta_run_id),
    timeout_milliseconds := 120000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function agency_ops.invoke_weekly_client_reports(uuid) from public;

create or replace function agency_ops.weekly_reports_after_meta_run()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $$
begin
  if new.status in ('COMPLETED','COMPLETED_WITH_ERRORS')
     and old.status is distinct from new.status
     and extract(isodow from new.snapshot_date) = 1 then
    perform agency_ops.invoke_weekly_client_reports(new.id);
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS trg_weekly_reports_after_meta_run ON agency_ops.meta_performance_runs;
create trigger trg_weekly_reports_after_meta_run
after update of status on agency_ops.meta_performance_runs
for each row execute function agency_ops.weekly_reports_after_meta_run();

-- Monday 05:15 America/Sao_Paulo (08:15 UTC): collect a fresh Monday-Sunday Meta snapshot.
-- Existing event-chained Meta worker does the heavy lifting in small batches.
select cron.unschedule(jobid) from cron.job where jobname='meta-performance-weekly-monday-client-report';
select cron.schedule(
  'meta-performance-weekly-monday-client-report',
  '15 8 * * 1',
  $$select agency_ops.invoke_meta_performance_weekly('start');$$
);
