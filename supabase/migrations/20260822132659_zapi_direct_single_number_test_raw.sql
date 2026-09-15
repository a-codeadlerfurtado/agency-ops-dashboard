create table if not exists agency_ops.whatsapp_zapi_direct_test (
  id bigserial primary key,
  capture_key text not null unique,
  message_id text not null,
  instance_id text,
  connected_phone text,
  chat_id text,
  chat_name text,
  participant_phone text,
  participant_lid text,
  sender_phone text,
  sender_lid text,
  sender_name text,
  from_me boolean not null default false,
  is_group boolean not null default false,
  is_newsletter boolean not null default false,
  event_type text,
  message_type text,
  text_body text,
  caption text,
  moment_raw text,
  event_at timestamptz,
  received_at timestamptz not null default now(),
  status text,
  raw_json jsonb not null default '{}'::jsonb,
  duplicate_hits integer not null default 0,
  last_seen_at timestamptz not null default now()
);

create index if not exists whatsapp_zapi_direct_test_message_idx on agency_ops.whatsapp_zapi_direct_test(message_id);
create index if not exists whatsapp_zapi_direct_test_event_idx on agency_ops.whatsapp_zapi_direct_test(event_at desc);
create index if not exists whatsapp_zapi_direct_test_chat_idx on agency_ops.whatsapp_zapi_direct_test(chat_id,event_at desc);
create index if not exists whatsapp_zapi_direct_test_phone_idx on agency_ops.whatsapp_zapi_direct_test(connected_phone,event_at desc);

insert into agency_ops.automation_settings(key,value)
values ('WA_DIRECT_TEST_TOKEN', to_jsonb(encode(gen_random_bytes(32),'hex')))
on conflict (key) do nothing;

insert into agency_ops.automation_health(job_name,last_success_at,updated_at)
values ('zapi_direct_test',null,now())
on conflict (job_name) do nothing;

revoke all on agency_ops.whatsapp_zapi_direct_test from public, anon, authenticated;
grant select,insert,update on agency_ops.whatsapp_zapi_direct_test to service_role;
grant usage,select on sequence agency_ops.whatsapp_zapi_direct_test_id_seq to service_role;
