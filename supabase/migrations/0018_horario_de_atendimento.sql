-- Imobi-Board 0018 - horario de atendimento da fila (spec 27)
--
-- A coluna working_hours existia desde a 0005 e o motor a ignorava: um lead que
-- chegava as 3h da manha era distribuido e o relogio de SLA corria a noite
-- inteira. As 9h o corretor ja tinha "perdido" o prazo sem ter tido chance.
--
-- A correcao NAO pode segurar o lead ate abrir o expediente, porque isso
-- exigiria varredura periodica - e a spec 32 proibe cron. A solucao usa o que
-- ja existe: o lead e atribuido na hora (o corretor ve assim que abrir o app),
-- mas o PRAZO comeca a contar quando o expediente abre. O Workflow ja sabe
-- dormir ate uma data; so passamos a data certa.
--
-- Formato de working_hours:
--   {"dias": [1,2,3,4,5], "inicio": "09:00", "fim": "19:00"}
--   dias em isodow: 1=segunda ... 7=domingo. {} = 24x7, como era antes.

create or replace function imobi_board_priv.inicio_do_prazo(
  p_queue_id uuid,
  p_quando   timestamptz default now()
) returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_h      jsonb;
  v_tz     text;
  v_dias   int[];
  v_ini    time;
  v_fim    time;
  v_local  timestamptz;
  v_dia    date;
  v_i      int := 0;
begin
  select working_hours, timezone into v_h, v_tz
  from imobi_board.lead_queues where id = p_queue_id;

  -- sem configuracao a fila atende 24x7: comportamento anterior preservado
  if v_h is null or v_h = '{}'::jsonb or not (v_h ? 'inicio') then
    return p_quando;
  end if;

  v_tz  := coalesce(v_tz, 'America/Sao_Paulo');
  v_ini := (v_h ->> 'inicio')::time;
  v_fim := (v_h ->> 'fim')::time;

  select coalesce(array_agg(x::int), array[1,2,3,4,5])
    into v_dias
  from jsonb_array_elements_text(coalesce(v_h -> 'dias', '[1,2,3,4,5]'::jsonb)) x;

  -- janela invertida (ex.: plantao 18h->02h) nao e suportada: trata como 24x7
  -- em vez de calcular errado silenciosamente
  if v_fim <= v_ini then
    return p_quando;
  end if;

  v_local := p_quando at time zone v_tz;      -- timestamp "de parede" na tz
  v_dia   := (v_local)::date;

  -- ja esta dentro da janela hoje?
  if extract(isodow from v_dia)::int = any (v_dias)
     and (v_local)::time >= v_ini
     and (v_local)::time <  v_fim then
    return p_quando;
  end if;

  -- ainda vai abrir hoje?
  if extract(isodow from v_dia)::int = any (v_dias)
     and (v_local)::time < v_ini then
    return (v_dia + v_ini) at time zone v_tz;
  end if;

  -- procura o proximo dia util (no maximo 8 voltas: cobre semana + folga)
  loop
    v_i := v_i + 1;
    v_dia := v_dia + 1;
    exit when v_i > 8;
    if extract(isodow from v_dia)::int = any (v_dias) then
      return (v_dia + v_ini) at time zone v_tz;
    end if;
  end loop;

  -- nenhum dia marcado como util: nao segura o lead eternamente
  return p_quando;
end;
$fn$;

-- distribuir() passa a ancorar o prazo no expediente
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
  delete from _elegiveis;
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

revoke execute on function imobi_board_priv.inicio_do_prazo(uuid, timestamptz) from public;
revoke execute on function imobi_board_priv.distribuir(uuid, uuid, smallint, uuid) from public;
