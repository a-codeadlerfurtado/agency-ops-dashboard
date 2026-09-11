create table if not exists agency_ops.diagnostic_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  period_start date,
  period_end date,
  status text not null default 'READY' check (status in ('DRAFT','READY','REVIEWED','ARCHIVED')),
  health_score integer check (health_score between 0 and 100),
  primary_bottleneck text,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  facts jsonb not null default '[]'::jsonb,
  hypotheses jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  generated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists diagnostic_runs_client_created_idx on agency_ops.diagnostic_runs (client_id, created_at desc);

create table if not exists agency_ops.diagnostic_questions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references agency_ops.clients(id) on delete cascade,
  run_id uuid references agency_ops.diagnostic_runs(id) on delete set null,
  question text not null,
  why_it_matters text,
  decision_impact text,
  options jsonb not null default '[]'::jsonb,
  priority text not null default 'MEDIUM' check (priority in ('CRITICAL','HIGH','MEDIUM','LOW')),
  status text not null default 'OPEN' check (status in ('OPEN','ANSWERED','DISMISSED')),
  target_person text,
  target_role text,
  answer_text text,
  structured_answer jsonb not null default '{}'::jsonb,
  answered_by text,
  answered_at timestamptz,
  source_gap jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);create index if not exists diagnostic_questions_open_idx on agency_ops.diagnostic_questions (status, priority, created_at desc);
create index if not exists diagnostic_questions_client_idx on agency_ops.diagnostic_questions (client_id, created_at desc);

create table if not exists agency_ops.diagnostic_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  actor text,
  actor_side text check (actor_side is null or actor_side in ('AGENCY','CLIENT','PLATFORM','UNKNOWN')),
  source text not null,
  evidence_ref text,
  payload jsonb not null default '{}'::jsonb,
  expected_at timestamptz,
  completed_at timestamptz,
  related_event_id uuid references agency_ops.diagnostic_events(id) on delete set null,
  confidence numeric(5,4) not null default 1 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now()
);
create index if not exists diagnostic_events_client_time_idx on agency_ops.diagnostic_events (client_id, occurred_at desc);
create index if not exists diagnostic_events_type_time_idx on agency_ops.diagnostic_events (event_type, occurred_at desc);

create table if not exists agency_ops.diagnostic_sla_results (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  metric_key text not null,
  label text not null,
  start_event_id uuid references agency_ops.diagnostic_events(id) on delete set null,
  end_event_id uuid references agency_ops.diagnostic_events(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz,
  duration_minutes integer,
  target_minutes integer,
  status text not null check (status in ('PENDING','MET','BREACHED','BLOCKED','NOT_APPLICABLE')),
  owner_side text check (owner_side is null or owner_side in ('AGENCY','CLIENT','SHARED','PLATFORM')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);create index if not exists diagnostic_sla_client_status_idx on agency_ops.diagnostic_sla_results (client_id, status, created_at desc);

create table if not exists agency_ops.diagnostic_experiments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  run_id uuid references agency_ops.diagnostic_runs(id) on delete set null,
  hypothesis text not null,
  intervention text,
  success_metric text,
  status text not null default 'PLANNED' check (status in ('PLANNED','RUNNING','WON','LOST','INCONCLUSIVE','CANCELLED')),
  started_at timestamptz,
  evaluate_at timestamptz,
  finished_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists diagnostic_experiments_client_idx on agency_ops.diagnostic_experiments (client_id, status, created_at desc);

alter table agency_ops.diagnostic_runs enable row level security;
alter table agency_ops.diagnostic_questions enable row level security;
alter table agency_ops.diagnostic_events enable row level security;
alter table agency_ops.diagnostic_sla_results enable row level security;
alter table agency_ops.diagnostic_experiments enable row level security;

grant select, insert, update, delete on agency_ops.diagnostic_runs to service_role;
grant select, insert, update, delete on agency_ops.diagnostic_questions to service_role;
grant select, insert, update, delete on agency_ops.diagnostic_events to service_role;
grant select, insert, update, delete on agency_ops.diagnostic_sla_results to service_role;
grant select, insert, update, delete on agency_ops.diagnostic_experiments to service_role;

comment on table agency_ops.diagnostic_questions is 'Perguntas de alto valor geradas pelo motor quando falta contexto que pode mudar diagnóstico, responsabilidade ou próxima ação.';
comment on table agency_ops.diagnostic_events is 'Linha do tempo estruturada da conta para performance, SLA, execução e dependências.';
alter table agency_ops.diagnostic_questions add column if not exists dedupe_key text;
create unique index if not exists diagnostic_questions_dedupe_idx
  on agency_ops.diagnostic_questions (dedupe_key)
  where dedupe_key is not null;
