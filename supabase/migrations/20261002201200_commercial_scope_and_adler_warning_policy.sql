-- Keep commercial WhatsApp groups out of client/onboarding scope while preserving
-- their signals for the commercial-followup subsystem. Also make Adler's blocking
-- operational warnings notification-first.

create or replace view agency_ops.commercial_whatsapp_signal_candidates as
select
  m.id as whatsapp_message_id,
  coalesce(r.client_id,cf.client_id) as client_id,
  r.chat_id,
  r.chat_name,
  m.event_at,
  coalesce(nullif(i.canonical_name,''),nullif(m.sender_name,''),nullif(m.sender_phone,''),'Desconhecido') as sender_name,
  i.side as sender_side,
  i.role_hint,
  i.confidence as identity_confidence,
  coalesce(m.text_body,m.caption,'') as message_text,
  case
    when coalesce(m.text_body,m.caption,'') ~* '(venda[[:space:]]+(fechada|ganha)|vendemos|vendeu|vendido|fechamos|neg[oó]cio[[:space:]]+fechado)' then 'WON'
    when coalesce(m.text_body,m.caption,'') ~* '(proposta|fez[[:space:]]+uma[[:space:]]+oferta|enviou[[:space:]]+oferta)' then 'PROPOSAL'
    when coalesce(m.text_body,m.caption,'') ~* '(visita[[:space:]]+(realizada|feita|conclu[ií]da)|visitou[[:space:]]+o|fez[[:space:]]+a[[:space:]]+visita)' then 'VISIT_COMPLETED'
    when coalesce(m.text_body,m.caption,'') ~* '(visita.{0,30}(agendada|marcada)|agendei.{0,30}visita|marquei.{0,30}visita)' then 'VISIT_SCHEDULED'
    when coalesce(m.text_body,m.caption,'') ~* '(respondeu|consegui[[:space:]]+contato|entrei[[:space:]]+em[[:space:]]+contato|atendeu|falou[[:space:]]+com)' then 'CONTACTED'
    else 'UNKNOWN'
  end as candidate_stage,
  case
    when i.side='CLIENT' and coalesce(i.confidence,0)>=0.8 then 0.85
    when i.side='CLIENT' then 0.70
    when coalesce(i.role_hint,'') ~* '(corretor|broker|vendas|comercial)' then 0.72
    else 0.50
  end as signal_confidence
from agency_ops.whatsapp_messages m
join agency_ops.whatsapp_chat_registry r on r.chat_id=m.chat_id
left join agency_ops.commercial_followup_clients cf
  on cf.group_chat_id=r.chat_id
 and cf.automation_enabled=true
left join lateral (
  select p.canonical_name,p.side,p.role_hint,p.confidence
  from agency_ops.whatsapp_participant_identity p
  where p.chat_id=m.chat_id
    and (
      (p.phone is not null and p.phone = any(array[m.participant_phone,m.sender_phone]))
      or
      (p.sender_lid is not null and p.sender_lid = any(array[m.participant_lid,m.sender_lid]))
    )
  order by p.confidence desc nulls last,p.last_seen_at desc nulls last
  limit 1
) i on true
where (r.scope='COMMERCIAL' or r.chat_name ~* '^\\[COMERCIAL\\]')
  and coalesce(m.text_body,m.caption,'') ~* '(respondeu|contato|atendeu|visita|proposta|oferta|venda|vendido|fechamos|neg[oó]cio[[:space:]]+fechado)';

create or replace function agency_ops.notify_adler_manager_attention()
returns trigger
language plpgsql
security definer
set search_path=agency_ops,pg_catalog
as $fn$
declare
  v_client uuid;
  v_event_key text;
  v_title text;
  v_desc text;
begin
  if new.status <> 'OPEN' then return new; end if;

  if new.client_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    begin v_client:=new.client_id::uuid; exception when others then v_client:=null; end;
  end if;

  v_event_key := 'manager-attention-radar:'||new.id::text||':'||greatest(1,coalesce(new.occurrence_count,1))::text;
  v_title := 'Radar gerencial · '||
    case new.level when 'COBRAR_AGORA' then 'COBRAR AGORA' when 'ACOMPANHAR_HOJE' then 'ACOMPANHAR HOJE' else 'VERIFICAR INTERNAMENTE' end
    ||' · '||coalesce(new.client_name,'Operação');
  v_desc := coalesce(nullif(new.charge_action,''),nullif(new.situation,''),nullif(new.context,''),'Há um alerta gerencial aberto.');

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
  ) values (
    v_event_key,'MANAGER_ATTENTION_RADAR',
    case when new.level='COBRAR_AGORA' or new.priority in ('CRITICAL','HIGH') then 'ATTENTION' else 'INFO' end,
    v_title,left(v_desc,700),v_client,'manager_attention_radar','Sistema',coalesce(new.last_seen_at,now()),null,
    jsonb_build_object(
      'private_to_person',true,
      'target_person','Adler Furtado',
      'target_role','MGMT',
      'manager_attention_alert_id',new.id,
      'manager_attention_occurrence',greatest(1,coalesce(new.occurrence_count,1)),
      'manager_attention_level',new.level,
      'owner_person',new.owner_person,
      'owner_area',new.owner_area,
      'context',new.context,
      'situation',new.situation,
      'charge_action',new.charge_action,
      'button_label','Abrir aviso completo'
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

drop trigger if exists trg_notify_adler_manager_attention on agency_ops.manager_attention_alerts;
create trigger trg_notify_adler_manager_attention
after insert or update of status,occurrence_count,level,priority,context,situation,charge_action,last_seen_at
on agency_ops.manager_attention_alerts
for each row execute function agency_ops.notify_adler_manager_attention();

insert into agency_ops.platform_notifications(
  event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
)
select
  'manager-attention-radar:'||a.id::text||':'||greatest(1,coalesce(a.occurrence_count,1))::text,
  'MANAGER_ATTENTION_RADAR',
  case when a.level='COBRAR_AGORA' or a.priority in ('CRITICAL','HIGH') then 'ATTENTION' else 'INFO' end,
  'Radar gerencial · '||
    case a.level when 'COBRAR_AGORA' then 'COBRAR AGORA' when 'ACOMPANHAR_HOJE' then 'ACOMPANHAR HOJE' else 'VERIFICAR INTERNAMENTE' end
    ||' · '||coalesce(a.client_name,'Operação'),
  left(coalesce(nullif(a.charge_action,''),nullif(a.situation,''),nullif(a.context,''),'Há um alerta gerencial aberto.'),700),
  case when a.client_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then a.client_id::uuid else null end,
  'manager_attention_radar','Sistema',coalesce(a.last_seen_at,now()),null,
  jsonb_build_object(
    'private_to_person',true,'target_person','Adler Furtado','target_role','MGMT',
    'manager_attention_alert_id',a.id,'manager_attention_occurrence',greatest(1,coalesce(a.occurrence_count,1)),
    'manager_attention_level',a.level,'owner_person',a.owner_person,'owner_area',a.owner_area,
    'context',a.context,'situation',a.situation,'charge_action',a.charge_action,'button_label','Abrir aviso completo'
  )
from agency_ops.manager_attention_alerts a
where a.status='OPEN'
on conflict(event_key) do update
set title=excluded.title,description=excluded.description,client_id=excluded.client_id,level=excluded.level,
    occurred_at=excluded.occurred_at,metadata=excluded.metadata;

create or replace function agency_ops.notify_adler_churned_message_warning()
returns trigger
language plpgsql
security definer
set search_path=agency_ops,pg_catalog
as $fn$
begin
  if new.target_person <> 'Adler Furtado' or new.acknowledged_at is not null then return new; end if;

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,source,actor,occurred_at,read_at,metadata
  ) values (
    'churned-client-message-warning:'||new.id::text,
    'CHURNED_CLIENT_MESSAGE_WARNING','ATTENTION',
    case when new.is_good_morning then 'Bom dia enviado para cliente churned' else 'Mensagem enviada para cliente churned' end,
    coalesce(new.client_name,'Cliente')||' · '||left(coalesce(new.message_text,'Mensagem detectada em grupo churned.'),500),
    new.client_id,'churned_client_message_warning',coalesce(new.actor_name,'Sistema'),coalesce(new.message_at,new.created_at,now()),null,
    jsonb_build_object(
      'private_to_person',true,'target_person','Adler Furtado','target_role','MGMT',
      'churned_warning_id',new.id,'chat_name',new.chat_name,'message_text',new.message_text,
      'is_good_morning',new.is_good_morning,'button_label','Abrir aviso completo'
    )
  )
  on conflict(event_key) do update
    set title=excluded.title,description=excluded.description,occurred_at=excluded.occurred_at,
        read_at=null,metadata=excluded.metadata;
  return new;
end
$fn$;

drop trigger if exists trg_notify_adler_churned_message_warning on agency_ops.churned_client_message_warnings;
create trigger trg_notify_adler_churned_message_warning
after insert or update of acknowledged_at
on agency_ops.churned_client_message_warnings
for each row execute function agency_ops.notify_adler_churned_message_warning();
