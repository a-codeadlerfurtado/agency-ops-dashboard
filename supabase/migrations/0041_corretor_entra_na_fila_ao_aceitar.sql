-- Imobi-Board 0041 - corretor entra na fila ao aceitar o convite
--
-- Ate aqui, aceitar o convite criava perfil e membership e parava ali. O
-- corretor existia, aparecia na lista de Corretores, e nao recebia lead
-- nenhum: `distribuir` so enxerga quem esta em queue_members.
--
-- O buraco tem uma forma cruel. Nao da erro em lugar nenhum -- o admin
-- convida, a pessoa aceita, tudo parece certo, e os leads simplesmente nao
-- chegam. Quando alguem percebe, ja passou.
--
-- E nao dava para resolver por fora: queue_members exige user_id, e o user_id
-- so passa a existir quando a pessoa cria a conta. O unico momento em que isso
-- pode acontecer e este, dentro do aceite.
--
-- Entra so quem e BROKER. Admin nao vai para o rodizio: quem administra
-- distribui, e colocar o admin na fila faria a operacao competir com o dono
-- dela pelos proprios leads.
--
-- A fila escolhida e a primeira ACTIVE do tenant, por data de criacao. Com
-- mais de uma fila a escolha vira arbitraria, e a linha `limit 1` e onde isso
-- fica visivel quando chegar a hora de decidir melhor.

create or replace function imobi_board.aceitar_convite(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_c     imobi_board.invites%rowtype;
  v_fila  uuid;
  v_ordem smallint;
begin
  if v_uid is null then
    raise exception 'Entre na sua conta para aceitar o convite.' using errcode = '28000';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into v_c from imobi_board.invites where token = p_token for update;
  if not found then
    raise exception 'Convite nao encontrado.' using errcode = 'P0002';
  end if;
  if v_c.revoked_at is not null then
    raise exception 'Convite revogado.' using errcode = 'P0001';
  end if;
  if v_c.accepted_at is not null then
    raise exception 'Convite ja utilizado.' using errcode = 'P0001';
  end if;
  if v_c.expires_at < now() then
    raise exception 'Convite expirado. Peca outro ao administrador.' using errcode = 'P0001';
  end if;
  if v_email is distinct from v_c.email then
    raise exception 'Este convite foi enviado para outro e-mail.' using errcode = '42501';
  end if;

  insert into imobi_board.profiles (id, full_name)
  select v_uid, u.raw_user_meta_data ->> 'full_name'
  from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  insert into imobi_board.memberships (tenant_id, user_id, role)
  values (v_c.tenant_id, v_uid, v_c.role)
  on conflict (tenant_id, user_id) do update set status = 'ACTIVE';

  update imobi_board.invites
     set accepted_at = now(), accepted_by = v_uid
   where id = v_c.id;

  /* ------------------------------------------------- entrada na fila --- */
  if v_c.role = 'BROKER' then
    select q.id into v_fila
      from imobi_board.lead_queues q
     where q.tenant_id = v_c.tenant_id and q.status = 'ACTIVE'
     order by q.created_at
     limit 1;

    if v_fila is not null then
      -- entra no fim do rodizio, sem furar a vez de quem ja estava
      select coalesce(max(m.sort_order), -1) + 1 into v_ordem
        from imobi_board.queue_members m where m.queue_id = v_fila;

      insert into imobi_board.queue_members (tenant_id, queue_id, user_id, sort_order, active)
      values (v_c.tenant_id, v_fila, v_uid, v_ordem, true)
      on conflict (queue_id, user_id) do update set active = true;

      perform imobi_board_priv.emit_event(
        v_c.tenant_id, 'queue.member_added', 'queue', v_fila,
        jsonb_build_object('user_id', v_uid, 'origem', 'aceite_de_convite',
                           'sort_order', v_ordem));
    end if;
  end if;

  perform imobi_board_priv.emit_event(
    v_c.tenant_id, 'invite.accepted', 'membership', v_uid,
    jsonb_build_object('role', v_c.role, 'fila', v_fila));

  return jsonb_build_object(
    'tenant_id', v_c.tenant_id,
    'role', v_c.role,
    'tenant', (select name from imobi_board.tenants where id = v_c.tenant_id),
    'fila', v_fila);
end;
$fn$;
