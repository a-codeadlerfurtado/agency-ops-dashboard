-- Google Calendar push notifications for Adler's primary onboarding calendar.
-- The Calendar itself is not polled by cron. pg_cron only renews the expiring
-- Google watch channel every six hours when needed; event changes arrive by webhook.

create table if not exists agency_ops.google_calendar_watches (
  account_id uuid primary key references agency_ops.meeting_integration_accounts(id) on delete cascade,
  owner_person text not null,
  calendar_id text not null default 'primary',
  channel_id text not null unique,
  resource_id text not null,
  resource_uri text,
  channel_token_hash text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ERROR','STOPPED')),
  expires_at timestamptz not null,
  first_started_at timestamptz not null default now(),
  last_renewed_at timestamptz not null default now(),
  last_change_scan_at timestamptz,
  last_message_number bigint not null default 0,
  last_resource_state text,
  last_webhook_at timestamptz,
  last_scan_reason text,
  last_scan_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.google_calendar_event_state (
  account_id uuid not null references agency_ops.meeting_integration_accounts(id) on delete cascade,
  event_id text not null,
  title text,
  status text,
  event_type text,
  creator_email text,
  creator_name text,
  organizer_email text,
  start_time timestamptz,
  end_time timestamptz,
  all_day boolean not null default false,
  created_at_google timestamptz,
  updated_at_google timestamptz,
  attendees jsonb not null default '[]'::jsonb,
  meet_url text,
  html_link text,
  raw_event jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (account_id,event_id)
);
create index if not exists google_calendar_event_state_creator_idx
  on agency_ops.google_calendar_event_state(account_id,creator_email);
create index if not exists google_calendar_event_state_start_idx
  on agency_ops.google_calendar_event_state(start_time);

create table if not exists agency_ops.google_calendar_alerts (
  dedupe_key text primary key,
  account_id uuid not null references agency_ops.meeting_integration_accounts(id) on delete cascade,
  event_id text not null,
  change_type text not null check (change_type in ('CREATED','RESCHEDULED','CANCELLED')),
  google_updated_at timestamptz,
  platform_notification_id uuid references agency_ops.platform_notifications(id) on delete set null,
  recipient_phone text,
  whatsapp_message_text text,
  whatsapp_status text not null default 'PENDING' check (whatsapp_status in ('PENDING','SENT','FAILED','SKIPPED')),
  whatsapp_message_id text,
  whatsapp_error text,
  attempts integer not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists google_calendar_alerts_event_idx
  on agency_ops.google_calendar_alerts(account_id,event_id,created_at desc);
create index if not exists google_calendar_alerts_whatsapp_idx
  on agency_ops.google_calendar_alerts(whatsapp_status,created_at desc);

alter table agency_ops.google_calendar_watches enable row level security;
alter table agency_ops.google_calendar_event_state enable row level security;
alter table agency_ops.google_calendar_alerts enable row level security;

revoke all on agency_ops.google_calendar_watches from public, anon, authenticated;
revoke all on agency_ops.google_calendar_event_state from public, anon, authenticated;
revoke all on agency_ops.google_calendar_alerts from public, anon, authenticated;

grant select,insert,update,delete on agency_ops.google_calendar_watches to service_role;
grant select,insert,update,delete on agency_ops.google_calendar_event_state to service_role;
grant select,insert,update,delete on agency_ops.google_calendar_alerts to service_role;

create or replace function agency_ops.invoke_google_calendar_watch_renewal()
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public','net','vault'
as $function$
declare
  v_url text;
  v_service_role text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name='projeto_url'
   order by created_at desc
   limit 1;

  select decrypted_secret into v_service_role
    from vault.decrypted_secrets
   where name='service_role_key'
   order by created_at desc
   limit 1;

  if nullif(v_url,'') is null or nullif(v_service_role,'') is null then
    raise exception 'google_calendar_watch_runtime_secret_missing';
  end if;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/agency-ops-google-calendar-watch',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || v_service_role
    ),
    body := jsonb_build_object(
      'action','ensure_watch',
      'owner_person','Adler Furtado',
      'force',false
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

revoke all on function agency_ops.invoke_google_calendar_watch_renewal() from public, anon, authenticated;
grant execute on function agency_ops.invoke_google_calendar_watch_renewal() to service_role;

do $do$
declare
  r record;
begin
  for r in select jobid from cron.job where jobname='google-calendar-adler-watch-renewal'
  loop
    perform cron.unschedule(r.jobid);
  end loop;

  perform cron.schedule(
    'google-calendar-adler-watch-renewal',
    '23 */6 * * *',
    $cron$select agency_ops.invoke_google_calendar_watch_renewal();$cron$
  );
end
$do$;
