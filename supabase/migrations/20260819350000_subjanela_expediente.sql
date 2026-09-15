-- Expediente 08:00-18:00, com subjanela de tolerancia ate 18:30.
--
-- Quem manda no contador de SLA e' o expediente: ate as 18h. A subjanela ate 18:30 e'
-- sobra - o time ainda esta por ali, entao mensagem que cai nela nao e' tratada como
-- "chegou fora do horario", mas tambem nao cobra resposta. O aviso rotula.
--
-- business_minutes ganha o parametro de fim de janela (default 18:00, o expediente
-- oficial). A versao de dois argumentos e' derrubada antes para nao criar chamada
-- ambigua com o novo default.
drop function if exists agency_ops.business_minutes(timestamptz, timestamptz);

create or replace function agency_ops.business_minutes(
  p_from timestamptz, p_to timestamptz, p_fim time default time '18:00')
returns integer language sql stable as $$
  select coalesce(sum(greatest(0, extract(epoch from
      least(p_to,   (d::date + p_fim)         at time zone 'America/Sao_Paulo')
    - greatest(p_from, (d::date + time '08:00') at time zone 'America/Sao_Paulo'))/60))::int, 0)
  from generate_series((p_from at time zone 'America/Sao_Paulo')::date,
                       (p_to   at time zone 'America/Sao_Paulo')::date, interval '1 day') d;
$$;

create or replace function agency_ops.notify_operational_alerts()
returns integer language plpgsql security definer set search_path = agency_ops, public as $fn$
declare v_novas integer := 0; v_n integer; v_stale integer; v_dias integer; v_unmatched integer;
begin
  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, client_id, source, occurred_at, metadata)
  select 'alerta:' || a.alert_key, 'OPERATIONAL_ALERT',
         case when a.severity = 'CRITICAL' then 'CRITICAL' else 'ATTENTION' end,
         a.title,
         case a.type
           when 'CLIENT_WAITING_SLA' then
             'Sem resposta há ' ||
             case when x.bmin < 60 then x.bmin || ' min' else round(x.bmin/60.0)::int || ' horas' end
             || ' de expediente (mensagem de ' || to_char(x.desde,'DD/MM às HH24:MI')
             || case when x.na_subjanela then ', já na subjanela' else '' end || ').'
           when 'ONBOARDING_STALLED' then
             'Onboarding sem nenhum evento há ' || x.dur || coalesce(' (último em ' || to_char(x.desde,'DD/MM/YYYY') || ').', '.')
           else
             'Sinal interno e Notion discordam. ' || coalesce(a.description,'') ||
             coalesce(' · Avaliação do Notion de ' || to_char((a.metadata->>'external_source_updated_at')::timestamptz,'DD/MM') || '.', '')
         end || coalesce(' ' || a.next_action, ''),
         a.client_id, 'dashboard', now(),
         jsonb_build_object('alert_key', a.alert_key, 'alert_type', a.type, 'severity', a.severity,
                            'minutos_expediente', x.bmin, 'minutos_com_subjanela', x.bsub,
                            'na_subjanela', x.na_subjanela)
  from agency_ops.operational_alerts a
  cross join lateral (
    select d.desde,
           agency_ops.business_minutes(d.desde, now())               as bmin,
           agency_ops.business_minutes(d.desde, now(), time '18:30') as bsub,
           (d.desde at time zone 'America/Sao_Paulo')::time >= time '18:00'
             and (d.desde at time zone 'America/Sao_Paulo')::time < time '18:30' as na_subjanela,
           case when d.desde is null then 'algum tempo'
                when now()-d.desde < interval '48 hours' then floor(extract(epoch from now()-d.desde)/3600)::int || ' horas'
                else floor(extract(epoch from now()-d.desde)/86400)::int || ' dias' end as dur
    from (select coalesce(
                   substring(a.description from '\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.\d]*[-+]\d{2}')::timestamptz,
                   substring(a.description from '\d{4}-\d{2}-\d{2}')::date::timestamptz) as desde) d
  ) x
  where a.status = 'OPEN'
    and a.type in ('CLIENT_WAITING_SLA','ONBOARDING_STALLED','CRITICAL_CONFLICT','REVERSE_CONFLICT')
    and (a.type <> 'CLIENT_WAITING_SLA' or (x.desde is not null and x.bmin >= 60))
  on conflict (event_key) do nothing;
  get diagnostics v_novas = row_count;

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
