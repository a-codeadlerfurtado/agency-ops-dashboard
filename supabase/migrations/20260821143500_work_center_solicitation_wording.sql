-- Alinha a semântica: o objeto operacional é uma solicitação; notificação é o aviso.
create or replace function agency_ops.audit_work_item()
returns trigger
language plpgsql
set search_path to 'agency_ops', 'public'
as $$
declare
  event_label text;
begin
  event_label := case when tg_op = 'INSERT' then 'CREATED' else 'STATUS_CHANGED' end;
  insert into agency_ops.work_item_events(work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata)
  values (new.id,event_label,new.created_by_user_key,coalesce(new.completed_by,new.created_by_person),case when tg_op = 'UPDATE' then old.status else null end,new.status,case when tg_op = 'INSERT' then new.description else new.resolution end,jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type));

  if tg_op = 'INSERT' then
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values ('work-item-created:' || new.id::text,'WORK_ITEM_ASSIGNED',case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'HIGH' else 'INFO' end,'Nova solicitação: ' || new.title,coalesce(new.description,'Abra a Central de Trabalho para ver e assumir.'),new.client_id,'work_center',new.created_by_person,now(),jsonb_build_object('work_item_id',new.id,'target_role',new.target_role,'target_person',new.target_person,'status',new.status));
  elsif old.status is distinct from new.status and new.status = 'COMPLETED' then
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values ('work-item-completed:' || new.id::text,'WORK_ITEM_COMPLETED','SUCCESS','Solicitação concluída: ' || new.title,coalesce(new.resolution,'A solicitação foi marcada como concluída.'),new.client_id,'work_center',new.completed_by,now(),jsonb_build_object('work_item_id',new.id,'target_person',new.created_by_person,'status',new.status));
  end if;
  return new;
end;
$$;
