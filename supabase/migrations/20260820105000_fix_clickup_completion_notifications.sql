-- TASK_COMPLETED: diferencia quem concluiu a task de quem era responsavel/assignee.
-- O ator vem do evento real de mudanca de status para closed no ClickUp.
-- O(s) responsavel(is) ficam preservados em metadata e no texto da notificacao.

create or replace function agency_ops.record_clickup_completion_notification()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_completed_by text;
  v_completed_by_id text;
  v_assignee_names text;
  v_assignees jsonb := '[]'::jsonb;
  v_closed_at timestamptz := coalesce(new.date_closed, new.last_synced_at, now());
  v_description text;
begin
  if new.is_closed and (tg_op = 'INSERT' or not coalesce(old.is_closed,false)) then
    select e.actor_name, e.actor_id
      into v_completed_by, v_completed_by_id
    from agency_ops.clickup_task_events e
    where e.task_id = new.task_id
      and lower(coalesce(e.after_value->>'type','')) = 'closed'
      and e.event_at between v_closed_at - interval '10 minutes' and v_closed_at + interval '10 minutes'
    order by abs(extract(epoch from (e.event_at - v_closed_at))), e.id desc
    limit 1;

    select
      string_agg(coalesce(a.username,a.email,a.user_id), ', ' order by coalesce(a.username,a.email,a.user_id)),
      coalesce(jsonb_agg(jsonb_build_object(
        'user_id', a.user_id,
        'username', a.username,
        'email', a.email
      ) order by coalesce(a.username,a.email,a.user_id)), '[]'::jsonb)
      into v_assignee_names, v_assignees
    from agency_ops.clickup_task_assignees a
    where a.task_id = new.task_id;

    v_description := new.name;
    if v_assignee_names is not null and btrim(v_assignee_names) <> '' then
      v_description := v_description || ' · Responsável pela task: ' || v_assignee_names;
    end if;

    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,metadata
    )
    values (
      'clickup:closed:'||new.task_id||':'||coalesce(new.date_closed::text,new.last_synced_at::text),
      'TASK_COMPLETED','SUCCESS','Tarefa concluída',v_description,new.client_id,new.task_id,'ClickUp',v_completed_by,
      v_closed_at,
      jsonb_build_object(
        'url',new.url,
        'status',new.status,
        'list',new.list_name,
        'task_name',new.name,
        'completed_by',v_completed_by,
        'completed_by_id',v_completed_by_id,
        'completion_actor_source',case when v_completed_by is not null then 'CLICKUP_STATUS_EVENT' else 'NOT_IDENTIFIED' end,
        'assignee_names',v_assignee_names,
        'assignees',v_assignees
      )
    )
    on conflict (event_key) do nothing;
  end if;
  return new;
end $$;

-- Backfill: corrige ator e preserva responsavel nas notificacoes ja existentes.
with resolved as (
  select
    n.id,
    e.actor_name as completed_by,
    e.actor_id as completed_by_id,
    a.assignee_names,
    a.assignees
  from agency_ops.platform_notifications n
  left join lateral (
    select ev.actor_name, ev.actor_id
    from agency_ops.clickup_task_events ev
    where ev.task_id = n.task_id
      and lower(coalesce(ev.after_value->>'type','')) = 'closed'
      and ev.event_at between n.occurred_at - interval '10 minutes' and n.occurred_at + interval '10 minutes'
    order by abs(extract(epoch from (ev.event_at - n.occurred_at))), ev.id desc
    limit 1
  ) e on true
  left join lateral (
    select
      string_agg(coalesce(x.username,x.email,x.user_id), ', ' order by coalesce(x.username,x.email,x.user_id)) as assignee_names,
      coalesce(jsonb_agg(jsonb_build_object('user_id',x.user_id,'username',x.username,'email',x.email) order by coalesce(x.username,x.email,x.user_id)), '[]'::jsonb) as assignees
    from agency_ops.clickup_task_assignees x
    where x.task_id = n.task_id
  ) a on true
  where n.type = 'TASK_COMPLETED'
)
update agency_ops.platform_notifications n
set
  actor = r.completed_by,
  description = split_part(n.description, ' · Responsável pela task:', 1) ||
    case when nullif(r.assignee_names,'') is not null
      then ' · Responsável pela task: ' || r.assignee_names
      else '' end,
  metadata = coalesce(n.metadata,'{}'::jsonb) || jsonb_build_object(
    'task_name', split_part(n.description, ' · Responsável pela task:', 1),
    'completed_by',r.completed_by,
    'completed_by_id',r.completed_by_id,
    'completion_actor_source',case when r.completed_by is not null then 'CLICKUP_STATUS_EVENT' else 'NOT_IDENTIFIED' end,
    'assignee_names',r.assignee_names,
    'assignees',coalesce(r.assignees,'[]'::jsonb)
  )
from resolved r
where n.id = r.id;
