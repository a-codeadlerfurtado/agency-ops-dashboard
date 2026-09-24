-- Radar de Anuncios: gradual production rollout using the self-hosted public Meta Ads Library browser collector.
-- Pilot completed before broad refresh. Keep one run/query at a time and retain the external kill switch.

update agency_ops.ad_radar_runtime_config
set provider='META_BROWSER',
    enabled=true,
    auto_briefing_enabled=true,
    external_collection_enabled=true,
    scheduled_refresh_enabled=true,
    max_runs_per_tick=1,
    max_queries_per_run=1,
    max_ads_per_query=25,
    refresh_days=14,
    updated_at=now()
where id=1;
