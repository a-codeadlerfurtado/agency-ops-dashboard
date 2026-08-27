with targets as (
  select id,display_name,lifecycle,metadata
  from agency_ops.clients
  where display_name in ('Jair Pereira de Souza','Vórtice Ativos Imobiliários')
)
update agency_ops.clients c
set lifecycle='CHURNED',
    metadata=coalesce(c.metadata,'{}'::jsonb) ||
      case
        when c.display_name='Jair Pereira de Souza' then jsonb_build_object(
          'historical_churn_confirmed',true,
          'historical_churn_month','2026-07',
          'historical_churn_exact_date_pending',true,
          'lifecycle_corrected_at',now(),
          'lifecycle_correction_source','MANAGEMENT_CONFIRMATION_20260827'
        )
        else jsonb_build_object(
          'historical_churn_confirmed',true,
          'historical_churn_exact_date_pending',true,
          'lifecycle_corrected_at',now(),
          'lifecycle_correction_source','MANAGEMENT_CONFIRMATION_20260827'
        )
      end,
    updated_at=now()
from targets t
where c.id=t.id and c.lifecycle<>'CHURNED';

insert into agency_ops.client_lifecycle_events(event_key,client_id,event_type,occurred_at,source,actor,before_value,after_value,detail)
select 'historical_churn_correction_20260827_'||c.id::text,
       c.id,'CLIENT_CHURNED',now(),'MANAGEMENT_CONFIRMATION','Adler Furtado',
       jsonb_build_object('lifecycle','ACTIVE'),jsonb_build_object('lifecycle','CHURNED'),
       case when c.display_name='Jair Pereira de Souza'
            then 'Correção histórica: gestão confirmou churn em julho/2026; dia exato ainda não recuperado. Não lançar churn no mês atual.'
            else 'Correção histórica: gestão confirmou cliente churned; data exata ainda não recuperada. Não lançar churn no mês atual.' end
from agency_ops.clients c
where c.display_name in ('Jair Pereira de Souza','Vórtice Ativos Imobiliários')
on conflict(event_key) do nothing;

with run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Jair Pereira de Souza','Vórtice Ativos Imobiliários')
)
delete from agency_ops.meta_campaign_performance_snapshots s
using run r,targets t
where s.run_id=r.id and s.client_id=t.id;

with run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Jair Pereira de Souza','Vórtice Ativos Imobiliários')
)
delete from agency_ops.meta_performance_snapshots s
using run r,targets t
where s.run_id=r.id and s.client_id=t.id;

with run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Jair Pereira de Souza','Vórtice Ativos Imobiliários')
)
delete from agency_ops.meta_performance_queue q
using run r,targets t
where q.run_id=r.id and q.client_id=t.id;

with r as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), q as (
  select q.run_id,
         count(*)::int total,
         count(*) filter(where q.status='DONE')::int done,
         count(*) filter(where q.status='ERROR' and q.attempts>=3)::int exhausted,
         count(*) filter(where q.status in ('PENDING','RUNNING') or(q.status='ERROR' and q.attempts<3))::int pending
  from agency_ops.meta_performance_queue q join r on r.id=q.run_id group by q.run_id
), s as (
  select s.run_id,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='NO_META_ACCOUNT')::int no_meta,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='NO_DELIVERY')::int no_data,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='API_ERROR')::int api_error
  from agency_ops.meta_performance_snapshots s join r on r.id=s.run_id group by s.run_id
)
update agency_ops.meta_performance_runs m
set total_clients=coalesce(q.total,0),
    processed_clients=coalesce(q.done,0)+coalesce(q.exhausted,0),
    successful_clients=coalesce(q.done,0),
    error_clients=coalesce(q.exhausted,0)+coalesce(s.api_error,0),
    no_meta_clients=coalesce(s.no_meta,0),
    no_data_clients=coalesce(s.no_data,0),
    status=case when coalesce(q.pending,0)=0 then case when coalesce(q.exhausted,0)+coalesce(s.api_error,0)>0 then 'COMPLETED_WITH_ERRORS' else 'COMPLETED' end else 'RUNNING' end,
    finished_at=case when coalesce(q.pending,0)=0 then coalesce(m.finished_at,now()) else null end,
    updated_at=now()
from r left join q on q.run_id=r.id left join s on s.run_id=r.id
where m.id=r.id;