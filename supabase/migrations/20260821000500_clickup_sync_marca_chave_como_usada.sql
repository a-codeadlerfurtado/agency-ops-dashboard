-- A chave do cron do ClickUp estava com last_used_at nulo mesmo com a
-- sincronizacao rodando de 15 em 15 minutos: quem valida o header em
-- clickup-sync-api nao escreve nesse campo.
--
-- Isso e' uma armadilha. Em 20/08 uma migration podou "chaves de dashboard
-- nunca usadas" e a do cron so' escapou por ter sido criada horas antes. Na
-- proxima poda ela seria desativada, o ClickUp pararia calado, e ninguem
-- ligaria a parada a uma limpeza de chaves feita dias antes.
--
-- Quem dispara passa a carimbar o uso. E' verdade: a chave esta' sendo usada.

create or replace function agency_ops.invoke_clickup_sync()
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops', 'extensions', 'public', 'pg_catalog'
as $function$
declare
  v_key text;
  v_request_id bigint;
begin
  v_key := agency_ops.get_internal_secret('CLICKUP_SYNC_DASHBOARD_KEY');
  if v_key is null or length(trim(v_key)) < 40 then
    raise exception 'CLICKUP_SYNC_DASHBOARD_KEY ausente ou curta demais no Vault';
  end if;

  -- Antes de disparar, para o carimbo existir mesmo que a chamada falhe: a
  -- chave foi usada de qualquer jeito, e e' isso que a poda precisa enxergar.
  update agency_ops.dashboard_api_keys
     set last_used_at = now()
   where label = 'clickup-sync-cron'
     and active;

  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/clickup-sync-api?action=sync&since_days=7&page_start=0&max_pages=5',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dashboard-key', v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

revoke all on function agency_ops.invoke_clickup_sync() from public, anon, authenticated;

comment on function agency_ops.invoke_clickup_sync() is
  'Dispara clickup-sync-api server-side e carimba last_used_at da chave, para a poda de chaves ociosas nao desativar o cron.';
