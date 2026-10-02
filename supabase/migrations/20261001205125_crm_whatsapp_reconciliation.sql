create or replace view agency_ops.commercial_whatsapp_metric_daily as
select
  client_id,
  inferred_report_date as report_date,
  count(*) as brokers_reporting,
  sum(coalesce(leads_received,0)) as leads_received,
  sum(coalesce(calls_made,0)) as calls_made,
  sum(coalesce(calls_answered,0)) as calls_answered,
  sum(coalesce(conversations,0)) as conversations,
  sum(coalesce(visits_scheduled,0)) as visits_scheduled,
  sum(coalesce(visits_completed,0)) as visits_completed,
  sum(coalesce(proposals,0)) as proposals,
  sum(coalesce(sales,0)) as sales,
  min(report_confidence) as min_report_confidence,
  max(event_at) as last_report_at
from agency_ops.commercial_whatsapp_metric_latest_by_broker
where inferred_report_date is not null
group by client_id,inferred_report_date;

create or replace view agency_ops.external_crm_funnel_daily as
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
from agency_ops.external_crm_events
where external_lead_id is not null
group by client_id,(coalesce(occurred_at,received_at) at time zone 'America/Sao_Paulo')::date;

create or replace view agency_ops.commercial_whatsapp_freeform_signals as
select *
from agency_ops.commercial_whatsapp_signal_candidates
where sender_side in ('CLIENT_SIDE','CLIENT')
  and candidate_stage <> 'UNKNOWN'
  and message_text !~* '(quantos[[:space:]]+leads[[:space:]]+receberam|quantas[[:space:]]+liga[cç][oõ]es|quantas[[:space:]]+visitas|quantas[[:space:]]+propostas)'
  and coalesce(identity_confidence,0) >= 0.8;

create or replace view agency_ops.crm_whatsapp_daily_reconciliation as
select
  coalesce(c.client_id,w.client_id) as client_id,
  coalesce(c.report_date,w.report_date) as report_date,
  c.new_leads as crm_new_leads,
  c.contacted as crm_contacted,
  c.qualified as crm_qualified,
  c.visits_scheduled as crm_visits_scheduled,
  c.visits_completed as crm_visits_completed,
  c.proposals as crm_proposals,
  c.won as crm_won,
  c.lost as crm_lost,
  c.leads_with_events as crm_leads_with_events,
  w.brokers_reporting as whatsapp_brokers_reporting,
  w.leads_received as whatsapp_leads_received,
  w.calls_made as whatsapp_calls_made,
  w.calls_answered as whatsapp_calls_answered,
  w.conversations as whatsapp_conversations,
  w.visits_scheduled as whatsapp_visits_scheduled,
  w.visits_completed as whatsapp_visits_completed,
  w.proposals as whatsapp_proposals,
  w.sales as whatsapp_sales,
  w.min_report_confidence,
  greatest(c.last_event_received_at,w.last_report_at) as last_source_activity_at
from agency_ops.external_crm_funnel_daily c
full outer join agency_ops.commercial_whatsapp_metric_daily w
  on w.client_id=c.client_id and w.report_date=c.report_date;

grant select on agency_ops.commercial_whatsapp_metric_daily to service_role;
grant select on agency_ops.external_crm_funnel_daily to service_role;
grant select on agency_ops.commercial_whatsapp_freeform_signals to service_role;
grant select on agency_ops.crm_whatsapp_daily_reconciliation to service_role;

comment on view agency_ops.crm_whatsapp_daily_reconciliation is
  'Daily CRM vs broker-reported WhatsApp commercial metrics. Null on either side means that source had no data for the client/date; values are not silently reconciled.';
