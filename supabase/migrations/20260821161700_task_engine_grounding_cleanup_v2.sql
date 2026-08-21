comment on column agency_ops.generated_tasks.grounding_score is
  'Deterministic grounding confidence computed after AI suggestion and before any LIVE delivery.';
comment on column agency_ops.generated_tasks.grounding_reason is
  'Deterministic validation outcome explaining why a generated task was accepted or discarded.';
comment on column agency_ops.generated_tasks.source_excerpt_hash is
  'SHA-256 of the event excerpt used to validate this generated task without duplicating source text.';
comment on column agency_ops.generated_tasks.validation_version is
  'Version of the deterministic Task Engine validation rules applied to the row.';

comment on table agency_ops.system_review_events is
  'Technical review queue for AI suggestions that are system/data-maintenance work rather than human operational tasks.';

revoke all on agency_ops.system_review_events from anon, authenticated;
grant select, insert, update on agency_ops.system_review_events to service_role;

update agency_ops.generated_tasks
set validation_version = 'legacy-pre-grounding-v2'
where validation_version is null;

update agency_ops.generated_tasks
set
  status = 'DESCARTADA',
  grounding_score = 0.2500,
  grounding_reason = case
    when lower(titulo) like '%triagem%' or lower(titulo) like '%titularidade%'
      then 'retroactive:internal_system_task'
    when lower(titulo) like '%pagamento%'
      then 'retroactive:unsupported_context:pagamento'
    when lower(titulo) like '%notifica%'
      then 'retroactive:unsupported_context:notificacao'
    else 'retroactive:grounding_rejected'
  end,
  validation_version = 'grounding-v2-retroactive',
  evidencia = coalesce(evidencia, '{}'::jsonb) || jsonb_build_object(
    'discard_reason', 'grounding_v2_retroactive_cleanup',
    'validation_version', 'grounding-v2-retroactive'
  )
where status = 'PROPOSTA'
  and (
    lower(titulo) like '%triagem%'
    or lower(titulo) like '%titularidade%'
    or (
      lower(titulo) like '%pagamento%'
      and lower(coalesce(evidencia->>'trecho', '')) not like '%pagamento%'
      and lower(coalesce(evidencia->>'trecho', '')) not like '%pagar%'
      and lower(coalesce(evidencia->>'trecho', '')) not like '%boleto%'
      and lower(coalesce(evidencia->>'trecho', '')) not like '%cobran%'
    )
    or (
      lower(titulo) like '%notifica%'
      and lower(coalesce(evidencia->>'trecho', '')) not like '%notifica%'
    )
  );