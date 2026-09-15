alter table agency_ops.meeting_capture_sessions
  drop constraint if exists meeting_capture_sessions_capture_mode_check;

alter table agency_ops.meeting_capture_sessions
  add constraint meeting_capture_sessions_capture_mode_check
  check (capture_mode = any (array[
    'MEET_CAPTIONS'::text,
    'MEET_RTC_CAPTIONS'::text,
    'MEET_RTC_AUDIO'::text,
    'GOOGLE_NATIVE'::text,
    'LOCAL_AUDIO_FALLBACK'::text,
    'HYBRID'::text,
    'WHATSAPP_WEB_AUDIO'::text,
    'WHATSAPP_DESKTOP_AUDIO'::text
  ]));
