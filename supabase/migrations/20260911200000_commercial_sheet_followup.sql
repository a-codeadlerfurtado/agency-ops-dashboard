alter table agency_ops.commercial_followup_clients
  drop constraint if exists commercial_followup_clients_collection_mode_check;

alter table agency_ops.commercial_followup_clients
  add constraint commercial_followup_clients_collection_mode_check
  check (collection_mode = any (array[
    'PLANTAO'::text,'PLANILHA'::text,'GRUPO_MANUAL'::text,
    'CRM_INTEGRADO'::text,'HIBRIDO'::text
  ]));

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
  ('view-oncall','ROLE','MGMT',true,'Acompanhamento Comercial',now()),
  ('view-oncall','ROLE','CS',true,'Acompanhamento Comercial',now())
on conflict (view_key,scope_type,scope_value)
do update set allowed=excluded.allowed,note=excluded.note,updated_at=now();
update agency_ops.commercial_followup_clients c
set collection_mode='PLANILHA', automation_enabled=true,
    group_chat_id='120363409349714754-group', group_chat_name='[COMERCIAL] - MURANO',
    checkin_time='09:00:00',
    source_config=coalesce(c.source_config,'{}'::jsonb) || jsonb_build_object(
      'data_mode','GOOGLE_SHEETS','drive_layout','MONTH_SUBFOLDER',
      'drive_folder_id','1VvatcmUeR0Hk4USdY4XVoz5Yl2Gik8Li',
      'collection_schedule','WEEKDAYS','history_source','google_sheets_and_group'),
    updated_at=now()
where c.slug='murano';

insert into agency_ops.commercial_followup_clients(
  client_id,slug,display_name,collection_mode,automation_enabled,
  group_chat_id,group_chat_name,connected_phone,checkin_time,questions,source_config)
select id,'wall-street','Wall Street','PLANILHA',true,
  '120363429722635010-group','[COMERCIAL] - Wallstreet','5513988051839','09:00:00',
  '["leads_received","leads_contacted","leads_in_conversation","calls_made","calls_answered","visits_scheduled","visits_completed","proposals","sales"]'::jsonb,
  jsonb_build_object('data_mode','GOOGLE_SHEETS','drive_layout','MONTH_SUBFOLDER','drive_folder_id','1gr4PYX6M1PN36uf7v40c_ABCr_JpZMVH','collection_schedule','WEEKDAYS','history_source','google_sheets_and_group')
from agency_ops.clients where display_name='Wall Street' limit 1
on conflict (slug) do update set
  client_id=excluded.client_id,display_name=excluded.display_name,collection_mode='PLANILHA',
  automation_enabled=true,group_chat_id=excluded.group_chat_id,group_chat_name=excluded.group_chat_name,
  checkin_time=excluded.checkin_time,source_config=excluded.source_config,updated_at=now();
update agency_ops.commercial_followup_clients c
set client_id=(select id from agency_ops.clients where display_name='Ronald Chaves' limit 1),
    display_name='Ronald Chaves', collection_mode='PLANILHA', automation_enabled=true,
    group_chat_id='120363409593561087-group', group_chat_name='[COMERCIAL] - Lopes Chaves',
    checkin_time='09:00:00',
    source_config=coalesce(c.source_config,'{}'::jsonb) || jsonb_build_object(
      'data_mode','GOOGLE_SHEETS','drive_layout','BROKER_FOLDERS',
      'drive_folder_id','1IbPZRmYkTDyM9j8dmnfAJp4aG2tiHV2g',
      'collection_schedule','WEEKDAYS','history_source','google_sheets_and_group'),
    updated_at=now()
where c.slug='lopes-chaves';

insert into agency_ops.commercial_followup_clients(
  client_id,slug,display_name,collection_mode,automation_enabled,
  group_chat_id,group_chat_name,connected_phone,checkin_time,questions,source_config)
select id,'imperial-imoveis','Imperial Imóveis','PLANILHA',true,
  '120363428014839066-group','[COMERCIAL] - Imperial Imóveis','5513988051839','09:00:00',
  '["leads_received","leads_contacted","leads_in_conversation","calls_made","calls_answered","visits_scheduled","visits_completed","proposals","sales"]'::jsonb,
  jsonb_build_object('data_mode','GOOGLE_SHEETS','drive_layout','MONTH_SUBFOLDER','drive_folder_id','13c9yV5MljgN63oEtu9TCREKDaoq87ZY_','collection_schedule','WEEKDAYS','history_source','google_sheets_and_group')
from agency_ops.clients where display_name='Imperial Imóveis' limit 1
on conflict (slug) do update set
  client_id=excluded.client_id,display_name=excluded.display_name,collection_mode='PLANILHA',
  automation_enabled=true,group_chat_id=excluded.group_chat_id,group_chat_name=excluded.group_chat_name,
  checkin_time=excluded.checkin_time,source_config=excluded.source_config,updated_at=now();
do $$
declare r record;
begin
  for r in
    select id from agency_ops.commercial_followup_clients
    where slug in ('murano','wall-street','lopes-chaves','imperial-imoveis')
  loop
    perform agency_ops.sync_commercial_followup_schedule(r.id);
  end loop;
end $$;
