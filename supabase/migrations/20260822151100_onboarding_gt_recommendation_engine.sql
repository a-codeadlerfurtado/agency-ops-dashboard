create table if not exists agency_ops.onboarding_gt_recommendations (
  request_id uuid primary key references agency_ops.onboarding_gt_assignment_requests(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  recommended_gt text,
  confidence integer not null default 0 check (confidence between 0 and 100),
  complexity_score integer not null default 0 check (complexity_score between 0 and 100),
  complexity_band text not null default 'UNDETERMINED',
  relationship_profile text not null default 'UNDETERMINED',
  relationship_detail jsonb not null default '{}'::jsonb,
  gt_scores jsonb not null default '[]'::jsonb,
  rationale text,
  evidence jsonb not null default '[]'::jsonb,
  source_coverage jsonb not null default '{}'::jsonb,
  load_snapshot jsonb not null default '[]'::jsonb,
  engine_version text not null default 'gt-fit-v1',
  chosen_gt text,
  chosen_by text,
  chosen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onboarding_gt_recommendations_client_idx
  on agency_ops.onboarding_gt_recommendations(client_id, updated_at desc);

revoke all on agency_ops.onboarding_gt_recommendations from anon, authenticated;
grant select, insert, update, delete on agency_ops.onboarding_gt_recommendations to service_role;

comment on table agency_ops.onboarding_gt_recommendations is
'Recomendacao assistida de GT para onboarding. Nunca atribui automaticamente; decisao final exige acao humana na notificacao.';
