alter table agency_ops.whatsapp_messages drop constraint if exists whatsapp_messages_source_check;
alter table agency_ops.whatsapp_messages add constraint whatsapp_messages_source_check
check (source = any(array['zapi_mirror'::text,'sheets_backfill'::text,'manual'::text,'zapi_direct_official'::text]));
