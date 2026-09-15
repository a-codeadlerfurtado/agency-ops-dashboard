-- Diferencia conta inexistente/não vinculada de conta conhecida cujo acesso ainda não chegou ao system user da LAK.
create or replace function agency_ops.classify_meta_snapshot_access_state()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_pending_ids jsonb;
begin
  if new.data_status='NO_META_ACCOUNT' then
    select coalesce(jsonb_agg(distinct ci.metadata->>'pending_meta_ad_account_id') filter (where nullif(ci.metadata->>'pending_meta_ad_account_id','') is not null),'[]'::jsonb)
      into v_pending_ids
    from agency_ops.client_integrations ci
    where ci.client_id=new.client_id and ci.system='META_AD_ACCOUNT';

    if jsonb_array_length(v_pending_ids)>0 then
      new.data_status := 'META_ACCESS_PENDING';
      new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
        'pending_meta_ad_account_ids',v_pending_ids,
        'access_state','KNOWN_ACCOUNT_NOT_READABLE_BY_LAK_TOKEN',
        'classification_source','agency_ops.classify_meta_snapshot_access_state'
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function agency_ops.classify_meta_snapshot_access_state() from public;

drop trigger if exists trg_classify_meta_snapshot_access_state on agency_ops.meta_performance_snapshots;
create trigger trg_classify_meta_snapshot_access_state
before insert on agency_ops.meta_performance_snapshots
for each row execute function agency_ops.classify_meta_snapshot_access_state();

update agency_ops.meta_performance_snapshots s
set data_status='META_ACCESS_PENDING',
    metadata=coalesce(s.metadata,'{}'::jsonb) || jsonb_build_object(
      'pending_meta_ad_account_ids',(
        select coalesce(jsonb_agg(distinct ci.metadata->>'pending_meta_ad_account_id') filter (where nullif(ci.metadata->>'pending_meta_ad_account_id','') is not null),'[]'::jsonb)
        from agency_ops.client_integrations ci
        where ci.client_id=s.client_id and ci.system='META_AD_ACCOUNT'
      ),
      'access_state','KNOWN_ACCOUNT_NOT_READABLE_BY_LAK_TOKEN',
      'classification_source','backfill_20260827'
    )
where s.snapshot_date=current_date
  and s.data_status='NO_META_ACCOUNT'
  and exists (
    select 1 from agency_ops.client_integrations ci
    where ci.client_id=s.client_id and ci.system='META_AD_ACCOUNT'
      and nullif(ci.metadata->>'pending_meta_ad_account_id','') is not null
  );

update agency_ops.meta_performance_runs r
set no_meta_clients=(
      select count(distinct s.client_id)::int from agency_ops.meta_performance_snapshots s
      where s.run_id=r.id and s.period_days=7 and s.data_status='NO_META_ACCOUNT'
    ),
    metadata=coalesce(r.metadata,'{}'::jsonb) || jsonb_build_object(
      'meta_access_pending_clients',(
        select count(distinct s.client_id)::int from agency_ops.meta_performance_snapshots s
        where s.run_id=r.id and s.period_days=7 and s.data_status='META_ACCESS_PENDING'
      ),
      'access_state_classification_at',now()
    ),
    updated_at=now()
where r.snapshot_date=current_date;