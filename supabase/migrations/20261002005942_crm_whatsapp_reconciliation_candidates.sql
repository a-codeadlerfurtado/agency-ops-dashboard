create or replace view agency_ops.crm_whatsapp_reconciliation_candidates
with (security_invoker = true) as
with crm as (
  select
    l.id as crm_event_id,
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
  from agency_ops.external_crm_latest_lead_state l
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
  (crm.crm_stage = wa.whatsapp_stage) as stage_agrees
from crm
join wa on wa.client_id = crm.client_id
  and wa.whatsapp_event_at between crm.crm_event_at - interval '14 days' and crm.crm_event_at + interval '14 days'
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

comment on view agency_ops.crm_whatsapp_reconciliation_candidates is
  'High-confidence CRM x [COMERCIAL] WhatsApp reconciliation candidates. Matches require lead phone/name evidence; WhatsApp remains corroborative, never authoritative.';
