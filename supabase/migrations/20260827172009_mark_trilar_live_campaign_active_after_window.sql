with current_run as (
  select id,snapshot_date,window_end
  from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), trilar as (
  select id from agency_ops.clients where display_name='Trilar Imóveis' limit 1
)
update agency_ops.meta_performance_snapshots s
set data_status='OK',
    metadata=coalesce(s.metadata,'{}'::jsonb) || jsonb_build_object(
      'live_campaign_active_after_window_end',true,
      'live_campaign_checked_at',now(),
      'live_campaign_id','120257864022950197',
      'live_campaign_name','[CA01172] [FORMS] [VENDA] 27/08',
      'live_campaign_status','ACTIVE',
      'live_campaign_effective_status','ACTIVE',
      'status_override_reason','Campaign became active on snapshot_date after historical window_end; avoid false operational Sem entrega label'
    )
from current_run r,trilar t
where s.run_id=r.id
  and s.client_id=t.id
  and s.data_status='NO_DELIVERY';

with r as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), counts as (
  select s.run_id,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='NO_DELIVERY')::int no_data,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='API_ERROR')::int api_error,
         count(distinct s.client_id) filter(where s.period_days=7 and s.data_status='NO_META_ACCOUNT')::int no_meta
  from agency_ops.meta_performance_snapshots s join r on r.id=s.run_id
  group by s.run_id
)
update agency_ops.meta_performance_runs m
set no_data_clients=coalesce(c.no_data,0),
    error_clients=coalesce(c.api_error,0),
    no_meta_clients=coalesce(c.no_meta,0),
    status=case when coalesce(c.api_error,0)>0 then 'COMPLETED_WITH_ERRORS' else 'COMPLETED' end,
    updated_at=now()
from counts c
where m.id=c.run_id;