-- Imobi-Board 0017 - o nome de quem foi desativado nao pode sumir
--
-- BUG encontrado usando a tela, nao no teste: tenant_peer_ids() so devolvia
-- usuarios com membership ATIVO. Ao desativar um corretor, o ADMIN perdia o
-- nome dele na propria tela de equipe - a linha virava "Sem nome" e ficava
-- impossivel saber quem reativar. O mesmo valia para o historico: atividade
-- registrada por alguem que saiu ficava sem autor.
--
-- Continua exigindo membership ATIVO do LADO DE QUEM CONSULTA: quem saiu da
-- imobiliaria nao ve mais ninguem. O que passa a ser visivel e o nome de quem
-- ja esteve no time - e nome de colega nao e dado sensivel dentro do tenant.

create or replace function imobi_board_priv.tenant_peer_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.tenant_id in (
    select mine.tenant_id
    from imobi_board.memberships mine
    where mine.user_id = (select auth.uid())
      and mine.status = 'ACTIVE'      -- quem consulta precisa estar ativo
  );
  -- sem filtro de status em m: inclui quem foi desativado
$fn$;
