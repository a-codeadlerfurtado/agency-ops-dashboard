do $$
declare
  v_paulo uuid;
  v_jair uuid;
  v_account_id text := '1112538460879885';
begin
  select id into v_paulo from agency_ops.clients where display_name='Paulo Vinícius' limit 1;
  select id into v_jair from agency_ops.clients where display_name='Jair Pereira de Souza' limit 1;
  if v_paulo is null then raise exception 'Paulo Vinícius not found'; end if;
  if v_jair is null then raise exception 'Jair Pereira de Souza not found'; end if;

  update agency_ops.client_integrations
     set system='META_AD_ACCOUNT',
         is_primary=false,
         meta_ad_account_id=null,
         matched_by='historical_account_reassigned_to_paulo_20260827',
         metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
           'historical_meta_ad_account_id',v_account_id,
           'reassigned_to_client','Paulo Vinícius',
           'reassigned_at',now(),
           'reason','Management confirmed the BM/account was formerly Jair and is now operated for Paulo Vinícius'
         )
   where client_id=v_jair
     and system='META_BM'
     and meta_ad_account_id=v_account_id;

  if not exists (
    select 1 from agency_ops.client_integrations
    where client_id=v_paulo and system='META_BM' and meta_ad_account_id=v_account_id
  ) then
    insert into agency_ops.client_integrations
      (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
    values
      (v_paulo,'META_BM','Paulo Vinícius - CA 01','Paulo Vinícius - CA 01',v_account_id,'ALTA',
       'MANAGEMENT_CONFIRMED_BM_REUSE_FROM_JAIR',true,
       jsonb_build_object(
         'confirmed_at',now(),
         'confirmed_by','Adler Furtado',
         'previous_client','Jair Pereira de Souza',
         'reason','Management confirmed this BM/ad account used to belong to Jair and is now used for Paulo Vinícius'
       ));
  else
    update agency_ops.client_integrations
       set is_primary=true,
           external_id='Paulo Vinícius - CA 01',
           external_name='Paulo Vinícius - CA 01',
           matched_by='MANAGEMENT_CONFIRMED_BM_REUSE_FROM_JAIR',
           metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'confirmed_at',now(),'confirmed_by','Adler Furtado','previous_client','Jair Pereira de Souza'
           )
     where client_id=v_paulo and system='META_BM' and meta_ad_account_id=v_account_id;
  end if;

  update agency_ops.integration_match_review
     set status='RESOLVED', resolved_client_id=v_paulo, resolved_by='MANAGEMENT_CONFIRMED', resolved_at=now(),
         resolution_note='Management confirmed account/BM was previously Jair and is now used for Paulo Vinícius.'
   where system='META_AD_ACCOUNT' and external_id=v_account_id and status<>'RESOLVED';
end $$;
