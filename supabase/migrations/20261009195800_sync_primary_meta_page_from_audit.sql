-- Replica auditavel da migracao aplicada em producao em 2026-10-09.
-- Meta API: autopreencher ID da Pagina apenas quando uma unica Pagina promotavel
-- foi confirmada para a conta de anuncios principal e nenhuma Pagina foi definida.
-- Nunca sobrescreve IDs validos escolhidos por um gestor.
create or replace function agency_ops.sync_primary_meta_page_from_audit()
returns trigger
language plpgsql
set search_path = pg_catalog, agency_ops
as $$
declare
  v_pages jsonb;
  v_page_id text;
  v_checked_at timestamptz;
  v_principal_count integer;
begin
  if new.system is distinct from 'META_BM'
     or new.is_primary is distinct from true
     or coalesce(new.meta_ad_account_id, '') !~ '^(act_)?[0-9]{5,30}$'
  then
    return new;
  end if;

  v_pages := new.metadata #> '{meta_audit,promote_pages}';
  if jsonb_typeof(v_pages) is distinct from 'array' then return new; end if;
  if jsonb_array_length(v_pages) <> 1 then return new; end if;
  v_page_id := v_pages -> 0 ->> 'id';
  if coalesce(v_page_id,'') !~ '^[0-9]{5,30}$' then return new; end if;

  begin
    v_checked_at := (new.metadata #>> '{meta_audit,checked_at}')::timestamptz;
  exception when others then
    return new;
  end;
  if v_checked_at is null
     or v_checked_at < now() - interval '48 hours'
     or v_checked_at > now() + interval '10 minutes'
  then
    return new;
  end if;

  if not exists (
    select 1 from agency_ops.clients c
    where c.id = new.client_id and c.lifecycle in ('ACTIVE','ONBOARDING')
  ) then return new; end if;

  select count(*) into v_principal_count
  from agency_ops.client_integrations i
  where i.client_id = new.client_id and i.system = 'META_BM'
    and i.is_primary is true
    and coalesce(i.meta_ad_account_id,'') ~ '^(act_)?[0-9]{5,30}$';
  if v_principal_count <> 1 then return new; end if;

  insert into agency_ops.client_meta_assets
    (client_id, meta_page_id, updated_at, updated_by_person)
  values
    (new.client_id, v_page_id, now(), 'Sincronizacao automatica Meta API (promote_pages unico)')
  on conflict (client_id) do update
    set meta_page_id = excluded.meta_page_id,
        updated_at = now(),
        updated_by_person = excluded.updated_by_person
  where coalesce(agency_ops.client_meta_assets.meta_page_id,'') !~ '^[0-9]{5,30}$'
    and (
      agency_ops.client_meta_assets.meta_ad_account_id is null
      or regexp_replace(agency_ops.client_meta_assets.meta_ad_account_id,'^act_','') =
         regexp_replace(new.meta_ad_account_id,'^act_','')
    );
  return new;
end;
$$;

drop trigger if exists trg_sync_primary_meta_page_from_audit on agency_ops.client_integrations;
create trigger trg_sync_primary_meta_page_from_audit
after insert or update of metadata, is_primary, meta_ad_account_id
on agency_ops.client_integrations
for each row
execute function agency_ops.sync_primary_meta_page_from_audit();
