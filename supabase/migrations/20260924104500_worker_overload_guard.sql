create table if not exists agency_ops.worker_dispatch_guard (
  worker text primary key,
  last_dispatched_at timestamptz,
  next_allowed_at timestamptz not null default '-infinity'::timestamptz,
  updated_at timestamptz not null default now()
);

revoke all on agency_ops.worker_dispatch_guard from public, anon, authenticated;
grant select, insert, update on agency_ops.worker_dispatch_guard to service_role;

create or replace function agency_ops.try_worker_dispatch(
  p_worker text,
  p_cooldown_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = agency_ops, pg_catalog
as $$
declare
  v_changed integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(trim(p_worker),'') = '' then return false; end if;
  p_cooldown_seconds := greatest(1, least(coalesce(p_cooldown_seconds,30),3600));
  insert into agency_ops.worker_dispatch_guard(worker,last_dispatched_at,next_allowed_at,updated_at)
  values(p_worker,v_now,v_now + make_interval(secs => p_cooldown_seconds),v_now)
  on conflict(worker) do update
    set last_dispatched_at = excluded.last_dispatched_at,
        next_allowed_at = excluded.next_allowed_at,
        updated_at = excluded.updated_at
  where agency_ops.worker_dispatch_guard.next_allowed_at <= v_now;

  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

revoke all on function agency_ops.try_worker_dispatch(text,integer) from public, anon, authenticated;
grant execute on function agency_ops.try_worker_dispatch(text,integer) to service_role;

create or replace function agency_ops.process_operational_queue_serialized(p_limit integer default 1)
returns integer
language plpgsql
security definer
set search_path = agency_ops, pg_catalog
as $$
begin
  if not pg_try_advisory_xact_lock(20260924,2401) then return 0; end if;
  return agency_ops.process_operational_queue(greatest(1,least(coalesce(p_limit,1),1)));
end;
$$;
revoke all on function agency_ops.process_operational_queue_serialized(integer) from public, anon, authenticated;
grant execute on function agency_ops.process_operational_queue_serialized(integer) to service_role;

create or replace function agency_ops.request_whatsapp_identity_sync(p_action text, p_chat_id text default null::text)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops', 'pg_catalog', 'extensions'
as $$
declare
  v_req bigint;
  v_token text;
  v_body jsonb := jsonb_build_object('action',p_action);
  v_timeout integer := case when p_action='sync_all' then 90000 when p_action='sync_batch' then 45000 else 25000 end;
  v_slug text := case when p_action='sync_all' then 'agency-ops-whatsapp-identity-sync-all' else 'agency-ops-whatsapp-identity-sync' end;
  v_scope text;
begin
  v_scope := case
    when p_action in ('sync_all','sync_batch') then 'whatsapp_identity_batch'
    else 'whatsapp_identity_group:'||coalesce(p_chat_id,'unknown')
  end;

  if not agency_ops.try_worker_dispatch('whatsapp_identity_global',30) then return null; end if;
  if not agency_ops.try_worker_dispatch(v_scope,case when p_action in ('sync_all','sync_batch') then 300 else 90 end) then return null; end if;

  select request_token into v_token from agency_ops.whatsapp_identity_sync_runtime where singleton=true;
  if coalesce(length(v_token),0) < 32 then return null; end if;
  if p_chat_id is not null then v_body := v_body || jsonb_build_object('chat_id',p_chat_id); end if;

  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/'||v_slug,
    headers := jsonb_build_object('Content-Type','application/json','x-automation-secret',v_token),
    body := v_body,
    timeout_milliseconds := v_timeout
  ) into v_req;
  return v_req;
exception when others then return null;
end;
$$;

create or replace function agency_ops.wake_semantic_queue_worker()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public', 'net', 'pg_catalog'
as $$
declare
  v_secret text;
begin
  if new.status not in ('PENDING','ERROR') then return new; end if;
  if not agency_ops.try_worker_dispatch('semantic_queue_wake',30) then return new; end if;

  select value #>> '{}' into v_secret
  from agency_ops.automation_settings
  where key='SEMANTIC_QUEUE_WORKER_SECRET';
  if coalesce(length(v_secret),0) >= 32 then
    perform net.http_post(
      url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-semantic-queue-worker',
      headers := jsonb_build_object('Content-Type','application/json','x-semantic-worker-key',v_secret),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  end if;
  return new;
end;
$$;

create or replace function agency_ops.invoke_ad_radar_worker()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'agency_ops', 'net', 'vault'
as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  if not agency_ops.try_worker_dispatch('ad_radar_worker',120) then return null; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='projeto_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='service_role_key' limit 1;
  if nullif(v_url,'') is null or nullif(v_key,'') is null then raise exception 'ad_radar_worker_secrets_missing'; end if;
  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/agency-ops-ad-radar-worker',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 70000
  ) into v_request;
  return v_request;
end;
$$;

create or replace function agency_ops.invoke_meta_balance_sync()
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops', 'extensions', 'public', 'pg_catalog'
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  if not agency_ops.try_worker_dispatch('meta_balance_sync',600) then return null; end if;
  v_secret := agency_ops.get_internal_secret('META_BALANCE_SYNC_SECRET');
  if v_secret is null or length(trim(v_secret)) < 20 then raise exception 'META_BALANCE_SYNC_SECRET missing from Vault'; end if;
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/meta-balance-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-meta-balance-secret',v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  ) into v_request_id;
  return v_request_id;
end;
$$;

select cron.alter_job(168, schedule := '*/10 * * * *');
select cron.alter_job(219, schedule := '*/10 * * * *');
select cron.alter_job(220, schedule := '*/10 * * * *');
