-- Radar de Anuncios: hydrate canonical identity from briefing without overwriting human corrections.

alter table agency_ops.ad_radar_product_entities
  add column if not exists identity_sources jsonb not null default '{}'::jsonb;

create or replace function agency_ops.ad_radar_context_for_product(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  p public.briefing_products%rowtype;
  v_entity uuid;
  v_context uuid;
  v_version text;
  v_answers jsonb := '{}'::jsonb;
  v_sources jsonb := '{}'::jsonb;
  v_name text;
  v_legacy_name text;
  v_developer text;
  v_aliases text[] := '{}';
  v_commercial jsonb := '{}'::jsonb;
begin
  select * into p
    from public.briefing_products
   where id = p_product_id and archived_at is null;
  if not found then raise exception 'radar_product_not_found'; end if;

  v_version := coalesce(p.completed_at, p.updated_at, p.created_at)::text;

  select coalesce(
    jsonb_object_agg(
      a.question_key,
      case
        when a.value_text is not null and btrim(a.value_text) <> '' then to_jsonb(a.value_text)
        else coalesce(a.value_json, 'null'::jsonb)
      end
    ),
    '{}'::jsonb
  )
  into v_answers
  from public.briefing_answers a
  where a.entity_type='PRODUCT'
    and a.entity_id=p.id;

  v_name := coalesce(
    nullif(btrim(v_answers->>'product.name'),''),
    nullif(btrim(v_answers->>'product.legacy.nome_produto'),''),
    nullif(btrim(p.name),''),
    'Produto sem nome'
  );
  v_legacy_name := nullif(btrim(v_answers->>'product.legacy.nome_produto'),'');
  v_developer := nullif(btrim(v_answers->>'product.developer'),'');

  select coalesce(array_agg(distinct x), '{}'::text[])
    into v_aliases
  from unnest(array[
    nullif(btrim(p.name),''),
    nullif(btrim(v_answers->>'product.name'),''),
    v_legacy_name
  ]) x
  where x is not null and lower(x) <> lower(v_name);

  v_commercial := jsonb_strip_nulls(jsonb_build_object(
    'briefing_version', v_version,
    'product_type', nullif(btrim(v_answers->>'product.type'),''),
    'location', nullif(btrim(v_answers->>'product.location'),''),
    'location_value', nullif(btrim(v_answers->>'product.location_value'),''),
    'main_features', nullif(btrim(v_answers->>'product.main_features'),''),
    'differentials', nullif(btrim(v_answers->>'product.differentials'),''),
    'buy_reason', nullif(btrim(v_answers->>'product.buy_reason'),''),
    'not_buy_reason', nullif(btrim(v_answers->>'product.not_buy_reason'),''),
    'stage', nullif(btrim(v_answers->>'product.stage'),''),
    'floorplan', nullif(btrim(v_answers->>'product.floorplan'),''),
    'lot_inventory', nullif(btrim(v_answers->>'product.lot_inventory'),''),
    'price', nullif(btrim(v_answers->>'product.price'),''),
    'public_price_allowed', nullif(btrim(v_answers->>'product.public_price_allowed'),''),
    'developer', v_developer,
    'payment_methods', nullif(btrim(v_answers->>'product.legacy.formas_pagamento'),''),
    'entry_facility', nullif(btrim(v_answers->>'product.legacy.facilidade_entrada'),''),
    'payment_facility', nullif(btrim(v_answers->>'product.legacy.facilidade_pagamento'),'')
  ));

  select id, product_entity_id
    into v_context, v_entity
    from agency_ops.ad_radar_product_contexts
   where briefing_product_id=p.id;

  if v_context is null then
    insert into agency_ops.ad_radar_product_entities(
      canonical_name, aliases, developer, identity_sources
    ) values (
      v_name, v_aliases, v_developer,
      jsonb_strip_nulls(jsonb_build_object(
        'canonical_name','BRIEFING',
        'aliases','BRIEFING',
        'developer',case when v_developer is null then null else 'BRIEFING' end
      ))
    )
    returning id into v_entity;

    insert into agency_ops.ad_radar_product_contexts(
      client_id,briefing_product_id,product_entity_id,briefing_template_id,
      briefing_completed_at,briefing_updated_at,commercial_context,context_version
    ) values (
      p.client_id,p.id,v_entity,p.template_id,
      p.completed_at,p.updated_at,v_commercial,v_version
    )
    returning id into v_context;
  else
    select coalesce(identity_sources,'{}'::jsonb)
      into v_sources
      from agency_ops.ad_radar_product_entities
     where id=v_entity;

    update agency_ops.ad_radar_product_entities
       set canonical_name = case when v_sources->>'canonical_name'='HUMAN' then canonical_name else v_name end,
           aliases = case when v_sources->>'aliases'='HUMAN' then aliases else v_aliases end,
           developer = case when v_sources->>'developer'='HUMAN' then developer else coalesce(v_developer,developer) end,
           identity_sources = v_sources
             || jsonb_strip_nulls(jsonb_build_object(
                  'canonical_name',case when v_sources->>'canonical_name'='HUMAN' then null else 'BRIEFING' end,
                  'aliases',case when v_sources->>'aliases'='HUMAN' then null else 'BRIEFING' end,
                  'developer',case when v_sources->>'developer'='HUMAN' or v_developer is null then null else 'BRIEFING' end
                )),
           updated_at=now()
     where id=v_entity;

    update agency_ops.ad_radar_product_contexts
       set briefing_template_id=p.template_id,
           briefing_completed_at=p.completed_at,
           briefing_updated_at=p.updated_at,
           commercial_context=v_commercial,
           context_version=v_version,
           updated_at=now()
     where id=v_context;
  end if;

  return v_context;
end;
$$;

revoke all on function agency_ops.ad_radar_context_for_product(uuid) from public, anon, authenticated;
grant execute on function agency_ops.ad_radar_context_for_product(uuid) to service_role;
