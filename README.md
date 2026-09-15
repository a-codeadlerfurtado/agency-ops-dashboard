# Imobi — Cloud API + Embedded Signup

Entrega dos itens 3 e 4 do plano mestre: webhook/envio/status/janela de 24h + onboarding de WABA/numero via Embedded Signup.

## Antes de subir

1. Aplicar `001_schema.sql` existente.
2. Criar `imobi_app` sem SUPERUSER/BYPASSRLS e dar grants do schema.
3. Aplicar `db/002_whatsapp_webhook_resolver.sql` como owner/admin do banco.
4. Copiar `.env.example` para `.env` e preencher.
5. Garantir Redis e Postgres na rede interna do stack.
6. Expor `GET/POST /webhooks/whatsapp` em HTTPS pelo Traefik.
7. Configurar na Meta o callback e o mesmo `META_VERIFY_TOKEN`.

## Rotas

- `GET /webhooks/whatsapp` — verificacao do webhook.
- `POST /webhooks/whatsapp` — mensagens e statuses, com validacao `X-Hub-Signature-256`.
- `GET /v1/whatsapp/embedded-signup/config` — config segura para o front.
- `POST /v1/whatsapp/embedded-signup/complete` — troca code por token, assina WABA, opcionalmente registra PIN, salva conta/token criptografado e sincroniza templates.
- `POST /v1/whatsapp/messages/text` — texto apenas dentro da janela de 24h.
- `POST /v1/whatsapp/messages/template` — template aprovado, inclusive fora da janela.
- `POST /v1/whatsapp/templates/sync/:accountId` — sincroniza status dos templates.
- `POST /v1/whatsapp/templates` — cria template.
- `DELETE /v1/whatsapp/templates/:accountId/:name` — remove template.

## Decisao importante de RLS

O webhook chega apenas com `phone_number_id`, entao a API ainda nao sabe o tenant. Com `FORCE ROW LEVEL SECURITY`, tentar consultar `whatsapp_accounts` diretamente como `imobi_app` retornaria zero linhas. A migration 002 cria o papel NOLOGIN `imobi_resolver` com BYPASSRLS e o usa apenas como owner de uma unica funcao `SECURITY DEFINER`, estreita e somente-leitura, que resolve `phone_number_id -> tenant_id/account_id`. O papel da API continua sendo `imobi_app`, sem bypass. Depois disso, toda mutacao entra em transacao com `SET LOCAL app.tenant_id`.

## Idempotencia

`messages.wamid` ja e UNIQUE no schema. O inbound usa `ON CONFLICT (wamid) DO NOTHING`; retries da Meta nao duplicam mensagem nem disparam o agente de novo.

## Embedded Signup em 2026

Deixe `META_GRAPH_VERSION=v26.0` configuravel. Para Embedded Signup, use a configuracao criada no Meta Business e mantenha `META_EMBEDDED_SIGNUP_EXTRAS_JSON={}` para o fluxo v4, salvo se a configuracao da sua conta exigir extras. Nao fixe `sessionInfoVersion: 3` em codigo novo.

## Worker

O webhook grava primeiro e depois coloca `agent_turn` na fila BullMQ. O worker pode chamar o webhook interno do n8n com `tenantId`, `conversationId`, `leadId`, `messageId`; a resposta da Meta nao fica dependente do tempo do LLM/n8n.

Tambem existe job `download_media` quando a mensagem traz `mediaId`; o worker deve baixar da Meta, salvar no MinIO e atualizar `messages.midia_url`.

## Done da Sprint 1

- onboarding do numero pelo painel;
- conta gravada com token criptografado;
- WABA inscrita nos webhooks;
- recebe texto/midia;
- status ENVIADA/ENTREGUE/LIDA/FALHOU;
- texto bloqueado fora da janela de 24h;
- template permitido fora da janela;
- retry da Meta idempotente;
- evento entra no Postgres antes de acionar n8n.
