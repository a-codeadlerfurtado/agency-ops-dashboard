-- Applied to project bfzdetibfcwihfkltbkp. Kept here for reproducibility.
create table if not exists agency_ops.clickup_tasks (
  task_id text primary key, custom_id text, name text not null default '', description text,
  status text, status_type text, is_closed boolean not null default false,
  date_created timestamptz, date_updated timestamptz, date_closed timestamptz,
  start_date timestamptz, due_date timestamptz, time_estimate_ms bigint, time_spent_ms bigint,
  list_id text, list_name text, folder_id text, folder_name text, space_id text, space_name text,
  creator_id text, creator_name text, client_id uuid references agency_ops.clients(id) on delete set null,
  client_match_source text, url text, raw_json jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(), last_synced_at timestamptz not null default now()
);
create table if not exists agency_ops.clickup_task_assignees (
  task_id text not null references agency_ops.clickup_tasks(task_id) on delete cascade,
  user_id text not null, username text, email text, initials text, profile_picture text,
  primary key(task_id,user_id)
);
create table if not exists agency_ops.clickup_task_events (
  id bigint generated always as identity primary key, event_key text not null unique,
  webhook_id text, event_type text not null, task_id text, actor_id text, actor_name text,
  event_at timestamptz, before_value jsonb, after_value jsonb, raw_json jsonb not null default '{}'::jsonb,
  processing_status text not null default 'RECEIVED' check(processing_status in ('RECEIVED','PROCESSED','IGNORED','ERROR')),
  processing_error text, received_at timestamptz not null default now(), processed_at timestamptz
);
create table if not exists agency_ops.clickup_sync_runs (
  id bigint generated always as identity primary key, mode text not null check(mode in ('WEBHOOK','BACKFILL','INCREMENTAL','MANUAL')),
  status text not null check(status in ('RUNNING','SUCCESS','PARTIAL','ERROR')), started_at timestamptz not null default now(),
  finished_at timestamptz, tasks_seen integer not null default 0, tasks_upserted integer not null default 0,
  tasks_closed integer not null default 0, error text, metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_clickup_tasks_closed_at on agency_ops.clickup_tasks(date_closed desc) where is_closed;
create index if not exists idx_clickup_tasks_client on agency_ops.clickup_tasks(client_id);
create index if not exists idx_clickup_tasks_list on agency_ops.clickup_tasks(list_id);
create index if not exists idx_clickup_assignees_user on agency_ops.clickup_task_assignees(user_id);
create index if not exists idx_clickup_events_task on agency_ops.clickup_task_events(task_id,event_at desc);
create index if not exists idx_clickup_events_received on agency_ops.clickup_task_events(received_at desc);
alter table agency_ops.clickup_tasks enable row level security;
alter table agency_ops.clickup_task_assignees enable row level security;
alter table agency_ops.clickup_task_events enable row level security;
alter table agency_ops.clickup_sync_runs enable row level security;
revoke all on agency_ops.clickup_tasks, agency_ops.clickup_task_assignees, agency_ops.clickup_task_events, agency_ops.clickup_sync_runs from anon,authenticated;
grant select,insert,update,delete on agency_ops.clickup_tasks, agency_ops.clickup_task_assignees, agency_ops.clickup_task_events, agency_ops.clickup_sync_runs to service_role;
grant usage,select on all sequences in schema agency_ops to service_role;

create or replace view agency_ops.clickup_productivity_daily with(security_invoker=true) as
select (t.date_closed at time zone 'America/Sao_Paulo')::date date, a.user_id,
  coalesce(nullif(a.username,''),nullif(a.email,''),a.user_id) person,
  count(*)::integer tasks_done, count(distinct t.client_id)::integer clients_served,
  round(avg(extract(epoch from(t.date_closed-t.date_created))/3600)::numeric,1) avg_cycle_hours,
  round((sum(coalesce(t.time_estimate_ms,0))/3600000.0)::numeric,1) estimated_hours,
  round((sum(coalesce(t.time_spent_ms,0))/3600000.0)::numeric,1) tracked_hours,
  count(*) filter(where t.due_date is null or t.date_closed<=t.due_date)::integer completed_on_time,
  count(*) filter(where t.due_date is not null and t.date_closed>t.due_date)::integer completed_late
from agency_ops.clickup_tasks t join agency_ops.clickup_task_assignees a on a.task_id=t.task_id
where t.is_closed and t.date_closed is not null group by 1,a.user_id,3;
create or replace view agency_ops.clickup_productivity_30d with(security_invoker=true) as
select user_id,person,sum(tasks_done)::integer tasks_done,sum(clients_served)::integer client_touches,
  round(avg(avg_cycle_hours)::numeric,1) avg_cycle_hours,round(sum(estimated_hours)::numeric,1) estimated_hours,
  round(sum(tracked_hours)::numeric,1) tracked_hours,sum(completed_on_time)::integer completed_on_time,
  sum(completed_late)::integer completed_late,
  round((100.0*sum(completed_on_time)/nullif(sum(completed_on_time)+sum(completed_late),0))::numeric,1) on_time_pct
from agency_ops.clickup_productivity_daily where date>=current_date-29 group by user_id,person;
grant select on agency_ops.clickup_productivity_daily,agency_ops.clickup_productivity_30d to service_role;

create or replace function agency_ops.get_clickup_config() returns jsonb language sql security definer
set search_path=pg_catalog,agency_ops,vault as $$
select jsonb_build_object('token',max(decrypted_secret) filter(where name='CLICKUP_API_TOKEN'),'team_id',max(decrypted_secret) filter(where name='CLICKUP_TEAM_ID'),'webhook_secret',max(decrypted_secret) filter(where name='CLICKUP_WEBHOOK_SECRET'))
from vault.decrypted_secrets where name in ('CLICKUP_API_TOKEN','CLICKUP_TEAM_ID','CLICKUP_WEBHOOK_SECRET'); $$;
create or replace function agency_ops.set_clickup_secret(p_name text,p_value text) returns void language plpgsql security definer
set search_path=pg_catalog,agency_ops,vault as $$ declare secret_id uuid; begin
if p_name not in ('CLICKUP_API_TOKEN','CLICKUP_TEAM_ID','CLICKUP_WEBHOOK_SECRET') or p_value is null or length(p_value)<1 then raise exception 'invalid_clickup_secret'; end if;
select id into secret_id from vault.decrypted_secrets where name=p_name limit 1;
if secret_id is null then perform vault.create_secret(p_value,p_name,'Credencial ClickUp usada exclusivamente pela integração agency_ops.');
else perform vault.update_secret(secret_id,p_value,p_name,'Credencial ClickUp usada exclusivamente pela integração agency_ops.'); end if; end; $$;
revoke all on function agency_ops.get_clickup_config() from public,anon,authenticated;
revoke all on function agency_ops.set_clickup_secret(text,text) from public,anon,authenticated;
grant execute on function agency_ops.get_clickup_config() to service_role;
grant execute on function agency_ops.set_clickup_secret(text,text) to service_role;
