# Supabase — ambiente da IA da Central de Operações

Projeto: `bfzdetibfcwihfkltbkp` (`imobi-pro`)

## Arquitetura final

- VPS Hostinger: frontend, backend principal da IA, streaming, workers, agentes e integrações.
- Anthropic: modelo Claude via API oficial.
- Supabase: Auth, banco operacional, histórico da IA, auditoria e Storage privado.

## Migrations preparadas

1. `supabase/migrations/20260820123000_ai_workspace.sql`
   - `agency_ops.ai_conversations`
   - `agency_ops.ai_messages`
   - `agency_ops.ai_attachments`
   - `agency_ops.ai_usage_events`
   - índices de histórico/uso
   - RLS habilitado
   - acesso direto de `anon`/`authenticated` revogado
   - acesso server-side concedido ao `service_role`

2. `supabase/migrations/20260820124500_ai_workspace_storage.sql`
   - bucket privado `agency-ai-private`
   - limite inicial de 25 MiB por arquivo
   - sem policies públicas/diretas para `anon`/`authenticated`
   - trigger que mantém `updated_at` e `last_message_at` da conversa sincronizados quando uma mensagem é inserida
   - índices adicionais para histórico por usuário e auditoria

## Estado em 2026-08-20

O projeto Supabase foi verificado como `ACTIVE_HEALTHY`, Postgres 17, região `us-east-2`.

Tentativas de executar SQL/aplicar migration pelo conector do ChatGPT terminaram com `Connection terminated due to connection timeout` antes da transação ser iniciada. Por segurança, não houve repetição indefinida nem alteração parcial assumida como concluída.

Portanto: **não assumir que as migrations estão aplicadas em produção**. O executor final deve confirmar a ausência/presença dos objetos e aplicar somente o que estiver pendente.

## Regras para o backend Hostinger

- O navegador envia o access token Supabase para a API da Hostinger.
- A API valida o token com Supabase Auth antes de qualquer acesso privilegiado.
- O cliente Supabase privilegiado do servidor deve ser separado do cliente que valida o usuário.
- Nunca permitir que uma sessão do usuário sobrescreva o Authorization do cliente privilegiado.
- Preferir a chave secreta server-side atual do Supabase (`sb_secret_...`) quando disponível; nunca expor credencial privada no navegador.
- `ANTHROPIC_API_KEY` fica somente na VPS Hostinger.
- Conversas são privadas por `user_id`; autorização sempre deve ser conferida no backend, não apenas escondida pelo frontend.
- `WALLET_ONLY` deve ser validado server-side contra a carteira real do GT.
- Storage é privado. Download deve ocorrer por backend autenticado ou URL assinada de curta duração.

## Verificação obrigatória após aplicar

Confirmar:

- quatro tabelas `agency_ops.ai_*` existem;
- RLS está ativo nas quatro tabelas;
- `anon` e `authenticated` não têm acesso direto às quatro tabelas;
- backend server-side consegue CRUD com credencial privada;
- bucket `agency-ai-private` existe e `public=false`;
- upload anônimo/autenticado direto é recusado sem policy;
- trigger `ai_messages_touch_conversation` existe;
- inserir mensagem atualiza `last_message_at` da conversa;
- Supabase Security Advisor revisado;
- Supabase Performance Advisor revisado.

## Observação sobre chaves

Não salvar secret key/service-role em GitHub, frontend, logs, screenshots ou respostas de chat. Configurar somente como secret/env da VPS.
