-- Fila que ninguem ve' e' o mesmo que decisao tomada sozinha.
--
-- Passei a sessao inteira consertando um defeito: o sistema decidia onde deveria
-- perguntar. TALVEZ virava MATCHED, "imperial" casava com "imperial cred", conta de
-- anuncio sem cliente simplesmente nao existia. A correcao foi sempre a mesma - em vez
-- de escolher, mandar para integration_match_review.
--
-- So' que a fila cresceu para 174 itens e nada no dashboard aponta para ela. Destes,
-- so' os 20 do ClickUp tem alerta proprio (notify_unlinked_clickup). Os outros 154
-- estao invisiveis:
--
--   86  META_AD_ACCOUNT       contas de anuncio ao alcance do token, sem cliente
--   27  CRM_LEAD              ha' 5 dias
--   21  NOTION_CLIENT_HEALTH
--   19  META_BM               ha' 5 dias
--    1  WHATSAPP_GROUP
--
-- Uma pergunta que ninguem le' nao e' melhor que um palpite errado - e' pior, porque
-- parece resolvida. Este alerta fecha o circuito e some sozinho quando a fila zera.

create or replace function agency_ops.notify_review_queue()
returns integer language plpgsql security definer
set search_path to 'agency_ops', 'pg_catalog'
as $fn$
declare v_n int; v_dias int; v_detalhe text; v_antigos int;
begin
  -- CLICKUP_TASK_PREFIX fica de fora: ja' tem alerta proprio, com contexto melhor.
  -- Notificar duas vezes a mesma coisa treina o time a ignorar o sino.
  select count(*), coalesce(max(extract(epoch from (now()-created_at))/86400.0), 0)::int,
         count(*) filter (where created_at < now() - interval '7 days')
    into v_n, v_dias, v_antigos
  from agency_ops.integration_match_review
  where coalesce(status,'OPEN') in ('OPEN','PENDING')
    and system <> 'CLICKUP_TASK_PREFIX';

  if v_n = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key = 'alerta:fila_revisao' and read_at is null;
    return 0;
  end if;

  select string_agg(linha, '; ' order by n desc) into v_detalhe from (
    select system || ': ' || count(*) as linha, count(*) n
    from agency_ops.integration_match_review
    where coalesce(status,'OPEN') in ('OPEN','PENDING') and system <> 'CLICKUP_TASK_PREFIX'
    group by system) s;

  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, source, occurred_at, metadata)
  values ('alerta:fila_revisao', 'OPERATIONAL_ALERT',
          case when v_antigos > 0 then 'CRITICAL' else 'ATTENTION' end,
          v_n || ' itens esperando alguém decidir de quem são',
          'São casos em que o sistema não teve certeza e preferiu perguntar em vez de chutar — '
          || 'conta de anúncio sem cliente, lead sem dono, nome que casou com mais de um. '
          || 'Enquanto ninguém decide, esses dados ficam fora de toda métrica: '
          || 'conta sem cliente não entra no alerta de saldo, lead sem dono não conta para ninguém. '
          || case when v_antigos > 0
                  then v_antigos || ' estão parados há mais de 7 dias (o mais antigo, ' || v_dias || ' dias). '
                  else 'Nenhum passou de 7 dias ainda. ' end
          || 'Por origem — ' || coalesce(v_detalhe, '—') || '.',
          'agency_ops.integration_match_review', now(),
          jsonb_build_object('total', v_n, 'antigos_7d', v_antigos, 'dias_mais_antigo', v_dias))
  on conflict (event_key) do update
    set level = excluded.level, title = excluded.title,
        description = excluded.description, metadata = excluded.metadata,
        occurred_at = now(),
        -- Alerta ja' lido so' reabre se a fila cresceu. Reabrir a cada rodada com o
        -- mesmo numero treina o time a dispensar sem ler; ficar calado quando piora
        -- esconde justamente o que importa.
        read_at = case
          when (excluded.metadata->>'total')::int
             > coalesce((agency_ops.platform_notifications.metadata->>'total')::int, 0)
          then null else agency_ops.platform_notifications.read_at end;
  return v_n;
end $fn$;

-- ---------------------------------------------------------------------------
-- OpsQuestion respondendo pelo plano B
-- ---------------------------------------------------------------------------
-- Este e' o caso em que tudo parece bem: as respostas continuam saindo, ninguem
-- reclama, e a VPS esta' quebrada. So' o campo source denuncia. Sem alerta, a
-- descoberta acontece quando alguem for olhar o log por outro motivo.
create or replace function agency_ops.notify_opsquestion_fallback()
returns integer language plpgsql security definer
set search_path to 'agency_ops', 'pg_catalog'
as $fn$
declare v_n int; v_ultimo timestamptz;
begin
  select count(*), max(created_at) into v_n, v_ultimo
  from agency_ops.opsquestion_interactions
  where source = 'DIRECT_AI_FALLBACK' and created_at > now() - interval '24 hours';

  if v_n = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key = 'alerta:opsquestion_fallback' and read_at is null;
    return 0;
  end if;

  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, source, occurred_at, metadata)
  values ('alerta:opsquestion_fallback', 'OPERATIONAL_ALERT', 'CRITICAL',
          'OpsQuestion está respondendo pelo caminho antigo',
          v_n || ' pergunta(s) nas últimas 24h falharam na VPS e foram respondidas pelo Make. '
          || 'As respostas saíram normalmente, então ninguém vai reclamar — mas a VPS está fora do ar, '
          || 'e cada pergunta nessa condição gasta operações do Make. '
          || 'A causa está em: journalctl -u opsquestion (ou docker logs opsquestion). '
          || 'Última ocorrência: ' || to_char(v_ultimo at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.',
          'agency_ops.opsquestion_interactions', now(),
          jsonb_build_object('perguntas_24h', v_n))
  on conflict (event_key) do update
    set level = excluded.level, title = excluded.title,
        description = excluded.description, metadata = excluded.metadata,
        occurred_at = now(),
        -- Infraestrutura quebrada reabre sempre: aqui o silencio custa caro.
        read_at = null;
  return v_n;
end $fn$;

-- Fila: uma vez por dia de manha, antes do expediente comecar a empurrar coisa nova.
select cron.schedule('notify_review_queue_daily', '0 11 * * 1-5',
                     $c$select agency_ops.notify_review_queue();$c$);
-- Fallback: de duas em duas horas. E' um alarme de infraestrutura, nao de rotina.
select cron.schedule('notify_opsquestion_fallback', '20 */2 * * *',
                     $c$select agency_ops.notify_opsquestion_fallback();$c$);
