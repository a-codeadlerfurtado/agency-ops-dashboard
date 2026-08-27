-- Corrige falsos NO_META_ACCOUNT quando a conta já é visível ao ecossistema Meta da LAK.
-- Regra automática futura: SOMENTE promove por ID exato previamente informado pelo cliente/time.
-- Matches por nome continuam exigindo evidência explícita/manual para evitar vínculo incorreto.

create or replace function agency_ops.auto_promote_exact_pending_meta_review()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_client_id uuid;
  v_client_count integer;
begin
  if new.system is distinct from 'META_AD_ACCOUNT' or nullif(trim(new.external_id),'') is null then
    return new;
  end if;

  select count(distinct ci.client_id), min(ci.client_id)
    into v_client_count, v_client_id
  from agency_ops.client_integrations ci
  where ci.system='META_AD_ACCOUNT'
    and ci.metadata->>'pending_meta_ad_account_id'=new.external_id;

  if v_client_count=1
     and not exists (
       select 1 from agency_ops.client_integrations x
       where x.meta_ad_account_id=new.external_id
         and x.client_id<>v_client_id
     ) then
    insert into agency_ops.client_integrations
      (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
    values
      (v_client_id,'META_BM',new.external_id,new.external_name,new.external_id,'ALTA','LAK_DISCOVERY_EXACT_PENDING_ID',true,
       jsonb_build_object('promoted_at',now(),'source','integration_match_review','rule','EXACT_PENDING_META_AD_ACCOUNT_ID'))
    on conflict do nothing;

    new.status := 'RESOLVED';
    new.resolved_client_id := v_client_id;
    new.resolved_by := 'SYSTEM_EXACT_META_ID';
    new.resolved_at := now();
    new.resolution_note := 'Conta ficou visível ao ecossistema Meta da LAK e o ID coincide exatamente com pending_meta_ad_account_id do cliente.';
  end if;
  return new;
end;
$$;

revoke all on function agency_ops.auto_promote_exact_pending_meta_review() from public;

drop trigger if exists trg_auto_promote_exact_pending_meta_review on agency_ops.integration_match_review;
create trigger trg_auto_promote_exact_pending_meta_review
before insert on agency_ops.integration_match_review
for each row execute function agency_ops.auto_promote_exact_pending_meta_review();

with exact_matches as (
  select r.id review_id,r.external_id,r.external_name,ci.client_id,
         count(*) over(partition by r.external_id) match_count
  from agency_ops.integration_match_review r
  join agency_ops.client_integrations ci
    on ci.system='META_AD_ACCOUNT'
   and ci.metadata->>'pending_meta_ad_account_id'=r.external_id
  where r.system='META_AD_ACCOUNT'
), safe as (
  select * from exact_matches e
  where e.match_count=1
    and not exists (
      select 1 from agency_ops.client_integrations x
      where x.meta_ad_account_id=e.external_id and x.client_id<>e.client_id
    )
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select client_id,'META_BM',external_id,external_name,external_id,'ALTA','LAK_DISCOVERY_EXACT_PENDING_ID',true,
       jsonb_build_object('promoted_at',now(),'source','existing_integration_match_review','rule','EXACT_PENDING_META_AD_ACCOUNT_ID')
from safe
on conflict do nothing;

with exact_matches as (
  select r.id review_id,r.external_id,ci.client_id,
         count(*) over(partition by r.external_id) match_count
  from agency_ops.integration_match_review r
  join agency_ops.client_integrations ci
    on ci.system='META_AD_ACCOUNT'
   and ci.metadata->>'pending_meta_ad_account_id'=r.external_id
  where r.system='META_AD_ACCOUNT'
), safe as (
  select * from exact_matches e
  where e.match_count=1
    and exists (
      select 1 from agency_ops.client_integrations x
      where x.client_id=e.client_id and x.meta_ad_account_id=e.external_id and x.system='META_BM'
    )
)
update agency_ops.integration_match_review r
set status='RESOLVED',resolved_client_id=s.client_id,resolved_by='SYSTEM_EXACT_META_ID',resolved_at=now(),
    resolution_note='Conta visível à LAK; ID exato coincide com pending_meta_ad_account_id.',updated_at=now()
from safe s where r.id=s.review_id;

-- Vínculos inequívocos confirmados pela descoberta ao vivo em 27/08/2026.
with verified(client_name,account_id,account_name) as (
  values
    ('Cleverson de Arcanjo','367609250003386','Cleverson'),
    ('Dias e Barbosa','1405910040578635','Dias imoveis'),
    ('Imperial Imóveis','1068839292578028','CA02 - Imperial Imóveis (LEO IMOBI)'),
    ('Marcelo Timbaúba','1701357534743606','CA01 - MARCELO TIMBAUBA [LEO IMOBI]'),
    ('Thais Rodrigues','4380224182246879','CA01 - Thais Rodrigues'),
    ('Trilar Imóveis','831873167838668','CA 01 - Trilar Imóveis'),
    ('Welton Cunha','4569933529902194','CA01 - Welton Cunha [LEO IMOBI]')
), resolved as (
  select c.id client_id,v.account_id,v.account_name
  from verified v join agency_ops.clients c on c.display_name=v.client_name
  where not exists (
    select 1 from agency_ops.client_integrations x
    where x.meta_ad_account_id=v.account_id and x.client_id<>c.id
  )
)
insert into agency_ops.client_integrations
  (client_id,system,external_id,external_name,meta_ad_account_id,confidence,matched_by,is_primary,metadata)
select client_id,'META_BM',account_id,account_name,account_id,'ALTA','LAK_DISCOVERY_CONFIRMED_20260827',true,
       jsonb_build_object('confirmed_at',now(),'evidence','live_meta_account_discovery_20260827','account_status',1)
from resolved
on conflict do nothing;

update agency_ops.integration_match_review r
set status='RESOLVED',resolved_client_id=c.id,resolved_by='SYSTEM_LAK_DISCOVERY_20260827',resolved_at=now(),
    resolution_note='Vínculo inequívoco confirmado pela descoberta ao vivo do ecossistema Meta da LAK em 27/08/2026.',updated_at=now()
from agency_ops.clients c
where r.system='META_AD_ACCOUNT'
  and ((c.display_name='Cleverson de Arcanjo' and r.external_id='367609250003386')
    or (c.display_name='Dias e Barbosa' and r.external_id='1405910040578635')
    or (c.display_name='Imperial Imóveis' and r.external_id='1068839292578028')
    or (c.display_name='Marcelo Timbaúba' and r.external_id='1701357534743606')
    or (c.display_name='Thais Rodrigues' and r.external_id='4380224182246879')
    or (c.display_name='Trilar Imóveis' and r.external_id='831873167838668')
    or (c.display_name='Welton Cunha' and r.external_id='4569933529902194'));

create or replace function agency_ops.guard_meta_performance_queue_scope()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_service text;
  v_scope text;
begin
  select lower(coalesce(service,'')), upper(coalesce(metadata->>'onboarding_history_scope',''))
    into v_service,v_scope
  from agency_ops.clients where id=new.client_id;

  if v_service='ia' or v_scope in ('IA_ONLY','COMMERCIAL_ONLY') then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function agency_ops.guard_meta_performance_queue_scope() from public;

drop trigger if exists trg_guard_meta_performance_queue_scope on agency_ops.meta_performance_queue;
create trigger trg_guard_meta_performance_queue_scope
before insert on agency_ops.meta_performance_queue
for each row execute function agency_ops.guard_meta_performance_queue_scope();

-- Corrige apenas o snapshot do dia da implantação, gerado com a reconciliação antiga.
do $$
declare
  v_run uuid;
begin
  select id into v_run
  from agency_ops.meta_performance_runs
  where snapshot_date=current_date
  order by created_at desc limit 1;

  if v_run is not null then
    delete from agency_ops.meta_campaign_performance_snapshots s
    using agency_ops.clients c
    where s.run_id=v_run and s.client_id=c.id
      and (lower(coalesce(c.service,''))='ia' or upper(coalesce(c.metadata->>'onboarding_history_scope','')) in ('IA_ONLY','COMMERCIAL_ONLY'));

    delete from agency_ops.meta_performance_snapshots s
    using agency_ops.clients c
    where s.run_id=v_run and s.client_id=c.id
      and (lower(coalesce(c.service,''))='ia' or upper(coalesce(c.metadata->>'onboarding_history_scope','')) in ('IA_ONLY','COMMERCIAL_ONLY'));

    delete from agency_ops.meta_performance_queue q
    using agency_ops.clients c
    where q.run_id=v_run and q.client_id=c.id
      and (lower(coalesce(c.service,''))='ia' or upper(coalesce(c.metadata->>'onboarding_history_scope','')) in ('IA_ONLY','COMMERCIAL_ONLY'));

    delete from agency_ops.meta_campaign_performance_snapshots s
    using agency_ops.client_integrations i
    where s.run_id=v_run and s.client_id=i.client_id and i.system='META_BM'
      and i.matched_by in ('LAK_DISCOVERY_EXACT_PENDING_ID','LAK_DISCOVERY_CONFIRMED_20260827');

    delete from agency_ops.meta_performance_snapshots s
    using agency_ops.client_integrations i
    where s.run_id=v_run and s.client_id=i.client_id and i.system='META_BM'
      and i.matched_by in ('LAK_DISCOVERY_EXACT_PENDING_ID','LAK_DISCOVERY_CONFIRMED_20260827');

    update agency_ops.meta_performance_queue q
    set status='PENDING',attempts=0,locked_at=null,error=null,updated_at=now()
    where q.run_id=v_run and exists (
      select 1 from agency_ops.client_integrations i
      where i.client_id=q.client_id and i.system='META_BM'
        and i.matched_by in ('LAK_DISCOVERY_EXACT_PENDING_ID','LAK_DISCOVERY_CONFIRMED_20260827')
    );

    update agency_ops.meta_performance_runs
    set status='RUNNING',finished_at=null,updated_at=now(),
        total_clients=(select count(*) from agency_ops.meta_performance_queue where run_id=v_run),
        metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
          'corrected_meta_reconciliation_at',now(),
          'correction_reason','LAK partner accounts were visible but not canonically linked; non-traffic scopes removed'
        )
    where id=v_run;

    perform agency_ops.invoke_meta_performance_weekly('work:'||v_run::text);
  end if;
end $$;