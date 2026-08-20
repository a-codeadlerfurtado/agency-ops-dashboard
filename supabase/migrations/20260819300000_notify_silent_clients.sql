-- Notificacao de cliente em silencio no ClickUp. O sinal ja existia na view
-- portfolio_operational_signal; faltava avisar.
--
-- Dedup por (cliente, gravidade): cada cliente avisa uma vez por nivel. Se piorar de
-- silencio_atencao para silencio_critico, avisa de novo - a escalada e' informacao.
-- Quando volta a gerar task ou sai da carteira, a notificacao e' marcada como lida,
-- para nao ficar no sino afirmando algo que deixou de ser verdade.
create or replace function agency_ops.notify_silent_clients()
returns integer language plpgsql security definer set search_path = agency_ops, public as $fn$
declare v_novas integer := 0;
begin
  insert into agency_ops.platform_notifications
    (event_key, type, level, title, description, client_id, source, occurred_at, metadata)
  select 'silencio:' || s.client_id || ':' || s.sinal,
         'CLIENT_SILENCE',
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
         end,
         s.client_id, 'dashboard', now(),
         jsonb_build_object('client_id', s.client_id, 'sinal', s.sinal,
                            'dias_sem_pedido', s.dias_sem_pedido, 'dias_casa', s.dias_casa,
                            'gt_owner', s.gt_owner, 'tasks', s.tasks)
  from agency_ops.portfolio_operational_signal s
  where s.lifecycle in ('ACTIVE','ONBOARDING')
    and s.sinal in ('nunca_atendido','silencio_critico','silencio_atencao')
  on conflict (event_key) do nothing;

  get diagnostics v_novas = row_count;

  update agency_ops.platform_notifications n
     set read_at = now()
   where n.type = 'CLIENT_SILENCE' and n.read_at is null
     and not exists (
       select 1 from agency_ops.portfolio_operational_signal s
        where s.client_id::text = n.metadata->>'client_id'
          and s.lifecycle in ('ACTIVE','ONBOARDING')
          and s.sinal = n.metadata->>'sinal');

  return v_novas;
end; $fn$;

select cron.schedule('agency_ops_silence_watch', '0 */6 * * *',
                     $cron$select agency_ops.notify_silent_clients();$cron$);
