-- Performance Meta is intentionally Adler-only. Browser users never read the warehouse directly;
-- the authenticated Edge API resolves the collaborator and returns 404 to every non-Adler profile.
revoke all on table agency_ops.meta_performance_runs from anon, authenticated;
revoke all on table agency_ops.meta_performance_queue from anon, authenticated;
revoke all on table agency_ops.meta_performance_snapshots from anon, authenticated;
revoke all on table agency_ops.meta_campaign_performance_snapshots from anon, authenticated;
revoke all on sequence agency_ops.meta_performance_queue_id_seq from anon, authenticated;
revoke all on sequence agency_ops.meta_performance_snapshots_id_seq from anon, authenticated;
revoke all on sequence agency_ops.meta_campaign_performance_snapshots_id_seq from anon, authenticated;
