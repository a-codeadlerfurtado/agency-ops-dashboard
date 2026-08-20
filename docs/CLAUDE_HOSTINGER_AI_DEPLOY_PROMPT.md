# Prompt para Claude — concluir IA da Central de Operações na VPS Hostinger

> **Atualização — 2026-08-20.** O provedor mudou para **OpenAI (`gpt-5-mini`)**,
> por decisão do Adler, alinhando com o serviço `opsquestion` que já roda na VPS.
> As menções a Anthropic/Claude abaixo descrevem o que foi especificado na época
> e ficam como registro. O estado atual está em `docs/HOSTINGER_DEPLOY.md`.

Você vai assumir a continuação de uma implementação já iniciada no projeto **Central de Operações / Agency Ops Dashboard**. Não comece do zero.

## Objetivo final

Transformar a Central de Operações em uma interface interna de IA semelhante ao Claude para toda a equipe, usando o **Claude oficial da Anthropic via API**, com:

- login já existente do Dashboard;
- conversas privadas por colaborador;
- histórico persistente;
- nova conversa;
- busca;
- reabrir/continuar conversa;
- renomear/arquivar/excluir;
- contexto por cliente;
- permissões FULL / WALLET_ONLY / RESTRICTED;
- anexos privados;
- auditoria e uso por colaborador;
- streaming posteriormente ou já nesta etapa se estável;
- frontend/backend executando na VPS Hostinger, sem depender de nenhum PC local ficar ligado.

Arquitetura desejada:

```text
Funcionário
   ↓ navegador
Central de Operações / IA
   ↓ HTTPS
VPS HOSTINGER
   ├── frontend do Dashboard
   ├── backend/API principal da IA
   ├── workers/agentes
   ├── logs
   └── processos 24/7
        ↓
   Anthropic Claude API
        ↓
   Supabase Auth / DB / Storage
        ↓
   ClickUp / Meta / Drive / demais integrações
```

O modelo Claude NÃO será hospedado na Hostinger. A Hostinger hospeda a aplicação e os processos que chamam a Anthropic.

---

## 1. Repositório

GitHub:

`a-codeadlerfurtado/agency-ops-dashboard`

Branch preparada:

`feature/ai-workspace`

Faça primeiro:

```bash
git fetch origin
git checkout feature/ai-workspace
git status
git log --oneline --decorate -15
```

A branch pode estar um ou mais commits atrás de `main`. Compare antes de rebasear/mergear.

NÃO mergeie em `main` sem autorização explícita do Adler.

---

## 2. Leia estes arquivos antes de alterar qualquer coisa

- `docs/AI_WORKSPACE_HANDOFF.md`
- `docs/SUPABASE_AI_ENVIRONMENT.md`
- `supabase/migrations/20260820123000_ai_workspace.sql`
- `supabase/migrations/20260820124500_ai_workspace_storage.sql`
- `supabase/functions/agency-ops-ai-chat/index.ts`
- `app/ia/page.tsx`
- `app/ia/ai.css`
- `app/shared.tsx`
- `app/page.tsx`

O projeto já possui OpsQuestion, Supabase Auth, profiles/user_preferences, team_roster, clientes e dados operacionais.

Não crie outro sistema de login.

---

## 3. Estado confirmado do Supabase

Projeto:

`bfzdetibfcwihfkltbkp`

Nome:

`imobi-pro`

Região:

`us-east-2`

Postgres:

17.x

O projeto foi confirmado como `ACTIVE_HEALTHY`.

As migrations da IA foram preparadas no GitHub, mas NÃO assuma que foram aplicadas. O executor do ChatGPT recebeu `Connection terminated due to connection timeout` antes de iniciar a transação.

Portanto confirme o estado real do banco.

---

## 4. Preparar Supabase

Use Supabase CLI, conector disponível, SQL Editor pelo browser ou conexão Postgres segura.

Antes de qualquer comando, descubra a versão e opções atuais:

```bash
supabase --version
supabase --help
supabase db --help
supabase migration --help
```

Não chute flags.

Vincule somente ao projeto correto `bfzdetibfcwihfkltbkp`.

Confira migrations remotas/locais antes de push.

Aplique somente o que estiver pendente e não execute migrations históricas antigas acidentalmente.

Migrations novas preparadas:

### `20260820123000_ai_workspace.sql`

Cria:

- `agency_ops.ai_conversations`
- `agency_ops.ai_messages`
- `agency_ops.ai_attachments`
- `agency_ops.ai_usage_events`

Com:

- índices;
- FKs;
- RLS habilitado;
- `anon`/`authenticated` sem acesso direto;
- server-side autorizado.

### `20260820124500_ai_workspace_storage.sql`

Cria/configura:

- bucket privado `agency-ai-private`;
- limite inicial de 25 MiB;
- trigger `ai_messages_touch_conversation`;
- função `agency_ops.touch_ai_conversation_from_message()`;
- índices adicionais.

Nenhuma policy de Storage deve tornar esse bucket público.

Acesso aos anexos deve ocorrer pela API confiável da Hostinger ou URL assinada de curta duração gerada por ela.

---

## 5. Segurança Supabase

Não expor no frontend:

- secret key do Supabase;
- service_role;
- senha Postgres;
- ANTHROPIC_API_KEY.

Na VPS, prefira uma **chave secreta server-side atual do Supabase** (`sb_secret_...`) se o projeto oferecer essa opção. Se a instalação existente ainda depender de `service_role`, mantenha compatibilidade apenas server-side e documente a migração futura.

O browser continuará usando somente a publishable key já utilizada pelo Dashboard.

Para validar usuário:

1. browser envia access token Supabase para backend Hostinger;
2. backend valida token com Supabase Auth;
3. resolve `auth.users.id`;
4. consulta `agency_ops.user_preferences`;
5. resolve `collaborator_person`;
6. consulta `agency_ops.team_roster`;
7. determina `role` e `access_level`;
8. somente depois utiliza cliente privilegiado para ler/escrever dados privados.

IMPORTANTE: não reutilize um cliente SSR que possa substituir o Authorization da credencial privilegiada por uma sessão do usuário. Use clientes separados.

---

## 6. Permissões

Já existem níveis:

- `FULL`
- `WALLET_ONLY`
- `RESTRICTED`

Eles precisam ser aplicados no backend.

### FULL

Pode consultar clientes permitidos globalmente segundo as regras existentes.

### WALLET_ONLY

Um GT só pode selecionar/consultar clientes da própria carteira.

### RESTRICTED

Respeitar escopo já estabelecido no sistema.

Não confie no frontend.

Teste requisição manual tentando forçar `client_id` proibido.

Resposta deve ser 403/404 conforme convenção da API.

---

## 7. Conversas privadas

Usuário A nunca pode:

- listar conversa de B;
- abrir conversa de B;
- enviar mensagem na conversa de B;
- renomear conversa de B;
- excluir conversa de B;
- baixar anexo de B.

Todas as operações devem verificar `user_id` no servidor.

Teste ataques alterando UUID manualmente.

---

## 8. Backend principal deve rodar na Hostinger

Já existe uma Edge Function de referência:

`supabase/functions/agency-ops-ai-chat/index.ts`

Ela implementa a lógica inicial e NÃO deve ser descartada sem análise.

Use-a como fonte para mover/adaptar a lógica para um serviço Node/TypeScript na VPS Hostinger.

Arquitetura sugerida:

```text
server/
  src/
    index.ts
    routes/
      ai.ts
    services/
      auth.ts
      anthropic.ts
      supabase.ts
      permissions.ts
      conversations.ts
      client-context.ts
    workers/
    tools/
```

Pode adaptar a estrutura ao projeto existente se houver padrão melhor.

Não faça refactor gigante do Dashboard.

Endpoints desejados, conceitualmente:

- `POST /api/ai/conversations/list`
- `POST /api/ai/conversations/create`
- `POST /api/ai/conversations/get`
- `POST /api/ai/conversations/rename`
- `POST /api/ai/conversations/archive`
- `POST /api/ai/conversations/delete`
- `POST /api/ai/conversations/set-client`
- `POST /api/ai/chat`
- `POST /api/ai/clients`

Pode usar uma convenção REST mais limpa se preferir, desde que adapte o frontend e mantenha segurança.

---

## 9. Anthropic

Usar API oficial da Anthropic.

Secrets na Hostinger:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`

Consulte documentação oficial atual antes de escolher o modelo.

Não hardcode modelo obsoleto.

Modelo deve ser configurável por env.

Para uso geral da equipe, prefira um modelo Sonnet atual, salvo motivo técnico melhor.

Registrar em `ai_usage_events`:

- provider;
- model;
- input_tokens;
- output_tokens;
- latency_ms;
- status;
- error;
- request_id.

Não registrar secret em logs.

---

## 10. Contexto do cliente

Quando uma conversa possuir `client_id`, monte contexto seletivo a partir do schema `agency_ops`.

A implementação inicial já consulta fontes como:

- `dashboard_client_overview`
- `campaign_client_latest`
- `client_health_scores`
- `conversation_state`
- `client_service_overview`

Pode aproveitar o OpsQuestion existente como evidência/fallback.

Não envie o banco inteiro para Claude.

Faça recuperação seletiva conforme a pergunta.

---

## 11. Frontend `/ia`

Já existe:

- `app/ia/page.tsx`
- `app/ia/ai.css`

Não substitua por uma tela genérica.

Ela já possui:

- sessão existente;
- sidebar estilo Claude;
- nova conversa;
- pesquisa;
- histórico;
- grupos por data;
- selecionar cliente;
- renomear;
- arquivar;
- excluir;
- retomada de conversa;
- responsividade.

Hoje ela ainda aponta para a Edge Function Supabase.

ALTERE para apontar para o backend principal da Hostinger.

Preferência:

- API same-origin `/api/ai/...`, evitando CORS desnecessário;
- ou variável de ambiente pública para base URL se backend usar subdomínio.

Não enviar `service_role`/secret key no browser.

---

## 12. Corrigir estado de cliente no frontend

Revise `draftClientId` em `app/ia/page.tsx`.

Garanta:

- nova conversa começa com contexto correto;
- abrir conversa recupera o `client_id` real dela;
- conversa sem cliente mostra `Geral`;
- trocar cliente altera apenas a conversa atual;
- abrir outra conversa não herda cliente indevidamente.

---

## 13. Adicionar IA ao menu principal

No menu lateral do Dashboard, adicionar:

`IA`

Apontando para `/ia`.

Não usar iframe.

---

## 14. Hostinger VPS

A intenção é que NADA dependa de PC local ficar ligado.

Inspecione primeiro o ambiente da VPS.

Você pode usar:

- SSH/terminal se estiver disponível;
- browser no painel Hostinger se autenticado;
- conector/plugin Hostinger se realmente existir no seu ambiente.

Não invente conector.

Faça inventário antes de alterar:

- hostname;
- distro/versão;
- CPU/RAM/disco/swap;
- usuários;
- SSH;
- firewall;
- Docker;
- Docker Compose;
- Node/npm;
- PM2;
- systemd;
- nginx/Caddy/Traefik;
- portas;
- certificados;
- domínios;
- processos;
- containers;
- volumes;
- diretórios;
- repositórios;
- backups.

Não derrube serviços existentes.

---

## 15. Deploy Hostinger

Adapte-se ao padrão atual da VPS.

Se Docker já for padrão, use Docker/Compose.

Se systemd + Node já estiver correto, não introduza Docker só por preferência.

Requisitos:

- processo reinicia sozinho;
- healthcheck;
- logs;
- HTTPS;
- reverse proxy;
- secrets protegidos;
- deploy reproduzível;
- rollback simples;
- branch/commit identificável.

Não rode Claude Code como root nem use permissões perigosas irrestritas em produção.

---

## 16. Build

Antes de deploy:

```bash
npm ci
npm run typecheck
npm run build
```

Corrija todos os erros.

O projeto atual usa React/TypeScript/vinext. Não migre a stack inteira sem necessidade.

Se criar um backend Node separado, tenha build/typecheck/test próprio também.

---

## 17. Anexos

Bucket preparado:

`agency-ai-private`

Fluxo recomendado:

1. usuário autenticado solicita upload;
2. backend valida usuário/conversa;
3. backend grava arquivo ou gera mecanismo seguro de upload;
4. metadados entram em `agency_ops.ai_attachments`;
5. download somente após autorização;
6. usar signed URLs curtas quando conveniente.

Suporte futuro desejado:

- PDF;
- TXT;
- CSV;
- XLSX;
- DOCX;
- imagens.

Validar MIME/tamanho.

---

## 18. Streaming

Após núcleo seguro funcionar, implementar streaming (SSE ou mecanismo equivalente) para experiência semelhante ao Claude.

Também desejável:

- Markdown sanitizado;
- tabelas;
- blocos de código;
- copiar;
- interromper geração;
- regenerar.

Não sacrifique segurança de identidade/histórico para implementar streaming.

---

## 19. Testes obrigatórios

### Login

- usuário existente entra normalmente;
- logout/login preserva funcionamento.

### Persistência

1. criar conversa;
2. mandar mensagem;
3. receber resposta do Claude;
4. fechar navegador;
5. entrar novamente;
6. abrir `/ia`;
7. conversa aparece;
8. histórico completo abre;
9. nova mensagem mantém contexto.

### Permissões

Testar:

- FULL;
- WALLET_ONLY;
- RESTRICTED;
- cross-user;
- cross-client;
- UUID manual de conversa alheia;
- client_id fora da carteira.

### Storage

- bucket é privado;
- upload direto sem autorização não funciona;
- backend autorizado consegue upload/download;
- usuário não acessa arquivo de conversa de outro usuário.

### Sistema existente

Smoke test:

- Home;
- Clientes;
- Onboarding;
- Campanhas;
- ClickUp;
- Notificações;
- perfil;
- IA.

A nova IA não pode quebrar as páginas atuais.

---

## 20. Advisors

Depois das migrations:

- rodar Supabase Security Advisor;
- rodar Supabase Performance Advisor;
- corrigir problemas novos introduzidos por esta implementação;
- não faça mudanças massivas não relacionadas sem autorização.

---

## 21. Não mexer em produção às cegas

Antes de deploy real:

- backup;
- commit conhecido;
- build verde;
- migrations verificadas;
- healthcheck;
- rollback planejado.

Não mergeie `feature/ai-workspace` em `main` sem autorização explícita do Adler.

Pode preparar staging e deixar tudo validado.

---

## 22. Relatório final obrigatório

Ao terminar, devolva:

### Estado inicial

- GitHub
- Supabase
- Hostinger

### Supabase

- migrations aplicadas
- tabelas criadas
- bucket criado
- RLS/grants
- advisors

### Hostinger

- ambiente encontrado
- serviços criados/alterados
- reverse proxy
- domínio/porta
- processo manager/container
- healthcheck

### Anthropic

- modelo configurado
- integração testada
- não revelar API key

### Frontend

- `/ia`
- menu
- histórico
- seleção de cliente
- responsividade

### Segurança

Resultado dos testes:

- FULL
- WALLET_ONLY
- RESTRICTED
- cross-user
- cross-client
- anexos

### Build

Resultado de:

```bash
npm run typecheck
npm run build
```

### Git

- branch
- commits
- arquivos alterados

### URLs

- staging/produção
- healthcheck

### Pendências

Liste qualquer item não concluído de forma explícita.

Se a única coisa que faltar for merge/deploy destrutivo, pare e peça autorização explícita do Adler.
