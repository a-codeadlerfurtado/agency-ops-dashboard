with target as (
  select id from agency_ops.clients where display_name='Cleiton Gregol' limit 1
)
update agency_ops.client_integrations ci
set system='META_AD_ACCOUNT',
    external_id='409464319107198',
    external_name='Cleiton gregol [LÉO_IMOB] (conta histórica)',
    is_primary=false,
    matched_by='historical_account_replaced_20260827',
    metadata=coalesce(ci.metadata,'{}'::jsonb) || jsonb_build_object(
      'historical_meta_account',true,
      'replaced_at',now(),
      'replaced_by_meta_ad_account_id','28349927768029665',
      'reason','Conta antiga do próprio Cleiton, sem entrega recente; substituída pela CA02 operacional atual com campanhas ativas.'
    )
where ci.client_id in (select id from target)
  and ci.system='META_BM'
  and ci.meta_ad_account_id='409464319107198';

with target as (
  select id from agency_ops.clients where display_name='Cleiton Gregol' limit 1
)
insert into agency_ops.client_integrations(
  client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata
)
select id,'META_BM','CA02 - Cleiton Gregol','CA02 - Cleiton Gregol','28349927768029665','ALTA','META_LIVE_CAMPAIGN_EVIDENCE',true,
       jsonb_build_object(
         'confirmed_at',now(),
         'evidence','Conta visível à LAK; nome exato CA02 - Cleiton Gregol; 3 campanhas ativas; gasto últimos 3 dias R$119,32; campanha [TAUANY 120] [FORMS] [VENDA] 26/08.',
         'previous_meta_ad_account_id','409464319107198'
       )
from target
on conflict(system,external_id) do update
set client_id=excluded.client_id,
    external_name=excluded.external_name,
    meta_ad_account_id=excluded.meta_ad_account_id,
    confidence='ALTA',
    matched_by='META_LIVE_CAMPAIGN_EVIDENCE',
    is_primary=true,
    metadata=coalesce(agency_ops.client_integrations.metadata,'{}'::jsonb) || excluded.metadata;

with target as (
  select id from agency_ops.clients where display_name='Cleiton Gregol' limit 1
)
update agency_ops.integration_match_review r
set status='RESOLVED',
    resolved_client_id=(select id from target),
    resolved_by='SYSTEM_META_LIVE_EVIDENCE',
    resolved_at=now(),
    resolution_note='Vinculada como conta atual do Cleiton Gregol. Nome exato CA02 - Cleiton Gregol, 3 campanhas ativas e gasto recente; conta 409464319107198 preservada como histórica.',
    updated_at=now()
where r.system='META_AD_ACCOUNT' and r.external_id='28349927768029665';

delete from agency_ops.account_ad_balances
where client_id=(select id from agency_ops.clients where display_name='Cleiton Gregol' limit 1)
  and account_key='Cleiton Gregol';
