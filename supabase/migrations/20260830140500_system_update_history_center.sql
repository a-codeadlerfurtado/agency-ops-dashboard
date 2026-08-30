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

create or replace function agency_ops.mark_system_update_revert()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, pg_temp
as $$
declare
  target_sha text;
begin
  target_sha := substring(coalesce(new.body, '') from '(?i)this reverts commit ([0-9a-f]{40})');
  if target_sha is null then
    target_sha := substring(coalesce(new.subject, '') || E'\n' || coalesce(new.body, '') from '(?i)revert(?:s|ed)?[^0-9a-f]+([0-9a-f]{40})');
  end if;
  if target_sha is not null then
    new.release_status := 'REVERT';
    new.reverts_sha := lower(target_sha);
    update agency_ops.system_update_commits
       set release_status = 'REVERTED', reverted_by_sha = new.sha
     where sha = lower(target_sha);
  end if;
  return new;
end;
$$;

revoke all on function agency_ops.mark_system_update_revert() from public, anon, authenticated;
grant execute on function agency_ops.mark_system_update_revert() to service_role;

drop trigger if exists trg_mark_system_update_revert on agency_ops.system_update_commits;
create trigger trg_mark_system_update_revert
before insert or update of subject, body on agency_ops.system_update_commits
for each row execute function agency_ops.mark_system_update_revert();

revoke all on agency_ops.system_update_commits from anon, authenticated;
revoke all on agency_ops.system_update_receipts from anon, authenticated;
revoke all on agency_ops.system_update_preview_queue from anon, authenticated;
