-- ImobiBoard - troca manual do corretor responsavel por um lead.
-- A operacao e exclusiva do ADMIN do tenant e e atomica.

create or replace function imobi_board.reassign_opportunity_broker(
  p_opportunity_id uuid,
  p_broker_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_opp imobi_board.opportunities%rowtype;
  v_old_name text;
  v_new_name text;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  select * into v_opp
    from imobi_board.opportunities
   where id = p_opportunity_id
   for update;

  if not found then
    raise exception 'Lead nao encontrado.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
      from imobi_board.memberships m
     where m.user_id = v_uid
       and m.tenant_id = v_opp.tenant_id
       and m.status = 'ACTIVE'
       and m.role = 'ADMIN'
  ) then
    raise exception 'Apenas o administrador pode trocar o corretor do lead.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
      from imobi_board.memberships m
     where m.user_id = p_broker_id
       and m.tenant_id = v_opp.tenant_id
       and m.status = 'ACTIVE'
       and m.role = 'BROKER'
       and not m.is_internal
  ) then
    raise exception 'Corretor invalido ou inativo para esta imobiliaria.'
      using errcode = 'P0001';
  end if;

  if v_opp.assigned_user_id is not distinct from p_broker_id then
    return;
  end if;

  select p.full_name into v_old_name
    from imobi_board.profiles p
   where p.id = v_opp.assigned_user_id;

  select p.full_name into v_new_name
    from imobi_board.profiles p
   where p.id = p_broker_id;

  update imobi_board.lead_assignments
     set status = 'CANCELLED',
         resolved_at = now()
   where opportunity_id = p_opportunity_id
     and status = 'PENDING';

  update imobi_board.tasks
     set assigned_user_id = p_broker_id
   where opportunity_id = p_opportunity_id
     and status = 'OPEN'
     and (v_opp.assigned_user_id is null
          or assigned_user_id = v_opp.assigned_user_id);

  update imobi_board.opportunities
     set assigned_user_id = p_broker_id,
         first_assigned_at = coalesce(first_assigned_at, now()),
         accepted_at = now()
   where id = p_opportunity_id;

  insert into imobi_board.activities
    (tenant_id, opportunity_id, type, body, created_by)
  values (
    v_opp.tenant_id,
    p_opportunity_id,
    'SYSTEM',
    'Corretor alterado de ' || coalesce(v_old_name, 'fila') ||
      ' para ' || coalesce(v_new_name, 'novo corretor') || '.',
    v_uid
  );

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id,
    'opportunity.broker_reassigned',
    'opportunity',
    p_opportunity_id,
    jsonb_build_object(
      'from_user_id', v_opp.assigned_user_id,
      'to_user_id', p_broker_id,
      'changed_by', v_uid
    )
  );

  perform imobi_board_priv.notificar(
    v_opp.tenant_id,
    p_broker_id,
    'lead.reassigned',
    'Lead transferido para voce',
    'Um administrador alterou o responsavel deste lead.',
    'opportunity',
    p_opportunity_id
  );
end;
$fn$;

revoke execute on function imobi_board.reassign_opportunity_broker(uuid, uuid) from public;
grant execute on function imobi_board.reassign_opportunity_broker(uuid, uuid) to authenticated;
