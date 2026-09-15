-- Central de Campanhas v2: resultados canônicos, inventário de campanhas e cobertura real.
alter table agency_ops.meta_campaign_insights
  add column if not exists result_type text,
  add column if not exists result_count numeric,
  add column if not exists cost_per_result numeric,
  add column if not exists result_source text;

update agency_ops.meta_campaign_insights set actions=(actions #>> '{}')::jsonb where jsonb_typeof(actions)='string' and nullif(actions #>> '{}','') is not null;
update agency_ops.meta_campaign_insights set cost_per_action_type=(cost_per_action_type #>> '{}')::jsonb where jsonb_typeof(cost_per_action_type)='string' and nullif(cost_per_action_type #>> '{}','') is not null;

create table if not exists agency_ops.meta_campaign_inventory(
  id bigserial primary key,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  account_key text,
  meta_ad_account_id text not null,
  campaign_id text not null,
  campaign_name text,
  campaign_status text,
  objective text,
  checked_at timestamptz not null default now(),
  unique(client_id,campaign_id)
);
create index if not exists idx_meta_campaign_insights_client_date on agency_ops.meta_campaign_insights(client_id,date_start desc);
create index if not exists idx_meta_campaign_inventory_client_status on agency_ops.meta_campaign_inventory(client_id,campaign_status);

create or replace view agency_ops.campaign_client_latest with(security_invoker=true) as
with marketing_clients as(
 select c.id client_id,c.display_name,c.lifecycle,c.gt_owner from agency_ops.clients c
 where lower(coalesce(c.service,''))='marketing' or exists(select 1 from agency_ops.client_services s where s.client_id=c.id and s.service_key='MARKETING')
),configured as(
 select client_id,count(distinct meta_ad_account_id) filter(where meta_ad_account_id is not null) configured_accounts,string_agg(distinct external_id,' | ') filter(where meta_ad_account_id is not null) configured_account_names from agency_ops.client_integrations where system='META_BM' group by client_id
),inventory as(
 select client_id,count(distinct campaign_id) campaign_inventory_count,count(distinct campaign_id) filter(where upper(coalesce(campaign_status,''))='ACTIVE') active_campaigns,count(distinct campaign_id) filter(where upper(coalesce(campaign_status,''))='PAUSED') paused_campaigns,max(checked_at) inventory_checked_at from agency_ops.meta_campaign_inventory group by client_id
),latest_date as(select client_id,max(date_start) latest_date from agency_ops.meta_campaign_insights group by client_id),latest as(
 select i.client_id,count(distinct i.meta_ad_account_id) insight_accounts,count(distinct i.campaign_id) delivered_campaigns,sum(coalesce(i.spend,0)) spend,sum(coalesce(i.impressions,0)) impressions,sum(coalesce(i.clicks,0)) clicks,sum(coalesce(i.result_count,0)) results,sum(coalesce(i.leads_estimate,0)) leads,max(i.checked_at) checked_at,string_agg(distinct i.result_type,', ' order by i.result_type) filter(where i.result_type is not null) result_types from agency_ops.meta_campaign_insights i join latest_date d on d.client_id=i.client_id and d.latest_date=i.date_start group by i.client_id
)
select m.client_id,m.display_name,m.lifecycle,m.gt_owner,coalesce(c.configured_accounts,0) configured_accounts,c.configured_account_names,d.latest_date,greatest(l.checked_at,inv.inventory_checked_at) checked_at,coalesce(l.insight_accounts,0) insight_accounts,coalesce(inv.campaign_inventory_count,l.delivered_campaigns,0) campaign_count,coalesce(inv.active_campaigns,0) active_campaigns,coalesce(inv.paused_campaigns,0) paused_campaigns,coalesce(l.spend,0) spend,coalesce(l.impressions,0) impressions,coalesce(l.clicks,0) clicks,coalesce(l.results,0) results,coalesce(l.leads,0) leads,l.result_types,
 case when coalesce(l.impressions,0)>0 then coalesce(l.clicks,0)::numeric/l.impressions::numeric*100 end ctr,
 case when coalesce(l.clicks,0)>0 then coalesce(l.spend,0)/l.clicks::numeric end cpc,
 case when coalesce(l.impressions,0)>0 then coalesce(l.spend,0)/l.impressions::numeric*1000 end cpm,
 case when coalesce(l.results,0)>0 then coalesce(l.spend,0)/l.results::numeric end cost_per_result,
 case when d.latest_date is null then null else current_date-d.latest_date end age_days,
 case when coalesce(c.configured_accounts,0)=0 then 'NO_META_ACCOUNT' when coalesce(inv.campaign_inventory_count,0)=0 then 'NO_CAMPAIGNS' when m.lifecycle='CHURNED' and coalesce(inv.active_campaigns,0)>0 and (coalesce(l.spend,0)>0 or coalesce(l.impressions,0)>0) then 'CHURNED_WITH_DELIVERY' when coalesce(inv.active_campaigns,0)=0 then 'NO_ACTIVE_CAMPAIGN' when d.latest_date is null then 'NO_DELIVERY' when current_date-d.latest_date>2 then 'STALE' when coalesce(l.spend,0)=0 and coalesce(l.impressions,0)=0 then 'NO_DELIVERY' else 'ACTIVE_DELIVERY' end delivery_status
from marketing_clients m left join configured c on c.client_id=m.client_id left join inventory inv on inv.client_id=m.client_id left join latest_date d on d.client_id=m.client_id left join latest l on l.client_id=m.client_id;

create or replace view agency_ops.campaign_latest_details with(security_invoker=true) as
with latest_date as(select client_id,max(date_start) latest_date from agency_ops.meta_campaign_insights group by client_id)
select i.*,c.display_name,c.lifecycle,c.gt_owner,case when i.result_count>0 then i.spend/i.result_count end computed_cost_per_result from agency_ops.meta_campaign_insights i join latest_date d on d.client_id=i.client_id and d.latest_date=i.date_start join agency_ops.clients c on c.id=i.client_id;
