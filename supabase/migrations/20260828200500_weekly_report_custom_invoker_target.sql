-- Keep production and repository aligned: exact-range reports use their dedicated worker.
create or replace function agency_ops.invoke_weekly_client_reports_custom(
  p_date_from date,
  p_date_to date,
  p_scope_type text default 'ALL',
  p_scope_value text default null,
  p_requested_by text default null
)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $$
declare
  v_secret text;
  v_request_id bigint;
  v_scope text := upper(coalesce(nullif(trim(p_scope_type),''),'ALL'));
begin
  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then raise exception 'invalid report period'; end if;
  if p_date_to >= (now() at time zone 'America/Sao_Paulo')::date then raise exception 'report period must end before today'; end if;
  if v_scope not in ('ALL','GT','CLIENT') then raise exception 'invalid report scope'; end if;
  v_secret := agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET');
  if v_secret is null or length(trim(v_secret)) < 20 then raise exception 'META_CAMPAIGN_SYNC_SECRET missing from Vault'; end if;
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-weekly-client-reports-custom',
    headers := jsonb_build_object('Content-Type','application/json','x-meta-campaign-secret',v_secret),
    body := jsonb_build_object('mode','start','date_from',p_date_from,'date_to',p_date_to,'scope_type',v_scope,'scope_value',p_scope_value,'requested_by',p_requested_by),
    timeout_milliseconds := 120000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function agency_ops.invoke_weekly_client_reports_custom(date,date,text,text,text) from public;
