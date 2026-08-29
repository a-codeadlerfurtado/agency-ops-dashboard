create table if not exists agency_ops.system_update_commits (
  sha text primary key,
  committed_at timestamptz not null,
  subject text not null,
  body text,
  changed_files jsonb not null default '[]'::jsonb,
  additions integer not null default 0,
  deletions integer not null default 0,
  target_roles text[] not null default array['ALL']::text[],
  title text not null,
  added jsonb not null default '[]'::jsonb,
  fixed jsonb not null default '[]'::jsonb,
  removed jsonb not null default '[]'::jsonb,
  explanation text,
  summary_source text not null default 'DETERMINISTIC',
  ingested_at timestamptz not null default now(),
  constraint system_update_target_roles_valid check (
    target_roles <@ array['ALL','MGMT','GT','CS','DESIGN','AI','COMMERCIAL']::text[]
  )
);

create index if not exists system_update_commits_committed_idx
  on agency_ops.system_update_commits (committed_at desc);

create index if not exists system_update_commits_roles_idx
  on agency_ops.system_update_commits using gin (target_roles);

create table if not exists agency_ops.system_update_receipts (
  user_key text not null,
  edition_date date not null,
  shown_at timestamptz not null default now(),
  dismissed_at timestamptz,
  commit_shas text[] not null default '{}'::text[],
  primary key (user_key, edition_date)
);

create index if not exists system_update_receipts_user_idx
  on agency_ops.system_update_receipts (user_key, edition_date desc);

create table if not exists agency_ops.system_update_preview_queue (
  user_key text primary key,
  enabled boolean not null default true,
  commit_limit integer not null default 6 check (commit_limit between 1 and 12),
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
);

alter table agency_ops.system_update_commits enable row level security;
alter table agency_ops.system_update_receipts enable row level security;
alter table agency_ops.system_update_preview_queue enable row level security;

revoke all on agency_ops.system_update_commits from anon, authenticated;
revoke all on agency_ops.system_update_receipts from anon, authenticated;
revoke all on agency_ops.system_update_preview_queue from anon, authenticated;

grant all on agency_ops.system_update_commits to service_role;
grant all on agency_ops.system_update_receipts to service_role;
grant all on agency_ops.system_update_preview_queue to service_role;

comment on table agency_ops.system_update_commits is 'Commit-level release notes ingested from verified GitHub Actions OIDC pushes to main.';
comment on table agency_ops.system_update_receipts is 'One daily system-update acknowledgement per dashboard user.';
comment on table agency_ops.system_update_preview_queue is 'One-off stacked patch-note preview queue, currently used for management validation.';
