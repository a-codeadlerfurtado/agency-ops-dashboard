-- [APROVAÇÕES] - Design é um fluxo interno Design -> CS.
-- Nunca deve ser interpretado como aprovação do cliente nem como nova demanda para GT/ClickUp.

create table if not exists agency_ops.creative_preapproval_items (
  id bigserial primary key,
  client_id uuid references agency_ops.clients(id) on delete set null,
  client_label text not null,
  subject text,
  subject_key text,
  demand_label text,
  drive_url text,
  status text not null default 'WAITING_CS' check (status in ('WAITING_CS','APPROVED_INTERNAL','ADJUSTMENT_REQUESTED')),
  submission_kind text not null default 'SUBMITTED' check (submission_kind in ('SUBMITTED','RESUBMITTED')),
  revision_no integer not null default 1 check (revision_no >= 1),
  parent_item_id bigint references agency_ops.creative_preapproval_items(id) on delete set null,
  submitted_at timestamptz not null,
  submitted_by text,
  submitted_by_phone text,
  submission_message_id text not null unique,
  reviewed_at timestamptz,
  reviewed_by text,
  reviewer_role text,
  review_message_id text,
  review_text text,
  decision_confidence text,
  source_chat_id text not null,
  source_group_name text,
  raw_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creative_preapproval_items_status_submitted_idx
  on agency_ops.creative_preapproval_items(status, submitted_at desc);
create index if not exists creative_preapproval_items_client_status_idx
  on agency_ops.creative_preapproval_items(client_id, status, submitted_at desc);

create table if not exists agency_ops.creative_preapproval_events (
  id bigserial primary key,
  item_id bigint references agency_ops.creative_preapproval_items(id) on delete set null,
  client_id uuid references agency_ops.clients(id) on delete set null,
  event_type text not null check (event_type in ('SUBMITTED','RESUBMITTED','APPROVED_INTERNAL','ADJUSTMENT_REQUESTED','UNMATCHED_REVIEW')),
  message_id text not null unique,
  chat_id text not null,
  group_name text,
  sender_name text,
  sender_phone text,
  sender_role text,
  body text,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists creative_preapproval_events_item_idx
  on agency_ops.creative_preapproval_events(item_id, occurred_at desc);

create or replace function agency_ops.normalize_internal_workflow_label(p_value text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(lower(extensions.unaccent(coalesce(p_value,''))), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function agency_ops.resolve_creative_preapproval_client(p_label text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
declare
  v_norm text := agency_ops.normalize_internal_workflow_label(p_label);
  v_client uuid;
begin
  if v_norm = '' then return null; end if;

  select a.client_id into v_client
  from agency_ops.clickup_client_aliases a
  where a.active = true
    and a.normalized_alias = v_norm
  order by a.is_manual desc, a.confidence desc, a.updated_at desc
  limit 1;

  if v_client is not null then return v_client; end if;

  select c.id into v_client
  from agency_ops.clients c
  where agency_ops.normalize_internal_workflow_label(c.display_name) = v_norm
     or agency_ops.normalize_internal_workflow_label(coalesce(c.normalized_name,'')) = v_norm
  order by case when c.lifecycle in ('ACTIVE','ONBOARDING') then 0 else 1 end, c.updated_at desc
  limit 1;

  return v_client;
end;
$$;

create or replace function agency_ops.capture_creative_preapproval_message(p_message_row_id bigint)
returns void
language plpgsql
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
declare
  m agency_ops.whatsapp_messages%rowtype;
  v_txt text;
  v_norm text;
  v_label text;
  v_client uuid;
  v_role text;
  v_drive text;
  v_subject text;
  v_subject_key text;
  v_demand_label text;
  v_submission_kind text;
  v_parent_id bigint;
  v_revision integer := 1;
  v_item_id bigint;
  v_is_approval boolean := false;
  v_is_adjustment boolean := false;
  v_candidate_count integer := 0;
  v_decision_confidence text;
begin
  select * into m from agency_ops.whatsapp_messages where id = p_message_row_id;
  if not found then return; end if;

  if coalesce(m.chat_id,'') <> '120363405788325807-group'
     and agency_ops.normalize_internal_workflow_label(coalesce(m.chat_name,'')) <> 'aprovacoes design' then
    return;
  end if;

  v_txt := coalesce(nullif(trim(m.text_body),''), nullif(trim(m.caption),''));
  if v_txt is null then return; end if;
  v_norm := agency_ops.normalize_internal_workflow_label(v_txt);

  select w.role into v_role
  from agency_ops.whatsapp_team_identities w
  where w.active = true
    and (
      (w.identity_type = 'PHONE' and regexp_replace(w.identity_value,'\D','','g') = regexp_replace(coalesce(m.sender_phone,m.participant_phone,''),'\D','','g'))
      or
      (w.identity_type = 'NAME' and agency_ops.normalize_internal_workflow_label(w.identity_value) = agency_ops.normalize_internal_workflow_label(m.sender_name))
    )
  order by case when w.identity_type = 'PHONE' then 0 else 1 end, w.updated_at desc
  limit 1;

  -- Designer publicou uma entrega para revisão interna do CS.
  if v_role = 'DESIGN' then
    v_label := nullif(trim(substring(v_txt from '\[([^\]]+)\]')), '');
    if v_label is null then return; end if;
    if agency_ops.normalize_internal_workflow_label(v_label) in ('ajustado','ajustada','ajustados','ajustadas') then
      v_label := nullif(trim(substring(v_txt from '(?i)(?:ajustad[oa]s?\]?\s*)\[([^\]]+)\]')), '');
    end if;
    if v_label is null then return; end if;

    v_client := agency_ops.resolve_creative_preapproval_client(v_label);
    v_drive := substring(v_txt from '(https?://[^[:space:]]+)');

    -- Só considera entrega quando há ativo/link e o texto identifica criativo/campanha.
    if v_drive is null or v_norm !~ '(criativ|campanha)' then return; end if;

    v_submission_kind := case when v_norm ~ '(^| )ajustad[oa]s?( |$)' then 'RESUBMITTED' else 'SUBMITTED' end;
    v_demand_label := case
      when v_norm ~ 'ajuste na campanha' then 'Ajuste na campanha'
      when v_norm ~ 'campanha' then 'Campanha'
      else 'Criativos'
    end;

    v_subject := regexp_replace(v_txt, 'https?://[^[:space:]]+', '', 'gi');
    v_subject := regexp_replace(v_subject, '\[[^\]]+\]', ' ', 'g');
    v_subject := regexp_replace(v_subject, '(?i)\bajustad[oa]s?\b', ' ', 'g');
    v_subject := trim(regexp_replace(v_subject, '[[:space:]]+', ' ', 'g'));
    v_subject := trim(both ' -' from v_subject);
    v_subject_key := agency_ops.normalize_internal_workflow_label(v_subject);

    if v_submission_kind = 'RESUBMITTED' and v_client is not null then
      select i.id, i.revision_no + 1 into v_parent_id, v_revision
      from agency_ops.creative_preapproval_items i
      where i.client_id = v_client
        and i.submitted_at <= coalesce(m.event_at,m.received_at,now())
        and i.submitted_at >= coalesce(m.event_at,m.received_at,now()) - interval '14 days'
        and (i.status = 'ADJUSTMENT_REQUESTED' or i.drive_url = v_drive or (v_subject_key <> '' and i.subject_key = v_subject_key))
      order by i.submitted_at desc, i.id desc
      limit 1;
    end if;

    insert into agency_ops.creative_preapproval_items (
      client_id, client_label, subject, subject_key, demand_label, drive_url,
      status, submission_kind, revision_no, parent_item_id,
      submitted_at, submitted_by, submitted_by_phone, submission_message_id,
      source_chat_id, source_group_name, raw_text, metadata
    ) values (
      v_client, v_label, nullif(v_subject,''), nullif(v_subject_key,''), v_demand_label, v_drive,
      'WAITING_CS', v_submission_kind, coalesce(v_revision,1), v_parent_id,
      coalesce(m.event_at,m.received_at,now()), m.sender_name, coalesce(m.sender_phone,m.participant_phone), m.message_id,
      m.chat_id, m.chat_name, v_txt,
      jsonb_build_object('meaning','DESIGN_DELIVERED_FOR_INTERNAL_CS_REVIEW','customer_approval',false,'publish_authorization',false)
    )
    on conflict (submission_message_id) do update
      set client_id = excluded.client_id,
          client_label = excluded.client_label,
          subject = excluded.subject,
          subject_key = excluded.subject_key,
          demand_label = excluded.demand_label,
          drive_url = excluded.drive_url,
          submitted_at = excluded.submitted_at,
          submitted_by = excluded.submitted_by,
          submitted_by_phone = excluded.submitted_by_phone,
          source_group_name = excluded.source_group_name,
          raw_text = excluded.raw_text,
          metadata = agency_ops.creative_preapproval_items.metadata || excluded.metadata,
          updated_at = now()
    returning id into v_item_id;

    insert into agency_ops.creative_preapproval_events (
      item_id, client_id, event_type, message_id, chat_id, group_name,
      sender_name, sender_phone, sender_role, body, occurred_at, metadata
    ) values (
      v_item_id, v_client, v_submission_kind, m.message_id, m.chat_id, m.chat_name,
      m.sender_name, coalesce(m.sender_phone,m.participant_phone), v_role, v_txt, coalesce(m.event_at,m.received_at,now()),
      jsonb_build_object('customer_approval',false,'workflow','DESIGN_TO_CS_PREAPPROVAL')
    )
    on conflict (message_id) do nothing;
    return;
  end if;

  -- A pré-aprovação é interna. CS (e gestão, quando substituindo o CS) pode decidir.
  if coalesce(v_role,'') not in ('CS','MGMT') then return; end if;

  v_is_approval := v_norm ~ '(^| )(aprovad[oa]s?|apovad[oa]s?)( |$)'
                   or v_norm ~ '(pode enviar|pode mandar|pode seguir|pode encaminhar|liberado para enviar|liberada para enviar)';
  v_is_adjustment := not v_is_approval and (
      v_norm ~ '(^| )(ajustar|corrigir|alterar|trocar|mudar|refazer|revisar|retirar|remover|inserir|corrige|altera|troca|muda|refaz|revisa)( |$)'
      or v_norm ~ '(ainda esta cortado|ainda ta cortado|esta errado|ta errado|precisa mudar|precisa ajustar|precisa corrigir)'
  );
  if not v_is_approval and not v_is_adjustment then return; end if;

  v_label := nullif(trim(substring(v_txt from '\[([^\]]+)\]')), '');
  if v_label is not null then v_client := agency_ops.resolve_creative_preapproval_client(v_label); end if;

  if v_client is not null then
    select i.id into v_item_id
    from agency_ops.creative_preapproval_items i
    where i.client_id = v_client
      and i.status = 'WAITING_CS'
      and i.submitted_at <= coalesce(m.event_at,m.received_at,now())
      and i.submitted_at >= coalesce(m.event_at,m.received_at,now()) - interval '72 hours'
    order by i.submitted_at desc, i.id desc
    limit 1;
    if v_item_id is not null then v_decision_confidence := 'EXPLICIT_CLIENT'; end if;
  end if;

  if v_item_id is null then
    select count(*), min(id) into v_candidate_count, v_item_id
    from agency_ops.creative_preapproval_items i
    where i.source_chat_id = m.chat_id
      and i.status = 'WAITING_CS'
      and i.submitted_at <= coalesce(m.event_at,m.received_at,now())
      and i.submitted_at >= coalesce(m.event_at,m.received_at,now()) - interval '15 minutes';
    if v_candidate_count = 1 then
      v_decision_confidence := 'SINGLE_RECENT_SUBMISSION';
    else
      v_item_id := null;
    end if;
  end if;

  if v_item_id is not null then
    select client_id into v_client from agency_ops.creative_preapproval_items where id = v_item_id;
    update agency_ops.creative_preapproval_items
    set status = case when v_is_approval then 'APPROVED_INTERNAL' else 'ADJUSTMENT_REQUESTED' end,
        reviewed_at = coalesce(m.event_at,m.received_at,now()),
        reviewed_by = m.sender_name,
        reviewer_role = v_role,
        review_message_id = m.message_id,
        review_text = v_txt,
        decision_confidence = v_decision_confidence,
        updated_at = now()
    where id = v_item_id;
  end if;

  insert into agency_ops.creative_preapproval_events (
    item_id, client_id, event_type, message_id, chat_id, group_name,
    sender_name, sender_phone, sender_role, body, occurred_at, metadata
  ) values (
    v_item_id, v_client,
    case when v_item_id is null then 'UNMATCHED_REVIEW' when v_is_approval then 'APPROVED_INTERNAL' else 'ADJUSTMENT_REQUESTED' end,
    m.message_id, m.chat_id, m.chat_name,
    m.sender_name, coalesce(m.sender_phone,m.participant_phone), v_role, v_txt, coalesce(m.event_at,m.received_at,now()),
    jsonb_build_object('decision_confidence',coalesce(v_decision_confidence,'UNMATCHED'),'customer_approval',false,'workflow','DESIGN_TO_CS_PREAPPROVAL')
  )
  on conflict (message_id) do nothing;
end;
$$;

create or replace function agency_ops.tg_capture_creative_preapproval()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
begin
  perform agency_ops.capture_creative_preapproval_message(new.id);
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_capture_creative_preapproval on agency_ops.whatsapp_messages;
create trigger trg_capture_creative_preapproval
after insert or update of text_body, caption, chat_id, chat_name, sender_name, sender_phone, participant_phone, event_at, received_at
on agency_ops.whatsapp_messages
for each row execute function agency_ops.tg_capture_creative_preapproval();

-- O grupo interno deixa de alimentar o Task Engine genérico.
create or replace function agency_ops.tg_enqueue_task_event()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public', 'extensions', 'pg_temp'
as $$
declare
  v_txt       text;
  v_cls       record;
  v_client    uuid;
  v_espera    interval;
  v_existente bigint;
  v_prefixo   text;
begin
  if coalesce(new.from_me, false) or not coalesce(new.is_group, false) then return new; end if;

  if coalesce(new.chat_id,'') = '120363405788325807-group'
     or agency_ops.normalize_internal_workflow_label(coalesce(new.chat_name,'')) = 'aprovacoes design' then
    return new;
  end if;

  v_txt := coalesce(nullif(trim(new.text_body),''), nullif(trim(new.caption),''));
  if v_txt is null then return new; end if;

  begin
    select * into v_cls from agency_ops.classify_message_urgency(v_txt);
    if v_cls.signals @> array['RUIDO'] or v_cls.signals @> array['SEM_SINAL'] then return new; end if;

    select ci.client_id into v_client from agency_ops.client_integrations ci
    where ci.system = 'WHATSAPP_GROUP' and ci.external_id = new.chat_id limit 1;
    if v_client is null then select cs.client_id into v_client from agency_ops.conversation_state cs where cs.chat_id = new.chat_id limit 1; end if;
    if v_client is null then select r.client_id into v_client from agency_ops.whatsapp_chat_registry r where r.chat_id = new.chat_id and r.client_id is not null limit 1; end if;
    if v_client is null then select g.client_id into v_client from agency_ops.whatsapp_group_registry g where g.chat_id = new.chat_id and g.client_id is not null limit 1; end if;
    if v_client is null then
      v_prefixo := nullif(trim(substring(v_txt from '\[([^\]]+)\]')), '');
      if v_prefixo is not null then
        select c.id into v_client from agency_ops.clients c
        where lower(extensions.unaccent(c.display_name)) = lower(extensions.unaccent(v_prefixo))
           or lower(extensions.unaccent(coalesce(c.normalized_name,''))) = lower(extensions.unaccent(v_prefixo))
        order by case when c.lifecycle in ('ACTIVE','ONBOARDING') then 0 else 1 end, c.updated_at desc limit 1;
      end if;
    end if;

    v_espera := case when v_cls.urgency = 'URGENT' then interval '0' when v_cls.urgency = 'HIGH' then interval '3 minutes' else interval '5 minutes' end;
    select id into v_existente from agency_ops.task_generation_events where chat_id = new.chat_id and status = 'PENDING' order by id desc limit 1;
    if v_existente is not null then
      update agency_ops.task_generation_events e
      set urgency = case when 'URGENT' in (e.urgency, v_cls.urgency) then 'URGENT' when 'HIGH' in (e.urgency, v_cls.urgency) then 'HIGH' else e.urgency end,
          signals = (select array_agg(distinct x) from unnest(e.signals || v_cls.signals) x),
          message_id = new.message_id,
          excerpt = left(coalesce(e.excerpt,'') || chr(10) || v_txt, 4000),
          client_id = coalesce(e.client_id, v_client),
          available_at = least(e.available_at, now() + v_espera)
      where e.id = v_existente;
    else
      insert into agency_ops.task_generation_events (source, chat_id, client_id, message_id, urgency, signals, excerpt, available_at)
      values ('WHATSAPP', new.chat_id, v_client, new.message_id, v_cls.urgency, v_cls.signals, left(v_txt,4000), now() + v_espera);
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

-- Encerra somente eventos ainda pendentes desse grupo; histórico permanece auditável.
update agency_ops.task_generation_events
set status = 'DONE', processed_at = coalesce(processed_at,now()), last_error = 'ignored_internal_creative_preapproval_group'
where chat_id = '120363405788325807-group' and status = 'PENDING';

-- Começa com histórico recente suficiente para preencher a fila atual sem transformar o grupo em fonte de demanda.
do $$
declare r record;
begin
  for r in
    select id from agency_ops.whatsapp_messages
    where chat_id = '120363405788325807-group'
      and event_at >= now() - interval '48 hours'
    order by event_at, id
  loop
    perform agency_ops.capture_creative_preapproval_message(r.id);
  end loop;
end;
$$;

create or replace view agency_ops.creative_preapproval_queue as
select
  i.id,
  i.client_id,
  coalesce(c.display_name,i.client_label) as display_name,
  i.client_label,
  i.subject,
  i.demand_label,
  i.drive_url,
  i.status,
  i.submission_kind,
  i.revision_no,
  i.submitted_at,
  i.submitted_by,
  i.reviewed_at,
  i.reviewed_by,
  i.review_text,
  i.decision_confidence,
  c.designer_owner,
  c.cs_owner,
  greatest(0, floor(extract(epoch from (now() - i.submitted_at))/60))::integer as waiting_minutes,
  case
    when i.status <> 'WAITING_CS' then 'DONE'
    when now() - i.submitted_at >= interval '4 hours' then 'LATE'
    when now() - i.submitted_at >= interval '1 hour' then 'ATTENTION'
    else 'OK'
  end as wait_band,
  i.source_group_name,
  i.submission_message_id
from agency_ops.creative_preapproval_items i
left join agency_ops.clients c on c.id = i.client_id;
