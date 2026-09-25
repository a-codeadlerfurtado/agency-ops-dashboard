alter table agency_ops.meeting_capture_sessions
drop constraint if exists meeting_capture_sessions_audio_status_check;

alter table agency_ops.meeting_capture_sessions
add constraint meeting_capture_sessions_audio_status_check
check (
  audio_status is null or audio_status in (
    'RECORDING','RECORDED_LOCAL','UPLOADING','STORED',
    'PROCESSING','READY','PARTIAL','UPLOAD_FAILED'
  )
);
