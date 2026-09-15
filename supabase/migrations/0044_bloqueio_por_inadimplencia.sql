-- Imobi-Board 0044 - bloqueio por inadimplencia
--
-- Regra: passou `dias_de_tolerancia` (5) do vencimento sem pagar, a imobiliaria
-- perde o acesso ate regularizar.
--
-- ONDE O BLOQUEIO MORA. Nos dois helpers de RLS -- current_tenant_ids() e
-- admin_tenant_ids() -- e nao na interface. Quarenta e quatro policies
-- dependem deles; mudar aqui bloqueia o CRM inteiro de uma vez, inclusive
-- tabelas que ainda nao existem. Bloqueio espalhado por tela e bloqueio que
-- alguem esquece numa tela nova.
--
-- A CONSEQUENCIA QUE PRECISA DE CUIDADO. Bloqueado, o admin passa a enxergar
-- vazio em tudo -- inclusive nas proprias faturas, se elas dependessem de
-- policy. Seria o absurdo de esconder a divida de quem precisa paga-la. Por
-- isso a leitura da cobranca e SECURITY DEFINER e nao passa pelos helpers.
--
-- QUEM NAO TEM ASSINATURA NAO E BLOQUEADO. `not exists` em vez de join: sem
-- linha em assinaturas, nada muda. E o que mantem as imobiliarias de
-- demonstracao e as anteriores a cobranca funcionando sem excecao no codigo.

/* --------------------------------------------- helpers com bloqueio --- */

create or replace function imobi_board_priv.current_tenant_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE'
    and not exists (
      select 1 from imobi_board.assinaturas a
      where a.tenant_id = m.tenant_id and a.status = 'BLOQUEADA'
    );
$fn$;

create or replace function imobi_board_priv.admin_tenant_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE'
    and m.role = 'ADMIN'
    and not exists (
      select 1 from imobi_board.assinaturas a
      where a.tenant_id = m.tenant_id and a.status = 'BLOQUEADA'
    );
$fn$;

/* ------------------------------------------ maquina de estado ------- */

/**
 * Deriva o estado da assinatura a partir das faturas em aberto.
 *
 * O estado nao e digitado por ninguem: e consequencia do que esta pago. Isso
 * elimina a classe de erro em que alguem marca "inadimplente" e esquece de
 * desmarcar -- que e exatamente o problema descrito no desenho de cobranca da
 * agencia, e nao vale repetir aqui.
 */
create or replace function imobi_board_priv.recalcular_assinatura(p_tenant uuid)
returns imobi_board.assinatura_status
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_a       imobi_board.assinaturas%rowtype;
  v_atraso  int;
  v_novo    imobi_board.assinatura_status;
begin
  select * into v_a from imobi_board.assinaturas where tenant_id = p_tenant;
  if not found then return null; end if;

  -- cancelada e teste nao viram bloqueio por atraso: sao decisoes, nao efeitos
  if v_a.status = 'CANCELADA' then return v_a.status; end if;
  if v_a.status = 'TESTE' and (v_a.teste_ate is null or v_a.teste_ate >= current_date) then
    return v_a.status;
  end if;

  -- maior atraso entre as faturas ainda em aberto
  select max(current_date - f.vence_em) into v_atraso
    from imobi_board.faturas f
   where f.tenant_id = p_tenant
     and f.status in ('PENDENTE', 'ATRASADA');

  v_novo := case
    when v_atraso is null or v_atraso <= 0 then 'ATIVA'
    when v_atraso >= v_a.dias_de_tolerancia then 'BLOQUEADA'
    else 'ATRASADA'
  end;

  -- fatura vencida deixa de ser PENDENTE: o nome tem que corresponder ao fato
  update imobi_board.faturas
     set status = 'ATRASADA'
   where tenant_id = p_tenant and status = 'PENDENTE' and vence_em < current_date;

  if v_novo is distinct from v_a.status then
    update imobi_board.assinaturas
       set status = v_novo,
           bloqueada_em = case
             when v_novo = 'BLOQUEADA' then coalesce(v_a.bloqueada_em, now())
             else null
           end
     where tenant_id = p_tenant;

    perform imobi_board_priv.emit_event(
      p_tenant, 'assinatura.' || lower(v_novo::text), 'assinatura', v_a.id,
      jsonb_build_object('de', v_a.status, 'para', v_novo, 'dias_de_atraso', v_atraso));
  end if;

  return v_novo;
end;
$fn$;

/** Passagem diaria. Sem isto, uma imobiliaria so seria bloqueada quando algum
    evento do provedor chegasse -- e o evento que nao chega e justamente o do
    pagamento que nao aconteceu. */
create or replace function imobi_board.varrer_cobranca()
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare r record; v_mudou int := 0; v_total int := 0; v_antes imobi_board.assinatura_status;
begin
  for r in select tenant_id, status from imobi_board.assinaturas
           where status <> 'CANCELADA'
  loop
    v_total := v_total + 1;
    v_antes := r.status;
    if imobi_board_priv.recalcular_assinatura(r.tenant_id) is distinct from v_antes then
      v_mudou := v_mudou + 1;
    end if;
  end loop;
  return jsonb_build_object('avaliadas', v_total, 'mudaram', v_mudou, 'em', now());
end;
$fn$;

/* ------------------------------------- leitura da propria cobranca --- */

/**
 * O que a imobiliaria ve sobre a propria cobranca.
 *
 * NAO usa current_tenant_ids(): quando bloqueada, aquele helper devolve vazio,
 * e esta e justamente a tela que precisa continuar de pe. Le memberships
 * direto, por isso e SECURITY DEFINER com filtro explicito por auth.uid().
 */
create or replace function imobi_board.minha_cobranca()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'tenant_id',   t.id,
      'imobiliaria', t.name,
      'meu_papel',   m.role,
      'assinatura', case when a.id is null then null else jsonb_build_object(
        'status',          a.status,
        'bloqueada',       a.status = 'BLOQUEADA',
        'bloqueada_em',    a.bloqueada_em,
        'plano',           p.nome,
        'plano_id',        p.id,
        'valor_centavos',  a.valor_centavos,
        'dia_vencimento',  a.dia_vencimento,
        'dias_de_tolerancia', a.dias_de_tolerancia,
        'teste_ate',       a.teste_ate
      ) end,
      'faturas_em_aberto', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', f.id, 'competencia', f.competencia, 'vence_em', f.vence_em,
          'valor_centavos', f.valor_centavos, 'status', f.status,
          'dias_de_atraso', greatest(current_date - f.vence_em, 0),
          'link', f.link_pagamento) order by f.vence_em), '[]'::jsonb)
        from imobi_board.faturas f
        where f.tenant_id = t.id and f.status in ('PENDENTE', 'ATRASADA')
      )
    ) as x
    from imobi_board.memberships m
    join imobi_board.tenants t on t.id = m.tenant_id
    left join imobi_board.assinaturas a on a.tenant_id = t.id
    left join imobi_board.planos p on p.id = a.plano_id
    where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
  ) s;
$fn$;

revoke execute on function imobi_board.minha_cobranca() from public;
grant  execute on function imobi_board.minha_cobranca() to authenticated;

revoke execute on function imobi_board.varrer_cobranca() from public, authenticated;
grant  execute on function imobi_board.varrer_cobranca() to service_role;

/* ----------------------------------------------- varredura diaria --- */
--
-- 09:00 UTC = 06:00 em Sao Paulo. Cedo de proposito: quando o bloqueio tiver
-- de acontecer, que aconteca antes do expediente e nao no meio de um
-- atendimento.
--
-- pg_cron ja esta instalado neste projeto. Registrado aqui para que o
-- agendamento faca parte da migracao e nao seja um comando solto que alguem
-- rodou uma vez e ninguem mais sabe que existe.

select cron.schedule(
  'imobi-board-varrer-cobranca',
  '0 9 * * *',
  $cron$select imobi_board.varrer_cobranca()$cron$
)
where not exists (
  select 1 from cron.job where jobname = 'imobi-board-varrer-cobranca'
);
