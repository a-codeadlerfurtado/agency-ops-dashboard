alter table agency_ops.creative_preapproval_items enable row level security;
alter table agency_ops.creative_preapproval_events enable row level security;

revoke all on agency_ops.creative_preapproval_items from public, anon, authenticated;
revoke all on agency_ops.creative_preapproval_events from public, anon, authenticated;
revoke all on agency_ops.creative_preapproval_queue from public, anon, authenticated;
revoke all on sequence agency_ops.creative_preapproval_items_id_seq from public, anon, authenticated;
revoke all on sequence agency_ops.creative_preapproval_events_id_seq from public, anon, authenticated;

grant select, insert, update, delete on agency_ops.creative_preapproval_items to service_role;
grant select, insert, update, delete on agency_ops.creative_preapproval_events to service_role;
grant select on agency_ops.creative_preapproval_queue to service_role;
grant usage, select on sequence agency_ops.creative_preapproval_items_id_seq to service_role;
grant usage, select on sequence agency_ops.creative_preapproval_events_id_seq to service_role;

revoke execute on function agency_ops.capture_creative_preapproval_message(bigint) from public, anon, authenticated;
revoke execute on function agency_ops.resolve_creative_preapproval_client(text) from public, anon, authenticated;
revoke execute on function agency_ops.tg_capture_creative_preapproval() from public, anon, authenticated;
grant execute on function agency_ops.capture_creative_preapproval_message(bigint) to service_role;
grant execute on function agency_ops.resolve_creative_preapproval_client(text) to service_role;
