create or replace function agency_ops.auto_resolve_operational_alerts()
returns integer
language plpgsql
security definer
set search_path = 'agency_ops','crm','pg_catalog'
as $function$
declare
  v_count integer := 0;
  v_rows integer := 0;
  v_thresholds jsonb;
  v_tier1 numeric;
  v_friday_threshold numeric;
  v_is_friday boolean;
  v_now timestamptz := now();
begin
  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved', true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','CLIENT_NO_LONGER_WAITING_AGENCY','resolution_evidence_at',v_now)
   where oa.type='CLIENT_WAITING_SLA'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and not exists (
       select 1 from agency_ops.conversation_state cs
       where oa.alert_key='WA_SLA:'||cs.chat_id
         and cs.waiting_for_agency
         and cs.sla_level in ('ATTENTION','CRITICAL'));
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','CRM_LEAD_LINKED_TO_CLIENT','resolution_evidence_at',v_now)
   where oa.type='SALES_WON_WITHOUT_CLIENT'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and exists (select 1 from agency_ops.clients c where c.crm_lead_id::text=split_part(oa.alert_key,':',2));
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','ONBOARDING_CASE_CREATED','resolution_evidence_at',v_now)
   where oa.type='CONTRACT_SIGNED_WITHOUT_ONBOARDING'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and exists (select 1 from agency_ops.onboarding_cases oc where oc.client_id=oa.client_id and oc.status='OPEN');
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','WHATSAPP_GROUP_LINKED','resolution_evidence_at',v_now)
   where oa.type='ONBOARDING_GROUP_NOT_CREATED'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and exists (select 1 from agency_ops.client_integrations ci where ci.client_id=oa.client_id and ci.system='WHATSAPP_GROUP');
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','COMMITMENT_NO_LONGER_OVERDUE','resolution_evidence_at',v_now)
   where oa.type='COMMITMENT_OVERDUE'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and not exists (
       select 1 from agency_ops.commitments cm
       where cm.id::text=split_part(oa.alert_key,':',2)
         and cm.status in ('OPEN','IN_PROGRESS')
         and cm.due_at is not null and cm.due_at<v_now);
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','ONBOARDING_ACTIVITY_RESUMED','resolution_evidence_at',v_now)
   where oa.type='ONBOARDING_STALLED'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and not exists (
       select 1 from agency_ops.onboarding_cases oc
       where oc.client_id=oa.client_id
         and oc.status='OPEN'
         and coalesce((select max(oe.occurred_at) from agency_ops.onboarding_events oe where oe.case_id=oc.id),oc.opened_at)
             < v_now-make_interval(days=>coalesce((select (value->>'stalled_days')::int from agency_ops.automation_settings where key='onboarding'),3)));
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','CREATIVE_SLA_CONDITION_CLEARED','resolution_evidence_at',v_now)
   where oa.type in ('CREATIVE_SLA_WARNING','CREATIVE_SLA_BREACHED')
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and not exists (
       select 1 from agency_ops.onboarding_cases oc
       where oc.client_id=oa.client_id
         and oc.status='OPEN'
         and oc.creative_due_at is not null
         and not exists (select 1 from agency_ops.onboarding_stages s where s.case_id=oc.id and s.stage_code='CREATIVE_PRODUCTION' and s.status='DONE')
         and oc.creative_due_at<v_now+interval '12 hours');
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','HEALTH_ATTENTION_CONDITION_CLEARED','resolution_evidence_at',v_now)
   where oa.source='NOTION_CLIENT_HEALTH'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and oa.type in ('CRITICAL_CONFLICT','UNMATCHED_HIGH_RISK','REVERSE_CONFLICT','CONFLICT','STALE_NOTION','PARTIAL')
     and not exists (
       select 1 from agency_ops.client_health_attention_queue q
       where 'NOTION_HEALTH:' || coalesce(q.client_id::text,q.external_source_record_id,md5(coalesce(q.display_name,''))) || ':' || q.attention_type = oa.alert_key);
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  select value into v_thresholds from agency_ops.automation_settings where key='meta_balance_thresholds';
  v_tier1 := coalesce((v_thresholds->>'tier1')::numeric,100);
  v_friday_threshold := coalesce((v_thresholds->>'friday_threshold')::numeric,150);
  v_is_friday := extract(dow from (v_now at time zone 'America/Sao_Paulo'))=5;

  update agency_ops.operational_alerts oa
     set status='RESOLVED', resolved_at=v_now,
         metadata=coalesce(oa.metadata,'{}'::jsonb) || jsonb_build_object(
           'auto_resolved',true,'resolution_source','STATE_RECONCILER',
           'resolution_reason','META_BALANCE_RECOVERED_OR_CLIENT_INACTIVE','resolution_evidence_at',v_now)
   where oa.type='META_BALANCE_LOW'
     and oa.status in ('OPEN','ACKNOWLEDGED')
     and exists (
       select 1 from agency_ops.account_ad_balances b
       join agency_ops.clients c on c.id=b.client_id
       where oa.alert_key='META_BALANCE_LOW:'||b.client_id||':'||b.account_key
         and (c.lifecycle<>'ACTIVE' or (
           b.balance_source in ('funding_source_parsed','funding_source_parsed_fallback','graph_balance_field')
           and b.available_balance is not null
           and b.available_balance>v_tier1
           and (not v_is_friday or b.available_balance>v_friday_threshold))));
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;

  update agency_ops.platform_notifications n
     set read_at=coalesce(n.read_at,v_now)
   where n.read_at is null
     and n.metadata ? 'alert_key'
     and exists (select 1 from agency_ops.operational_alerts oa where oa.alert_key=n.metadata->>'alert_key' and oa.status='RESOLVED');

  return v_count;
end;
$function$;

do $do$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname='agency_ops_alert_auto_resolve' limit 1;
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
  perform cron.schedule('agency_ops_alert_auto_resolve','*/2 * * * *','select agency_ops.auto_resolve_operational_alerts();');
end
$do$;
