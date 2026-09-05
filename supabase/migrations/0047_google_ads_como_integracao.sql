-- Imobi-Board 0047 - Google Ads como origem de lead
--
-- `criar_fonte` recusava qualquer coisa fora de META_ADS, SITE e WEBHOOK. A
-- lista continua explicita e so cresce: melhor recusar o desconhecido do que
-- aceitar "gogle_ads" com erro de digitacao e nunca receber lead nenhum.
--
-- Nao ha app, OAuth nem projeto no Google Cloud nesta integracao. O formulario
-- de lead do Google Ads entrega por webhook direto: o anunciante cola a URL e
-- uma chave na propria tela do Ads. A chave que ele digita volta no corpo de
-- cada lead, e o worker confere contra o mesmo token que ja esta na URL.
--
-- O corpo abaixo e o da 0025 com UMA linha alterada -- a da lista. A ordem dos
-- parametros e o nome do evento ficam intactos de proposito: os tipos sao
-- (text, text, uuid) nos dois, entao trocar a ordem dos nomes substituiria a
-- funcao fazendo o rotulo entrar no campo da integracao, em silencio; e
-- renomear o evento quebraria quem le domain_events.

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

  -- unica mudanca desta migracao
  if p_integration not in ('META_ADS','GOOGLE_ADS','SITE','WEBHOOK') then
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
