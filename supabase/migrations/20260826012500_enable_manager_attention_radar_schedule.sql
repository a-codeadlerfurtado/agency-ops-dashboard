create or replace function agency_ops.invoke_manager_attention_radar(p_slot text)
returns bigint
language plpgsql
security definer
set search_path = agency_ops, public, extensions, net
as $$
declare
  v_key text;
  v_request_id bigint;
begin
  select value #>> '{}'
    into v_key
  from agency_ops.automation_settings
  where key = 'MANAGER_RADAR_CRON_SECRET';

  if coalesce(v_key, '') = '' then
    raise exception 'MANAGER_RADAR_CRON_SECRET is not configured';
  end if;

  select net.http_get(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-manager-attention-radar?slot=' || replace(p_slot, ':', '%3A'),
    headers := jsonb_build_object('x-manager-radar-key', v_key),
    timeout_milliseconds := 10000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function agency_ops.invoke_manager_attention_radar(text) from public;

do $$
declare
  r record;
begin
  for r in
    select jobid
    from cron.job
    where jobname in (
      'agency_ops_manager_radar_1100',
      'agency_ops_manager_radar_1500',
      'agency_ops_manager_radar_1700',
      'agency_ops_manager_radar_1840'
    )
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

select cron.schedule(
  'agency_ops_manager_radar_1100',
  '0 11 * * *',
  $$select agency_ops.invoke_manager_attention_radar('11:00');$$
);
select cron.schedule(
  'agency_ops_manager_radar_1500',
  '0 15 * * *',
  $$select agency_ops.invoke_manager_attention_radar('15:00');$$
);
select cron.schedule(
  'agency_ops_manager_radar_1700',
  '0 17 * * *',
  $$select agency_ops.invoke_manager_attention_radar('17:00');$$
);
select cron.schedule(
  'agency_ops_manager_radar_1840',
  '40 18 * * *',
  $$select agency_ops.invoke_manager_attention_radar('18:40');$$
);