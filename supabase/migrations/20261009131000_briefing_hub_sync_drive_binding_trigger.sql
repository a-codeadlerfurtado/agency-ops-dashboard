create or replace function agency_ops.tg_sync_drive_binding_from_integration()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.system = 'DRIVE' and coalesce(new.external_id, '') <> '' then
    begin
      insert into agency_ops.client_drive_bindings
        (client_id, drive_folder_id, drive_root_id, binding_status, verified_at, verified_by, source, metadata)
      values
        (new.client_id, new.external_id, '1-FIIyg51Wbe5GbMXagDcB6XxWhKmdY9A', 'VERIFIED', now(),
         'integration_sync_trigger', 'client_integrations_sync',
         jsonb_build_object(
           'client_name', new.external_name,
           'folder_url', 'https://drive.google.com/drive/folders/' || new.external_id,
           'root_folder_id', '1-FIIyg51Wbe5GbMXagDcB6XxWhKmdY9A',
           'integration_kind', 'BRIEFING_HUB_MATERIALS',
           'linked_at', now()))
      on conflict (client_id) do update
        set drive_folder_id = excluded.drive_folder_id,
            binding_status  = 'VERIFIED',
            verified_at     = now(),
            metadata        = coalesce(agency_ops.client_drive_bindings.metadata, '{}'::jsonb) || excluded.metadata,
            updated_at      = now()
        where agency_ops.client_drive_bindings.drive_folder_id is distinct from excluded.drive_folder_id;
    exception when others then
      null;
    end;
  end if;
  return new;
end
$$;

drop trigger if exists trg_sync_drive_binding on agency_ops.client_integrations;
create trigger trg_sync_drive_binding
after insert or update of external_id on agency_ops.client_integrations
for each row execute function agency_ops.tg_sync_drive_binding_from_integration();
