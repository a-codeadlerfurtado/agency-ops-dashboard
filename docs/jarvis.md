# Jarvis

Assistente de voz com loop de agente, montado por cima do OpsQuestion. Consulta e
executa nos sistemas da operação usando as edge functions que já existem.

**Princípio que sustenta o resto:** a Jarvis não tem permissão própria. Toda
chamada de ferramenta leva o JWT do usuário logado, então ela vê e faz
exatamente o que aquela pessoa vê e faz. O catálogo diz o que *existe*; quem
pode o quê continua sendo decidido pela edge function de destino.

## O que roda onde

| Caminho | Arquivo | O que faz |
|---|---|---|
| `POST /api/jarvis/chat` | `worker/jarvis/agent.ts` | loop de agente, resposta em SSE |
| `POST /api/jarvis/confirm` | `worker/jarvis/confirm.ts` | executa ou cancela ação pendente |
| `POST /api/jarvis/stt` | `worker/jarvis/stt.ts` | Whisper, só para navegador sem Web Speech |
| `POST /api/jarvis/tts` | `worker/jarvis/tts.ts` | 501 na fase 1 |
| `POST /api/jarvis/run` | `worker/jarvis/routines.ts` | rondas, chamado pelo Cron Trigger |

A interceptação acontece em `worker/entry.ts`, antes do `baseWorker` — mesmo
lugar onde o `creative-vision` já entrava. **`/api/ai` não foi tocado**: o
OpsQuestion de texto continua exatamente como era.

## Adicionar uma ferramenta

Uma linha em `agency_ops.jarvis_tools`. Nada de código.

```sql
insert into agency_ops.jarvis_tools
  (name, description, input_schema, edge_function, http_method, mode,
   requires_confirmation, roles_allowed)
values
  ('nome_em_snake_case',
   'Verbo primeiro, em pt-BR, dizendo QUANDO usar. Até 160 caracteres.',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   'agency-ops-alguma-api', 'GET', 'read', false, array['MGMT']);
```

Antes de inserir, **leia a edge function**. Foi assim que os 17 do seed foram
feitos, e três surpresas apareceram:

- `agency-ops-work-center-api` e `agency-ops-required-alerts-api`: o `POST`
  delas é **mutação** (`work-item-update`, `ACK`). A leitura é o `GET`.
  Registrar o POST como ferramenta de leitura teria dado ao agente uma escrita
  disfarçada de consulta.
- `agency-ops-leonardo-clickup-api` só aceita `GET` — **não cria task**. A
  criação no ClickUp acontece por `work-item-create-api` com
  `create_clickup: true`, e é assim que `criar_task_clickup` está registrada.
- Várias funções de leitura são `GET` com query string, não `POST` com body. O
  executor monta os dois; o que define é a coluna `http_method`.

Uma constraint no banco impede registrar `mode='write'` sem
`requires_confirmation`. Não é possível criar por engano uma ferramenta de
escrita que executa sozinha.

O catálogo tem cache de 60s no KV `JARVIS_CACHE`. Uma ferramenta nova demora
até um minuto para aparecer.

## Adicionar uma ronda

Uma linha em `agency_ops.jarvis_routines`. `tools_allowed` é filtrado de novo em
tempo de execução contra `mode='read'` — uma ronda não escreve nem se o catálogo
estiver mal semeado.

## Ativar o fallback OpenAI

Hoje o agente usa `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Se o contexto
estourar, ele tenta uma vez com o contexto cortado para 8k. Para cair no
`gpt-5.6-luna` via AI Gateway depois disso, defina `AI_GATEWAY_OPENAI` e
implemente a segunda tentativa no `catch` de `agent.ts`. **Ainda não está
implementado** — o corte para 8k está, o desvio para o Gateway não.

## Ligar o Kokoro (fase 2)

`worker/jarvis/tts.ts` já tem o contrato no comentário: proxy para
`env.KOKORO_URL` com header `x-jarvis-token`, cache em KV por sha256 do texto,
retorno `audio/ogg`. O frontend já tenta o servidor e cai no `speechSynthesis`
ao receber 501, então ligar a fase 2 não exige mexer no front.

## Segredos

```
wrangler secret put JARVIS_SERVICE_TOKEN   # protege POST /api/jarvis/run
wrangler secret put JARVIS_SERVICE_JWT     # identidade das rondas (ver abaixo)
wrangler secret put N8N_JARVIS_WEBHOOK     # opcional
wrangler secret put KOKORO_URL             # fase 2
wrangler secret put KOKORO_TOKEN           # fase 2
wrangler secret put AI_GATEWAY_OPENAI      # fallback, ainda não implementado
```

`SUPABASE_ANON_KEY` está em `vars` no `wrangler.jsonc`, não em secret: é a chave
publicável, a mesma que o front já expõe.

## A exceção ao princípio

As rondas rodam pelo cron, sem ninguém logado. Alguém precisa emprestar
identidade, e é aí que a Jarvis age com permissão própria. Duas travas
compensam:

1. só ferramentas de leitura entram, filtradas em runtime;
2. exige `JARVIS_SERVICE_JWT` explícito. **Sem o segredo, a ronda não roda** —
   falhar visível é melhor que rodar com permissão que ninguém revisou.

## Limites conhecidos

- **A migration `20260907120000_jarvis.sql` ainda não foi aplicada.** Sem ela,
  `jarvis_tool_catalog` não existe, o catálogo volta vazio e a Jarvis responde
  sem ferramenta nenhuma — ou seja, conversa mas não consulta nada.
- `permissions-policy` foi afrouxado de `microphone=()` para `microphone=(self)`
  em `worker/index.ts`. Sem isso o navegador nega o microfone antes de
  perguntar. Continua negado para iframe e terceiros.
- O rollout é por RBAC, não por feature flag: `app/jarvis-voice.tsx` só se
  desenha para `MGMT`. Não é barreira de segurança — o servidor já filtra as
  ferramentas por papel — é só para não expor antes da validação.
- Sem streaming token a token do modelo: a resposta final é quebrada em frases e
  emitida como eventos `token`. Do ponto de vista de quem ouve o efeito é o
  mesmo; do ponto de vista de latência, a primeira frase sai depois que o modelo
  termina, não durante.
- `saudacao_diaria` (substituir o MP3 estático do `daily-greeting-v3`) não foi
  feita. Ficou fora por escopo.
