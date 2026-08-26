create or replace function agency_ops.current_collaborator_person()
returns text
language sql
stable
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
  select collaborator_person
  from agency_ops.user_preferences
  where user_key = auth.uid()::text
  limit 1
$$;

grant execute on function agency_ops.current_collaborator_person() to authenticated;

drop policy if exists platform_notifications_self_private_select on agency_ops.platform_notifications;
create policy platform_notifications_self_private_select
on agency_ops.platform_notifications
for select
to authenticated
using (
  coalesce((metadata->>'private_to_person')::boolean,false)=true
  and metadata->>'target_person' = agency_ops.current_collaborator_person()
);

grant select on agency_ops.platform_notifications to authenticated;
