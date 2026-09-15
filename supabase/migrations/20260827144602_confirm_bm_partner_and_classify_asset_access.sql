create or replace function agency_ops.classify_meta_snapshot_access_state()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_pending_ids jsonb;
  v_partner_confirmed boolean;
begin
  if new.data_status='NO_META_ACCOUNT' then
    select
      coalesce(jsonb_agg(distinct ci.metadata->>'pending_meta_ad_account_id') filter (where nullif(ci.metadata->>'pending_meta_ad_account_id','') is not null),'[]'::jsonb),
      bool_or(coalesce((ci.metadata->>'bm_lak_partner_confirmed')::boolean,false))
      into v_pending_ids,v_partner_confirmed
    from agency_ops.client_integrations ci
    where ci.client_id=new.client_id and ci.system='META_AD_ACCOUNT';

    if jsonb_array_length(v_pending_ids)>0 then
      new.data_status := case when coalesce(v_partner_confirmed,false) then 'META_ASSET_ACCESS_MISSING' else 'META_ACCESS_PENDING' end;
      new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
        'pending_meta_ad_account_ids',v_pending_ids,
        'access_state',case when coalesce(v_partner_confirmed,false)
          then 'BM_LAK_PARTNER_CONFIRMED_ACCOUNT_NOT_READABLE_BY_SYSTEM_USER'
          else 'KNOWN_ACCOUNT_NOT_READABLE_BY_LAK_TOKEN' end,
        'bm_lak_partner_confirmed',coalesce(v_partner_confirmed,false),
        'classification_source','agency_ops.classify_meta_snapshot_access_state'
      );
    end if;
  end if;
  return new;
end;
$$;

with target_clients as (
  select id from agency_ops.clients
  where display_name in ('Caetano e Fraga Imóveis','Lua Imóveis Sorocaba')
)
update agency_ops.client_integrations ci
set metadata=coalesce(ci.metadata,'{}'::jsonb) || jsonb_build_object(
      'bm_lak_partner_confirmed',true,
      'bm_lak_partner_confirmed_at',now(),
      'bm_lak_partner_confirmed_by','Adler Furtado',
      'access_request_status','BM_PARTNER_CONFIRMED_ACCOUNT_NOT_READABLE_BY_SYSTEM_USER',
      'access_request_note','Gestão confirmou que a BM-LAK já está vinculada como parceira. A pendência remanescente é acesso técnico/atribuição da conta específica ao system user, não vínculo da BM.'
    ),
    matched_by=case when ci.matched_by='user_forneceu_id_sem_acesso_bm' then 'management_confirmed_bm_partner_account_pending_system_user' else ci.matched_by end
where ci.client_id in (select id from target_clients)
  and ci.system='META_AD_ACCOUNT';

with target_clients as (
  select id from agency_ops.clients
  where display_name in ('Caetano e Fraga Imóveis','Lua Imóveis Sorocaba')
)
update agency_ops.meta_performance_snapshots s
set data_status='META_ASSET_ACCESS_MISSING',
    metadata=coalesce(s.metadata,'{}'::jsonb) || jsonb_build_object(
      'bm_lak_partner_confirmed',true,
      'access_state','BM_LAK_PARTNER_CONFIRMED_ACCOUNT_NOT_READABLE_BY_SYSTEM_USER',
      'classification_source','management_confirmation_20260827'
    )
where s.client_id in (select id from target_clients)
  and s.data_status in ('NO_META_ACCOUNT','META_ACCESS_PENDING');

update agency_ops.meta_performance_runs r
set metadata=coalesce(r.metadata,'{}'::jsonb) || jsonb_build_object(
      'meta_asset_access_missing_clients',(
        select count(distinct s.client_id)::int
        from agency_ops.meta_performance_snapshots s
        where s.run_id=r.id and s.period_days=7 and s.data_status='META_ASSET_ACCESS_MISSING'
      ),
      'meta_access_pending_clients',(
        select count(distinct s.client_id)::int
        from agency_ops.meta_performance_snapshots s
        where s.run_id=r.id and s.period_days=7 and s.data_status='META_ACCESS_PENDING'
      )
    ),
    no_meta_clients=(
      select count(distinct s.client_id)::int
      from agency_ops.meta_performance_snapshots s
      where s.run_id=r.id and s.period_days=7 and s.data_status='NO_META_ACCOUNT'
    ),
    updated_at=now()
where exists(select 1 from agency_ops.meta_performance_snapshots s where s.run_id=r.id and s.snapshot_date=current_date);
