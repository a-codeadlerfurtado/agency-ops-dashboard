-- Dedicated internal authentication for Calendar watch maintenance.
-- This avoids coupling pg_cron to the platform service-role JWT while keeping
-- the public Google webhook endpoint unauthenticated only at the transport layer.

create table if not exists agency_ops.google_calendar_watch_runtime (
  singleton boolean primary key default true check (singleton),
  request_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into agency_ops.google_calendar_watch_runtime(singleton,request_token)
values (
  true,
  replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
)
on conflict(singleton) do nothing;

alter table agency_ops.google_calendar_watch_runtime enable row level security;
revoke all on agency_ops.google_calendar_watch_runtime from public, anon, authenticated;
grant select,insert,update,delete on agency_ops.google_calendar_watch_runtime to service_role;

create or replace function agency_ops.invoke_google_calendar_watch_renewal()
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public','net','vault'
as $function$
declare
  v_url text;
  v_request_token text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name='projeto_url'
   order by created_at desc
   limit 1;

  select request_token into v_request_token
    from agency_ops.google_calendar_watch_runtime
   where singleton=true;

  if nullif(v_url,'') is null or nullif(v_request_token,'') is null then
    raise exception 'google_calendar_watch_runtime_secret_missing';
  end if;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/agency-ops-google-calendar-watch',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-google-calendar-watch-key',v_request_token
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
