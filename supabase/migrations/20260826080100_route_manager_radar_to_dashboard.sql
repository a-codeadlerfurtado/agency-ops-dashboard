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
  select value #>> '{}' into v_key
  from agency_ops.automation_settings
  where key = 'MANAGER_RADAR_CRON_SECRET';

  if coalesce(v_key, '') = '' then
    raise exception 'MANAGER_RADAR_CRON_SECRET is not configured';
  end if;

  select net.http_get(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-manager-attention-dashboard?slot=' || replace(p_slot, ':', '%3A'),
    headers := jsonb_build_object('x-manager-radar-key', v_key),
    timeout_milliseconds := 10000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function agency_ops.invoke_manager_attention_radar(text) from public;