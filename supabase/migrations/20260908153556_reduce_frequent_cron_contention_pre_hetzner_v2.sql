-- Alivio imediato enquanto os workers pesados ainda nao foram movidos para a Hetzner.
-- O SLA do check-overdue dispara em 5 min; rodar a cada 2 min preserva a resposta
-- com no maximo ~2 min de jitter e corta pela metade as invocacoes (1440 -> 720/dia).
select cron.unschedule('check-overdue-1min');
select cron.schedule(
  'check-overdue-1min',
  '*/2 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'projeto_url')
           || '/functions/v1/check-overdue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- Mantem a mesma cadencia de 5 min da triagem, mas tira a execucao do mesmo
-- minuto dos outros jobs */5, reduzindo picos de concorrencia no Postgres.
select cron.unschedule('material-triage-escalation');
select cron.schedule(
  'material-triage-escalation',
  '1,6,11,16,21,26,31,36,41,46,51,56 * * * *',
  'select agency_ops.escalate_material_triage();'
);
