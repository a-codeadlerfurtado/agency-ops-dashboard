-- Harden onboarding integration scheduling and Meet context.
-- Production equivalent applied in Supabase on 2026-08-21.

create table if not exists agency_ops.onboarding_meeting_schedule_proposals (
  id bigserial primary key,
  case_id bigint not null references agency_ops.onboarding_cases(id) on delete cascade,
  stage_code text not null default 'INTEGRATION_MEETING',
  chat_id text not null,
  proposed_at timestamptz not null,
  proposed_for timestamptz not null,
  proposer_is_team boolean,
  source_message_id bigint,
  source_whatsapp_message_id text,
  proposal_text text,
  status text not null default 'OPEN' check (status in ('OPEN','CONFIRMED','SUPERSEDED','CANCELLED')),
  confirmed_at timestamptz,
  confirmed_by_message_id bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_onboarding_meeting_schedule_proposals_open
  on agency_ops.onboarding_meeting_schedule_proposals(case_id,stage_code,status,proposed_at desc);

create table if not exists agency_ops.whatsapp_ingestion_anomalies (
  id bigserial primary key,
  chat_id text,
  message_id text,
  whatsapp_row_id bigint,
  anomaly_type text not null,
  event_at timestamptz,
  received_at timestamptz,
  lag_seconds integer,
  source text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists whatsapp_ingestion_anomalies_unique
  on agency_ops.whatsapp_ingestion_anomalies(anomaly_type,whatsapp_row_id)
  where whatsapp_row_id is not null;

create or replace function agency_ops.detect_whatsapp_ingestion_anomaly()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','pg_catalog' as $$
declare v_lag numeric;
begin
  if new.event_at is null or new.received_at is null then return new; end if;
  v_lag:=extract(epoch from (new.received_at-new.event_at));
  if v_lag > 900 then
    insert into agency_ops.whatsapp_ingestion_anomalies(chat_id,message_id,whatsapp_row_id,anomaly_type,event_at,received_at,lag_seconds,source,details)
    values(new.chat_id,new.message_id,new.id,'LATE_ARRIVAL',new.event_at,new.received_at,v_lag::int,new.source,
      jsonb_build_object('chat_name',new.chat_name,'sender_name',new.sender_name,'raw_origin',new.raw_json->>'origem'))
    on conflict (anomaly_type,whatsapp_row_id) where whatsapp_row_id is not null do update
      set received_at=excluded.received_at,lag_seconds=excluded.lag_seconds,details=agency_ops.whatsapp_ingestion_anomalies.details||excluded.details;
  end if;
  return new;
end $$;
drop trigger if exists trg_detect_whatsapp_ingestion_anomaly on agency_ops.whatsapp_messages;
create trigger trg_detect_whatsapp_ingestion_anomaly
after insert or update of event_at,received_at on agency_ops.whatsapp_messages
for each row execute function agency_ops.detect_whatsapp_ingestion_anomaly();

create or replace function agency_ops.capture_schedule_audio_review_from_whatsapp()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','pg_catalog','extensions' as $$
declare v_case_id bigint; v_prop_id bigint; v_text text;
begin
  if coalesce(new.is_group,false) is not true then return new; end if;
  v_text:=lower(unaccent(trim(coalesce(new.text_body,'')||' '||coalesce(new.caption,''))));
  if coalesce(new.message_type,'')<>'audio' and v_text not like '%sem texto reconhecido%' then return new; end if;
  select oc.id into v_case_id
  from agency_ops.whatsapp_chat_registry reg
  join agency_ops.onboarding_cases oc on oc.client_id=reg.client_id and oc.status='OPEN'
  join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code='INTEGRATION_MEETING' and s.status in ('PENDING','SCHEDULED')
  where reg.chat_id=new.chat_id order by oc.updated_at desc limit 1;
  if v_case_id is null then return new; end if;
  select p.id into v_prop_id from agency_ops.onboarding_meeting_schedule_proposals p
   where p.case_id=v_case_id and p.status='OPEN' and p.proposed_at>=coalesce(new.event_at,new.received_at,now())-interval '24 hours'
   order by p.proposed_at desc limit 1;
  if v_prop_id is null and not exists(
    select 1 from agency_ops.whatsapp_messages m where m.chat_id=new.chat_id and m.id<>new.id
      and coalesce(m.event_at,m.received_at) between coalesce(new.event_at,new.received_at,now())-interval '60 minutes' and coalesce(new.event_at,new.received_at,now())
      and lower(unaccent(coalesce(m.text_body,'')||' '||coalesce(m.caption,''))) ~ '(reuniao|integracao|horario|podemos|remarcar|reagendar)'
  ) then return new; end if;
  insert into agency_ops.onboarding_evidence(case_id,kind,source,source_id,occurred_at,confidence,status,metadata)
  select v_case_id,'MEETING_SCHEDULING_AUDIO_UNREAD','whatsapp',new.id::text,coalesce(new.event_at,new.received_at,now()),'MEDIUM','PENDING_REVIEW',
    jsonb_build_object('message_id',new.message_id,'chat_id',new.chat_id,'sender_name',new.sender_name,'proposal_id',v_prop_id,'reason','Audio/midia sem texto interpretavel recebido durante negociacao da integracao')
  where not exists(select 1 from agency_ops.onboarding_evidence e where e.case_id=v_case_id and e.kind='MEETING_SCHEDULING_AUDIO_UNREAD' and e.source='whatsapp' and e.source_id=new.id::text);
  return new;
end $$;
drop trigger if exists trg_capture_schedule_audio_review on agency_ops.whatsapp_messages;
create trigger trg_capture_schedule_audio_review
after insert or update of text_body,caption,message_type,chat_id,event_at,received_at on agency_ops.whatsapp_messages
for each row execute function agency_ops.capture_schedule_audio_review_from_whatsapp();

-- The parser and scheduling/Meet trigger functions are intentionally CREATE OR REPLACE
-- in production migrations. Their current definitions can be inspected in Supabase as:
-- agency_ops.extract_ptbr_meeting_datetime
-- agency_ops.capture_integration_schedule_from_whatsapp
-- agency_ops.capture_integration_meet_link_from_whatsapp
-- Rules enforced by those functions:
-- 1. explicit invite date/time > inferred conversational proposal;
-- 2. proposals do not become SCHEDULED without confirmation;
-- 3. confirmations may resolve an open proposal for up to 24h;
-- 4. reschedule + new date in the same message preserves the new proposal;
-- 5. Meet links without integration context are stored historical/ambiguous, never current;
-- 6. supported PT-BR patterns include '24 de agosto 10h', '24/08 as 10h', 'dia 24 as 10h', 'amanha as 10h', and weekday-relative dates.
