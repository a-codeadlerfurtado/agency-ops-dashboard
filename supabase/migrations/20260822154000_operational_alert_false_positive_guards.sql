create or replace function agency_ops.guard_operational_alert_open_state()
returns trigger
language plpgsql
security definer
set search_path='agency_ops','pg_catalog'
as $function$
declare
  v_lifecycle text;
  v_account_key text;
  v_has_inventory boolean;
  v_has_active_campaign boolean;
begin
  if new.status not in ('OPEN','ACKNOWLEDGED') then
    return new;
  end if;

  if new.client_id is not null then
    select c.lifecycle into v_lifecycle from agency_ops.clients c where c.id=new.client_id;
    if v_lifecycle is not null and v_lifecycle not in ('ACTIVE','ONBOARDING') then
      new.status := 'RESOLVED';
      new.resolved_at := coalesce(new.resolved_at,now());
      new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
        'auto_resolved',true,
        'resolution_source','OPEN_STATE_GUARD',
        'resolution_reason','CLIENT_NOT_OPERATIONALLY_ACTIVE',
        'resolution_evidence_at',now(),
        'client_lifecycle',v_lifecycle
      );
      return new;
    end if;
  end if;

  if new.type='ONBOARDING_STALLED' and new.client_id is not null
     and exists (
       select 1 from agency_ops.onboarding_cases oc
       where oc.client_id=new.client_id and oc.status='OPEN'
         and oc.next_action_due is not null and oc.next_action_due>now()
     ) then
    new.status := 'RESOLVED';
    new.resolved_at := coalesce(new.resolved_at,now());
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
      'auto_resolved',true,
      'resolution_source','OPEN_STATE_GUARD',
      'resolution_reason','FUTURE_ONBOARDING_ACTION_SCHEDULED',
      'resolution_evidence_at',now()
    );
    return new;
  end if;

  if new.type='META_BALANCE_LOW' and new.client_id is not null
     and coalesce((new.metadata->>'active_campaigns')::int,0)=0 then
    v_account_key := nullif(new.metadata->>'account_key','');
    select exists(
             select 1 from agency_ops.meta_campaign_inventory mi
             where mi.client_id=new.client_id
               and (v_account_key is null or mi.account_key=v_account_key)
           ),
           exists(
             select 1 from agency_ops.meta_campaign_inventory mi
             where mi.client_id=new.client_id
               and (v_account_key is null or mi.account_key=v_account_key)
               and upper(coalesce(mi.campaign_status,''))='ACTIVE'
           )
      into v_has_inventory,v_has_active_campaign;

    if v_has_inventory and not v_has_active_campaign then
      new.status := 'RESOLVED';
      new.resolved_at := coalesce(new.resolved_at,now());
      new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
        'auto_resolved',true,
        'resolution_source','OPEN_STATE_GUARD',
        'resolution_reason','NO_ACTIVE_CAMPAIGN_FOR_ACCOUNT',
        'resolution_evidence_at',now()
      );
      return new;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_operational_alert_open_state on agency_ops.operational_alerts;
create trigger trg_guard_operational_alert_open_state
before insert or update of status,client_id,type,metadata
on agency_ops.operational_alerts
for each row execute function agency_ops.guard_operational_alert_open_state();

create or replace function agency_ops.auto_resolve_operational_alerts_context()
returns integer
language plpgsql
security definer
set search_path='agency_ops','pg_catalog'
as $function$
declare
  v_count integer := 0;
  v_rows integer := 0;
  v_now timestamptz := now();
begin
  update agency_ops.operational_alerts oa
     set status='RESOLVED',resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb)||jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','CLIENT_NOT_OPERATIONALLY_ACTIVE','resolution_evidence_at',v_now,
           'client_lifecycle',c.lifecycle)
    from agency_ops.clients c
   where oa.client_id=c.id
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and c.lifecycle not in ('ACTIVE','ONBOARDING');
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED',resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb)||jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','FUTURE_ONBOARDING_ACTION_SCHEDULED','resolution_evidence_at',v_now,
           'scheduled_for',oc.next_action_due)
    from agency_ops.onboarding_cases oc
   where oa.client_id=oc.client_id
     and oa.type='ONBOARDING_STALLED'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and oc.status='OPEN'
     and oc.next_action_due is not null
     and oc.next_action_due>v_now;
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED',resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb)||jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','NO_ACTIVE_CAMPAIGN_FOR_ACCOUNT','resolution_evidence_at',v_now)
   where oa.type='META_BALANCE_LOW'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and oa.client_id is not null
     and coalesce((oa.metadata->>'active_campaigns')::int,0)=0
     and exists (
       select 1 from agency_ops.meta_campaign_inventory mi
       where mi.client_id=oa.client_id
         and (nullif(oa.metadata->>'account_key','') is null or mi.account_key=oa.metadata->>'account_key')
     )
     and not exists (
       select 1 from agency_ops.meta_campaign_inventory mi
       where mi.client_id=oa.client_id
         and (nullif(oa.metadata->>'account_key','') is null or mi.account_key=oa.metadata->>'account_key')
         and upper(coalesce(mi.campaign_status,''))='ACTIVE'
     );
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.platform_notifications n
     set read_at=coalesce(n.read_at,v_now)
   where n.read_at is null
     and n.metadata ? 'alert_key'
     and exists (
       select 1 from agency_ops.operational_alerts oa
       where oa.alert_key=n.metadata->>'alert_key' and oa.status='RESOLVED'
     );

  return v_count;
end;
$function$;

do $do$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname='agency_ops_alert_auto_resolve' limit 1;
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
  perform cron.schedule(
    'agency_ops_alert_auto_resolve',
    '*/2 * * * *',
    'select agency_ops.auto_resolve_operational_alerts(); select agency_ops.auto_resolve_operational_alerts_context();'
  );
end
$do$;

select agency_ops.auto_resolve_operational_alerts_context();
