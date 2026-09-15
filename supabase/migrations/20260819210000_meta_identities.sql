-- Meta: o id que o Business Manager expoe em selected_user_id e' escopado por BM.
-- A mesma pessoa (mesmo e-mail) tem ids diferentes em cada BM - verificado com
-- Vitor Hugo: 61564689521175 em "Corretores Unic" e 61592752962164 em "PH Imoveis".
-- Logo o id do BM nao serve como chave da pessoa. O identificador estavel e' o e-mail.
--
-- META               -> id global do Facebook (actor_id dos logs de atividade)
-- META_EMAIL         -> e-mail usado no Meta (pode diferir do cadastro: Joel)
-- META_BUSINESS_USER -> id por BM, N linhas por pessoa, business_id no metadata
alter table agency_ops.team_identities drop constraint if exists team_identities_system_check;
alter table agency_ops.team_identities add constraint team_identities_system_check
  check (system in ('EMAIL','CLICKUP','WHATSAPP_PHONE','WHATSAPP_NAME','SUPABASE_AUTH',
                    'META','META_BUSINESS_USER','META_EMAIL','NOTION','GOOGLE'));

create or replace view agency_ops.team_identity_map as
select t.person, t.role, r.access_level,
  max(i.external_id)   filter (where i.system='EMAIL')          as email,
  max(i.external_id)   filter (where i.system='CLICKUP')        as clickup_user_id,
  max(i.external_name) filter (where i.system='CLICKUP')        as clickup_username,
  max(i.external_id)   filter (where i.system='WHATSAPP_PHONE') as whatsapp_phone,
  count(*)             filter (where i.system='WHATSAPP_NAME')  as whatsapp_aliases,
  max(i.external_id)   filter (where i.system='SUPABASE_AUTH')  as auth_user_id,
  max(i.external_id)   filter (where i.system='META')           as meta_user_id,
  max(i.external_id)   filter (where i.system='NOTION')         as notion_user_id,
  array_remove(array[
    case when count(*) filter (where i.system='EMAIL')          = 0 then 'EMAIL'          end,
    case when count(*) filter (where i.system='CLICKUP')        = 0 then 'CLICKUP'        end,
    case when count(*) filter (where i.system='WHATSAPP_PHONE') = 0 then 'WHATSAPP_PHONE' end,
    case when count(*) filter (where i.system='SUPABASE_AUTH')  = 0 then 'SUPABASE_AUTH'  end,
    case when count(*) filter (where i.system='META_EMAIL')     = 0 then 'META'           end
  ], null) as faltando,
  round(100.0 * (
    (case when count(*) filter (where i.system='EMAIL')          > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='CLICKUP')        > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='WHATSAPP_PHONE') > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='SUPABASE_AUTH')  > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='META_EMAIL')     > 0 then 1 else 0 end)
  ) / 5.0, 0) as sincronizado_pct,
  t.role_order,
  max(i.external_id) filter (where i.system='META_EMAIL')         as meta_email,
  count(*)           filter (where i.system='META_BUSINESS_USER') as meta_bms
from agency_ops.team_overview t
left join agency_ops.team_identities i on lower(i.person) = lower(t.person)
left join agency_ops.team_roster r     on lower(r.person) = lower(t.person)
where t.in_roster
group by t.person, t.role, r.access_level, t.role_order;
