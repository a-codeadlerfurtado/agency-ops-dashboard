-- Imobi-Board 0023 - produto da oportunidade (spec 71/72)
--
-- opportunities.property_id e development_id existem desde a 0010 e nunca
-- foram preenchidos por ninguem: colunas mortas. Sem elas nao da para
-- filtrar lead por empreendimento (71) nem mostrar o imovel no lead (72).
--
-- A correcao NAO cria um campo novo para o corretor preencher a mao. O
-- vinculo nasce do que ele ja faz: marcar visita, mandar proposta, fechar
-- venda. Feito por trigger e nao dentro das RPCs porque assim vale para
-- qualquer caminho que insira essas linhas, inclusive os que ainda nao
-- existem, e nao arrisca regressao em tres funcoes que ja funcionam.

create or replace function imobi_board_priv.vincular_produto()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_dev uuid;
begin
  if new.property_id is null or new.opportunity_id is null then
    return new;
  end if;

  select development_id into v_dev
  from imobi_board.properties where id = new.property_id;

  if tg_table_name = 'sales' then
    -- a venda e definitiva: o produto da oportunidade e o imovel vendido,
    -- mesmo que uma visita antiga tenha apontado outro
    update imobi_board.opportunities
       set property_id    = new.property_id,
           development_id = v_dev
     where id = new.opportunity_id;
  else
    -- visita e proposta so preenchem o que ainda estiver vazio: a primeira
    -- intencao registrada vale ate a venda dizer o contrario
    update imobi_board.opportunities
       set property_id    = coalesce(property_id, new.property_id),
           development_id = coalesce(development_id, v_dev)
     where id = new.opportunity_id;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_produto_visita   on imobi_board.visits;
drop trigger if exists trg_produto_proposta on imobi_board.proposals;
drop trigger if exists trg_produto_venda    on imobi_board.sales;

create trigger trg_produto_visita   after insert on imobi_board.visits
  for each row execute function imobi_board_priv.vincular_produto();
create trigger trg_produto_proposta after insert on imobi_board.proposals
  for each row execute function imobi_board_priv.vincular_produto();
create trigger trg_produto_venda    after insert on imobi_board.sales
  for each row execute function imobi_board_priv.vincular_produto();

-- Retroativo: o historico que ja existe tambem tem produto. Mesma precedencia
-- da trigger - venda manda, senao a visita/proposta mais antiga.
with melhor as (
  select opportunity_id, property_id,
         row_number() over (
           partition by opportunity_id
           order by prioridade, quando
         ) as posicao
  from (
    select opportunity_id, property_id, 0 as prioridade, created_at as quando
      from imobi_board.sales     where property_id is not null and opportunity_id is not null
    union all
    select opportunity_id, property_id, 1, created_at
      from imobi_board.proposals where property_id is not null and opportunity_id is not null
    union all
    select opportunity_id, property_id, 1, created_at
      from imobi_board.visits    where property_id is not null and opportunity_id is not null
  ) tudo
)
update imobi_board.opportunities o
   set property_id    = m.property_id,
       development_id = p.development_id
  from melhor m
  join imobi_board.properties p on p.id = m.property_id
 where m.posicao = 1
   and o.id = m.opportunity_id
   and o.property_id is null;

-- indice do filtro por empreendimento: parcial, porque a maioria dos leads
-- ainda nao tem produto e essas linhas nao servem ao filtro
create index if not exists opportunities_development_idx
  on imobi_board.opportunities (tenant_id, development_id)
  where development_id is not null;
