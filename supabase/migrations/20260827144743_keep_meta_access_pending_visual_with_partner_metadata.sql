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
      new.data_status := 'META_ACCESS_PENDING';
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

update agency_ops.meta_performance_snapshots
set data_status='META_ACCESS_PENDING'
where data_status='META_ASSET_ACCESS_MISSING';

update agency_ops.meta_performance_runs r
set metadata=coalesce(r.metadata,'{}'::jsonb) || jsonb_build_object(
      'bm_partner_confirmed_access_pending_clients',(
        select count(distinct s.client_id)::int
        from agency_ops.meta_performance_snapshots s
        where s.run_id=r.id and s.period_days=7 and s.data_status='META_ACCESS_PENDING'
          and coalesce((s.metadata->>'bm_lak_partner_confirmed')::boolean,false)=true
      ),
      'meta_access_pending_clients',(
        select count(distinct s.client_id)::int
        from agency_ops.meta_performance_snapshots s
        where s.run_id=r.id and s.period_days=7 and s.data_status='META_ACCESS_PENDING'
      )
    ),updated_at=now()
where exists(select 1 from agency_ops.meta_performance_snapshots s where s.run_id=r.id and s.snapshot_date=current_date);
