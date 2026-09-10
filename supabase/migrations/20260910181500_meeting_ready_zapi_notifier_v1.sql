insert into agency_ops.meeting_integration_providers(provider_key,label,category,auth_mode,capabilities,metadata)
values ('ZAPI_NOTIFIER','Z-API Notificações','MESSAGING','INTERNAL','["MEETING_READY_NOTIFY"]'::jsonb,'{"scope":"internal_notifications_only","connected_phone":"13997811685","may_read_whatsapp":false,"may_send_user_messages":false}'::jsonb)
on conflict (provider_key) do update set
  label=excluded.label,
  category=excluded.category,
  auth_mode=excluded.auth_mode,
  capabilities=excluded.capabilities,
  metadata=excluded.metadata,
  enabled=true,
  updated_at=now();

create table if not exists agency_ops.meeting_ready_notifications (
  id uuid primary key default gen_random_uuid(),
  transcript_id bigint not null references agency_ops.meeting_transcripts(id) on delete cascade,
  owner_person text not null,
  recipient_phone text,
  channel text not null default 'ZAPI' check (channel in ('ZAPI')),
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  attempts integer not null default 0,
  last_error text,
  provider_key text not null default 'ZAPI_NOTIFIER',
  message_text text,
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(transcript_id,channel)
);
create index if not exists meeting_ready_notifications_pending_idx
  on agency_ops.meeting_ready_notifications(status,next_attempt_at)
  where status in ('PENDING','FAILED');

alter table agency_ops.meeting_ready_notifications enable row level security;
revoke all on agency_ops.meeting_ready_notifications from public, anon, authenticated;
grant select,insert,update,delete on agency_ops.meeting_ready_notifications to service_role;

insert into agency_ops.worker_runtime_config(key,value,updated_at)
values ('meeting_notifications','{"mode":"off","channel":"ZAPI","provider_key":"ZAPI_NOTIFIER","sender_phone":"13997811685","notify_owner":true,"max_attempts":5}'::jsonb,now())
on conflict (key) do update set value=agency_ops.worker_runtime_config.value || excluded.value, updated_at=now();