# Prompt para Claude Code — finalizar integração no repositório real

Você está implementando os itens 3 e 4 da Sprint 1 da Plataforma de IA Imobiliária.

## Premissas imutáveis
- Não usar Supabase, Chatwoot, AirChat ou Railway.
- Stack 100% VPS/Portainer: Traefik, Postgres 16 + pgvector, Redis/BullMQ, MinIO, API Hono/TypeScript, Next.js, n8n.
- Multi-tenant por `tenant_id` e RLS. Em TODA transação de tenant, executar `set_config('app.tenant_id', tenantId, true)` e `set_config('app.user_id', userId, true)`.
- API roda com `imobi_app`, nunca superuser/BYPASSRLS.
- n8n é o motor do agente; o webhook não deve esperar LLM.
- Mensagens devem ser idempotentes por `wamid`.
- Token da Meta nunca em texto puro; AES-256-GCM com chave de ambiente.

## Faça agora
1. Integre os arquivos desta pasta ao repositório real sem alterar a arquitetura existente.
2. Aplique/ajuste `db/002_whatsapp_webhook_resolver.sql`.
3. Ligue `src/routes/webhook.ts` em `/webhooks/whatsapp`.
4. Ligue Embedded Signup no front Next usando `EmbeddedSignupButton.tsx` e Meta JS SDK.
5. Use Graph API via env `META_GRAPH_VERSION`, atualmente `v26.0`; não espalhe versão hardcoded.
6. Configure o Embedded Signup v4 pela configuração do Meta Business. Não introduza `sessionInfoVersion:3` em código novo.
7. Depois do commit do inbound, enfileire `agent_turn` no BullMQ. No worker, consuma e faça POST para `N8N_AGENT_WEBHOOK` com tenant/conversation/lead/message IDs.
8. Implemente `download_media`: buscar o media ID via Graph, baixar bytes, salvar no MinIO e atualizar `messages.midia_url`/`midia_mime`.
9. Adicione testes de:
   - assinatura HMAC inválida => 401;
   - retry com mesmo wamid => uma mensagem;
   - webhook de tenant A não enxerga tenant B;
   - janela de 24h aberta => texto envia;
   - janela expirada => 409 requiresTemplate;
   - template aprovado => envia fora da janela;
   - Embedded Signup salva token criptografado e WABA/phone_number_id corretos;
   - status webhook atualiza ENVIADA/ENTREGUE/LIDA/FALHOU.
10. Não mexer em schema 001 além do indispensável; novas mudanças vão em migrations numeradas.

## Critério de aceite
Um tenant autenticado clica “Conectar WhatsApp”, conclui Embedded Signup, o número aparece no banco, o webhook recebe mensagem real, cria contato/lead/conversa/mensagem apenas uma vez, abre janela de 24h, dispara job para n8n, permite responder texto dentro da janela e exige template aprovado fora dela. Status de entrega/leitura volta e atualiza a mesma mensagem.

Antes de encerrar, rode typecheck/testes, mostre os arquivos alterados e qualquer ponto que ainda dependa de configuração manual no painel da Meta.
