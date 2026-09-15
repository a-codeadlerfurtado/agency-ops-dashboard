-- Treat both ClickUp terminal status types (done + closed) as completion evidence.
-- Also enrich notification metadata so the dashboard can show the full task context.
create or replace function agency_ops.record_clickup_completion_notification()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','public'
as $function$
declare
  v_completed_by text; v_completed_by_id text;
  v_assignee_names text; v_assignees jsonb := '[]'::jsonb;
  v_closed_at timestamptz := coalesce(new.date_closed,new.last_synced_at,now());
  v_description text;
  v_before jsonb; v_after jsonb;
begin
  if new.is_closed and (tg_op='INSERT' or not coalesce(old.is_closed,false)) then
    select e.actor_name,e.actor_id,e.before_value,e.after_value
      into v_completed_by,v_completed_by_id,v_before,v_after
    from agency_ops.clickup_task_events e
    where e.task_id=new.task_id
      and lower(coalesce(e.after_value->>'type','')) in ('done','closed')
      and e.event_at between v_closed_at-interval '10 minutes' and v_closed_at+interval '10 minutes'
    order by abs(extract(epoch from(e.event_at-v_closed_at))),e.id desc limit 1;

    select string_agg(coalesce(a.username,a.email,a.user_id),', ' order by coalesce(a.username,a.email,a.user_id)),
           coalesce(jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'email',a.email)
             order by coalesce(a.username,a.email,a.user_id)),'[]'::jsonb)
      into v_assignee_names,v_assignees
    from agency_ops.clickup_task_assignees a where a.task_id=new.task_id;

    v_description:=new.name;
    if coalesce(btrim(v_assignee_names),'')<>'' then v_description:=v_description||' · Responsável pela task: '||v_assignee_names; end if;
    if v_completed_by is null then v_description:=v_description||' · Quem concluiu: não identificado (sem evento de status utilizável)'; end if;

    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,metadata)
    values('clickup:closed:'||new.task_id||':'||coalesce(new.date_closed::text,new.last_synced_at::text),
      'TASK_COMPLETED','SUCCESS','Tarefa concluída',v_description,new.client_id,new.task_id,'ClickUp',v_completed_by,v_closed_at,
      jsonb_build_object(
        'url',new.url,'status',new.status,'list',new.list_name,'folder',new.folder_name,'space',new.space_name,
        'task_name',new.name,'task_description',new.description,'creator_name',new.creator_name,
        'date_created',new.date_created,'date_updated',new.date_updated,'due_date',new.due_date,'date_closed',new.date_closed,
        'completed_by',v_completed_by,'completed_by_id',v_completed_by_id,
        'completion_actor_source',case when v_completed_by is not null then 'CLICKUP_STATUS_EVENT' else 'NOT_IDENTIFIED' end,
        'status_before',v_before,'status_after',v_after,
        'assignee_names',v_assignee_names,'assignees',v_assignees,
        'attachments',coalesce(new.raw_json->'attachments','[]'::jsonb),
        'watchers',coalesce(new.raw_json->'watchers','[]'::jsonb),
        'priority',new.raw_json->'priority'
      ))
    on conflict(event_key) do nothing;
  end if;
  return new;
end $function$;

-- Recover actors already present in webhook history but missed by the old closed-only matcher.
with ranked as (
  select n.id,e.actor_name,e.actor_id,e.before_value,e.after_value,
         row_number() over(partition by n.id order by abs(extract(epoch from(e.event_at-n.occurred_at))),e.id desc) rn
  from agency_ops.platform_notifications n
  join agency_ops.clickup_task_events e on e.task_id=n.task_id
    and lower(coalesce(e.after_value->>'type','')) in ('done','closed')
    and e.event_at between n.occurred_at-interval '10 minutes' and n.occurred_at+interval '10 minutes'
  where n.type='TASK_COMPLETED'
), best as (select * from ranked where rn=1)
update agency_ops.platform_notifications n
set actor=coalesce(n.actor,b.actor_name),
    description=case when n.description like '%Quem concluiu: não identificado%' and b.actor_name is not null
      then regexp_replace(n.description,' · Quem concluiu: não identificado[^·]*$','','g') else n.description end,
    metadata=coalesce(n.metadata,'{}'::jsonb)||jsonb_build_object(
      'completed_by',coalesce(n.metadata->>'completed_by',b.actor_name),
      'completed_by_id',coalesce(n.metadata->>'completed_by_id',b.actor_id),
      'completion_actor_source',case when b.actor_name is not null then 'CLICKUP_STATUS_EVENT' else coalesce(n.metadata->>'completion_actor_source','NOT_IDENTIFIED') end,
      'status_before',b.before_value,'status_after',b.after_value)
from best b where n.id=b.id;

-- Enrich recent completion notifications with the canonical ClickUp task snapshot.
update agency_ops.platform_notifications n
set metadata=coalesce(n.metadata,'{}'::jsonb)||jsonb_build_object(
  'url',t.url,'status',t.status,'list',t.list_name,'folder',t.folder_name,'space',t.space_name,
  'task_name',t.name,'task_description',t.description,'creator_name',t.creator_name,
  'date_created',t.date_created,'date_updated',t.date_updated,'due_date',t.due_date,'date_closed',t.date_closed,
  'assignee_names',coalesce(t.assignee_names,n.metadata->>'assignee_names'),
  'attachments',coalesce(t.raw_json->'attachments','[]'::jsonb),
  'watchers',coalesce(t.raw_json->'watchers','[]'::jsonb),
  'priority',t.raw_json->'priority')
from agency_ops.clickup_tasks t
where n.type='TASK_COMPLETED' and n.task_id=t.task_id and n.occurred_at>=now()-interval '60 days';
