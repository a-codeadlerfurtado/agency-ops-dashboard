-- Imobi-Board 0011 - matching lead x imovel (spec PASSO 16, secoes 41/42)
--
-- Deterministico, barato e explicavel: sem IA, sem embedding, sem tabela de
-- score persistida. A consulta e barata o suficiente para rodar quando a ficha
-- do lead abre.
--
-- Pesos da spec: bairro 25, preco 25, tipo 15, quartos 15, area 10, vagas 10.
-- Criterio NAO preenchido nao entra na conta - nem a favor nem contra. O score
-- e normalizado sobre o peso do que foi de fato informado, senao um lead com
-- dois criterios preenchidos nunca passaria de 50%.
create or replace function imobi_board.match_imoveis(
  p_opportunity_id uuid,
  p_limite         int default 10
) returns table (
  property_id  uuid,
  titulo       text,
  bairro       text,
  cidade       text,
  preco        numeric,
  area_m2      numeric,
  quartos      smallint,
  vagas        smallint,
  tipo         imobi_board.property_type,
  score        int,
  motivos      jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_opp   imobi_board.opportunities%rowtype;
  v_i     imobi_board.lead_interests%rowtype;
  v_admin boolean;
begin
  select * into v_opp from imobi_board.opportunities where id = p_opportunity_id;
  if not found then
    raise exception 'Oportunidade nao encontrada.' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = v_opp.tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) into v_admin;

  if not v_admin and v_opp.assigned_user_id is distinct from v_uid then
    raise exception 'Voce nao tem permissao sobre esta oportunidade.'
      using errcode = '42501';
  end if;

  select * into v_i from imobi_board.lead_interests
  where opportunity_id = p_opportunity_id;

  if not found then
    return;  -- sem perfil de interesse nao ha o que casar
  end if;

  return query
  with pesos as (
    select
      case when cardinality(v_i.neighborhoods) > 0 or cardinality(v_i.cities) > 0
           then 25 else 0 end as w_local,
      case when v_i.min_price is not null or v_i.max_price is not null
           then 25 else 0 end as w_preco,
      case when v_i.property_type is not null then 15 else 0 end as w_tipo,
      case when v_i.min_bedrooms is not null   then 15 else 0 end as w_quartos,
      case when v_i.min_area is not null or v_i.max_area is not null
           then 10 else 0 end as w_area,
      case when v_i.min_parking_spaces is not null then 10 else 0 end as w_vagas
  ),
  avaliado as (
    select
      p.*,
      w.*,
      -- localizacao: bairro vale cheio, cidade certa com bairro errado vale metade
      (case when w.w_local = 0 then 0
            when cardinality(v_i.neighborhoods) > 0 and p.neighborhood = any (v_i.neighborhoods) then 25
            when cardinality(v_i.cities) > 0 and p.city = any (v_i.cities) then 12
            else 0 end) as p_local,
      -- preco: dentro da faixa vale cheio; ate 10% acima do teto vale metade,
      -- porque corretor negocia e o cliente costuma esticar um pouco
      (case when w.w_preco = 0 or p.price is null then 0
            when p.price >= coalesce(v_i.min_price, 0)
             and p.price <= coalesce(v_i.max_price, 1e12) then 25
            when v_i.max_price is not null
             and p.price <= v_i.max_price * 1.10 then 12
            else 0 end) as p_preco,
      (case when w.w_tipo = 0 then 0
            when p.type = v_i.property_type then 15 else 0 end) as p_tipo,
      (case when w.w_quartos = 0 or p.bedrooms is null then 0
            when p.bedrooms >= v_i.min_bedrooms then 15 else 0 end) as p_quartos,
      (case when w.w_area = 0 or p.area_m2 is null then 0
            when p.area_m2 >= coalesce(v_i.min_area, 0)
             and p.area_m2 <= coalesce(v_i.max_area, 1e9) then 10
            when v_i.min_area is not null
             and p.area_m2 >= v_i.min_area * 0.9 then 5
            else 0 end) as p_area,
      (case when w.w_vagas = 0 or p.parking_spaces is null then 0
            when p.parking_spaces >= v_i.min_parking_spaces then 10 else 0 end) as p_vagas
    from imobi_board.properties p
    cross join pesos w
    where p.tenant_id = v_opp.tenant_id
      and p.status = 'AVAILABLE'
      and p.transaction_type = 'VENDA'
  )
  select
    a.id, a.title, a.neighborhood, a.city, a.price, a.area_m2,
    a.bedrooms, a.parking_spaces, a.type,
    (case when (a.w_local + a.w_preco + a.w_tipo + a.w_quartos + a.w_area + a.w_vagas) = 0
          then 0
          else round(100.0 * (a.p_local + a.p_preco + a.p_tipo + a.p_quartos + a.p_area + a.p_vagas)
                     / (a.w_local + a.w_preco + a.w_tipo + a.w_quartos + a.w_area + a.w_vagas))
     end)::int,
    -- os motivos existem para o corretor conseguir defender a sugestao na
    -- frente do cliente. Score sem explicacao ninguem usa.
    (select jsonb_agg(m order by m ->> 'criterio')
     from (values
       ('bairro',  a.w_local,   a.p_local),
       ('preco',   a.w_preco,   a.p_preco),
       ('tipo',    a.w_tipo,    a.p_tipo),
       ('quartos', a.w_quartos, a.p_quartos),
       ('area',    a.w_area,    a.p_area),
       ('vagas',   a.w_vagas,   a.p_vagas)
     ) as t(criterio, peso, pontos)
     cross join lateral (
       select jsonb_build_object(
         'criterio', t.criterio,
         'peso', t.peso,
         'pontos', t.pontos,
         'situacao', case when t.peso = 0 then 'nao_informado'
                          when t.pontos = t.peso then 'atende'
                          when t.pontos > 0 then 'parcial'
                          else 'nao_atende' end) as m
     ) x
     where t.peso > 0)
  from avaliado a
  where (a.p_local + a.p_preco + a.p_tipo + a.p_quartos + a.p_area + a.p_vagas) > 0
  order by (a.p_local + a.p_preco + a.p_tipo + a.p_quartos + a.p_area + a.p_vagas) desc,
           a.price nulls last
  limit greatest(p_limite, 1);
end;
$fn$;

revoke execute on function imobi_board.match_imoveis(uuid, int) from public;
grant execute on function imobi_board.match_imoveis(uuid, int) to authenticated;
