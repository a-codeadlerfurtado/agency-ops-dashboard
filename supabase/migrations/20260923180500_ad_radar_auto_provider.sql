-- Radar de Anuncios: choose any configured external provider without rebuilding the queue.
alter table agency_ops.ad_radar_runtime_config alter column provider set default 'AUTO';
alter table agency_ops.ad_radar_runs alter column provider set default 'AUTO';

update agency_ops.ad_radar_runtime_config
set provider='AUTO', updated_at=now()
where id=1 and upper(provider)='FOREPLAY';
