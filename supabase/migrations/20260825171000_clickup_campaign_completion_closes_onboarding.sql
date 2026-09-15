-- Regra operacional: o onboarding termina quando a primeira campanha foi efetivamente
-- subida/publicada pelo time. Uma task de tráfego do tipo `[CLIENTE] - Campanha - ...`
-- concluída no ClickUp é evidência operacional suficiente de que a subida foi executada,
-- mesmo que a campanha ainda esteja aguardando saldo/pagamento do cliente para começar a gastar.
-- Isso NÃO significa que a campanha esteja ACTIVE no Meta; apenas que a entrega de lançamento
-- que encerra o onboarding foi realizada.

create or replace function agency_ops.apply_onboarding_campaign_clickup_task(p_task_id text)
returns boolean
language plpgsql
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
declare
  t agency_ops.clickup_tasks%rowtype;
  v_case_id bigint;
  v_done_at timestamptz;
  v_name_norm text;
  v_list_norm text;
  v_changed integer := 0;
begin
  select * into t
  from agency_ops.clickup_tasks
  where task_id = p_task_id;

  if not found or t.client_id is null then
    return false;
  end if;

  if not coalesce(t.is_closed,false)
     and lower(coalesce(t.status_type,'')) not in ('closed','done') then
    return false;
  end if;

  v_name_norm := lower(extensions.unaccent(coalesce(t.name,'')));
  v_list_norm := lower(extensions.unaccent(coalesce(t.list_name,'')));

  -- Só a task de SUBIDA de campanha encerra onboarding.
  -- Ajustes/otimizações posteriores não contam como primeiro lançamento.
  if v_name_norm not like '% - campanha - %'
     or v_name_norm like '%ajuste na campanha%'
     or v_list_norm <> 'trafego pago' then
    return false;
  end if;

  v_done_at := coalesce(t.date_closed,t.date_updated,t.last_synced_at,now());

  select oc.id into v_case_id
  from agency_ops.onboarding_cases oc
  where oc.client_id=t.client_id
    and oc.status='OPEN'
    and oc.opened_at <= v_done_at
  order by oc.opened_at desc,oc.id desc
  limit 1;

  if v_case_id is null then
    return false;
  end if;

  perform set_config('agency_ops.onboarding_internal_update','on',true);

  update agency_ops.onboarding_stages
  set status='DONE',
      completed_at=coalesce(completed_at,v_done_at),
      blocked_type=null,
      notes=case
        when coalesce(notes,'') ilike '%ClickUp concluída comprova campanha subida/publicada%'
          then notes
        else concat_ws(
          ' | ',
          nullif(notes,''),
          'ClickUp concluída comprova campanha subida/publicada: '||coalesce(t.name,'Campanha')||' ['||t.task_id||']'
        )
      end
  where case_id=v_case_id
    and stage_code='CAMPAIGN_LAUNCH'
    and status<>'DONE';
  get diagnostics v_changed=row_count;

  update agency_ops.onboarding_stages
  set status='DONE',
      completed_at=coalesce(completed_at,v_done_at),
      blocked_type=null,
      notes=case
        when coalesce(notes,'') ilike '%Subida comprovada por ClickUp%'
          then notes
        else concat_ws(' | ',nullif(notes,''),'Subida comprovada por ClickUp')
      end
  where case_id=v_case_id
    and stage_code='READY_TO_LAUNCH'
    and status<>'DONE';

  insert into agency_ops.onboarding_evidence(
    case_id,kind,source,source_id,occurred_at,confidence,status,metadata,applied_at
  )
  select
    v_case_id,
    'CAMPAIGN_PUBLISHED',
    'clickup',
    t.task_id,
    v_done_at,
    'CONFIRMED',
    'AUTO_APPLIED',
    jsonb_build_object(
      'stage_code','CAMPAIGN_LAUNCH',
      'evidence_text',coalesce(t.name,''),
      'clickup_status',t.status,
      'clickup_status_type',t.status_type,
      'clickup_url',t.url,
      'list_name',t.list_name,
      'assignees',t.assignee_names,
      'meaning','CAMPAIGN_UPLOADED_OR_PUBLISHED_BY_TRAFFIC_TEAM',
      'meta_active_confirmed',false,
      'note','Task concluída encerra onboarding; saldo/ativação de mídia pode continuar como pendência operacional separada.'
    ),
    now()
  where not exists(
    select 1
    from agency_ops.onboarding_evidence e
    where e.case_id=v_case_id
      and e.source='clickup'
      and e.source_id=t.task_id
      and e.kind='CAMPAIGN_PUBLISHED'
  );

  if v_changed > 0 then
    perform agency_ops.recalculate_onboarding_case(v_case_id);
    begin
      perform agency_ops.run_onboarding_notification_engine();
    exception when others then null;
    end;
    return true;
  end if;

  return false;
end;
$$;

create or replace function agency_ops.tg_clickup_campaign_closes_onboarding()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
begin
  perform agency_ops.apply_onboarding_campaign_clickup_task(new.task_id);
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_clickup_campaign_closes_onboarding on agency_ops.clickup_tasks;
create trigger trg_clickup_campaign_closes_onboarding
after insert or update of client_id,name,status,status_type,is_closed,date_closed,date_updated,list_name
on agency_ops.clickup_tasks
for each row execute function agency_ops.tg_clickup_campaign_closes_onboarding();

-- Backfill seguro: aplica a nova regra apenas a onboardings ainda OPEN e tasks fechadas
-- criadas/fechadas depois da abertura do próprio onboarding.
do $$
declare
  r record;
begin
  for r in
    select distinct ct.task_id
    from agency_ops.clickup_tasks ct
    join agency_ops.onboarding_cases oc
      on oc.client_id=ct.client_id
     and oc.status='OPEN'
     and oc.opened_at <= coalesce(ct.date_closed,ct.date_updated,ct.last_synced_at,now())
    where ct.client_id is not null
      and (coalesce(ct.is_closed,false) or lower(coalesce(ct.status_type,'')) in ('closed','done'))
      and lower(extensions.unaccent(coalesce(ct.name,''))) like '% - campanha - %'
      and lower(extensions.unaccent(coalesce(ct.name,''))) not like '%ajuste na campanha%'
      and lower(extensions.unaccent(coalesce(ct.list_name,'')))='trafego pago'
    order by ct.task_id
  loop
    perform agency_ops.apply_onboarding_campaign_clickup_task(r.task_id);
  end loop;
end;
$$;

revoke execute on function agency_ops.apply_onboarding_campaign_clickup_task(text) from public,anon,authenticated;
revoke execute on function agency_ops.tg_clickup_campaign_closes_onboarding() from public,anon,authenticated;
grant execute on function agency_ops.apply_onboarding_campaign_clickup_task(text) to service_role;
grant execute on function agency_ops.tg_clickup_campaign_closes_onboarding() to service_role;
