-- Retira Agenda da operacao e desfaz os pontos de capacidade que causaram regressao.
-- Team Now e desativado na Edge Function; aqui removemos a captura da Agenda e
-- garantimos que os jobs pesados nao encostem um no outro.

drop trigger if exists trg_capture_meeting_agenda on agency_ops.whatsapp_messages;

update agency_ops.dashboard_view_permissions
set allowed = false,
    note = 'Agenda removida em 2026-08-24 para reduzir carga operacional',
    updated_at = now()
where view_key = 'agenda';

revoke execute on function public.agenda_for_current_user(timestamptz,timestamptz) from authenticated;

do $do$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agency_ops_alerts_refresh' limit 1;
  if v_jobid is not null then
    perform cron.alter_job(job_id := v_jobid, schedule := '32 * * * *');
  end if;

  select jobid into v_jobid from cron.job where jobname = 'agency_ops_alert_auto_resolve' limit 1;
  if v_jobid is not null then
    perform cron.alter_job(job_id := v_jobid, schedule := '34 * * * *');
  end if;

  select jobid into v_jobid from cron.job where jobname = 'zapi-direct-official-drain' limit 1;
  if v_jobid is not null then
    perform cron.alter_job(
      job_id := v_jobid,
      schedule := '1,11,21,31,41,51 * * * *',
      command := 'select agency_ops.zapi_direct_official_tick(250);'
    );
  end if;
end
$do$;
