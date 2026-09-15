-- Imobi-Board 0039 - convite emitido pelo console central
--
-- convidar_membro() exige que quem chama seja ADMIN da imobiliaria, e le isso
-- de auth.uid(). O console central roda com chave de servico e nao tem sessao
-- de usuario: auth.uid() e nulo e a funcao recusa, corretamente.
--
-- Em vez de afrouxar a regra da tela -- que protege o caso comum -- o console
-- ganha a propria porta, fechada para todo mundo menos service_role. Quem
-- decide se o chamador pode e a Edge Function, que ja confere que o ator e o
-- Adler com papel MGMT e exige a senha do dashboard.
--
-- Registra quem emitiu no lugar de created_by, que aponta para auth.users e
-- aqui seria sempre nulo.

create or replace function imobi_board.convidar_pelo_console(
  p_tenant uuid,
  p_email  text,
  p_papel  imobi_board.member_role,
  p_por    text
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_email text := imobi_board_priv.normalize_email(p_email);
  v_token text;
  v_id    uuid;
begin
  if not exists (select 1 from imobi_board.tenants t where t.id = p_tenant) then
    raise exception 'Imobiliaria nao existe.' using errcode = 'P0001';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail invalido.' using errcode = 'P0001';
  end if;

  -- ja e membro: convidar de novo nao ajuda ninguem e confunde quem recebe
  if exists (
    select 1 from imobi_board.memberships m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant and lower(u.email) = v_email and m.status = 'ACTIVE'
  ) then
    raise exception 'Essa pessoa ja faz parte desta imobiliaria.' using errcode = 'P0001';
  end if;

  -- convite pendente e reaproveitado em vez de empilhar dois links validos
  select i.id, i.token into v_id, v_token
    from imobi_board.invites i
   where i.tenant_id = p_tenant and i.email = v_email
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
   limit 1;

  if v_id is null then
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    insert into imobi_board.invites (tenant_id, email, role, token)
    values (p_tenant, v_email, p_papel, v_token)
    returning id into v_id;
  end if;

  perform imobi_board_priv.emit_event(
    p_tenant, 'invite.console', 'invite', v_id,
    jsonb_build_object('email', v_email, 'papel', p_papel, 'por', p_por));

  return jsonb_build_object(
    'invite_id', v_id, 'email', v_email, 'papel', p_papel, 'token', v_token,
    'expira_em', (select i.expires_at from imobi_board.invites i where i.id = v_id));
end;
$fn$;

revoke execute on function imobi_board.convidar_pelo_console(uuid, text, imobi_board.member_role, text)
  from public, authenticated;
grant execute on function imobi_board.convidar_pelo_console(uuid, text, imobi_board.member_role, text)
  to service_role;

/* Ligar uma imobiliaria ao cliente do Agency Ops, para o acesso saber em qual
   cofre entra. */
create or replace function imobi_board.ligar_ao_cliente(
  p_tenant uuid,
  p_cliente uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare v_nome text;
begin
  if p_cliente is not null
     and not exists (select 1 from agency_ops.clients c where c.id = p_cliente) then
    raise exception 'Cliente nao existe no Agency Ops.' using errcode = 'P0001';
  end if;

  update imobi_board.tenants t set agency_client_id = p_cliente where t.id = p_tenant;
  if not found then
    raise exception 'Imobiliaria nao existe.' using errcode = 'P0001';
  end if;

  select c.display_name into v_nome from agency_ops.clients c where c.id = p_cliente;
  return jsonb_build_object('tenant_id', p_tenant, 'agency_client_id', p_cliente, 'cliente', v_nome);
end;
$fn$;

revoke execute on function imobi_board.ligar_ao_cliente(uuid, uuid) from public, authenticated;
grant execute on function imobi_board.ligar_ao_cliente(uuid, uuid) to service_role;
