create or replace view agency_ops.client_balance_overview as
with insights as (
  select client_id,account_key,max(date_start) latest_spend_date,max(checked_at) latest_insight_checked_at,
         coalesce(sum(spend) filter(where date_start>=current_date-6),0)::numeric spend_7d,
         count(distinct date_start) filter(where date_start>=current_date-6 and spend>0)::int active_spend_days_7d
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
       coalesce(i.spend_7d,0)::numeric spend_7d,
       case when coalesce(i.spend_7d,0)>0 then round(i.spend_7d/greatest(1,least(7,coalesce((current_date-c.entrada::date)+1,7))),2) else 0::numeric end avg_daily_spend,
       coalesce(ld.latest_day_spend,0)::numeric latest_day_spend,coalesce(ld.active_campaigns,0)::int active_campaigns,
       case when b.client_id is null then 'NO_ACCOUNT'
            when b.funding_type=20 and coalesce(b.available_balance,0)<=0 then 'NO_BALANCE'
            when b.funding_type=20 and b.available_balance<=100 then 'LOW_BALANCE'
            when b.funding_type=20 then 'OK'
            when b.funding_type=1 and b.account_status is not null and b.account_status<>1 then 'BLOCKED'
            when b.funding_type=1 and coalesce(ld.latest_day_spend,0)>0 then 'OK'
            when b.funding_type=1 and coalesce(ld.active_campaigns,0)>0 then 'ATTENTION'
            when b.funding_type=1 then 'NO_ACTIVE_CAMPAIGN' else 'UNKNOWN' end run_status,
       case when b.funding_type=20 and coalesce(i.spend_7d,0)>0 then round(b.available_balance/(i.spend_7d/greatest(1,least(7,coalesce((current_date-c.entrada::date)+1,7)))),1) else null::numeric end days_remaining,
       greatest(1,least(7,coalesce((current_date-c.entrada::date)+1,7)))::int spend_window_days,
       coalesce(i.active_spend_days_7d,0)::int active_spend_days_7d
from agency_ops.clients c
left join agency_ops.account_ad_balances b on b.client_id=c.id
left join insights i on i.client_id=c.id and i.account_key=b.account_key
left join latest_day ld on ld.client_id=c.id and ld.account_key=b.account_key
where c.lifecycle in('ACTIVE','ONBOARDING') and coalesce(c.service,'')<>'ia';
