create table if not exists agency_ops.drive_change_watch_state (
  account_key text primary key,
  root_folder_id text not null,
  page_token text,
  channel_id text,
  resource_id text,
  channel_expires_at timestamptz,
  last_notification_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  status text not null default 'UNCONFIGURED' check (status in ('UNCONFIGURED','ACTIVE','EXPIRED','ERROR')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.drive_change_watch_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  channel_id text,
  resource_state text,
  resource_id text,
  message_number bigint,
  processed_at timestamptz,
  changes_count integer not null default 0,
  ingested_count integer not null default 0,
  skipped_count integer not null default 0,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_drive_change_watch_events_received_at
  on agency_ops.drive_change_watch_events(received_at desc);

alter table agency_ops.drive_change_watch_state enable row level security;
alter table agency_ops.drive_change_watch_events enable row level security;
revoke all on agency_ops.drive_change_watch_state from public, anon, authenticated;
revoke all on agency_ops.drive_change_watch_events from public, anon, authenticated;
grant all on agency_ops.drive_change_watch_state to service_role;
grant all on agency_ops.drive_change_watch_events to service_role;
grant usage, select on sequence agency_ops.drive_change_watch_events_id_seq to service_role;

insert into agency_ops.drive_change_watch_state(account_key, root_folder_id, status, metadata)
values ('lakassessoriadigital', '1-FIIyg51Wbe5GbMXagDcB6XxWhKmdY9A', 'UNCONFIGURED', jsonb_build_object('provider','GOOGLE_DRIVE_CHANGES_WATCH','replaces_make_scenario_id',4880887))
on conflict (account_key) do update set
  root_folder_id=excluded.root_folder_id,
  metadata=coalesce(agency_ops.drive_change_watch_state.metadata,'{}'::jsonb) || excluded.metadata,
  updated_at=now();

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name='drive_change_channel_token') then
    perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'drive_change_channel_token','Token privado enviado pelo Google Drive em X-Goog-Channel-Token',null);
  end if;
end $$;
