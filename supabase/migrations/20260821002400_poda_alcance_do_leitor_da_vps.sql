-- agency_ops_ai_reader e' o usuario de banco que a VPS do OpsQuestion usa. Ele e'
-- somente-leitura, mas tem BYPASSRLS - o que e' proposital e necessario no desenho
-- atual (as tabelas tem RLS sem policy, entao sem o bypass ele leria zero linha).
-- Consequencia: RLS nao protege nada dele, e o unico controle real e' o GRANT.
--
-- Alguem ja' havia tirado dele automation_settings (os segredos) e
-- contract_internal_signers. Sobraram duas tabelas de INFRAESTRUTURA que a IA nunca
-- tem motivo para consultar - ela responde pergunta operacional sobre cliente, nao
-- sobre autenticacao:
--   dashboard_api_keys  - hashes das chaves de acesso total
--   team_login_emails   - a allowlist de quem pode se cadastrar
--
-- Se a VPS for comprometida, isso deixa de ir junto.
revoke all on agency_ops.dashboard_api_keys from agency_ops_ai_reader;
revoke all on agency_ops.team_login_emails  from agency_ops_ai_reader;
