-- Keep Adler notification-first for GT assignment requests and codify the
-- commercial classification of the View Imóveis follow-up group.

create or replace function agency_ops.notify_adler_gt_assignment_request()
returns trigger
language plpgsql
security definer
set search_path=agency_ops,pg_catalog
as $fn$
declare
  v_client_name text;
  v_event_key text;
  v_description text;
begin
  v_event_key := 'onboarding-gt-assignment:' || new.id::text;

  if new.status <> 'PENDING' then
    delete from agency_ops.platform_notifications where event_key=v_event_key;
    return new;
  end if;

  select c.display_name into v_client_name
  from agency_ops.clients c
  where c.id=new.client_id;

  v_client_name := coalesce(nullif(v_client_name,''),'Cliente');
  v_description := case
    when new.trigger_status='DONE'
      then 'A 1ª reunião de apresentação de '||v_client_name||' foi concluída. Selecione o GT para liberar a integração e a carteira.'
    else v_client_name||' já avançou além da 1ª apresentação. Selecione o GT para liberar a integração e a carteira.'
  end;

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
  ) values (
    v_event_key,
    'ONBOARDING_GT_ASSIGNMENT_REQUIRED',
    'ATTENTION',
    'Onboarding · selecionar GT · '||v_client_name,
    v_description,
    new.client_id,
    'onboarding',
    'Sistema',
    coalesce(new.requested_at,new.created_at,now()),
    null,
    jsonb_build_object(
      'private_to_person',true,
      'target_person','Adler Furtado',
      'target_role','MGMT',
      'onboarding_gt_assignment_request_id',new.id,
      'onboarding_case_id',new.case_id,
      'action_type','ASSIGN_GT',
      'action_status','PENDING',
      'button_label','Selecionar GT'
    )
  )
  on conflict(event_key) do update
  set title=excluded.title,
      description=excluded.description,
      client_id=excluded.client_id,
      level=excluded.level,
      occurred_at=excluded.occurred_at,
      read_at=null,
      metadata=excluded.metadata;

  return new;
end
$fn$;

drop trigger if exists trg_notify_adler_gt_assignment_request on agency_ops.onboarding_gt_assignment_requests;
create trigger trg_notify_adler_gt_assignment_request
after insert or update of status,trigger_status,requested_at,client_id
on agency_ops.onboarding_gt_assignment_requests
for each row execute function agency_ops.notify_adler_gt_assignment_request();

insert into agency_ops.platform_notifications(
  event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
)
select
  'onboarding-gt-assignment:'||r.id::text,
  'ONBOARDING_GT_ASSIGNMENT_REQUIRED',
  'ATTENTION',
  'Onboarding · selecionar GT · '||coalesce(nullif(c.display_name,''),'Cliente'),
  case when r.trigger_status='DONE'
    then 'A 1ª reunião de apresentação de '||coalesce(nullif(c.display_name,''),'Cliente')||' foi concluída. Selecione o GT para liberar a integração e a carteira.'
    else coalesce(nullif(c.display_name,''),'Cliente')||' já avançou além da 1ª apresentação. Selecione o GT para liberar a integração e a carteira.'
  end,
  r.client_id,
  'onboarding',
  'Sistema',
  coalesce(r.requested_at,r.created_at,now()),
  null,
  jsonb_build_object(
    'private_to_person',true,
    'target_person','Adler Furtado',
    'target_role','MGMT',
    'onboarding_gt_assignment_request_id',r.id,
    'onboarding_case_id',r.case_id,
    'action_type','ASSIGN_GT',
    'action_status','PENDING',
    'button_label','Selecionar GT'
  )
from agency_ops.onboarding_gt_assignment_requests r
left join agency_ops.clients c on c.id=r.client_id
where r.status='PENDING'
on conflict(event_key) do update
set title=excluded.title,
    description=excluded.description,
    client_id=excluded.client_id,
    level=excluded.level,
    occurred_at=excluded.occurred_at,
    metadata=excluded.metadata;

-- This exact chat is the View Imóveis commercial follow-up group. It must
-- never enter the marketing/onboarding client pipeline.
update agency_ops.whatsapp_chat_registry
set scope='COMMERCIAL',
    client_id=null,
    confidence='CONFIRMED',
    reason='MANUAL:COMMERCIAL_GROUP_VIEW_IMOVEIS',
    updated_at=now()
where chat_id='554199405058-1560955082';

update agency_ops.conversation_state
set client_id=null,updated_at=now()
where chat_id='554199405058-1560955082';

delete from agency_ops.client_integrations
where system='WHATSAPP_GROUP'
  and external_id='554199405058-1560955082';
