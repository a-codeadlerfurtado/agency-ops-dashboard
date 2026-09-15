grant usage on schema agency_ops to authenticated;
grant select (id, display_name) on agency_ops.clients to authenticated;

create policy briefing_client_read_own_client_name
on agency_ops.clients
for select
to authenticated
using (
  exists (
    select 1
    from public.briefing_client_users bcu
    where bcu.user_id = auth.uid()
      and bcu.is_active = true
      and bcu.client_id = clients.id
  )
);
