-- Client-facing monthly report compiled from audited weekly reports.
create table if not exists agency_ops.monthly_client_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  gt_owner text,
  month_start date not null,
  month_end date not null,
  public_token uuid not null default gen_random_uuid() unique,
  status text not null default 'READY' check (status in ('READY','REVIEW_REQUIRED','ERROR')),
  audit_status text not null default 'PARTIAL' check (audit_status in ('PASS','PARTIAL','FAIL')),
  is_final boolean not null default false,
  snapshot jsonb not null default '{}'::jsonb,
  source_report_ids uuid[] not null default '{}'::uuid[],
  previous_source_report_ids uuid[] not null default '{}'::uuid[],
  generated_at timestamptz not null default now(),
  shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, month_start),
  check (month_start = date_trunc('month',month_start)::date),
  check (month_end >= month_start)
);
create index if not exists monthly_client_reports_month_idx
  on agency_ops.monthly_client_reports(month_start desc,status,gt_owner,client_name);
create index if not exists monthly_client_reports_client_idx
  on agency_ops.monthly_client_reports(client_id,month_start desc);

alter table agency_ops.monthly_client_reports enable row level security;
revoke all on agency_ops.monthly_client_reports from anon,authenticated;
grant select,insert,update,delete on agency_ops.monthly_client_reports to service_role;

comment on table agency_ops.monthly_client_reports is
  'Fechamento mensal cliente-facing: consolida relatorios semanais auditados, compara semanas e mes anterior, e publica apresentacao tokenizada.';