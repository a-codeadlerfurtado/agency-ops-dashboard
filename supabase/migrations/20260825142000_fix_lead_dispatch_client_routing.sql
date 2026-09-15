create or replace function agency_ops.resolve_meta_lead_dispatch_routing()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public, pg_catalog
as $$
declare
  v_product_norm text;
  v_chat_norm text;
  v_chat_ids uuid[];
  v_exact_product_ids uuid[];
  v_max_campaign_score numeric := 0;
  v_group_evidence integer := 0;
begin
  v_product_norm := agency_ops.normalize_match_text(new.product_label);
  v_chat_norm := agency_ops.normalize_match_text(coalesce(new.raw_json->>'chatName',''));

  -- A conversa direta identificada pelo nome do contato é evidência mais forte
  -- de quem recebeu a mensagem do que similaridade aproximada de nome de campanha.
  if new.recipient_client_id is null and length(coalesce(v_chat_norm,'')) >= 5 then
    select array_agg(id)
    into v_chat_ids
    from (
      select c.id
      from agency_ops.clients c
      where c.lifecycle in ('ACTIVE','ONBOARDING')
        and length(agency_ops.normalize_match_text(c.display_name)) >= 5
        and position(agency_ops.normalize_match_text(c.display_name) in v_chat_norm) > 0
      group by c.id
    ) s;

    if coalesce(cardinality(v_chat_ids),0) = 1 then
      new.recipient_client_id := v_chat_ids[1];
      new.recipient_match_method := 'DIRECT_CHAT_NAME_UNIQUE_CLIENT';
    end if;
  end if;

  if length(coalesce(v_product_norm,'')) >= 5 then
    -- Primeiro procura ownership exato do produto nas conversas do próprio cliente.
    -- Isso evita confundir, por exemplo, SÃO JOAQUIM com SÃO JOÃO.
    select array_agg(client_id)
    into v_exact_product_ids
    from (
      select distinct gr.client_id
      from agency_ops.whatsapp_messages wm
      join agency_ops.whatsapp_group_registry gr
        on gr.chat_id = wm.chat_id
       and gr.client_id is not null
      join agency_ops.clients c on c.id = gr.client_id
      where c.lifecycle in ('ACTIVE','ONBOARDING')
        and agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,'')) like '%' || v_product_norm || '%'
    ) s;

    if coalesce(cardinality(v_exact_product_ids),0) = 1 then
      new.expected_client_id := v_exact_product_ids[1];
      new.expected_match_method := 'WHATSAPP_GROUP_PRODUCT_UNIQUE_CLIENT';
    elsif new.expected_match_method = 'CAMPAIGN_PRODUCT_UNIQUE_CLIENT' then
      select coalesce(max(
        case when (x->>'score') ~ '^[0-9]+(\.[0-9]+)?$' then (x->>'score')::numeric else null end
      ),0)
      into v_max_campaign_score
      from jsonb_array_elements(coalesce(new.expected_candidates,'[]'::jsonb)) x;

      -- Similaridades abaixo de 0,72 são fracas demais para declarar ownership.
      if v_max_campaign_score < 0.72 then
        new.expected_client_id := null;
        new.expected_match_method := null;
      end if;
    end if;
  end if;

  if new.recipient_client_id is not null and length(coalesce(v_product_norm,'')) >= 5 then
    select count(*)::integer
    into v_group_evidence
    from agency_ops.whatsapp_messages wm
    join agency_ops.whatsapp_group_registry gr
      on gr.chat_id = wm.chat_id
     and gr.client_id = new.recipient_client_id
    where agency_ops.normalize_match_text(coalesce(wm.text_body,wm.caption,'')) like '%' || v_product_norm || '%';

    new.group_product_evidence_count := v_group_evidence;
  end if;

  if new.recipient_client_id is not null and new.expected_client_id is not null
     and new.recipient_client_id <> new.expected_client_id then
    new.routing_status := 'ROUTING_CONFLICT';
  elsif new.recipient_client_id is not null and new.expected_client_id = new.recipient_client_id then
    new.routing_status := 'ROUTING_OK';
  elsif new.recipient_client_id is not null and new.expected_client_id is null and v_group_evidence > 0 then
    new.routing_status := 'ROUTING_OK';
  elsif new.recipient_client_id is not null then
    new.routing_status := 'ROUTING_PROBABLE';
  else
    new.routing_status := 'ROUTING_UNKNOWN';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_resolve_meta_lead_dispatch_routing on agency_ops.meta_lead_dispatches;
create trigger trg_resolve_meta_lead_dispatch_routing
before insert or update on agency_ops.meta_lead_dispatches
for each row execute function agency_ops.resolve_meta_lead_dispatch_routing();
