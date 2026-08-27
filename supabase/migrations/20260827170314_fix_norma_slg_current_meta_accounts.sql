with norma as (
  select id from agency_ops.clients where display_name='Norma Salazar' limit 1
)
update agency_ops.client_integrations ci
set is_primary=false,
    matched_by='historical_wrong_meta_account_id_replaced_20260827',
    metadata=coalesce(ci.metadata,'{}'::jsonb) || jsonb_build_object(
      'superseded_by_meta_ad_account_id','1299936238070825',
      'reason','Meta live direct verification matched 01CA - Norma Salazar and DOM/ROYAL/ART DESIGN campaigns'
    )
from norma n
where ci.client_id=n.id
  and ci.system='META_AD_ACCOUNT'
  and ci.metadata->>'pending_meta_ad_account_id'='1299936238070820';

with norma as (
  select id from agency_ops.clients where display_name='Norma Salazar' limit 1
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select n.id,'META_BM','01CA - Norma Salazar','01CA - Norma Salazar','1299936238070825','ALTA','META_LIVE_DIRECT_CAMPAIGN_MATCH',true,
       jsonb_build_object('source','META_SYSTEM_USER_LIVE_DIRECT_VERIFICATION','previous_incorrect_meta_ad_account_id','1299936238070820')
from norma n
on conflict (system,external_id) do update
set client_id=excluded.client_id,
    external_name=excluded.external_name,
    meta_ad_account_id=excluded.meta_ad_account_id,
    confidence=excluded.confidence,
    matched_by=excluded.matched_by,
    is_primary=true,
    metadata=coalesce(agency_ops.client_integrations.metadata,'{}'::jsonb)||excluded.metadata;

with slg as (
  select id from agency_ops.clients where display_name='SLG Imóveis Mkt' limit 1
)
update agency_ops.client_integrations ci
set is_primary=false,
    matched_by='historical_wrong_meta_account_id_replaced_20260827',
    metadata=coalesce(ci.metadata,'{}'::jsonb) || jsonb_build_object(
      'superseded_by_meta_ad_account_id','577500957524591',
      'reason','Meta live direct verification matched CONTA 01 - ALESSANDRO and INC GREEN CAMBEBA/MURURIPI/SIGNA campaigns'
    )
from slg s
where ci.client_id=s.id
  and ci.system='META_AD_ACCOUNT';

with slg as (
  select id from agency_ops.clients where display_name='SLG Imóveis Mkt' limit 1
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select s.id,'META_BM','CONTA 01 - ALESSANDRO','CONTA 01 - ALESSANDRO','577500957524591','ALTA','META_LIVE_DIRECT_CAMPAIGN_MATCH',true,
       jsonb_build_object('source','META_SYSTEM_USER_LIVE_DIRECT_VERIFICATION','previous_incorrect_meta_ad_account_ids',jsonb_build_array('1764106587161329','687106343102712'))
from slg s
on conflict (system,external_id) do update
set client_id=excluded.client_id,
    external_name=excluded.external_name,
    meta_ad_account_id=excluded.meta_ad_account_id,
    confidence=excluded.confidence,
    matched_by=excluded.matched_by,
    is_primary=true,
    metadata=coalesce(agency_ops.client_integrations.metadata,'{}'::jsonb)||excluded.metadata;

with today_run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Norma Salazar','SLG Imóveis Mkt')
)
delete from agency_ops.meta_campaign_performance_snapshots s
using today_run r, targets t
where s.run_id=r.id and s.client_id=t.id;

with today_run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Norma Salazar','SLG Imóveis Mkt')
)
delete from agency_ops.meta_performance_snapshots s
using today_run r, targets t
where s.run_id=r.id and s.client_id=t.id;

with today_run as (
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
), targets as (
  select id from agency_ops.clients where display_name in ('Norma Salazar','SLG Imóveis Mkt')
)
update agency_ops.meta_performance_queue q
set status='PENDING',attempts=0,locked_at=null,error=null,updated_at=now()
from today_run r, targets t
where q.run_id=r.id and q.client_id=t.id;

update agency_ops.meta_performance_runs
set status='RUNNING',finished_at=null,updated_at=now()
where id=(
  select id from agency_ops.meta_performance_runs
  where snapshot_date=((now() at time zone 'America/Sao_Paulo')::date)
  order by started_at desc limit 1
);
