# PROMPT — Terminar o Jarvis no agency-ops-dashboard

Cole este arquivo inteiro como primeira mensagem, com o agente aberto em
`C:\Users\Adler\agency-ops-dashboard`. A fase 1 do Jarvis já está escrita,
commitada e publicada. Falta ligar, testar e fechar dois itens.

Não reabra o que está marcado **FEITO**. Não redesenhe o que está marcado
**DECIDIDO**.

---

## 0. Estado atual — verificado, não presumir de novo

| | |
|---|---|
| Repositório | `C:\Users\Adler\agency-ops-dashboard` |
| Worker | `agency-ops-dashboard`, versão em produção `8e528596-8449-4298-a1e1-e8f1ee182442` |
| Commit da fase 1 | `c5f696a` |
| Supabase | projeto `imobi-pro`, ref `bfzdetibfcwihfkltbkp` |
| Modelo do agente | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Workers AI) |
| KV | `JARVIS_CACHE` = `44671461c84144ee92b40d0be83f40d3` |
| Crons aplicados | `0 8 * * 1-5`, `0 12 * * 1-5`, `0 17 * * 1-5` (UTC) |

### FEITO — está no ar e verificado

- `worker/jarvis/` completo: `index.ts`, `agent.ts`, `tools.ts`, `identity.ts`,
  `confirm.ts`, `stt.ts`, `tts.ts`, `routines.ts`, `sse.ts`.
- `app/jarvis-voice.tsx` — mic, SSE, `speechSynthesis`, card de confirmação,
  atalho `Ctrl+Espaço`. Só se desenha para `MGMT`.
- `supabase/migrations/20260907120000_jarvis.sql` — 238 linhas: `jarvis_tools`,
  `jarvis_pending_actions`, `jarvis_routines`, RLS, RPC `jarvis_tool_catalog`,
  seed de 17 ferramentas e 3 rondas. **ESCRITA, NÃO APLICADA.**
- `worker/entry.ts` — intercepta `/api/jarvis/*` antes do `baseWorker` e exporta
  `scheduled`.
- `worker/index.ts` — `permissions-policy` passou de `microphone=()` para
  `microphone=(self)`. Sem isso o navegador nega o mic antes de perguntar.
- `wrangler.jsonc` — KV, crons, var `SUPABASE_ANON_KEY`.
- `app/layout.tsx` — `<JarvisVoice />` montado ao lado do `<OpsQuestionWidget />`.
- `docs/jarvis.md` — como adicionar ferramenta e ronda, limites conhecidos.

Verificado em produção: `/`, `/apps`, `/demos`, `/briefing-hub-demo` → 200;
`GET /api/ai/health` → 200; `POST /api/jarvis/chat` sem token → 401;
`permissions-policy` com `microphone=(self)`.

### DECIDIDO — não rediscutir

- **A Jarvis não tem permissão própria.** Toda chamada de ferramenta leva o JWT
  do usuário logado. O catálogo diz o que *existe*; quem pode o quê continua
  sendo decidido pela edge function de destino. `roles_allowed` é economia de
  rodada, não fronteira de segurança.
- **Escrita nunca executa direto.** Vira pendência em `jarvis_pending_actions`,
  validade de 15 minutos. Uma constraint no banco impede registrar
  `mode='write'` sem `requires_confirmation`.
- **Rondas exigem `JARVIS_SERVICE_JWT`.** Sem o segredo elas não rodam e
  devolvem 503 — falhar visível em vez de rodar com permissão não revisada.
- Frontend não usa `localStorage`. A pendência vive no servidor.

---

## 1. Três armadilhas já pagas — não repita

**1.1 — O POST de `agency-ops-work-center-api` e `agency-ops-required-alerts-api`
é MUTAÇÃO**, não leitura (`work-item-update`, `ACK`). A leitura é o `GET`. O
catálogo registra o GET. Se alguém "corrigir" para POST, o agente ganha uma
escrita disfarçada de consulta, sem confirmação.

**1.2 — `agency-ops-leonardo-clickup-api` só aceita GET.** Não cria task. A
criação no ClickUp vai por `agency-ops-work-item-create-api` com
`create_clickup: true`, e é assim que `criar_task_clickup` está registrada.

**1.3 — DOIS repositórios locais publicam no mesmo Worker.**
`C:\Users\Adler\agency-ops-cobranca\wrangler.jsonc` também tem
`"name": "agency-ops-dashboard"`, mesmo commit raiz, e está desatualizado.
**Nunca rode `wrangler deploy` de dentro do `agency-ops-cobranca`** — ele
sobrescreve o dashboard inteiro com um estado antigo.

Relacionado: a página `/apps` já sumiu de produção uma vez exatamente assim.
Hoje ela está versionada (`app/apps/route.ts`, commit `2a94509`), mas confira
que ela responde 200 antes e depois de qualquer deploy.

---

## 2. Regras de trabalho

- Leia o código-fonte da edge function antes de escrever qualquer coisa que a
  chame. Os fontes estão em `supabase/functions/` (106 delas) e as migrations em
  `supabase/migrations/` (227). Não invente schema.
- **Não modifique** `/api/ai/*`, `worker/index.ts:handleAI`, nem
  `app/opsquestion-widget.tsx`. O Jarvis entra por fora.
- **Nunca `wrangler deploy` sem antes** `wrangler versions upload`, testar a URL
  de preview e confirmar que `/`, `/apps`, `/demos`, `/briefing-hub-demo` e
  `/api/ai/health` continuam 200.
- **Não gere credenciais.** Se um segredo for necessário, entregue o comando e
  peça para o Adler executar.
- Existe um erro de tipo **pré-existente** em `app/briefing-staff-bridge.tsx:62`
  (`TS7023`). Não é seu, não conserte de passagem.
- Commits curtos, em português. Não faça push sem perguntar — o repo tem remote
  e outra sessão mexe nele.

---

## 3. O que falta — nesta ordem

### Etapa A — aplicar a migration (bloqueia tudo)

O MCP do Supabase estava sem autenticação. Se o seu tiver, aplique
`supabase/migrations/20260907120000_jarvis.sql` com `apply_migration`. Se não,
peça ao Adler para colar no SQL Editor.

Verifique:
```sql
select count(*) from agency_ops.jarvis_tools;                    -- 17
select count(*) from agency_ops.jarvis_routines;                 -- 3
select name, mode, requires_confirmation, http_method, edge_function
  from agency_ops.jarvis_tools order by mode, name;
```
Mostre a saída. Se `count` for 0, pare — nada adiante funciona.

### Etapa B — segredos

Peça ao Adler para rodar, no diretório do repo:
```
wrangler secret put JARVIS_SERVICE_TOKEN   # protege POST /api/jarvis/run
wrangler secret put JARVIS_SERVICE_JWT     # identidade das rondas (service role)
```
Confirme com `wrangler secret list`.

### Etapa C — teste de leitura (critério 1)

Com um JWT de usuário MGMT válido:
```bash
curl -N -X POST https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/jarvis/chat \
  -H "authorization: Bearer <JWT>" -H "content-type: application/json" \
  -d '{"message":"quais clientes precisam de atenção hoje?"}'
```
Esperado: eventos `tool_start` com `saude_dos_clientes`, depois `token`, depois
`done` com `tool_calls >= 1`. **Mostre o log de `tool_calls`.**

Se o modelo não chamar ferramenta nenhuma, o problema é function calling no
70B — só então considere o fallback do item E.

### Etapa D — teste de escrita e confirmação (critério 2)

```bash
# 1. deve gerar `pending`, NÃO executar
-d '{"message":"cria uma demanda pro CS ligar pra <cliente de teste>"}'

# 2. confirmar
curl -X POST .../api/jarvis/confirm \
  -H "authorization: Bearer <JWT>" -H "content-type: application/json" \
  -d '{"action_id":"<uuid do evento pending>","decision":"confirm"}'
```
Verifique que a demanda apareceu no Work Center e que
`jarvis_pending_actions.status` virou `EXECUTED`.

Teste também o atalho por voz: mande `{"message":"sim"}` com uma pendência
aberta — deve confirmar sem passar pelo modelo.

### Etapa E — teste de escopo (critério 3)

Com um JWT de **GT**, peça dado de um cliente fora da carteira dele, inclusive
tentando via `consulta_sql_leitura`. Esperado: `consulta_sql_leitura` nem
aparece no catálogo dele (é `roles_allowed = {MGMT}`), e as outras ferramentas
devolvem só a carteira dele — o corte é feito pela edge function, não pelo
agente. Registre o resultado.

### Etapa F — rondas (critério 5)

```bash
curl -X POST .../api/jarvis/run -H "authorization: Bearer $JARVIS_SERVICE_TOKEN"
```
Esperado: 200 com relatório das 3 rondas, linhas novas em
`agency_ops.platform_notifications` com `category = 'JARVIS_RONDA'`, e
`jarvis_routines.last_run_at` preenchido. Confirme que a notificação aparece no
dashboard.

### Etapa G — fallback OpenAI (não implementado)

Hoje `agent.ts` tem só a primeira metade: se `env.AI.run` falha, ele tenta **uma
vez** com o contexto cortado de 14k para 8k caracteres. Falta o desvio para
`gpt-5.6-luna` via AI Gateway quando essa segunda tentativa também falha.

Implemente no `catch` de `agent.ts`, atrás de `env.AI_GATEWAY_OPENAI`, com a
mesma lista de tools, e grave `fallback: true` em
`ai_usage_events.metadata`. Se o 70B passar bem nas etapas C e D, isto vira
baixa prioridade — registre e siga.

### Etapa H — rotina `saudacao_diaria` (fora do escopo original)

Substituir o MP3 estático do `daily-greeting-v3` por texto gerado às 05h.
**Leia `supabase/functions/agency-ops-daily-greeting-api/index.ts` primeiro** —
se o contrato não aceitar escrita, não force: registre em `docs/jarvis.md` e
deixe para depois.

### Etapa I — deploy e fechamento

`versions upload` → testar preview → `wrangler deploy` (é o `deploy` que aplica
triggers; `versions deploy` não). Depois confirme em produção as mesmas 5 rotas
do item 2. Atualize `docs/jarvis.md` com o que mudou.

---

## 4. Critérios de aceite

Dos sete originais, **um** está verificado hoje: `/api/ai/*` e o OpsQuestion de
texto continuam funcionando exatamente como antes. Os outros seis dependem da
Etapa A:

- [ ] Voz: "o que tá travado na Imperial?" responde falado, com dados reais, e a
      UI mostra as ferramentas usadas.
- [ ] "cria uma demanda pro CS" gera pendência, fala "Confirmo?", só executa
      após "sim".
- [ ] GT não obtém dado fora da carteira, nem pedindo por SQL.
- [ ] Nenhuma resposta contém nome de tabela ou coluna.
- [ ] `campanhas_em_risco` roda pelo cron e gera notificação.
- [ ] `ai_usage_events` registra tokens; nenhuma conversa passa de 6 rodadas.
- [x] `/api/ai/*` e o OpsQuestion de texto intactos.

---

## 5. Fora de escopo

Kokoro/Hetzner/Tunnel (o contrato está comentado em `worker/jarvis/tts.ts`),
Gmail e Calendar, wake word, trocar o modelo do OpsQuestion de texto, e qualquer
alteração no imoBia (`mcp-tools`, `motor_*`, n8n dos tenants).
