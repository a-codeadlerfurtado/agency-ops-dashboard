-- Varredura de tasks orfas no ClickUp: 316 de 3948 (8%) sem cliente vinculado.
--
-- O caso da Pla nao era isolado, mas o padrao e' outro do que eu supunha. Quase
-- nenhum prefixo [NOME] das tasks orfas casa com a carteira - nao e' erro de
-- matching, e' trabalho sendo executado para nomes que nao existem em clients.
-- Hall (23 tasks, ate 11/08), Lopes Chaves (14, ate 10/08) e Bello (6, ate 11/08)
-- tem task recente e nao existem nem como cliente nem como grupo de WhatsApp.
--
-- Isso importa porque esse esforco nao entra em nenhuma metrica: nem carteira, nem
-- churn, nem produtividade por gestor. E' trabalho invisivel.
--
-- O que da' para resolver sozinho e' so o caso certo; o resto vai para conferencia
-- humana, porque criar cliente e' decisao de negocio e nao de sincronizacao.

-- 1) [PLA] sem acento e' a mesma Pla Imobiliaria. O alias ja existia; o filtro da
--    migration anterior so pegou a versao acentuada e deixou 18 tasks para tras.
update agency_ops.clickup_tasks
   set client_id = '1e2216f9-4147-4209-be7c-8efe62951fe4'
 where client_id is null
   and lower(extensions.unaccent(trim(substring(name from '^\[([^\]]+)\]'))))
       in ('pla','pla imobiliaria');

-- 2) Os demais nomes vao para a fila de conferencia que ja existe. Prefixos que sao
--    claramente trabalho interno ficam de fora, e o corte de 3 tasks evita encher a
--    fila com digitacao avulsa.
with orfas as (
  select lower(extensions.unaccent(trim(substring(name from '^\[([^\]]+)\]')))) prefixo,
         trim(substring(name from '^\[([^\]]+)\]')) prefixo_cru, date_created
  from agency_ops.clickup_tasks where client_id is null and name ~ '^\['
), agg as (
  select prefixo, min(prefixo_cru) nome, count(*) tasks,
         min(date_created)::date primeira, max(date_created)::date ultima
  from orfas
  where prefixo not in ('sem cliente especifico','urgente','pendencias','gerenciador',
                        'adler gerente operacional','joel','we','teste')
  group by 1 having count(*) >= 3
)
insert into agency_ops.integration_match_review (system, external_id, external_name, candidates, reason)
select 'CLICKUP_TASK_PREFIX', a.prefixo, a.nome, '[]'::jsonb,
       a.tasks || ' tasks no ClickUp sem cliente correspondente na carteira ('
       || to_char(a.primeira,'DD/MM/YYYY') || ' a ' || to_char(a.ultima,'DD/MM/YYYY') || '). '
       || 'Confirmar: cliente existente com nome diferente (vincular), cliente que nunca foi cadastrado (criar), ou trabalho interno (ignorar).'
from agg a
on conflict (system, external_id) do nothing;

-- 3) Um aviso agregado, com a mesma regra dos outros: some sozinho quando a fila
--    de conferencia esvaziar. Critico so quando ha task nos ultimos 30 dias, porque
--    ai e' trabalho acontecendo agora e nao residuo historico.
create or replace function agency_ops.notify_unlinked_clickup()
returns integer language plpgsql security definer
set search_path = agency_ops, public, extensions as $fn$
declare v_n integer; v_pend integer; v_recentes integer;
begin
  select count(*) into v_pend from agency_ops.integration_match_review
   where system='CLICKUP_TASK_PREFIX' and coalesce(status,'OPEN') in ('OPEN','PENDING');

  select count(*) into v_recentes from agency_ops.integration_match_review r
   where r.system='CLICKUP_TASK_PREFIX' and coalesce(r.status,'OPEN') in ('OPEN','PENDING')
     and exists (select 1 from agency_ops.clickup_tasks t
                  where t.client_id is null
                    and lower(extensions.unaccent(trim(substring(t.name from '^\[([^\]]+)\]')))) = r.external_id
                    and t.date_created > now() - interval '30 days');

  if v_pend = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key='alerta:clickup_sem_cliente' and read_at is null;
    return 0;
  end if;

  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, source, occurred_at, metadata)
  values ('alerta:clickup_sem_cliente','OPERATIONAL_ALERT',
          case when v_recentes > 0 then 'CRITICAL' else 'ATTENTION' end,
          v_pend || ' nomes com task no ClickUp e sem cliente na carteira',
          'A equipe está executando trabalho para nomes que o dashboard não conhece, então esse esforço não entra em nenhuma métrica de carteira, churn ou produtividade. '
          || case when v_recentes > 0
                  then v_recentes || ' deles têm task nos últimos 30 dias — é trabalho acontecendo agora. '
                  else 'Nenhum tem task recente; provavelmente são clientes antigos nunca cadastrados. ' end
          || 'A fila de conferência está em integration_match_review: para cada nome, vincular a um cliente existente, cadastrar, ou marcar como interno.',
          'dashboard', now(),
          jsonb_build_object('pendentes', v_pend, 'com_task_recente', v_recentes))
  on conflict (event_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end; $fn$;

select cron.schedule('agency_ops_alerts_refresh','*/30 * * * *',
  'select agency_ops.refresh_operational_alerts(); select agency_ops.reconcile_operational_alerts(); select agency_ops.refresh_automation_watchdog(); select agency_ops.reconcile_client_health_alerts(); select agency_ops.notify_operational_alerts(); select agency_ops.notify_unlinked_clickup();');
