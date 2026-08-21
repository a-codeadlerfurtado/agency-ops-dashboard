-- O mapa de atividade deve contabilizar ajustes do Diario mesmo quando
-- responsible_person nao foi preenchido. Mantemos responsible_person como
-- prioridade quando existir e usamos a autoria autenticada como fallback.
create or replace view agency_ops.op_perf_daily_activity as
select person,
       role,
       activity_date,
       source,
       count(*) as events
from (
  select f.person,
         f.role,
         (f.date_closed at time zone 'America/Sao_Paulo')::date as activity_date,
         'clickup_task_closed'::text as source
  from agency_ops.op_perf_task_facts f
  where f.completed
    and f.date_closed is not null

  union all

  select l.collaborator_name as person,
         r.role,
         l.task_date as activity_date,
         'task_log'::text as source
  from agency_ops.task_log_entries l
  left join agency_ops.team_roster r
    on r.person = l.collaborator_name
  where l.deleted_at is null

  union all

  select coalesce(
           ca.responsible_person,
           up.collaborator_person,
           up.name,
           ca.author_name_snapshot,
           ca.metadata->>'author_name'
         ) as person,
         r.role,
         (ca.occurred_at at time zone 'America/Sao_Paulo')::date as activity_date,
         'client_adjustment'::text as source
  from agency_ops.client_adjustments ca
  left join agency_ops.user_preferences up
    on up.user_key = ca.author_user_id::text
  left join agency_ops.team_roster r
    on r.person = coalesce(
      ca.responsible_person,
      up.collaborator_person,
      up.name,
      ca.author_name_snapshot,
      ca.metadata->>'author_name'
    )
  where coalesce(
          ca.responsible_person,
          up.collaborator_person,
          up.name,
          ca.author_name_snapshot,
          ca.metadata->>'author_name'
        ) is not null
) x
group by person, role, activity_date, source;
