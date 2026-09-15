do $$
begin
  if to_regclass('agency_ops.whatsapp_zapi_raw') is null
     and to_regclass('agency_ops.whatsapp_zapi_direct_test') is not null then
    alter table agency_ops.whatsapp_zapi_direct_test rename to whatsapp_zapi_raw;
  end if;
end $$;

alter table agency_ops.whatsapp_zapi_raw
  add column if not exists message_class text,
  add column if not exists processing_status text not null default 'PENDING',
  add column if not exists processed_at timestamptz,
  add column if not exists processing_error text,
  add column if not exists canonical_message_row_id bigint;

create index if not exists whatsapp_zapi_raw_processing_idx
  on agency_ops.whatsapp_zapi_raw(processing_status, received_at);

create table if not exists agency_ops.zapi_message_processing_queue (
  raw_id bigint primary key references agency_ops.whatsapp_zapi_raw(id) on delete cascade,
  message_id text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','DONE','ERROR')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  classification text,
  canonical_inserted boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists zapi_message_processing_queue_pending_idx
  on agency_ops.zapi_message_processing_queue(status, next_attempt_at, created_at);

create table if not exists agency_ops.client_phone_registry (
  id bigserial primary key,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  phone text not null,
  chat_id text not null,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  evidence_count bigint not null default 1,
  source text not null default 'whatsapp_history',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, phone, chat_id)
);

create index if not exists client_phone_registry_phone_idx
  on agency_ops.client_phone_registry(phone) where active;

create table if not exists agency_ops.meta_lead_dispatches (
  id bigserial primary key,
  raw_id bigint not null unique references agency_ops.whatsapp_zapi_raw(id) on delete restrict,
  message_id text not null unique,
  event_at timestamptz,
  connected_phone text,
  recipient_phone text,
  product_label text,
  lead_name text,
  lead_phone text,
  lead_email text,
  recipient_client_id uuid references agency_ops.clients(id),
  expected_client_id uuid references agency_ops.clients(id),
  routing_status text not null default 'ROUTING_UNKNOWN' check (routing_status in ('ROUTING_OK','ROUTING_PROBABLE','ROUTING_CONFLICT','ROUTING_UNKNOWN')),
  recipient_match_method text,
  expected_match_method text,
  group_product_evidence_count integer not null default 0,
  recipient_candidates jsonb not null default '[]'::jsonb,
  expected_candidates jsonb not null default '[]'::jsonb,
  raw_text text,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meta_lead_dispatches_event_idx on agency_ops.meta_lead_dispatches(event_at desc);
create index if not exists meta_lead_dispatches_recipient_client_idx on agency_ops.meta_lead_dispatches(recipient_client_id, event_at desc);
create index if not exists meta_lead_dispatches_expected_client_idx on agency_ops.meta_lead_dispatches(expected_client_id, event_at desc);
create index if not exists meta_lead_dispatches_routing_idx on agency_ops.meta_lead_dispatches(routing_status, event_at desc);
create index if not exists meta_lead_dispatches_lead_phone_idx on agency_ops.meta_lead_dispatches(lead_phone);

create or replace function agency_ops.normalize_match_text(p_text text)
returns text
language sql
stable
set search_path = extensions, public, pg_catalog
as $$
  select btrim(regexp_replace(extensions.unaccent(lower(coalesce(p_text,''))), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function agency_ops.refresh_client_phone_registry_from_whatsapp(p_since interval default interval '2 days')
returns bigint
language plpgsql
security definer
set search_path = agency_ops, public, pg_catalog
as $$
declare
  v_count bigint := 0;
begin
  insert into agency_ops.client_phone_registry(client_id, phone, chat_id, first_seen_at, last_seen_at, evidence_count, source, active, updated_at)
  select
    gr.client_id,
    regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g') as phone,
    wm.chat_id,
    min(coalesce(wm.event_at, wm.received_at)),
    max(coalesce(wm.event_at, wm.received_at)),
    count(*)::bigint,
    'whatsapp_history',
    true,
    now()
  from agency_ops.whatsapp_messages wm
  join agency_ops.whatsapp_group_registry gr on gr.chat_id = wm.chat_id and gr.client_id is not null
  where wm.is_group
    and coalesce(wm.event_at, wm.received_at) >= now() - p_since
    and length(regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g')) >= 8
  group by gr.client_id, regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g'), wm.chat_id
  on conflict (client_id, phone, chat_id) do update set
    first_seen_at = least(coalesce(agency_ops.client_phone_registry.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
    last_seen_at = greatest(coalesce(agency_ops.client_phone_registry.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
    evidence_count = greatest(agency_ops.client_phone_registry.evidence_count, excluded.evidence_count),
    active = true,
    updated_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

insert into agency_ops.client_phone_registry(client_id, phone, chat_id, first_seen_at, last_seen_at, evidence_count, source, active, updated_at)
select
  gr.client_id,
  regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g') as phone,
  wm.chat_id,
  min(coalesce(wm.event_at, wm.received_at)),
  max(coalesce(wm.event_at, wm.received_at)),
  count(*)::bigint,
  'whatsapp_history',
  true,
  now()
from agency_ops.whatsapp_messages wm
join agency_ops.whatsapp_group_registry gr on gr.chat_id = wm.chat_id and gr.client_id is not null
where wm.is_group
  and length(regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g')) >= 8
group by gr.client_id, regexp_replace(coalesce(nullif(wm.participant_phone,''), nullif(wm.sender_phone,'')), '[^0-9]', '', 'g'), wm.chat_id
on conflict (client_id, phone, chat_id) do update set
  first_seen_at = least(coalesce(agency_ops.client_phone_registry.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
  last_seen_at = greatest(coalesce(agency_ops.client_phone_registry.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
  evidence_count = greatest(agency_ops.client_phone_registry.evidence_count, excluded.evidence_count),
  active = true,
  updated_at = now();

create or replace function agency_ops.capture_client_phone_registry()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public, pg_catalog
as $$
declare
  v_client uuid;
  v_phone text;
begin
  if not coalesce(new.is_group,false) or new.chat_id is null then
    return new;
  end if;

  select client_id into v_client
  from agency_ops.whatsapp_group_registry
  where chat_id = new.chat_id and client_id is not null
  limit 1;

  if v_client is null then
    return new;
  end if;

  v_phone := regexp_replace(coalesce(nullif(new.participant_phone,''), nullif(new.sender_phone,'')), '[^0-9]', '', 'g');
  if length(v_phone) < 8 then
    return new;
  end if;

  insert into agency_ops.client_phone_registry(client_id, phone, chat_id, first_seen_at, last_seen_at, evidence_count, source, active, updated_at)
  values (v_client, v_phone, new.chat_id, coalesce(new.event_at,new.received_at), coalesce(new.event_at,new.received_at), 1, 'whatsapp_live', true, now())
  on conflict (client_id, phone, chat_id) do update set
    first_seen_at = least(coalesce(agency_ops.client_phone_registry.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
    last_seen_at = greatest(coalesce(agency_ops.client_phone_registry.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
    evidence_count = agency_ops.client_phone_registry.evidence_count + 1,
    active = true,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists trg_capture_client_phone_registry on agency_ops.whatsapp_messages;
create trigger trg_capture_client_phone_registry
after insert or update of chat_id, participant_phone, sender_phone, is_group on agency_ops.whatsapp_messages
for each row execute function agency_ops.capture_client_phone_registry();

create or replace function agency_ops.process_zapi_raw_pending(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = agency_ops, public, pg_catalog
as $$
declare
  q record;
  r agency_ops.whatsapp_zapi_raw%rowtype;
  v_text text;
  v_product text;
  v_product_norm text;
  v_lead_name text;
  v_lead_phone text;
  v_lead_email text;
  v_recipient_phone text;
  v_recipient_ids uuid[];
  v_recipient_client uuid;
  v_recipient_candidates jsonb := '[]'::jsonb;
  v_evidence_ids uuid[];
  v_group_evidence integer := 0;
  v_expected_ids uuid[];
  v_expected_client uuid;
  v_expected_candidates jsonb := '[]'::jsonb;
  v_recipient_method text;
  v_expected_method text;
  v_routing text;
  v_inserted boolean;
  v_canonical_id bigint;
  v_done integer := 0;
  v_errors integer := 0;
  v_leads integer := 0;
  v_operational integer := 0;
begin
  for q in
    select raw_id
    from agency_ops.zapi_message_processing_queue
    where status in ('PENDING','ERROR')
      and next_attempt_at <= now()
      and attempts < 20
    order by created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,100),1000))
  loop
    begin
      update agency_ops.zapi_message_processing_queue
      set status='PROCESSING', attempts=attempts+1, updated_at=now(), last_error=null
      where raw_id=q.raw_id;

      select * into r from agency_ops.whatsapp_zapi_raw where id=q.raw_id;
      if not found then
        raise exception 'raw row % not found', q.raw_id;
      end if;

      v_text := coalesce(r.text_body, r.caption, '');
      v_product := null;
      v_product_norm := null;
      v_lead_name := null;
      v_lead_phone := null;
      v_lead_email := null;
      v_recipient_phone := null;
      v_recipient_ids := null;
      v_recipient_client := null;
      v_recipient_candidates := '[]'::jsonb;
      v_evidence_ids := null;
      v_group_evidence := 0;
      v_expected_ids := null;
      v_expected_client := null;
      v_expected_candidates := '[]'::jsonb;
      v_recipient_method := null;
      v_expected_method := null;
      v_routing := null;
      v_inserted := null;
      v_canonical_id := null;

      if r.from_me
         and not r.is_group
         and v_text ~* 'NOVO[[:space:]]+LEAD'
         and v_text ~* 'NOME[[:space:]]+DO[[:space:]]+LEAD[[:space:]]*:'
         and v_text ~* 'TELEFONE[[:space:]]*:' then

        v_product := nullif(btrim(coalesce((regexp_match(v_text, '(?i)NOVO[[:space:]]+LEAD[[:space:]]*-[[:space:]]*([^\r\n]+)'))[1],'')), '');
        v_product_norm := agency_ops.normalize_match_text(v_product);
        v_lead_name := nullif(btrim(coalesce((regexp_match(v_text, '(?i)NOME[[:space:]]+DO[[:space:]]+LEAD[[:space:]]*:[[:space:]]*([^\r\n]+)'))[1],'')), '');
        v_lead_phone := nullif(regexp_replace(coalesce((regexp_match(v_text, '(?i)TELEFONE[[:space:]]*:[[:space:]]*([^\r\n]+)'))[1],''), '[^0-9]', '', 'g'), '');
        v_lead_email := nullif(btrim(coalesce((regexp_match(v_text, '(?i)EMAIL[[:space:]]*:[[:space:]]*([^\r\n ]+)'))[1],'')), '');
        v_recipient_phone := nullif(regexp_replace(coalesce(r.chat_id,''), '[^0-9]', '', 'g'), '');

        select array_agg(distinct cpr.client_id),
               coalesce(jsonb_agg(distinct jsonb_build_object('client_id',cpr.client_id,'client_name',c.display_name,'chat_id',cpr.chat_id,'evidence_count',cpr.evidence_count)), '[]'::jsonb)
        into v_recipient_ids, v_recipient_candidates
        from agency_ops.client_phone_registry cpr
        join agency_ops.clients c on c.id=cpr.client_id
        where cpr.active and cpr.phone=v_recipient_phone;

        if coalesce(cardinality(v_recipient_ids),0)=1 then
          v_recipient_client := v_recipient_ids[1];
          v_recipient_method := 'DESTINATION_PHONE_UNIQUE_GROUP_CLIENT';
        elsif coalesce(cardinality(v_recipient_ids),0)>1 and length(coalesce(v_product_norm,''))>=5 then
          select array_agg(client_id)
          into v_evidence_ids
          from (
            select gr.client_id, count(*) as evidence_count
            from agency_ops.whatsapp_messages wm
            join agency_ops.whatsapp_group_registry gr on gr.chat_id=wm.chat_id and gr.client_id = any(v_recipient_ids)
            where agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,'')) like '%'||v_product_norm||'%'
               or public.word_similarity(v_product_norm, agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,''))) >= 0.55
            group by gr.client_id
            having count(*)>0
          ) s;
          if coalesce(cardinality(v_evidence_ids),0)=1 then
            v_recipient_client := v_evidence_ids[1];
            v_recipient_method := 'DESTINATION_PHONE_PLUS_GROUP_PRODUCT';
          end if;
        end if;

        if v_recipient_client is not null and length(coalesce(v_product_norm,''))>=5 then
          select count(*)::integer into v_group_evidence
          from agency_ops.whatsapp_messages wm
          join agency_ops.whatsapp_group_registry gr on gr.chat_id=wm.chat_id and gr.client_id=v_recipient_client
          where agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,'')) like '%'||v_product_norm||'%'
             or public.word_similarity(v_product_norm, agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,''))) >= 0.55;
        end if;

        if length(coalesce(v_product_norm,''))>=5 then
          with campaigns as (
            select distinct client_id, campaign_id, campaign_name from agency_ops.campaign_latest_details where client_id is not null and campaign_name is not null
            union
            select distinct client_id, campaign_id, campaign_name from agency_ops.meta_campaign_inventory where client_id is not null and campaign_name is not null
            union
            select distinct client_id, campaign_id, campaign_name from agency_ops.meta_campaign_insights where client_id is not null and campaign_name is not null
          ), scored as (
            select client_id, campaign_id, campaign_name,
                   greatest(
                     public.similarity(agency_ops.normalize_match_text(campaign_name), v_product_norm),
                     public.word_similarity(v_product_norm, agency_ops.normalize_match_text(campaign_name))
                   ) as score
            from campaigns
          ), matched as (
            select * from scored
            where score >= 0.55
               or agency_ops.normalize_match_text(campaign_name) like '%'||v_product_norm||'%'
               or v_product_norm like '%'||agency_ops.normalize_match_text(campaign_name)||'%'
          )
          select array_agg(distinct client_id),
                 coalesce(jsonb_agg(jsonb_build_object('client_id',client_id,'campaign_id',campaign_id,'campaign_name',campaign_name,'score',score) order by score desc), '[]'::jsonb)
          into v_expected_ids, v_expected_candidates
          from matched;

          if coalesce(cardinality(v_expected_ids),0)=1 then
            v_expected_client := v_expected_ids[1];
            v_expected_method := 'CAMPAIGN_PRODUCT_UNIQUE_CLIENT';
          end if;
        end if;

        if v_recipient_client is not null and v_expected_client is not null and v_recipient_client <> v_expected_client then
          v_routing := 'ROUTING_CONFLICT';
        elsif v_recipient_client is not null and v_expected_client = v_recipient_client then
          v_routing := 'ROUTING_OK';
        elsif v_recipient_client is not null and v_expected_client is null and v_group_evidence > 0 then
          v_routing := 'ROUTING_OK';
        elsif v_recipient_client is not null then
          v_routing := 'ROUTING_PROBABLE';
        else
          v_routing := 'ROUTING_UNKNOWN';
        end if;

        insert into agency_ops.meta_lead_dispatches(
          raw_id,message_id,event_at,connected_phone,recipient_phone,product_label,lead_name,lead_phone,lead_email,
          recipient_client_id,expected_client_id,routing_status,recipient_match_method,expected_match_method,
          group_product_evidence_count,recipient_candidates,expected_candidates,raw_text,raw_json,updated_at
        ) values (
          r.id,r.message_id,r.event_at,r.connected_phone,v_recipient_phone,v_product,v_lead_name,v_lead_phone,v_lead_email,
          v_recipient_client,v_expected_client,v_routing,v_recipient_method,v_expected_method,
          v_group_evidence,v_recipient_candidates,v_expected_candidates,v_text,r.raw_json,now()
        )
        on conflict (message_id) do update set
          recipient_phone=excluded.recipient_phone,
          product_label=excluded.product_label,
          lead_name=excluded.lead_name,
          lead_phone=excluded.lead_phone,
          lead_email=excluded.lead_email,
          recipient_client_id=excluded.recipient_client_id,
          expected_client_id=excluded.expected_client_id,
          routing_status=excluded.routing_status,
          recipient_match_method=excluded.recipient_match_method,
          expected_match_method=excluded.expected_match_method,
          group_product_evidence_count=excluded.group_product_evidence_count,
          recipient_candidates=excluded.recipient_candidates,
          expected_candidates=excluded.expected_candidates,
          raw_text=excluded.raw_text,
          raw_json=excluded.raw_json,
          updated_at=now();

        update agency_ops.whatsapp_zapi_raw
        set message_class='META_LEAD_DISPATCH', processing_status='DONE', processed_at=now(), processing_error=null
        where id=r.id;

        update agency_ops.zapi_message_processing_queue
        set status='DONE', classification='META_LEAD_DISPATCH', canonical_inserted=false,
            processed_at=now(), updated_at=now(), last_error=null
        where raw_id=r.id;

        v_leads := v_leads + 1;
      else
        select inserted into v_inserted
        from agency_ops.ingest_whatsapp_message(r.raw_json,'zapi_direct_official')
        limit 1;

        select id into v_canonical_id
        from agency_ops.whatsapp_messages
        where message_id=r.message_id
        limit 1;

        update agency_ops.whatsapp_zapi_raw
        set message_class='OPERATIONAL_MESSAGE', processing_status='DONE', processed_at=now(), processing_error=null,
            canonical_message_row_id=v_canonical_id
        where id=r.id;

        update agency_ops.zapi_message_processing_queue
        set status='DONE', classification='OPERATIONAL_MESSAGE', canonical_inserted=coalesce(v_inserted,false),
            processed_at=now(), updated_at=now(), last_error=null
        where raw_id=r.id;

        v_operational := v_operational + 1;
      end if;

      v_done := v_done + 1;
    exception when others then
      v_errors := v_errors + 1;
      update agency_ops.whatsapp_zapi_raw
      set processing_status='ERROR', processing_error=sqlerrm
      where id=q.raw_id;
      update agency_ops.zapi_message_processing_queue
      set status='ERROR', last_error=sqlerrm,
          next_attempt_at=now() + make_interval(secs => least(300, greatest(5, attempts*5))),
          updated_at=now()
      where raw_id=q.raw_id;
    end;
  end loop;

  return jsonb_build_object('ok',true,'processed',v_done,'operational',v_operational,'lead_dispatches',v_leads,'errors',v_errors);
end;
$$;

create or replace function public.ingest_zapi_direct_official_atomic(p_payload jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  v_expected text;
  v_message_id text;
  v_moment text;
  v_event_at timestamptz;
  v_id bigint;
  v_duplicate_hits integer;
begin
  select value #>> '{}' into v_expected
  from agency_ops.automation_settings
  where key = 'WA_DIRECT_TEST_TOKEN';

  if v_expected is null or p_token is null or p_token <> v_expected then
    raise exception 'unauthorized' using errcode='28000';
  end if;

  v_message_id := nullif(btrim(coalesce(p_payload->>'messageId',p_payload->>'messageid','')), '');
  if v_message_id is null then
    raise exception 'missing_messageId' using errcode='22023';
  end if;

  v_moment := coalesce(p_payload->>'momment',p_payload->>'moment');
  if v_moment ~ '^[0-9]+([.][0-9]+)?$' then
    if v_moment::numeric > 10000000000 then
      v_event_at := to_timestamp((v_moment::numeric/1000.0)::double precision);
    else
      v_event_at := to_timestamp(v_moment::double precision);
    end if;
  end if;

  insert into agency_ops.whatsapp_zapi_raw(
    capture_key,message_id,instance_id,connected_phone,chat_id,chat_name,
    participant_phone,participant_lid,sender_phone,sender_lid,sender_name,
    from_me,is_group,is_newsletter,event_type,message_type,text_body,caption,
    moment_raw,event_at,status,raw_json,received_at,last_seen_at,processing_status
  ) values (
    v_message_id,v_message_id,
    nullif(p_payload->>'instanceId',''),nullif(p_payload->>'connectedPhone',''),
    nullif(coalesce(p_payload->>'phone',p_payload->>'chatId'),''),nullif(p_payload->>'chatName',''),
    nullif(p_payload->>'participantPhone',''),nullif(p_payload->>'participantLid',''),
    nullif(coalesce(p_payload->>'participantPhone',p_payload->>'phone'),''),nullif(p_payload->>'senderLid',''),
    nullif(coalesce(p_payload->>'senderName',p_payload->>'pushName',p_payload->>'chatName'),''),
    lower(coalesce(p_payload->>'fromMe','false'))='true',
    lower(coalesce(p_payload->>'isGroup','false'))='true',
    lower(coalesce(p_payload->>'isNewsletter','false'))='true',
    coalesce(nullif(p_payload->>'type',''),'ReceivedCallback'),
    case when p_payload?'text' then 'text' when p_payload?'image' then 'image' when p_payload?'audio' then 'audio'
         when p_payload?'video' then 'video' when p_payload?'document' then 'document' when p_payload?'sticker' then 'sticker'
         when p_payload?'contact' then 'contact' when p_payload?'location' then 'location' else 'other' end,
    nullif(p_payload#>>'{text,message}',''),
    nullif(coalesce(p_payload#>>'{image,caption}',p_payload#>>'{video,caption}',p_payload#>>'{document,caption}'),''),
    v_moment,v_event_at,nullif(p_payload->>'status',''),p_payload,now(),now(),'PENDING'
  )
  on conflict (capture_key) do update set
    duplicate_hits=agency_ops.whatsapp_zapi_raw.duplicate_hits+1,
    last_seen_at=now(),
    instance_id=coalesce(agency_ops.whatsapp_zapi_raw.instance_id,excluded.instance_id),
    connected_phone=coalesce(agency_ops.whatsapp_zapi_raw.connected_phone,excluded.connected_phone),
    chat_id=coalesce(agency_ops.whatsapp_zapi_raw.chat_id,excluded.chat_id),
    chat_name=coalesce(agency_ops.whatsapp_zapi_raw.chat_name,excluded.chat_name),
    participant_phone=coalesce(agency_ops.whatsapp_zapi_raw.participant_phone,excluded.participant_phone),
    participant_lid=coalesce(agency_ops.whatsapp_zapi_raw.participant_lid,excluded.participant_lid),
    sender_phone=coalesce(agency_ops.whatsapp_zapi_raw.sender_phone,excluded.sender_phone),
    sender_lid=coalesce(agency_ops.whatsapp_zapi_raw.sender_lid,excluded.sender_lid),
    sender_name=coalesce(agency_ops.whatsapp_zapi_raw.sender_name,excluded.sender_name),
    text_body=coalesce(agency_ops.whatsapp_zapi_raw.text_body,excluded.text_body),
    caption=coalesce(agency_ops.whatsapp_zapi_raw.caption,excluded.caption),
    event_at=coalesce(agency_ops.whatsapp_zapi_raw.event_at,excluded.event_at),
    raw_json=excluded.raw_json
  returning id,duplicate_hits into v_id,v_duplicate_hits;

  insert into agency_ops.zapi_message_processing_queue(raw_id,message_id,status,next_attempt_at,updated_at)
  values(v_id,v_message_id,'PENDING',now(),now())
  on conflict(raw_id) do update set
    message_id=excluded.message_id,
    next_attempt_at=case when agency_ops.zapi_message_processing_queue.status='ERROR' then now() else agency_ops.zapi_message_processing_queue.next_attempt_at end,
    updated_at=now();

  return jsonb_build_object('ok',true,'accepted',true,'id',v_id,'duplicateHits',v_duplicate_hits,'queued',true);
end;
$$;

create or replace function public.ingest_zapi_direct_test_atomic(p_payload jsonb, p_token text)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
  select public.ingest_zapi_direct_official_atomic(p_payload,p_token);
$$;

create or replace function public.process_zapi_direct_pending(p_limit integer default 100)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
  select agency_ops.process_zapi_raw_pending(p_limit);
$$;

revoke all on function public.ingest_zapi_direct_official_atomic(jsonb,text) from public;
revoke all on function public.ingest_zapi_direct_test_atomic(jsonb,text) from public;
revoke all on function public.process_zapi_direct_pending(integer) from public;
grant execute on function public.ingest_zapi_direct_official_atomic(jsonb,text) to anon, service_role;
grant execute on function public.ingest_zapi_direct_test_atomic(jsonb,text) to anon, service_role;
grant execute on function public.process_zapi_direct_pending(integer) to service_role;

revoke all on agency_ops.whatsapp_zapi_raw from public, anon, authenticated;
revoke all on agency_ops.zapi_message_processing_queue from public, anon, authenticated;
revoke all on agency_ops.meta_lead_dispatches from public, anon, authenticated;
revoke all on agency_ops.client_phone_registry from public, anon, authenticated;
grant select,insert,update on agency_ops.whatsapp_zapi_raw to service_role;
grant select,insert,update,delete on agency_ops.zapi_message_processing_queue to service_role;
grant select,insert,update on agency_ops.meta_lead_dispatches to service_role;
grant select,insert,update on agency_ops.client_phone_registry to service_role;

insert into agency_ops.zapi_message_processing_queue(raw_id,message_id,status,next_attempt_at,updated_at)
select r.id,r.message_id,'PENDING',now(),now()
from agency_ops.whatsapp_zapi_raw r
where not exists (select 1 from agency_ops.zapi_message_processing_queue q where q.raw_id=r.id)
on conflict do nothing;

insert into agency_ops.automation_settings(key,value)
values ('zapi_direct_test_config', jsonb_build_object('enabled',true,'mode','OFFICIAL_PRIMARY','promote_to_canonical',true,'lead_dispatch_routing',true,'updated_at',now()))
on conflict (key) do update set value=excluded.value;

select cron.schedule('zapi-direct-official-drain','* * * * *','select agency_ops.process_zapi_raw_pending(250);');
select cron.schedule('zapi-client-phone-registry-refresh','*/2 * * * *','select agency_ops.refresh_client_phone_registry_from_whatsapp(interval ''2 days'');');
