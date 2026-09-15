-- O alerta que eu criei hoje de manha nao podia mais tocar.
--
-- Ele vigiava source='DIRECT_AI_FALLBACK' - OpsQuestion respondendo pelo Make porque a
-- VPS falhou. Fazia sentido enquanto o cenario do Make estava ativo. A' tarde o Adler
-- pediu para desativa-lo, e com isso o fallback deixou de existir: a VPS falhando nao
-- gera mais DIRECT_AI_FALLBACK, gera status='ERROR' e erro na tela de quem perguntou.
--
-- Ou seja, eu construi um alarme e depois desliguei a unica condicao que o faria tocar.
-- Ficou um alerta que existe, roda de duas em duas horas, e nunca dispara - que e' pior
-- que nao ter alerta, porque parece cobertura.
--
-- Descoberto na pratica: as 19:57 de 20/08 uma pergunta real deu vps_ai_timeout em
-- 50,6s. Ninguem foi avisado.
--
-- Agora olha os dois: ERROR e FALLBACK. E diz o que fazer conforme o motivo - timeout
-- nao e' VPS caida, e' pergunta ampla demais ou modelo lento, e o conserto fica no
-- /etc/opsquestion.env, nao em reiniciar container.
--
-- Junto vai o p95 das que deram certo contra o teto, que e' o numero que antecipa o
-- proximo estouro em vez de so' contar os que ja' aconteceram.

create or replace function agency_ops.notify_opsquestion_fallback()
returns integer language plpgsql security definer
set search_path to 'agency_ops', 'pg_catalog'
as $fn$
declare v_erros int; v_fallback int; v_total int; v_ultimo timestamptz;
        v_detalhe text; v_p95 numeric;
begin
  select count(*) filter (where status = 'ERROR'),
         count(*) filter (where source = 'DIRECT_AI_FALLBACK'),
         count(*),
         max(created_at) filter (where status = 'ERROR'),
         percentile_cont(0.95) within group (order by latency_ms) filter (where status='SUCCESS')
    into v_erros, v_fallback, v_total, v_ultimo, v_p95
  from agency_ops.opsquestion_interactions
  where created_at > now() - interval '24 hours' and source like 'DIRECT_AI%';

  if v_erros = 0 and v_fallback = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key = 'alerta:opsquestion_fallback' and read_at is null;
    return 0;
  end if;

  select string_agg(distinct error, ', ') into v_detalhe
  from agency_ops.opsquestion_interactions
  where created_at > now() - interval '24 hours' and status = 'ERROR' and error is not null;

  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, source, occurred_at, metadata)
  values ('alerta:opsquestion_fallback', 'OPERATIONAL_ALERT',
          case when v_erros > 0 then 'CRITICAL' else 'ATTENTION' end,
          case when v_erros > 0
               then v_erros || ' de ' || v_total || ' perguntas ao OpsQuestion falharam nas últimas 24h'
               else 'OpsQuestion respondeu ' || v_fallback || 'x pelo caminho antigo' end,
          case when v_erros > 0
               then 'Quem perguntou recebeu erro na tela. Motivo: ' || coalesce(v_detalhe,'—') || '. '
                 || case when v_detalhe like '%timeout%'
                         then 'Timeout quer dizer que o modelo investigou além da janela — não é a VPS caída, '
                           || 'é pergunta ampla demais ou modelo lento. Baixar MAX_STEPS ou DEADLINE_MS em '
                           || '/etc/opsquestion.env resolve. '
                         else 'Ver: docker logs opsquestion na VPS srv1837879. ' end
               else 'A VPS falhou e o Make cobriu. As respostas saíram, então ninguém vai reclamar. ' end
          || 'p95 das que deram certo: ' || coalesce(round(v_p95/1000.0,1)::text,'—') || 's (teto 55s). '
          || case when v_ultimo is not null
                  then 'Última falha: ' || to_char(v_ultimo at time zone 'America/Sao_Paulo','DD/MM HH24:MI') || '.'
                  else '' end,
          'agency_ops.opsquestion_interactions', now(),
          jsonb_build_object('erros_24h', v_erros, 'fallback_24h', v_fallback,
                             'total_24h', v_total, 'p95_ms', v_p95))
  on conflict (event_key) do update
    set level = excluded.level, title = excluded.title,
        description = excluded.description, metadata = excluded.metadata,
        occurred_at = now(), read_at = null;
  return v_erros + v_fallback;
end $fn$;
