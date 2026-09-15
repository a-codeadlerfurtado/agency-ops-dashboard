-- Estados intermediários não devem carregar campos visuais de conclusão.
-- Preserva o texto da ação no metadata/evento para auditoria sem exibi-lo como "Conclusão".

create or replace function agency_ops.touch_work_item()
returns trigger
language plpgsql
set search_path to 'agency_ops', 'public'
as $$
begin
  new.updated_at := now();

  if new.status = 'IN_PROGRESS' and old.status is distinct from new.status and new.started_at is null then
    new.started_at := now();
  end if;

  if new.status = 'COMPLETED' and old.status is distinct from new.status then
    if new.completed_at is null then new.completed_at := now(); end if;
  elsif new.status <> 'COMPLETED' then
    new.completed_at := null;
    new.completed_by := null;
  end if;

  if new.status in ('OPEN','IN_PROGRESS','WAITING','SNOOZED') and nullif(new.resolution,'') is not null then
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
      'last_action_detail', new.resolution,
      'last_action_status', new.status,
      'last_action_at', now()
    );
    new.resolution := null;
  end if;

  return new;
end;
$$;

create or replace function agency_ops.audit_work_item()
returns trigger
language plpgsql
set search_path to 'agency_ops', 'public'
as $$
declare
  event_label text;
  notification_description text;
  v_event_id bigint;
  v_detail text;
begin
  event_label := case when tg_op = 'INSERT' then 'CREATED' else 'STATUS_CHANGED' end;
  v_detail := case
    when tg_op = 'INSERT' then new.description
    when new.status in ('OPEN','IN_PROGRESS','WAITING','SNOOZED') then coalesce(new.metadata->>'last_action_detail', new.resolution)
    else new.resolution
  end;

  insert into agency_ops.work_item_events(
    work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata
  ) values (
    new.id,event_label,new.created_by_user_key,coalesce(new.completed_by,new.created_by_person),
    case when tg_op = 'UPDATE' then old.status else null end,new.status,
    v_detail,
    jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type,'source',new.source)
  ) returning id into v_event_id;

  if tg_op = 'INSERT' then
    notification_description := case
      when new.source = 'task_engine_ai' then
        'Demanda identificada automaticamente pela IA no grupo ' ||
        coalesce(nullif(new.metadata->>'source_group_name',''), 'de WhatsApp') ||
        '. Abra a Central de Trabalho para ver a evidência literal e o contexto lido.'
      else coalesce(new.description,'Abra a Central de Trabalho para ver e assumir.')
    end;

    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
    ) values (
      'work-item-created:' || new.id::text,'WORK_ITEM_ASSIGNED',
      case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'ATTENTION' else 'INFO' end,
      'Nova demanda: ' || new.title,notification_description,
      new.client_id,'work_center',new.created_by_person,now(),
      jsonb_build_object(
        'work_item_id',new.id,'target_role',new.target_role,'target_person',new.target_person,
        'status',new.status,'origin',new.source,'source_group_name',new.metadata->>'source_group_name'
      )
    ) on conflict (event_key) do nothing;

  elsif old.status is distinct from new.status and new.status = 'COMPLETED' then
    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
    ) values (
      'work-item-completed:' || new.id::text || ':' || v_event_id::text,
      'WORK_ITEM_COMPLETED','SUCCESS',
      'Demanda concluída: ' || new.title,
      coalesce(new.resolution,'A demanda foi marcada como concluída.'),
      new.client_id,'work_center',new.completed_by,now(),
      jsonb_build_object(
        'work_item_id',new.id,'work_item_event_id',v_event_id,
        'target_person',new.created_by_person,'status',new.status
      )
    );
  end if;

  return new;
end;
$$;
