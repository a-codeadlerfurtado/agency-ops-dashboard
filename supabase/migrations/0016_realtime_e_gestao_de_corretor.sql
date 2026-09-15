-- Imobi-Board 0016 - Realtime seletivo (spec 56) e ativar/desativar corretor (26)

-- Realtime SO em notifications. A spec pede "somente onde melhora o produto" e
-- "nao criar subscription global": o corretor precisa saber na hora que um lead
-- caiu para ele, porque o SLA ja esta correndo. O resto da tela nao precisa - e
-- cada tabela publicada custa WAL replicado para todo o projeto.
-- A RLS continua valendo no canal: cada um so recebe as proprias linhas.
alter publication supabase_realtime add table imobi_board.notifications;

-- Ativar/desativar corretor (spec 26). Nao e um UPDATE solto na tabela porque
-- desativar tem consequencia: quem sai do ar precisa sair das filas tambem,
-- senao o rodizio continua contando com ele.
create or replace function imobi_board.definir_status_corretor(
  p_membership_id uuid,
  p_ativo         boolean
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_m   imobi_board.memberships%rowtype;
begin
  select * into v_m from imobi_board.memberships where id = p_membership_id for update;
  if not found then
    raise exception 'Membro nao encontrado.' using errcode = 'P0002';
  end if;

  if not exists (select 1 from imobi_board.memberships a
                 where a.user_id = v_uid and a.tenant_id = v_m.tenant_id
                   and a.status = 'ACTIVE' and a.role = 'ADMIN') then
    raise exception 'Apenas o administrador gerencia a equipe.' using errcode = '42501';
  end if;

  if v_m.user_id = v_uid and not p_ativo then
    raise exception 'Voce nao pode desativar a si mesmo.' using errcode = 'P0001';
  end if;

  -- ultimo ADMIN ativo nao sai: o tenant ficaria sem quem administra
  if v_m.role = 'ADMIN' and not p_ativo and (
      select count(*) from imobi_board.memberships a
      where a.tenant_id = v_m.tenant_id and a.role = 'ADMIN' and a.status = 'ACTIVE') <= 1 then
    raise exception 'Esta imobiliaria ficaria sem administrador.' using errcode = 'P0001';
  end if;

  update imobi_board.memberships
     set status = case when p_ativo then 'ACTIVE' else 'INACTIVE' end::imobi_board.member_status
   where id = p_membership_id;

  -- tira das filas ao desativar; religar e decisao do ADMIN, fila por fila
  if not p_ativo then
    update imobi_board.queue_members set active = false where user_id = v_m.user_id;
  end if;

  perform imobi_board_priv.emit_event(
    v_m.tenant_id,
    case when p_ativo then 'broker.activated' else 'broker.deactivated' end,
    'membership', p_membership_id,
    jsonb_build_object('user_id', v_m.user_id));
end;
$fn$;

-- notificacao quando a proposta muda de estado (spec 57)
create or replace function imobi_board_priv.notificar_proposta()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
declare v_nome text;
begin
  if tg_op = 'UPDATE' and old.status = new.status then
    return null;
  end if;

  select c.full_name into v_nome from imobi_board.contacts c where c.id = new.contact_id;

  perform imobi_board_priv.notificar(
    new.tenant_id, new.broker_id, 'proposta.atualizada',
    'Proposta ' || case new.status
       when 'ACCEPTED' then 'ACEITA' when 'REJECTED' then 'recusada'
       when 'SENT' then 'enviada' when 'NEGOTIATING' then 'em negociacao'
       else lower(new.status::text) end || ': ' || coalesce(v_nome, 'sem nome'),
    null, 'opportunity', new.opportunity_id);
  return null;
end;
$fn$;

create trigger proposals_notifica
  after insert or update of status on imobi_board.proposals
  for each row execute function imobi_board_priv.notificar_proposta();

revoke execute on function imobi_board.definir_status_corretor(uuid, boolean) from public;
revoke execute on function imobi_board_priv.notificar_proposta() from public;
grant execute on function imobi_board.definir_status_corretor(uuid, boolean) to authenticated;
