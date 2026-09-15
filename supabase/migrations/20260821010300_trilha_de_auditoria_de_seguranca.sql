-- Hoje, mudar quem enxerga o que e' um UPDATE solto. Nao fica registrado quem
-- promoveu alguem a FULL, quem liberou uma aba, quem reativou uma chave de acesso
-- total nem quando. Eu mesmo mudei o nivel do Gustavo por UPDATE nesta sessao - o
-- unico rastro virou o commit do git, que e' rastro de codigo, nao de producao.
--
-- Sem trilha nao existe investigacao: se amanha alguem aparecer com acesso que nao
-- deveria ter, nao ha' como saber se foi engano, teste esquecido ou invasao.
create table if not exists agency_ops.security_audit_log (
  id          bigint generated always as identity primary key,
  ocorrido_em timestamptz not null default now(),
  tabela      text        not null,
  operacao    text        not null,
  chave       text,
  antes       jsonb,
  depois      jsonb,
  papel_db    text        not null default current_user,
  -- current_setting captura o usuario logado quando a mudanca vem pela API do
  -- Supabase; por psql ou cron fica nulo, e ai' o papel_db e' quem responde.
  usuario_app text
);

create index if not exists security_audit_log_tempo_idx  on agency_ops.security_audit_log (ocorrido_em desc);
create index if not exists security_audit_log_tabela_idx on agency_ops.security_audit_log (tabela, ocorrido_em desc);

alter table agency_ops.security_audit_log enable row level security;

comment on table agency_ops.security_audit_log is
  'Trilha de mudancas de permissao e credencial. Quem muda acesso deixa rastro.';

create or replace function agency_ops.tg_security_audit()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_antes  jsonb;
  v_depois jsonb;
  v_app    text;
begin
  -- NEW nao existe em DELETE e OLD nao existe em INSERT: montar cada lado a parte.
  if tg_op in ('UPDATE', 'DELETE') then v_antes  := to_jsonb(old); end if;
  if tg_op in ('UPDATE', 'INSERT') then v_depois := to_jsonb(new); end if;

  begin
    v_app := nullif(current_setting('request.jwt.claim.sub', true), '');
  exception when others then
    v_app := null;
  end;

  insert into agency_ops.security_audit_log (tabela, operacao, chave, antes, depois, usuario_app)
  values (
    tg_table_name,
    tg_op,
    coalesce(
      coalesce(v_depois, v_antes) ->> 'person',
      coalesce(v_depois, v_antes) ->> 'view_key',
      coalesce(v_depois, v_antes) ->> 'label',
      coalesce(v_depois, v_antes) ->> 'user_key',
      coalesce(v_depois, v_antes) ->> 'key'
    ),
    v_antes,
    v_depois,
    v_app
  );
  return null;
end;
$$;

-- As quatro superficies onde acesso nasce, muda ou e' concedido.
drop trigger if exists audita_team_roster on agency_ops.team_roster;
create trigger audita_team_roster after insert or update or delete on agency_ops.team_roster
for each row execute function agency_ops.tg_security_audit();

drop trigger if exists audita_view_permissions on agency_ops.dashboard_view_permissions;
create trigger audita_view_permissions after insert or update or delete on agency_ops.dashboard_view_permissions
for each row execute function agency_ops.tg_security_audit();

drop trigger if exists audita_api_keys on agency_ops.dashboard_api_keys;
create trigger audita_api_keys after insert or update or delete on agency_ops.dashboard_api_keys
for each row execute function agency_ops.tg_security_audit();

drop trigger if exists audita_access_requests on agency_ops.access_requests;
create trigger audita_access_requests after insert or update or delete on agency_ops.access_requests
for each row execute function agency_ops.tg_security_audit();

revoke all on function agency_ops.tg_security_audit() from public, anon, authenticated;
revoke all on agency_ops.security_audit_log from anon, authenticated;
