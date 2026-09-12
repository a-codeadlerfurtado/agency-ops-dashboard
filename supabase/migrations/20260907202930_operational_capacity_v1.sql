-- Capacidade Operacional v1
-- Motor gerencial do dashboard interno. Nao cria capacidade ficticia: sem calibracao,
-- capacity_points permanece NULL e a UI informa "nao calibrado".

create table if not exists agency_ops.capacity_settings (
  scope_type text not null check (scope_type in ('PERSON','AREA')),
  scope_id text not null,
  capacity_points numeric(10,2),
  warning_threshold numeric(5,2) not null default 70,
  high_threshold numeric(5,2) not null default 85,
  critical_threshold numeric(5,2) not null default 90,
  overload_threshold numeric(5,2) not null default 100,
  hiring_lead_time_days integer not null default 14,
  monthly_cost numeric(12,2),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_id),
  check (capacity_points is null or capacity_points > 0)
);

create table if not exists agency_ops.client_workload_overrides (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  score_override numeric(6,2) not null check (score_override > 0 and score_override <= 3),  reason text not null,
  valid_until date,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.operational_capacity_snapshots (
  snapshot_date date not null,
  scope_type text not null check (scope_type in ('CLIENT','PERSON','AREA','OPERATION')),
  scope_id text not null,
  client_count integer,
  workload_points numeric(12,2),
  capacity_points numeric(12,2),
  utilization_pct numeric(8,2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (snapshot_date, scope_type, scope_id)
);

create index if not exists operational_capacity_snapshots_scope_idx
  on agency_ops.operational_capacity_snapshots (scope_type, scope_id, snapshot_date desc);

create table if not exists agency_ops.workload_weight_config (
  metric_key text primary key,
  weight numeric(6,4) not null check (weight >= 0 and weight <= 1),
  enabled boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,  updated_at timestamptz not null default now()
);

insert into agency_ops.workload_weight_config(metric_key,weight,enabled,configuration) values
  ('whatsapp',  0.25, true, '{"source":"whatsapp_messages","window":"7d_30d"}'),
  ('tasks',     0.25, true, '{"source":"clickup_tasks","window":"7d_30d"}'),
  ('criativos', 0.15, true, '{"source":"work_items:CREATIVE_REQUEST","window":"7d_30d"}'),
  ('reunioes',  0.10, true, '{"source":"meeting_presence_events","window":"7d_30d"}'),
  ('alertas',   0.15, true, '{"source":"manager+onboarding+lead_incidents","window":"7d_30d"}'),
  ('risco',     0.10, true, '{"source":"portfolio_client_status","window":"current"}')
on conflict (metric_key) do nothing;

-- Retorna somente contagens cruas. O score final continua em shared/capacity,
-- garantindo uma unica formula para UI, simulador e testes.
create or replace function agency_ops.capacity_current_metrics()
returns table (
  client_id uuid,
  display_name text,
  lifecycle text,
  gt_owner text,
  entrada date,
  whatsapp_7d numeric,
  whatsapp_30d numeric,
  tasks_7d numeric,
  tasks_30d numeric,
  criativos_7d numeric,
  criativos_30d numeric,  reunioes_7d numeric,
  reunioes_30d numeric,
  alertas_7d numeric,
  alertas_30d numeric,
  risco_7d numeric,
  risco_30d numeric
)
language sql
stable
security definer
set search_path = agency_ops, public
as $$
with live as (
  select id, display_name, lifecycle, gt_owner, entrada
  from agency_ops.clients
  where lifecycle in ('ACTIVE','ONBOARDING')
), wa as (
  select cs.client_id,
    count(*) filter (where m.event_at >= now()-interval '7 days')::numeric as v7,
    count(*)::numeric as v30
  from agency_ops.conversation_state cs
  join live l on l.id=cs.client_id
  join agency_ops.whatsapp_messages m on m.chat_id=cs.chat_id
  where m.is_group=true and m.event_at >= now()-interval '30 days'
  group by cs.client_id
), tasks as (
  select t.client_id,
    count(*) filter (where coalesce(t.date_updated,t.date_created) >= now()-interval '7 days')::numeric as v7,
    count(*)::numeric as v30  from agency_ops.clickup_tasks t
  join live l on l.id=t.client_id
  where coalesce(t.date_updated,t.date_created) >= now()-interval '30 days'
  group by t.client_id
), creatives as (
  select w.client_id,
    count(*) filter (where w.created_at >= now()-interval '7 days')::numeric as v7,
    count(*)::numeric as v30
  from agency_ops.work_items w
  join live l on l.id=w.client_id
  where w.type='CREATIVE_REQUEST' and w.created_at >= now()-interval '30 days'
  group by w.client_id
), meetings as (
  select e.client_id,
    count(distinct coalesce(e.meeting_code,e.source_record_id,e.id::text))
      filter (where e.started_at >= now()-interval '7 days')::numeric as v7,
    count(distinct coalesce(e.meeting_code,e.source_record_id,e.id::text))::numeric as v30
  from agency_ops.meeting_presence_events e
  join live l on l.id=e.client_id
  where e.started_at >= now()-interval '30 days'
  group by e.client_id
), alert_events as (
  select a.client_id, coalesce(a.last_seen_at,a.first_seen_at) as at,
    case upper(coalesce(a.priority,a.level,''))
      when 'CRITICAL' then 2.0 when 'HIGH' then 1.5 else 1.0 end::numeric as weight
  from agency_ops.manager_attention_alerts a
  where a.client_id is not null
    and coalesce(a.last_seen_at,a.first_seen_at) >= now()-interval '30 days'  union all
  select o.client_id::text, o.occurred_at,
    case when o.acknowledged_at is null then 1.2 else 0.8 end::numeric
  from agency_ops.onboarding_required_alerts o
  where o.occurred_at >= now()-interval '30 days'
  union all
  select q.client_id::text, q.created_at,
    case upper(coalesce(q.severity,''))
      when 'CRITICAL' then 2.0 when 'HIGH' then 1.5 else 1.0 end::numeric
  from agency_ops.lead_dispatch_quality_incidents q
  where q.created_at >= now()-interval '30 days'
), alerts as (
  select client_id,
    sum(weight) filter (where at >= now()-interval '7 days') as v7,
    sum(weight) as v30
  from alert_events
  group by client_id
), risk as (
  select pcs.client_id,
    (case when pcs.churn_previsto then 3 else 0 end
     + case when pcs.juridico then 2 else 0 end
     + case when pcs.inadimplente then 1 else 0 end
     + case when lower(coalesce(pcs.urgencia,''))='urgente' then 2 else 0 end)::numeric as points
  from agency_ops.portfolio_client_status pcs
)
select l.id, l.display_name, l.lifecycle, l.gt_owner, l.entrada,
  coalesce(wa.v7,0), coalesce(wa.v30,0),  coalesce(tasks.v7,0), coalesce(tasks.v30,0),
  coalesce(creatives.v7,0), coalesce(creatives.v30,0),
  coalesce(meetings.v7,0), coalesce(meetings.v30,0),
  coalesce(alerts.v7,0), coalesce(alerts.v30,0),
  coalesce(risk.points,0), coalesce(risk.points,0)
from live l
left join wa on wa.client_id=l.id
left join tasks on tasks.client_id=l.id
left join creatives on creatives.client_id=l.id
left join meetings on meetings.client_id=l.id
left join alerts on alerts.client_id=l.id::text
left join risk on risk.client_id=l.id
order by l.display_name;
$$;

-- Crescimento liquido para o forecast. Usa entradas/saidas reais da base, nao pipeline.
create or replace function agency_ops.capacity_growth_summary()
returns jsonb
language sql
stable
security definer
set search_path = agency_ops, public
as $$
select jsonb_build_object(
  'net_30d',
    count(*) filter (where entrada >= current_date-29)
      - count(*) filter (where saida >= current_date-29),
  'net_60d',
    count(*) filter (where entrada >= current_date-59)
      - count(*) filter (where saida >= current_date-59),  'net_90d',
    count(*) filter (where entrada >= current_date-89)
      - count(*) filter (where saida >= current_date-89),
  'entries_30d', count(*) filter (where entrada >= current_date-29),
  'exits_30d', count(*) filter (where saida >= current_date-29),
  'entries_60d', count(*) filter (where entrada >= current_date-59),
  'exits_60d', count(*) filter (where saida >= current_date-59),
  'entries_90d', count(*) filter (where entrada >= current_date-89),
  'exits_90d', count(*) filter (where saida >= current_date-89)
)
from agency_ops.clients
where entrada >= current_date-89 or saida >= current_date-89;
$$;

-- Snapshot cru diario. A UI recompõe o score com a mesma formula TypeScript,
-- evitando duplicar regra de negocio em SQL.
create or replace function agency_ops.capture_capacity_snapshot(p_day date default current_date)
returns integer
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare v_count integer;
begin
  insert into agency_ops.operational_capacity_snapshots(
    snapshot_date,scope_type,scope_id,client_count,metadata
  )
  select p_day,'CLIENT',m.client_id::text,1,
    jsonb_build_object(
      'display_name',m.display_name,'lifecycle',m.lifecycle,'gt_owner',m.gt_owner,'entrada',m.entrada,      'metricas7d',jsonb_build_object(
        'whatsapp',m.whatsapp_7d,'tasks',m.tasks_7d,'criativos',m.criativos_7d,
        'reunioes',m.reunioes_7d,'alertas',m.alertas_7d,'risco',m.risco_7d),
      'metricas30d',jsonb_build_object(
        'whatsapp',m.whatsapp_30d,'tasks',m.tasks_30d,'criativos',m.criativos_30d,
        'reunioes',m.reunioes_30d,'alertas',m.alertas_30d,'risco',m.risco_30d)
    )
  from agency_ops.capacity_current_metrics() m
  on conflict (snapshot_date,scope_type,scope_id)
  do update set metadata=excluded.metadata,created_at=now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A aba nasce liberada apenas nominalmente para Adler. Ausencia de regra continua
-- significando negado para os demais perfis.
insert into agency_ops.dashboard_view_permissions(
  view_key,scope_type,scope_value,allowed,note,updated_at
) values (
  'capacity','PERSON','Adler Furtado',true,
  'Capacidade Operacional v1: rollout inicial MGMT/Adler',now()
)
on conflict (view_key,scope_type,scope_value)
do update set allowed=excluded.allowed,note=excluded.note,updated_at=now();

revoke all on agency_ops.capacity_settings from anon, authenticated;
revoke all on agency_ops.client_workload_overrides from anon, authenticated;revoke all on agency_ops.operational_capacity_snapshots from anon, authenticated;
revoke all on agency_ops.workload_weight_config from anon, authenticated;
grant select,insert,update,delete on agency_ops.capacity_settings to service_role;
grant select,insert,update,delete on agency_ops.client_workload_overrides to service_role;
grant select,insert,update,delete on agency_ops.operational_capacity_snapshots to service_role;
grant select,insert,update,delete on agency_ops.workload_weight_config to service_role;

revoke all on function agency_ops.capacity_current_metrics() from public;
revoke all on function agency_ops.capacity_growth_summary() from public;
revoke all on function agency_ops.capture_capacity_snapshot(date) from public;
grant execute on function agency_ops.capacity_current_metrics() to service_role;
grant execute on function agency_ops.capacity_growth_summary() to service_role;
grant execute on function agency_ops.capture_capacity_snapshot(date) to service_role;

-- Um unico job diario e barato (~30 ms no EXPLAIN inicial). Nao cria polling novo.
do $$
begin
  if exists (select 1 from cron.job where jobname='agency_ops_capacity_daily_snapshot') then
    perform cron.unschedule('agency_ops_capacity_daily_snapshot');
  end if;
  perform cron.schedule(
    'agency_ops_capacity_daily_snapshot',
    '37 6 * * *',
    'select agency_ops.capture_capacity_snapshot(current_date);'
  );
end $$;

-- Gera o primeiro ponto historico imediatamente.
select agency_ops.capture_capacity_snapshot(current_date);