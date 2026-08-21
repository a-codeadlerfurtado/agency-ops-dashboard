alter table agency_ops.weekend_balance_alerts
  add column if not exists rule_key text not null default 'FRIDAY_WEEKEND_100',
  add column if not exists threshold numeric not null default 100,
  add column if not exists run_key text;

create index if not exists weekend_balance_alerts_run_gt_idx
  on agency_ops.weekend_balance_alerts (run_key, target_gt);

create table if not exists agency_ops.balance_alert_runs (
  run_key text primary key,
  rule_key text not null,
  slot_key text not null,
  local_date date not null,
  threshold numeric not null,
  ran_at timestamptz not null default now(),
  matched_count integer not null default 0
);

create index if not exists balance_alert_runs_rule_date_idx
  on agency_ops.balance_alert_runs (rule_key, local_date, ran_at desc);

alter table agency_ops.balance_alert_runs enable row level security;
revoke all on agency_ops.balance_alert_runs from anon, authenticated;
grant all on agency_ops.balance_alert_runs to service_role;

create or replace function agency_ops.generate_balance_threshold_alerts(
  p_rule_key text,
  p_threshold numeric,
  p_slot text default null
)
returns integer
language plpgsql
security definer
set search_path to pg_catalog, agency_ops
as $function$
declare
  v_local_now timestamp := now() at time zone 'America/Sao_Paulo';
  v_local_date date := v_local_now::date;
  v_slot text := coalesce(nullif(trim(p_slot), ''), to_char(v_local_now, 'HH24:MI'));
  v_slot_key text;
  v_run_key text;
  v_count integer := 0;
begin
  if p_rule_key not in ('DAILY_CRITICAL_30', 'FRIDAY_WEEKEND_100') then
    raise exception 'unsupported balance alert rule: %', p_rule_key;
  end if;
  if p_threshold is null or p_threshold <= 0 then
    raise exception 'threshold must be positive';
  end if;

  v_slot_key := to_char(v_local_date, 'YYYY-MM-DD') || '-' || replace(v_slot, ':', '');
  v_run_key := p_rule_key || ':' || v_slot_key;

  insert into agency_ops.balance_alert_runs (run_key, rule_key, slot_key, local_date, threshold, ran_at, matched_count)
  values (v_run_key, p_rule_key, v_slot_key, v_local_date, p_threshold, now(), 0)
  on conflict (run_key) do update
    set threshold = excluded.threshold,
        ran_at = excluded.ran_at,
        matched_count = 0;

  -- Se o mesmo minuto for reprocessado, o snapshot do minuto deve refletir apenas
  -- quem ainda está com saldo baixo naquele momento.
  delete from agency_ops.weekend_balance_alerts where run_key = v_run_key;

  with low as (
    select
      c.id as client_id,
      c.display_name as client_name,
      c.gt_owner as target_gt,
      min(b.available_balance) as min_balance,
      max(b.checked_at) as checked_at,
      jsonb_agg(
        jsonb_build_object(
          'account_key', b.account_key,
          'available_balance', b.available_balance,
          'checked_at', b.checked_at,
          'funding_type_label', b.funding_type_label
        ) order by b.available_balance asc, b.account_key
      ) as low_accounts
    from agency_ops.account_ad_balances b
    join agency_ops.clients c on c.id = b.client_id
    join agency_ops.campaign_client_latest cl on cl.client_id = c.id
    where c.lifecycle in ('ACTIVE','ONBOARDING')
      and c.gt_owner is not null
      and coalesce(c.service, '') <> 'ia'
      and coalesce(cl.active_campaigns, 0) > 0
      and b.available_balance is not null
      and b.available_balance < p_threshold
      and b.balance_source is distinct from 'not_applicable_postpaid'
      and b.checked_at >= now() - interval '45 minutes'
    group by c.id, c.display_name, c.gt_owner
  )
  insert into agency_ops.weekend_balance_alerts (
    slot_key, slot_at, target_gt, client_id, client_name, min_balance, checked_at,
    low_accounts, rule_key, threshold, run_key
  )
  select
    v_slot_key, now(), target_gt, client_id, client_name, min_balance, checked_at,
    low_accounts, p_rule_key, p_threshold, v_run_key
  from low
  on conflict (slot_key, client_id) do update
    set slot_at = excluded.slot_at,
        target_gt = excluded.target_gt,
        client_name = excluded.client_name,
        min_balance = excluded.min_balance,
        checked_at = excluded.checked_at,
        low_accounts = excluded.low_accounts,
        rule_key = excluded.rule_key,
        threshold = excluded.threshold,
        run_key = excluded.run_key;

  get diagnostics v_count = row_count;

  update agency_ops.balance_alert_runs
  set matched_count = v_count, ran_at = now()
  where run_key = v_run_key;

  return v_count;
end;
$function$;

revoke all on function agency_ops.generate_balance_threshold_alerts(text,numeric,text) from public, anon, authenticated;
grant execute on function agency_ops.generate_balance_threshold_alerts(text,numeric,text) to service_role;

create or replace function agency_ops.dispatch_gt_balance_alerts()
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, agency_ops
as $function$
declare
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  v_hm text := to_char(v_local, 'HH24:MI');
  v_is_friday boolean := extract(isodow from v_local) = 5;
  v_hour integer := extract(hour from v_local);
  v_minute integer := extract(minute from v_local);
  v_daily integer := 0;
  v_friday integer := 0;
begin
  if v_hm in ('08:15','10:00','17:45') then
    v_daily := agency_ops.generate_balance_threshold_alerts('DAILY_CRITICAL_30', 30, v_hm);
  end if;

  if v_is_friday and v_hour >= 17 and mod(v_minute, 10) = 0 then
    v_friday := agency_ops.generate_balance_threshold_alerts('FRIDAY_WEEKEND_100', 100, v_hm);
  end if;

  return jsonb_build_object(
    'local_time', v_hm,
    'daily_critical_30', v_daily,
    'friday_weekend_100', v_friday
  );
end;
$function$;

revoke all on function agency_ops.dispatch_gt_balance_alerts() from public, anon, authenticated;
grant execute on function agency_ops.dispatch_gt_balance_alerts() to service_role;

do $jobs$
declare r record;
begin
  for r in
    select jobid from cron.job
    where jobname like 'agency_ops_weekend_balance_%'
       or jobname = 'agency_ops_balance_alert_dispatcher'
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end
$jobs$;

-- Executa a cada 5 minutos, mas a função só gera snapshot nos horários definidos
-- em America/Sao_Paulo. Assim o cron não depende do timezone UTC do pg_cron.
select cron.schedule(
  'agency_ops_balance_alert_dispatcher',
  '*/5 * * * *',
  $$select agency_ops.dispatch_gt_balance_alerts();$$
);
