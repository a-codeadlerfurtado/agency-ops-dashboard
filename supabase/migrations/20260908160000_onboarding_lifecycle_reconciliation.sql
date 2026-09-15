-- Reconciliacao de onboarding: clientes que ja lancaram campanha continuavam
-- presos em lifecycle ONBOARDING com onboarding_cases OPEN.
--
-- POR QUE ACONTECEU
--
-- O fechamento automatico depende de agency_ops.apply_onboarding_campaign_clickup_task,
-- acionado por trigger em clickup_tasks. Ele so' reconhece a subida quando a task
-- casa TRES condicoes simultaneas (20260825171000):
--
--   name  like '% - campanha - %'
--   name  not like '%ajuste na campanha%'
--   list_name = 'trafego pago'
--
-- Qualquer campanha lancada sem uma task nesse formato exato -- nome fora do
-- padrao, lista diferente, task anterior ao trigger, ou lancamento registrado
-- so' no Meta -- nunca dispara o fechamento. O cliente fica ativo na pratica e
-- ONBOARDING no cadastro, e e' isso que faz o Jarvis e os paineis divergirem.
--
-- O QUE ESTA MIGRATION FAZ
--
-- 1. Reprocessa o historico de tasks pela funcao canonica, para pegar quem tem
--    evidencia valida e simplesmente nunca foi processado.
-- 2. Aplica a verdade operacional informada pela gestao para os clientes que ja
--    sairam do onboarding sem task no padrao.
--
-- NAO cria fluxo paralelo: o passo 2 tambem passa por recalculate_onboarding_case,
-- a mesma funcao que o caminho automatico usa.
--
-- Idempotente: rodar duas vezes nao muda nada na segunda.

-- ---------------------------------------------------------------- passo 1

do $$
declare
  r record;
  v_aplicados integer := 0;
begin
  for r in
    select t.task_id
    from agency_ops.clickup_tasks t
    join agency_ops.onboarding_cases oc
      on oc.client_id = t.client_id
     and oc.status = 'OPEN'
    where t.client_id is not null
      and (coalesce(t.is_closed,false) or lower(coalesce(t.status_type,'')) in ('closed','done'))
    order by t.date_closed nulls last
  loop
    begin
      if agency_ops.apply_onboarding_campaign_clickup_task(r.task_id) then
        v_aplicados := v_aplicados + 1;
      end if;
    exception when others then
      -- Uma task problematica nao pode abortar a reconciliacao inteira.
      null;
    end;
  end loop;
  raise notice 'reconciliacao: % casos fechados por evidencia de ClickUp', v_aplicados;
end $$;

-- ---------------------------------------------------------------- passo 2

/**
 * Verdade operacional informada pela gestao.
 *
 * Estes clientes ja' tiveram a primeira campanha publicada, confirmado pela
 * operacao, mas nao possuem task de ClickUp no formato que o automatico exige.
 * Sem esta etapa eles permaneceriam ONBOARDING para sempre.
 *
 * Casamento por display_name exato e SOMENTE quando o cliente ainda esta em
 * ONBOARDING -- assim rodar de novo nao mexe em quem ja foi corrigido, e um
 * homonimo em outro lifecycle nao e' afetado.
 */
do $$
declare
  v_nome text;
  v_client_id uuid;
  v_case_id bigint;
  v_nomes text[] := array[
    'Caio Rodrigues Vieira',
    'Pellegrini',
    'Irley Gurgel',
    'Living',
    'SILVIO BRASILEIRO'
  ];
begin
  foreach v_nome in array v_nomes loop
    select c.id into v_client_id
    from agency_ops.clients c
    where c.display_name = v_nome
      and c.lifecycle = 'ONBOARDING'
    limit 1;

    if v_client_id is null then
      raise notice 'reconciliacao: % nao esta em ONBOARDING (ja corrigido ou nome divergente)', v_nome;
      continue;
    end if;

    perform set_config('agency_ops.onboarding_internal_update','on',true);

    -- Fecha as etapas de lancamento do caso aberto.
    select oc.id into v_case_id
    from agency_ops.onboarding_cases oc
    where oc.client_id = v_client_id and oc.status = 'OPEN'
    order by oc.opened_at desc, oc.id desc
    limit 1;

    if v_case_id is not null then
      update agency_ops.onboarding_stages
      set status = 'DONE',
          completed_at = coalesce(completed_at, now()),
          blocked_type = null,
          notes = concat_ws(' | ', nullif(notes,''), 'Saida de onboarding confirmada pela gestao (reconciliacao 2026-09-08)')
      where case_id = v_case_id
        and stage_code in ('CAMPAIGN_LAUNCH','READY_TO_LAUNCH')
        and status <> 'DONE';

      insert into agency_ops.onboarding_evidence(
        case_id, kind, source, source_id, occurred_at, confidence, status, metadata, applied_at
      )
      select
        v_case_id, 'CAMPAIGN_PUBLISHED', 'manual', 'reconciliacao-2026-09-08', now(),
        'CONFIRMED', 'AUTO_APPLIED',
        jsonb_build_object(
          'stage_code','CAMPAIGN_LAUNCH',
          'meaning','CAMPAIGN_PUBLISHED_CONFIRMED_BY_OPS',
          'note','Cliente ja em operacao; sem task de ClickUp no formato exigido pelo automatico.'
        ),
        now()
      where not exists (
        select 1 from agency_ops.onboarding_evidence e
        where e.case_id = v_case_id
          and e.source = 'manual'
          and e.source_id = 'reconciliacao-2026-09-08'
      );

      -- Mesma funcao do caminho automatico: fecha o caso e propaga o lifecycle.
      perform agency_ops.recalculate_onboarding_case(v_case_id);
    end if;

    -- Rede de seguranca: se o recalculo nao tiver promovido o lifecycle, promove
    -- aqui. Um lado corrigido e o outro OPEN e' exatamente o estado inconsistente
    -- que originou este trabalho.
    update agency_ops.clients
    set lifecycle = 'ACTIVE', updated_at = now()
    where id = v_client_id and lifecycle = 'ONBOARDING';

    update agency_ops.onboarding_cases
    set status = 'CLOSED', closed_at = coalesce(closed_at, now())
    where client_id = v_client_id and status = 'OPEN';

    raise notice 'reconciliacao: % promovido para ACTIVE', v_nome;
  end loop;
end $$;

-- ---------------------------------------------------------------- verificacao

do $$
declare
  v_active integer;
  v_onb integer;
begin
  select count(*) filter (where lifecycle = 'ACTIVE'),
         count(*) filter (where lifecycle = 'ONBOARDING')
    into v_active, v_onb
  from agency_ops.clients;
  raise notice 'apos reconciliacao: ACTIVE=% ONBOARDING=% OPERACIONAL=%', v_active, v_onb, v_active + v_onb;

  -- Invariante: nenhum cliente ACTIVE pode ter caso de onboarding OPEN.
  if exists (
    select 1 from agency_ops.clients c
    join agency_ops.onboarding_cases oc on oc.client_id = c.id and oc.status = 'OPEN'
    where c.lifecycle = 'ACTIVE'
  ) then
    raise warning 'ainda existem clientes ACTIVE com onboarding_case OPEN';
  end if;
end $$;
