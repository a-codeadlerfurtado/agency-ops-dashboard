create or replace view agency_ops.client_balance_overview as
with insights as (
  select meta_campaign_insights.client_id,
         meta_campaign_insights.account_key,
         max(meta_campaign_insights.date_start) as latest_spend_date,
         max(meta_campaign_insights.checked_at) as latest_insight_checked_at,
         coalesce(sum(meta_campaign_insights.spend) filter (where meta_campaign_insights.date_start >= (current_date - 6)),0::numeric) as spend_7d,
         count(distinct meta_campaign_insights.date_start) filter (where meta_campaign_insights.date_start >= (current_date - 6) and meta_campaign_insights.spend > 0::numeric)::integer as active_spend_days_7d
  from agency_ops.meta_campaign_insights
  group by meta_campaign_insights.client_id, meta_campaign_insights.account_key
), latest_day as (
  select m.client_id,
         m.account_key,
         coalesce(sum(m.spend),0::numeric) as latest_day_spend,
         count(distinct m.campaign_id) filter (where m.campaign_status='ACTIVE'::text)::integer as active_campaigns
  from agency_ops.meta_campaign_insights m
  join insights i_1 on i_1.client_id=m.client_id and i_1.account_key=m.account_key and i_1.latest_spend_date=m.date_start
  group by m.client_id,m.account_key
)
select c.id as client_id,
       c.display_name,
       c.lifecycle,
       c.service,
       c.cs_owner,
       c.gt_owner,
       b.account_key,
       b.balance,
       b.available_balance,
       b.spend_cap,
       b.amount_spent,
       b.currency,
       b.funding_type,
       b.funding_type_label,
       b.payment_display,
       b.balance_source,
       b.account_status,
       b.disable_reason,
       b.checked_at,
       i.latest_spend_date,
       i.latest_insight_checked_at,
       coalesce(i.spend_7d,0::numeric) as spend_7d,
       case when coalesce(i.spend_7d,0::numeric)>0::numeric then round(i.spend_7d / greatest(1,least(7,coalesce(current_date-c.entrada+1,7)))::numeric,2) else 0::numeric end as avg_daily_spend,
       coalesce(ld.latest_day_spend,0::numeric) as latest_day_spend,
       coalesce(ld.active_campaigns,0) as active_campaigns,
       case
         when b.client_id is null then 'NO_ACCOUNT'::text
         when b.funding_type=20 and coalesce(b.available_balance,0::numeric)<=0::numeric then 'NO_BALANCE'::text
         when b.funding_type=20 and b.available_balance<=100::numeric then 'LOW_BALANCE'::text
         when b.funding_type=20 then 'OK'::text
         when b.funding_type=1 and b.account_status is not null and b.account_status<>1 then 'BLOCKED'::text
         when b.funding_type=1 and coalesce(ld.latest_day_spend,0::numeric)>0::numeric then 'OK'::text
         when b.funding_type=1 and coalesce(ld.active_campaigns,0)>0 then 'ATTENTION'::text
         when b.funding_type=1 then 'NO_ACTIVE_CAMPAIGN'::text
         else 'UNKNOWN'::text
       end as run_status,
       case when b.funding_type=20 and coalesce(i.spend_7d,0::numeric)>0::numeric then round(b.available_balance / (i.spend_7d / greatest(1,least(7,coalesce(current_date-c.entrada+1,7)))::numeric),1) else null::numeric end as days_remaining,
       greatest(1,least(7,coalesce(current_date-c.entrada+1,7))) as spend_window_days,
       coalesce(i.active_spend_days_7d,0) as active_spend_days_7d,
       mi.meta_ad_account_id,
       wr.carteira
from agency_ops.clients c
left join agency_ops.account_ad_balances b on b.client_id=c.id
left join lateral (
  select ci.meta_ad_account_id
  from agency_ops.client_integrations ci
  where ci.client_id=c.id and ci.system='META_BM'::text and ci.meta_ad_account_id is not null
    and (ci.external_id=b.account_key or ci.external_name=b.account_key or (select count(*) from agency_ops.client_integrations ci2 where ci2.client_id=c.id and ci2.system='META_BM'::text and ci2.meta_ad_account_id is not null)=1)
  order by (ci.external_id=b.account_key or ci.external_name=b.account_key) desc, ci.is_primary desc nulls last, ci.id desc
  limit 1
) mi on true
left join insights i on i.client_id=c.id and i.account_key=b.account_key
left join latest_day ld on ld.client_id=c.id and ld.account_key=b.account_key
left join lateral (
  select w.carteira
  from agency_ops.wallet_registry w
  where w.gt_owner=c.gt_owner
  order by w.ordem
  limit 1
) wr on true
where c.lifecycle=any(array['ACTIVE'::text,'ONBOARDING'::text]) and coalesce(c.service,''::text)<>'ia'::text;
