create or replace function agency_ops.current_authenticated_collaborator_person()
returns text
language sql
stable
security definer
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
  select nullif(trim(up.collaborator_person), '')
  from agency_ops.user_preferences up
  where up.user_key::text = auth.uid()::text
  limit 1
$$;

revoke all on function agency_ops.current_authenticated_collaborator_person() from public;
grant execute on function agency_ops.current_authenticated_collaborator_person() to authenticated;

grant usage on schema agency_ops to authenticated;
grant select on agency_ops.churned_client_message_warnings to authenticated;

drop policy if exists churned_warning_select_own on agency_ops.churned_client_message_warnings;
create policy churned_warning_select_own
on agency_ops.churned_client_message_warnings
for select
to authenticated
using (
  target_person = agency_ops.current_authenticated_collaborator_person()
);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'agency_ops'
      and tablename = 'churned_client_message_warnings'
  ) then
    alter publication supabase_realtime add table agency_ops.churned_client_message_warnings;
  end if;
end
$$;
