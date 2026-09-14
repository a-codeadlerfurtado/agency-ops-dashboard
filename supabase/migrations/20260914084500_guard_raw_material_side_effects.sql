-- Prevent test/manual rows in client_raw_material_uploads from triggering production side effects.
-- Only a verified Drive watcher event, matched against a non-test client binding, may notify,
-- enqueue triage, update watcher health, or start the automatic video pipeline.

create or replace function agency_ops.raw_material_side_effects_allowed(
  p_client_id uuid,
  p_source text,
  p_match_confidence text,
  p_drive_file_id text,
  p_drive_folder_id text,
  p_drive_uploaded_at timestamptz,
  p_detected_at timestamptz,
  p_metadata jsonb
)
returns boolean
language sql
stable
security definer
set search_path to 'agency_ops','public'
as $$
  select
    p_client_id is not null
    and lower(coalesce(p_source,'')) = 'drive_watch'
    and lower(coalesce(p_match_confidence,'')) = 'alta'
    and nullif(btrim(p_drive_file_id),'') is not null
    and nullif(btrim(p_drive_folder_id),'') is not null
    and p_drive_uploaded_at is not null
    and p_detected_at is not null
    and coalesce(p_metadata->>'matched_by','') = 'DRIVE_FOLDER_BINDING'
    and nullif(btrim(p_metadata->>'canonical_drive_folder_id'),'') = nullif(btrim(p_drive_folder_id),'')
    and p_detected_at >= p_drive_uploaded_at - interval '5 minutes'
    and p_detected_at <= p_drive_uploaded_at + interval '24 hours'
    and exists (
      select 1
      from agency_ops.client_drive_bindings b
      where b.client_id = p_client_id
        and b.binding_status = 'VERIFIED'
        and b.drive_folder_id = p_drive_folder_id
        and lower(coalesce(b.metadata->>'test_mode','false')) not in ('true','1','yes','on')
    );
$$;

comment on function agency_ops.raw_material_side_effects_allowed(uuid,text,text,text,text,timestamptz,timestamptz,jsonb)
is 'Fail-closed provenance check for raw Drive uploads before notifications, triage, watcher heartbeat or auto-video side effects.';

drop trigger if exists trg_raw_material_triage on agency_ops.client_raw_material_uploads;
create trigger trg_raw_material_triage
after insert on agency_ops.client_raw_material_uploads
for each row
when (agency_ops.raw_material_side_effects_allowed(new.client_id,new.source,new.match_confidence,new.drive_file_id,new.drive_folder_id,new.drive_uploaded_at,new.detected_at,new.metadata))
execute function agency_ops.enqueue_raw_material_triage();

drop trigger if exists trg_designer_material_notification on agency_ops.client_raw_material_uploads;
create trigger trg_designer_material_notification
after insert on agency_ops.client_raw_material_uploads
for each row
when (agency_ops.raw_material_side_effects_allowed(new.client_id,new.source,new.match_confidence,new.drive_file_id,new.drive_folder_id,new.drive_uploaded_at,new.detected_at,new.metadata))
execute function agency_ops.create_designer_material_notifications();

drop trigger if exists trg_notify_raw_material_uploaded on agency_ops.client_raw_material_uploads;
create trigger trg_notify_raw_material_uploaded
after insert on agency_ops.client_raw_material_uploads
for each row
when (agency_ops.raw_material_side_effects_allowed(new.client_id,new.source,new.match_confidence,new.drive_file_id,new.drive_folder_id,new.drive_uploaded_at,new.detected_at,new.metadata))
execute function agency_ops.notify_raw_material_uploaded();

drop trigger if exists trg_auto_video_v4_from_raw_upload on agency_ops.client_raw_material_uploads;
create trigger trg_auto_video_v4_from_raw_upload
after insert on agency_ops.client_raw_material_uploads
for each row
when (agency_ops.raw_material_side_effects_allowed(new.client_id,new.source,new.match_confidence,new.drive_file_id,new.drive_folder_id,new.drive_uploaded_at,new.detected_at,new.metadata))
execute function agency_ops.enqueue_auto_video_v4_from_raw_upload();

drop trigger if exists trg_mark_drive_polling_watcher_active on agency_ops.client_raw_material_uploads;
create trigger trg_mark_drive_polling_watcher_active
after insert or update of detected_at on agency_ops.client_raw_material_uploads
for each row
when (agency_ops.raw_material_side_effects_allowed(new.client_id,new.source,new.match_confidence,new.drive_file_id,new.drive_folder_id,new.drive_uploaded_at,new.detected_at,new.metadata))
execute function agency_ops.mark_drive_polling_watcher_active();
