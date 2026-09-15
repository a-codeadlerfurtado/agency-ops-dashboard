update agency_ops.onboarding_sla_events
set started_at = completed_at,
    due_at = agency_ops.add_business_days(
      completed_at,
      case when event_type = 'CREATIVE_PRODUCTION' then 2 else 1 end
    ),
    updated_at = now()
where completed_at is not null
  and completed_at < started_at;
