create or replace function agency_ops.zapi_direct_official_tick(p_limit integer default 250)
returns jsonb
language plpgsql
security definer
set search_path=agency_ops,public,pg_catalog
as $$
declare
  v_result jsonb;
begin
  v_result := agency_ops.process_zapi_raw_pending(p_limit);
  insert into agency_ops.automation_health(job_name,last_success_at,last_error_at,last_error,updated_at)
  values('zapi_direct_official',now(),null,null,now())
  on conflict(job_name) do update set
    last_success_at=excluded.last_success_at,
    last_error_at=null,
    last_error=null,
    updated_at=now();
  return v_result;
exception when others then
  insert into agency_ops.automation_health(job_name,last_error_at,last_error,updated_at)
  values('zapi_direct_official',now(),sqlerrm,now())
  on conflict(job_name) do update set
    last_error_at=now(),last_error=sqlerrm,updated_at=now();
  raise;
end;
$$;

select cron.schedule('zapi-direct-official-drain','* * * * *','select agency_ops.zapi_direct_official_tick(250);');

insert into agency_ops.automation_health(job_name,last_success_at,last_error_at,last_error,updated_at)
values('zapi_direct_official',now(),null,null,now())
on conflict(job_name) do update set last_success_at=now(),last_error_at=null,last_error=null,updated_at=now();

create or replace function agency_ops.refresh_automation_watchdog()
returns void
language plpgsql
security definer
set search_path=agency_ops,public,pg_catalog
as $$
declare
  v_hb timestamptz;
  v_last_raw timestamptz;
  v_pending integer;
  v_error integer;
begin
  select last_success_at into v_hb
  from agency_ops.automation_health
  where job_name='zapi_direct_official';

  select max(received_at) into v_last_raw from agency_ops.whatsapp_zapi_raw;
  select count(*) filter(where status in ('PENDING','PROCESSING')),
         count(*) filter(where status='ERROR')
  into v_pending,v_error
  from agency_ops.zapi_message_processing_queue;

  if v_hb is null or v_hb < now() - interval '5 minutes' then
    perform agency_ops.upsert_alert(
      'CAPTURE_STALLED:whatsapp',null,'CAPTURE_STALLED','CRITICAL','watchdog',
      'Captura WhatsApp parada',
      'O processador oficial Z-API -> Supabase não executa há mais de 5 minutos. Último tick: '||coalesce(v_hb::text,'nunca'),
      'Verificar Edge Function zapi-direct-test-ingest e cron zapi-direct-official-drain.',
      jsonb_build_object('last_tick',v_hb,'last_raw_received_at',v_last_raw,'pending',v_pending,'errors',v_error)
    );
  elsif v_error > 0 then
    perform agency_ops.upsert_alert(
      'CAPTURE_STALLED:whatsapp',null,'CAPTURE_STALLED','CRITICAL','watchdog',
      'Falha no processamento WhatsApp',
      v_error||' mensagem(ns) estão em erro na fila oficial. A captura RAW continua preservada.',
      'Verificar agency_ops.zapi_message_processing_queue.',
      jsonb_build_object('last_tick',v_hb,'last_raw_received_at',v_last_raw,'pending',v_pending,'errors',v_error)
    );
  end if;
end;
$$;

do $$
declare
  v_def text;
begin
  select definition into v_def
  from pg_views
  where schemaname='agency_ops' and viewname='integration_health_overview';

  if v_def is not null then
    v_def := replace(v_def, 'FROM agency_ops.whatsapp_messages', 'FROM agency_ops.whatsapp_zapi_raw whatsapp_messages');
    v_def := replace(v_def, '''sheet_sync''::text', '''zapi_direct_official''::text');
    execute 'create or replace view agency_ops.integration_health_overview as '||v_def;
  end if;
end $$;
