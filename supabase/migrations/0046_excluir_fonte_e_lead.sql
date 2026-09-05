-- Imobi-Board 0046 - excluir integracao e excluir lead
--
-- Faltavam as duas exclusoes. Sem elas, um teste mal feito fica para sempre na
-- tela: hoje ha uma fonte chamada "asdsa" na Terra Concreta e leads
-- "<test lead: dummy data for full_name>" no funil, e nao havia como tirar.
--
-- Ambas sao de ADMIN, pela mesma porta de atualizar_fonte. Corretor nao apaga
-- lead: quem perde um atendimento nao pode fazer o registro dele sumir.
--
-- AS DUAS EMITEM EVENTO ANTES DE APAGAR, com um retrato do que foi removido.
-- Exclusao sem rastro e como o dado some sem ninguem saber explicar depois.

/* --------------------------------------------------- excluir fonte --- */

create or replace function imobi_board.excluir_fonte(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_s   imobi_board.ingest_sources%rowtype;
begin
  select * into v_s from imobi_board.ingest_sources where id = p_id;
  if not found then
    raise exception 'Integracao nao encontrada.' using errcode = 'P0002';
  end if;

  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_s.tenant_id
                   and m.status = 'ACTIVE' and m.role = 'ADMIN') then
    raise exception 'Apenas o administrador exclui integracoes.' using errcode = '42501';
  end if;

  -- retrato antes de sumir; o token nao entra, nem cifrado
  perform imobi_board_priv.emit_event(
    v_s.tenant_id, 'fonte.excluida', 'ingest_source', p_id,
    jsonb_build_object(
      'label', v_s.label, 'integracao', v_s.integration,
      'page_id', v_s.page_id, 'page_name', v_s.page_name,
      'ja_recebeu_lead', v_s.last_used_at is not null,
      'ultimo_uso', v_s.last_used_at, 'por', v_uid));

  delete from imobi_board.ingest_sources where id = p_id;

  return jsonb_build_object(
    'excluida', v_s.label,
    'era_meta', v_s.integration = 'META_ADS' and v_s.page_id is not null,
    -- quem chama precisa saber disso para avisar na tela: a Meta continua
    -- assinada na pagina e vai seguir mandando lead para um destino que nao
    -- existe mais
    'pagina_ainda_assinada_na_meta', v_s.assinada_em is not null);
end;
$fn$;

revoke execute on function imobi_board.excluir_fonte(uuid) from public;
grant  execute on function imobi_board.excluir_fonte(uuid) to authenticated;

/* ---------------------------------------------------- excluir lead --- */

/**
 * Exclui a oportunidade e, quando ela era a unica do contato, o contato junto.
 *
 * O schema ja carrega a politica certa e ela e respeitada, nao contornada:
 * activities, lead_assignments, lead_interests, proposals, tasks e visits caem
 * em cascata, mas `sales` e RESTRICT. Lead com venda registrada nao se apaga --
 * isso e historico financeiro, e o erro vira uma mensagem que explica o que
 * fazer em vez de um erro de chave estrangeira na cara do usuario.
 *
 * O contato so e removido se nao sobrar nada dele. Contato orfao sem
 * oportunidade nenhuma polui a busca e nao serve para nada; mas contato com
 * outro lead vivo fica.
 */
create or replace function imobi_board.excluir_lead(
  p_id     uuid,
  p_motivo text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_o       imobi_board.opportunities%rowtype;
  v_contato imobi_board.contacts%rowtype;
  v_vendas  int;
  v_sobrou  int;
  v_apagou_contato boolean := false;
begin
  select * into v_o from imobi_board.opportunities where id = p_id;
  if not found then
    raise exception 'Lead nao encontrado.' using errcode = 'P0002';
  end if;

  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_o.tenant_id
                   and m.status = 'ACTIVE' and m.role = 'ADMIN') then
    raise exception 'Apenas o administrador exclui leads.' using errcode = '42501';
  end if;

  select count(*) into v_vendas from imobi_board.sales s where s.opportunity_id = p_id;
  if v_vendas > 0 then
    raise exception
      'Este lead tem venda registrada e nao pode ser excluido. Cancele a venda antes, se ela nao aconteceu.'
      using errcode = 'P0001';
  end if;

  select * into v_contato from imobi_board.contacts where id = v_o.contact_id;

  perform imobi_board_priv.emit_event(
    v_o.tenant_id, 'lead.excluido', 'opportunity', p_id,
    jsonb_build_object(
      'contato', v_contato.full_name, 'telefone', v_contato.phone,
      'email', v_contato.email, 'origem', v_o.source,
      'produto', v_o.source_detail, 'campanha', v_o.campaign_name,
      'criado_em', v_o.created_at, 'motivo', p_motivo, 'por', v_uid));

  delete from imobi_board.opportunities where id = p_id;

  -- o contato so vai junto se nao sobrar nada dele
  select
    (select count(*) from imobi_board.opportunities o where o.contact_id = v_contato.id)
  + (select count(*) from imobi_board.proposals  pp where pp.contact_id = v_contato.id)
  + (select count(*) from imobi_board.sales      s  where s.contact_id  = v_contato.id)
  + (select count(*) from imobi_board.visits     v  where v.contact_id  = v_contato.id)
  into v_sobrou;

  if v_sobrou = 0 then
    delete from imobi_board.contacts where id = v_contato.id;
    v_apagou_contato := true;
  end if;

  return jsonb_build_object(
    'excluido', true,
    'contato', v_contato.full_name,
    'contato_removido', v_apagou_contato,
    'outros_registros_do_contato', v_sobrou);
end;
$fn$;

revoke execute on function imobi_board.excluir_lead(uuid, text) from public;
grant  execute on function imobi_board.excluir_lead(uuid, text) to authenticated;
