alter table agency_ops.meeting_capture_sessions
  add constraint meeting_capture_sessions_owner_local_session_key
  unique (owner_person, local_session_id);
