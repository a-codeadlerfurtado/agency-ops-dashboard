-- Corrige a Direção Comercial do Leonardo.
-- O backend consulta crm.leads / crm.lead_activities / crm.closer_goals via PostgREST,
-- mas o schema crm não estava na lista exposta. As tabelas permanecem protegidas por RLS.

alter role authenticator set pgrst.db_schemas = 'public, graphql_public, storage, agency_ops, crm';
notify pgrst, 'reload config';
