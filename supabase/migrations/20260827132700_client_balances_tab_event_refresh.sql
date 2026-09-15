alter table agency_ops.account_ad_balances
  add column if not exists account_status integer,
  add column if not exists disable_reason integer;

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
  ('balances','ROLE','GT',true,'Saldo Clientes: GT vê somente a própria carteira',now()),
  ('balances','ROLE','CS',true,'Saldo Clientes: CS vê somente a própria carteira',now()),
  ('balances','ROLE','DESIGN',false,'Saldo Clientes indisponível para Design',now()),
  ('balances','ROLE','AI',false,'Saldo Clientes indisponível para IA',now()),
  ('balances','ROLE','COMMERCIAL',false,'Saldo Clientes indisponível para Comercial',now()),
  ('balances','ROLE','MGMT',false,'Saldo Clientes liberado nominalmente apenas para Adler',now()),
  ('balances','PERSON','Adler Furtado',true,'Saldo Clientes: acesso total do Adler',now())
on conflict (view_key,scope_type,scope_value) do update set allowed=excluded.allowed,note=excluded.note,updated_at=excluded.updated_at;

create or replace view agency_ops.client_balance_overview as
with insights as (
  select client_id,account_key,max(date_start) latest_spend_date,max(checked_at) latest_insight_checked_at,
         coalesce(sum(spend) filter(where date_start>=current_date-6),0)::numeric spend_7d,
         count(distinct date_start) filter(where date_start>=current_date-6) spend_days_7d
  from agency_ops.meta_campaign_insights group by client_id,account_key
),latest_day as (
  select m.client_id,m.account_key,coalesce(sum(m.spend),0)::numeric latest_day_spend,
         count(distinct m.campaign_id) filter(where m.campaign_status='ACTIVE')::int active_campaigns
  from agency_ops.meta_campaign_insights m
  join insights i on i.client_id=m.client_id and i.account_key=m.account_key and i.latest_spend_date=m.date_start
  group by m.client_id,m.account_key
)
select c.id client_id,c.display_name,c.lifecycle,c.service,c.cs_owner,c.gt_owner,b.account_key,b.balance,b.available_balance,b.spend_cap,b.amount_spent,b.currency,
       b.funding_type,b.funding_type_label,b.payment_display,b.balance_source,b.account_status,b.disable_reason,b.checked_at,i.latest_spend_date,i.latest_insight_checked_at,
       coalesce(i.spend_7d,0)::numeric spend_7d,case when coalesce(i.spend_days_7d,0)>0 then round(i.spend_7d/i.spend_days_7d,2) else 0::numeric end avg_daily_spend,
       coalesce(ld.latest_day_spend,0)::numeric latest_day_spend,coalesce(ld.active_campaigns,0)::int active_campaigns,
       case when b.client_id is null then 'NO_ACCOUNT'
            when b.funding_type=20 and coalesce(b.available_balance,0)<=0 then 'NO_BALANCE'
            when b.funding_type=20 and b.available_balance<=100 then 'LOW_BALANCE'
            when b.funding_type=20 then 'OK'
            when b.funding_type=1 and b.account_status is not null and b.account_status<>1 then 'BLOCKED'
            when b.funding_type=1 and coalesce(ld.latest_day_spend,0)>0 then 'OK'
            when b.funding_type=1 and coalesce(ld.active_campaigns,0)>0 then 'ATTENTION'
            when b.funding_type=1 then 'NO_ACTIVE_CAMPAIGN' else 'UNKNOWN' end run_status,
       case when b.funding_type=20 and coalesce(i.spend_days_7d,0)>0 and i.spend_7d>0 then round(b.available_balance/(i.spend_7d/i.spend_days_7d),1) else null::numeric end days_remaining
from agency_ops.clients c
left join agency_ops.account_ad_balances b on b.client_id=c.id
left join insights i on i.client_id=c.id and i.account_key=b.account_key
left join latest_day ld on ld.client_id=c.id and ld.account_key=b.account_key
where c.lifecycle in('ACTIVE','ONBOARDING') and coalesce(c.service,'')<>'ia';

create or replace function agency_ops.request_meta_balance_refresh(p_cooldown_minutes integer default 60)
returns jsonb language plpgsql security definer set search_path to 'agency_ops','pg_catalog' as $function$
declare v_lock boolean;v_last_success timestamptz;v_last_request timestamptz;v_cutoff interval;v_request_id bigint;
begin
  v_cutoff:=make_interval(mins=>greatest(coalesce(p_cooldown_minutes,60),30));
  v_lock:=pg_try_advisory_xact_lock(hashtext('agency_ops:meta_balance_event_refresh'));
  if not v_lock then return jsonb_build_object('queued',false,'reason','refresh_in_progress'); end if;
  select last_success_at,updated_at into v_last_success,v_last_request from agency_ops.automation_health where job_name='meta_balance_sync';
  if greatest(coalesce(v_last_success,'epoch'::timestamptz),coalesce(v_last_request,'epoch'::timestamptz))>=now()-v_cutoff then
    return jsonb_build_object('queued',false,'reason','cooldown','last_success_at',v_last_success,'last_request_at',v_last_request,'cooldown_minutes',greatest(coalesce(p_cooldown_minutes,60),30));
  end if;
  insert into agency_ops.automation_health(job_name,updated_at) values('meta_balance_sync',now()) on conflict(job_name) do update set updated_at=now();
  v_request_id:=agency_ops.invoke_meta_balance_sync();
  return jsonb_build_object('queued',true,'request_id',v_request_id,'requested_at',now());
end;$function$;
revoke all on function agency_ops.request_meta_balance_refresh(integer) from public,anon,authenticated;
grant execute on function agency_ops.request_meta_balance_refresh(integer) to service_role;

do $$begin if exists(select 1 from cron.job where jobid=19) then perform cron.alter_job(19,'6 */3 * * *',null,null,null,true); end if;end$$;

create or replace function agency_ops.refresh_meta_balance_sync_watchdog()
returns void language plpgsql security definer set search_path to 'agency_ops','pg_catalog' as $function$
declare v_hb timestamptz;v_err text;v_threshold interval:=interval '4 hours';
begin
 select last_success_at,last_error into v_hb,v_err from agency_ops.automation_health where job_name='meta_balance_sync';
 if v_hb is null or v_hb<now()-v_threshold then
   perform agency_ops.upsert_alert('AUTOMATION_STALLED:meta_balance_sync',null,'AUTOMATION_STALLED','CRITICAL','watchdog','Sync de saldo Meta Ads parada',
     case when v_hb is null then 'meta-balance-sync nunca completou uma execução com sucesso.' else 'Último sucesso: '||v_hb::text||'. A coleta de segurança deveria ocorrer no máximo a cada 3 horas.' end,
     'Verificar agency_ops.job_runs (job_name=''meta_balance_sync'') e o token META_SYSTEM_USER_TOKEN.',jsonb_build_object('last_success_at',v_hb,'last_error',v_err,'fallback_schedule','3h','event_refresh_cooldown','60m'));
 else
   update agency_ops.operational_alerts set status='RESOLVED',resolved_at=now(),last_detected_at=now() where alert_key='AUTOMATION_STALLED:meta_balance_sync' and status in('OPEN','ACKNOWLEDGED');
 end if;
end;$function$;
