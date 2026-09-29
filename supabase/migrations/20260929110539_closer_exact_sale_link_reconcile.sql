-- Safe deterministic reconciliation for Vitor Feitoza historical sales.
-- Only exact normalized name matches are accepted, and only when the mapping is unique both ways.
with vitor as (
  select id
  from public.profiles
  where lower(email)=lower('feitozaluizvitor@gmail.com')
  limit 1
),
raw_candidates as (
  select c.id as client_id,l.id as lead_id
  from agency_ops.clients c
  join crm.leads l
    on l.owner_id=(select id from vitor)
   and l.archived_at is null
   and regexp_replace(lower(unaccent(c.display_name)),'[^a-z0-9]+','','g') =
       regexp_replace(lower(unaccent(coalesce(nullif(l.company,''),l.name,''))),'[^a-z0-9]+','','g')
  where c.crm_lead_id is null
    and lower(coalesce(c.closer_origin,'')) like '%vitor%feitoza%'
),
unique_clients as (
  select client_id,min(lead_id::text)::uuid as lead_id
  from raw_candidates
  group by client_id
  having count(*)=1
),
unique_both_ways as (
  select u.client_id,u.lead_id
  from unique_clients u
  join (
    select lead_id
    from unique_clients
    group by lead_id
    having count(*)=1
  ) x using(lead_id)
  where not exists (
    select 1 from agency_ops.commercial_client_lead_links e
    where e.lead_id=u.lead_id and e.client_id<>u.client_id
  )
)
update agency_ops.clients c
set crm_lead_id=u.lead_id,
    updated_at=now()
from unique_both_ways u
where c.id=u.client_id
  and c.crm_lead_id is null;
