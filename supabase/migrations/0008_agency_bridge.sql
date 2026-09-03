-- Imobi-Board 0008 - contrato do bridge com o dashboard da agencia (spec 55)
--
-- Somente agregados: nenhum nome, telefone ou e-mail de lead sai por aqui.
-- Isso e proposital - a agencia precisa saber que a campanha converteu, nao
-- quem e o cliente da imobiliaria.
--
-- Grant apenas para service_role: nao existe caminho pelo navegador. E o
-- endpoint do Worker que exige Bearer AGENCY_BRIDGE_TOKEN.
--
-- Nesta fase o contrato EXISTE mas nao esta conectado a producao nenhuma.

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
  por as (
    select coalesce(jsonb_agg(distinct jsonb_build_object(
             'id', campaign_id, 'name', campaign_name))
             filter (where campaign_id is not null), '[]'::jsonb) as campanhas
    from base
  )
  select jsonb_build_object(
    'tenant_id', p_tenant_id,
    'periodo',   jsonb_build_object('desde', p_desde, 'ate', p_ate),
    'leads',     (select count(*) from base),
    'contacted', (select count(*) from base where first_contact_at is not null),
    'qualified', (select count(*) from base where qualified_at is not null),
    'visits',    (select count(*) from base where sort_order >= 3),
    'proposals', (select count(*) from base where sort_order >= 4),
    'sales',     (select count(*) from base where status = 'WON'),
    'vgv',       null,   -- chega com o modulo de vendas (PASSO 19)
    'breakdown', jsonb_build_object(
      'campaign', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select campaign_id as id, campaign_name as name, count(*) as leads,
                 count(*) filter (where qualified_at is not null) as qualified,
                 count(*) filter (where status = 'WON') as sales
          from base where campaign_id is not null
          group by campaign_id, campaign_name order by count(*) desc limit 50) x),
      'adset', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select adset_id as id, adset_name as name, count(*) as leads,
                 count(*) filter (where status = 'WON') as sales
          from base where adset_id is not null
          group by adset_id, adset_name order by count(*) desc limit 50) x),
      'ad', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select ad_id as id, ad_name as name, count(*) as leads,
                 count(*) filter (where status = 'WON') as sales
          from base where ad_id is not null
          group by ad_id, ad_name order by count(*) desc limit 50) x)
    )
  )
  from por;
$fn$;

revoke execute on function imobi_board.agency_performance(uuid, timestamptz, timestamptz)
  from public, authenticated, anon;
grant execute on function imobi_board.agency_performance(uuid, timestamptz, timestamptz)
  to service_role;
