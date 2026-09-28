create table if not exists agency_ops.relato_call_coaching_points (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references agency_ops.meeting_capture_sessions(id) on delete cascade,
  transcript_id bigint references agency_ops.meeting_transcripts(id) on delete set null,
  sdr_person text not null,
  author_person text not null,
  kind text not null default 'IMPROVEMENT'
    check (kind in ('IMPROVEMENT','PRAISE','OBSERVATION')),
  timestamp_ms integer not null check (timestamp_ms >= 0),
  note text not null check (char_length(btrim(note)) between 2 and 2000),
  context_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists relato_call_coaching_points_session_time_idx
  on agency_ops.relato_call_coaching_points(session_id, timestamp_ms, created_at);

create index if not exists relato_call_coaching_points_sdr_created_idx
  on agency_ops.relato_call_coaching_points(sdr_person, created_at desc);

alter table agency_ops.relato_call_coaching_points enable row level security;

comment on table agency_ops.relato_call_coaching_points is
  'Timestamped manager coaching notes attached to Relato AI SDR calls. Read/write is mediated by agency-ops-sdr-api.';
