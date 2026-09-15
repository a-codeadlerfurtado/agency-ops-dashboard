create or replace function agency_ops.get_meta_system_user_token()
returns text
language sql
security definer
set search_path = vault, pg_catalog
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'META_SYSTEM_USER_TOKEN'
  order by updated_at desc
  limit 1;
$$;

revoke all on function agency_ops.get_meta_system_user_token() from public, anon, authenticated;
grant execute on function agency_ops.get_meta_system_user_token() to service_role;
