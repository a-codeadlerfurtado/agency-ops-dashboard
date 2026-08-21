-- Descoberta complementar de contas Meta acessíveis via parceria da BM da LAK.
--
-- Mantém o fluxo legado de /me/adaccounts intacto e adiciona uma segunda varredura
-- que tenta client_ad_accounts + owned_ad_accounts da BM. A Edge Function usa
-- fallback seguro: se o token não tiver business_management, continua devolvendo
-- as contas diretamente visíveis e registra o erro de permissão no estado da automação.

create or replace function agency_ops.invoke_meta_partner_account_discovery()
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $fn$
declare
  v_req bigint;
begin
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/meta-partner-account-discovery',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-meta-campaign-secret',(
        select value #>> '{}'
        from agency_ops.automation_settings
        where key='META_CAMPAIGN_SYNC_SECRET'
      )
    ),
    body := jsonb_build_object('include_owned',true)
  ) into v_req;

  insert into agency_ops.automation_settings(key,value,updated_at)
  values(
    'meta_partner_account_discovery',
    jsonb_build_object('last_request_id',v_req,'fired_at',now()),
    now()
  )
  on conflict(key) do update
    set value=coalesce(agency_ops.automation_settings.value,'{}'::jsonb) || excluded.value,
        updated_at=now();

  return v_req;
end
$fn$;

create or replace function agency_ops.process_meta_partner_account_discovery()
returns integer
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $fn$
declare
  v_req bigint;
  v_body jsonb;
  v_novos integer := 0;
begin
  select (value->>'last_request_id')::bigint
    into v_req
    from agency_ops.automation_settings
   where key='meta_partner_account_discovery';

  if v_req is null then
    return 0;
  end if;

  select content::jsonb
    into v_body
    from net._http_response
   where id=v_req
     and status_code=200;

  if v_body is null then
    return 0;
  end if;

  insert into agency_ops.integration_match_review(
    system,
    external_id,
    external_name,
    candidates,
    reason,
    updated_at
  )
  select
    'META_AD_ACCOUNT',
    a->>'meta_ad_account_id',
    coalesce(nullif(a->>'name',''),a->>'meta_ad_account_id'),
    jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'sources',coalesce(a->'sources','[]'::jsonb),
          'owner_business_id',nullif(a->>'owner_business_id',''),
          'owner_business_name',nullif(a->>'owner_business_name',''),
          'account_status',a->'account_status'
        )
      )
    ),
    case
      when coalesce(a->'sources','[]'::jsonb) @> '["BM_PARTNER"]'::jsonb
        or exists (
          select 1
            from jsonb_array_elements_text(coalesce(a->'sources','[]'::jsonb)) s(value)
           where s.value like '%_PARTNER'
        )
      then 'Conta de anúncio descoberta por parceria da BM da LAK e ainda sem cliente vinculado. Vincular ao cliente correto ou marcar como não-cliente.'
      else 'Conta de anúncio visível ao ecossistema Meta da LAK e ainda sem cliente vinculado. Vincular ao cliente correto ou marcar como não-cliente.'
    end,
    now()
  from jsonb_array_elements(coalesce(v_body->'accounts','[]'::jsonb)) a
  where not exists (
    select 1
      from agency_ops.client_integrations i
     where i.meta_ad_account_id=a->>'meta_ad_account_id'
  )
  on conflict(system,external_id) do update
    set external_name=excluded.external_name,
        candidates=excluded.candidates,
        reason=excluded.reason,
        updated_at=now();

  get diagnostics v_novos = row_count;

  insert into agency_ops.automation_settings(key,value,updated_at)
  values(
    'meta_partner_account_discovery',
    jsonb_strip_nulls(jsonb_build_object(
      'last_request_id',v_req,
      'processed_at',now(),
      'total_direct',coalesce((v_body->>'total_direct')::int,0),
      'total_partner',coalesce((v_body->>'total_partner')::int,0),
      'total_owned',coalesce((v_body->>'total_owned')::int,0),
      'total_union',coalesce((v_body->>'total_union')::int,0),
      'partner_only',coalesce((v_body->>'partner_only')::int,0),
      'business_ids_used',v_body->'business_ids_used',
      'businesses_discovered',v_body->'businesses_discovered',
      'business_discovery_errors',v_body->'business_discovery_errors',
      'business_results',v_body->'business_results',
      'novas_para_revisao',v_novos
    )),
    now()
  )
  on conflict(key) do update
    set value=coalesce(agency_ops.automation_settings.value,'{}'::jsonb) || excluded.value,
        updated_at=now();

  return v_novos;
end
$fn$;

-- Idempotência para reexecução da migration.
select cron.unschedule(jobid)
from cron.job
where jobname in ('meta_partner_account_discovery_weekly','meta_partner_account_discovery_process');

select cron.schedule(
  'meta_partner_account_discovery_weekly',
  '2 8 * * 1',
  $cron$select agency_ops.invoke_meta_partner_account_discovery();$cron$
);

select cron.schedule(
  'meta_partner_account_discovery_process',
  '7 8 * * 1',
  $cron$select agency_ops.process_meta_partner_account_discovery();$cron$
);
