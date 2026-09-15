-- Aggregate-only ClickUp scope for Leonardo's executive profile.
-- Deliberately returns no assignee, actor, creator, task name, task id or per-person metrics.
create or replace function agency_ops.get_clickup_executive_aggregate()
returns jsonb
language sql
security definer
set search_path = pg_catalog, agency_ops
as $$
with params as (
  select
    make_timestamptz(
      extract(year from (now() at time zone 'America/Sao_Paulo'))::int,
      1, 1, 0, 0, 0,
      'America/Sao_Paulo'
    ) as year_start,
    date_trunc('month', now() at time zone 'America/Sao_Paulo') as current_month_local
), totals as (
  select
    count(*) filter (where t.is_closed and t.date_closed >= p.year_start)::int as completed_since_jan,
    count(*) filter (where t.date_created >= p.year_start)::int as created_since_jan,
    count(*) filter (where t.is_closed and t.date_closed >= now() - interval '30 days')::int as completed_30d,
    count(*) filter (where t.is_closed and t.date_closed >= now() - interval '7 days')::int as completed_7d,
    count(*) filter (where not t.is_closed)::int as open_now,
    count(*) filter (where not t.is_closed and t.due_date is not null and t.due_date < now())::int as overdue_now,
    count(*) filter (where t.is_closed and t.date_closed >= p.year_start and t.client_id is not null)::int as completed_linked_to_client,
    max(t.last_synced_at) as last_task_sync
  from agency_ops.clickup_tasks t
  cross join params p
), monthly as (
  select
    to_char(date_trunc('month', t.date_closed at time zone 'America/Sao_Paulo'), 'YYYY-MM') as month,
    count(*)::int as completed
  from agency_ops.clickup_tasks t
  cross join params p
  where t.is_closed and t.date_closed >= p.year_start
  group by 1
  order by 1
), last_run as (
  select status, mode, started_at, finished_at, tasks_seen, tasks_upserted, tasks_closed
  from agency_ops.clickup_sync_runs
  order by started_at desc
  limit 1
)
select jsonb_build_object(
  'scope', 'EXECUTIVE_AGGREGATE_ONLY',
  'year', extract(year from (now() at time zone 'America/Sao_Paulo'))::int,
  'completed_since_jan', totals.completed_since_jan,
  'created_since_jan', totals.created_since_jan,
  'completed_30d', totals.completed_30d,
  'completed_7d', totals.completed_7d,
  'open_now', totals.open_now,
  'overdue_now', totals.overdue_now,
  'completed_linked_to_client', totals.completed_linked_to_client,
  'completion_rate_pct', round(100.0 * totals.completed_since_jan / nullif(totals.created_since_jan, 0), 1),
  'last_task_sync', totals.last_task_sync,
  'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'completed', completed) order by month) from monthly), '[]'::jsonb),
  'last_sync', coalesce((select to_jsonb(last_run) from last_run), 'null'::jsonb)
)
from totals;
$$;

revoke all on function agency_ops.get_clickup_executive_aggregate() from public, anon, authenticated;
grant execute on function agency_ops.get_clickup_executive_aggregate() to service_role;
