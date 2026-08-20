# AI Workspace — Handoff de implementação

Branch de trabalho: `feature/ai-workspace`

## Objetivo

Transformar a Central de Operações em uma interface interna de IA semelhante ao Claude, usando o Claude oficial via Anthropic API, sem criar ou treinar um modelo próprio.

O usuário continua autenticando pelo Supabase Auth já existente. Cada colaborador mantém seu próprio histórico e o backend resolve `person`, `role` e `access_level` pelo `agency_ops.user_preferences` + `agency_ops.team_roster`.

## O que já foi implementado nesta branch

### 1. Persistência privada de IA

Migration:

`supabase/migrations/20260820123000_ai_workspace.sql`

Cria em `agency_ops`:

- `ai_conversations`
- `ai_messages`
- `ai_attachments`
- `ai_usage_events`

As tabelas têm RLS habilitado e não recebem GRANT para `anon`/`authenticated`. O frontend não acessa essas tabelas diretamente. A Edge Function usa `service_role` apenas depois de validar o JWT do usuário.

### 2. Edge Function de chat

Arquivo:

`supabase/functions/agency-ops-ai-chat/index.ts`

Ações suportadas:

- `clients`
- `list`
- `create`
- `get`
- `rename`
- `archive`
- `delete`
- `set_client`
- `send`

Fluxo do `send`:

1. valida JWT;
2. resolve identidade no roster;
3. valida acesso ao cliente conforme `FULL`, `WALLET_ONLY` ou `RESTRICTED`;
4. persiste mensagem do usuário;
5. recupera as últimas mensagens da conversa;
6. monta contexto do cliente a partir de fontes `agency_ops`;
7. consulta o OpsQuestion atual como evidência operacional/fallback;
8. se `ANTHROPIC_API_KEY` estiver presente, chama `POST https://api.anthropic.com/v1/messages`;
9. persiste resposta, tokens, latência e auditoria;
10. atualiza título e atividade da conversa.

Secrets esperados:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`

Os secrets Supabase já existentes continuam necessários:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Sem `ANTHROPIC_API_KEY`, a função mantém o OpsQuestion atual como fallback para que o rollout não fique totalmente quebrado.

### 3. Interface `/ia`

Arquivos:

- `app/ia/page.tsx`
- `app/ia/ai.css`

Já possui:

- mesma sessão Supabase do Dashboard;
- sidebar estilo Claude;
- nova conversa;
- pesquisa de conversas;
- agrupamento Hoje / Ontem / últimos períodos;
- retomada de histórico;
- contexto por cliente;
- filtragem de clientes segundo o acesso do colaborador;
- renomear conversa;
- arquivar;
- excluir;
- envio com estado de carregamento;
- indicação de modelo/fonte/latência;
- layout responsivo;
- atalho de volta para Central de Operações.

## O que falta completar antes de produção

### Obrigatório

1. Rodar build/typecheck da branch e corrigir qualquer incompatibilidade específica do vinext.
2. Aplicar a migration no Supabase somente após revisão.
3. Fazer deploy da Edge Function `agency-ops-ai-chat` com `verify_jwt=true`.
4. Configurar `ANTHROPIC_API_KEY` e `ANTHROPIC_MODEL` nos secrets das Edge Functions.
5. Testar no mínimo com um usuário `FULL`, um `WALLET_ONLY` e um `RESTRICTED`.
6. Adicionar um item `IA` na navegação principal do Dashboard apontando para `/ia`.
7. Validar que nenhum colaborador consegue abrir conversa de outro usuário nem selecionar cliente fora do seu escopo.
8. Rodar Supabase security/performance advisors após a migration.
9. Somente depois disso mergear/deployar.

### Recomendado na sequência

1. Streaming SSE da resposta do Claude.
2. Renderização Markdown/código/tabelas no chat.
3. Upload de anexos em bucket privado Supabase Storage.
4. Suporte a PDF/imagem/documentos na chamada ao Claude.
5. Busca semântica em conversas antigas.
6. Compartilhamento interno de conversas com auditoria.
7. Projetos/pastas de IA por cliente.
8. Importador de exportação do claude.ai para preservar histórico antigo quando desejado.
9. Painel administrativo de consumo por colaborador/modelo.
10. Limites de uso/custo por role.
11. Tool use formal para Supabase/ClickUp/Meta/Drive em vez de depender apenas do contexto e do fallback OpsQuestion.

## Hetzner

A Hetzner deve hospedar o frontend/backend web da Central de Operações quando o projeto sair do hosting atual. O modelo Claude NÃO deve ser hospedado na Hetzner: a aplicação usa a API oficial da Anthropic.

A Hetzner pode posteriormente hospedar workers isolados para tarefas de agente/Claude Code que precisem executar código, ler logs ou interagir com containers. Não dê acesso root irrestrito ao agente.

### Deploy sugerido

- usuário Linux exclusivo para deploy;
- repositório clonado em `/opt/agency-ops-dashboard`;
- Node LTS;
- build com o lockfile do projeto;
- processo gerenciado por systemd ou container Docker;
- Nginx/Caddy como reverse proxy;
- HTTPS;
- secrets somente no servidor/secret manager;
- branch `main` como fonte de produção;
- healthcheck e rollback documentados.

Antes de alterar infraestrutura real, inspecione como a VPS Hetzner atual está organizada. Não substitua serviços, portas, reverse proxy, Docker networks ou certificados existentes às cegas.

## Segurança

- Nunca colocar `ANTHROPIC_API_KEY` no frontend.
- Nunca colocar `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Não usar `user_metadata` do JWT como autorização.
- Identidade/autorização operacional deve continuar vindo do roster validado no servidor.
- Não liberar acesso direto do cliente às tabelas `agency_ops.ai_*`.
- Toda ação futura que escreva em ClickUp, Meta, Supabase operacional ou produção deve exigir autorização explícita e ser auditada.

## Critério de aceite inicial

Um colaborador deve conseguir:

1. entrar no Dashboard com a conta atual;
2. abrir `/ia`;
3. ver apenas seu histórico;
4. criar uma conversa;
5. opcionalmente selecionar um cliente permitido;
6. conversar com Claude;
7. sair e voltar depois;
8. reabrir a conversa exatamente de onde parou;
9. não acessar dados/conversas proibidos pelo próprio perfil.
