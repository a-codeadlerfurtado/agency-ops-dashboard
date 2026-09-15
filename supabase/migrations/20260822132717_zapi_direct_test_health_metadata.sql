insert into agency_ops.automation_settings(key,value)
values ('zapi_direct_test_config', jsonb_build_object('enabled',true,'mode','RAW_ONLY','promote_to_canonical',false,'created_at',now()))
on conflict (key) do update set value=excluded.value;
