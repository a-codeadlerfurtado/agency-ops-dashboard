-- Duas tabelas novas nasceram sem RLS, diferente das vizinhas (clients, team_roster,
-- user_preferences). Os grants ja' negam anon/authenticated, mas a casa liga RLS como
-- segunda tranca: se um dia alguem expuser o schema ou conceder SELECT por engano, a
-- tabela continua fechada. Sem policy = ninguem le, exceto quem tem BYPASSRLS
-- (service_role, usado pelas edge functions) e o dono (as funcoes security definer).
alter table agency_ops.wallet_registry            enable row level security;
alter table agency_ops.dashboard_view_permissions enable row level security;

-- search_path fixo: o linter aponta a funcao como mutavel, e uma funcao sem schema
-- amarrado pode resolver nome diferente dependendo de quem chama.
create or replace function agency_ops.nato_word(n int)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(
    (array['Alfa','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India',
           'Juliett','Kilo','Lima','Mike','November','Oscar','Papa','Quebec','Romeo',
           'Sierra','Tango','Uniform','Victor','Whiskey','X-ray','Yankee','Zulu'])[n],
    'Carteira ' || n::text
  );
$$;

revoke all on function agency_ops.nato_word(int) from public;
grant execute on function agency_ops.nato_word(int) to service_role;
