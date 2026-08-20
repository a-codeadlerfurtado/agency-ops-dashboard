-- Tres correcoes vindas da revisao do gestor.
--
-- 1) SLA so corre em horario comercial. Mensagem que chega depois das 18h so e'
--    devida no dia seguinte - avisar "sem resposta ha 5 horas" as 23h da noite
--    cobra uma resposta que ninguem deveria estar dando. O contador passa a somar
--    apenas minutos dentro de 08:00-18:00, e sem 1h util acumulada nao ha aviso.
--    Efeito imediato: os 4 alertas de SLA abertos as 23h sairam do sino.
--
-- 2) Pla Imobiliaria aparecia como "nunca atendida" em 148 dias de casa. Errado: as
--    tasks existiam, o vinculo com o cliente e' que nunca foi feito. Alias manual
--    resolve, e ela passa a ler como silencio de 23 dias (ultima task 27/07).
--
-- 3) Silencio de cliente no juridico ou inadimplente le-se de outro jeito, entao o
--    aviso passa a dizer. Pla e Beto estao no juridico; Jair e Airton inadimplentes.

create or replace function agency_ops.business_minutes(p_from timestamptz, p_to timestamptz)
returns integer language sql stable as $$
  select coalesce(sum(greatest(0, extract(epoch from
      least(p_to, (d::date + time '18:00') at time zone 'America/Sao_Paulo')
    - greatest(p_from, (d::date + time '08:00') at time zone 'America/Sao_Paulo'))/60))::int, 0)
  from generate_series((p_from at time zone 'America/Sao_Paulo')::date,
                       (p_to   at time zone 'America/Sao_Paulo')::date, interval '1 day') d;
$$;

insert into agency_ops.clickup_client_aliases
  (alias, normalized_alias, client_id, match_method, confidence, is_manual, active)
values ('PLÁ','pla','1e2216f9-4147-4209-be7c-8efe62951fe4','manual',1,true,true),
       ('PLÁ IMOBILIÁRIA','pla imobiliaria','1e2216f9-4147-4209-be7c-8efe62951fe4','manual',1,true,true)
on conflict do nothing;

update agency_ops.clickup_tasks
   set client_id = '1e2216f9-4147-4209-be7c-8efe62951fe4'
 where client_id is null and (name ilike '[PLÁ]%' or name ilike '[PLÁ IMOBILIÁRIA]%');

-- Redefinicao das duas funcoes de notificacao com as regras acima. Substituem as
-- versoes de 20260819300000 e 20260819310000.
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
             || ' de expediente (mensagem de ' || to_char(x.desde,'DD/MM às HH24:MI') || ').'
           when 'ONBOARDING_STALLED' then
             'Onboarding sem nenhum evento há ' || x.dur || coalesce(' (último em ' || to_char(x.desde,'DD/MM/YYYY') || ').', '.')
           else
             'Sinal interno e Notion discordam. ' || coalesce(a.description,'') ||
             coalesce(' · Avaliação do Notion de ' || to_char((a.metadata->>'external_source_updated_at')::timestamptz,'DD/MM') || '.', '')
         end || coalesce(' ' || a.next_action, ''),
         a.client_id, 'dashboard', now(),
         jsonb_build_object('alert_key', a.alert_key, 'alert_type', a.type, 'severity', a.severity,
                            'minutos_uteis', x.bmin)
  from agency_ops.operational_alerts a
  cross join lateral (
    select d.desde, agency_ops.business_minutes(d.desde, now()) as bmin,
           case when d.desde is null then 'algum tempo'
                when now()-d.desde < interval '48 hours' then floor(extract(epoch from now()-d.desde)/3600)::int || ' horas'
                else floor(extract(epoch from now()-d.desde)/86400)::int || ' dias' end as dur
    from (select coalesce(
                   substring(a.description from '\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.\d]*[-+]\d{2}')::timestamptz,
                   substring(a.description from '\d{4}-\d{2}-\d{2}')::date::timestamptz) as desde) d
  ) x
  where a.status = 'OPEN'
    and a.type in ('CLIENT_WAITING_SLA','ONBOARDING_STALLED','CRITICAL_CONFLICT','REVERSE_CONFLICT')
    -- Mensagem que chegou depois das 18h so e' devida no dia seguinte.
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

create or replace function agency_ops.notify_silent_clients()
returns integer language plpgsql security definer set search_path = agency_ops, public as $fn$
declare v_novas integer := 0;
begin
  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, client_id, source, occurred_at, metadata)
  select 'silencio:' || s.client_id || ':' || s.sinal, 'CLIENT_SILENCE',
         case when s.sinal in ('nunca_atendido','silencio_critico') then 'CRITICAL' else 'ATTENTION' end,
         case s.sinal
           when 'nunca_atendido'   then 'Nunca atendido: ' || s.display_name
           when 'silencio_critico' then 'Silêncio crítico: ' || s.display_name
           else 'Cliente em silêncio: ' || s.display_name end,
         case s.sinal
           when 'nunca_atendido' then
             s.display_name || ' está há ' || s.dias_casa || ' dias na carteira e nunca teve uma task criada no ClickUp.'
             || coalesce(' Gestor: ' || s.gt_owner || '.', ' Sem gestor de tráfego atribuído.')
           else
             s.display_name || ' está há ' || s.dias_sem_pedido || ' dias sem nenhum pedido novo no ClickUp'
             || ' (última task em ' || to_char(s.ultima_task_criada,'DD/MM/YYYY') || ').'
             || ' ' || s.dias_casa || ' dias de casa, ' || s.tasks || ' tasks no total.'
             || coalesce(' Gestor: ' || s.gt_owner || '.', ' Sem gestor de tráfego atribuído.')
         end
         || case when st.juridico and st.inadimplente then ' Atenção: está no jurídico e inadimplente.'
                 when st.juridico then ' Atenção: cliente no jurídico.'
                 when st.inadimplente then ' Atenção: cliente inadimplente.'
                 else '' end,
         s.client_id, 'dashboard', now(),
         jsonb_build_object('client_id', s.client_id, 'sinal', s.sinal,
                            'dias_sem_pedido', s.dias_sem_pedido, 'dias_casa', s.dias_casa,
                            'gt_owner', s.gt_owner, 'tasks', s.tasks,
                            'juridico', st.juridico, 'inadimplente', st.inadimplente)
  from agency_ops.portfolio_operational_signal s
  left join agency_ops.portfolio_client_status st on st.client_id = s.client_id
  where s.lifecycle in ('ACTIVE','ONBOARDING')
    and s.sinal in ('nunca_atendido','silencio_critico','silencio_atencao')
  on conflict (event_key) do nothing;
  get diagnostics v_novas = row_count;

  update agency_ops.platform_notifications n set read_at = now()
   where n.type = 'CLIENT_SILENCE' and n.read_at is null
     and not exists (
       select 1 from agency_ops.portfolio_operational_signal s
        where s.client_id::text = n.metadata->>'client_id'
          and s.lifecycle in ('ACTIVE','ONBOARDING')
          and s.sinal = n.metadata->>'sinal');
  return v_novas;
end; $fn$;
