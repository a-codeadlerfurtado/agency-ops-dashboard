-- Radar de Anuncios: hydrate city/neighborhood from product briefing location without overwriting human identity corrections.

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
begin
  select coalesce(
    nullif(btrim(a.value_text),''),
    nullif(btrim(a.value_json #>> '{}'),'')
  )
  into v_location
  from public.briefing_answers a
  where a.entity_type='PRODUCT'
    and a.entity_id=new.briefing_product_id
    and a.question_key in ('product.location_value','product.location','localizacao')
  order by case a.question_key
    when 'product.location_value' then 1
    when 'product.location' then 2
    else 3
  end
  limit 1;

  if v_location is null then
    return new;
  end if;

  v_city := nullif(btrim(substring(v_location from '(?i)cidade(?:\s+de)?\s*[:\-]?\s*([^,;]+)')),'');
  v_neighborhood := nullif(btrim(substring(v_location from '(?i)bairro\s*[:\-]?\s*([^,;]+)')),'');

  if v_city is null and v_location ~* '^[^,;]{2,60},\s*(bairro\b|[A-Z]{2}\b)' then
    v_city := nullif(btrim(split_part(v_location,',',1)),'');
  end if;

  select coalesce(identity_sources,'{}'::jsonb)
    into v_sources
  from agency_ops.ad_radar_product_entities
  where id=new.product_entity_id;

  update agency_ops.ad_radar_product_entities
     set city = case
                  when v_sources->>'city'='HUMAN' then city
                  else coalesce(v_city,city)
                end,
         neighborhood = case
                          when v_sources->>'neighborhood'='HUMAN' then neighborhood
                          else coalesce(v_neighborhood,neighborhood)
                        end,
         identity_sources = v_sources
           || jsonb_strip_nulls(jsonb_build_object(
                'city',case when v_sources->>'city'='HUMAN' or v_city is null then null else 'BRIEFING' end,
                'neighborhood',case when v_sources->>'neighborhood'='HUMAN' or v_neighborhood is null then null else 'BRIEFING' end
              )),
         updated_at=now()
   where id=new.product_entity_id;

  return new;
end;
$$;

drop trigger if exists trg_ad_radar_sync_location_identity on agency_ops.ad_radar_product_contexts;
create trigger trg_ad_radar_sync_location_identity
after insert or update of briefing_updated_at, commercial_context, product_entity_id
on agency_ops.ad_radar_product_contexts
for each row execute function agency_ops.ad_radar_sync_location_identity();

-- Backfill existing contexts through the same trigger.
update agency_ops.ad_radar_product_contexts
set briefing_updated_at=briefing_updated_at;
