-- Imobi-Board 0028 - conectar por token de usuario de sistema da BM
--
-- Caminho alternativo ao login (0027), e o unico que funciona ANTES do App
-- Review da Meta.
--
-- Por que funciona sem App Review: a Meta so exige revisao para usar uma
-- permissao em nome de quem NAO tem papel no aplicativo. Um usuario de
-- sistema criado na mesma BM do app pode receber papel nele, e nesse caso
-- `leads_retrieval` vale sem revisao. E o arranjo classico de agencia: as
-- paginas dos clientes ja estao compartilhadas na BM.
--
-- O que ele NAO resolve: cliente que nao esta na sua BM. Para auto-servico
-- de terceiro continua sendo preciso App Review + Login for Business.
--
-- O token fica por tenant, e nao global, de proposito: assim uma imobiliaria
-- pode usar a BM da agencia e outra a propria, sem trocar codigo.

create table if not exists imobi_board.meta_tokens_de_sistema (
  tenant_id     uuid primary key references imobi_board.tenants(id) on delete cascade,
  token         text not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references auth.users(id) on delete set null
);
alter table imobi_board.meta_tokens_de_sistema enable row level security;
-- sem policy: o token so e lido pelo worker, via RPC de service_role

comment on table imobi_board.meta_tokens_de_sistema is
  'Token de usuario de sistema da Business Manager. Nao expira e da acesso a '
  'todas as paginas atribuidas aquele usuario -- por isso nunca volta para o '
  'navegador em nenhuma leitura.';

/* Guarda o token e devolve o state que autoriza o worker a ir buscar as
   paginas. O token entra por RPC (HTTPS ate o banco) e nao passa por lugar
   nenhum do bundle. */
create or replace function imobi_board.salvar_token_de_sistema(p_token text)
returns text
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_tenant uuid; v_state text;
begin
  select m.tenant_id into v_tenant from imobi_board.memberships m
  where m.user_id = v_uid and m.status='ACTIVE' and m.role='ADMIN' limit 1;
  if v_tenant is null then
    raise exception 'Apenas o administrador conecta integracoes.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'Token vazio.' using errcode = 'P0001';
  end if;

  insert into imobi_board.meta_tokens_de_sistema (tenant_id, token, atualizado_por)
  values (v_tenant, btrim(p_token), v_uid)
  on conflict (tenant_id) do update
    set token = excluded.token, atualizado_em = now(), atualizado_por = excluded.atualizado_por;

  v_state := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.meta_estados (state, tenant_id, user_id, finalidade)
  values (v_state, v_tenant, v_uid, 'SISTEMA');
  return v_state;
end;
$fn$;

/* Lido pelo worker. NAO consome o state: quem consome e
   salvar_paginas_da_meta, logo depois, com a lista ja em maos. */
create or replace function imobi_board.token_de_sistema(p_state text)
returns text
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_e imobi_board.meta_estados%rowtype;
begin
  select * into v_e from imobi_board.meta_estados
  where state = p_state and finalidade = 'SISTEMA'
    and used_at is null and expires_at > now();
  if not found then
    raise exception 'Autorizacao expirada.' using errcode = 'P0001';
  end if;
  return (select token from imobi_board.meta_tokens_de_sistema where tenant_id = v_e.tenant_id);
end;
$fn$;

/* A tela so precisa saber se existe token e de quando e. */
create or replace function imobi_board.situacao_do_token_de_sistema()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(
    (select jsonb_build_object('tem', true, 'atualizado_em', t.atualizado_em)
     from imobi_board.meta_tokens_de_sistema t
     where t.tenant_id in (
       select m.tenant_id from imobi_board.memberships m
       where m.user_id = (select auth.uid()) and m.status='ACTIVE' and m.role='ADMIN'
     )),
    jsonb_build_object('tem', false)
  );
$fn$;

revoke execute on function imobi_board.salvar_token_de_sistema(text) from public;
revoke execute on function imobi_board.token_de_sistema(text) from public;
revoke execute on function imobi_board.situacao_do_token_de_sistema() from public;

grant execute on function imobi_board.salvar_token_de_sistema(text) to authenticated;
grant execute on function imobi_board.situacao_do_token_de_sistema() to authenticated;
grant execute on function imobi_board.token_de_sistema(text) to service_role;
