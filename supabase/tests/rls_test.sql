-- =========================================================================
-- Imobi-Board - suite de testes de RLS e isolamento (spec 60, 110, 114)
--
-- Reproduz o que foi verificado na construcao. Auto-contido: cria os helpers
-- de impersonacao, roda, e os apaga no fim. NAO deixe esses helpers no banco:
-- `atacar()` executa SQL arbitrario e nao tem por que existir fora do teste.
--
-- Como rodar:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/rls_test.sql
-- ou cole no SQL Editor do Supabase.
--
-- Depende do seed (supabase/seed.sql) ter sido aplicado.
-- =========================================================================

begin;

create or replace function pg_temp.contar(p_user uuid)
returns table (opps bigint, contatos bigint, tenants bigint, atividades bigint, tasks bigint)
language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  return query select
    (select count(*) from imobi_board.opportunities),
    (select count(*) from imobi_board.contacts),
    (select count(*) from imobi_board.tenants),
    (select count(*) from imobi_board.activities),
    (select count(*) from imobi_board.tasks);
  execute 'reset role';
end;
$fn$;

create or replace function pg_temp.atacar(p_user uuid, p_sql text)
returns text language plpgsql as $fn$
declare v_rows int; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_msg := case when v_rows = 0 then 'BLOQUEADO'
                  else 'FALHA DE SEGURANCA: ' || v_rows || ' linha(s)' end;
  exception when others then
    v_msg := 'BLOQUEADO (' || sqlstate || ')';
  end;
  execute 'reset role';
  return v_msg;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 1. Visibilidade por papel e por tenant
-- ---------------------------------------------------------------------
-- Esperado:
--   Carlos  (ADMIN Terra Concreta)  ve todos os leads da Terra Concreta
--   Joao    (BROKER)                ve apenas os atribuidos a ele
--   Beatriz (ADMIN Horizonte)       nao ve nada da Terra Concreta
--   desconhecido                    ve zero em tudo
select u.quem, c.*
from (values
  ('Carlos  ADMIN  Terra Concreta', '11111111-1111-4111-8111-000000000001'::uuid),
  ('Joao    BROKER Terra Concreta', '11111111-1111-4111-8111-000000000002'::uuid),
  ('Maria   BROKER Terra Concreta', '11111111-1111-4111-8111-000000000003'::uuid),
  ('Beatriz ADMIN  Horizonte',      '22222222-2222-4222-8222-000000000001'::uuid),
  ('Rafael  BROKER Horizonte',      '22222222-2222-4222-8222-000000000002'::uuid),
  ('Sem membership',                '99999999-9999-4999-8999-999999999999'::uuid)
) as u(quem, id), lateral pg_temp.contar(u.id) c;

-- ---------------------------------------------------------------------
-- 2. Ataques de escrita. Todos devem responder BLOQUEADO.
-- ---------------------------------------------------------------------
with alvos as (
  select
    (select id from imobi_board.opportunities
      where assigned_user_id = '11111111-1111-4111-8111-000000000003' limit 1) as da_maria,
    (select id from imobi_board.opportunities
      where assigned_user_id = '11111111-1111-4111-8111-000000000002' limit 1) as do_joao,
    (select id from imobi_board.opportunities
      where tenant_id = 'bbbbbbbb-0000-4000-8000-000000000002' limit 1) as da_horizonte
)
select t.n, t.teste, pg_temp.atacar(t.autor, t.sql) as resultado
from (
  select 1, 'Joao edita lead da Maria', '11111111-1111-4111-8111-000000000002'::uuid,
         format('update imobi_board.opportunities set source=''X'' where id=%L', da_maria) from alvos
  union all select 2, 'Joao se promove a ADMIN', '11111111-1111-4111-8111-000000000002'::uuid,
         'update imobi_board.memberships set role=''ADMIN'' where user_id=''11111111-1111-4111-8111-000000000002''' from alvos
  union all select 3, 'Joao repassa lead para colega', '11111111-1111-4111-8111-000000000002'::uuid,
         format('update imobi_board.opportunities set assigned_user_id=''11111111-1111-4111-8111-000000000003'' where id=%L', do_joao) from alvos
  union all select 4, 'Joao troca o tenant_id no payload', '11111111-1111-4111-8111-000000000002'::uuid,
         format('update imobi_board.opportunities set tenant_id=''bbbbbbbb-0000-4000-8000-000000000002'' where id=%L', do_joao) from alvos
  union all select 5, 'Joao le lead de outro tenant por UUID', '11111111-1111-4111-8111-000000000002'::uuid,
         format('select * from imobi_board.opportunities where id=%L', da_horizonte) from alvos
  union all select 6, 'Joao cria contato em outro tenant', '11111111-1111-4111-8111-000000000002'::uuid,
         'insert into imobi_board.contacts (tenant_id, full_name) values (''bbbbbbbb-0000-4000-8000-000000000002'',''X'')' from alvos
  union all select 7, 'Rafael move estagio de lead de outro tenant', '22222222-2222-4222-8222-000000000002'::uuid,
         format('select imobi_board.move_opportunity_stage(%L, (select id from imobi_board.pipeline_stages where pipeline_id=''aaaaaaaa-1111-4000-8000-000000000001'' and kind=''WON''))', do_joao) from alvos
  union all select 8, 'Joao apaga historico', '11111111-1111-4111-8111-000000000002'::uuid,
         'delete from imobi_board.activities' from alvos
  union all select 9, 'Joao escreve em domain_events', '11111111-1111-4111-8111-000000000002'::uuid,
         'insert into imobi_board.domain_events (tenant_id,event_type,aggregate_type,aggregate_id) values (''aaaaaaaa-0000-4000-8000-000000000001'',''x'',''y'',gen_random_uuid())' from alvos
  union all select 10, 'Joao le audit_logs', '11111111-1111-4111-8111-000000000002'::uuid,
         'select * from imobi_board.audit_logs' from alvos
  union all select 11, 'Maria aceita lead do Pedro', '11111111-1111-4111-8111-000000000003'::uuid,
         'select imobi_board.aceitar_lead((select id from imobi_board.lead_assignments where user_id=''11111111-1111-4111-8111-000000000004'' and status=''PENDING'' limit 1))' from alvos
  union all select 12, 'BROKER tenta distribuir lead', '11111111-1111-4111-8111-000000000002'::uuid,
         format('select imobi_board.distribuir_lead(%L, (select id from imobi_board.lead_queues limit 1))', do_joao) from alvos
) as t(n, teste, autor, sql)
order by t.n;

-- ---------------------------------------------------------------------
-- 3. Painel executivo e ranking sao exclusivos do ADMIN do proprio tenant
-- ---------------------------------------------------------------------
select 'Joao (BROKER) no painel admin' as teste,
       pg_temp.atacar('11111111-1111-4111-8111-000000000002',
         'select imobi_board.dashboard_admin(''aaaaaaaa-0000-4000-8000-000000000001'')') as resultado
union all
select 'Beatriz (ADMIN Horizonte) no painel da Terra Concreta',
       pg_temp.atacar('22222222-2222-4222-8222-000000000001',
         'select imobi_board.dashboard_admin(''aaaaaaaa-0000-4000-8000-000000000001'')')
union all
select 'Joao (BROKER) no ranking',
       pg_temp.atacar('11111111-1111-4111-8111-000000000002',
         'select * from imobi_board.ranking_corretores(''aaaaaaaa-0000-4000-8000-000000000001'')');

-- ---------------------------------------------------------------------
-- 4. Normalizacao de telefone (base da deduplicacao, spec 17)
-- ---------------------------------------------------------------------
-- As cinco primeiras linhas devem produzir exatamente o mesmo valor.
select entrada, imobi_board_priv.normalize_phone_br(entrada) as normalizado
from (values
  ('(11) 99663-4567'), ('11996634567'), ('5511996634567'),
  ('+55 11 99663-4567'), ('11 9663-4567'),
  ('(61) 3245-1200'), ('99663-4567'), ('abc'), (null)
) as t(entrada);

rollback;  -- teste nao deixa residuo
