-- CPL Guard: pausa automática (regra nativa da Meta) de anúncio ou conjunto que gasta
-- acima do CPL ideal sem gerar lead, com aviso ao GT responsável e ao Adler.
--   anúncio: gastou 2x o CPL ideal no dia sem lead -> pausa
--   conjunto: gastou 3x o CPL ideal no dia sem lead -> pausa
-- CPL ideal: regra por ticket médio / manual (v_client_cpl_alvo); sem isso, CPL médio
-- do cliente nos últimos 30 dias (mínimo de 5 resultados).

insert into agency_ops.automation_settings (key, description, value)
values ('cpl_guard', 'CPL Guard: pausa automática por CPL (multiplicadores, piso em R$, avisos)', jsonb_build_object(
  'enabled', true,
  'whatsapp', true,
  'notify_adler', true,
  'ad_multiplier', 2,
  'adset_multiplier', 3,
  'min_threshold_brl', 20,
  'history_min_results', 5,
  'reading_model', 'gpt-5-mini'
))
on conflict (key) do nothing;

create table if not exists agency_ops.cpl_guard_rules (
  id bigserial primary key,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  ad_account_id text not null,
  level text not null check (level in ('AD', 'ADSET')),
  meta_rule_id text,
  cpl_alvo numeric,
  cpl_origem text,
  multiplier numeric not null,
  threshold_cents bigint,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'DISABLED', 'ERROR', 'NO_ACCESS', 'NO_TARGET', 'SKIPPED')),
  last_error text,
  last_synced_at timestamptz,
  history_cursor timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, level)
);

create table if not exists agency_ops.cpl_guard_events (
  id bigserial primary key,
  event_key text not null unique,
  client_id uuid references agency_ops.clients(id) on delete set null,
  gt_owner text,
  ad_account_id text not null,
  level text not null,
  meta_rule_id text,
  entity_id text not null,
  entity_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  executed_at timestamptz not null,
  cpl_alvo numeric,
  cpl_origem text,
  threshold_brl numeric,
  spend_today numeric,
  diagnosis jsonb not null default '{}'::jsonb,
  reading text,
  reading_source text,
  notified_at timestamptz,
  notify_result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists cpl_guard_events_client_idx on agency_ops.cpl_guard_events (client_id, executed_at desc);

alter table agency_ops.cpl_guard_rules enable row level security;
alter table agency_ops.cpl_guard_events enable row level security;

-- Contas Meta de cada cliente ativo com o CPL ideal efetivo.
create or replace view agency_ops.cpl_guard_targets as
with accounts as (
  select ci.client_id, regexp_replace(ci.meta_ad_account_id, '^act_', '') as ad_account_id,
         coalesce(ci.is_primary, false) as is_primary
  from agency_ops.client_integrations ci
  where ci.system = 'META_BM' and nullif(trim(ci.meta_ad_account_id), '') is not null
  union
  select cma.client_id, regexp_replace(cma.meta_ad_account_id, '^act_', ''), true
  from agency_ops.client_meta_assets cma
  where nullif(trim(cma.meta_ad_account_id), '') is not null
),
hist as (
  select i.client_id, sum(i.spend) as spend_30d, sum(coalesce(i.result_count, 0)) as results_30d
  from agency_ops.meta_campaign_insights i
  where i.date_start >= current_date - 30 and i.date_start < current_date
    and (i.objective in ('OUTCOME_LEADS', 'LEAD_GENERATION', 'MESSAGES') or i.result_type is not null)
  group by i.client_id
),
cfg as (
  select coalesce((value->>'history_min_results')::numeric, 5) as min_results
  from agency_ops.automation_settings where key = 'cpl_guard'
),
ranked as (
  select a.*, row_number() over (partition by a.ad_account_id order by a.is_primary desc, a.client_id) as rn
  from accounts a
)
select c.id as client_id,
       c.display_name,
       c.gt_owner,
       r.ad_account_id,
       h.spend_30d,
       h.results_30d,
       coalesce(v.cpl_alvo,
         case when h.results_30d >= coalesce((select min_results from cfg), 5) and h.spend_30d > 0
              then round(h.spend_30d / h.results_30d, 2) end) as cpl_alvo,
       case when v.cpl_alvo is not null then v.origem
            when h.results_30d >= coalesce((select min_results from cfg), 5) and h.spend_30d > 0 then 'HISTORICO_30D'
            else 'SEM_DADOS' end as cpl_origem
from ranked r
join agency_ops.clients c on c.id = r.client_id and c.lifecycle in ('ACTIVE', 'ONBOARDING')
left join agency_ops.v_client_cpl_alvo v on v.client_id = c.id
left join hist h on h.client_id = c.id
where r.rn = 1;

revoke all on agency_ops.cpl_guard_targets from anon, authenticated;

-- Chama a edge function (sincronizar regras ou ler pausas).
create or replace function agency_ops.invoke_cpl_guard(p_action text, p_client_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  v_secret := agency_ops.get_internal_secret('CPL_GUARD_SECRET');
  if v_secret is null or length(trim(v_secret)) < 20 then
    raise exception 'CPL_GUARD_SECRET missing from Vault';
  end if;
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-cpl-guard',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
      'x-cpl-guard-secret', v_secret),
    body := jsonb_build_object('action', p_action, 'client_id', p_client_id),
    timeout_milliseconds := 300000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function agency_ops.invoke_cpl_guard(text, uuid) from public, anon, authenticated;

-- Evento: quando o ticket médio ou o CPL manual de um cliente muda, atualiza as regras dele.
create or replace function agency_ops.cpl_guard_on_target_change()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $$
begin
  if tg_op = 'UPDATE'
     and new.ticket_medio is not distinct from old.ticket_medio
     and new.cpl_alvo_manual is not distinct from old.cpl_alvo_manual then
    return new;
  end if;
  perform agency_ops.invoke_cpl_guard('SYNC_RULES', new.client_id);
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists cpl_guard_target_change on agency_ops.client_cpl_targets;
create trigger cpl_guard_target_change
after insert or update on agency_ops.client_cpl_targets
for each row execute function agency_ops.cpl_guard_on_target_change();

-- Leitura das pausas: de hora em hora (a pausa em si é feita pela Meta a cada ~30 min).
-- Ajuste das regras: uma vez por dia (06:40 BRT), depois da sincronização de métricas.
-- pg_cron roda em UTC.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('cpl_guard_check', 'cpl_guard_sync_rules');
  perform cron.schedule('cpl_guard_check', '41 * * * *', $c$select agency_ops.invoke_cpl_guard('CHECK_HISTORY')$c$);
  perform cron.schedule('cpl_guard_sync_rules', '40 9 * * *', $c$select agency_ops.invoke_cpl_guard('SYNC_RULES')$c$);
end $$;
