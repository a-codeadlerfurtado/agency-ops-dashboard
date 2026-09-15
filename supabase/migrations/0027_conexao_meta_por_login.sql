-- Imobi-Board 0027 - conectar a Meta por login, sem copiar token
--
-- O que muda em relacao a 0025: la a pessoa copiava URL e token na mao. Aqui
-- ela clica em "Conectar conta do Facebook", autoriza na janela da Meta e
-- escolhe a pagina numa lista. Mesmo fluxo do Imobilead.
--
-- Como o segredo nunca passa pelo navegador:
--
--   1. o CRM pede um `state` de uso unico (esta tabela) e manda a pessoa
--      para o dialogo da Meta;
--   2. a Meta devolve um `code` para o WORKER, nao para o navegador;
--   3. o worker troca o code por token, lista as paginas com
--      /me/accounts e grava aqui -- token de pagina incluso;
--   4. o navegador so recebe de volta a LISTA DE NOMES das paginas.
--
-- O token de pagina, portanto, nasce e morre no servidor.

create table if not exists imobi_board.meta_estados (
  state       text primary key,
  tenant_id   uuid not null references imobi_board.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  finalidade  text not null default 'CONECTAR',
  ref_id      uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  used_at     timestamptz
);
create index if not exists meta_estados_limpeza on imobi_board.meta_estados (expires_at);

create table if not exists imobi_board.meta_paginas (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references imobi_board.tenants(id) on delete cascade,
  page_id           text not null,
  page_name         text not null,
  page_access_token text not null,
  descoberta_em     timestamptz not null default now(),
  unique (tenant_id, page_id)
);

alter table imobi_board.meta_estados enable row level security;
alter table imobi_board.meta_paginas enable row level security;
-- sem policy: ninguem le direto. Tudo passa pelas RPCs abaixo.

alter table imobi_board.ingest_sources
  add column if not exists page_name   text,
  add column if not exists assinada_em timestamptz;

-- Uma pagina so pode alimentar uma conexao: o webhook chega por page_id e
-- precisa de destino unico.
create unique index if not exists ingest_sources_page_uq
  on imobi_board.ingest_sources (page_id) where page_id is not null;

/* ---------------------------------------------------------- passo 1 --- */

create or replace function imobi_board.iniciar_conexao_meta(
  p_finalidade text default 'CONECTAR',
  p_ref_id     uuid default null
) returns text
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_tenant uuid; v_state text;
begin
  select m.tenant_id into v_tenant from imobi_board.memberships m
  where m.user_id = v_uid and m.status='ACTIVE' and m.role='ADMIN' limit 1;
  if v_tenant is null then
    raise exception 'Apenas o administrador conecta integracoes.' using errcode = '42501';
  end if;

  delete from imobi_board.meta_estados where expires_at < now();

  v_state := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.meta_estados (state, tenant_id, user_id, finalidade, ref_id)
  values (v_state, v_tenant, v_uid, p_finalidade, p_ref_id);
  return v_state;
end;
$fn$;

/* ---------------------------------------------------------- passo 3 ---
   Chamada pelo worker depois de falar com a Meta. Consome o state: um code
   reapresentado nao serve duas vezes. */

create or replace function imobi_board.salvar_paginas_da_meta(
  p_state text,
  p_paginas jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare v_e imobi_board.meta_estados%rowtype; v_n int := 0;
begin
  select * into v_e from imobi_board.meta_estados
  where state = p_state and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'Autorizacao expirada ou ja utilizada.' using errcode = 'P0001';
  end if;

  update imobi_board.meta_estados set used_at = now() where state = p_state;

  insert into imobi_board.meta_paginas (tenant_id, page_id, page_name, page_access_token)
  select v_e.tenant_id, x->>'id', x->>'name', x->>'access_token'
  from jsonb_array_elements(p_paginas) x
  where coalesce(x->>'id','') <> '' and coalesce(x->>'access_token','') <> ''
  on conflict (tenant_id, page_id) do update
    set page_name = excluded.page_name,
        page_access_token = excluded.page_access_token,
        descoberta_em = now();
  get diagnostics v_n = row_count;

  -- conexao que ja usa essa pagina recebe o token renovado de graca
  update imobi_board.ingest_sources s
     set page_access_token = p.page_access_token,
         page_name = p.page_name,
         last_error = null, last_error_at = null
  from imobi_board.meta_paginas p
  where p.tenant_id = s.tenant_id and p.page_id = s.page_id
    and s.tenant_id = v_e.tenant_id;

  return jsonb_build_object('tenant_id', v_e.tenant_id, 'paginas', v_n);
end;
$fn$;

/* ---------------------------------------------------------- passo 4 --- */

create or replace function imobi_board.paginas_da_meta()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  -- sem access_token: a tela so escolhe pelo nome
  select coalesce(jsonb_agg(jsonb_build_object(
    'page_id',   p.page_id,
    'page_name', p.page_name,
    'conectada', exists (
      select 1 from imobi_board.ingest_sources s
      where s.page_id = p.page_id and s.tenant_id = p.tenant_id
    )
  ) order by p.page_name), '[]'::jsonb)
  from imobi_board.meta_paginas p
  where p.tenant_id in (
    select m.tenant_id from imobi_board.memberships m
    where m.user_id = (select auth.uid()) and m.status='ACTIVE' and m.role='ADMIN'
  );
$fn$;

/* Promove a pagina escolhida a fonte de lead. O token de pagina vem da
   staging -- nunca do cliente. Devolve um nonce para o worker assinar o
   webhook dessa pagina sem precisar de uma camada de auth propria. */
create or replace function imobi_board.conectar_pagina(
  p_page_id  text,
  p_label    text default null,
  p_queue_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid; v_p imobi_board.meta_paginas%rowtype;
  v_id uuid; v_token text; v_nonce text;
begin
  select m.tenant_id into v_tenant from imobi_board.memberships m
  where m.user_id = v_uid and m.status='ACTIVE' and m.role='ADMIN' limit 1;
  if v_tenant is null then
    raise exception 'Apenas o administrador conecta integracoes.' using errcode = '42501';
  end if;

  select * into v_p from imobi_board.meta_paginas
  where tenant_id = v_tenant and page_id = p_page_id;
  if not found then
    raise exception 'Pagina nao encontrada. Refaca a conexao com o Facebook.' using errcode = 'P0002';
  end if;

  if p_queue_id is not null and not exists (
    select 1 from imobi_board.lead_queues q where q.id = p_queue_id and q.tenant_id = v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  select id into v_id from imobi_board.ingest_sources
  where tenant_id = v_tenant and page_id = p_page_id;

  if v_id is null then
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    insert into imobi_board.ingest_sources
      (tenant_id, integration, label, token_sha256, queue_id,
       page_id, page_name, page_access_token)
    values (v_tenant, 'META_ADS',
            coalesce(nullif(btrim(p_label), ''), v_p.page_name),
            encode(extensions.digest(v_token,'sha256'),'hex'), p_queue_id,
            v_p.page_id, v_p.page_name, v_p.page_access_token)
    returning id into v_id;
  else
    update imobi_board.ingest_sources
       set label = coalesce(nullif(btrim(p_label), ''), label),
           queue_id = coalesce(p_queue_id, queue_id),
           page_access_token = v_p.page_access_token,
           page_name = v_p.page_name,
           active = true, last_error = null, last_error_at = null
     where id = v_id;
  end if;

  v_nonce := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.meta_estados (state, tenant_id, user_id, finalidade, ref_id)
  values (v_nonce, v_tenant, v_uid, 'ASSINAR', v_id);

  perform imobi_board_priv.emit_event(
    v_tenant, 'ingest_source.connected', 'ingest_source', v_id,
    jsonb_build_object('page_id', v_p.page_id, 'page_name', v_p.page_name));

  return jsonb_build_object('id', v_id, 'nonce', v_nonce, 'page_name', v_p.page_name);
end;
$fn$;

/* --------------------------------------------------- worker: assinar --- */

create or replace function imobi_board.fonte_para_assinar(p_nonce text)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare v_e imobi_board.meta_estados%rowtype; v_s imobi_board.ingest_sources%rowtype;
begin
  select * into v_e from imobi_board.meta_estados
  where state = p_nonce and finalidade = 'ASSINAR'
    and used_at is null and expires_at > now() for update;
  if not found then
    raise exception 'Autorizacao expirada.' using errcode = 'P0001';
  end if;
  update imobi_board.meta_estados set used_at = now() where state = p_nonce;

  select * into v_s from imobi_board.ingest_sources where id = v_e.ref_id;
  return jsonb_build_object(
    'id', v_s.id, 'page_id', v_s.page_id, 'page_access_token', v_s.page_access_token);
end;
$fn$;

create or replace function imobi_board.marcar_assinada(p_id uuid, p_erro text default null)
returns void
language sql security definer set search_path = ''
as $fn$
  update imobi_board.ingest_sources
     set assinada_em   = case when p_erro is null then now() else assinada_em end,
         last_error    = p_erro,
         last_error_at = case when p_erro is null then last_error_at else now() end
   where id = p_id;
$fn$;

/* Roteamento do webhook: com login, a Meta manda tudo para UMA url do app e
   o destino se descobre pelo page_id. */
create or replace function imobi_board.fonte_da_pagina(p_page_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select jsonb_build_object(
    'token_sha256', token_sha256,
    'page_access_token', page_access_token
  )
  from imobi_board.ingest_sources
  where page_id = p_page_id and active;
$fn$;

revoke execute on function imobi_board.iniciar_conexao_meta(text, uuid) from public;
revoke execute on function imobi_board.salvar_paginas_da_meta(text, jsonb) from public;
revoke execute on function imobi_board.paginas_da_meta() from public;
revoke execute on function imobi_board.conectar_pagina(text, text, uuid) from public;
revoke execute on function imobi_board.fonte_para_assinar(text) from public;
revoke execute on function imobi_board.marcar_assinada(uuid, text) from public;
revoke execute on function imobi_board.fonte_da_pagina(text) from public;

grant execute on function imobi_board.iniciar_conexao_meta(text, uuid) to authenticated;
grant execute on function imobi_board.paginas_da_meta() to authenticated;
grant execute on function imobi_board.conectar_pagina(text, text, uuid) to authenticated;

grant execute on function imobi_board.salvar_paginas_da_meta(text, jsonb) to service_role;
grant execute on function imobi_board.fonte_para_assinar(text) to service_role;
grant execute on function imobi_board.marcar_assinada(uuid, text) to service_role;
grant execute on function imobi_board.fonte_da_pagina(text) to service_role;
