create table if not exists agency_ops.data_audit_runs (
  id uuid primary key default gen_random_uuid(),
  phase text not null check (phase in ('INITIAL', 'FINAL')),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'SUCCESS', 'PARTIAL', 'ERROR')),
  initiated_by text not null default 'Agency Ops',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  records_analyzed bigint not null default 0,
  issues_found integer not null default 0,
  issues_corrected integer not null default 0,
  manual_review integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error text
);

create table if not exists agency_ops.data_audit_issues (
  id bigint generated always as identity primary key,
  audit_run_id uuid not null references agency_ops.data_audit_runs(id) on delete cascade,
  severity text not null check (severity in ('CRITICAL', 'ATTENTION', 'INFO')),
  category text not null,
  issue_code text not null,
  entity_type text not null,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  source_used text,
  resolution_status text not null default 'OPEN' check (resolution_status in ('OPEN', 'AUTO_CORRECTED', 'MANUAL_REVIEW', 'NO_CHANGE')),
  explanation text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (audit_run_id, issue_code, entity_type, entity_id)
);

create table if not exists agency_ops.data_recovery_snapshots (
  id uuid primary key default gen_random_uuid(),
  audit_run_id uuid not null references agency_ops.data_audit_runs(id) on delete restrict,
  label text not null,
  captured_at timestamptz not null default now(),
  table_counts jsonb not null default '{}'::jsonb,
  notes text
);

create table if not exists agency_ops.data_recovery_snapshot_rows (
  snapshot_id uuid not null references agency_ops.data_recovery_snapshots(id) on delete restrict,
  source_schema text not null,
  source_table text not null,
  record_key text not null,
  row_data jsonb not null,
  captured_at timestamptz not null default now(),
  primary key (snapshot_id, source_schema, source_table, record_key)
);

create index if not exists data_audit_issues_run_status_idx
  on agency_ops.data_audit_issues (audit_run_id, resolution_status, severity);
create index if not exists data_recovery_snapshot_rows_source_idx
  on agency_ops.data_recovery_snapshot_rows (source_schema, source_table, record_key);

alter table agency_ops.data_audit_runs enable row level security;
alter table agency_ops.data_audit_issues enable row level security;
alter table agency_ops.data_recovery_snapshots enable row level security;
alter table agency_ops.data_recovery_snapshot_rows enable row level security;

revoke all on agency_ops.data_audit_runs from anon, authenticated;
revoke all on agency_ops.data_audit_issues from anon, authenticated;
revoke all on agency_ops.data_recovery_snapshots from anon, authenticated;
revoke all on agency_ops.data_recovery_snapshot_rows from anon, authenticated;
grant all on agency_ops.data_audit_runs to service_role;
grant all on agency_ops.data_audit_issues to service_role;
grant all on agency_ops.data_recovery_snapshots to service_role;
grant all on agency_ops.data_recovery_snapshot_rows to service_role;
grant usage, select on sequence agency_ops.data_audit_issues_id_seq to service_role;

comment on table agency_ops.data_recovery_snapshot_rows is
  'Ponto de recuperação lógico criado antes de reconstruções em massa; contém somente tabelas operacionais mutáveis, preservando fontes brutas imutáveis.';
