-- Radar de Anuncios: tighten location parsing and prefer structured product.location over descriptive location_value.

create or replace function agency_ops.ad_radar_sync_location_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  v_location text;
  v_city text;
  v_neighborhood text;
  v_sources jsonb := '{}'::jsonb;
  v_match text[];
begin
  select coalesce(
    nullif(btrim(a.value_text),''),
    nullif(btrim(a.value_json #>> '{}'),'')
  )
  into v_location
  from public.briefing_answers a
  where a.entity_type='PRODUCT'
    and a.entity_id=new.briefing_product_id
    and a.question_key in ('product.location','localizacao','product.location_value')
  order by case a.question_key
    when 'product.location' then 1
    when 'localizacao' then 2
    else 3
  end
  limit 1;

  select coalesce(identity_sources,'{}'::jsonb)
    into v_sources
  from agency_ops.ad_radar_product_entities
  where id=new.product_entity_id;

  if v_location is not null then
    v_city := nullif(btrim(substring(v_location from '(?i)(?:^|[[:space:],;])cidade(?:\s+de)?\s*[:\-]?\s*([^,;|]+)')),'');
    v_neighborhood := nullif(btrim(substring(v_location from '(?i)(?:^|[[:space:],;])bairro\s*[:\-]?\s*([^,;|]+)')),'');

    if v_city is null then
      v_match := regexp_match(v_location, '^\s*([^,|]{2,80})\s*,\s*([^|]{2,80}?)\s*[-/]\s*[A-Z]{2}(?:\b|\s*\|)', 'i');
      if v_match is not null then
        v_neighborhood := coalesce(v_neighborhood,nullif(btrim(v_match[1]),''));
        v_city := nullif(btrim(v_match[2]),'');
      end if;
    end if;

    if v_city is null then
      v_match := regexp_match(v_location, '^\s*([^,|]{2,80}?)\s*[-/]\s*[A-Z]{2}(?:\b|\s*\|)', 'i');
      if v_match is not null then
        v_city := nullif(btrim(v_match[1]),'');
      end if;
    end if;
  end if;

  update agency_ops.ad_radar_product_entities
     set city = case
                  when v_sources->>'city'='HUMAN' then city
                  when v_city is not null then v_city
                  when v_sources->>'city'='BRIEFING' then null
                  else city
                end,
         neighborhood = case
                          when v_sources->>'neighborhood'='HUMAN' then neighborhood
                          when v_neighborhood is not null then v_neighborhood
                          when v_sources->>'neighborhood'='BRIEFING' then null
                          else neighborhood
                        end,
         identity_sources =
           (v_sources - 'city' - 'neighborhood')
           || jsonb_strip_nulls(jsonb_build_object(
                'city',case when v_sources->>'city'='HUMAN' then 'HUMAN' when v_city is not null then 'BRIEFING' else null end,
                'neighborhood',case when v_sources->>'neighborhood'='HUMAN' then 'HUMAN' when v_neighborhood is not null then 'BRIEFING' else null end
              )),
         updated_at=now()
   where id=new.product_entity_id;

  return new;
end;
$$;

update agency_ops.ad_radar_product_contexts
set briefing_updated_at=briefing_updated_at;
