alter table agency_ops.system_update_commits
  add column if not exists release_status text not null default 'ACTIVE',
  add column if not exists reverts_sha text null,
  add column if not exists reverted_by_sha text null;

alter table agency_ops.system_update_commits
  drop constraint if exists system_update_commits_release_status_check;

alter table agency_ops.system_update_commits
  add constraint system_update_commits_release_status_check
  check (release_status in ('ACTIVE','REVERTED','REVERT'));

create index if not exists idx_system_update_commits_status_time
  on agency_ops.system_update_commits (release_status, committed_at desc);

revoke all on agency_ops.system_update_commits from anon, authenticated;
revoke all on agency_ops.system_update_receipts from anon, authenticated;
revoke all on agency_ops.system_update_preview_queue from anon, authenticated;
