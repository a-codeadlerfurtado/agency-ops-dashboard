create or replace function agency_ops.notify_creative_preapproval_ready()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','extensions','pg_temp'
as $$
declare
  v_client_name text;
  v_product_name text;
  r record;
begin
  if new.status <> 'WAITING_CS' then
    return new;
  end if;

  select c.display_name into v_client_name
  from agency_ops.clients c
  where c.id = new.client_id;

  v_client_name := coalesce(nullif(trim(v_client_name),''), nullif(trim(new.client_label),''), 'cliente');
  v_product_name := trim(regexp_replace(
    coalesce(new.subject,''),
    '^(criativos?|ajuste na campanha|campanha)\s*[-–—:]\s*',
    '',
    'i'
  ));
  if v_product_name = '' then
    v_product_name := coalesce(nullif(trim(new.subject),''), 'Produto não identificado');
  end if;

  for r in
    select distinct tr.person, tr.role
    from agency_ops.team_roster tr
    where tr.is_former = false
      and (tr.role = 'CS' or tr.person = 'Adler Furtado')
      and nullif(trim(tr.person),'') is not null
  loop
    insert into agency_ops.platform_notifications (
      event_key,
      type,
      level,
      title,
      description,
      client_id,
      source,
      actor,
      occurred_at,
      metadata
    ) values (
      'creative-ready:' || new.submission_message_id || ':' || md5(r.person),
      'CREATIVE_READY_FOR_CS',
      'INFO',
      'Criativo de ' || v_client_name || ' pronto!',
      'Produto: ' || v_product_name,
      new.client_id,
      'creative_preapproval',
      coalesce(new.submitted_by,'Design'),
      new.submitted_at,
      jsonb_build_object(
        'private_to_person', true,
        'target_person', r.person,
        'target_role', r.role,
        'preapproval_item_id', new.id,
        'product_name', v_product_name,
        'drive_url', new.drive_url,
        'submission_kind', new.submission_kind,
        'workflow', 'DESIGN_TO_CS_PREAPPROVAL'
      )
    )
    on conflict (event_key) do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_creative_preapproval_ready on agency_ops.creative_preapproval_items;
create trigger trg_notify_creative_preapproval_ready
after insert on agency_ops.creative_preapproval_items
for each row execute function agency_ops.notify_creative_preapproval_ready();

revoke execute on function agency_ops.notify_creative_preapproval_ready() from public, anon, authenticated;
grant execute on function agency_ops.notify_creative_preapproval_ready() to service_role;
