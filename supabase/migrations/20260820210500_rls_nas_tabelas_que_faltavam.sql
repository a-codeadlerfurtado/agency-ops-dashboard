-- Defesa em profundidade: 10 das ~120 tabelas de agency_ops estavam sem RLS, entre
-- elas as mais sensiveis do schema (notas de cobranca, signatarios internos de
-- contrato, anotacoes operacionais). Hoje elas ja' estao fechadas pelos grants -
-- anon e authenticated nao tem SELECT -, mas grant e' uma tranca so'. Foi exatamente
-- assim que a RPC ficou aberta: um default do Postgres concedeu o que ninguem pediu.
-- Com RLS ligada e sem policy, nem um GRANT distraido no futuro abre a tabela.
--
-- Quem escreve nelas nao e' afetado: as edge functions usam service_role (BYPASSRLS),
-- o pg_cron roda como superusuario e as funcoes SECURITY DEFINER rodam como dono.
alter table agency_ops.client_billing_notes        enable row level security;
alter table agency_ops.contract_internal_signers   enable row level security;
alter table agency_ops.contract_signal_dismissals  enable row level security;
alter table agency_ops.knowledge_base              enable row level security;
alter table agency_ops.knowledge_base_status       enable row level security;
alter table agency_ops.meta_account_discovery      enable row level security;
alter table agency_ops.meta_campaign_insights      enable row level security;
alter table agency_ops.meta_campaign_inventory     enable row level security;
alter table agency_ops.ops_notes                   enable row level security;
alter table agency_ops.transcript_signal_patterns  enable row level security;
