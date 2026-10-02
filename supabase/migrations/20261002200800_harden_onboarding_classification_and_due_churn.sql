-- Harden automatic onboarding classification and make dated churns effective.
-- Safe to re-run: production was hot-fixed before this migration was committed.

alter table agency_ops.whatsapp_chat_registry
  drop constraint if exists whatsapp_chat_registry_scope_check;

alter table agency_ops.whatsapp_chat_registry
  add constraint whatsapp_chat_registry_scope_check
  check (scope = any (array[
    'CLIENT'::text,'INTERNAL'::text,'TEST'::text,'UNKNOWN'::text,'COMMERCIAL'::text
  ]));

do $patch$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('agency_ops.apply_onboarding_worker_sync(jsonb)'::regprocedure);

  if position('and r.scope not in (''INTERNAL'',''TEST'')' in v_def) > 0 then
    v_def := replace(
      v_def,
      'and r.scope not in (''INTERNAL'',''TEST'')',
      'and r.scope not in (''INTERNAL'',''TEST'',''COMMERCIAL'')'
    );
  end if;

  v_old := 'if v_evidence_at is null then v_skipped:=v_skipped+1; continue; end if;';
  v_new := 'if v_evidence_at is null or not (v_evidence_types ? ''ONBOARDING_EXPLICITO'' or v_evidence_types ? ''INICIO_PROJETO'') then v_skipped:=v_skipped+1; continue; end if;';
  if position(v_old in v_def) > 0 then
    v_def := replace(v_def,v_old,v_new);
  elsif position('v_evidence_types ? ''ONBOARDING_EXPLICITO''' in v_def) = 0 then
    raise exception 'apply_onboarding_worker_sync strong-evidence guard anchor not found';
  end if;
  execute v_def;

  v_def := pg_get_functiondef('agency_ops.sync_clients_from_whatsapp_onboarding()'::regprocedure);

  if position('and reg.scope not in (''INTERNAL'',''TEST'')' in v_def) > 0 then
    v_def := replace(
      v_def,
      'and reg.scope not in (''INTERNAL'',''TEST'')',
      'and reg.scope not in (''INTERNAL'',''TEST'',''COMMERCIAL'')'
    );
  end if;

  v_old := 'select * from eligible where evidence_at is not null' || chr(10) || '  loop';
  v_new := 'select * from eligible where evidence_at is not null' || chr(10) || '  loop' || chr(10) ||
    '    if not (''ONBOARDING_EXPLICITO'' = any(coalesce(r.evidence_types,array[]::text[])) or ''INICIO_PROJETO'' = any(coalesce(r.evidence_types,array[]::text[]))) then continue; end if;';
  if position(v_old in v_def) > 0
     and position('''ONBOARDING_EXPLICITO'' = any(coalesce(r.evidence_types' in v_def) = 0 then
    v_def := replace(v_def,v_old,v_new);
  elsif position('''ONBOARDING_EXPLICITO'' = any(coalesce(r.evidence_types' in v_def) = 0 then
    raise exception 'sync_clients_from_whatsapp_onboarding strong-evidence guard anchor not found';
  end if;
  execute v_def;
end
$patch$;

create or replace function agency_ops.apply_due_churn_statuses()
returns jsonb
language plpgsql
security definer
set search_path = agency_ops, pg_catalog
as $fn$
declare
  r record;
  v_reactivated_at timestamptz;
  v_applied integer := 0;
  v_resolved integer := 0;
  v_stale integer := 0;
begin
  for r in
    select s.id as status_id,s.client_id,s.expected_at,s.created_at,
           c.display_name,c.lifecycle,c.saida
    from agency_ops.client_operational_status s
    join agency_ops.clients c on c.id=s.client_id
    where s.active=true
      and s.status='churn_previsto'
      and s.expected_at is not null
      and s.expected_at <= current_date
    order by s.expected_at,s.created_at
    for update of s skip locked
  loop
    select max(e.occurred_at)
      into v_reactivated_at
    from agency_ops.client_lifecycle_events e
    where e.client_id=r.client_id
      and e.event_type='CLIENT_REACTIVATED';

    if v_reactivated_at is not null and v_reactivated_at > r.created_at then
      update agency_ops.client_operational_status
      set active=false,resolved_at=now(),resolved_by='SYSTEM_STALE_AFTER_REACTIVATION'
      where id=r.status_id;
      v_resolved:=v_resolved+1;
      v_stale:=v_stale+1;
      continue;
    end if;

    if r.lifecycle in ('ACTIVE','ONBOARDING') then
      update agency_ops.clients
      set lifecycle='CHURNED',
          saida=r.expected_at,
          metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
            'churn_type','churn',
            'churn_source','scheduled_operational_status',
            'churn_expected_status_id',r.status_id,
            'churn_effective_at',now(),
            'churn_reason','Saída programada atingiu a data prevista.'
          ),
          updated_at=now()
      where id=r.client_id
        and lifecycle in ('ACTIVE','ONBOARDING');
      if found then v_applied:=v_applied+1; end if;
    end if;

    update agency_ops.client_operational_status
    set active=false,resolved_at=now(),resolved_by='SYSTEM_DUE_CHURN'
    where id=r.status_id;
    v_resolved:=v_resolved+1;
  end loop;

  return jsonb_build_object(
    'applied',v_applied,
    'resolved_statuses',v_resolved,
    'stale_after_reactivation',v_stale,
    'run_at',now()
  );
end
$fn$;

do $cron$
declare j record;
begin
  for j in select jobid from cron.job where jobname='apply-due-client-churns' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule(
    'apply-due-client-churns',
    '15 * * * *',
    'select agency_ops.apply_due_churn_statuses();'
  );
end
$cron$;
