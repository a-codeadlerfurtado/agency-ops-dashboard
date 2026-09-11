-- Monthly Wrapped: snapshot imutavel + agregador mensal sob demanda.
create table if not exists agency_ops.monthly_wrapped_snapshots (
  id uuid primary key default gen_random_uuid(),
  month_key date not null,
  scope_type text not null default 'COMPANY' check (scope_type in ('COMPANY','PERSON')),
  scope_key text not null default 'COMPANY',
  coverage_tier text not null check (coverage_tier in ('FULL','PARTIAL_STRONG','PARTIAL')),
  is_final boolean not null default false,
  payload jsonb not null,
  source_version text not null default 'wrapped-v1',
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(month_key,scope_type,scope_key),
  check (month_key = date_trunc('month',month_key)::date)
);
create index if not exists monthly_wrapped_month_idx
  on agency_ops.monthly_wrapped_snapshots(month_key desc,scope_type,scope_key);
alter table agency_ops.monthly_wrapped_snapshots enable row level security;
revoke all on agency_ops.monthly_wrapped_snapshots from anon,authenticated;
grant select,insert,update,delete on agency_ops.monthly_wrapped_snapshots to service_role;
comment on table agency_ops.monthly_wrapped_snapshots is
  'Fechamento mensal do Wrapped. Mes fechado fica congelado; recalculo exige acao explicita da gestao.';

create or replace function agency_ops.wrapped_company_month(p_month date)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,agency_ops,public
as $$declare
  m0 date := date_trunc('month',p_month)::date;
  m1 date := (date_trunc('month',p_month) + interval '1 month')::date;
  pm0 date := (date_trunc('month',p_month) - interval '1 month')::date;
  tier text;
  result jsonb;
begin
  if m0 < date '2026-01-01' or m0 > date_trunc('month',current_date)::date then
    raise exception 'wrapped_month_out_of_range';
  end if;
  tier := case
    when m0 >= date '2026-09-01' then 'FULL'
    when m0 >= date '2026-07-01' then 'PARTIAL_STRONG'
    else 'PARTIAL'
  end;

  with pf as (
    select coalesce(sum(active_clients),0)::int active_clients,
      coalesce(sum(entries),0)::int entries, coalesce(sum(churns),0)::int churns,
      coalesce(sum(vendas_caidas),0)::int fallen_sales,
      coalesce(sum(churn_base),0)::int churn_base,
      round(sum(coalesce(ltv_months,0)*active_clients)/nullif(sum(active_clients),0),2) ltv_months,
      round(sum(coalesce(tpc_months,0)*churns)/nullif(sum(churns),0),2) tpc_months
    from agency_ops.portfolio_monthly_computed where month=m0
  ), prev as (
    select coalesce(sum(active_clients),0)::int active_clients,
      coalesce(sum(entries),0)::int entries, coalesce(sum(churns),0)::int churns,
      coalesce(sum(churn_base),0)::int churn_base,
      round(sum(coalesce(ltv_months,0)*active_clients)/nullif(sum(active_clients),0),2) ltv_months,
      round(sum(coalesce(tpc_months,0)*churns)/nullif(sum(churns),0),2) tpc_months
    from agency_ops.portfolio_monthly_computed where month=pm0
  ),  tasks as (
    select count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1)::int completed,
      count(*) filter(where date_created>=m0 and date_created<m1)::int created,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and due_date>date_created)::int due_real,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and due_date>date_created and date_closed<=due_date)::int on_time,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and due_date is not null and due_date<=date_created)::int born_overdue,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and lower(coalesce(list_name,'')||' '||name) ~ '(traf|campanh|meta|google|ajuste.*campanh)')::int traffic,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and lower(coalesce(list_name,'')||' '||name) ~ '(criativ|design|arte|imagem|video|vÃ­deo|edicao|ediÃ§Ã£o)')::int design,
      count(*) filter(where is_closed and date_closed>=m0 and date_closed<m1 and lower(coalesce(list_name,'')||' '||name) ~ '(copy|roteiro|escrita criativa)')::int copy,
      round(percentile_disc(.5) within group(order by extract(epoch from(date_closed-date_created))/3600.0)
        filter(where is_closed and date_closed>=m0 and date_closed<m1)::numeric,1) cycle_median_hours
    from agency_ops.clickup_tasks
  ), task_people as (
    select r.person,r.role,r.is_former,count(distinct t.task_id)::int tasks_completed,
      count(distinct t.task_id) filter(where lower(coalesce(t.list_name,'')||' '||t.name) ~ '(traf|campanh|meta|google|ajuste.*campanh)')::int traffic_tasks,
      count(distinct t.task_id) filter(where lower(coalesce(t.list_name,'')||' '||t.name) ~ '(criativ|design|arte|imagem|video|vÃ­deo|edicao|ediÃ§Ã£o)')::int design_tasks,
      count(distinct t.task_id) filter(where t.due_date>t.date_created)::int due_real,
      count(distinct t.task_id) filter(where t.due_date>t.date_created and t.date_closed<=t.due_date)::int on_time
    from agency_ops.clickup_tasks t
    join agency_ops.clickup_task_assignees a on a.task_id=t.task_id
    join agency_ops.team_roster r on lower(coalesce(a.username,''))=lower(coalesce(r.clickup_user,''))
      or (a.email is not null and r.email is not null and lower(a.email)=lower(r.email))
    where t.is_closed and t.date_closed>=m0 and t.date_closed<m1
    group by r.person,r.role,r.is_former
  ),  creator_people as (
    select r.person,r.role,count(distinct t.task_id)::int tasks_created
    from agency_ops.clickup_tasks t
    join agency_ops.team_roster r on lower(coalesce(t.creator_name,'')) in (lower(r.person),lower(coalesce(r.clickup_user,'')))
    where t.date_created>=m0 and t.date_created<m1
    group by r.person,r.role
  ), replies as (
    select coalesce(i.pessoa,w.pessoa) person,coalesce(i.papel_whatsapp,w.papel) role,
      count(*)::int replies,
      percentile_disc(.5) within group(order by w.minutos_uteis)::int median_minutes,
      percentile_disc(.9) within group(order by w.minutos_uteis)::int p90_minutes
    from agency_ops.whatsapp_response_times w
    left join agency_ops.identidade_whatsapp_para_quadro i on i.nome_whatsapp=w.pessoa
    where w.respondeu_em>=m0 and w.respondeu_em<m1
    group by 1,2
  ), sources as (
    select
      (select count(*) from agency_ops.task_log_entries where deleted_at is null and task_date>=m0 and task_date<m1)::int tasklog,
      (select count(*) from agency_ops.client_adjustments where occurred_at>=m0 and occurred_at<m1)::int adjustments,
      (select count(*) from agency_ops.designer_daily_reports where report_date>=m0 and report_date<m1)::int designer_daily,
      (select count(*) from agency_ops.weekly_traffic_reports where week_end>=m0 and week_end<m1)::int weekly_traffic,
      (select count(*) from agency_ops.meta_gt_weekly_submissions where coalesce(submitted_at,created_at)>=m0 and coalesce(submitted_at,created_at)<m1)::int gt_weekly,
      (select count(*) from agency_ops.meta_gt_client_analyses where created_at>=m0 and created_at<m1)::int gt_analyses,
      (select count(*) from agency_ops.whatsapp_messages where event_at>=m0 and event_at<m1)::int whatsapp,
      (select count(*) from agency_ops.meta_campaign_insights where date_start>=m0 and date_start<m1)::int meta,
      (select count(*) from agency_ops.work_items where created_at>=m0 and created_at<m1)::int work_items,
      (select count(*) from agency_ops.work_item_events where occurred_at>=m0 and occurred_at<m1)::int work_events,
      (select count(*) from agency_ops.creative_preapproval_items where submitted_at>=m0 and submitted_at<m1)::int creative_preapproval
  ),  finance as (
    select
      coalesce(sum(ct.monthly_value) filter(where c.entrada>=m0 and c.entrada<m1),0)::numeric mrr_added_known,
      coalesce(sum(ct.monthly_value) filter(where c.saida>=m0 and c.saida<m1 and c.saida-c.entrada>10),0)::numeric mrr_lost_known,
      count(*) filter(where ct.monthly_value is not null)::int clients_with_terms,
      count(*)::int clients_considered
    from agency_ops.clients c
    left join agency_ops.client_commercial_terms ct on ct.client_id=c.id
    where c.entrada<m1 and (c.saida is null or c.saida>=m0)
  ), meta_stats as (
    select round(coalesce(sum(spend),0)::numeric,2) spend,
      coalesce(sum(leads_estimate),0)::int leads,
      round((sum(spend)/nullif(sum(leads_estimate),0))::numeric,2) cpl,
      count(distinct client_id)::int clients,
      count(distinct campaign_id)::int campaigns
    from agency_ops.meta_campaign_insights where date_start>=m0 and date_start<m1
  ), weekly as (
    select count(*)::int submissions,count(distinct gt_person)::int gts
    from agency_ops.meta_gt_weekly_submissions
    where coalesce(submitted_at,created_at)>=m0 and coalesce(submitted_at,created_at)<m1
  ), weekly_actions as (
    select count(*)::int analyses,
      count(*) filter(where nullif(trim(diagnosis),'') is not null)::int with_diagnosis,
      count(*) filter(where nullif(trim(hypothesis),'') is not null)::int with_hypothesis,
      count(*) filter(where nullif(trim(decision),'') is not null)::int with_decision,
      count(*) filter(where nullif(trim(next_validation),'') is not null)::int with_validation
    from agency_ops.meta_gt_client_analyses where created_at>=m0 and created_at<m1
  )
  select jsonb_build_object(
    'month_key',to_char(m0,'YYYY-MM'),'month_start',m0,'month_end',(m1-1),
    'is_open_month',m0=date_trunc('month',current_date)::date,
    'coverage_tier',tier,
    'generated_at',now(),
    'portfolio',jsonb_build_object(
      'active_clients',pf.active_clients,'entries',pf.entries,'churns',pf.churns,
      'fallen_sales',pf.fallen_sales,'client_balance',pf.entries-pf.churns,
      'churn_rate',round(100.0*pf.churns/nullif(pf.churn_base,0),1),
      'ltv_months',pf.ltv_months,'tpc_months',pf.tpc_months),
    'previous',jsonb_build_object(
      'active_clients',prev.active_clients,'entries',prev.entries,'churns',prev.churns,
      'churn_rate',round(100.0*prev.churns/nullif(prev.churn_base,0),1),
      'ltv_months',prev.ltv_months,'tpc_months',prev.tpc_months),    'tasks',jsonb_build_object(
      'created',tasks.created,'completed',tasks.completed,'traffic',tasks.traffic,
      'design',tasks.design,'copy',tasks.copy,'due_real',tasks.due_real,
      'on_time',tasks.on_time,'on_time_rate',round(100.0*tasks.on_time/nullif(tasks.due_real,0),1),
      'born_overdue',tasks.born_overdue,'cycle_median_hours',tasks.cycle_median_hours),
    'finance',jsonb_build_object(
      'mrr_added_known',finance.mrr_added_known,'mrr_lost_known',finance.mrr_lost_known,
      'mrr_net_known',finance.mrr_added_known-finance.mrr_lost_known,
      'clients_with_terms',finance.clients_with_terms,'clients_considered',finance.clients_considered,
      'coverage_pct',round(100.0*finance.clients_with_terms/nullif(finance.clients_considered,0),1)),
    'meta',to_jsonb(meta_stats),'weekly_gt',to_jsonb(weekly)||to_jsonb(weekly_actions),
    'sources',to_jsonb(sources),
    'rankings',jsonb_build_object(
      'tasks_completed',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,role,is_former,tasks_completed,due_real,
          case when due_real>=5 then round(100.0*on_time/due_real,1) end on_time_rate
        from task_people order by tasks_completed desc,person limit 10) x),
      'tasks_created',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,role,tasks_created from creator_people order by tasks_created desc,person limit 10) x),
      'traffic',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,is_former,traffic_tasks tasks from task_people where role='GT' and traffic_tasks>0
        order by traffic_tasks desc,person limit 10) x),
      'design',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,is_former,design_tasks tasks from task_people where role='DESIGN' and design_tasks>0
        order by design_tasks desc,person limit 10) x),
      'task_sla',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,role,due_real,round(100.0*on_time/due_real,1) rate
        from task_people where due_real>=10 order by rate desc,due_real desc limit 10) x),
      'response_speed',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select person,role,replies,median_minutes,p90_minutes from replies where replies>=30
        order by median_minutes asc,p90_minutes asc limit 10) x)
    )
  ) into result
  from pf,prev,tasks,sources,finance,meta_stats,weekly,weekly_actions;
  return result;
end;
$$;
revoke all on function agency_ops.wrapped_company_month(date) from public,anon,authenticated;
grant execute on function agency_ops.wrapped_company_month(date) to service_role;

