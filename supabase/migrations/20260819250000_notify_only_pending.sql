-- O gatilho criava a notificacao de "Aprovar cadastro" em qualquer INSERT, inclusive
-- quando o pedido ja nascia APPROVED (caso do backfill retroativo em 20260819240000).
-- Resultado: o sino pedia para aprovar algo que ja estava aprovado.
-- Agora so notifica pedido PENDENTE.
create or replace function agency_ops.access_request_notify()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
declare quem text := coalesce(new.person, 'colaborador');
begin
  if (tg_op = 'INSERT' and new.status = 'PENDING') then
    insert into agency_ops.platform_notifications
      (event_key, type, level, title, description, source, actor, occurred_at, metadata)
    values ('access_request:' || new.id,
      case when new.kind='SIGNUP' then 'SIGNUP_APPROVAL' else 'ACCESS_REQUEST' end,
      'ATTENTION',
      case when new.kind='SIGNUP' then 'Aprovar cadastro: ' || quem else 'Solicitação de acesso: ' || quem end,
      coalesce(nullif(new.note,''), case when new.kind='SIGNUP'
        then quem || ' criou conta e aguarda sua liberação para entrar.'
        else quem || ' pediu acesso além do próprio perfil.' end),
      'dashboard', new.person, new.requested_at,
      jsonb_build_object('access_request_id',new.id,'person',new.person,
                         'user_key',new.user_key,'status',new.status,'kind',new.kind))
    on conflict (event_key) do nothing;
    return new;
  end if;

  if (tg_op='UPDATE' and new.status is distinct from old.status and new.status <> 'PENDING') then
    update agency_ops.platform_notifications
       set read_at=coalesce(read_at,now()),
           metadata=metadata||jsonb_build_object('status',new.status,'decided_by',new.decided_by)
     where event_key='access_request:'||new.id;
    insert into agency_ops.platform_notifications
      (event_key,type,level,title,description,source,actor,occurred_at,read_at,metadata)
    values ('access_request_decided:'||new.id,'ACCESS_REQUEST_DECIDED',
      case when new.status='APPROVED' then 'SUCCESS' else 'INFO' end,
      case when new.status='APPROVED'
           then (case when new.kind='SIGNUP' then 'Cadastro liberado: ' else 'Acesso liberado: ' end)||quem
           else (case when new.kind='SIGNUP' then 'Cadastro recusado: ' else 'Acesso recusado: ' end)||quem end,
      coalesce(new.decided_by,'Gestão')||' decidiu a solicitação.',
      'dashboard',new.decided_by,coalesce(new.decided_at,now()),now(),
      jsonb_build_object('access_request_id',new.id,'person',new.person,'status',new.status,'kind',new.kind))
    on conflict (event_key) do nothing;
    return new;
  end if;
  return new;
end; $$;

delete from agency_ops.platform_notifications
 where type = 'SIGNUP_APPROVAL'
   and metadata->>'access_request_id' in (
     select id::text from agency_ops.access_requests where status <> 'PENDING'
   );
