-- Imobi-Board 0014 - analytics com VGV, SLA e atribuicao de venda reais
-- (spec PASSO 20, secoes 46-50, 54-55)
--
-- Substitui os `null` que a 0004 devolvia em vgv e sla_perdido: as tabelas que
-- alimentam esses numeros passaram a existir na 0012.
--
-- Duas bases de contagem, de proposito:
--   leads    -> pela data de ENTRADA (coorte)
--   visita, proposta, venda -> pela data DELAS
-- Uma venda fechada em setembro de um lead que entrou em junho e uma venda de
-- setembro. A UI rotula os dois cortes para nao parecerem contradicao.

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
  vendas as (
    select count(*) as n, coalesce(sum(sale_value), 0) as vgv
    from imobi_board.sales
    where tenant_id = p_tenant_id and cancelled_at is null
      and sold_at >= p_desde and sold_at < p_ate
  ),
  vis as (
    select count(*) as n from imobi_board.visits
    where tenant_id = p_tenant_id
      and scheduled_at >= p_desde and scheduled_at < p_ate
      and status <> 'CANCELLED'
  ),
  props as (
    select count(*) as n from imobi_board.proposals
    where tenant_id = p_tenant_id and status <> 'CANCELLED'
      and created_at >= p_desde and created_at < p_ate
  ),
  sla as (
    select count(*) as n from imobi_board.lead_assignments
    where tenant_id = p_tenant_id and status in ('MISSED','REASSIGNED')
      and assigned_at >= p_desde and assigned_at < p_ate
  ),
  cards as (
    select jsonb_build_object(
      'leads',        (select count(*) from base),
      'atendidos',    (select count(*) from base where first_contact_at is not null),
      'qualificados', (select count(*) from base where qualified_at is not null),
      'visitas',      (select n from vis),
      'propostas',    (select n from props),
      'vendas',       (select n from vendas),
      'vgv',          (select vgv from vendas),
      'sla_perdido',  (select n from sla)
    ) as j
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
      select b.source as origem, count(*) as leads,
             count(*) filter (where b.qualified_at is not null) as qualificados,
             count(sv.id) as vendas,
             coalesce(sum(sv.sale_value), 0) as vgv
      from base b
      left join imobi_board.sales sv
        on sv.opportunity_id = b.id and sv.cancelled_at is null
      group by b.source
    ) x
  ),
  campanhas as (
    select coalesce(jsonb_agg(x order by x.vgv desc), '[]'::jsonb) as j from (
      select coalesce(s.campaign_name, 'Sem campanha') as campanha,
             count(*) as vendas, coalesce(sum(s.sale_value), 0) as vgv
      from imobi_board.sales s
      where s.tenant_id = p_tenant_id and s.cancelled_at is null
        and s.sold_at >= p_desde and s.sold_at < p_ate
      group by s.campaign_name
    ) x
  )
  select jsonb_build_object(
    'cards',     (select j from cards),
    'funil',     (select j from funil),
    'origens',   (select j from origens),
    'campanhas', (select j from campanhas),
    'periodo',   jsonb_build_object('desde', p_desde, 'ate', p_ate)
  ) into v_out;

  return v_out;
end;
$fn$;

-- Ranking completo da spec 47: agora com SLA perdido, visitas, propostas e VGV.
drop function if exists imobi_board.ranking_corretores(uuid, timestamptz, timestamptz);
create or replace function imobi_board.ranking_corretores(
  p_tenant_id uuid,
  p_desde     timestamptz default now() - interval '30 days',
  p_ate       timestamptz default now()
) returns table (
  user_id uuid, nome text,
  leads bigint, aceitos bigint, sla_perdido bigint, contatados bigint,
  qualificados bigint, visitas bigint, propostas bigint, vendas bigint,
  vgv numeric, parados bigint,
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
    count(distinct o.id),
    count(distinct o.id) filter (where o.accepted_at is not null),
    (select count(*) from imobi_board.lead_assignments la
      where la.user_id = m.user_id and la.tenant_id = p_tenant_id
        and la.status in ('MISSED','REASSIGNED')
        and la.assigned_at >= p_desde and la.assigned_at < p_ate),
    count(distinct o.id) filter (where o.first_contact_at is not null),
    count(distinct o.id) filter (where o.qualified_at is not null),
    (select count(*) from imobi_board.visits v
      where v.broker_id = m.user_id and v.tenant_id = p_tenant_id
        and v.scheduled_at >= p_desde and v.scheduled_at < p_ate
        and v.status <> 'CANCELLED'),
    (select count(*) from imobi_board.proposals pp
      where pp.broker_id = m.user_id and pp.tenant_id = p_tenant_id
        and pp.status <> 'CANCELLED'
        and pp.created_at >= p_desde and pp.created_at < p_ate),
    (select count(*) from imobi_board.sales s
      where s.broker_id = m.user_id and s.tenant_id = p_tenant_id
        and s.cancelled_at is null
        and s.sold_at >= p_desde and s.sold_at < p_ate),
    (select coalesce(sum(s.sale_value), 0) from imobi_board.sales s
      where s.broker_id = m.user_id and s.tenant_id = p_tenant_id
        and s.cancelled_at is null
        and s.sold_at >= p_desde and s.sold_at < p_ate),
    count(distinct o.id) filter (where o.status = 'OPEN'
                          and o.last_interaction_at < now() - interval '7 days'),
    round(avg(extract(epoch from (o.accepted_at - o.created_at)) / 60)
            filter (where o.accepted_at is not null), 1),
    round(avg(extract(epoch from (o.first_contact_at - o.created_at)) / 60)
            filter (where o.first_contact_at is not null), 1),
    round(100.0 * count(distinct o.id) filter (where o.status = 'WON')
          / nullif(count(distinct o.id), 0), 1)
  from imobi_board.memberships m
  join imobi_board.profiles pr on pr.id = m.user_id
  left join imobi_board.opportunities o
    on o.assigned_user_id = m.user_id and o.tenant_id = p_tenant_id
   and o.created_at >= p_desde and o.created_at < p_ate
  where m.tenant_id = p_tenant_id and m.status = 'ACTIVE' and m.role = 'BROKER'
  group by m.user_id, pr.full_name
  order by 11 desc, 10 desc, 3 desc;
end;
$fn$;

-- Painel do corretor: visitas de hoje, propostas abertas e VGV proprio
create or replace function imobi_board.dashboard_broker(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_out jsonb;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = p_tenant_id and m.status = 'ACTIVE') then
    raise exception 'Voce nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'novos', (select count(*) from imobi_board.opportunities o
              join imobi_board.pipeline_stages s on s.id = o.stage_id
              where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
                and s.kind = 'NEW' and o.status = 'OPEN'),
    'sem_aceite', (select count(*) from imobi_board.opportunities o
                   where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
                     and o.accepted_at is null and o.status = 'OPEN'),
    'followups_hoje', (select count(*) from imobi_board.tasks t
                       where t.assigned_user_id = v_uid and t.status = 'OPEN'
                         and t.due_at >= date_trunc('day', now())
                         and t.due_at < date_trunc('day', now()) + interval '1 day'),
    'followups_atrasados', (select count(*) from imobi_board.tasks t
                            where t.assigned_user_id = v_uid and t.status = 'OPEN'
                              and t.due_at < date_trunc('day', now())),
    'visitas_hoje', (select count(*) from imobi_board.visits v
                     where v.broker_id = v_uid and v.status = 'SCHEDULED'
                       and v.scheduled_at >= date_trunc('day', now())
                       and v.scheduled_at < date_trunc('day', now()) + interval '1 day'),
    'em_proposta', (select count(*) from imobi_board.proposals p
                    where p.broker_id = v_uid and p.tenant_id = p_tenant_id
                      and p.status in ('DRAFT','SENT','NEGOTIATING')),
    'vendas', (select count(*) from imobi_board.sales s
               where s.broker_id = v_uid and s.tenant_id = p_tenant_id
                 and s.cancelled_at is null),
    'vgv', (select coalesce(sum(s.sale_value), 0) from imobi_board.sales s
            where s.broker_id = v_uid and s.tenant_id = p_tenant_id
              and s.cancelled_at is null),
    'parados_30d', (select count(*) from imobi_board.opportunities o
                    where o.assigned_user_id = v_uid and o.tenant_id = p_tenant_id
                      and o.status = 'OPEN'
                      and o.last_interaction_at < now() - interval '30 days')
  ) into v_out;
  return v_out;
end;
$fn$;

-- Bridge da agencia com atribuicao de venda de verdade (spec 54/55)
create or replace function imobi_board.agency_performance(
  p_tenant_id uuid,
  p_desde     timestamptz default now() - interval '30 days',
  p_ate       timestamptz default now()
) returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  with base as (
    select o.*, s.sort_order
    from imobi_board.opportunities o
    join imobi_board.pipeline_stages s on s.id = o.stage_id
    where o.tenant_id = p_tenant_id
      and o.created_at >= p_desde and o.created_at < p_ate
  ),
  vd as (
    select * from imobi_board.sales
    where tenant_id = p_tenant_id and cancelled_at is null
      and sold_at >= p_desde and sold_at < p_ate
  )
  select jsonb_build_object(
    'tenant_id', p_tenant_id,
    'periodo',   jsonb_build_object('desde', p_desde, 'ate', p_ate),
    'leads',     (select count(*) from base),
    'contacted', (select count(*) from base where first_contact_at is not null),
    'qualified', (select count(*) from base where qualified_at is not null),
    'visits',    (select count(*) from imobi_board.visits v
                   where v.tenant_id = p_tenant_id and v.status <> 'CANCELLED'
                     and v.scheduled_at >= p_desde and v.scheduled_at < p_ate),
    'proposals', (select count(*) from imobi_board.proposals p
                   where p.tenant_id = p_tenant_id and p.status <> 'CANCELLED'
                     and p.created_at >= p_desde and p.created_at < p_ate),
    'sales',     (select count(*) from vd),
    'vgv',       (select coalesce(sum(sale_value), 0) from vd),
    'breakdown', jsonb_build_object(
      'campaign', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select b.campaign_id as id, b.campaign_name as name, count(*) as leads,
               count(*) filter (where b.qualified_at is not null) as qualified,
               (select count(*) from vd where vd.campaign_id = b.campaign_id) as sales,
               (select coalesce(sum(sale_value),0) from vd where vd.campaign_id = b.campaign_id) as vgv
        from base b where b.campaign_id is not null
        group by b.campaign_id, b.campaign_name order by count(*) desc limit 50) x),
      'adset', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select b.adset_id as id, b.adset_name as name, count(*) as leads,
               (select count(*) from vd where vd.adset_id = b.adset_id) as sales
        from base b where b.adset_id is not null
        group by b.adset_id, b.adset_name order by count(*) desc limit 50) x),
      'ad', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select b.ad_id as id, b.ad_name as name, count(*) as leads,
               (select count(*) from vd where vd.ad_id = b.ad_id) as sales
        from base b where b.ad_id is not null
        group by b.ad_id, b.ad_name order by count(*) desc limit 50) x)
    )
  );
$fn$;

revoke execute on function imobi_board.ranking_corretores(uuid, timestamptz, timestamptz) from public;
grant execute on function imobi_board.ranking_corretores(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function imobi_board.agency_performance(uuid, timestamptz, timestamptz) from public, authenticated, anon;
grant execute on function imobi_board.agency_performance(uuid, timestamptz, timestamptz) to service_role;
