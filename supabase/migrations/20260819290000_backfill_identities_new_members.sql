-- A semeadura de identidades (20260819200000) rodou antes de Filipe Azevedo,
-- Leonardo Augusto e Gabriel Castro entrarem no quadro, entao os tres ficaram sem
-- a identidade EMAIL e apareciam com sincronia artificialmente baixa (20-25%).
-- Idempotente: pode rodar de novo sem duplicar.
insert into agency_ops.team_identities (person, system, external_id, external_name, verified, matched_by)
select r.person, 'EMAIL', lower(r.email), r.person, true, 'team_roster'
from agency_ops.team_roster r where not r.is_former and r.email is not null
on conflict (system, external_id) do nothing;

insert into agency_ops.team_identities (person, system, external_id, external_name, verified, matched_by)
select 'Leonardo Augusto','WHATSAPP_PHONE', i.identity_value, i.canonical_name, true, 'canonical_name'
from agency_ops.whatsapp_team_identities i
where i.active and i.identity_type='PHONE' and i.canonical_name='Leonardo Augusto'
on conflict (system, external_id) do nothing;

-- Leonardo aparece nas duas BMs varridas no Business Manager.
insert into agency_ops.team_identities (person, system, external_id, external_name, verified, matched_by, metadata) values
  ('Leonardo Augusto','META_EMAIL','lakassessoriadigital@gmail.com','Leonardo Augusto', true,'meta_business_manager','{}'::jsonb),
  ('Leonardo Augusto','META_BUSINESS_USER','61582199610949','Leonardo Augusto', true,'meta_business_manager',
     jsonb_build_object('business_id','2927201347375903','business_name','Corretores Unic')),
  ('Leonardo Augusto','META_BUSINESS_USER','61587325666424','Leonardo Augusto', true,'meta_business_manager',
     jsonb_build_object('business_id','811541619724640','business_name','PH Imóveis'))
on conflict (system, external_id) do nothing;
