-- Imobi-Board 0025 - aba de integracoes (spec 51/53)
--
-- Ate aqui a unica fonte de lead que existia foi inserida na mao no seed.
-- Nao havia como o ADMIN conectar a Meta, nem ver se esta chegando lead.
--
-- Decisoes que o desenho da tabela precisa suportar:
--
-- 1. A Meta nao manda header nenhum no webhook. O segredo tem que viajar na
--    URL, entao a URL de callback JA e a credencial. Continua sendo o mesmo
--    token com hash: o worker le da query e compara o sha256.
--
-- 2. O handshake de verificacao da Meta (hub.verify_token) passa a ser por
--    fonte, e nao uma variavel global do worker: cada imobiliaria tem o seu.
--    Reaproveita o mesmo token -- um valor so para a pessoa copiar, colado em
--    dois campos la.
--
-- 3. O webhook de Lead Ads NAO traz os dados do lead, so o leadgen_id. Para
--    ler nome e telefone e obrigatorio chamar a Graph API com um token de
--    pagina. Por isso page_access_token: sem ele a integracao recebe o aviso
--    e nao consegue montar o lead.

alter table imobi_board.ingest_sources
  add column if not exists page_access_token text,
  add column if not exists page_id            text,
  add column if not exists last_error         text,
  add column if not exists last_error_at      timestamptz;

comment on column imobi_board.ingest_sources.page_access_token is
  'Token de pagina da Meta. Nunca sai do banco para o navegador: as RPCs de '
  'leitura devolvem apenas um booleano dizendo se ele existe.';

-- Leitura: uma chamada devolve tudo que a tela precisa, ja com a contagem de
-- leads. SECURITY DEFINER para poder ler a tabela sem expor coluna de segredo.
create or replace function imobi_board.fontes_de_lead()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_r jsonb;
begin
  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_r
  from (
    select jsonb_build_object(
      'id',            s.id,
      'integration',   s.integration,
      'label',         s.label,
      'queue_id',      s.queue_id,
      'queue_nome',    q.name,
      'active',        s.active,
      'last_used_at',  s.last_used_at,
      'created_at',    s.created_at,
      'last_error',    s.last_error,
      'last_error_at', s.last_error_at,
      'page_id',       s.page_id,
      -- o token da pagina nunca sai daqui; a tela so precisa saber se existe
      'tem_token_da_pagina', s.page_access_token is not null,
      'leads', (
        select count(*) from imobi_board.opportunities o
        where o.tenant_id = s.tenant_id
          and o.source = s.integration
          and o.source_detail = s.label
      )
    ) as x
    from imobi_board.ingest_sources s
    left join imobi_board.lead_queues q on q.id = s.queue_id
    where s.tenant_id in (
      select m.tenant_id from imobi_board.memberships m
      where m.user_id = v_uid and m.status = 'ACTIVE' and m.role = 'ADMIN'
    )
  ) t;
  return v_r;
end;
$fn$;

/* Cria a fonte e devolve o token EM CLARO, uma vez so. Depois disso ele nao
   existe mais em lugar nenhum legivel: a tabela guarda so o sha256. Perdeu,
   gera outro -- e o mesmo contrato do convite de corretor. */
create or replace function imobi_board.criar_fonte(
  p_integration text,
  p_label       text,
  p_queue_id    uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_token text;
  v_id uuid;
begin
  select m.tenant_id into v_tenant from imobi_board.memberships m
  where m.user_id = v_uid and m.status = 'ACTIVE' and m.role = 'ADMIN' limit 1;
  if v_tenant is null then
    raise exception 'Apenas o administrador conecta integracoes.' using errcode = '42501';
  end if;

  if p_integration not in ('META_ADS','SITE','WEBHOOK') then
    raise exception 'Integracao nao suportada.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'De um nome para a conexao.' using errcode = 'P0001';
  end if;

  if p_queue_id is not null and not exists (
    select 1 from imobi_board.lead_queues q
    where q.id = p_queue_id and q.tenant_id = v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into imobi_board.ingest_sources
    (tenant_id, integration, label, token_sha256, queue_id)
  values (v_tenant, p_integration, btrim(p_label),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), p_queue_id)
  returning id into v_id;

  perform imobi_board_priv.emit_event(
    v_tenant, 'ingest_source.created', 'ingest_source', v_id,
    jsonb_build_object('integration', p_integration, 'label', p_label));

  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$fn$;

create or replace function imobi_board.regerar_token_da_fonte(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_tenant uuid; v_token text;
begin
  select s.tenant_id into v_tenant from imobi_board.ingest_sources s where s.id = p_id;
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_tenant
                   and m.status='ACTIVE' and m.role='ADMIN') then
    raise exception 'Apenas o administrador altera integracoes.' using errcode = '42501';
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  update imobi_board.ingest_sources
     set token_sha256 = encode(extensions.digest(v_token, 'sha256'), 'hex')
   where id = p_id;

  return jsonb_build_object('token', v_token);
end;
$fn$;

create or replace function imobi_board.atualizar_fonte(
  p_id       uuid,
  p_label    text default null,
  p_queue_id uuid default null,
  p_active   boolean default null,
  p_page_access_token text default null,
  p_page_id  text default null
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_tenant uuid;
begin
  select s.tenant_id into v_tenant from imobi_board.ingest_sources s where s.id = p_id;
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_tenant
                   and m.status='ACTIVE' and m.role='ADMIN') then
    raise exception 'Apenas o administrador altera integracoes.' using errcode = '42501';
  end if;

  if p_queue_id is not null and not exists (
    select 1 from imobi_board.lead_queues q
    where q.id = p_queue_id and q.tenant_id = v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  update imobi_board.ingest_sources s
     set label    = coalesce(nullif(btrim(p_label), ''), s.label),
         queue_id = coalesce(p_queue_id, s.queue_id),
         active   = coalesce(p_active, s.active),
         page_id  = coalesce(nullif(btrim(p_page_id), ''), s.page_id),
         -- string vazia apaga o token da pagina; null deixa como esta
         page_access_token = case
           when p_page_access_token is null then s.page_access_token
           when btrim(p_page_access_token) = '' then null
           else btrim(p_page_access_token)
         end
   where s.id = p_id;
end;
$fn$;

/* Chamada pelo worker (service_role) quando a Meta responde erro: a tela
   precisa dizer "chegou aviso mas nao consegui ler o lead" em vez de ficar
   muda. */
create or replace function imobi_board.registrar_erro_de_fonte(
  p_token_sha256 text, p_erro text
) returns void
language sql security definer set search_path = ''
as $fn$
  update imobi_board.ingest_sources
     set last_error = left(p_erro, 400), last_error_at = now()
   where token_sha256 = p_token_sha256;
$fn$;

revoke execute on function imobi_board.fontes_de_lead() from public;
revoke execute on function imobi_board.criar_fonte(text, text, uuid) from public;
revoke execute on function imobi_board.regerar_token_da_fonte(uuid) from public;
revoke execute on function imobi_board.atualizar_fonte(uuid, text, uuid, boolean, text, text) from public;
revoke execute on function imobi_board.registrar_erro_de_fonte(text, text) from public;

grant execute on function imobi_board.fontes_de_lead() to authenticated;
grant execute on function imobi_board.criar_fonte(text, text, uuid) to authenticated;
grant execute on function imobi_board.regerar_token_da_fonte(uuid) to authenticated;
grant execute on function imobi_board.atualizar_fonte(uuid, text, uuid, boolean, text, text) to authenticated;
grant execute on function imobi_board.registrar_erro_de_fonte(text, text) to service_role;
