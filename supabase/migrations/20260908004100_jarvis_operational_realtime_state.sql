-- Memoria operacional em tempo real da Jarvis.
-- Snapshot derivado de fontes canonicas; tabelas nao ficam expostas ao browser.
create table if not exists agency_ops.jarvis_client_state (
  client_id uuid primary key,
  display_name text not null,
  lifecycle text,
  gt_owner text,
  cs_owner text,
  designer_owner text,
  leads_today numeric,
  spend_today numeric,
  cpl_today numeric,
  today_checked_at timestamptz,
  leads_yesterday numeric,
  spend_yesterday numeric,
  cpl_yesterday numeric,
  yesterday_checked_at timestamptz,
  spend_7d numeric,
  media_latest_date date,
  media_checked_at timestamptz,
  active_campaigns integer,
  campaign_count integer,
  meta_balance numeric,
  meta_available_balance numeric,
  meta_currency text,
  balance_run_status text,
  balance_checked_at timestamptz,
  state_updated_at timestamptz not null default now()
);
create index if not exists jarvis_client_state_lifecycle_idx on agency_ops.jarvis_client_state(lifecycle);
create index if not exists jarvis_client_state_gt_idx on agency_ops.jarvis_client_state(gt_owner);create index if not exists jarvis_client_state_cs_idx on agency_ops.jarvis_client_state(cs_owner);

create table if not exists agency_ops.jarvis_operation_state (
  state_key text primary key default 'global',
  active_clients integer not null default 0,
  onboarding_clients integer not null default 0,
  team_counts jsonb not null default '{}'::jsonb,
  leads_today_total numeric,
  leads_today_coverage integer not null default 0,
  spend_today_total numeric,
  leads_yesterday_total numeric,
  leads_yesterday_coverage integer not null default 0,
  spend_yesterday_total numeric,
  spend_7d_total numeric,
  clients_low_balance uuid[] not null default '{}'::uuid[],
  clients_without_active_campaigns uuid[] not null default '{}'::uuid[],
  updated_at timestamptz not null default now()
);

alter table agency_ops.jarvis_client_state enable row level security;
alter table agency_ops.jarvis_operation_state enable row level security;
revoke all on agency_ops.jarvis_client_state, agency_ops.jarvis_operation_state from anon, authenticated;
grant all on agency_ops.jarvis_client_state, agency_ops.jarvis_operation_state to service_role;

create or replace function agency_ops.refresh_jarvis_operational_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_person text;
  v_role text;
  v_count integer;
begin
  if auth.uid() is not null then
    select tr.person, upper(tr.role) into v_person, v_role
    from agency_ops.user_preferences up
    join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
    where up.user_key = auth.uid()::text limit 1;
    if coalesce(v_role,'') <> 'MGMT' then raise exception 'forbidden'; end if;
  end if;

  insert into agency_ops.jarvis_client_state as s (
    client_id, display_name, lifecycle, gt_owner, cs_owner, designer_owner,
    leads_today, spend_today, cpl_today, today_checked_at,
    leads_yesterday, spend_yesterday, cpl_yesterday, yesterday_checked_at,
    spend_7d, media_latest_date, media_checked_at, active_campaigns, campaign_count,
    meta_balance, meta_available_balance, meta_currency, balance_run_status, balance_checked_at,
    state_updated_at
  )
  select
    c.client_id, c.display_name, c.lifecycle, c.gt_owner, c.cs_owner, c.designer_owner,
    td.leads, td.spend, case when coalesce(td.leads,0) > 0 then td.spend / td.leads else null end, td.checked_at,
    yd.leads, yd.spend, case when coalesce(yd.leads,0) > 0 then yd.spend / yd.leads else null end, yd.checked_at,
    d7.spend_7d, camp.latest_date, camp.checked_at,
    camp.active_campaigns::integer, camp.campaign_count::integer,
    bal.balance, bal.available_balance, bal.currency, bal.run_status, bal.checked_at, now()
  from agency_ops.dashboard_client_overview c  left join lateral (
    select sum(i.leads_estimate) as leads, sum(i.spend) as spend, max(i.checked_at) as checked_at
    from agency_ops.meta_campaign_insights i
    where i.client_id = c.client_id and i.date_start = v_today and i.date_stop = v_today
  ) td on true
  left join lateral (
    select sum(i.leads_estimate) as leads, sum(i.spend) as spend, max(i.checked_at) as checked_at
    from agency_ops.meta_campaign_insights i
    where i.client_id = c.client_id and i.date_start = (v_today - 1) and i.date_stop = (v_today - 1)
  ) yd on true
  left join lateral (
    select sum(i.spend) as spend_7d
    from agency_ops.meta_campaign_insights i
    where i.client_id = c.client_id and i.date_start = i.date_stop
      and i.date_start between (v_today - 6) and v_today
  ) d7 on true
  left join agency_ops.campaign_client_latest camp on camp.client_id = c.client_id
  left join lateral (
    select sum(b.balance) as balance, sum(b.available_balance) as available_balance,
           max(b.currency) as currency,
           case when bool_or(b.run_status = 'BLOCKED') then 'BLOCKED'
                when bool_or(b.run_status = 'LOW_BALANCE') then 'LOW_BALANCE'
                when bool_or(b.run_status = 'OK') then 'OK'
                when bool_or(b.run_status = 'NO_ACTIVE_CAMPAIGN') then 'NO_ACTIVE_CAMPAIGN'
                when bool_or(b.run_status = 'NO_BALANCE') then 'NO_BALANCE'
                when bool_or(b.run_status = 'NO_ACCOUNT') then 'NO_ACCOUNT'
                else max(b.run_status) end as run_status,
           max(b.checked_at) as checked_at
    from agency_ops.client_balance_overview b where b.client_id = c.client_id
  ) bal on true  on conflict (client_id) do update set
    display_name = excluded.display_name,
    lifecycle = excluded.lifecycle,
    gt_owner = excluded.gt_owner,
    cs_owner = excluded.cs_owner,
    designer_owner = excluded.designer_owner,
    leads_today = excluded.leads_today,
    spend_today = excluded.spend_today,
    cpl_today = excluded.cpl_today,
    today_checked_at = excluded.today_checked_at,
    leads_yesterday = excluded.leads_yesterday,
    spend_yesterday = excluded.spend_yesterday,
    cpl_yesterday = excluded.cpl_yesterday,
    yesterday_checked_at = excluded.yesterday_checked_at,
    spend_7d = excluded.spend_7d,
    media_latest_date = excluded.media_latest_date,
    media_checked_at = excluded.media_checked_at,
    active_campaigns = excluded.active_campaigns,
    campaign_count = excluded.campaign_count,
    meta_balance = excluded.meta_balance,
    meta_available_balance = excluded.meta_available_balance,
    meta_currency = excluded.meta_currency,
    balance_run_status = excluded.balance_run_status,
    balance_checked_at = excluded.balance_checked_at,
    state_updated_at = excluded.state_updated_at;

  insert into agency_ops.jarvis_operation_state as o (
    state_key, active_clients, onboarding_clients, team_counts,
    leads_today_total, leads_today_coverage, spend_today_total,
    leads_yesterday_total, leads_yesterday_coverage, spend_yesterday_total,    spend_7d_total, clients_low_balance, clients_without_active_campaigns, updated_at
  )
  select 'global',
    count(*) filter (where s.lifecycle = 'ACTIVE')::integer,
    count(*) filter (where s.lifecycle = 'ONBOARDING')::integer,
    coalesce((select jsonb_object_agg(x.role, x.cnt) from (
      select upper(role) as role, count(*)::integer as cnt
      from agency_ops.team_roster where is_former = false group by upper(role)
    ) x), '{}'::jsonb),
    sum(s.leads_today) filter (where s.lifecycle = 'ACTIVE'),
    count(*) filter (where s.lifecycle = 'ACTIVE' and s.today_checked_at is not null)::integer,
    sum(s.spend_today) filter (where s.lifecycle = 'ACTIVE'),
    sum(s.leads_yesterday) filter (where s.lifecycle = 'ACTIVE'),
    count(*) filter (where s.lifecycle = 'ACTIVE' and s.yesterday_checked_at is not null)::integer,
    sum(s.spend_yesterday) filter (where s.lifecycle = 'ACTIVE'),
    sum(s.spend_7d) filter (where s.lifecycle = 'ACTIVE'),
    coalesce(array_agg(s.client_id) filter (where s.lifecycle = 'ACTIVE' and s.balance_run_status = 'LOW_BALANCE'), '{}'::uuid[]),
    coalesce(array_agg(s.client_id) filter (where s.lifecycle = 'ACTIVE' and coalesce(s.active_campaigns,0) = 0), '{}'::uuid[]),
    now()
  from agency_ops.jarvis_client_state s
  on conflict (state_key) do update set
    active_clients = excluded.active_clients,
    onboarding_clients = excluded.onboarding_clients,
    team_counts = excluded.team_counts,
    leads_today_total = excluded.leads_today_total,
    leads_today_coverage = excluded.leads_today_coverage,
    spend_today_total = excluded.spend_today_total,
    leads_yesterday_total = excluded.leads_yesterday_total,
    leads_yesterday_coverage = excluded.leads_yesterday_coverage,    spend_yesterday_total = excluded.spend_yesterday_total,
    spend_7d_total = excluded.spend_7d_total,
    clients_low_balance = excluded.clients_low_balance,
    clients_without_active_campaigns = excluded.clients_without_active_campaigns,
    updated_at = excluded.updated_at;

  select count(*)::integer into v_count from agency_ops.jarvis_client_state;
  return jsonb_build_object('ok', true, 'clients', v_count, 'updated_at', now());
end;
$$;

create or replace function agency_ops.jarvis_client_snapshot(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person text;
  v_role text;
  v_state agency_ops.jarvis_client_state%rowtype;
begin
  select tr.person, upper(tr.role) into v_person, v_role
  from agency_ops.user_preferences up
  join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
  where up.user_key = auth.uid()::text
  limit 1;  if v_role is null then return null; end if;

  select * into v_state
  from agency_ops.jarvis_client_state
  where client_id = p_client_id;
  if not found then return null; end if;

  if v_role <> 'MGMT'
     and not (v_role = 'GT' and v_state.gt_owner = v_person)
     and not (v_role = 'CS' and v_state.cs_owner = v_person)
     and not (v_role = 'DESIGN' and v_state.designer_owner = v_person) then
    return null;
  end if;
  return to_jsonb(v_state);
end;
$$;

create or replace function agency_ops.jarvis_operation_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_state agency_ops.jarvis_operation_state%rowtype;
begin
  select upper(tr.role) into v_role  from agency_ops.user_preferences up
  join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
  where up.user_key = auth.uid()::text
  limit 1;
  if v_role <> 'MGMT' then return null; end if;

  select * into v_state
  from agency_ops.jarvis_operation_state
  where state_key = 'global';
  if not found then return null; end if;
  return to_jsonb(v_state);
end;
$$;

revoke execute on function agency_ops.refresh_jarvis_operational_state() from public, anon;
revoke execute on function agency_ops.jarvis_client_snapshot(uuid) from public, anon;
revoke execute on function agency_ops.jarvis_operation_snapshot() from public, anon;
grant execute on function agency_ops.refresh_jarvis_operational_state() to authenticated, service_role;
grant execute on function agency_ops.jarvis_client_snapshot(uuid) to authenticated, service_role;
grant execute on function agency_ops.jarvis_operation_snapshot() to authenticated, service_role;
