-- Adler must receive onboarding blocking alerts in notifications first.
-- The full-screen dialog opens only after the notification is clicked.

create or replace function agency_ops.notify_adler_onboarding_required_alert()
returns trigger
language plpgsql
security definer
set search_path=agency_ops,pg_catalog
as $fn$
begin
  if new.target_person <> 'Adler Furtado'
     or coalesce(new.ack_required,true)=false
     or new.acknowledged_at is not null then
    return new;
  end if;

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
  ) values (
    'onboarding-required-alert:'||new.id::text,
    'ONBOARDING_REQUIRED_ALERT',
    case when coalesce(new.metadata->>'severity','') in ('CRITICAL','HIGH') then 'ATTENTION' else 'INFO' end,
    coalesce(nullif(new.title,''),'Aviso de onboarding'),
    left(coalesce(nullif(new.description,''),'Existe uma ação de onboarding aguardando sua ciência.'),700),
    new.client_id,
    'onboarding_required_alert',
    coalesce(new.actor,'Sistema'),
    coalesce(new.occurred_at,new.created_at,now()),
    null,
    jsonb_build_object(
      'private_to_person',true,
      'target_person','Adler Furtado',
      'target_role','MGMT',
      'onboarding_required_alert_id',new.id,
      'onboarding_case_id',new.onboarding_case_id,
      'alert_type',new.alert_type,
      'ack_label',new.ack_label,
      'button_label','Abrir aviso completo'
    ) || coalesce(new.metadata,'{}'::jsonb)
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

drop trigger if exists trg_notify_adler_onboarding_required_alert on agency_ops.onboarding_required_alerts;
create trigger trg_notify_adler_onboarding_required_alert
after insert or update of target_person,ack_required,acknowledged_at,title,description,metadata
on agency_ops.onboarding_required_alerts
for each row execute function agency_ops.notify_adler_onboarding_required_alert();

insert into agency_ops.platform_notifications(
  event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
)
select
  'onboarding-required-alert:'||a.id::text,
  'ONBOARDING_REQUIRED_ALERT',
  case when coalesce(a.metadata->>'severity','') in ('CRITICAL','HIGH') then 'ATTENTION' else 'INFO' end,
  coalesce(nullif(a.title,''),'Aviso de onboarding'),
  left(coalesce(nullif(a.description,''),'Existe uma ação de onboarding aguardando sua ciência.'),700),
  a.client_id,
  'onboarding_required_alert',
  coalesce(a.actor,'Sistema'),
  coalesce(a.occurred_at,a.created_at,now()),
  null,
  jsonb_build_object(
    'private_to_person',true,
    'target_person','Adler Furtado',
    'target_role','MGMT',
    'onboarding_required_alert_id',a.id,
    'onboarding_case_id',a.onboarding_case_id,
    'alert_type',a.alert_type,
    'ack_label',a.ack_label,
    'button_label','Abrir aviso completo'
  ) || coalesce(a.metadata,'{}'::jsonb)
from agency_ops.onboarding_required_alerts a
where a.target_person='Adler Furtado'
  and coalesce(a.ack_required,true)=true
  and a.acknowledged_at is null
on conflict(event_key) do update
set title=excluded.title,description=excluded.description,client_id=excluded.client_id,
    level=excluded.level,occurred_at=excluded.occurred_at,metadata=excluded.metadata;
