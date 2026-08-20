-- Carteiras com nome proprio (alfabeto militar), em vez do nome do gestor.
--
-- Ate' aqui "carteira" era so' o nome da pessoa colado num rotulo ("Carteira Felipe
-- Oliveira"). Isso amarra a identidade da carteira a quem a opera hoje: troca de GT
-- e a carteira "muda de nome", mesmo sendo a mesma lista de clientes.
--
-- Agora cada carteira tem um codinome estavel - Alfa, Bravo, Charlie... - atribuido
-- por ORDEM DE CRIACAO e nunca reciclado. Carteira nova nasce ja' com a proxima
-- palavra do alfabeto, sem ninguem precisar batizar: os gatilhos abaixo cuidam disso
-- em qualquer caminho que crie uma carteira (cliente novo com gestor, remanejamento
-- em gt_assignments, ou GT novo entrando no quadro).

create table if not exists agency_ops.wallet_registry (
  gt_owner  text        primary key,
  ordem     int         not null unique,
  carteira  text        not null unique,
  criada_em timestamptz not null default now()
);

comment on table agency_ops.wallet_registry is
  'Codinome estavel de cada carteira (Alfa, Bravo, Charlie...). Ordem de criacao, nunca reciclada.';

-- 1 -> Alfa. Acima de 26 o nome deixa de ser palavra e vira numero, mas continua
-- unico e nao-nulo: melhor um rotulo feio do que a coluna estourar.
create or replace function agency_ops.nato_word(n int)
returns text
language sql
immutable
as $$
  select coalesce(
    (array['Alfa','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India',
           'Juliett','Kilo','Lima','Mike','November','Oscar','Papa','Quebec','Romeo',
           'Sierra','Tango','Uniform','Victor','Whiskey','X-ray','Yankee','Zulu'])[n],
    'Carteira ' || n::text
  );
$$;

-- Idempotente: chamar mil vezes para o mesmo gestor devolve sempre o mesmo codinome.
-- O advisory lock existe porque dois inserts simultaneos (webhook + sync) chegariam
-- ao mesmo max(ordem)+1 e brigariam pelo unique.
create or replace function agency_ops.ensure_wallet(p_gt_owner text)
returns text
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_nome  text;
  v_ordem int;
begin
  if p_gt_owner is null or btrim(p_gt_owner) = '' then
    return null;
  end if;

  select carteira into v_nome from agency_ops.wallet_registry where gt_owner = p_gt_owner;
  if v_nome is not null then
    return v_nome;
  end if;

  perform pg_advisory_xact_lock(hashtext('agency_ops.wallet_registry'));

  select carteira into v_nome from agency_ops.wallet_registry where gt_owner = p_gt_owner;
  if v_nome is not null then
    return v_nome;
  end if;

  select coalesce(max(ordem), 0) + 1 into v_ordem from agency_ops.wallet_registry;
  v_nome := agency_ops.nato_word(v_ordem);

  insert into agency_ops.wallet_registry (gt_owner, ordem, carteira)
  values (p_gt_owner, v_ordem, v_nome);

  return v_nome;
end;
$$;

create or replace function agency_ops.tg_ensure_wallet()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  if tg_table_name = 'team_roster' then
    if new.role = 'GT' and coalesce(new.is_former, false) = false then
      perform agency_ops.ensure_wallet(new.person);
    end if;
  else
    perform agency_ops.ensure_wallet(new.gt_owner);
  end if;
  return null;
end;
$$;

drop trigger if exists ensure_wallet_on_clients on agency_ops.clients;
create trigger ensure_wallet_on_clients
after insert or update of gt_owner on agency_ops.clients
for each row when (new.gt_owner is not null)
execute function agency_ops.tg_ensure_wallet();

drop trigger if exists ensure_wallet_on_gt_assignments on agency_ops.gt_assignments;
create trigger ensure_wallet_on_gt_assignments
after insert or update of gt_owner on agency_ops.gt_assignments
for each row when (new.gt_owner is not null)
execute function agency_ops.tg_ensure_wallet();

drop trigger if exists ensure_wallet_on_team_roster on agency_ops.team_roster;
create trigger ensure_wallet_on_team_roster
after insert or update of role, is_former on agency_ops.team_roster
for each row when (new.role = 'GT')
execute function agency_ops.tg_ensure_wallet();

-- ---------------------------------------------------------------- carga inicial
-- A regra "carteira nova recebe a proxima palavra" aplicada para tras: quem abriu
-- carteira primeiro fica com Alfa. Antiguidade = entrada do cliente mais antigo que
-- a carteira ja' teve, nao a data de cadastro do GT (varios foram cadastrados juntos).
insert into agency_ops.wallet_registry (gt_owner, ordem, carteira)
select antiguidade.gt_owner,
       row_number() over (order by antiguidade.desde nulls last, antiguidade.gt_owner),
       agency_ops.nato_word((row_number() over (order by antiguidade.desde nulls last, antiguidade.gt_owner))::int)
  from (
    select c.gt_owner, min(c.entrada) as desde
      from agency_ops.dashboard_client_overview c
     where c.gt_owner is not null and btrim(c.gt_owner) <> ''
     group by c.gt_owner
  ) antiguidade
on conflict (gt_owner) do nothing;

-- GT do quadro que ainda nao recebeu cliente tambem tem carteira (vazia, mas nomeada).
select agency_ops.ensure_wallet(person)
  from agency_ops.team_roster
 where role = 'GT' and is_former = false;

-- Leitura pronta para o dashboard: carteira, quem opera e o tamanho dela.
create or replace view agency_ops.wallet_overview as
select w.carteira,
       w.ordem,
       w.gt_owner,
       w.criada_em,
       count(c.client_id) filter (where c.lifecycle in ('ACTIVE', 'ONBOARDING')) as clientes_ativos,
       count(c.client_id) filter (where c.lifecycle = 'ONBOARDING')              as clientes_onboarding,
       count(c.client_id) filter (where c.lifecycle = 'CHURNED')                 as clientes_churned,
       min(c.entrada)                                                            as cliente_mais_antigo
  from agency_ops.wallet_registry w
  left join agency_ops.dashboard_client_overview c on c.gt_owner = w.gt_owner
 group by w.carteira, w.ordem, w.gt_owner, w.criada_em;

comment on view agency_ops.wallet_overview is
  'Carteiras nomeadas com quem opera e quantos clientes cada uma tem.';

revoke all on function agency_ops.ensure_wallet(text) from public;
revoke all on function agency_ops.nato_word(int)  from public;
grant execute on function agency_ops.ensure_wallet(text) to service_role;
grant execute on function agency_ops.nato_word(int)  to service_role;
