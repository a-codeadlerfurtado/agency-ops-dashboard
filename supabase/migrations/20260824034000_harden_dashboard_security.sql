-- Restrict privileged webhook RPCs to trusted server-side callers.
revoke all on function public.ingest_zapi_direct_official_atomic(jsonb, text) from public, anon, authenticated;
revoke all on function public.ingest_zapi_direct_test_atomic(jsonb, text) from public, anon, authenticated;
revoke all on function public.process_zapi_direct_pending(integer) from public, anon, authenticated;

grant execute on function public.ingest_zapi_direct_official_atomic(jsonb, text) to service_role;
grant execute on function public.ingest_zapi_direct_test_atomic(jsonb, text) to service_role;
grant execute on function public.process_zapi_direct_pending(integer) to service_role;

-- Pin deterministic lookup paths so callers cannot influence object resolution.
alter function agency_ops.ai_work_item_clean_text(text, integer)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.ai_work_item_section(text, text, text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.compact_ai_work_item_description(text, jsonb)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.compact_task_engine_work_item_before_write()
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.creative_learning_statement(text, text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.extract_google_meet_url(text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.extract_vgv_prelabel(text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.normalize_work_item_role_scope()
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.pt_month_number(text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.tg_normalize_won_event_vgv()
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.touch_weekly_traffic_reports_updated_at()
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.weekly_rate_context(numeric, numeric, text)
  set search_path = pg_catalog, agency_ops, public, extensions;
alter function agency_ops.weekly_safe_rate(numeric, numeric)
  set search_path = pg_catalog, agency_ops, public, extensions;
