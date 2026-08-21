-- Resolve cliente também em grupos internos multi-cliente quando a mensagem traz
-- um prefixo explícito [NOME DO CLIENTE], como no grupo de aprovações/design.

create or replace function agency_ops.tg_enqueue_task_event()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public', 'extensions', 'pg_temp'
as $$
declare
  v_txt       text;
  v_cls       record;
  v_client    uuid;
  v_espera    interval;
  v_existente bigint;
  v_prefixo   text;
begin
  if coalesce(new.from_me, false) or not coalesce(new.is_group, false) then return new; end if;

  v_txt := coalesce(nullif(trim(new.text_body),''), nullif(trim(new.caption),''));
  if v_txt is null then return new; end if;

  begin
    select * into v_cls from agency_ops.classify_message_urgency(v_txt);
    if v_cls.signals @> array['RUIDO'] or v_cls.signals @> array['SEM_SINAL'] then
      return new;
    end if;

    select ci.client_id into v_client
    from agency_ops.client_integrations ci
    where ci.system = 'WHATSAPP_GROUP' and ci.external_id = new.chat_id
    limit 1;

    if v_client is null then
      select cs.client_id into v_client
      from agency_ops.conversation_state cs
      where cs.chat_id = new.chat_id
      limit 1;
    end if;

    if v_client is null then
      select r.client_id into v_client
      from agency_ops.whatsapp_chat_registry r
      where r.chat_id = new.chat_id and r.client_id is not null
      limit 1;
    end if;

    if v_client is null then
      select g.client_id into v_client
      from agency_ops.whatsapp_group_registry g
      where g.chat_id = new.chat_id and g.client_id is not null
      limit 1;
    end if;

    -- Grupos internos como [APROVAÇÕES] - Design podem misturar clientes.
    -- Neles, o padrão legado já traz [CLIENTE] no próprio texto; quando houver
    -- correspondência exata, esse prefixo é uma evidência forte e determinística.
    if v_client is null then
      v_prefixo := nullif(trim(substring(v_txt from '\[([^\]]+)\]')), '');
      if v_prefixo is not null then
        select c.id into v_client
        from agency_ops.clients c
        where lower(extensions.unaccent(c.display_name)) = lower(extensions.unaccent(v_prefixo))
           or lower(extensions.unaccent(coalesce(c.normalized_name,''))) = lower(extensions.unaccent(v_prefixo))
        order by case when c.lifecycle in ('ACTIVE','ONBOARDING') then 0 else 1 end, c.updated_at desc
        limit 1;
      end if;
    end if;

    v_espera := case when v_cls.urgency = 'URGENT' then interval '0'
                     when v_cls.urgency = 'HIGH'   then interval '3 minutes'
                     else interval '5 minutes' end;

    select id into v_existente
    from agency_ops.task_generation_events
    where chat_id = new.chat_id and status = 'PENDING'
    order by id desc limit 1;

    if v_existente is not null then
      update agency_ops.task_generation_events e
      set urgency = case when 'URGENT' in (e.urgency, v_cls.urgency) then 'URGENT'
                         when 'HIGH'   in (e.urgency, v_cls.urgency) then 'HIGH'
                         else e.urgency end,
          signals = (select array_agg(distinct x) from unnest(e.signals || v_cls.signals) x),
          message_id = new.message_id,
          excerpt = left(coalesce(e.excerpt,'') || chr(10) || v_txt, 4000),
          client_id = coalesce(e.client_id, v_client),
          available_at = least(e.available_at, now() + v_espera)
      where e.id = v_existente;
    else
      insert into agency_ops.task_generation_events
        (source, chat_id, client_id, message_id, urgency, signals, excerpt, available_at)
      values ('WHATSAPP', new.chat_id, v_client, new.message_id,
              v_cls.urgency, v_cls.signals, left(v_txt,4000), now() + v_espera);
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- Corrige apenas eventos ainda não processados, sem reabrir histórico concluído.
with parsed as (
  select e.id,
         nullif(trim(substring(e.excerpt from '\[([^\]]+)\]')), '') as prefixo
  from agency_ops.task_generation_events e
  where e.client_id is null and e.status in ('PENDING','ERROR')
), matched as (
  select p.id, c.id as client_id
  from parsed p
  join lateral (
    select c.id
    from agency_ops.clients c
    where p.prefixo is not null
      and (lower(extensions.unaccent(c.display_name)) = lower(extensions.unaccent(p.prefixo))
        or lower(extensions.unaccent(coalesce(c.normalized_name,''))) = lower(extensions.unaccent(p.prefixo)))
    order by case when c.lifecycle in ('ACTIVE','ONBOARDING') then 0 else 1 end, c.updated_at desc
    limit 1
  ) c on true
)
update agency_ops.task_generation_events e
set client_id = m.client_id
from matched m
where e.id = m.id;
