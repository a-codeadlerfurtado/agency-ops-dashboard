-- Entradas no mês deve representar apenas clientes que entraram no período e ainda
-- permanecem na operação (ACTIVE/ONBOARDING). Clientes CHURNED, inclusive vendas
-- caídas, não aparecem neste KPI. O saldo líquido continua usando a entrada bruta
-- internamente para não descontar a mesma saída duas vezes.

create or replace view agency_ops.portfolio_live as
with inicio as (
  select date_trunc('month', current_date)::date as m0
),
setores as (
  select unnest(array['marketing'::text,'ia'::text]) as sector
),
ativos as (
  select
    portfolio_client_status.sector,
    count(*) as active_clients,
    count(*) filter (where portfolio_client_status.banda='LESS_3M') as clients_less_3m,
    count(*) filter (where portfolio_client_status.banda='M3_6') as clients_3_6m,
    count(*) filter (where portfolio_client_status.banda='OVER_6M') as clients_over_6m,
    round(avg(portfolio_client_status.meses_casa),2) as ltv_months,
    count(*) filter (where portfolio_client_status.inadimplente) as inadimplentes,
    count(*) filter (where portfolio_client_status.juridico) as juridico,
    count(*) filter (where portfolio_client_status.churn_previsto) as churn_previsto,
    count(*) filter (where portfolio_client_status.urgencia='urgente') as transicoes_10d
  from agency_ops.portfolio_client_status
  group by portfolio_client_status.sector
),
entradas as (
  select
    coalesce(nullif(c.service,''),'marketing') as sector,
    count(*) filter (where c.lifecycle in ('ACTIVE','ONBOARDING')) as entries,
    count(*) as gross_entries
  from agency_ops.clients c, inicio
  where c.entrada >= inicio.m0
    and c.entrada <= current_date
  group by coalesce(nullif(c.service,''),'marketing')
),
saidas as (
  select
    l.sector,
    count(*) filter (where l.tipo='churn') as churns,
    count(*) filter (where l.tipo='venda_caida') as vendas_caidas,
    round((avg(l.permanencia_dias) filter (where l.tipo='churn') / 30.0),2) as tpc_months
  from agency_ops.client_churn_log l, inicio
  where l.saida >= inicio.m0
  group by l.sector
),
base_potencial as (
  select
    coalesce(nullif(c.service,''),'marketing') as sector,
    count(*) as churn_base
  from agency_ops.clients c, inicio
  where c.entrada < inicio.m0
    and (c.saida is null or c.saida >= inicio.m0)
  group by coalesce(nullif(c.service,''),'marketing')
)
select
  s.sector,
  to_char((select inicio.m0 from inicio)::timestamptz,'YYYY-MM') as month,
  coalesce(a.active_clients,0::bigint) as active_clients,
  coalesce(a.clients_less_3m,0::bigint) as clients_less_3m,
  coalesce(a.clients_3_6m,0::bigint) as clients_3_6m,
  coalesce(a.clients_over_6m,0::bigint) as clients_over_6m,
  a.ltv_months,
  coalesce(e.entries,0::bigint) as entries,
  coalesce(x.churns,0::bigint) as churns,
  x.tpc_months,
  coalesce(b.churn_base,0::bigint) as churn_base,
  case when coalesce(b.churn_base,0::bigint)>0
    then round((100.0*coalesce(x.churns,0::bigint)::numeric)/b.churn_base::numeric,1)
    else 0::numeric
  end as churn_rate,
  ((coalesce(e.gross_entries,0::bigint)-coalesce(x.churns,0::bigint))-coalesce(x.vendas_caidas,0::bigint)) as balance,
  coalesce(a.inadimplentes,0::bigint) as inadimplentes,
  coalesce(a.juridico,0::bigint) as juridico,
  coalesce(a.churn_previsto,0::bigint) as churn_previsto,
  coalesce(a.transicoes_10d,0::bigint) as transicoes_10d,
  coalesce(x.vendas_caidas,0::bigint) as vendas_caidas
from setores s
left join ativos a on a.sector=s.sector
left join entradas e on e.sector=s.sector
left join saidas x on x.sector=s.sector
left join base_potencial b on b.sector=s.sector;

create or replace view agency_ops.portfolio_timeline as
select
  h.month,
  to_char(h.month::timestamptz,'YYYY-MM') as month_key,
  h.label,
  h.sector,
  h.active_clients,
  h.clients_less_3m,
  h.clients_3_6m,
  h.clients_over_6m,
  h.ltv_months,
  h.entries,
  h.churns,
  h.churn_base,
  h.churn_rate,
  h.tpc_months,
  h.balance,
  h.quality,
  h.quality_label,
  h.quality_detail,
  h.reference_date,
  h.admin_removals,
  h.estimated_churns,
  'historico'::text as origem,
  coalesce(h.vendas_caidas,0) as vendas_caidas
from agency_ops.portfolio_monthly_history h
where h.month < date_trunc('month',current_date)::date
union all
select
  date_trunc('month',current_date)::date as month,
  to_char(current_date::timestamptz,'YYYY-MM') as month_key,
  ((array['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'])[extract(month from current_date)::int] || '/' || to_char(current_date::timestamptz,'YYYY')) as label,
  l.sector,
  l.active_clients,
  l.clients_less_3m,
  l.clients_3_6m,
  l.clients_over_6m,
  l.ltv_months,
  l.entries,
  l.churns,
  l.churn_base,
  l.churn_rate,
  l.tpc_months,
  l.balance,
  'high'::text as quality,
  'Calculado ao vivo'::text as quality_label,
  'Recalculado a cada consulta. Entradas contam apenas clientes ainda ACTIVE/ONBOARDING; churned e venda caída ficam fora. Venda caída também não entra em churns, taxa nem TPC.'::text as quality_detail,
  current_date as reference_date,
  0 as admin_removals,
  0 as estimated_churns,
  'ao_vivo'::text as origem,
  l.vendas_caidas
from agency_ops.portfolio_live l;
