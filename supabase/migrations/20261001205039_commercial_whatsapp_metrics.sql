create or replace view agency_ops.commercial_whatsapp_metric_reports as
with base as (
  select
    m.id as whatsapp_message_id,
    r.client_id,
    r.chat_id,
    r.chat_name,
    m.event_at,
    coalesce(nullif(i.canonical_name,''), nullif(m.sender_name,''), nullif(m.sender_phone,''), 'Desconhecido') as sender_name,
    i.side as sender_side,
    i.role_hint,
    i.confidence as identity_confidence,
    coalesce(m.text_body,m.caption,'') as message_text
  from agency_ops.whatsapp_messages m
  join agency_ops.whatsapp_chat_registry r on r.chat_id=m.chat_id
  left join lateral (
    select p.canonical_name,p.side,p.role_hint,p.confidence
    from agency_ops.whatsapp_participant_identity p
    where p.chat_id=m.chat_id
      and (
        (p.phone is not null and p.phone in (m.participant_phone,m.sender_phone))
        or (p.sender_lid is not null and p.sender_lid in (m.participant_lid,m.sender_lid))
      )
    order by p.confidence desc nulls last,p.last_seen_at desc nulls last
    limit 1
  ) i on true
  where r.chat_name ~* '^\\[COMERCIAL\\]'
),
parsed as (
  select *,
    nullif((regexp_match(message_text,'(?i)leads[[:space:]]+receberam[^0-9]{0,12}([0-9]+)'))[1],'')::int as leads_received,
    nullif((regexp_match(message_text,'(?i)liga[cç][oõ]es[[:space:]]+efetuadas[^0-9]{0,12}([0-9]+)'))[1],'')::int as calls_made,
    nullif((regexp_match(message_text,'(?i)liga[cç][oõ]es[[:space:]]+atendidas[^0-9]{0,12}([0-9]+)'))[1],'')::int as calls_answered,
    nullif((regexp_match(message_text,'(?i)em[[:space:]]+conversa[^0-9]{0,12}([0-9]+)'))[1],'')::int as conversations,
    nullif((regexp_match(message_text,'(?i)visitas?[[:space:]]+agendadas?[^0-9]{0,12}([0-9]+)'))[1],'')::int as visits_scheduled,
    nullif((regexp_match(message_text,'(?i)visitas?[[:space:]]+realizadas?[^0-9]{0,12}([0-9]+)'))[1],'')::int as visits_completed,
    nullif((regexp_match(message_text,'(?i)propostas?[[:space:]]+(?:emitidas?)?[^0-9]{0,12}([0-9]+)'))[1],'')::int as proposals,
    nullif((regexp_match(message_text,'(?i)vendas?[^0-9]{0,12}([0-9]+)'))[1],'')::int as sales
  from base
)
select
  *,
  ((leads_received is not null)::int+
   (calls_made is not null)::int+
   (calls_answered is not null)::int+
   (conversations is not null)::int+
   (visits_scheduled is not null)::int+
   (visits_completed is not null)::int+
   (proposals is not null)::int+
   (sales is not null)::int) as metric_fields_present,
  case
    when message_text ~* '\montem\M'
      then ((event_at at time zone 'America/Sao_Paulo')::date - 1)
    else null
  end as inferred_report_date,
  case
    when message_text ~* '\montem\M' then 'YESTERDAY'
    when message_text ~* '(sexta|sábado|sabado).*(domingo|segunda)' then 'MULTIDAY_TEXT'
    when message_text ~* '(referente|ref)[^0-9]{0,12}[0-9]{1,2}/[0-9]{1,2}' then 'EXPLICIT_TEXT'
    else 'UNSPECIFIED'
  end as period_reference_kind,
  case
    when sender_side in ('CLIENT_SIDE','CLIENT') and coalesce(identity_confidence,0)>=0.8 then 0.98
    when sender_side in ('CLIENT_SIDE','CLIENT') then 0.85
    else 0.65
  end::numeric as report_confidence
from parsed
where sender_side in ('CLIENT_SIDE','CLIENT')
  and (
    (leads_received is not null)::int+
    (calls_made is not null)::int+
    (calls_answered is not null)::int+
    (conversations is not null)::int+
    (visits_scheduled is not null)::int+
    (visits_completed is not null)::int+
    (proposals is not null)::int+
    (sales is not null)::int
  ) >= 2;

create or replace view agency_ops.commercial_whatsapp_metric_latest_by_broker as
select distinct on (
  client_id,
  sender_name,
  coalesce(inferred_report_date,(event_at at time zone 'America/Sao_Paulo')::date)
)
  *
from agency_ops.commercial_whatsapp_metric_reports
order by
  client_id,
  sender_name,
  coalesce(inferred_report_date,(event_at at time zone 'America/Sao_Paulo')::date),
  event_at desc,
  whatsapp_message_id desc;

grant select on agency_ops.commercial_whatsapp_metric_reports to service_role;
grant select on agency_ops.commercial_whatsapp_metric_latest_by_broker to service_role;

comment on view agency_ops.commercial_whatsapp_metric_reports is
  'Structured commercial metrics explicitly reported by identified client-side participants in [COMERCIAL] WhatsApp groups.';
comment on view agency_ops.commercial_whatsapp_metric_latest_by_broker is
  'Latest self-reported commercial metric message per client/broker/report-date; avoids counting repeat/correction messages twice.';
