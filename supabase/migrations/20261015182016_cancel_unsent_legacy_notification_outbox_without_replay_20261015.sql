-- Versioned copy of migration already applied to imobi-pro on 2026-10-15.
-- Historical notification records preserved but cannot be replayed automatically.
update agency_ops.notification_outbox
set status='CANCELLED',
    last_error='LEGACY_OUTBOX_RETIRED_2026-10-09_NO_REPLAY',
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('retirement_reason','LEGACY_OUTBOX_RETIRED','retirement_at',now(),'historical_status','PENDING','send_suppressed',true)
where status='PENDING' and attempt_count=0;
