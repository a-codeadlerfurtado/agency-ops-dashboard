-- Solicitacao de acesso aparece nas notificacoes do dashboard (sino) em vez de e-mail.
-- Gatilho garante que funcione por qualquer caminho: Edge Function, insert manual
-- ou automacao futura. Aprovar na notificacao ja libera o colaborador, porque a
-- Edge Function eleva quem tem access_requests APPROVED (flag `elevated`).

create or replace function agency_ops.access_request_notify()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  if (tg_op = 'INSERT') then
    insert into agency_ops.platform_notifications
      (event_key, type, level, title, description, source, actor, occurred_at, metadata)
    values (
      'access_request:' || new.id,
      'ACCESS_REQUEST',
      'ATTENTION',
      'Solicitação de acesso: ' || coalesce(new.person, 'colaborador'),
      coalesce(nullif(new.note, ''), coalesce(new.person, 'Um colaborador') || ' pediu liberação de acesso ao dashboard.'),
      'dashboard',
      new.person,
      new.requested_at,
      jsonb_build_object('access_request_id', new.id, 'person', new.person, 'user_key', new.user_key, 'status', new.status)
    )
    on conflict (event_key) do nothing;
    return new;
  end if;

  if (tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'PENDING') then
    update agency_ops.platform_notifications
       set read_at  = coalesce(read_at, now()),
           metadata = metadata || jsonb_build_object('status', new.status, 'decided_by', new.decided_by)
     where event_key = 'access_request:' || new.id;

    insert into agency_ops.platform_notifications
      (event_key, type, level, title, description, source, actor, occurred_at, read_at, metadata)
    values (
      'access_request_decided:' || new.id,
      'ACCESS_REQUEST_DECIDED',
      case when new.status = 'APPROVED' then 'SUCCESS' else 'INFO' end,
      case when new.status = 'APPROVED'
           then 'Acesso liberado: ' || coalesce(new.person, 'colaborador')
           else 'Acesso recusado: ' || coalesce(new.person, 'colaborador') end,
      coalesce(new.decided_by, 'Gestão') || ' decidiu a solicitação.',
      'dashboard',
      new.decided_by,
      coalesce(new.decided_at, now()),
      now(),
      jsonb_build_object('access_request_id', new.id, 'person', new.person, 'status', new.status)
    )
    on conflict (event_key) do nothing;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists access_request_notify_trg on agency_ops.access_requests;
create trigger access_request_notify_trg
after insert or update on agency_ops.access_requests
for each row execute function agency_ops.access_request_notify();

comment on function agency_ops.access_request_notify is
  'Gera notificacao no sino do dashboard quando um colaborador solicita acesso, e registra o desfecho quando a solicitacao e decidida.';
