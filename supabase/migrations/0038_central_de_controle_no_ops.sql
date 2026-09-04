-- Imobi-Board 0038 - o dashboard da agencia como central de controle do CRM
--
-- Decisao do Adler: o perfil dele no agency-ops-dashboard controla o CRM por
-- inteiro -- ve o acesso de cada usuario, altera senha, e o cofre de senhas
-- passa a conter o acesso de todos os usuarios criados.
--
-- Isso exige tres coisas que nao existiam.
--
-- 1. LIGACAO. Uma imobiliaria no Imobi-Board nao sabia de qual cliente do
--    Agency Ops ela e. Sem isso nao ha como dizer em qual cofre o acesso
--    entra.
--
-- 2. IMPRESSAO DA SENHA. O cofre so pode guardar uma senha que alguem
--    conheca, e no Imobi-Board a pessoa cria a propria senha -- o banco guarda
--    o hash. Quando o Adler define a senha pelo console, ela passa a ser
--    conhecida e vale guardar. Mas se o usuario trocar depois, o cofre
--    passaria a mentir em silencio.
--
--    Guardamos entao a impressao do hash (md5 do proprio hash, nao da senha)
--    no momento em que o Adler define. Se a impressao de hoje difere da
--    guardada, a senha foi trocada e o item aparece como DESATUALIZADO. Um
--    cofre que admite nao saber vale mais que um que responde errado.
--
-- 3. LEITURA CENTRAL. Uma consulta que devolve todas as imobiliarias com seus
--    usuarios, papeis, ultimo acesso e situacao do cofre.
--
-- Tudo aqui e service_role: quem chama e a Edge Function do console, que ja
-- verifica que o ator e o Adler com papel MGMT e exige a senha do dashboard.

/* ------------------------------------------------------------ ligacao --- */

alter table imobi_board.tenants
  add column if not exists agency_client_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenants_agency_client_fk'
  ) then
    alter table imobi_board.tenants
      add constraint tenants_agency_client_fk
      foreign key (agency_client_id) references agency_ops.clients(id)
      on delete set null;
  end if;
end $$;

comment on column imobi_board.tenants.agency_client_id is
  'Cliente correspondente no Agency Ops. Define em qual cofre o acesso desta imobiliaria e registrado.';

create index if not exists tenants_agency_client_idx
  on imobi_board.tenants (agency_client_id)
  where agency_client_id is not null;

-- a unica imobiliaria de cliente real ate agora
update imobi_board.tenants
   set agency_client_id = '188c2a8f-654a-40f3-b2c9-13c9b7881c38'
 where slug = 'im-imobiliaria'
   and agency_client_id is null;

/* -------------------------------------------------- impressao da senha --- */

create table if not exists imobi_board.senhas_no_cofre (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid not null references imobi_board.tenants(id) on delete cascade,
  vault_item_id uuid,
  -- md5 do hash bcrypt, nao da senha: serve so para perceber que mudou
  impressao     text not null,
  definida_em   timestamptz not null default now(),
  definida_por  text
);

alter table imobi_board.senhas_no_cofre enable row level security;
-- sem policy: so a chave de servico enxerga, como imobi_board.operadores

comment on table imobi_board.senhas_no_cofre is
  'Marca quais senhas de usuario foram definidas pelo console central e estao '
  'no cofre. A impressao permite descobrir que o usuario trocou a senha depois, '
  'e que o cofre esta desatualizado.';

create or replace function imobi_board.impressao_da_senha(p_user_id uuid)
returns text
language sql stable security definer set search_path = ''
as $fn$
  select md5(u.encrypted_password) from auth.users u where u.id = p_user_id;
$fn$;

create or replace function imobi_board.marcar_senha_no_cofre(
  p_user_id uuid,
  p_tenant  uuid,
  p_item    uuid,
  p_por     text
) returns void
language plpgsql security definer set search_path = ''
as $fn$
begin
  insert into imobi_board.senhas_no_cofre
    (user_id, tenant_id, vault_item_id, impressao, definida_em, definida_por)
  values
    (p_user_id, p_tenant, p_item, imobi_board.impressao_da_senha(p_user_id), now(), p_por)
  on conflict (user_id) do update
    set tenant_id     = excluded.tenant_id,
        vault_item_id = excluded.vault_item_id,
        impressao     = excluded.impressao,
        definida_em   = excluded.definida_em,
        definida_por  = excluded.definida_por;
end;
$fn$;

/* ------------------------------------------------------------ leitura --- */

create or replace function imobi_board.central_do_crm()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(jsonb_agg(x order by x->>'nome'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'tenant_id',        t.id,
      'nome',             t.name,
      'slug',             t.slug,
      'situacao',         t.status,
      'agency_client_id', t.agency_client_id,
      'cliente',          (select c.display_name from agency_ops.clients c
                            where c.id = t.agency_client_id),
      'leads',            (select count(*) from imobi_board.opportunities o
                            where o.tenant_id = t.id),
      'usuarios', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'user_id',      u.id,
          'email',        u.email,
          'nome',         coalesce(p.full_name, split_part(u.email, '@', 1)),
          'papel',        m.role,
          'situacao',     m.status,
          'ultimo_acesso', u.last_sign_in_at,
          'entrou_em',    m.created_at,
          'no_cofre',     s.vault_item_id is not null,
          'senha_definida_em', s.definida_em,
          -- o usuario trocou a senha depois que o console a definiu?
          'senha_desatualizada',
            s.impressao is not null and s.impressao <> md5(u.encrypted_password)
        ) order by m.role, u.email), '[]'::jsonb)
        from imobi_board.memberships m
        join auth.users u on u.id = m.user_id
        left join imobi_board.profiles p on p.id = m.user_id
        left join imobi_board.senhas_no_cofre s on s.user_id = m.user_id
        where m.tenant_id = t.id and m.status = 'ACTIVE'
      ),
      'convites_pendentes', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'email', i.email, 'papel', i.role, 'expira_em', i.expires_at
        ) order by i.created_at desc), '[]'::jsonb)
        from imobi_board.invites i
        where i.tenant_id = t.id and i.accepted_at is null and i.revoked_at is null
          and i.expires_at > now()
      )
    ) as x
    from imobi_board.tenants t
  ) s;
$fn$;

/* ----------------------------------------------------------- permissao --- */

revoke execute on function imobi_board.central_do_crm()                        from public, authenticated;
revoke execute on function imobi_board.impressao_da_senha(uuid)                from public, authenticated;
revoke execute on function imobi_board.marcar_senha_no_cofre(uuid, uuid, uuid, text) from public, authenticated;

grant execute on function imobi_board.central_do_crm()                         to service_role;
grant execute on function imobi_board.impressao_da_senha(uuid)                 to service_role;
grant execute on function imobi_board.marcar_senha_no_cofre(uuid, uuid, uuid, text) to service_role;
