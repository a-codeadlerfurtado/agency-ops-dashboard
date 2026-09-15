create table if not exists agency_ops.designer_daily_reports (
  id bigserial primary key,
  author_user_id uuid not null,
  author_name text not null,
  report_date date not null,
  report_text text not null check (char_length(trim(report_text)) between 1 and 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_user_id, report_date)
);

create index if not exists designer_daily_reports_report_date_idx
  on agency_ops.designer_daily_reports (report_date desc);

create index if not exists designer_daily_reports_author_date_idx
  on agency_ops.designer_daily_reports (author_user_id, report_date desc);

alter table agency_ops.designer_daily_reports enable row level security;

comment on table agency_ops.designer_daily_reports is
  'Relatorio diario livre dos designers. Um registro por designer por data; acesso de escrita somente pela API autenticada do Diario.';