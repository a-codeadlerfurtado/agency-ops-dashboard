create or replace function agency_ops.auto_promote_exact_pending_meta_review()
returns trigger
language plpgsql
as $function$
declare
  v_client_id uuid;
  v_client_count integer;
begin
  if new.system is distinct from 'META_AD_ACCOUNT' or nullif(trim(new.external_id),'') is null then
    return new;
  end if;

  select count(distinct ci.client_id), min(ci.client_id::text)::uuid
    into v_client_count, v_client_id
  from agency_ops.client_integrations ci
  where ci.system='META_AD_ACCOUNT'
    and ci.metadata->>'pending_meta_ad_account_id'=new.external_id;

  if v_client_count=1
     and not exists (
       select 1 from agency_ops.client_integrations x
       where x.meta_ad_account_id=new.external_id
         and x.client_id<>v_client_id
     ) then
    insert into agency_ops.client_integrations
      (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
    values
      (v_client_id,'META_BM',new.external_id,new.external_name,new.external_id,'ALTA','LAK_DISCOVERY_EXACT_PENDING_ID',true,
       jsonb_build_object('promoted_at',now(),'source','integration_match_review','rule','EXACT_PENDING_META_AD_ACCOUNT_ID'))
    on conflict do nothing;

    new.status := 'RESOLVED';
    new.resolved_client_id := v_client_id;
    new.resolved_by := 'SYSTEM_EXACT_META_ID';
    new.resolved_at := now();
    new.resolution_note := 'Conta ficou visível ao ecossistema Meta da LAK e o ID coincide exatamente com pending_meta_ad_account_id do cliente.';
  end if;
  return new;
end;
$function$;
