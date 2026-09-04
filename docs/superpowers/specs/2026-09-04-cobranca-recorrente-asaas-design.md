# Cobrança recorrente e inteligência financeira via Asaas

- **Data:** 2026-09-04
- **Autor:** Adler Furtado (direção) + Claude (desenho)
- **Status:** desenho aprovado, aguardando plano de implementação
- **Escopo:** `agency-ops-dashboard` (frontend + edge functions) e schema `agency_ops`
  do projeto Supabase `imobi-pro` (`bfzdetibfcwihfkltbkp`)

## 1. Problema

A agência cobra ~85 clientes ativos por mensalidade, via boleto, em dia combinado
por contrato. Hoje a emissão é operada à mão no Asaas e a inadimplência é uma
**flag que alguém marca** em `agency_ops.client_operational_status`. Consequências:

1. Um boleto não emitido só aparece 30–40 dias depois, quando alguém estranha.
2. "Inadimplente" reflete a memória de quem marcou, não o fato do pagamento.
3. Não existe série histórica: nenhum MRR mês a mês, nenhuma taxa de
   inadimplência, nenhuma comparação previsto × recebido.

O objetivo é que a cobrança se emita sozinha, que a inadimplência se marque e se
desmarque sozinha, e que exista base para dashboards de evolução.

## 2. Inventário do que já existe (verificado em 2026-09-04)

Metade da fundação está pronta e desligada.

| Objeto | Estado |
|---|---|
| `agency_ops.clients` | 85 `ACTIVE`, 7 `ONBOARDING` |
| `agency_ops.client_commercial_terms` | 81 ativos com `monthly_value`; MRR conhecido **R$ 92.305,00** |
| `agency_ops.client_business_identity` | 78 linhas, **todas com CNPJ ou CPF**; 76 dos 85 ativos têm documento, **76 documentos distintos — zero duplicata** |
| `agency_ops.client_operational_status` | status `inadimplente`/`juridico` com histórico (`since`, `resolved_at`); 6 marcados hoje |
| `agency_ops.client_finance_controls` | **existe com a forma certa** (`payment_status`, `next_due_date`, `overdue_since`, `last_payment_at`, `pause_reason`) e **0 linhas** |
| `app/finance/page.tsx` + `agency-ops-adler-finance-api` | tela e API de termos comerciais, com filtro por status financeiro |
| Integração de pagamento | **nenhuma** — grep por Asaas, Cora, Inter, Iugu, Efí, Vindi, Omie, ContaAzul, Stripe não retorna nada |

Duas consequências que orientam todo o desenho:

- **Não se cria tabela de controle financeiro.** `client_finance_controls` já foi
  modelada corretamente; ela passa a ser *derivada* dos pagamentos reais.
- **O elo com o Asaas é determinístico, não heurístico.** O Asaas guarda
  `cpfCnpj` no customer; 76 clientes ativos têm documento fiscal e todos são
  distintos. O casamento é 1-para-1 por documento normalizado. Os 9 sem
  documento viram fila explícita de resolução manual.

## 3. Decisão de arquitetura

**O Asaas é o dono da recorrência.** Cada contrato ativo corresponde a uma
*assinatura* no Asaas (valor = `monthly_value`, vencimento = dia combinado). O
Asaas emite o boleto, roda a própria régua de cobrança e notifica por webhook.
O dashboard **espelha** os eventos e deriva estado e métricas.

Cobrança avulsa pela mesma via cobre o que não é recorrente: implantação
parcelada (`implementation_value`, `implementation_installments`) e extras.

### Alternativas descartadas

- **Agendador próprio (`pg_cron` cria cobrança avulsa mês a mês).** Daria
  controle fino (pró-rata, desconto pontual, cobrança condicionada à entrega),
  mas transfere pra nós o risco de cobrar duplicado ou esquecer de cobrar, e
  reimplementa a régua de cobrança que o Asaas já entrega pronta. O controle
  fino que importa é preservado pela cobrança avulsa, sem herdar o risco na
  mensalidade.
- **Somente conciliação (seguir emitindo à mão).** Risco zero e entrega rápida,
  mas não resolve o pedido central, que é a emissão automática. A Fase 1 do
  rollout entrega esse valor de qualquer forma, como degrau — não como destino.

### Princípio que não se quebra

**Nenhuma alteração em dinheiro acontece sem aprovação humana explícita.**
Divergência entre contrato e assinatura vira pendência na tela, nunca correção
silenciosa. Emissão automática só existe a partir da Fase 4.

## 4. Modelo de dados

Migration nova em `supabase/migrations`, tudo no schema `agency_ops`.

### `asaas_customers` — o elo

```
client_id            uuid primary key references agency_ops.clients(id)
asaas_customer_id    text not null unique
matched_by           text not null check (matched_by in ('DOCUMENT','MANUAL'))
matched_document     text                    -- documento normalizado usado no match
confirmed_by         text                    -- null = ainda não aprovado
confirmed_at         timestamptz
raw                  jsonb                   -- customer do Asaas como veio
created_at           timestamptz default now()
updated_at           timestamptz default now()
```

Um par com `confirmed_at is null` é **candidato**: aparece na tela de
conciliação e é ignorado por qualquer rotina que emita cobrança.

### `billing_subscriptions` — espelho da assinatura

```
client_id                uuid references agency_ops.clients(id)
asaas_subscription_id    text primary key
value                    numeric(12,2) not null
due_day                  int not null check (due_day between 1 and 31)
cycle                    text not null           -- MONTHLY na prática
status                   text not null           -- ACTIVE | INACTIVE | EXPIRED
billing_type             text                    -- BOLETO | PIX | CREDIT_CARD | UNDEFINED
next_due_date            date
raw                      jsonb
synced_at                timestamptz not null default now()
```

`due_day` **só existe aqui** — não há dia de vencimento em nenhuma tabela hoje.
Ele é descoberto na importação da Fase 1 a partir das assinaturas do Asaas.

### `billing_charges` — a cobrança, fonte da verdade

```
asaas_payment_id         text primary key
client_id                uuid references agency_ops.clients(id)
asaas_subscription_id    text
kind                     text not null check (kind in ('MENSALIDADE','IMPLANTACAO','EXTRA'))
value                    numeric(12,2) not null
net_value                numeric(12,2)
due_date                 date not null
status                   text not null
billing_type             text
paid_at                  timestamptz
payment_date             date
invoice_url              text
bank_slip_url            text
description              text
raw                      jsonb
created_at               timestamptz default now()
updated_at               timestamptz default now()
```

Índices: `(client_id, due_date desc)`, `(status, due_date)`, `(asaas_subscription_id)`.
Todo gráfico e todo indicador saem desta tabela.

`kind` é derivado na ingestão: cobrança ligada a assinatura → `MENSALIDADE`;
avulsa cuja descrição casa com implantação → `IMPLANTACAO`; resto → `EXTRA`.
A regra de classificação fica numa função SQL isolada e testável.

### `billing_webhook_events` — idempotência

```
id             bigserial primary key
asaas_event_id text not null unique          -- garante o "exactly once" lógico
event          text not null
payment_id     text
payload        jsonb not null
received_at    timestamptz not null default now()
processed_at   timestamptz
error          text
```

A constraint `unique` em `asaas_event_id` é o mecanismo central de segurança:
receber o mesmo evento duas vezes, ou reprocessar a fila inteira, **não pode**
duplicar um pagamento. O webhook grava primeiro e processa depois; falha de
processamento deixa `error` preenchido e `processed_at` nulo, para retry.

### `client_finance_controls` — recalculada, não criada

Tabela existente, recalculada após cada evento processado:

- `payment_status` — `CURRENT` | `DUE_SOON` | `OVERDUE` | `DELINQUENT`
- `overdue_since` — `due_date` da cobrança vencida em aberto mais antiga
- `next_due_date` — próximo vencimento em aberto
- `last_payment_at` — pagamento confirmado mais recente
- `monthly_value` — espelho do termo comercial vigente

**O vocabulário é o que a tabela já impõe, não um novo.** A
`client_finance_controls` tem CHECK constraint com
`UNKNOWN | CURRENT | DUE_SOON | OVERDUE | NEGOTIATING | PAID | CANCELLED` em
`payment_status`, e `RELEASED | PAUSE_REQUESTED | PAUSED` em
`operational_status`. Usamos `CURRENT`, `DUE_SOON` e `OVERDUE` como já existem
e **acrescentamos `DELINQUENT`** ao check, para separar o atraso curto (D+1 a
D+4) da inadimplência (D+5 ou mais) — distinção que a agência precisa e o
vocabulário atual não tem. `NEGOTIATING`, `PAID` e `CANCELLED` continuam
disponíveis para marcação manual; o sistema não os escreve.

**Pausa é eixo separado.** Cliente pausado não é um estado de pagamento: vive
em `operational_status = 'PAUSED'`, que já existe. A derivação de
`payment_status` ignora pausa; quem lê a tela é que combina os dois.

### RLS

Todas as tabelas novas nascem com `enable row level security` e **nenhuma
policy** — acesso exclusivo por `service_role`, ou seja, só pelas edge
functions. A chave `anon` nunca alcança dado financeiro. Isso é deliberadamente
o oposto do problema aberto das 9 tabelas sem RLS no `public` do mesmo projeto.

## 5. Fluxos

### 5.1 Recebimento — `agency-ops-asaas-webhook`

Edge function sem JWT (o Asaas não carrega token de usuário), autenticada pelo
header `asaas-access-token` comparado com o secret `ASAAS_WEBHOOK_TOKEN`. Mesmo
padrão já usado em `CLICKUP_WEBHOOK_SECRET` e `META_CAMPAIGN_SYNC_SECRET`.

1. Valida o token. Token errado → `404`, sem corpo informativo.
2. Insere em `billing_webhook_events`. Conflito no `asaas_event_id` → responde
   `200` e encerra (evento repetido é sucesso, não erro).
3. Faz upsert em `billing_charges` a partir do payload.
4. Chama `recalc_client_finance_controls` do cliente afetado.
5. Espelha o resultado para `client_operational_status` (§5.3).
6. Marca `processed_at`. Sempre responde `200` quando o evento foi persistido —
   erro de processamento fica na fila com `error`, não devolve 5xx ao Asaas.

Eventos relevantes: criação, confirmação, recebimento, vencimento, estorno,
exclusão e restauração de cobrança. **A lista canônica de nomes de evento e de
`status` é conferida contra a documentação oficial do Asaas como primeira tarefa
da Fase 0** — o desenho não depende dos nomes exatos, mas o código depende.

### 5.2 Reconciliação — cron diário

`pg_cron` (o schema já roda ~15 jobs; segue a convenção de nome
`agency_ops_*`). Para cada cliente `ACTIVE` com termo comercial e elo
**confirmado**, compara contrato × assinatura e classifica:

- assinatura ausente → pendência `ASSINATURA_FALTANDO`
- valor divergente → pendência `VALOR_DIVERGENTE` (com os dois valores)
- assinatura ativa para cliente já em `saida` → pendência `ASSINATURA_ORFA`

Pendência é registro para a tela. O cron **nunca cria, altera ou cancela**
cobrança ou assinatura.

### 5.3 Derivação da inadimplência

Cortes (configuráveis, com estes defaults aprovados):

- `CURRENT` — nada vencido em aberto
- `DUE_SOON` — próximo vencimento em aberto dentro de 3 dias
- `OVERDUE` — cobrança vencida em aberto há 1 a 4 dias
- `DELINQUENT` — cobrança vencida em aberto há **5 dias ou mais**

Pausa não aparece nesta lista: é `operational_status = 'PAUSED'`, eixo próprio.

**A derivação precisa de dois gatilhos, não de um.** O gatilho por evento (§5.1)
não basta, e essa é a correção mais importante feita a este desenho: o Asaas emite
`PAYMENT_OVERDUE` **uma única vez, em D+1**. Se a derivação só rodar quando chega
evento, nada acontece em D+5 — a linha de controle segue dizendo `OVERDUE` enquanto
o cliente está 5, 20 ou 40 dias atrasado, até que um evento não relacionado apareça.
A tela de inadimplentes ficaria **vazia enquanto há gente devendo**, e a falha parece
boa notícia.

Portanto: além do recálculo disparado por evento, um **`pg_cron` diário** reexecuta a
derivação para todo cliente com cobrança em aberto. Os dois gatilhos chamam a mesma
função pura; o tempo é apenas a segunda razão para chamá-la. Sem o gatilho diário,
nenhum valor de `payment_status` é confiável.

`DELINQUENT` espelha para `client_operational_status` chamando a
`set_client_financial_legal_status` existente, com `p_actor = 'SISTEMA'`. Assim
a tela atual, o histórico `since`/`resolved_at` e as notificações continuam
funcionando sem alteração. O status `juridico` **permanece decisão humana** e
nunca é tocado pelo sistema.

## 6. Views e indicadores

Views SQL sobre `billing_charges` — nenhum cálculo financeiro no frontend.

- `billing_monthly_evolution` — por mês: previsto, recebido, em aberto, vencido,
  nº de cobranças, ticket médio
- `billing_weekly_current_month` — mesma quebra por semana do mês corrente
- `billing_delinquency` — por cliente inadimplente: valor total em aberto, dias
  do atraso mais antigo, nº de cobranças vencidas, link do boleto mais recente
- `billing_mrr_movement` — MRR do mês e a quebra novo / expansão / contração /
  churn, comparando termos vigentes mês a mês
- `billing_payment_behavior` — por cliente: atraso médio em dias e tempo médio
  entre vencimento e pagamento (sinal antecedente de churn)

## 7. Telas

`app/finance` ganha abas, consumindo uma nova edge function
`agency-ops-billing-api`. **Visível apenas para Adler e Leonardo** — regra
detalhada em §8; o item de menu só é desenhado depois que o servidor confirma
a autorização.

1. **Cobranças do mês** — cliente, valor, vencimento, status, link do boleto;
   filtro por status e por responsável.
2. **Inadimplentes** — quem deve, há quantos dias, quanto, ordenado por
   dias × valor. Entrega direta do pedido original.
3. **Evolução** — MRR mês a mês, previsto × recebido, taxa de inadimplência %,
   e a visão semanal do mês corrente.
4. **Conciliação** — os pares candidatos para aprovar, e os clientes sem
   documento ou sem elo. Some quando estiver zerada.

## 8. Segurança e acesso

`agency-ops-billing-api` replica a autorização do
`agency-ops-adler-finance-api`, que é o padrão do repo:

Bearer → `auth.getUser()` → `user_preferences.collaborator_person` →
`access_requests` com `kind='SIGNUP'` e `status='APPROVED'` → `team_roster`
(`is_former = false`) → allowlist: `Adler Furtado` (MGMT) e `Leonardo Augusto`
(COMMERCIAL). Não autorizado recebe **`404`**, não `403` — a rota não revela
que existe.

**Nenhum outro perfil vê esta área.** Requisito explícito do Adler
(2026-09-04): a área financeira aparece para ele e para o Leonardo, e para mais
ninguém. Isso vale em três camadas, e as três são obrigatórias:

1. **Menu.** O item de navegação segue o padrão do
   `adler-finance-nav-bridge.tsx`: o bridge chama `?probe=1` na
   `agency-ops-billing-api` e **só insere o botão no DOM se o servidor
   autorizar**. Resposta não-ok, sessão ausente ou troca de usuário removem o
   botão imediatamente (`removeFinanceNav`). O cliente nunca decide sozinho
   quem vê.
2. **Rota.** `/finance` sem autorização não renderiza dado — a API responde
   `404` e a tela mostra indisponibilidade, como já faz a
   `app/finance/page.tsx` hoje. Acessar a URL na mão não contorna nada.
3. **Dado.** As tabelas novas não têm policy de RLS: mesmo com a chave `anon`
   em mãos, não há leitura possível fora do `service_role`.

A allowlist existe em **um lugar só**, dentro da edge function. Ela não é
duplicada no frontend, não vira variável de ambiente e não vira `if` em
componente — senão passam a existir duas verdades sobre quem pode ver dinheiro,
e uma delas vai ficar desatualizada.

Adler e Leonardo recebem o **mesmo escopo** (carteira inteira), que é o que já
vale hoje no `agency-ops-adler-finance-api`. Se em algum momento o Leonardo
tiver de ver só a carteira dele, o ponto de mudança é a montagem da query na
API — não a autorização.

### Segredos (ação do Adler)

| Secret | Uso |
|---|---|
| `ASAAS_API_KEY` | chamadas à API do Asaas |
| `ASAAS_WEBHOOK_TOKEN` | valida o header `asaas-access-token` do webhook |
| `ASAAS_ENV` | `sandbox` ou `production` |

**Adler gera e cola os três nos secrets do Supabase.** O restante — código,
migration, teste, documentação e rollback — é entregue pronto.

## 9. Rollout

Cada fase tem critério de saída. Não se avança sem ele.

**Fase 0 — Sandbox.** Migration, webhook, cliente da API e ingestão contra o
sandbox do Asaas. *Saída:* um ciclo simulado (criar → vencer → pagar) refletido
corretamente em `billing_charges` e `client_finance_controls`.

**Fase 1 — Observação em produção.** Chave de produção usada **apenas para
leitura**: importa customers, assinaturas e cobranças existentes, preenche as
tabelas e liga os dashboards. Nenhum caminho de código capaz de emitir está
habilitado. *Saída:* o MRR calculado a partir do Asaas é **comparado** com os
R$ 92.305,00 dos termos comerciais, e a lista de inadimplentes derivada é
comparada com os 6 marcados à mão hoje. Divergência aqui é informação, não
erro — mas cada uma precisa ser explicada antes de avançar. Não se exige
igualdade; exige-se que nenhuma diferença fique sem causa conhecida.

Esta fase também responde uma pergunta em aberto: **se hoje já existem
assinaturas recorrentes no Asaas ou se a emissão é avulsa mês a mês.** O
desenho serve aos dois casos; o volume de trabalho da Fase 3 depende da
resposta.

**Fase 2 — Conciliação do elo.** Tela para aprovar os pares casados por
documento — **no máximo 76**, e só os que tiverem customer correspondente no
Asaas — e resolver os 9 clientes ativos sem documento fiscal. Dos 85 ativos, 75
têm documento **e** mensalidade definida, que é a população de fato elegível.
*Saída:* todo cliente `ACTIVE` com mensalidade tem elo confirmado, ou uma
justificativa registrada para não ter.

**Fase 3 — Emissão assistida.** As pendências do §5.2 ganham botão de aprovação:
criar a assinatura que falta, ajustar o valor divergente. Uma a uma, com
confirmação. *Saída:* um mês inteiro fechando sem pendência inesperada.

**Fase 4 — Automático.** Só depois da Fase 3 fechar um ciclo completo.

## 10. Fora de escopo (YAGNI)

- Emissão de nota fiscal — o Asaas oferece, mas envolve o contador; projeto próprio.
- Cobrança por cartão de crédito ou split — não é como a agência cobra hoje.
- Régua de cobrança própria (e-mail/WhatsApp de aviso) — a do Asaas já existe e
  é configurada lá; reimplementar aqui é trabalho duplicado com risco de mandar
  mensagem errada para cliente real.
- Conciliação bancária de extrato — o webhook do Asaas já dá o fato do pagamento.
- Previsão de churn ou score de risco — `billing_payment_behavior` entrega o
  dado bruto; modelo em cima disso é outro projeto.

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Elo errado → cobrar cliente errado | Elo por documento fiscal (76 distintos, zero duplicata) + aprovação humana obrigatória antes de qualquer emissão |
| Evento duplicado → pagamento contado duas vezes | `asaas_event_id` único, upsert por `asaas_payment_id` |
| Divergência silenciosa contrato × Asaas | Cron diário que só reporta; toda correção é aprovada na tela |
| 9 clientes ativos sem documento fiscal | Fila visível na aba de conciliação; bloqueiam a saída da Fase 2 |
| Dado financeiro exposto | RLS ligada sem policy; só `service_role`; API com allowlist e 404 |
| Área financeira vazando para outro perfil | Menu desenhado só após `probe` do servidor; rota sem dado sem autorização; allowlist em um único lugar (§8) |
| Sessão paralela de IA no mesmo repo | `git fetch` e conferir `HEAD..origin/main` antes de cada etapa; commit isolado por assunto e push imediato |

## 12. Critérios de sucesso

1. A pergunta "quem está devendo, quanto e há quantos dias" é respondida por uma
   tela, a partir do pagamento real, sem ninguém ter marcado nada.
2. `client_finance_controls` deixa de estar vazia e reflete o Asaas.
3. Existe série histórica mensal e semanal de previsto × recebido e de
   inadimplência.
4. Nenhuma cobrança é emitida, alterada ou cancelada sem aprovação humana até a
   Fase 4.
