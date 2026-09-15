create or replace function agency_ops.invoke_meta_account_campaign_probe(p_terms text[])
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_req bigint;
begin
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/meta-account-campaign-probe',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-meta-campaign-secret', agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET')
    ),
    body := jsonb_build_object('terms', to_jsonb(p_terms)),
    timeout_milliseconds := 120000
  ) into v_req;
  return v_req;
end;
$$;

revoke all on function agency_ops.invoke_meta_account_campaign_probe(text[]) from public, anon, authenticated;
grant execute on function agency_ops.invoke_meta_account_campaign_probe(text[]) to service_role;
