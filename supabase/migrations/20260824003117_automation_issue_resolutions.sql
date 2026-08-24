create table if not exists agency_ops.automation_issue_resolutions (
  id uuid primary key default gen_random_uuid(),
  issue_key text not null unique,
  issue_kind text not null,
  reference_id text,
  resolved_by_user_key text,
  resolved_by_person text,
  resolved_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_issue_resolutions_resolved_at_idx
  on agency_ops.automation_issue_resolutions (resolved_at desc);

alter table agency_ops.automation_issue_resolutions enable row level security;
revoke all on agency_ops.automation_issue_resolutions from public, anon, authenticated;
grant select, insert, update, delete on agency_ops.automation_issue_resolutions to service_role;
