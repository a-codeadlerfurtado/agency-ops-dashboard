# AI Workspace — Handoff de implementação

> **Atualização — 2026-08-20.** O provedor mudou para **OpenAI (`gpt-5-mini`)**,
> por decisão do Adler, alinhando com o serviço `opsquestion` que já roda na VPS.
> As menções a Anthropic/Claude abaixo descrevem o que foi especificado na época
> e ficam como registro. O estado atual está em `docs/HOSTINGER_DEPLOY.md`.

Branch de trabalho: `feature/ai-workspace`

## Objetivo

Transformar a Central de Operações em uma interface interna de IA semelhante ao Claude, usando o Claude oficial via Anthropic API, sem criar ou treinar um modelo próprio.

O usuário continua autenticando pelo Supabase Auth já existente. Cada colaborador mantém seu próprio histórico e o backend resolve `person`, `role` e `access_level` pelo `agency_ops.user_preferences` + `agency_ops.team_roster`.

## Arquitetura final corrigida

A VPS da **Hostinger** será o ambiente central e permanente da aplicação. A intenção é que a operação não dependa de nenhum computador local ficar ligado.

Fluxo final desejado:

```text
Funcionário
   ↓ navegador
Central de Operações / IA
   ↓ HTTPS
VPS Hostinger
   ├── frontend do Dashboard
   ├── backend/API da IA
   ├── workers/agentes
   ├── processos permanentes
   ├── logs
   └── integrações
        ↓
   Anthropic Claude API
        ↓
   Supabase / ClickUp / Meta / Drive / demais fontes
```

O modelo Claude **não** será hospedado na Hostinger. O modelo continua sendo servido pela Anthropic. A Hostinger hospeda a aplicação, a API, os workers e os processos que usam Claude.

O Supabase continua sendo banco/Auth/Storage e pode continuar com Edge Functions auxiliares, mas o **endpoint principal do novo chat deve preferencialmente rodar na VPS Hostinger**, para que a camada de aplicação/IA fique centralizada no servidor da agência. A Edge Function `agency-ops-ai-chat` criada nesta branch pode ser mantida temporariamente como fallback/referência durante a migração, mas não deve ser considerada obrigatoriamente a arquitetura final.

## O que já foi implementado nesta branch

### 1. Persistência privada de IA

Migration:

`supabase/migrations/20260820123000_ai_workspace.sql`

Cria em `agency_ops`:

- `ai_conversations`
- `ai_messages`
- `ai_attachments`
- `ai_usage_events`

As tabelas têm RLS habilitado e não recebem GRANT para `anon`/`authenticated`. O frontend não acessa essas tabelas diretamente. O backend deve acessar com credenciais privadas somente depois de validar a sessão/JWT do usuário.

### 2. Backend de chat inicial

Arquivo de referência já criado:

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

Fluxo implementado:

1. valida JWT;
2. resolve identidade no roster;
3. valida acesso ao cliente conforme `FULL`, `WALLET_ONLY` ou `RESTRICTED`;
4. persiste mensagem do usuário;
5. recupera as últimas mensagens da conversa;
6. monta contexto do cliente a partir de fontes `agency_ops`;
7. consulta o OpsQuestion atual como evidência operacional/fallback;
8. se `ANTHROPIC_API_KEY` estiver presente, chama a Messages API oficial da Anthropic;
9. persiste resposta, tokens, latência e auditoria;
10. atualiza título e atividade da conversa.

### Correção de arquitetura necessária

Esse código foi criado inicialmente como Supabase Edge Function para acelerar a fundação. Para a arquitetura final solicitada pelo Adler, mover/adaptar essa lógica para um **serviço backend executado na VPS Hostinger**.

Pode ser:

- rota server-side da própria aplicação, se o runtime final suportar de forma estável; ou
- serviço Node/TypeScript separado na VPS, preferencialmente containerizado ou gerenciado por systemd.

O frontend deve chamar algo como:

`https://<dominio-da-central>/api/ai/...`

em vez de depender diretamente da Edge Function do Supabase para o chat principal.

Secrets esperados no servidor Hostinger:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `SUPABASE_URL`
- chave privada/service role necessária ao backend

Nunca colocar secrets no frontend.

A Edge Function `agency-ops-ai-chat` pode permanecer disponível durante a transição como fallback de contingência até o backend Hostinger estar validado.

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

1. Rebasear/atualizar a branch com `main` de forma segura.
2. Rodar build/typecheck da branch e corrigir qualquer incompatibilidade específica do vinext/runtime final.
3. Aplicar a migration no Supabase somente após revisão.
4. Migrar/adaptar `agency-ops-ai-chat` para backend principal na VPS Hostinger.
5. Configurar os secrets da Anthropic e Supabase **no servidor Hostinger**, nunca no frontend.
6. Testar no mínimo com um usuário `FULL`, um `WALLET_ONLY` e um `RESTRICTED`.
7. Adicionar um item `IA` na navegação principal do Dashboard apontando para `/ia`.
8. Validar que nenhum colaborador consegue abrir conversa de outro usuário nem selecionar cliente fora do seu escopo.
9. Rodar Supabase security/performance advisors após a migration.
10. Testar persistência completa após logout/login e reinício do processo da VPS.
11. Configurar serviço permanente na Hostinger (Docker/systemd), healthcheck, logs e restart automático.
12. Configurar reverse proxy + HTTPS + domínio/subdomínio.
13. Somente depois disso mergear/deployar.

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

## Hostinger VPS

A Hostinger será a infraestrutura de aplicação da Central de Operações e da camada interna de IA.

Objetivo principal: **nenhum PC da agência precisa ficar ligado para manter Dashboard, IA, workers ou integrações funcionando**.

A VPS deve hospedar, conforme a arquitetura final:

- frontend/web app da Central;
- backend/API da Central;
- API gateway da IA;
- workers permanentes;
- jobs/queues quando existirem;
- logs;
- observabilidade;
- integrações que precisem de processo residente;
- futuramente workers isolados de Claude Code/Agent SDK para tarefas técnicas.

O banco principal e Auth podem continuar no Supabase gerenciado.

### Inventário obrigatório antes de deploy

Antes de alterar a VPS Hostinger, registrar:

- distro e versão;
- CPU/RAM/disco/swap;
- usuários Linux;
- SSH;
- firewall;
- portas abertas;
- Docker/Compose;
- containers atuais;
- volumes/networks;
- Node/npm;
- PM2;
- serviços systemd;
- Nginx/Caddy/Traefik;
- certificados;
- domínios/subdomínios;
- processos;
- repositórios;
- backups;
- serviços da agência já hospedados nela.

Não substituir componentes existentes às cegas.

### Deploy sugerido

- usuário Linux exclusivo para deploy/aplicação;
- repositório em `/opt/agency-ops-dashboard` ou diretório compatível com o padrão atual;
- Node LTS ou Docker, conforme padrão existente na VPS;
- build baseado em `package-lock.json`;
- processo gerenciado por systemd/PM2/container;
- Nginx/Caddy/Traefik como reverse proxy, conforme ambiente atual;
- HTTPS;
- secrets somente no servidor/secret manager;
- `main` como fonte de produção após aprovação;
- healthcheck;
- logs estruturados;
- backup;
- rollback documentado.

## Claude/Agent SDK/Claude Code na VPS

Caso existam tarefas técnicas que precisem realmente executar código, ler logs ou operar containers, isso pode rodar na Hostinger usando um worker separado com Claude Code ou Agent SDK.

Não rodar agente como root indiscriminadamente.

Estrutura desejada:

```text
backend web
   ↓
fila/job autorizado
   ↓
worker isolado
   ↓
workspace permitido
   ↓
Claude Agent/Code
```

Ações destrutivas devem exigir confirmação e auditoria.

## Segurança

- Nunca colocar `ANTHROPIC_API_KEY` no frontend.
- Nunca colocar `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Não usar `user_metadata` do JWT como autorização.
- Identidade/autorização operacional deve continuar vindo do roster validado no servidor.
- Não liberar acesso direto do cliente às tabelas `agency_ops.ai_*`.
- Toda ação futura que escreva em ClickUp, Meta, Supabase operacional ou produção deve exigir autorização explícita e ser auditada.
- Implementar rate limiting por usuário/IP no backend Hostinger.
- Aplicar limite de payload/upload.
- Não gravar secrets em logs.
- Restringir CORS ao domínio real em produção.

## Critério de aceite inicial

Um colaborador deve conseguir:

1. entrar no Dashboard com a conta atual;
2. abrir `/ia`;
3. ver apenas seu histórico;
4. criar uma conversa;
5. opcionalmente selecionar um cliente permitido;
6. conversar com Claude;
7. fechar o navegador ou desligar seu PC;
8. voltar depois de outro computador;
9. reabrir a conversa exatamente de onde parou;
10. continuar conversando normalmente;
11. não acessar dados/conversas proibidos pelo próprio perfil.

E, do ponto de vista de infraestrutura:

1. a VPS continua processando os serviços com os PCs da equipe desligados;
2. reinício da VPS recupera automaticamente os serviços;
3. nenhum processo crítico depende de sessão SSH aberta;
4. histórico permanece no Supabase;
5. frontend/backend voltam automaticamente após reboot;
6. logs e healthcheck permitem detectar falhas.
