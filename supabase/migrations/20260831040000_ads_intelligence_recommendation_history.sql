create table if not exists agency_ops.ads_intelligence_recommendation_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text null,
  object_type text not null default 'CLIENT' check (object_type in ('CLIENT','ADSET','AD')),
  object_id text null,
  object_name text null,
  field_name text null,
  category text null,
  title text not null,
  recommendation text not null,
  reason text null,
  confidence text null,
  benchmark_snapshot jsonb not null default '{}'::jsonb,
  metrics_before jsonb not null default '{}'::jsonb,
  status text not null default 'APPLIED' check (status in ('APPLIED','DISMISSED','CANCELLED')),
  applied_by_user_key uuid null,
  applied_by_person text null,
  applied_at timestamptz null,
  followup_due_at timestamptz null,
  metrics_after jsonb null,
  outcome text null,
  outcome_reason text null,
  evaluated_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ads_intelligence_rec_events_client_idx
  on agency_ops.ads_intelligence_recommendation_events(client_id, created_at desc);
create index if not exists ads_intelligence_rec_events_due_idx
  on agency_ops.ads_intelligence_recommendation_events(status, followup_due_at)
  where status='APPLIED';
create index if not exists ads_intelligence_rec_events_object_idx
  on agency_ops.ads_intelligence_recommendation_events(object_type, object_id, created_at desc);

alter table agency_ops.ads_intelligence_recommendation_events enable row level security;
revoke all on agency_ops.ads_intelligence_recommendation_events from anon, authenticated;

comment on table agency_ops.ads_intelligence_recommendation_events is
  'Histórico auditável de recomendações do Ads Intelligence e avaliação pós-ação.';
