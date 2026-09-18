alter table agency_ops.meeting_capture_sessions
  add column if not exists audio_local_path text,
  add column if not exists audio_remote_path text,
  add column if not exists audio_mixed_path text,
  add column if not exists audio_duration_ms bigint,
  add column if not exists audio_size_bytes bigint,
  add column if not exists audio_mime_type text,
  add column if not exists audio_status text,
  add column if not exists audio_source text,
  add column if not exists audio_retention_until timestamptz,
  add column if not exists audio_last_error text,
  add column if not exists audio_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='agency_ops.meeting_capture_sessions'::regclass
      and conname='meeting_capture_sessions_audio_status_check'
  ) then
    alter table agency_ops.meeting_capture_sessions
      add constraint meeting_capture_sessions_audio_status_check
      check (audio_status is null or audio_status = any(array[
        'RECORDING','RECORDED_LOCAL','UPLOADING','STORED','PROCESSING','READY','UPLOAD_FAILED'
      ]));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='agency_ops.meeting_capture_sessions'::regclass
      and conname='meeting_capture_sessions_audio_source_check'
  ) then
    alter table agency_ops.meeting_capture_sessions
      add constraint meeting_capture_sessions_audio_source_check
      check (audio_source is null or audio_source = any(array[
        'DESKTOP_AGENT','EXTENSION_WEBRTC','FALLBACK_EXTENSION'
      ]));
  end if;
end $$;

create index if not exists meeting_capture_sessions_audio_status_idx
  on agency_ops.meeting_capture_sessions(audio_status, updated_at desc);

update storage.buckets
set file_size_limit = greatest(coalesce(file_size_limit,0), 2147483648),
    allowed_mime_types = array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav']
where id='relato-call-audio';
