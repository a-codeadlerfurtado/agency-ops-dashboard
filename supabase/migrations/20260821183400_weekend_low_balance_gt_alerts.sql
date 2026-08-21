create table if not exists agency_ops.weekend_balance_alerts (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null,
  slot_at timestamptz not null default now(),
  target_gt text not null,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  min_balance numeric not null,
  checked_at timestamptz not null,
  low_accounts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (slot_key, client_id)
);

create index if not exists weekend_balance_alerts_gt_slot_idx
  on agency_ops.weekend_balance_alerts (target_gt, slot_at desc);

create table if not exists agency_ops.weekend_balance_alert_reads (
  alert_id uuid not null references agency_ops.weekend_balance_alerts(id) on delete cascade,
  user_key text not null,
  read_at timestamptz not null default now(),
  primary key (alert_id, user_key)
);

alter table agency_ops.weekend_balance_alerts enable row level security;
alter table agency_ops.weekend_balance_alert_reads enable row level security;
revoke all on agency_ops.weekend_balance_alerts from anon, authenticated;
revoke all on agency_ops.weekend_balance_alert_reads from anon, authenticated;
grant all on agency_ops.weekend_balance_alerts to service_role;
grant all on agency_ops.weekend_balance_alert_reads to service_role;

create or replace function agency_ops.generate_weekend_low_balance_alerts(p_slot text default null)
returns integer
language plpgsql
security definer
set search_path to pg_catalog, agency_ops
as $function$
declare
  v_local_date date := (now() at time zone 'America/Sao_Paulo')::date;
  v_slot text := coalesce(nullif(trim(p_slot), ''), to_char(now() at time zone 'America/Sao_Paulo', 'HH24:MI'));
  v_slot_key text;
  v_count integer := 0;
begin
  v_slot_key := to_char(v_local_date, 'YYYY-MM-DD') || '-' || replace(v_slot, ':', '');

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
      and b.available_balance < 100
      and b.balance_source is distinct from 'not_applicable_postpaid'
      and b.checked_at >= now() - interval '45 minutes'
    group by c.id, c.display_name, c.gt_owner
  )
  insert into agency_ops.weekend_balance_alerts (
    slot_key, slot_at, target_gt, client_id, client_name, min_balance, checked_at, low_accounts
  )
  select v_slot_key, now(), target_gt, client_id, client_name, min_balance, checked_at, low_accounts
  from low
  on conflict (slot_key, client_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function agency_ops.generate_weekend_low_balance_alerts(text) from public, anon, authenticated;
grant execute on function agency_ops.generate_weekend_low_balance_alerts(text) to service_role;

do $jobs$
declare r record;
begin
  for r in select jobid from cron.job where jobname in (
    'agency_ops_weekend_balance_1800',
    'agency_ops_weekend_balance_1830',
    'agency_ops_weekend_balance_1835'
  ) loop
    perform cron.unschedule(r.jobid);
  end loop;
end
$jobs$;

select cron.schedule('agency_ops_weekend_balance_1800', '0 18 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:00');$$);
select cron.schedule('agency_ops_weekend_balance_1830', '30 18 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:30');$$);
select cron.schedule('agency_ops_weekend_balance_1835', '35 18 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:35');$$);
