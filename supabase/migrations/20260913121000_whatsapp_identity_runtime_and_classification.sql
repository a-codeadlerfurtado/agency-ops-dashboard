alter table agency_ops.whatsapp_group_identity_sync_state
  add column if not exists classification text,
  add column if not exists classification_confirmed boolean not null default false,
  add column if not exists classification_source text;

create index if not exists whatsapp_group_identity_sync_state_classification_idx
  on agency_ops.whatsapp_group_identity_sync_state(classification,classification_confirmed);

create table if not exists agency_ops.whatsapp_identity_sync_debounce (
  chat_id text primary key,
  requested_at timestamptz not null default now(),
  notification text,
  updated_at timestamptz not null default now()
);

create or replace function agency_ops.request_whatsapp_identity_sync(p_action text, p_chat_id text default null)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog','extensions'
as $function$
declare
  v_req bigint;
  v_token text;
  v_body jsonb := jsonb_build_object('action',p_action);
  v_timeout integer := case when p_action='sync_all' then 360000 when p_action='sync_batch' then 60000 else 30000 end;
  v_slug text := case when p_action='sync_all' then 'agency-ops-whatsapp-identity-sync-all' else 'agency-ops-whatsapp-identity-sync' end;
begin
  select request_token into v_token from agency_ops.whatsapp_identity_sync_runtime where singleton=true;
  if coalesce(length(v_token),0) < 32 then return null; end if;
  if p_chat_id is not null then v_body := v_body || jsonb_build_object('chat_id',p_chat_id); end if;
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/'||v_slug,
    headers := jsonb_build_object('Content-Type','application/json','x-automation-secret',v_token),
    body := v_body,
    timeout_milliseconds := v_timeout
  ) into v_req;
  return v_req;
exception when others then return null;
end
$function$;

create or replace function agency_ops.capture_whatsapp_participant_identity_live()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $function$
declare
  v_phone text;
  v_lid text;
  v_key text;
  v_client uuid;
  v_team_name text;
  v_team_role text;
  v_side text;
  v_role text;
  v_name text;
  v_at timestamptz := coalesce(new.event_at,new.received_at,now());
begin
  if new.chat_id is null or not (coalesce(new.is_group,false) or new.chat_id like '%-group') then return new; end if;
  v_phone := nullif(regexp_replace(coalesce(nullif(new.participant_phone,''),nullif(new.sender_phone,'')), '[^0-9]', '', 'g'),'');
  if coalesce(length(v_phone),0) < 8 then v_phone := null; end if;
  v_lid := nullif(regexp_replace(coalesce(new.participant_lid,new.sender_lid,''), '[^0-9]', '', 'g'),'');
  if v_phone is null and v_lid is null then return new; end if;
  v_key := case when v_phone is not null then 'phone:'||v_phone else 'lid:'||v_lid end;

  select r.client_id into v_client from agency_ops.whatsapp_chat_registry r where r.chat_id=new.chat_id and r.client_id is not null limit 1;
  if v_client is null then select r.client_id into v_client from agency_ops.whatsapp_group_registry r where r.chat_id=new.chat_id and r.client_id is not null limit 1; end if;

  if v_phone is not null then
    select t.canonical_name,t.role into v_team_name,v_team_role
    from agency_ops.whatsapp_team_identities t
    where t.identity_type='PHONE' and regexp_replace(t.identity_value,'[^0-9]','','g')=v_phone and t.active=true limit 1;
  end if;

  v_side := case when v_team_name is not null then 'TEAM' when v_client is not null then 'CLIENT_SIDE' else 'EXTERNAL' end;
  v_name := coalesce(v_team_name,nullif(trim(new.sender_name),''));
  v_role := coalesce(v_team_role,case when v_client is not null then 'CLIENT_CONTACT' else null end);

  insert into agency_ops.whatsapp_participant_identity as i(
    chat_id,identity_key,phone,sender_lid,canonical_name,client_id,side,role_hint,confidence,source,
    first_seen_at,last_seen_at,last_message_id,metadata,updated_at
  ) values (
    new.chat_id,v_key,v_phone,v_lid,v_name,case when v_team_name is not null then null else v_client end,
    v_side,v_role,case when v_team_name is not null then 1.0 when v_client is not null then 0.95 when v_name is not null then 0.75 else 0.55 end,
    'WHATSAPP_LIVE_FIRST_SEEN',v_at,v_at,new.id,
    jsonb_build_object('whatsapp_name',nullif(trim(new.sender_name),''),'first_seen_live',true,'active_in_group',true),now()
  )
  on conflict (chat_id,identity_key) do update set
    phone=coalesce(i.phone,excluded.phone), sender_lid=coalesce(i.sender_lid,excluded.sender_lid),
    canonical_name=case when upper(coalesce(i.source,'')) like 'RELATO_MANUAL%' then i.canonical_name else coalesce(i.canonical_name,excluded.canonical_name) end,
    client_id=case when upper(coalesce(i.source,'')) like 'RELATO_MANUAL%' then i.client_id else coalesce(i.client_id,excluded.client_id) end,
    side=case when upper(coalesce(i.source,'')) like 'RELATO_MANUAL%' then i.side when excluded.side='TEAM' or i.side='TEAM' then 'TEAM' else coalesce(i.side,excluded.side) end,
    role_hint=case when upper(coalesce(i.source,'')) like 'RELATO_MANUAL%' then i.role_hint else coalesce(i.role_hint,excluded.role_hint) end,
    confidence=greatest(i.confidence,excluded.confidence),
    source=case when upper(coalesce(i.source,'')) like 'RELATO_MANUAL%' then i.source else excluded.source end,
    first_seen_at=least(coalesce(i.first_seen_at,excluded.first_seen_at),excluded.first_seen_at),
    last_seen_at=greatest(coalesce(i.last_seen_at,excluded.last_seen_at),excluded.last_seen_at),
    last_message_id=excluded.last_message_id,
    metadata=coalesce(i.metadata,'{}'::jsonb)||excluded.metadata,
    updated_at=now();
  return new;
end
$function$;

drop trigger if exists trg_whatsapp_participant_identity_live on agency_ops.whatsapp_messages;
create trigger trg_whatsapp_participant_identity_live
after insert or update on agency_ops.whatsapp_messages
for each row execute function agency_ops.capture_whatsapp_participant_identity_live();

create or replace function agency_ops.request_whatsapp_group_identity_sync_from_registry()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $function$
begin
  if new.chat_id is null or new.chat_id not like '%-group' then return new; end if;
  if tg_op='UPDATE' and new.client_id is not distinct from old.client_id and new.chat_name is not distinct from old.chat_name then return new; end if;
  perform agency_ops.request_whatsapp_identity_sync('sync_group',new.chat_id);
  return new;
end
$function$;

drop trigger if exists trg_whatsapp_group_identity_sync_registry on agency_ops.whatsapp_chat_registry;
create trigger trg_whatsapp_group_identity_sync_registry
after insert or update on agency_ops.whatsapp_chat_registry
for each row execute function agency_ops.request_whatsapp_group_identity_sync_from_registry();

create or replace function agency_ops.request_whatsapp_identity_sync_from_group_notification()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $function$
declare
  v_notification text := coalesce(new.raw_json->>'notification','');
  v_chat text := new.chat_id;
  v_acquired text;
begin
  if v_chat is null or v_chat not like '%-group' then return new; end if;
  if v_notification not in (
    'GROUP_CREATE','GROUP_CHANGE_SUBJECT','GROUP_CHANGE_DESCRIPTION','GROUP_CHANGE_ICON',
    'GROUP_PARTICIPANT_PROMOTE','GROUP_PARTICIPANT_DEMOTE','GROUP_PARTICIPANT_LEAVE',
    'GROUP_PARTICIPANT_ADD','GROUP_PARTICIPANT_REMOVE','GROUP_PARTICIPANT_INVITE'
  ) then return new; end if;

  insert into agency_ops.whatsapp_identity_sync_debounce as d(chat_id,requested_at,notification,updated_at)
  values(v_chat,now(),v_notification,now())
  on conflict(chat_id) do update set
    requested_at=excluded.requested_at,
    notification=excluded.notification,
    updated_at=now()
  where d.requested_at < now()-interval '15 seconds'
  returning chat_id into v_acquired;

  if v_acquired is not null then
    perform agency_ops.request_whatsapp_identity_sync('sync_group',v_chat);
  end if;
  return new;
end
$function$;

drop trigger if exists trg_whatsapp_identity_group_notification on agency_ops.whatsapp_zapi_raw;
create trigger trg_whatsapp_identity_group_notification
after insert on agency_ops.whatsapp_zapi_raw
for each row execute function agency_ops.request_whatsapp_identity_sync_from_group_notification();

-- A number known as team/system must never remain an active client-phone relation.
update agency_ops.client_phone_registry r
set active=false, updated_at=now()
where r.active=true and exists (
  select 1 from agency_ops.whatsapp_team_identities t
  where t.identity_type='PHONE' and t.active=true
    and regexp_replace(t.identity_value,'[^0-9]','','g')=r.phone
);

-- Classification is durable and must not be overwritten by snapshot metadata refreshes.
update agency_ops.whatsapp_group_identity_sync_state s
set classification=case
      when s.client_id is not null then 'CLIENT'
      when r.scope='INTERNAL' then 'INTERNAL'
      when r.scope='TEST' then 'TEST'
      when r.reason='MANUAL:KNOWN_EXTERNAL_NOT_CLIENT' then 'EXTERNAL_NOT_CLIENT'
      when r.reason='MANUAL:ORPHANED_UNNAMED_GROUP' then 'ORPHANED'
      else s.classification
    end,
    classification_confirmed=case when s.client_id is not null or r.reason like 'MANUAL:%' then true else s.classification_confirmed end,
    classification_source=case when s.client_id is not null then coalesce(s.classification_source,'client_link') when r.reason like 'MANUAL:%' then coalesce(s.classification_source,'manual_audit') else s.classification_source end
from agency_ops.whatsapp_chat_registry r
where r.chat_id=s.chat_id;

update agency_ops.whatsapp_group_identity_sync_state
set classification='CLIENT',classification_confirmed=true,classification_source=coalesce(classification_source,'client_link')
where client_id is not null;

do $do$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname='whatsapp_identity_sync_all' loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule('whatsapp_identity_sync_all','*/5 * * * *',$cron$select agency_ops.request_whatsapp_identity_sync('sync_batch',null);$cron$);
end
$do$;