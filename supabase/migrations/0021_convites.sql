-- Imobi-Board 0021 - convite de corretor (spec 26)
--
-- Ate aqui o ADMIN nao tinha como colocar ninguem no time: criar usuario
-- exigia o painel do Supabase. Nao da para resolver com trigger em auth.users
-- (compartilhada com os outros sistemas do projeto), entao o desenho e:
--
--   ADMIN cria o convite  ->  pessoa abre o link e se cadastra  ->
--   ela mesma chama aceitar_convite(token), que cria profile + membership.
--
-- O convite guarda o e-mail: quem se cadastrar com OUTRO e-mail nao consegue
-- usar o link, mesmo tendo o token.

create table imobi_board.invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references imobi_board.tenants(id) on delete cascade,
  email       text not null,
  role        imobi_board.member_role not null default 'BROKER',
  token       text not null unique,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz
);
-- um convite pendente por e-mail e tenant: reconvidar substitui, nao acumula
create unique index invites_pendente_uq
  on imobi_board.invites (tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index invites_token_idx on imobi_board.invites (token);

alter table imobi_board.invites enable row level security;
grant select on imobi_board.invites to authenticated;

-- ADMIN ve os convites do proprio tenant. O token NAO e lido por policy:
-- quem cria recebe uma vez, na resposta da RPC.
create policy invites_admin_select on imobi_board.invites
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create or replace function imobi_board.convidar_membro(
  p_email text,
  p_role  imobi_board.member_role default 'BROKER',
  p_tenant_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_email  text := imobi_board_priv.normalize_email(p_email);
  v_token  text;
begin
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail invalido.' using errcode = 'P0001';
  end if;

  select coalesce(p_tenant_id, m.tenant_id) into v_tenant
  from imobi_board.memberships m
  where m.user_id = v_uid and m.status = 'ACTIVE' and m.role = 'ADMIN'
    and (p_tenant_id is null or m.tenant_id = p_tenant_id)
  limit 1;

  if v_tenant is null then
    raise exception 'Apenas o administrador convida.' using errcode = '42501';
  end if;

  if exists (
    select 1 from imobi_board.memberships m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = v_tenant and lower(u.email) = v_email
  ) then
    raise exception 'Essa pessoa ja esta na equipe.' using errcode = 'P0001';
  end if;

  -- reconvidar substitui o pendente em vez de empilhar
  delete from imobi_board.invites
   where tenant_id = v_tenant and email = v_email
     and accepted_at is null and revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into imobi_board.invites (tenant_id, email, role, token, created_by)
  values (v_tenant, v_email, p_role, v_token, v_uid);

  perform imobi_board_priv.emit_event(
    v_tenant, 'invite.created', 'invite', v_uid,
    jsonb_build_object('email', v_email, 'role', p_role));

  -- o token so aparece aqui, uma vez
  return jsonb_build_object('token', v_token, 'email', v_email, 'role', p_role);
end;
$fn$;

create or replace function imobi_board.revogar_convite(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_t uuid;
begin
  select tenant_id into v_t from imobi_board.invites where id = p_id;
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_t
                   and m.status = 'ACTIVE' and m.role = 'ADMIN') then
    raise exception 'Apenas o administrador revoga convites.' using errcode = '42501';
  end if;
  update imobi_board.invites set revoked_at = now()
   where id = p_id and accepted_at is null;
end;
$fn$;

-- Chamada pela PESSOA convidada, ja autenticada. Nao exige ser ADMIN: exige
-- que o e-mail da sessao seja o mesmo do convite.
create or replace function imobi_board.aceitar_convite(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_c     imobi_board.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'Entre na sua conta para aceitar o convite.' using errcode = '28000';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into v_c from imobi_board.invites where token = p_token for update;
  if not found then
    raise exception 'Convite nao encontrado.' using errcode = 'P0002';
  end if;
  if v_c.revoked_at is not null then
    raise exception 'Convite revogado.' using errcode = 'P0001';
  end if;
  if v_c.accepted_at is not null then
    raise exception 'Convite ja utilizado.' using errcode = 'P0001';
  end if;
  if v_c.expires_at < now() then
    raise exception 'Convite expirado. Peca outro ao administrador.' using errcode = 'P0001';
  end if;
  if v_email is distinct from v_c.email then
    raise exception 'Este convite foi enviado para outro e-mail.' using errcode = '42501';
  end if;

  insert into imobi_board.profiles (id, full_name)
  select v_uid, u.raw_user_meta_data ->> 'full_name'
  from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  insert into imobi_board.memberships (tenant_id, user_id, role)
  values (v_c.tenant_id, v_uid, v_c.role)
  on conflict (tenant_id, user_id) do update set status = 'ACTIVE';

  update imobi_board.invites
     set accepted_at = now(), accepted_by = v_uid
   where id = v_c.id;

  perform imobi_board_priv.emit_event(
    v_c.tenant_id, 'invite.accepted', 'membership', v_uid,
    jsonb_build_object('role', v_c.role));

  return jsonb_build_object(
    'tenant_id', v_c.tenant_id,
    'role', v_c.role,
    'tenant', (select name from imobi_board.tenants where id = v_c.tenant_id));
end;
$fn$;

-- Só para a tela do convite mostrar de quem é, antes de a pessoa entrar.
-- Devolve o mínimo: nome da imobiliária e o e-mail convidado. Sem token,
-- sem id, e nada se o convite não valer mais.
--
-- ATENCAO: o grant a `anon` na ultima linha e revertido pela migration 0022.
-- Ver o comentario la: dar EXECUTE ao anon sem USAGE no schema nao funciona,
-- e conceder o USAGE quebraria a garantia de superficie zero sem sessao.
create or replace function imobi_board.convite_publico(p_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select jsonb_build_object(
    'email', i.email,
    'role', i.role,
    'tenant', t.name,
    'valido', i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  )
  from imobi_board.invites i
  join imobi_board.tenants t on t.id = i.tenant_id
  where i.token = p_token;
$fn$;

revoke execute on function imobi_board.convidar_membro(text, imobi_board.member_role, uuid) from public;
revoke execute on function imobi_board.revogar_convite(uuid) from public;
revoke execute on function imobi_board.aceitar_convite(text) from public;
revoke execute on function imobi_board.convite_publico(text) from public;

grant execute on function imobi_board.convidar_membro(text, imobi_board.member_role, uuid) to authenticated;
grant execute on function imobi_board.revogar_convite(uuid) to authenticated;
grant execute on function imobi_board.aceitar_convite(text) to authenticated;
-- a tela do convite abre antes do login: anon precisa ler o cabecalho
grant execute on function imobi_board.convite_publico(text) to anon, authenticated;
