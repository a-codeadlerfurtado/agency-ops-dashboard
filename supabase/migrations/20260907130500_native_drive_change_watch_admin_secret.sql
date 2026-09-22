do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name='drive_change_admin_token') then
    perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'drive_change_admin_token','Token administrativo privado do Drive changes.watch',null);
  end if;
end $$;
