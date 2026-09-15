-- Leva os alertas operacionais para o sino, com a mesma disciplina da notificacao de
-- silencio: o aviso diz de quem e ha quanto tempo, e some sozinho quando deixa de ser
-- verdade. O motor de alertas ja existia e ja se auto-resolvia - o que faltava era
-- alguem ver: 79 alertas abertos que nao chegavam a nenhuma tela.
--
-- Regra de curadoria: alerta nominal vira aviso individual; causa-raiz unica vira UM
-- aviso. Os 55 STALE_NOTION nao sao 55 problemas, sao um so (o quadro de saude no
-- Notion parou de ser preenchido), e 55 avisos identicos tornariam o sino inutil - o
-- oposto do que se quer. MEDIUM e LOW ficam fora do sino e seguem na tabela de alertas.
create or replace function agency_ops.notify_operational_alerts()
returns integer language plpgsql security definer set search_path = agency_ops, public as $fn$
declare v_novas integer := 0; v_n integer; v_stale integer; v_dias integer; v_unmatched integer;
begin
  -- A) Alertas nominais: um aviso por alerta aberto, sempre com nome e tempo decorrido.
  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, client_id, source, occurred_at, metadata)
  select 'alerta:' || a.alert_key, 'OPERATIONAL_ALERT',
         case when a.severity = 'CRITICAL' then 'CRITICAL' else 'ATTENTION' end,
         a.title,
         case a.type
           when 'CLIENT_WAITING_SLA' then
             'Sem resposta há ' || x.dur || coalesce(' (desde ' || to_char(x.desde,'DD/MM às HH24:MI') || ').', '.')
           when 'ONBOARDING_STALLED' then
             'Onboarding sem nenhum evento há ' || x.dur || coalesce(' (último em ' || to_char(x.desde,'DD/MM/YYYY') || ').', '.')
           else
             -- O conflito e calculado contra o Notion; dizer a data da avaliacao evita
             -- tratar dado de tres semanas atras como divergencia real.
             'Sinal interno e Notion discordam. ' || coalesce(a.description,'') ||
             coalesce(' · Avaliação do Notion de ' || to_char((a.metadata->>'external_source_updated_at')::timestamptz,'DD/MM') || '.', '')
         end || coalesce(' ' || a.next_action, ''),
         a.client_id, 'dashboard', now(),
         jsonb_build_object('alert_key', a.alert_key, 'alert_type', a.type, 'severity', a.severity)
  from agency_ops.operational_alerts a
  cross join lateral (
    select d.desde,
           case when d.desde is null then 'algum tempo'
                when now()-d.desde < interval '1 hour'   then greatest(1, floor(extract(epoch from now()-d.desde)/60))::int || ' min'
                when now()-d.desde < interval '48 hours' then floor(extract(epoch from now()-d.desde)/3600)::int || ' horas'
                else floor(extract(epoch from now()-d.desde)/86400)::int || ' dias' end as dur
    from (select coalesce(
                   substring(a.description from '\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.\d]*[-+]\d{2}')::timestamptz,
                   substring(a.description from '\d{4}-\d{2}-\d{2}')::date::timestamptz) as desde) d
  ) x
  where a.status = 'OPEN'
    and a.type in ('CLIENT_WAITING_SLA','ONBOARDING_STALLED','CRITICAL_CONFLICT','REVERSE_CONFLICT')
  on conflict (event_key) do nothing;
  get diagnostics v_novas = row_count;

  -- B) Causa-raiz unica: um aviso agregado, nao um por cliente afetado.
  select count(*) into v_stale from agency_ops.operational_alerts where status='OPEN' and type='STALE_NOTION';
  select (now()::date - max(source_updated_at)::date) into v_dias from agency_ops.client_health_external_signals;
  if v_stale > 0 then
    insert into agency_ops.platform_notifications
      (event_key, type, level, title, description, source, occurred_at, metadata)
    values ('alerta:notion_parado','OPERATIONAL_ALERT','ATTENTION',
            'Quadro de saúde no Notion parado há ' || v_dias || ' dias',
            v_stale || ' clientes estão com a avaliação de saúde vencida. A sincronização está funcionando — quem parou foi o preenchimento. '
            || 'Os alertas de divergência com o Notion são calculados em cima desses dados, então perdem confiabilidade enquanto o quadro não for atualizado.',
            'dashboard', now(), jsonb_build_object('clientes', v_stale, 'dias_parado', v_dias))
    on conflict (event_key) do nothing;
    get diagnostics v_n = row_count; v_novas := v_novas + v_n;
  end if;

  select count(*) into v_unmatched from agency_ops.operational_alerts where status='OPEN' and type='UNMATCHED_HIGH_RISK';
  if v_unmatched > 0 then
    insert into agency_ops.platform_notifications
      (event_key, type, level, title, description, source, occurred_at, metadata)
    select 'alerta:notion_sem_vinculo','OPERATIONAL_ALERT','ATTENTION',
           v_unmatched || ' avaliações de risco no Notion sem cliente correspondente na base',
           'São avaliações de risco alto/crítico para nomes que não existem no cadastro: '
           || string_agg(distinct s.client_name_raw, ', ') || '. '
           || 'Ou o nome está grafado diferente do cadastro, ou a avaliação é de alguém que não é cliente. '
           || 'Vale revisar antes de tratar como carteira em risco.',
           'dashboard', now(), jsonb_build_object('avaliacoes', v_unmatched)
    from agency_ops.operational_alerts a
    join agency_ops.client_health_external_signals s
      on s.source_record_id = a.source_id or s.source_page_id = a.source_id
    where a.status='OPEN' and a.type='UNMATCHED_HIGH_RISK'
    having count(*) > 0
    on conflict (event_key) do nothing;
    get diagnostics v_n = row_count; v_novas := v_novas + v_n;
  end if;

  -- C) Some sozinho: alerta que saiu de OPEN marca o aviso como lido.
  update agency_ops.platform_notifications n set read_at = now()
   where n.type = 'OPERATIONAL_ALERT' and n.read_at is null and n.metadata ? 'alert_key'
     and not exists (select 1 from agency_ops.operational_alerts a
                      where a.alert_key = n.metadata->>'alert_key' and a.status = 'OPEN');
  if v_stale = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key = 'alerta:notion_parado' and read_at is null;
  end if;
  if v_unmatched = 0 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key = 'alerta:notion_sem_vinculo' and read_at is null;
  end if;
  return v_novas;
end; $fn$;

-- Roda logo apos a deteccao, no job de alertas que ja existia (a cada 30 min).
select cron.schedule('agency_ops_alerts_refresh','*/30 * * * *',
  'select agency_ops.refresh_operational_alerts(); select agency_ops.reconcile_operational_alerts(); select agency_ops.refresh_automation_watchdog(); select agency_ops.reconcile_client_health_alerts(); select agency_ops.notify_operational_alerts();');
