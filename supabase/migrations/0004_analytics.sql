-- Imobi-Board 0004 - agregacoes (spec 22 / 23 / 47 / 48 / 49 / 50)
--
-- Tudo resolvido no banco e devolvido pronto. O painel completo do ADMIN
-- (8 cards + funil de 6 etapas + quebra por origem) e UMA chamada, nao 15.

-- Funil acumulado: uma oportunidade em PROPOSTA tambem conta em NOVO,
-- CONTATADO, QUALIFICADO e VISITA. E a leitura que o gestor espera.
create or replace function imobi_board.dashboard_admin(
  p_tenant_id uuid,
  p_desde     timestamptz default now() - interval '30 days',
  p_ate       timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
  v_out jsonb;
begin
  select exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = p_tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) into v_ok;

  if not v_ok then
    raise exception 'Apenas o administrador da imobiliaria ve este painel.'
      using errcode = '42501';
  end if;

  with base as (
    select o.*, s.sort_order, s.kind
    from imobi_board.opportunities o
    join imobi_board.pipeline_stages s on s.id = o.stage_id
    where o.tenant_id = p_tenant_id
      and o.created_at >= p_desde and o.created_at < p_ate
  ),
  cards as (
    select jsonb_build_object(
      'leads',        count(*),
      'atendidos',    count(*) filter (where first_contact_at is not null),
      'qualificados', count(*) filter (where qualified_at is not null),
      'visitas',      count(*) filter (where sort_order >= 3),
      'propostas',    count(*) filter (where sort_order >= 4),
      'vendas',       count(*) filter (where status = 'WON'),
      -- null, nao zero: as tabelas que alimentam estes dois ainda nao existem.
      -- A UI mostra "--" em vez de fingir um numero.
      'vgv',          null,
      'sla_perdido',  null
    ) as j from base
  ),
  funil as (
    select coalesce(jsonb_agg(x order by x.ord), '[]'::jsonb) as j from (
      select s.sort_order as ord, s.name as etapa, s.kind,
             (select count(*) from base b where b.sort_order >= s.sort_order) as total
      from imobi_board.pipeline_stages s
      join imobi_board.pipelines p on p.id = s.pipeline_id
      where p.tenant_id = p_tenant_id and p.is_default
      order by s.sort_order
    ) x
  ),
  origens as (
    select coalesce(jsonb_agg(x order by x.leads desc), '[]'::jsonb) as j from (
      select source as origem, count(*) as leads,
             count(*) filter (where status = 'WON') as vendas,
             count(*) filter (where qualified_at is not null) as qualificados
      from base group by source
    ) x
  )
  select jsonb_build_object(
    'cards',   (select j from cards),
    'funil',   (select j from funil),
    'origens', (select j from origens),
    'periodo', jsonb_build_object('desde', p_desde, 'ate', p_ate)
  ) into v_out;

  return v_out;
end;
$fn$;

-- Ranking (spec 47). ADMIN apenas: um BROKER chamando recebe 42501.
create or replace function imobi_board.ranking_corretores(
  p_tenant_id uuid,
  p_desde     timestamptz default now() - interval '30 days',
  p_ate       timestamptz default now()
) returns table (
  user_id uuid, nome text,
  leads bigint, aceitos bigint, contatados bigint, qualificados bigint,
  vendas bigint, parados bigint,
  min_ate_aceite numeric, min_ate_contato numeric, conversao numeric
)
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_ok boolean;
begin
  select exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = p_tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) into v_ok;

  if not v_ok then
    raise exception 'Apenas o administrador da imobiliaria ve o ranking.'
      using errcode = '42501';
  end if;

  return query
  select
    m.user_id,
    coalesce(pr.full_name, 'Sem nome')::text,
    count(o.id),
    count(o.id) filter (where o.accepted_at is not null),
    count(o.id) filter (where o.first_contact_at is not null),
    count(o.id) filter (where o.qualified_at is not null),
    count(o.id) filter (where o.status = 'WON'),
    count(o.id) filter (where o.status = 'OPEN'
                          and o.last_interaction_at < now() - interval '7 days'),
    round(avg(extract(epoch from (o.accepted_at - o.created_at)) / 60)
            filter (where o.accepted_at is not null), 1),
    round(avg(extract(epoch from (o.first_contact_at - o.created_at)) / 60)
            filter (where o.first_contact_at is not null), 1),
    round(100.0 * count(o.id) filter (where o.status = 'WON')
          / nullif(count(o.id), 0), 1)
  from imobi_board.memberships m
  join imobi_board.profiles pr on pr.id = m.user_id
  left join imobi_board.opportunities o
    on o.assigned_user_id = m.user_id
   and o.tenant_id = p_tenant_id
   and o.created_at >= p_desde and o.created_at < p_ate
  where m.tenant_id = p_tenant_id and m.status = 'ACTIVE' and m.role = 'BROKER'
  group by m.user_id, pr.full_name
  order by count(o.id) filter (where o.status = 'WON') desc, count(o.id) desc;
end;
$fn$;

-- Painel do corretor (spec 22). Nao recebe user_id como parametro de proposito:
-- assim nao existe superficie para espiar o dia de um colega.
create or replace function imobi_board.dashboard_broker(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = p_tenant_id and m.status = 'ACTIVE'
  ) then
    raise exception 'Voce nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'novos', (
      select count(*) from imobi_board.opportunities o
      join imobi_board.pipeline_stages s on s.id = o.stage_id
      where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
        and s.kind = 'NEW' and o.status = 'OPEN'),
    'sem_aceite', (
      select count(*) from imobi_board.opportunities o
      where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
        and o.accepted_at is null and o.status = 'OPEN'),
    'followups_hoje', (
      select count(*) from imobi_board.tasks t
      where t.assigned_user_id = v_uid and t.status = 'OPEN'
        and t.due_at >= date_trunc('day', now())
        and t.due_at <  date_trunc('day', now()) + interval '1 day'),
    'followups_atrasados', (
      select count(*) from imobi_board.tasks t
      where t.assigned_user_id = v_uid and t.status = 'OPEN'
        and t.due_at < date_trunc('day', now())),
    'em_proposta', (
      select count(*) from imobi_board.opportunities o
      join imobi_board.pipeline_stages s on s.id = o.stage_id
      where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
        and s.kind = 'PROPOSAL' and o.status = 'OPEN'),
    'vendas', (
      select count(*) from imobi_board.opportunities o
      where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
        and o.status = 'WON'),
    'parados_30d', (
      select count(*) from imobi_board.opportunities o
      where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
        and o.status = 'OPEN'
        and o.last_interaction_at < now() - interval '30 days')
  ) into v_out;

  return v_out;
end;
$fn$;

-- Leads esquecidos (spec 23). Sem IA e sem cron: uma consulta sobre o indice
-- parcial opportunities_stale_idx, disparada quando a tela abre.
create or replace function imobi_board.leads_parados(
  p_tenant_id uuid,
  p_dias      int default 30
) returns table (faixa text, total bigint)
language sql stable security definer set search_path = ''
as $fn$
  select faixa, count(*)::bigint
  from (
    select case
             when o.last_interaction_at < now() - interval '60 days' then '60+'
             when o.last_interaction_at < now() - interval '30 days' then '30-60'
             when o.last_interaction_at < now() - interval '15 days' then '15-30'
             when o.last_interaction_at < now() - interval '7 days'  then '7-15'
           end as faixa
    from imobi_board.opportunities o
    where o.tenant_id = p_tenant_id
      and o.status = 'OPEN'
      and o.last_interaction_at < now() - interval '7 days'
      and (
        o.assigned_user_id = (select auth.uid())
        or exists (
          select 1 from imobi_board.memberships m
          where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant_id
            and m.status = 'ACTIVE' and m.role = 'ADMIN')
      )
  ) x
  where faixa is not null
  group by faixa
  order by faixa;
$fn$;

revoke execute on function imobi_board.dashboard_admin(uuid, timestamptz, timestamptz) from public;
revoke execute on function imobi_board.ranking_corretores(uuid, timestamptz, timestamptz) from public;
revoke execute on function imobi_board.dashboard_broker(uuid) from public;
revoke execute on function imobi_board.leads_parados(uuid, int) from public;

grant execute on function imobi_board.dashboard_admin(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function imobi_board.ranking_corretores(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function imobi_board.dashboard_broker(uuid) to authenticated;
grant execute on function imobi_board.leads_parados(uuid, int) to authenticated;
