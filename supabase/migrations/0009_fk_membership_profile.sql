-- Imobi-Board 0009 - FK memberships -> profiles
--
-- Encontrado rodando o app, nao no typecheck: o PostgREST recusava
--   "Could not find a relationship between 'memberships' and 'profiles'"
-- porque as duas so se ligavam indiretamente, via auth.users. Sem FK direta o
-- PostgREST nao consegue embutir uma na outra.
--
-- NAO uso trigger em auth.users para popular profiles: auth.users e
-- compartilhada com os outros sistemas deste projeto Supabase, e um trigger ali
-- criaria profile do Imobi-Board para usuario de agency_ops, crm e sdr_monitor.

insert into imobi_board.profiles (id, full_name)
select distinct m.user_id, u.raw_user_meta_data ->> 'full_name'
from imobi_board.memberships m
join auth.users u on u.id = m.user_id
where not exists (select 1 from imobi_board.profiles p where p.id = m.user_id);

alter table imobi_board.memberships
  add constraint memberships_profile_fk
  foreign key (user_id) references imobi_board.profiles(id) on delete cascade;

-- provision_tenant passa a criar o profile de quem abre a imobiliaria, senao a
-- nova FK rejeita o membership.
create or replace function imobi_board.provision_tenant(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_pipeline uuid;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  insert into imobi_board.profiles (id, full_name)
  select v_uid, u.raw_user_meta_data ->> 'full_name'
  from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  insert into imobi_board.tenants (name, slug) values (p_name, p_slug)
  returning id into v_tenant;

  insert into imobi_board.memberships (tenant_id, user_id, role)
  values (v_tenant, v_uid, 'ADMIN');

  insert into imobi_board.pipelines (tenant_id, name, is_default)
  values (v_tenant, 'Funil padrao', true) returning id into v_pipeline;

  insert into imobi_board.pipeline_stages (tenant_id, pipeline_id, name, kind, sort_order)
  values
    (v_tenant, v_pipeline, 'Novo',        'NEW',        0),
    (v_tenant, v_pipeline, 'Contatado',   'CONTACTED',  1),
    (v_tenant, v_pipeline, 'Qualificado', 'QUALIFIED',  2),
    (v_tenant, v_pipeline, 'Visita',      'VISIT',      3),
    (v_tenant, v_pipeline, 'Proposta',    'PROPOSAL',   4),
    (v_tenant, v_pipeline, 'Venda',       'WON',        5);

  return v_tenant;
end;
$fn$;

notify pgrst, 'reload schema';
