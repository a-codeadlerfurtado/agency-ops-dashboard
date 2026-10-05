create or replace view agency_ops.promentor_whatsapp_lead_events
with (security_invoker = true) as
with base as (
  select
    m.id as whatsapp_message_id,
    m.message_id as whatsapp_provider_message_id,
    m.event_at,
    m.received_at,
    r.client_id,
    c.id as connection_id,
    replace(coalesce(m.text_body,m.caption,''), E'\r', '') as msg
  from agency_ops.whatsapp_messages m
  join agency_ops.whatsapp_chat_registry r on r.chat_id = m.chat_id
  join agency_ops.external_crm_connections c
    on c.client_id = r.client_id
   and c.provider = 'PROMENTOR'
  where m.is_group = true
    and coalesce(m.text_body,m.caption,'') ~* 'novo Lead para atendimento'
    and coalesce(m.text_body,m.caption,'') ~* 'funil/detalhes/[0-9]+'
),
parsed as (
  select
    b.*,
    nullif(btrim(split_part(split_part(b.msg,'Nome do Cliente:',2), E'\n',1)),'') as lead_name,
    nullif(btrim(split_part(split_part(b.msg,'E-mail do Cliente:',2), E'\n',1)),'') as lead_email,
    nullif(btrim(split_part(split_part(b.msg,'Telefone do Cliente:',2), E'\n',1)),'') as lead_phone,
    nullif(btrim(split_part(split_part(split_part(b.msg,'Dados da Campanha',2),'Id:',2), E'\n',1)),'') as meta_lead_id,
    nullif(btrim(split_part(split_part(b.msg,'Nome da Campanha:',2), E'\n',1)),'') as campaign_name,
    nullif(btrim(split_part(split_part(b.msg,'Nome do anúncio:',2), E'\n',1)),'') as ad_name,
    nullif(btrim(split_part(split_part(b.msg,'Formulário:',2), E'\n',1)),'') as form_id,
    nullif(btrim(split_part(split_part(b.msg,'Plataforma de Origem:',2), E'\n',1)),'') as platform,
    (regexp_match(b.msg,'funil/detalhes/([0-9]+)'))[1] as crm_card_id,
    (regexp_match(b.msg,'funil-detalhes/([0-9]+)'))[1] as mobile_card_id,
    nullif(btrim(split_part(split_part(b.msg,'Criado em:',2), E'\n',1)),'') as created_raw
  from base b
)
select
  'promentor-wa-' || whatsapp_message_id::text as synthetic_event_id,
  whatsapp_message_id,
  whatsapp_provider_message_id,
  connection_id,
  client_id,
  'PROMENTOR'::text as provider,
  coalesce(crm_card_id,mobile_card_id,meta_lead_id,whatsapp_message_id::text) as external_lead_id,
  'LEAD_CREATED'::text as event_type,
  'Novo lead para atendimento'::text as external_status,
  'NEW'::text as canonical_stage,
  lead_name,
  lead_email,
  lead_phone,
  null::text as product,
  null::text as broker_name,
  null::text as broker_email,
  null::text as broker_phone,
  coalesce(
    case when created_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      then created_raw::timestamptz else null::timestamptz end,
    event_at
  ) as occurred_at,
  coalesce(received_at,event_at) as received_at,
  'WHATSAPP_CRM_ALERT'::text as source,
  0.92::numeric as source_confidence,
  jsonb_build_object(
    'whatsapp_message_id',whatsapp_message_id,
    'meta_lead_id',meta_lead_id,
    'crm_card_id',crm_card_id,
    'mobile_card_id',mobile_card_id,
    'campaign_name',campaign_name,
    'ad_name',ad_name,
    'form_id',form_id,
    'platform',platform
  ) as payload
from parsed
where coalesce(crm_card_id,mobile_card_id,meta_lead_id) is not null;

revoke all on agency_ops.promentor_whatsapp_lead_events from public, anon, authenticated;
grant select on agency_ops.promentor_whatsapp_lead_events to service_role;

create or replace view agency_ops.promentor_legacy_roster_events
with (security_invoker = true) as
with conn as (
  select x.id as connection_id, x.client_id
  from agency_ops.external_crm_connections x
  join agency_ops.clients c on c.id = x.client_id
  where x.provider = 'PROMENTOR'
    and c.display_name = 'View Imóveis'
  order by x.updated_at desc
  limit 1
),
normalized as (
  select
    r.id,
    r.cliente as lead_name,
    r.telefone as lead_phone,
    r.email as lead_email,
    r.corretor as broker_name,
    r.status as source_status,
    r.data_inclusao,
    r.data_envio,
    regexp_replace(coalesce(r.telefone,''),'[^0-9]','','g') as phone_digits,
    lower(btrim(coalesce(r.email,''))) as email_norm
  from public.view_imoveis_base_leads_crm r
),
ranked as (
  select n.*,
    case
      when length(n.phone_digits) >= 8 then 'phone:' || n.phone_digits
      when n.email_norm <> '' then 'email:' || n.email_norm
      else 'row:' || n.id::text
    end as lead_identity,
    row_number() over (
      partition by case
        when length(n.phone_digits) >= 8 then 'phone:' || n.phone_digits
        when n.email_norm <> '' then 'email:' || n.email_norm
        else 'row:' || n.id::text
      end
      order by n.data_envio desc nulls last, n.id desc
    ) as identity_rank
  from normalized n
),
deduped as (
  select r.*
  from ranked r
  where r.identity_rank = 1
)
select
  'promentor-roster-' || d.id::text as synthetic_event_id,
  c.connection_id,
  c.client_id,
  'PROMENTOR'::text as provider,
  d.lead_identity as external_lead_id,
  'LEAD_IMPORTED'::text as event_type,
  d.source_status as external_status,
  'NEW'::text as canonical_stage,
  d.lead_name,
  nullif(d.email_norm,'') as lead_email,
  d.lead_phone,
  null::text as product,
  d.broker_name,
  null::text as broker_email,
  null::text as broker_phone,
  coalesce(
    case when d.data_inclusao ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
      then to_date(d.data_inclusao,'DD/MM/YYYY')::timestamp at time zone 'America/Sao_Paulo'
      else null::timestamptz end,
    d.data_envio
  ) as occurred_at,
  coalesce(
    d.data_envio,
    to_date(d.data_inclusao,'DD/MM/YYYY')::timestamp at time zone 'America/Sao_Paulo'
  ) as received_at,
  'PROMENTOR_LEGACY_ROSTER'::text as source,
  0.90::numeric as source_confidence,
  jsonb_build_object(
    'source_row_id',d.id,
    'source_status',d.source_status,
    'data_inclusao',d.data_inclusao
  ) as payload
from deduped d
cross join conn c
where not exists (
  select 1
  from agency_ops.promentor_whatsapp_lead_events a
  where a.client_id = c.client_id
    and (
      (
        length(d.phone_digits) >= 8
        and length(regexp_replace(coalesce(a.lead_phone,''),'[^0-9]','','g')) >= 8
        and right(regexp_replace(coalesce(a.lead_phone,''),'[^0-9]','','g'),8) = right(d.phone_digits,8)
      )
      or (
        d.email_norm <> ''
        and lower(btrim(coalesce(a.lead_email,''))) = d.email_norm
      )
    )
);

revoke all on agency_ops.promentor_legacy_roster_events from public, anon, authenticated;
grant select on agency_ops.promentor_legacy_roster_events to service_role;

create or replace view agency_ops.external_crm_event_feed
with (security_invoker = true) as
select
  e.id::text as event_id,
  e.connection_id,
  e.client_id,
  e.provider,
  e.external_lead_id,
  e.event_type,
  e.external_status,
  e.canonical_stage,
  e.lead_name,
  e.lead_email,
  e.lead_phone,
  e.product,
  e.broker_name,
  e.broker_email,
  e.broker_phone,
  e.occurred_at,
  e.received_at,
  e.source,
  1.0::numeric as source_confidence,
  e.payload
from agency_ops.external_crm_events e
union all
select
  p.synthetic_event_id,
  p.connection_id,
  p.client_id,
  p.provider,
  p.external_lead_id,
  p.event_type,
  p.external_status,
  p.canonical_stage,
  p.lead_name,
  p.lead_email,
  p.lead_phone,
  p.product,
  p.broker_name,
  p.broker_email,
  p.broker_phone,
  p.occurred_at,
  p.received_at,
  p.source,
  p.source_confidence,
  p.payload
from agency_ops.promentor_whatsapp_lead_events p
union all
select
  p.synthetic_event_id,
  p.connection_id,
  p.client_id,
  p.provider,
  p.external_lead_id,
  p.event_type,
  p.external_status,
  p.canonical_stage,
  p.lead_name,
  p.lead_email,
  p.lead_phone,
  p.product,
  p.broker_name,
  p.broker_email,
  p.broker_phone,
  p.occurred_at,
  p.received_at,
  p.source,
  p.source_confidence,
  p.payload
from agency_ops.promentor_legacy_roster_events p;

revoke all on agency_ops.external_crm_event_feed from public, anon, authenticated;
grant select on agency_ops.external_crm_event_feed to service_role;

create or replace view agency_ops.external_crm_latest_lead_state_all
with (security_invoker = true) as
select distinct on (client_id,provider,external_lead_id)
  event_id,
  connection_id,
  client_id,
  provider,
  external_lead_id,
  event_type,
  external_status,
  canonical_stage,
  lead_name,
  lead_email,
  lead_phone,
  product,
  broker_name,
  broker_email,
  broker_phone,
  occurred_at,
  received_at,
  source,
  source_confidence,
  payload
from agency_ops.external_crm_event_feed
where external_lead_id is not null
order by
  client_id,
  provider,
  external_lead_id,
  coalesce(occurred_at,received_at) desc,
  received_at desc,
  event_id desc;

revoke all on agency_ops.external_crm_latest_lead_state_all from public, anon, authenticated;
grant select on agency_ops.external_crm_latest_lead_state_all to service_role;

create or replace view agency_ops.external_crm_funnel_daily
with (security_invoker = true) as
select
  client_id,
  (coalesce(occurred_at,received_at) at time zone 'America/Sao_Paulo')::date as report_date,
  count(distinct external_lead_id) filter (where canonical_stage='NEW') as new_leads,
  count(distinct external_lead_id) filter (where canonical_stage='CONTACTED') as contacted,
  count(distinct external_lead_id) filter (where canonical_stage='QUALIFIED') as qualified,
  count(distinct external_lead_id) filter (where canonical_stage='VISIT_SCHEDULED') as visits_scheduled,
  count(distinct external_lead_id) filter (where canonical_stage='VISIT_COMPLETED') as visits_completed,
  count(distinct external_lead_id) filter (where canonical_stage='PROPOSAL') as proposals,
  count(distinct external_lead_id) filter (where canonical_stage='WON') as won,
  count(distinct external_lead_id) filter (where canonical_stage='LOST') as lost,
  count(distinct external_lead_id) as leads_with_events,
  max(received_at) as last_event_received_at
from agency_ops.external_crm_event_feed
where external_lead_id is not null
group by client_id,(coalesce(occurred_at,received_at) at time zone 'America/Sao_Paulo')::date;

revoke all on agency_ops.external_crm_funnel_daily from public, anon, authenticated;
grant select on agency_ops.external_crm_funnel_daily to service_role;

create or replace view agency_ops.crm_whatsapp_reconciliation_candidates
with (security_invoker = true) as
with crm as (
  select
    case when l.event_id ~ '^[0-9]+$' then l.event_id::bigint else null::bigint end as crm_event_id,
    l.event_id as crm_event_key,
    l.connection_id,
    l.client_id,
    l.provider,
    l.external_lead_id,
    l.external_status,
    l.canonical_stage as crm_stage,
    l.lead_name,
    l.lead_phone,
    l.broker_name,
    coalesce(l.occurred_at,l.received_at) as crm_event_at,
    lower(regexp_replace(coalesce(l.lead_name,''),'[[:space:]]+',' ','g')) as lead_name_norm,
    regexp_replace(coalesce(l.lead_phone,''),'[^0-9]','','g') as lead_phone_digits,
    lower(regexp_replace(coalesce(l.broker_name,''),'[[:space:]]+',' ','g')) as broker_name_norm
  from agency_ops.external_crm_latest_lead_state_all l
),
wa as (
  select
    w.whatsapp_message_id,
    w.client_id,
    w.chat_id,
    w.chat_name,
    w.event_at as whatsapp_event_at,
    w.sender_name,
    w.sender_side,
    w.role_hint,
    w.identity_confidence,
    w.message_text,
    w.candidate_stage as whatsapp_stage,
    w.signal_confidence,
    lower(regexp_replace(coalesce(w.message_text,''),'[[:space:]]+',' ','g')) as message_norm,
    regexp_replace(coalesce(w.message_text,''),'[^0-9]','','g') as message_digits,
    lower(regexp_replace(coalesce(w.sender_name,''),'[[:space:]]+',' ','g')) as sender_name_norm
  from agency_ops.commercial_whatsapp_signal_candidates w
)
select
  crm.crm_event_id,
  crm.connection_id,
  crm.client_id,
  crm.provider,
  crm.external_lead_id,
  crm.lead_name,
  crm.lead_phone,
  crm.broker_name,
  crm.crm_stage,
  crm.external_status,
  crm.crm_event_at,
  wa.whatsapp_message_id,
  wa.chat_id,
  wa.chat_name,
  wa.whatsapp_event_at,
  wa.sender_name,
  wa.sender_side,
  wa.role_hint,
  wa.identity_confidence,
  wa.whatsapp_stage,
  wa.signal_confidence,
  wa.message_text,
  case
    when length(crm.lead_phone_digits) >= 8
      and wa.message_digits like '%' || right(crm.lead_phone_digits,8) || '%'
      then 'PHONE_SUFFIX_8'
    when length(crm.lead_name_norm) >= 4
      and wa.message_norm like '%' || crm.lead_name_norm || '%'
      then 'FULL_LEAD_NAME'
    when length(split_part(crm.lead_name_norm,' ',1)) >= 4
      and wa.message_norm like '%' || split_part(crm.lead_name_norm,' ',1) || '%'
      and length(split_part(crm.broker_name_norm,' ',1)) >= 3
      and wa.sender_name_norm like '%' || split_part(crm.broker_name_norm,' ',1) || '%'
      then 'LEAD_FIRST_NAME_PLUS_BROKER'
    else 'UNMATCHED'
  end as match_reason,
  case
    when length(crm.lead_phone_digits) >= 8
      and wa.message_digits like '%' || right(crm.lead_phone_digits,8) || '%'
      then 0.96
    when length(crm.lead_name_norm) >= 4
      and wa.message_norm like '%' || crm.lead_name_norm || '%'
      then case
        when length(split_part(crm.broker_name_norm,' ',1)) >= 3
          and wa.sender_name_norm like '%' || split_part(crm.broker_name_norm,' ',1) || '%'
        then 0.93 else 0.87 end
    when length(split_part(crm.lead_name_norm,' ',1)) >= 4
      and wa.message_norm like '%' || split_part(crm.lead_name_norm,' ',1) || '%'
      and length(split_part(crm.broker_name_norm,' ',1)) >= 3
      and wa.sender_name_norm like '%' || split_part(crm.broker_name_norm,' ',1) || '%'
      then 0.82
    else 0.0
  end::numeric as match_confidence,
  (crm.crm_stage = wa.whatsapp_stage) as stage_agrees,
  crm.crm_event_key
from crm
join wa
  on wa.client_id = crm.client_id
 and wa.whatsapp_event_at between crm.crm_event_at - interval '14 days'
                              and crm.crm_event_at + interval '14 days'
where
  (
    length(crm.lead_phone_digits) >= 8
    and wa.message_digits like '%' || right(crm.lead_phone_digits,8) || '%'
  )
  or (
    length(crm.lead_name_norm) >= 4
    and wa.message_norm like '%' || crm.lead_name_norm || '%'
  )
  or (
    length(split_part(crm.lead_name_norm,' ',1)) >= 4
    and wa.message_norm like '%' || split_part(crm.lead_name_norm,' ',1) || '%'
    and length(split_part(crm.broker_name_norm,' ',1)) >= 3
    and wa.sender_name_norm like '%' || split_part(crm.broker_name_norm,' ',1) || '%'
  );

revoke all on agency_ops.crm_whatsapp_reconciliation_candidates from public, anon, authenticated;
grant select on agency_ops.crm_whatsapp_reconciliation_candidates to service_role;

create or replace view agency_ops.crm_whatsapp_stage_audit
with (security_invoker = true) as
with ranked as (
  select
    c.*,
    case c.crm_stage
      when 'NEW' then 10
      when 'CONTACTED' then 20
      when 'QUALIFIED' then 30
      when 'VISIT_SCHEDULED' then 40
      when 'VISIT_COMPLETED' then 50
      when 'PROPOSAL' then 60
      when 'WON' then 70
      when 'LOST' then 70
      else 0
    end as crm_stage_rank,
    case c.whatsapp_stage
      when 'NEW' then 10
      when 'CONTACTED' then 20
      when 'QUALIFIED' then 30
      when 'VISIT_SCHEDULED' then 40
      when 'VISIT_COMPLETED' then 50
      when 'PROPOSAL' then 60
      when 'WON' then 70
      when 'LOST' then 70
      else 0
    end as whatsapp_stage_rank
  from agency_ops.crm_whatsapp_reconciliation_candidates c
  where c.match_confidence >= 0.82
)
select
  r.*,
  case
    when r.stage_agrees then 'VERIFIED'
    when r.whatsapp_stage_rank > r.crm_stage_rank then 'CRM_BEHIND_REPORTED'
    when r.whatsapp_stage_rank < r.crm_stage_rank then 'WHATSAPP_BEHIND_OR_OLDER'
    else 'REVIEW'
  end as audit_status
from ranked r;

revoke all on agency_ops.crm_whatsapp_stage_audit from public, anon, authenticated;
grant select on agency_ops.crm_whatsapp_stage_audit to service_role;

comment on view agency_ops.promentor_whatsapp_lead_events is
  'ProMentor lead-created events inferred from structured CRM alert messages in authorized WhatsApp groups.';
comment on view agency_ops.promentor_legacy_roster_events is
  'View Imoveis legacy CRM roster bridged as NEW lead events with broker ownership. Operational dispatch status is preserved but never promoted to a commercial funnel stage.';
comment on view agency_ops.external_crm_event_feed is
  'Unified external CRM event feed combining native CRM events and explicitly lower-confidence synthetic provider sources.';
comment on view agency_ops.external_crm_latest_lead_state_all is
  'Latest per-lead state across native and synthetic CRM event sources, preserving source and confidence.';
comment on view agency_ops.crm_whatsapp_reconciliation_candidates is
  'High-confidence CRM x commercial WhatsApp reconciliation candidates across native and synthetic CRM sources. WhatsApp remains corroborative.';
comment on view agency_ops.crm_whatsapp_stage_audit is
  'Audit-only comparison of matched CRM and WhatsApp funnel stages. CRM_BEHIND_REPORTED is a review flag, never an automatic CRM write.';

create or replace view agency_ops.crm_whatsapp_daily_gap_audit
with (security_invoker = true) as
select
  r.*,
  case
    when r.crm_leads_with_events is null
      and (
        coalesce(r.whatsapp_visits_scheduled,0) > 0
        or coalesce(r.whatsapp_visits_completed,0) > 0
        or coalesce(r.whatsapp_proposals,0) > 0
        or coalesce(r.whatsapp_sales,0) > 0
      )
      then 'CRM_SOURCE_MISSING'
    when r.whatsapp_brokers_reporting is null
      and coalesce(r.crm_leads_with_events,0) > 0
      then 'WHATSAPP_REPORT_MISSING'
    when coalesce(r.whatsapp_sales,0) > coalesce(r.crm_won,0)
      or coalesce(r.whatsapp_proposals,0) > coalesce(r.crm_proposals,0)
      or coalesce(r.whatsapp_visits_completed,0) > coalesce(r.crm_visits_completed,0)
      or coalesce(r.whatsapp_visits_scheduled,0) > coalesce(r.crm_visits_scheduled,0)
      then 'CRM_BEHIND_REPORTED'
    else 'NO_FORWARD_GAP_DETECTED'
  end as audit_status,
  greatest(coalesce(r.whatsapp_sales,0) - coalesce(r.crm_won,0),0) as sales_gap,
  greatest(coalesce(r.whatsapp_proposals,0) - coalesce(r.crm_proposals,0),0) as proposals_gap,
  greatest(coalesce(r.whatsapp_visits_completed,0) - coalesce(r.crm_visits_completed,0),0) as visits_completed_gap,
  greatest(coalesce(r.whatsapp_visits_scheduled,0) - coalesce(r.crm_visits_scheduled,0),0) as visits_scheduled_gap
from agency_ops.crm_whatsapp_daily_reconciliation r;

revoke all on agency_ops.crm_whatsapp_daily_gap_audit from public, anon, authenticated;
grant select on agency_ops.crm_whatsapp_daily_gap_audit to service_role;

comment on view agency_ops.crm_whatsapp_daily_gap_audit is
  'Aggregate audit of broker-reported WhatsApp funnel metrics versus CRM events. Flags missing CRM source or CRM behind reported activity without promoting WhatsApp reports to authoritative CRM state.';
