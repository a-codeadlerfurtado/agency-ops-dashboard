create or replace function agency_ops.get_client_crm_funnel_summary(
  p_client_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language sql
stable
security invoker
set search_path = agency_ops, public
as $$
with scoped as (
  select
    f.client_id,
    f.provider,
    f.external_lead_id,
    f.canonical_stage,
    nullif(btrim(f.broker_name),'') as broker_name,
    coalesce(f.occurred_at,f.received_at) as event_at,
    f.received_at,
    f.source,
    f.source_confidence
  from agency_ops.external_crm_event_feed f
  where f.client_id = p_client_id
    and (coalesce(f.occurred_at,f.received_at) at time zone 'America/Sao_Paulo')::date
      between p_date_from and p_date_to
),
totals as (
  select
    count(distinct external_lead_id) filter (where canonical_stage='NEW') as new_leads,
    count(distinct external_lead_id) filter (where canonical_stage='CONTACTED') as contacted,
    count(distinct external_lead_id) filter (where canonical_stage='QUALIFIED') as qualified,
    count(distinct external_lead_id) filter (where canonical_stage='VISIT_SCHEDULED') as visits_scheduled,
    count(distinct external_lead_id) filter (where canonical_stage='VISIT_COMPLETED') as visits_completed,
    count(distinct external_lead_id) filter (where canonical_stage='PROPOSAL') as proposals,
    count(distinct external_lead_id) filter (where canonical_stage='WON') as won,
    count(distinct external_lead_id) filter (where canonical_stage='LOST') as lost,
    count(distinct external_lead_id) as leads_with_events,
    max(received_at) as last_event_received_at,
    avg(source_confidence) as avg_source_confidence
  from scoped
),
broker_rows as (
  select
    coalesce(broker_name,'Sem corretor identificado') as broker_name,
    count(distinct external_lead_id) filter (where canonical_stage='NEW') as new_leads,
    count(distinct external_lead_id) filter (where canonical_stage='CONTACTED') as contacted,
    count(distinct external_lead_id) filter (where canonical_stage='QUALIFIED') as qualified,
    count(distinct external_lead_id) filter (where canonical_stage='VISIT_SCHEDULED') as visits_scheduled,
    count(distinct external_lead_id) filter (where canonical_stage='VISIT_COMPLETED') as visits_completed,
    count(distinct external_lead_id) filter (where canonical_stage='PROPOSAL') as proposals,
    count(distinct external_lead_id) filter (where canonical_stage='WON') as won,
    count(distinct external_lead_id) filter (where canonical_stage='LOST') as lost,
    count(distinct external_lead_id) as leads_with_events
  from scoped
  group by coalesce(broker_name,'Sem corretor identificado')
),
brokers as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'broker_name', broker_name,
        'new_leads', new_leads,
        'contacted', contacted,
        'qualified', qualified,
        'visits_scheduled', visits_scheduled,
        'visits_completed', visits_completed,
        'proposals', proposals,
        'won', won,
        'lost', lost,
        'leads_with_events', leads_with_events
      )
      order by won desc, proposals desc, visits_completed desc, visits_scheduled desc, new_leads desc, broker_name
    ),
    '[]'::jsonb
  ) as payload
  from broker_rows
),
provider_rows as (
  select
    provider,
    count(distinct external_lead_id) as leads_with_events,
    max(received_at) as last_event_received_at,
    avg(source_confidence) as avg_source_confidence
  from scoped
  group by provider
),
providers as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'leads_with_events', leads_with_events,
        'last_event_received_at', last_event_received_at,
        'avg_source_confidence', round(coalesce(avg_source_confidence,0)::numeric,3)
      )
      order by leads_with_events desc, provider
    ),
    '[]'::jsonb
  ) as payload
  from provider_rows
)
select jsonb_build_object(
  'date_from', p_date_from,
  'date_to', p_date_to,
  'totals', jsonb_build_object(
    'new_leads', coalesce(t.new_leads,0),
    'contacted', coalesce(t.contacted,0),
    'qualified', coalesce(t.qualified,0),
    'visits_scheduled', coalesce(t.visits_scheduled,0),
    'visits_completed', coalesce(t.visits_completed,0),
    'proposals', coalesce(t.proposals,0),
    'won', coalesce(t.won,0),
    'lost', coalesce(t.lost,0),
    'leads_with_events', coalesce(t.leads_with_events,0),
    'last_event_received_at', t.last_event_received_at,
    'avg_source_confidence', round(coalesce(t.avg_source_confidence,0)::numeric,3)
  ),
  'brokers', b.payload,
  'providers', p.payload
)
from totals t
cross join brokers b
cross join providers p;
$$;

revoke all on function agency_ops.get_client_crm_funnel_summary(uuid,date,date) from public, anon, authenticated;
grant execute on function agency_ops.get_client_crm_funnel_summary(uuid,date,date) to service_role;

comment on function agency_ops.get_client_crm_funnel_summary(uuid,date,date) is
  'Returns distinct-lead funnel totals and broker/provider breakdown for one client and date range. Service-role only.';
