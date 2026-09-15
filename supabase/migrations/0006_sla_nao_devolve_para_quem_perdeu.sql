-- Imobi-Board 0006 - correcao de redistribuicao
--
-- Achado no teste da 0005: um lead cujo SLA estourou com a Maria foi
-- redistribuido para a propria Maria. O rodizio estava matematicamente correto
-- (o cursor da fila e global e havia voltado nela), mas o comportamento de
-- produto e errado: quem acabou de deixar o prazo passar nao pode receber o
-- mesmo lead de volta na sequencia.
--
-- distribuir() passa a aceitar p_excluir e pular esse usuario, DESDE QUE haja
-- outro corretor ativo na fila. Com um unico corretor, excluir deixaria o lead
-- sem destino nenhum - nesse caso ele volta para a mesma pessoa, que e o menos
-- ruim dos dois.

create or replace function imobi_board_priv.distribuir(
  p_opportunity_id uuid,
  p_queue_id       uuid,
  p_tentativa      smallint default 1,
  p_excluir        uuid default null
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_fila    imobi_board.lead_queues%rowtype;
  v_membro  imobi_board.queue_members%rowtype;
  v_ativos  int;
  v_excluir uuid;
  v_assign  uuid;
begin
  select * into v_fila from imobi_board.lead_queues
  where id = p_queue_id and status = 'ACTIVE';
  if not found then
    raise exception 'Fila inexistente ou inativa.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_queue_id::text, 0));

  select count(*) into v_ativos
  from imobi_board.queue_members m
  where m.queue_id = p_queue_id and m.active;

  if v_ativos = 0 then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  -- com um unico corretor ativo, excluir alguem deixaria o lead sem destino
  v_excluir := case when v_ativos > 1 then p_excluir end;

  select m.* into v_membro
  from imobi_board.queue_members m
  where m.queue_id = p_queue_id and m.active
    and m.sort_order > v_fila.cursor_sort_order
    and (v_excluir is null or m.user_id <> v_excluir)
  order by m.sort_order limit 1;

  if not found then
    select m.* into v_membro
    from imobi_board.queue_members m
    where m.queue_id = p_queue_id and m.active
      and (v_excluir is null or m.user_id <> v_excluir)
    order by m.sort_order limit 1;
  end if;

  if not found then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  update imobi_board.lead_queues
     set cursor_sort_order = v_membro.sort_order
   where id = p_queue_id;

  insert into imobi_board.lead_assignments
    (tenant_id, opportunity_id, queue_id, user_id, expires_at, attempt)
  values
    (v_fila.tenant_id, p_opportunity_id, p_queue_id, v_membro.user_id,
     now() + make_interval(secs => v_fila.acceptance_timeout_seconds), p_tentativa)
  returning id into v_assign;

  update imobi_board.opportunities
     set assigned_user_id  = v_membro.user_id,
         first_assigned_at = coalesce(first_assigned_at, now()),
         accepted_at       = null
   where id = p_opportunity_id;

  perform imobi_board_priv.emit_event(
    v_fila.tenant_id, 'opportunity.assigned', 'opportunity', p_opportunity_id,
    jsonb_build_object('assignment_id', v_assign, 'user_id', v_membro.user_id,
                       'queue_id', p_queue_id, 'attempt', p_tentativa));

  return v_assign;
end;
$fn$;

-- expirar_assignment passa quem perdeu o prazo para ser pulado
create or replace function imobi_board.expirar_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_a    imobi_board.lead_assignments%rowtype;
  v_novo uuid;
begin
  select * into v_a from imobi_board.lead_assignments
  where id = p_assignment_id for update;

  if not found then return jsonb_build_object('resultado', 'nao_encontrado'); end if;
  if v_a.status = 'ACCEPTED' then return jsonb_build_object('resultado', 'ja_aceito'); end if;
  if v_a.status <> 'PENDING' then
    return jsonb_build_object('resultado', 'ja_resolvido', 'status', v_a.status);
  end if;
  if now() < v_a.expires_at then
    return jsonb_build_object('resultado', 'ainda_no_prazo', 'expires_at', v_a.expires_at);
  end if;

  update imobi_board.lead_assignments
     set status = 'MISSED', resolved_at = now()
   where id = p_assignment_id;

  perform imobi_board_priv.emit_event(
    v_a.tenant_id, 'assignment.sla_missed', 'opportunity', v_a.opportunity_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'user_id', v_a.user_id,
                       'attempt', v_a.attempt));

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_a.tenant_id, v_a.opportunity_id, 'SYSTEM',
          'SLA de aceite perdido. Lead redistribuido.', null);

  if v_a.queue_id is not null and v_a.attempt < 5 then
    begin
      v_novo := imobi_board_priv.distribuir(
        v_a.opportunity_id, v_a.queue_id, (v_a.attempt + 1)::smallint, v_a.user_id);
      update imobi_board.lead_assignments set status = 'REASSIGNED'
       where id = p_assignment_id;
      return jsonb_build_object('resultado', 'redistribuido', 'novo_assignment_id', v_novo);
    exception when others then
      update imobi_board.opportunities set assigned_user_id = null
       where id = v_a.opportunity_id;
      return jsonb_build_object('resultado', 'sem_corretor_disponivel', 'erro', sqlerrm);
    end;
  end if;

  update imobi_board.opportunities set assigned_user_id = null
   where id = v_a.opportunity_id;
  return jsonb_build_object('resultado', 'devolvido_a_fila');
end;
$fn$;

create or replace function imobi_board.distribuir_lead(
  p_opportunity_id uuid, p_queue_id uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from imobi_board.opportunities where id = p_opportunity_id;
  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = (select auth.uid()) and m.tenant_id = v_tenant
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) then
    raise exception 'Apenas o administrador distribui leads.' using errcode = '42501';
  end if;
  return imobi_board_priv.distribuir(p_opportunity_id, p_queue_id, 1::smallint, null);
end;
$fn$;

-- a assinatura antiga de 3 argumentos deixa de existir
drop function if exists imobi_board_priv.distribuir(uuid, uuid, smallint);

revoke execute on function imobi_board_priv.distribuir(uuid, uuid, smallint, uuid) from public;
revoke execute on function imobi_board.distribuir_lead(uuid, uuid) from public;
grant execute on function imobi_board.distribuir_lead(uuid, uuid) to authenticated;
grant execute on function imobi_board.expirar_assignment(uuid) to service_role;
