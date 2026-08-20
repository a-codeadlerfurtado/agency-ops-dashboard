-- Permissao POR ABA do dashboard.
--
-- Ate' aqui o que cada pessoa via era decidido por um unico nivel grosso
-- (team_roster.access_level: FULL / WALLET_ONLY / RESTRICTED). Isso mistura duas
-- perguntas diferentes:
--   1) QUANTO DADO a pessoa alcanca (carteira propria x base inteira)  -> access_level
--   2) QUAIS TELAS a pessoa abre                                       -> esta tabela
-- Sem a segunda, dar acesso a Alertas para o CS obrigava a dar tambem Auditoria e
-- Evidencias, que sao telas de gestao. Agora as duas perguntas sao independentes.
--
-- Resolucao: regra por PERSON vence a regra por ROLE. Ausencia de regra = negado.
-- Editar permissao passa a ser um UPDATE, nao um deploy.

create table if not exists agency_ops.dashboard_view_permissions (
  view_key    text        not null,
  scope_type  text        not null check (scope_type in ('ROLE', 'PERSON')),
  scope_value text        not null,
  allowed     boolean     not null default true,
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (view_key, scope_type, scope_value)
);

create index if not exists dashboard_view_permissions_scope_idx
  on agency_ops.dashboard_view_permissions (scope_type, scope_value);

comment on table agency_ops.dashboard_view_permissions is
  'Quais abas do dashboard cada papel/pessoa abre. PERSON sobrescreve ROLE; sem regra = negado.';

-- Resolve a lista final de abas de uma pessoa. O full outer join e' o que faz o
-- override por pessoa poder tanto LIBERAR uma aba que o papel nao tem quanto
-- TIRAR uma aba que o papel tem.
create or replace function agency_ops.dashboard_allowed_views(p_person text, p_role text)
returns text[]
language sql
stable
security definer
set search_path = agency_ops, public
as $$
  with por_papel as (
    select view_key, allowed
      from agency_ops.dashboard_view_permissions
     where scope_type = 'ROLE' and scope_value = coalesce(p_role, '')
  ),
  por_pessoa as (
    select view_key, allowed
      from agency_ops.dashboard_view_permissions
     where scope_type = 'PERSON' and scope_value = coalesce(p_person, '')
  ),
  final as (
    select coalesce(pessoa.view_key, papel.view_key) as view_key,
           coalesce(pessoa.allowed,  papel.allowed)  as allowed
      from por_papel papel
      full outer join por_pessoa pessoa on pessoa.view_key = papel.view_key
  )
  select coalesce(array_agg(view_key order by view_key), '{}'::text[])
    from final
   where allowed;
$$;

-- So' quem chama e' a edge function, com service role. PUBLIC nao precisa executar.
revoke all on function agency_ops.dashboard_allowed_views(text, text) from public;
grant execute on function agency_ops.dashboard_allowed_views(text, text) to service_role;

-- ---------------------------------------------------------------- padrao por papel
insert into agency_ops.dashboard_view_permissions (view_key, scope_type, scope_value, allowed, note)
select aba, 'ROLE', papel.role, true, 'padrao do papel'
  from (values
    ('MGMT',   array['overview','focus','onboarding','campaigns','conversations','team','diary','clickup','evidence','audit','alerts']),
    ('AI',     array['overview','focus','onboarding','campaigns','conversations','team','diary','clickup','evidence','audit','alerts']),
    ('CS',     array['overview','focus','onboarding','campaigns','conversations','diary','clickup','alerts']),
    ('GT',     array['overview','focus','onboarding','campaigns','conversations','diary','clickup','alerts']),
    ('DESIGN', array['overview','focus','diary','clickup'])
  ) as papel(role, abas),
  unnest(papel.abas) as aba
on conflict (view_key, scope_type, scope_value)
do update set allowed = excluded.allowed, note = excluded.note, updated_at = now();

-- Negacoes explicitas: ficam registradas para quem for ler a tabela depois entender
-- que a ausencia da aba e' decisao, nao esquecimento.
insert into agency_ops.dashboard_view_permissions (view_key, scope_type, scope_value, allowed, note)
select aba, 'ROLE', papel.role, false, motivo
  from (values
    ('MGMT',   array['clients','preclients'], 'carteira e funil comercial: liberados nominalmente'),
    ('AI',     array['clients','preclients'], 'carteira e funil comercial: liberados nominalmente'),
    ('CS',     array['clients','preclients','team','evidence','audit'], 'telas de gestao e funil comercial'),
    ('GT',     array['clients','preclients','team','evidence','audit'], 'telas de gestao e funil comercial'),
    ('DESIGN', array['clients','preclients','team','evidence','audit','onboarding','campaigns','conversations','alerts'], 'fora da operacao de design')
  ) as papel(role, abas, motivo),
  unnest(papel.abas) as aba
on conflict (view_key, scope_type, scope_value)
do update set allowed = excluded.allowed, note = excluded.note, updated_at = now();

-- ------------------------------------------------------------ excecoes por pessoa
insert into agency_ops.dashboard_view_permissions (view_key, scope_type, scope_value, allowed, note) values
  ('clients',    'PERSON', 'Adler Furtado',  true, 'gestor operacional'),
  ('preclients', 'PERSON', 'Adler Furtado',  true, 'funil comercial: exclusividade do Adler'),
  ('clients',    'PERSON', 'Joel Antoniete', true, 'CS responsavel pela leitura de carteira')
on conflict (view_key, scope_type, scope_value)
do update set allowed = excluded.allowed, note = excluded.note, updated_at = now();
