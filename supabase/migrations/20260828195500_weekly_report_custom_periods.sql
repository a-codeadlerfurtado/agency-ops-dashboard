-- Extend client-facing reports to support arbitrary closed date ranges and audited generation.

alter table agency_ops.weekly_client_reports alter column meta_run_id drop not null;

alter table agency_ops.weekly_client_reports
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists report_kind text not null default 'WEEKLY',
  add column if not exists generation_source text not null default 'META_SNAPSHOT',
  add column if not exists generation_batch_id uuid,
  add column if not exists requested_by text,
  add column if not exists requested_scope text,
  add column if not exists report_version integer not null default 1,
  add column if not exists audit_status text not null default 'NOT_RUN';

update agency_ops.weekly_client_reports
set period_start = coalesce(period_start, week_start),
    period_end = coalesce(period_end, week_end)
where period_start is null or period_end is null;

alter table agency_ops.weekly_client_reports
  alter column period_start set not null,
  alter column period_end set not null;

alter table agency_ops.weekly_client_reports
  drop constraint if exists weekly_client_reports_client_id_week_end_key;

alter table agency_ops.weekly_client_reports
  drop constraint if exists weekly_client_reports_report_kind_check;
alter table agency_ops.weekly_client_reports
  add constraint weekly_client_reports_report_kind_check check (report_kind in ('WEEKLY','CUSTOM'));

alter table agency_ops.weekly_client_reports
  drop constraint if exists weekly_client_reports_generation_source_check;
alter table agency_ops.weekly_client_reports
  add constraint weekly_client_reports_generation_source_check check (generation_source in ('META_SNAPSHOT','META_DIRECT'));

alter table agency_ops.weekly_client_reports
  drop constraint if exists weekly_client_reports_audit_status_check;
alter table agency_ops.weekly_client_reports
  add constraint weekly_client_reports_audit_status_check check (audit_status in ('NOT_RUN','PASS','FAIL'));

create unique index if not exists weekly_client_reports_period_version_uidx
  on agency_ops.weekly_client_reports(client_id, period_start, period_end, report_version);
create unique index if not exists weekly_client_reports_meta_run_client_uidx
  on agency_ops.weekly_client_reports(meta_run_id, client_id)
  where meta_run_id is not null;
create index if not exists weekly_client_reports_period_idx
  on agency_ops.weekly_client_reports(period_end desc, period_start desc, gt_owner, status);

create table if not exists agency_ops.weekly_report_batches (
  id uuid primary key default gen_random_uuid(),
  meta_run_id uuid references agency_ops.meta_performance_runs(id) on delete set null,
  period_start date not null,
  period_end date not null,
  report_kind text not null check (report_kind in ('WEEKLY','CUSTOM')),
  generation_source text not null check (generation_source in ('META_SNAPSHOT','META_DIRECT')),
  scope_type text not null check (scope_type in ('ALL','GT','CLIENT')),
  scope_value text,
  requested_by text,
  automatic boolean not null default false,
  status text not null default 'RUNNING' check (status in ('RUNNING','COMPLETED','COMPLETED_WITH_ERRORS')),
  total_reports integer not null default 0,
  ready_reports integer not null default 0,
  review_reports integer not null default 0,
  error_reports integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

alter table agency_ops.weekly_client_reports
  drop constraint if exists weekly_client_reports_generation_batch_id_fkey;
alter table agency_ops.weekly_client_reports
  add constraint weekly_client_reports_generation_batch_id_fkey
  foreign key (generation_batch_id) references agency_ops.weekly_report_batches(id) on delete set null;

create index if not exists weekly_report_batches_created_idx
  on agency_ops.weekly_report_batches(created_at desc, period_end desc);
create index if not exists weekly_client_reports_batch_claim_idx
  on agency_ops.weekly_client_reports(generation_batch_id, status, attempts, id);

create or replace function agency_ops.invoke_weekly_client_reports_custom(
  p_date_from date,
  p_date_to date,
  p_scope_type text default 'ALL',
  p_scope_value text default null,
  p_requested_by text default null
)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $$
declare
  v_secret text;
  v_request_id bigint;
  v_scope text := upper(coalesce(nullif(trim(p_scope_type),''),'ALL'));
begin
  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception 'invalid report period';
  end if;
  if p_date_to >= (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'report period must end before today';
  end if;
  if v_scope not in ('ALL','GT','CLIENT') then
    raise exception 'invalid report scope';
  end if;

  v_secret := agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET');
  if v_secret is null or length(trim(v_secret)) < 20 then
    raise exception 'META_CAMPAIGN_SYNC_SECRET missing from Vault';
  end if;

  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-weekly-client-reports',
    headers := jsonb_build_object('Content-Type','application/json','x-meta-campaign-secret',v_secret),
    body := jsonb_build_object(
      'mode','start_custom',
      'date_from',p_date_from,
      'date_to',p_date_to,
      'scope_type',v_scope,
      'scope_value',p_scope_value,
      'requested_by',p_requested_by
    ),
    timeout_milliseconds := 120000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function agency_ops.invoke_weekly_client_reports_custom(date,date,text,text,text) from public;
