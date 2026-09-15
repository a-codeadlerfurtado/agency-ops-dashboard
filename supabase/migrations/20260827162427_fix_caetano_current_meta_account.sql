with caetano as (
  select id from agency_ops.clients where display_name='Caetano e Fraga Imóveis' limit 1
)
update agency_ops.client_integrations ci
set is_primary=false,
    matched_by='historical_wrong_meta_account_id_replaced_20260827',
    metadata=coalesce(ci.metadata,'{}'::jsonb) || jsonb_build_object(
      'superseded_by_meta_ad_account_id','1269318144569841',
      'reason','Meta live discovery matched CT anuncio Caetano e Fraga Imoveis in BM-LAK System User'
    )
from caetano c
where ci.client_id=c.id
  and ci.system='META_AD_ACCOUNT'
  and ci.metadata->>'pending_meta_ad_account_id'='469609089569137';

with caetano as (
  select id from agency_ops.clients where display_name='Caetano e Fraga Imóveis' limit 1
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select c.id,'META_BM','CT anuncio Caetano e Fraga Imoveis','CT anuncio Caetano e Fraga Imoveis','1269318144569841','ALTA','META_LIVE_SYSTEM_USER_NAME_MATCH',true,
       jsonb_build_object('source','META_SYSTEM_USER_LIVE_DISCOVERY','previous_incorrect_meta_ad_account_id','469609089569137')
from caetano c
on conflict (system,external_id) do update
set client_id=excluded.client_id,
    external_name=excluded.external_name,
    meta_ad_account_id=excluded.meta_ad_account_id,
    confidence=excluded.confidence,
    matched_by=excluded.matched_by,
    is_primary=true,
    metadata=coalesce(agency_ops.client_integrations.metadata,'{}'::jsonb)||excluded.metadata;
