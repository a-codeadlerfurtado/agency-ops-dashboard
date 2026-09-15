-- Escopo canônico do perfil de Gabriel Castro: somente clientes com IA da agência
-- e fonte N8N_CHAT ativa. A função é reutilizada pelas APIs de Saúde, Visão Geral,
-- Foco, Central de Trabalho e ClickUp para evitar listas divergentes.
create or replace function agency_ops.ai_ours_active_client_ids()
returns table(client_id uuid)
language sql
stable
security definer
set search_path = agency_ops, public
as $$
  select distinct s.client_id
  from agency_ops.ai_source_registry s
  join agency_ops.client_services cs
    on cs.client_id = s.client_id
   and cs.service_key = 'IA'
   and cs.owner_key = 'OURS'
   and cs.service_status in ('ACTIVE','BUILDING')
  where s.source_type = 'N8N_CHAT'
    and s.owner_hint = 'OURS'
    and s.active = true
    and s.client_id is not null;
$$;
revoke all on function agency_ops.ai_ours_active_client_ids() from public;
grant execute on function agency_ops.ai_ours_active_client_ids() to service_role;

create or replace function agency_ops.clickup_range_report_ai_clients(
  p_since date,
  p_until date,
  p_person text
)
returns jsonb
language sql
stable
security definer
set search_path = agency_ops, public
as $$
  with ai_clients as (
    select client_id from agency_ops.ai_ours_active_client_ids()
  ),
  escopo as (
    select t.task_id, t.date_created, t.date_closed, t.due_date,
           a.user_id, coalesce(a.username, a.email) as person
      from agency_ops.clickup_tasks t
      join agency_ops.clickup_task_assignees a on a.task_id = t.task_id
      join ai_clients ac on ac.client_id = t.client_id
     where t.is_closed
       and t.date_closed is not null
       and (t.date_closed at time zone 'America/Sao_Paulo')::date between p_since and p_until
       and coalesce(a.username, a.email) = p_person
  ),
  diario as (
    select (date_closed at time zone 'America/Sao_Paulo')::date as dia,
           count(distinct task_id) as tasks_done
      from escopo group by 1
  ),
  pessoa as (
    select user_id, person, count(distinct task_id) as tasks_done,
           round(avg(extract(epoch from (date_closed - date_created)) / 3600.0)::numeric, 1) as avg_cycle_hours,
           count(*) filter (where due_date is null or date_closed <= due_date) as completed_on_time,
           count(*) filter (where due_date is not null and date_closed > due_date) as completed_late
      from escopo group by 1,2
  )
  select jsonb_build_object(
    'since', p_since,
    'until', p_until,
    'daily_totals', coalesce((select jsonb_agg(jsonb_build_object('date',dia,'tasks_done',tasks_done) order by dia) from diario),'[]'::jsonb),
    'summary', coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'person',person,'tasks_done',tasks_done,'avg_cycle_hours',avg_cycle_hours,'completed_on_time',completed_on_time,'completed_late',completed_late) order by tasks_done desc) from pessoa),'[]'::jsonb)
  );
$$;
revoke all on function agency_ops.clickup_range_report_ai_clients(date,date,text) from public;
grant execute on function agency_ops.clickup_range_report_ai_clients(date,date,text) to service_role;
