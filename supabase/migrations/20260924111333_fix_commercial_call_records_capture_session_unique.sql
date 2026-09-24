alter table agency_ops.commercial_call_records
  add constraint commercial_call_records_capture_session_key
  unique (capture_session_id);
