create table if not exists agency_ops.client_decisions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete restrict,
  category text not null default 'OTHER' check (category in ('STRATEGY','BUDGET','CAMPAIGN','CREATIVE','AUDIENCE','COMMUNICATION','ONBOARDING','PROCESS','OTHER')),
  title text not null check (char_length(trim(title)) between 3 and 240),
  decision_text text not null check (char_length(trim(decision_text)) between 3 and 12000),
  reason text,
  expected_impact text,
  outcome text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED','SUPERSEDED','REVERSED')),
  decided_at timestamptz not null default now(),
  created_by_user_id uuid not null,
  created_by_person text not null,
  supersedes_decision_id uuid references agency_ops.client_decisions(id) on delete set null,
  source_type text not null default 'MANUAL',
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_decisions_client_time_idx on agency_ops.client_decisions(client_id, decided_at desc);
create index if not exists client_decisions_status_idx on agency_ops.client_decisions(status, decided_at desc);
create index if not exists client_decisions_actor_idx on agency_ops.client_decisions(created_by_user_id, decided_at desc);

create table if not exists agency_ops.traffic_experiments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 3 and 240),
  experiment_type text not null default 'OTHER' check (experiment_type in ('AUDIENCE','CREATIVE','BUDGET','PLACEMENT','OBJECTIVE','COPY','LANDING_PAGE','CAMPAIGN_STRUCTURE','OTHER')),
  hypothesis text not null check (char_length(trim(hypothesis)) between 3 and 12000),
  variable_tested text,
  control_description text,
  variant_description text,
  primary_metric text not null default 'CPL' check (primary_metric in ('CPL','CPA','CTR','CPM','LEADS','CONVERSIONS','ROAS','CPC','OTHER')),
  baseline_value numeric,
  result_value numeric,
  start_at timestamptz,
  end_at timestamptz,
  status text not null default 'PLANNED' check (status in ('PLANNED','RUNNING','COMPLETED','CANCELLED')),
  conclusion text not null default 'ONGOING' check (conclusion in ('ONGOING','WIN','LOSS','INCONCLUSIVE')),
  result_summary text,
  learning text,
  campaign_ids text[] not null default '{}'::text[],
  created_by_user_id uuid not null,
  created_by_person text not null,
  source_type text not null default 'MANUAL',
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traffic_experiments_date_order check (end_at is null or start_at is null or end_at >= start_at)
);

create index if not exists traffic_experiments_client_time_idx on agency_ops.traffic_experiments(client_id, coalesce(start_at, created_at) desc);
create index if not exists traffic_experiments_status_idx on agency_ops.traffic_experiments(status, created_at desc);
create index if not exists traffic_experiments_type_idx on agency_ops.traffic_experiments(experiment_type, created_at desc);

create or replace function agency_ops.touch_learning_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, agency_ops
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_client_decisions_updated_at on agency_ops.client_decisions;
create trigger trg_client_decisions_updated_at
before update on agency_ops.client_decisions
for each row execute function agency_ops.touch_learning_updated_at();

drop trigger if exists trg_traffic_experiments_updated_at on agency_ops.traffic_experiments;
create trigger trg_traffic_experiments_updated_at
before update on agency_ops.traffic_experiments
for each row execute function agency_ops.touch_learning_updated_at();

alter table agency_ops.client_decisions enable row level security;
alter table agency_ops.traffic_experiments enable row level security;

comment on table agency_ops.client_decisions is 'Memoria operacional de decisoes tomadas por cliente, incluindo motivo, impacto esperado e resultado.';
comment on table agency_ops.traffic_experiments is 'Biblioteca de experimentos de trafego por cliente, com hipotese, variavel, metrica, resultado e aprendizado.';