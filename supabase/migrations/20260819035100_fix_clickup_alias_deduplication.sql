-- A label can appear with different casing/accents. Rank one normalized label,
-- otherwise duplicate spellings compete with the same client candidate.
create or replace function agency_ops.refresh_clickup_client_aliases()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, agency_ops, public
as $$
declare
  affected integer := 0;
begin
  with raw_labels as (
    select agency_ops.extract_clickup_client_label(name) label
    from agency_ops.clickup_tasks
  ),
  labels as (
    select min(label) label,
           agency_ops.normalize_clickup_label(label) norm,
           agency_ops.canonical_clickup_label(label) canonical,
           agency_ops.clickup_label_token_key(label) token_key
    from raw_labels
    where label is not null
    group by agency_ops.normalize_clickup_label(label),
             agency_ops.canonical_clickup_label(label),
             agency_ops.clickup_label_token_key(label)
  ),
  clients as (
    select id, display_name,
           agency_ops.normalize_clickup_label(display_name) norm,
           agency_ops.canonical_clickup_label(display_name) canonical,
           agency_ops.clickup_label_token_key(display_name) token_key
    from agency_ops.clients
  ),
  scored as (
    select l.label, l.norm, c.id client_id,
      case
        when l.norm = c.norm then 1.0000
        when l.canonical = c.canonical and length(coalesce(l.canonical,'')) >= 2 then 0.9900
        when replace(l.norm,' ','') = replace(c.norm,' ','') and length(replace(coalesce(l.norm,''),' ','')) >= 4 then 0.9800
        when l.token_key = c.token_key and length(replace(coalesce(l.token_key,''),' ','')) >= 4 then 0.9700
        when length(coalesce(l.canonical,'')) >= 4 and (' ' || c.canonical || ' ') like ('% ' || l.canonical || ' %') then 0.9300
        when length(coalesce(c.canonical,'')) >= 4 and (' ' || l.canonical || ' ') like ('% ' || c.canonical || ' %') then 0.9200
        else public.similarity(coalesce(l.canonical,''), coalesce(c.canonical,''))::numeric
      end confidence,
      case
        when l.norm = c.norm then 'EXACT_LABEL'
        when l.canonical = c.canonical and length(coalesce(l.canonical,'')) >= 2 then 'CANONICAL_LABEL'
        when replace(l.norm,' ','') = replace(c.norm,' ','') and length(replace(coalesce(l.norm,''),' ','')) >= 4 then 'COMPACT_LABEL'
        when l.token_key = c.token_key and length(replace(coalesce(l.token_key,''),' ','')) >= 4 then 'TOKEN_SET_LABEL'
        when length(coalesce(l.canonical,'')) >= 4 and (' ' || c.canonical || ' ') like ('% ' || l.canonical || ' %') then 'LABEL_PREFIX'
        when length(coalesce(c.canonical,'')) >= 4 and (' ' || l.canonical || ' ') like ('% ' || c.canonical || ' %') then 'CLIENT_PREFIX'
        else 'FUZZY_LABEL'
      end match_method
    from labels l cross join clients c
    where l.norm is not null and l.norm <> 'sem cliente especifico'
  ),
  ranked as (
    select *, row_number() over(partition by norm order by confidence desc, client_id) rank,
           lead(confidence) over(partition by norm order by confidence desc, client_id) second_confidence
    from scored
  ),
  accepted as (
    select label, norm, client_id, match_method, confidence
    from ranked
    where rank = 1 and (
      (match_method in ('EXACT_LABEL','CANONICAL_LABEL','COMPACT_LABEL','TOKEN_SET_LABEL') and confidence > coalesce(second_confidence, -1))
      or (confidence >= 0.9000 and confidence - coalesce(second_confidence, 0) >= 0.0600)
      or (confidence >= 0.7800 and confidence - coalesce(second_confidence, 0) >= 0.1500)
    )
  )
  insert into agency_ops.clickup_client_aliases(alias, normalized_alias, client_id, match_method, confidence)
  select label, norm, client_id, match_method, confidence from accepted
  on conflict(normalized_alias) do update
    set alias=excluded.alias, client_id=excluded.client_id, match_method=excluded.match_method,
        confidence=excluded.confidence, active=true, updated_at=now()
  where not agency_ops.clickup_client_aliases.is_manual;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

select agency_ops.refresh_clickup_client_aliases();
select agency_ops.reindex_clickup_task_clients();
