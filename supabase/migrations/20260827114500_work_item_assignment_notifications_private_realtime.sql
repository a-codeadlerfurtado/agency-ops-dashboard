-- Faz a troca de responsavel propagar por evento aos dois lados da Central.
-- A notificacao de atribuicao e privada ao responsavel. Quando ela e' marcada como
-- substituida, o antigo responsavel recebe o UPDATE pelo Realtime e remove o item.

create or replace function agency_ops.normalize_work_assignment_notification_privacy()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public'
as $function$
begin
  if new.type in ('WORK_ITEM_ASSIGNED','WORK_ITEM_REASSIGNED')
     and nullif(btrim(coalesce(new.metadata->>'target_person','')), '') is not null then
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object('private_to_person',true);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_work_assignment_notification_privacy on agency_ops.platform_notifications;
create trigger trg_work_assignment_notification_privacy
before insert or update of metadata on agency_ops.platform_notifications
for each row execute function agency_ops.normalize_work_assignment_notification_privacy();

update agency_ops.platform_notifications
   set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('private_to_person',true)
 where type in ('WORK_ITEM_ASSIGNED','WORK_ITEM_REASSIGNED')
   and nullif(btrim(coalesce(metadata->>'target_person','')), '') is not null
   and coalesce((metadata->>'private_to_person')::boolean,false) = false;
