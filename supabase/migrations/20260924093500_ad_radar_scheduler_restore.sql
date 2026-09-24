-- Radar de Anuncios: restore durable scheduler through a protected database invoker.

create or replace function agency_ops.invoke_ad_radar_worker()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops, net, vault
as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name='projeto_url'
  limit 1;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name='service_role_key'
  limit 1;

  if nullif(v_url,'') is null or nullif(v_key,'') is null then
    raise exception 'ad_radar_worker_secrets_missing';
  end if;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/agency-ops-ad-radar-worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 95000
  )
  into v_request;

  return v_request;
end;
$$;

revoke all on function agency_ops.invoke_ad_radar_worker() from public, anon, authenticated;
grant execute on function agency_ops.invoke_ad_radar_worker() to service_role;

do $$
declare
  v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='ad-radar-worker-v1' limit 1;
  if v_job is not null then
    perform cron.unschedule(v_job);
  end if;
end $$;

select cron.schedule(
  'ad-radar-worker-v1',
  '*/5 * * * *',
  $cron$select agency_ops.invoke_ad_radar_worker();$cron$
);
