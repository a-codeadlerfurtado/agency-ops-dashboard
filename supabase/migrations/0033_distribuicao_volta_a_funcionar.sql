-- Imobi-Board 0033 - a distribuicao nunca funcionou em producao
--
-- Sintoma: lead entrava, aparecia na lista, e ficava sem corretor e sem
-- prazo. So em producao -- chamando distribuir() direto pelo SQL como
-- postgres, funcionava. Foi o que fez isso passar despercebido.
--
-- Causa: `delete from _elegiveis;` sem WHERE, na tabela temporaria interna.
-- O Supabase mantem o safeupdate ligado no papel que o PostgREST usa, e ele
-- recusa DELETE sem WHERE com "DELETE requires a WHERE clause". Como
-- ingerir_lead engolia o erro da distribuicao, o motivo nunca aparecia --
-- corrigido na 0032, e foi assim que este apareceu.
--
-- Rodando como postgres o safeupdate nao se aplica, e ai a mesma funcao
-- passava. Toda vez que testei por SQL, testei o caminho errado.
--
-- A correcao e `where true`: satisfaz o safeupdate sem mudar o efeito.

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
  v_nome    text;
  v_inicio  timestamptz;
  v_expira  timestamptz;
begin
  select * into v_fila from imobi_board.lead_queues
  where id = p_queue_id and status = 'ACTIVE';
  if not found then
    raise exception 'Fila inexistente ou inativa.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_queue_id::text, 0));

  -- elegivel = ativo na fila E ativo no quadro de pessoal (spec 26)
  create temp table if not exists _elegiveis (
    user_id uuid, sort_order smallint) on commit drop;
  -- `where true` de proposito: o safeupdate do Supabase recusa DELETE sem
  -- WHERE, e era isso que derrubava toda a distribuicao em producao.
  delete from _elegiveis where true;
  insert into _elegiveis (user_id, sort_order)
  select m.user_id, m.sort_order
  from imobi_board.queue_members m
  join imobi_board.memberships mb
    on mb.user_id = m.user_id and mb.tenant_id = v_fila.tenant_id
  where m.queue_id = p_queue_id and m.active and mb.status = 'ACTIVE';

  select count(*) into v_ativos from _elegiveis;
  if v_ativos = 0 then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  v_excluir := case when v_ativos > 1 then p_excluir end;

  select e.user_id, e.sort_order into v_membro.user_id, v_membro.sort_order
  from _elegiveis e
  where e.sort_order > v_fila.cursor_sort_order
    and (v_excluir is null or e.user_id <> v_excluir)
  order by e.sort_order limit 1;

  if v_membro.user_id is null then
    select e.user_id, e.sort_order into v_membro.user_id, v_membro.sort_order
    from _elegiveis e
    where (v_excluir is null or e.user_id <> v_excluir)
    order by e.sort_order limit 1;
  end if;

  if v_membro.user_id is null then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  update imobi_board.lead_queues
     set cursor_sort_order = v_membro.sort_order
   where id = p_queue_id;

  -- o prazo so comeca quando o expediente abre
  v_inicio := imobi_board_priv.inicio_do_prazo(p_queue_id, now());
  v_expira := v_inicio + make_interval(secs => v_fila.acceptance_timeout_seconds);

  insert into imobi_board.lead_assignments
    (tenant_id, opportunity_id, queue_id, user_id, expires_at, attempt)
  values
    (v_fila.tenant_id, p_opportunity_id, p_queue_id, v_membro.user_id,
     v_expira, p_tentativa)
  returning id into v_assign;

  update imobi_board.opportunities
     set assigned_user_id  = v_membro.user_id,
         first_assigned_at = coalesce(first_assigned_at, now()),
         accepted_at       = null
   where id = p_opportunity_id;

  select c.full_name into v_nome
  from imobi_board.opportunities o
  join imobi_board.contacts c on c.id = o.contact_id
  where o.id = p_opportunity_id;

  perform imobi_board_priv.notificar(
    v_fila.tenant_id, v_membro.user_id, 'lead.atribuido',
    'Novo lead: ' || coalesce(v_nome, 'sem nome'),
    case when v_inicio > now() + interval '1 minute'
         then 'Prazo comeca quando o expediente abrir.'
         else 'Assuma em ate ' || (v_fila.acceptance_timeout_seconds / 60) || ' minutos.' end,
    'opportunity', p_opportunity_id);

  perform imobi_board_priv.emit_event(
    v_fila.tenant_id, 'opportunity.assigned', 'opportunity', p_opportunity_id,
    jsonb_build_object('assignment_id', v_assign, 'user_id', v_membro.user_id,
                       'queue_id', p_queue_id, 'attempt', p_tentativa,
                       'expires_at', v_expira, 'fora_do_expediente', v_inicio > now()));

  return v_assign;
end;
$fn$;

revoke execute on function imobi_board_priv.distribuir(uuid, uuid, smallint, uuid) from public;
