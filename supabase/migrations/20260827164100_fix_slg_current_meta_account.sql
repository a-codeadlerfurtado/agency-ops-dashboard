with slg as (
  select id as client_id
  from agency_ops.clients
  where display_name = 'SLG Imóveis Mkt'
  limit 1
)
update agency_ops.client_integrations i
set is_primary = false,
    matched_by = 'historical_wrong_meta_account_id_replaced_20260827',
    metadata = coalesce(i.metadata,'{}'::jsonb) || jsonb_build_object(
      'replaced_by_meta_ad_account_id','687106343102712',
      'reason','SLG Oficial confirmed by management'
    )
from slg
where i.client_id = slg.client_id
  and i.system = 'META_AD_ACCOUNT'
  and i.metadata->>'pending_meta_ad_account_id' = '1764106587161329';

with slg as (
  select id as client_id
  from agency_ops.clients
  where display_name = 'SLG Imóveis Mkt'
  limit 1
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select
  slg.client_id,
  'META_AD_ACCOUNT',
  'SLG Oficial — 687106343102712 [PENDENTE ACESSO SYSTEM USER]',
  'SLG Oficial',
  null,
  'ALTA',
  'management_confirmed_current_meta_account_20260827',
  true,
  jsonb_build_object(
    'pending_meta_ad_account_id','687106343102712',
    'access_state','CURRENT_ACCOUNT_NOT_READABLE_BY_LAK_SYSTEM_USER'
  )
from slg
where not exists (
  select 1
  from agency_ops.client_integrations i
  where i.client_id = slg.client_id
    and i.system = 'META_AD_ACCOUNT'
    and i.metadata->>'pending_meta_ad_account_id' = '687106343102712'
);
