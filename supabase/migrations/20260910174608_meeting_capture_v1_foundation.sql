alter table agency_ops.meeting_transcripts
  add column if not exists owner_person text,
  add column if not exists meeting_ended_at timestamptz,
  add column if not exists duration_seconds integer,
  add column if not exists processing_status text,
  add column if not exists transcript_source text,
  add column if not exists transcript_quality numeric,
  add column if not exists capture_session_id uuid;

create table if not exists agency_ops.meeting_capture_devices (
  id uuid primary key default gen_random_uuid(),
  owner_person text not null,
  device_name text not null default 'Chrome',
  token_hash text not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  extension_version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.meeting_capture_pairings (
  code text primary key,
  owner_person text not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  device_id uuid references agency_ops.meeting_capture_devices(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists agency_ops.meeting_capture_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references agency_ops.meeting_capture_devices(id) on delete restrict,
  owner_person text not null,
  local_session_id text not null,
  meeting_code text,
  meeting_url text,
  title text,
  calendar_event_id text,
  started_at timestamptz not null,
  ended_at timestamptz,
  state text not null default 'CAPTURED' check (state in ('CAPTURING','CAPTURED','QUEUED','PROCESSING','READY','FAILED','NEEDS_REVIEW')),
  capture_mode text not null default 'MEET_CAPTIONS' check (capture_mode in ('MEET_CAPTIONS','GOOGLE_NATIVE','LOCAL_AUDIO_FALLBACK','HYBRID')),
  native_transcript_available boolean not null default false,
  captions_available boolean not null default true,
  transcript_id bigint references agency_ops.meeting_transcripts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, local_session_id)
);

alter table agency_ops.meeting_transcripts
  drop constraint if exists meeting_transcripts_capture_session_id_fkey;
alter table agency_ops.meeting_transcripts
  add constraint meeting_transcripts_capture_session_id_fkey
  foreign key (capture_session_id) references agency_ops.meeting_capture_sessions(id) on delete set null;

create unique index if not exists meeting_transcripts_capture_session_uidx
  on agency_ops.meeting_transcripts(capture_session_id)
  where capture_session_id is not null;
create index if not exists meeting_transcripts_owner_started_idx
  on agency_ops.meeting_transcripts(owner_person, meeting_started_at desc)
  where owner_person is not null;

create table if not exists agency_ops.meeting_capture_participants (
  id bigserial primary key,
  session_id uuid not null references agency_ops.meeting_capture_sessions(id) on delete cascade,
  participant_key text not null,
  google_user_id text,
  display_name text not null,
  email text,
  joined_at timestamptz,
  left_at timestamptz,
  source text not null default 'CAPTIONS',
  identity_confidence numeric,
  collaborator_person text,
  client_id uuid references agency_ops.clients(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, participant_key)
);

create index if not exists meeting_capture_participants_google_idx
  on agency_ops.meeting_capture_participants(google_user_id)
  where google_user_id is not null;
create index if not exists meeting_capture_participants_client_idx
  on agency_ops.meeting_capture_participants(client_id)
  where client_id is not null;

create table if not exists agency_ops.meeting_transcript_segments (
  id bigserial primary key,
  transcript_id bigint not null references agency_ops.meeting_transcripts(id) on delete cascade,
  session_id uuid not null references agency_ops.meeting_capture_sessions(id) on delete cascade,
  sequence_no integer not null,
  started_ms integer,
  ended_ms integer,
  speaker_key text,
  speaker_name text,
  text text not null,
  confidence numeric,
  source text not null default 'MEET_CAPTIONS',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, sequence_no)
);

create index if not exists meeting_transcript_segments_transcript_idx
  on agency_ops.meeting_transcript_segments(transcript_id, sequence_no);
create index if not exists meeting_transcript_segments_speaker_idx
  on agency_ops.meeting_transcript_segments(session_id, speaker_key)
  where speaker_key is not null;

alter table agency_ops.meeting_capture_devices enable row level security;
alter table agency_ops.meeting_capture_pairings enable row level security;
alter table agency_ops.meeting_capture_sessions enable row level security;
alter table agency_ops.meeting_capture_participants enable row level security;
alter table agency_ops.meeting_transcript_segments enable row level security;

revoke all on agency_ops.meeting_capture_devices from public, anon, authenticated;
revoke all on agency_ops.meeting_capture_pairings from public, anon, authenticated;
revoke all on agency_ops.meeting_capture_sessions from public, anon, authenticated;
revoke all on agency_ops.meeting_capture_participants from public, anon, authenticated;
revoke all on agency_ops.meeting_transcript_segments from public, anon, authenticated;
grant select,insert,update,delete on agency_ops.meeting_capture_devices to service_role;
grant select,insert,update,delete on agency_ops.meeting_capture_pairings to service_role;
grant select,insert,update,delete on agency_ops.meeting_capture_sessions to service_role;
grant select,insert,update,delete on agency_ops.meeting_capture_participants to service_role;
grant select,insert,update,delete on agency_ops.meeting_transcript_segments to service_role;
grant usage,select on sequence agency_ops.meeting_capture_participants_id_seq to service_role;
grant usage,select on sequence agency_ops.meeting_transcript_segments_id_seq to service_role;

insert into agency_ops.worker_runtime_config(key,value)
values ('meeting_postprocess', '{"mode":"off","poll_ms":5000,"whisper_fallback":"local_only","native_google_bonus":true}'::jsonb)
on conflict (key) do nothing;
