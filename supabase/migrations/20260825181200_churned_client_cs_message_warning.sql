create table if not exists agency_ops.churned_client_message_warnings (
  id uuid primary key default gen_random_uuid(),
  whatsapp_message_id bigint not null unique references agency_ops.whatsapp_messages(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  client_name text not null,
  chat_id text not null,
  chat_name text,
  target_person text not null,
  actor_name text not null,
  message_type text,
  message_text text,
  message_at timestamptz not null,
  churned_at timestamptz,
  is_good_morning boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists churned_client_message_warnings_target_open_idx
  on agency_ops.churned_client_message_warnings(target_person, created_at desc)
  where acknowledged_at is null;

alter table agency_ops.churned_client_message_warnings enable row level security;
revoke all on agency_ops.churned_client_message_warnings from anon, authenticated;

create or replace function agency_ops.capture_cs_message_to_churned_client()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
declare
  v_client_id uuid;
  v_client_name text;
  v_lifecycle text;
  v_saida date;
  v_churned_at timestamptz;
  v_actor_name text;
  v_actor_role text;
  v_target_person text;
  v_message_at timestamptz;
  v_message_text text;
  v_normalized text;
  v_good_morning boolean := false;
begin
  if not coalesce(new.is_group, false) or coalesce(new.is_newsletter, false) then
    return new;
  end if;

  if lower(coalesce(new.source, '')) like '%backfill%'
     or lower(coalesce(new.source, '')) like '%archive%' then
    return new;
  end if;

  select x.client_id
    into v_client_id
  from (
    select r.client_id, 0 as ord
      from agency_ops.whatsapp_chat_registry r
     where r.chat_id = new.chat_id and r.client_id is not null
    union all
    select g.client_id, 1 as ord
      from agency_ops.whatsapp_group_registry g
     where g.chat_id = new.chat_id and g.client_id is not null
  ) x
  order by x.ord
  limit 1;

  if v_client_id is null then
    return new;
  end if;

  select c.display_name, c.lifecycle, c.saida
    into v_client_name, v_lifecycle, v_saida
    from agency_ops.clients c
   where c.id = v_client_id;

  if v_lifecycle is distinct from 'CHURNED' then
    return new;
  end if;

  select l.created_at
    into v_churned_at
    from agency_ops.client_churn_log l
   where l.client_id = v_client_id
     and coalesce(l.confirmed, true)
   order by l.created_at desc
   limit 1;

  v_message_at := coalesce(new.event_at, new.received_at, now());

  -- Evita alarme falso se uma mensagem antiga for ingerida depois do churn.
  if v_churned_at is not null and v_message_at < v_churned_at then
    return new;
  end if;
  if v_churned_at is null and v_saida is not null and v_message_at::date <= v_saida then
    return new;
  end if;

  select t.canonical_name, t.role
    into v_actor_name, v_actor_role
    from agency_ops.whatsapp_team_identities t
   where t.active
     and (
       (t.identity_type = 'PHONE' and t.identity_value = regexp_replace(coalesce(new.sender_phone,''), '\\D', '', 'g'))
       or
       (t.identity_type = 'NAME' and lower(regexp_replace(coalesce(new.sender_name,''), '[^a-zA-Z0-9 ]', '', 'g')) like '%' || t.identity_value || '%')
     )
   order by case when t.identity_type = 'PHONE' then 0 else 1 end
   limit 1;

  if v_actor_role is distinct from 'CS' or v_actor_name is null then
    return new;
  end if;

  select q.pessoa
    into v_target_person
    from agency_ops.identidade_whatsapp_para_quadro q
   where lower(q.nome_whatsapp) = lower(v_actor_name)
     and q.papel_whatsapp = 'CS'
     and coalesce(q.no_quadro, false)
   limit 1;

  v_target_person := coalesce(v_target_person, v_actor_name);
  v_message_text := left(coalesce(nullif(new.text_body,''), nullif(new.caption,''), '[' || coalesce(new.message_type,'mensagem') || ']'), 700);
  v_normalized := lower(unaccent(coalesce(new.text_body,'') || ' ' || coalesce(new.caption,'')));
  v_good_morning := v_normalized ~ '(^|[^a-z0-9])bom[[:space:][:punct:]]+dia+([^a-z0-9]|$)';

  insert into agency_ops.churned_client_message_warnings (
    whatsapp_message_id, client_id, client_name, chat_id, chat_name,
    target_person, actor_name, message_type, message_text, message_at,
    churned_at, is_good_morning, metadata
  ) values (
    new.id, v_client_id, v_client_name, new.chat_id, new.chat_name,
    v_target_person, v_actor_name, new.message_type, v_message_text, v_message_at,
    v_churned_at, v_good_morning,
    jsonb_build_object('source', new.source, 'sender_name', new.sender_name, 'sender_phone', new.sender_phone)
  )
  on conflict (whatsapp_message_id) do nothing;

  return new;
end;
$$;

revoke all on function agency_ops.capture_cs_message_to_churned_client() from public;

drop trigger if exists trg_warn_cs_message_to_churned_client on agency_ops.whatsapp_messages;
create trigger trg_warn_cs_message_to_churned_client
after insert or update of chat_id, chat_name, sender_name, sender_phone, text_body, caption, event_at, received_at, source, is_group
on agency_ops.whatsapp_messages
for each row execute function agency_ops.capture_cs_message_to_churned_client();
