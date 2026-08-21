-- Produção já aplicada em 21/08/2026.
-- Captura links do Google Meet ligados à etapa de integração do GT, preserva histórico
-- e expõe somente o link corrente no worklist da carteira.

create table if not exists agency_ops.onboarding_stage_meet_links (
  id bigserial primary key,
  case_id bigint not null references agency_ops.onboarding_cases(id) on delete cascade,
  stage_code text not null references agency_ops.onboarding_stage_definitions(code),
  url text not null,
  provider text not null default 'GOOGLE_MEET',
  source text not null default 'whatsapp',
  source_id text,
  occurred_at timestamptz not null default now(),
  scheduled_for timestamptz,
  is_current boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_stage_meet_links_url_check check (url ~ '^https://meet\.google\.com/[A-Za-z0-9-]+')
);

create unique index if not exists onboarding_stage_meet_links_source_unique
  on agency_ops.onboarding_stage_meet_links(source, source_id, url)
  where source_id is not null;
create index if not exists onboarding_stage_meet_links_current_idx
  on agency_ops.onboarding_stage_meet_links(case_id, stage_code, is_current, occurred_at desc);

create or replace function agency_ops.extract_google_meet_url(p_text text)
returns text language sql immutable as $$
  select (regexp_match(coalesce(p_text,''), '(https?://meet\.google\.com/[A-Za-z0-9-]+(?:\?[^[:space:]]+)?)', 'i'))[1]
$$;

create or replace function agency_ops.capture_integration_meet_link_from_whatsapp()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
declare
  v_text text; v_url text; v_case_id bigint; v_current_stage text;
  v_stage_status text; v_due_at timestamptz; v_gt_owner text; v_occurred_at timestamptz;
begin
  if coalesce(new.is_group,false) is not true then return new; end if;
  v_text := trim(coalesce(new.text_body,'') || ' ' || coalesce(new.caption,''));
  v_url := agency_ops.extract_google_meet_url(v_text);
  if v_url is null then return new; end if;

  select oc.id,oc.current_stage,s.status,s.due_at,c.gt_owner
    into v_case_id,v_current_stage,v_stage_status,v_due_at,v_gt_owner
  from agency_ops.whatsapp_chat_registry reg
  join agency_ops.clients c on c.id=reg.client_id
  join agency_ops.onboarding_cases oc on oc.client_id=c.id and oc.status='OPEN'
  join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code='INTEGRATION_MEETING'
  where reg.chat_id=new.chat_id
  order by oc.updated_at desc,oc.id desc limit 1;

  if v_case_id is null or nullif(btrim(coalesce(v_gt_owner,'')),'') is null then return new; end if;
  if not (v_current_stage='INTEGRATION_MEETING' or v_stage_status in ('SCHEDULED','IN_PROGRESS')) then return new; end if;

  v_occurred_at := coalesce(new.event_at,new.received_at,now());
  insert into agency_ops.onboarding_stage_meet_links(
    case_id,stage_code,url,provider,source,source_id,occurred_at,scheduled_for,is_current,metadata
  ) values (
    v_case_id,'INTEGRATION_MEETING',v_url,'GOOGLE_MEET','whatsapp',new.id::text,
    v_occurred_at,coalesce(v_due_at,v_occurred_at),true,
    jsonb_build_object('message_id',new.message_id,'chat_id',new.chat_id,'sender_name',new.sender_name)
  )
  on conflict (source,source_id,url) where source_id is not null do update
    set occurred_at=excluded.occurred_at,scheduled_for=excluded.scheduled_for,is_current=true,
        metadata=agency_ops.onboarding_stage_meet_links.metadata || excluded.metadata,updated_at=now();
  return new;
end
$$;

drop trigger if exists trg_capture_integration_meet_link on agency_ops.whatsapp_messages;
create trigger trg_capture_integration_meet_link
after insert or update of text_body,caption,chat_id,event_at,received_at on agency_ops.whatsapp_messages
for each row execute function agency_ops.capture_integration_meet_link_from_whatsapp();

create or replace function agency_ops.archive_integration_meet_links_on_stage_change()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
begin
  if new.stage_code <> 'INTEGRATION_MEETING' then return new; end if;
  if new.status in ('DONE','SKIPPED') then
    update agency_ops.onboarding_stage_meet_links set is_current=false,updated_at=now()
    where case_id=new.case_id and stage_code='INTEGRATION_MEETING' and is_current;
  elsif new.status='PENDING' and old.status is distinct from 'PENDING' then
    update agency_ops.onboarding_stage_meet_links set is_current=false,updated_at=now()
    where case_id=new.case_id and stage_code='INTEGRATION_MEETING' and is_current;
  elsif new.due_at is distinct from old.due_at and new.due_at is not null then
    update agency_ops.onboarding_stage_meet_links set is_current=false,updated_at=now()
    where case_id=new.case_id and stage_code='INTEGRATION_MEETING' and is_current
      and scheduled_for is not null
      and abs(extract(epoch from (scheduled_for-new.due_at))) > 7200;
  end if;
  return new;
end
$$;

drop trigger if exists trg_archive_integration_meet_links on agency_ops.onboarding_stages;
create trigger trg_archive_integration_meet_links
after update of status,due_at on agency_ops.onboarding_stages
for each row execute function agency_ops.archive_integration_meet_links_on_stage_change();

create or replace view agency_ops.gt_onboarding_worklist as
select c.id client_id,c.display_name,c.lifecycle,c.entrada,c.gt_owner,wr.carteira,
  oc.id onboarding_case_id,oc.onboarding_risk,oc.current_stage,oc.next_action,oc.next_action_due,
  im.status integration_status,im.started_at integration_started_at,im.due_at integration_due_at,
  im.completed_at integration_completed_at,im.notes integration_notes,
  av.status access_status,av.started_at access_started_at,av.due_at access_due_at,
  av.completed_at access_completed_at,av.notes access_notes,
  case when im.status='BLOCKED' or av.status='BLOCKED' then 'BLOCKED'
       when im.status='SCHEDULED' then 'SCHEDULED'
       when im.status='IN_PROGRESS' then 'IN_PROGRESS'
       when im.status in ('DONE','SKIPPED') and av.status in ('PENDING','SCHEDULED','IN_PROGRESS') then 'ACCESS_VALIDATION'
       when im.status='PENDING' then 'WAITING_SCHEDULING' else 'WAITING_SCHEDULING' end integration_bucket,
  la.attempt_no integration_attempt_no,ac.attempt_count integration_attempt_count,
  la.outcome last_attempt_outcome,la.reason_code last_attempt_reason_code,la.reason_detail last_attempt_reason_detail,
  la.objective_achieved last_attempt_objective_achieved,la.retry_required last_attempt_retry_required,
  la.rescheduled_for last_attempt_rescheduled_for,la.ended_at last_attempt_ended_at,la.evidence_text last_attempt_evidence,
  ml.url integration_meet_url,ml.provider integration_meet_provider,
  ml.occurred_at integration_meet_detected_at,ml.scheduled_for integration_meet_scheduled_for
from agency_ops.clients c
join lateral (select o.* from agency_ops.onboarding_cases o where o.client_id=c.id and o.status='OPEN' order by o.updated_at desc,o.id desc limit 1) oc on true
join agency_ops.onboarding_stages im on im.case_id=oc.id and im.stage_code='INTEGRATION_MEETING'
left join agency_ops.onboarding_stages av on av.case_id=oc.id and av.stage_code='ACCESS_VALIDATION'
left join agency_ops.wallet_registry wr on wr.gt_owner=c.gt_owner
left join lateral (select a.* from agency_ops.onboarding_stage_attempts a where a.case_id=oc.id and a.stage_code='INTEGRATION_MEETING' order by a.attempt_no desc limit 1) la on true
left join lateral (select count(*)::integer attempt_count from agency_ops.onboarding_stage_attempts a where a.case_id=oc.id and a.stage_code='INTEGRATION_MEETING') ac on true
left join lateral (
  select l.url,l.provider,l.occurred_at,l.scheduled_for
  from agency_ops.onboarding_stage_meet_links l
  where l.case_id=oc.id and l.stage_code='INTEGRATION_MEETING' and l.is_current=true
    and (im.due_at is null or l.scheduled_for is null or abs(extract(epoch from (l.scheduled_for-im.due_at))) <= 7200)
  order by l.occurred_at desc,l.id desc limit 1
) ml on true
where nullif(btrim(c.gt_owner),'') is not null
  and (im.status in ('PENDING','SCHEDULED','IN_PROGRESS','BLOCKED')
       or (im.status in ('DONE','SKIPPED') and av.status in ('PENDING','SCHEDULED','IN_PROGRESS','BLOCKED')));
