create or replace function agency_ops.sync_overdue_playbook_sla_notifications()
returns integer
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  r record;
  v_count integer := 0;
  v_label text;
  v_message text;
begin
  for r in
    select * from agency_ops.onboarding_sla_board
    where status='OPEN' and sla_status='OVERDUE'
  loop
    v_label := case r.event_type
      when 'CREATIVE_PRODUCTION' then 'Produção criativa'
      when 'CREATIVE_REVISION' then 'Ajuste criativo'
      when 'CAMPAIGN_LAUNCH' then 'Campanha após aprovação'
      else replace(r.event_type,'_',' ')
    end;
    v_message := format('%s está com o SLA vencido desde %s. Responsável atual: %s.',
      r.display_name,
      to_char(r.due_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
      coalesce(r.responsible_person,r.responsible_role,'não identificado'));

    insert into agency_ops.platform_notifications
      (event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values
      ('onboarding-sla-overdue:'||r.id::text||':responsible',
       'ONBOARDING_SLA_OVERDUE','CRITICAL',
       'SLA vencido: '||v_label||' — '||r.display_name,
       v_message,r.client_id,'onboarding_playbook_sla',null,now(),
       jsonb_build_object(
         'sla_event_id',r.id,'case_id',r.case_id,'event_type',r.event_type,
         'due_at',r.due_at,'target_role',r.responsible_role,'target_person',r.responsible_person,
         'overdue_minutes',r.overdue_minutes,'gt_owner',r.gt_owner,'cs_owner',r.cs_owner
       ))
    on conflict(event_key) do nothing;
    if found then v_count := v_count + 1; end if;

    insert into agency_ops.platform_notifications
      (event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values
      ('onboarding-sla-overdue:'||r.id::text||':management',
       'ONBOARDING_SLA_OVERDUE','CRITICAL',
       'Gestão · SLA vencido: '||v_label||' — '||r.display_name,
       v_message,r.client_id,'onboarding_playbook_sla',null,now(),
       jsonb_build_object(
         'sla_event_id',r.id,'case_id',r.case_id,'event_type',r.event_type,
         'due_at',r.due_at,'target_role','MGMT','target_person','Adler Furtado',
         'overdue_minutes',r.overdue_minutes,'responsible_person',r.responsible_person,
         'gt_owner',r.gt_owner,'cs_owner',r.cs_owner
       ))
    on conflict(event_key) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if exists(select 1 from cron.job where jobname='playbook-sla-overdue-notifications') then
    perform cron.unschedule('playbook-sla-overdue-notifications');
  end if;
  perform cron.schedule(
    'playbook-sla-overdue-notifications',
    '*/15 * * * *',
    'select agency_ops.sync_overdue_playbook_sla_notifications();'
  );
end $$;

select agency_ops.sync_overdue_playbook_sla_notifications();
