-- =========================================================================
-- Imobi-Board - testes de RLS das tabelas comerciais
-- (imoveis, interesse, visitas, propostas, vendas, filas)
--
-- Complementa rls_test.sql. Mesmo padrao: cria os helpers, roda, apaga.
--   psql "$SUPABASE_DB_URL" -f supabase/tests/rls_comercial_test.sql
-- =========================================================================

begin;

create or replace function pg_temp.conta(p_user uuid)
returns table (imoveis bigint, visitas bigint, propostas bigint,
               vendas bigint, interesses bigint, filas bigint)
language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  return query select
    (select count(*) from imobi_board.properties),
    (select count(*) from imobi_board.visits),
    (select count(*) from imobi_board.proposals),
    (select count(*) from imobi_board.sales),
    (select count(*) from imobi_board.lead_interests),
    (select count(*) from imobi_board.lead_queues);
  execute 'reset role';
end;
$fn$;

create or replace function pg_temp.atacar(p_user uuid, p_sql text)
returns text language plpgsql as $fn$
declare n int; m text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql; get diagnostics n = row_count;
    m := case when n = 0 then 'BLOQUEADO' else 'FALHA DE SEGURANCA: ' || n || ' linha(s)' end;
  exception when others then m := 'BLOQUEADO (' || sqlstate || ')'; end;
  execute 'reset role';
  return m;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 1. Visibilidade
-- ---------------------------------------------------------------------
-- Esperado:
--   imoveis  -> todo mundo do tenant ve o estoque (spec 12)
--   visitas, propostas, vendas -> BROKER so as proprias
--   Horizonte nao ve nada da Terra Concreta
select u.quem, c.*
from (values
  ('Carlos  ADMIN  Terra Concreta', '11111111-1111-4111-8111-000000000001'::uuid),
  ('Joao    BROKER Terra Concreta', '11111111-1111-4111-8111-000000000002'::uuid),
  ('Maria   BROKER Terra Concreta', '11111111-1111-4111-8111-000000000003'::uuid),
  ('Beatriz ADMIN  Horizonte',      '22222222-2222-4222-8222-000000000001'::uuid),
  ('Rafael  BROKER Horizonte',      '22222222-2222-4222-8222-000000000002'::uuid)
) as u(quem, id), lateral pg_temp.conta(u.id) c;

-- ---------------------------------------------------------------------
-- 2. Ataques. Todos devem responder BLOQUEADO.
-- ---------------------------------------------------------------------
select t.n, t.teste, pg_temp.atacar(t.autor, t.sql) as resultado
from (
  select 1, 'BROKER cadastra imovel', '11111111-1111-4111-8111-000000000002'::uuid,
    'insert into imobi_board.properties (tenant_id,title,type) values (''aaaaaaaa-0000-4000-8000-000000000001'',''Pirata'',''CASA'')'
  union all select 2, 'BROKER edita preco de imovel', '11111111-1111-4111-8111-000000000002'::uuid,
    'update imobi_board.properties set price = 1 where code = ''VR-202'''
  union all select 3, 'BROKER apaga imovel', '11111111-1111-4111-8111-000000000002'::uuid,
    'delete from imobi_board.properties where code = ''VR-202'''
  union all select 4, 'Corretor de outro tenant cadastra imovel aqui', '22222222-2222-4222-8222-000000000002'::uuid,
    'insert into imobi_board.properties (tenant_id,title,type) values (''aaaaaaaa-0000-4000-8000-000000000001'',''Invasor'',''CASA'')'
  union all select 5, 'Maria le proposta do Joao', '11111111-1111-4111-8111-000000000003'::uuid,
    'select * from imobi_board.proposals'
  union all select 6, 'Maria le venda do Joao', '11111111-1111-4111-8111-000000000003'::uuid,
    'select * from imobi_board.sales'
  union all select 7, 'BROKER escreve direto em sales', '11111111-1111-4111-8111-000000000002'::uuid,
    'insert into imobi_board.sales (tenant_id,opportunity_id,contact_id,broker_id,sale_value) select ''aaaaaaaa-0000-4000-8000-000000000001'',id,contact_id,''11111111-1111-4111-8111-000000000002'',1 from imobi_board.opportunities limit 1'
  union all select 8, 'BROKER cria fila de distribuicao', '11111111-1111-4111-8111-000000000002'::uuid,
    'insert into imobi_board.lead_queues (tenant_id,name) values (''aaaaaaaa-0000-4000-8000-000000000001'',''Minha fila'')'
  union all select 9, 'BROKER se coloca primeiro no rodizio', '11111111-1111-4111-8111-000000000002'::uuid,
    'update imobi_board.queue_members set sort_order = -1 where user_id = ''11111111-1111-4111-8111-000000000002'''
  union all select 10, 'ADMIN de outro tenant le imovel daqui', '22222222-2222-4222-8222-000000000001'::uuid,
    'select * from imobi_board.properties where code like ''VR-%'''
  union all select 11, 'Maria cria interesse em lead do Joao', '11111111-1111-4111-8111-000000000003'::uuid,
    'insert into imobi_board.lead_interests (tenant_id,opportunity_id) select ''aaaaaaaa-0000-4000-8000-000000000001'',id from imobi_board.opportunities where assigned_user_id=''11111111-1111-4111-8111-000000000002'' limit 1'
  union all select 12, 'BROKER cancela a propria venda', '11111111-1111-4111-8111-000000000002'::uuid,
    'select imobi_board.cancelar_venda((select id from imobi_board.sales limit 1), ''quero mudar'')'
  union all select 13, 'Corretor de outro tenant roda matching daqui', '22222222-2222-4222-8222-000000000002'::uuid,
    'select * from imobi_board.match_imoveis((select id from imobi_board.opportunities where tenant_id=''aaaaaaaa-0000-4000-8000-000000000001'' limit 1))'
) as t(n, teste, autor, sql)
order by t.n;

-- ---------------------------------------------------------------------
-- 3. Regra da spec 80: venda nao acontece por arrastar card
-- ---------------------------------------------------------------------
-- Esperado: BLOQUEADO com a mensagem pedindo "Registrar venda".
select 'Arrastar lead sem venda para a etapa Venda' as teste,
       pg_temp.atacar('11111111-1111-4111-8111-000000000002', format(
         'select imobi_board.move_opportunity_stage(%L, (select id from imobi_board.pipeline_stages where pipeline_id = ''aaaaaaaa-1111-4000-8000-000000000001'' and kind = ''WON''))',
         (select o.id from imobi_board.opportunities o
          where o.assigned_user_id = '11111111-1111-4111-8111-000000000002'
            and o.status = 'OPEN' limit 1))) as resultado;

-- ---------------------------------------------------------------------
-- 4. Matching: score e explicacao
-- ---------------------------------------------------------------------
-- Esperado, com o interesse do seed (Aquarius, ate 1 mi, 3q, 2v, 90m2+):
--   100% nas unidades que atendem tudo
--    95% no usado com area ligeiramente abaixo (credito parcial)
--   imovel de outro bairro/faixa cai proporcionalmente
--   imovel vendido ou de outro tenant NAO aparece
select m.titulo, m.bairro, m.preco, m.area_m2, m.quartos, m.vagas, m.score
from imobi_board.opportunities o
join imobi_board.contacts c on c.id = o.contact_id
cross join lateral imobi_board.match_imoveis(o.id, 8) m
where c.full_name = 'Olivia Ramos';

rollback;  -- teste nao deixa residuo
