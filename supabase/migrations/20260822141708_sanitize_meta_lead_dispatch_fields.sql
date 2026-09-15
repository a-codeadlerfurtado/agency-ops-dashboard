create or replace function agency_ops.sanitize_meta_lead_dispatch_fields()
returns trigger
language plpgsql
set search_path=agency_ops,public,pg_catalog
as $$
begin
  new.lead_name := nullif(btrim(new.lead_name),'');
  new.lead_phone := nullif(regexp_replace(coalesce(new.lead_phone,''),'[^0-9]','','g'),'');
  new.lead_email := nullif(btrim(new.lead_email),'');
  if new.lead_name ~* '^(TELEFONE|EMAIL)[[:space:]]*:' then
    new.lead_name := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sanitize_meta_lead_dispatch_fields on agency_ops.meta_lead_dispatches;
create trigger trg_sanitize_meta_lead_dispatch_fields
before insert or update on agency_ops.meta_lead_dispatches
for each row execute function agency_ops.sanitize_meta_lead_dispatch_fields();

update agency_ops.meta_lead_dispatches
set lead_name=nullif(btrim(lead_name),''),
    lead_phone=nullif(regexp_replace(coalesce(lead_phone,''),'[^0-9]','','g'),''),
    lead_email=nullif(btrim(lead_email),'')
where true;

update agency_ops.meta_lead_dispatches
set lead_name=null
where lead_name ~* '^(TELEFONE|EMAIL)[[:space:]]*:';
