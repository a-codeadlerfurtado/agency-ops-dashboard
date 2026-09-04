-- Imobi-Board 0029 - criacao de imobiliaria pelo operador
--
-- Tres coisas, e a primeira e uma correcao de seguranca.
--
-- 1. provision_tenant estava concedida a `authenticated`. Ou seja: qualquer
--    pessoa com conta e a chave anon podia criar uma imobiliaria propria
--    dentro deste banco, sem tela nenhuma, so chamando a RPC. Nao havia
--    interface para isso -- o que torna pior, porque ninguem ia notar.
--    O modelo escolhido e "so o operador cria", entao a permissao sai.
--
-- 2. provision_tenant nao criava fila de distribuicao. Nao e hipotetico: a
--    "Imobiliaria Horizonte" ja existe sem fila, e o primeiro lead dela
--    falharia na distribuicao. Passa a criar.
--
-- 3. Quem e operador fica numa lista de e-mails, e nao num papel novo. Papel
--    exigiria mexer em memberships, que e por imobiliaria; operador e uma
--    condicao acima disso. Lista tambem significa que a rota nao vaza por
--    acidente: quem nao esta nela recebe 42501 da propria funcao.

create table if not exists imobi_board.operadores (
  email     text primary key,
  nome      text,
  criado_em timestamptz not null default now()
);
alter table imobi_board.operadores enable row level security;
-- sem policy: ninguem le a lista pelo PostgREST. So as funcoes abaixo consultam.

comment on table imobi_board.operadores is
  'Quem pode criar imobiliarias. E uma condicao acima de membership, por isso '
  'lista de e-mail e nao papel: papel vive dentro de uma imobiliaria.';

insert into imobi_board.operadores (email, nome)
values ('leonardoimobiia@gmail.com', 'Adler')
on conflict (email) do nothing;

create or replace function imobi_board_priv.e_operador()
returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from imobi_board.operadores o
    where o.email = lower((select auth.jwt() ->> 'email'))
  );
$fn$;

/* ------------------------------------------------- criar imobiliaria --- */

create or replace function imobi_board.criar_imobiliaria(
  p_nome        text,
  p_email_admin text,
  p_slug        text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_slug   text;
  v_base   text;
  v_n      int := 1;
  v_tenant uuid;
  v_pipe   uuid;
  v_fila   uuid;
  v_email  text := imobi_board_priv.normalize_email(p_email_admin);
  v_token  text;
begin
  if not imobi_board_priv.e_operador() then
    raise exception 'Somente a operacao cria imobiliaria.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_nome), '') = '' then
    raise exception 'Informe o nome da imobiliaria.' using errcode = 'P0001';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail do administrador invalido.' using errcode = 'P0001';
  end if;

  -- slug a partir do nome: sem acento, sem simbolo, sem espaco dobrado
  v_base := coalesce(nullif(btrim(p_slug), ''), btrim(p_nome));
  v_base := lower(translate(v_base,
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  if v_base = '' then v_base := 'imobiliaria'; end if;

  -- colisao vira sufixo numerico em vez de erro na cara do operador
  v_slug := v_base;
  while exists (select 1 from imobi_board.tenants t where t.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  insert into imobi_board.tenants (name, slug)
  values (btrim(p_nome), v_slug) returning id into v_tenant;

  insert into imobi_board.pipelines (tenant_id, name, is_default)
  values (v_tenant, 'Funil padrao', true) returning id into v_pipe;

  insert into imobi_board.pipeline_stages (tenant_id, pipeline_id, name, kind, sort_order)
  values
    (v_tenant, v_pipe, 'Novo',        'NEW',        0),
    (v_tenant, v_pipe, 'Contatado',   'CONTACTED',  1),
    (v_tenant, v_pipe, 'Qualificado', 'QUALIFIED',  2),
    (v_tenant, v_pipe, 'Visita',      'VISIT',      3),
    (v_tenant, v_pipe, 'Proposta',    'PROPOSAL',   4),
    (v_tenant, v_pipe, 'Venda',       'WON',        5);

  -- A fila que faltava. Sem ela o primeiro lead entra e fica sem dono, e o
  -- SLA nao tem prazo para cobrar.
  insert into imobi_board.lead_queues
    (tenant_id, name, status, acceptance_timeout_seconds, timezone)
  values (v_tenant, 'Atendimento', 'ACTIVE', 300, 'America/Sao_Paulo')
  returning id into v_fila;

  -- convite do primeiro ADMIN: mesma mecanica do convite de corretor, entao
  -- ele entra criando a propria senha e o e-mail fica travado
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.invites (tenant_id, email, role, token, created_by)
  values (v_tenant, v_email, 'ADMIN', v_token, v_uid);

  perform imobi_board_priv.emit_event(
    v_tenant, 'tenant.created', 'tenant', v_tenant,
    jsonb_build_object('nome', p_nome, 'slug', v_slug, 'admin', v_email));

  return jsonb_build_object(
    'tenant_id', v_tenant, 'nome', btrim(p_nome), 'slug', v_slug,
    'email', v_email, 'token', v_token);
end;
$fn$;

/* Lista para a tela da operacao. Numeros vem daqui para nao precisar de uma
   consulta por imobiliaria no cliente. */
create or replace function imobi_board.imobiliarias()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_r jsonb;
begin
  if not imobi_board_priv.e_operador() then
    raise exception 'Somente a operacao ve esta lista.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'criada_em' desc), '[]'::jsonb) into v_r
  from (
    select jsonb_build_object(
      'id', t.id, 'nome', t.name, 'slug', t.slug, 'criada_em', t.created_at,
      'membros',  (select count(*) from imobi_board.memberships m
                    where m.tenant_id = t.id and m.status = 'ACTIVE'),
      'leads',    (select count(*) from imobi_board.opportunities o where o.tenant_id = t.id),
      'filas',    (select count(*) from imobi_board.lead_queues q where q.tenant_id = t.id),
      'convites_pendentes', (select count(*) from imobi_board.invites i
                              where i.tenant_id = t.id
                                and i.accepted_at is null and i.revoked_at is null)
    ) as x
    from imobi_board.tenants t
  ) s;
  return v_r;
end;
$fn$;

/* Quem abre o app precisa saber se ve o menu da operacao. */
create or replace function imobi_board.sou_operador()
returns boolean
language sql stable security definer set search_path = ''
as $fn$ select imobi_board_priv.e_operador(); $fn$;

/* --------------------------------------------- correcao de seguranca --- */

-- provision_tenant sai do alcance de quem tem conta. Fica so para o postgres,
-- que e como o seed a usa.
revoke execute on function imobi_board.provision_tenant(text, text) from authenticated;
revoke execute on function imobi_board.provision_tenant(text, text) from public;

revoke execute on function imobi_board.criar_imobiliaria(text, text, text) from public;
revoke execute on function imobi_board.imobiliarias() from public;
revoke execute on function imobi_board.sou_operador() from public;
revoke execute on function imobi_board_priv.e_operador() from public;

grant execute on function imobi_board.criar_imobiliaria(text, text, text) to authenticated;
grant execute on function imobi_board.imobiliarias() to authenticated;
grant execute on function imobi_board.sou_operador() to authenticated;
