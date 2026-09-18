alter table agency_ops.meeting_capture_sessions
  drop constraint if exists meeting_capture_sessions_capture_mode_check;
alter table agency_ops.meeting_capture_sessions
  add constraint meeting_capture_sessions_capture_mode_check
  check (capture_mode = any(array[
    'MEET_CAPTIONS','MEET_RTC_CAPTIONS','MEET_RTC_AUDIO','MEET_DESKTOP_AGENT_AUDIO',
    'GOOGLE_NATIVE','LOCAL_AUDIO_FALLBACK','HYBRID','WHATSAPP_WEB_AUDIO','WHATSAPP_DESKTOP_AUDIO'
  ]));

alter table agency_ops.meeting_capture_sessions
  drop constraint if exists meeting_capture_sessions_state_check;
alter table agency_ops.meeting_capture_sessions
  add constraint meeting_capture_sessions_state_check
  check (state = any(array[
    'CAPTURING','FINISHING','CAPTURED','QUEUED','PROCESSING','READY','FAILED','NEEDS_REVIEW'
  ]));
