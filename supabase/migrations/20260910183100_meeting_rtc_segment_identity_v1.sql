-- Preserve raw Meet RTC identity on transcript segments for authoritative speaker repair.
alter table agency_ops.meeting_transcript_segments
  add column if not exists device_id text,
  add column if not exists message_id text,
  add column if not exists message_version bigint;

create index if not exists meeting_transcript_segments_device_idx
  on agency_ops.meeting_transcript_segments(session_id, device_id)
  where device_id is not null;

comment on column agency_ops.meeting_transcript_segments.device_id is
  'Raw Google Meet RTC device identity captured from caption protobuf; never inferred from audio.';
comment on column agency_ops.meeting_transcript_segments.message_id is
  'Stable caption message identity used to deduplicate revisions.';
comment on column agency_ops.meeting_transcript_segments.message_version is
  'Highest observed revision number for the caption message when available.';
