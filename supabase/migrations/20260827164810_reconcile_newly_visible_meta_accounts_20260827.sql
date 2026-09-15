do $$
declare
  r record;
  v_client uuid;
begin
  for r in
    select * from (values
      ('Lua Imóveis Sorocaba','4494629937532952','CA01 - LUA IMOVEIS'),
      ('Marcia Pacheco','1709636713719707','Marcia cristiane'),
      ('Raquel Lage','814676431643416','CA 01 - RAQUEL LAGE IMÓVEIS'),
      ('Remax SJC','2610385495904427','CA01 - REMAX SJC')
    ) as x(client_name, account_id, account_name)
  loop
    select id into v_client from agency_ops.clients where display_name=r.client_name limit 1;
    if v_client is null then
      raise exception 'Client not found: %', r.client_name;
    end if;

    update agency_ops.client_integrations
       set is_primary=false,
           matched_by='historical_wrong_meta_account_replaced_20260827',
           metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'replaced_at',now(),
             'replaced_by_meta_ad_account_id',r.account_id,
             'replacement_account_name',r.account_name,
             'reason','Live Meta discovery plus campaign evidence identified the current account'
           ) - 'pending_meta_ad_account_id'
     where client_id=v_client
       and system='META_AD_ACCOUNT'
       and is_primary=true;

    if not exists (
      select 1 from agency_ops.client_integrations
      where client_id=v_client and system='META_BM' and meta_ad_account_id=r.account_id
    ) then
      insert into agency_ops.client_integrations
        (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
      values
        (v_client,'META_BM',r.account_name,r.account_name,r.account_id,'ALTA',
         'META_LIVE_ACCOUNT_AND_CAMPAIGN_MATCH',true,
         jsonb_build_object('matched_at',now(),'source','live_meta_discovery','evidence','account_name_and_campaigns'));
    else
      update agency_ops.client_integrations
         set is_primary=true,
             external_id=r.account_name,
             external_name=r.account_name,
             matched_by='META_LIVE_ACCOUNT_AND_CAMPAIGN_MATCH',
             metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('matched_at',now(),'source','live_meta_discovery')
       where client_id=v_client and system='META_BM' and meta_ad_account_id=r.account_id;
    end if;

    update agency_ops.integration_match_review
       set status='RESOLVED', resolved_client_id=v_client, resolved_by='SYSTEM_LIVE_CAMPAIGN_MATCH', resolved_at=now(),
           resolution_note='Resolved from live Meta account visibility and campaign evidence.'
     where system='META_AD_ACCOUNT' and external_id=r.account_id and status<>'RESOLVED';
  end loop;
end $$;
