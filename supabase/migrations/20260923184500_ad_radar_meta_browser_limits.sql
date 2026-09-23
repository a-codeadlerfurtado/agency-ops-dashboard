-- Radar Meta Browser: conservative limits for the self-hosted public Ads Library collector.
-- One run at a time keeps browser sessions serialized and bounds CPU/RAM and provider latency.
update agency_ops.ad_radar_runtime_config
set max_runs_per_tick = 1,
    max_queries_per_run = 2,
    max_ads_per_query = least(max_ads_per_query,25),
    updated_at = now()
where id = 1;
