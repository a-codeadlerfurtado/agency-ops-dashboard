# Cobrança Asaas — Fundação Local Testável (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir e testar localmente toda a lógica de cobrança que não depende de chave, deploy ou banco de produção — deixando migration e webhook prontos para o Adler disparar quando decidir.

**Architecture:** A lógica que decide dinheiro (normalização de documento fiscal, match cliente ↔ customer do Asaas, classificação da cobrança, mapeamento do payload e derivação da inadimplência) sai de dentro do runtime Deno e vira módulos TypeScript puros em `supabase/functions/_shared/billing/`, sem nenhum import de `Deno`, `jsr:` ou `npm:`. Esses módulos rodam sob vitest no Node. A edge function `agency-ops-asaas-webhook` fica sendo uma casca fina que faz HTTP → módulo puro → Supabase. A migration é escrita e revisada, **não aplicada**.

**Tech Stack:** TypeScript, vitest (novo devDependency), Deno (edge functions, não executável nesta máquina), Postgres/Supabase (schema `agency_ops`, não tocado).

**Spec:** `docs/superpowers/specs/2026-09-04-cobranca-recorrente-asaas-design.md`

## Global Constraints

Valem para **todas** as tarefas. Violação é falha da tarefa, não detalhe.

- **Nada é publicado.** Proibido nesta execução: `git push`, `wrangler deploy`, `supabase functions deploy`, e qualquer aplicação de migration ou DDL no projeto `bfzdetibfcwihfkltbkp`. Commits **locais** são esperados e desejados.
- **Nada de escrita em produção.** Nenhuma tarefa executa `INSERT`, `UPDATE`, `DELETE` ou DDL via MCP do Supabase. Leitura só se for estritamente necessária para conferir schema.
- **Ferramentas ausentes na máquina:** `deno`, `supabase`, `docker`, `psql`. Disponíveis: `node` v26.5.0, `npm` 11.17.0, `npx`, `wrangler` 4.129.0, `git`. Nenhum passo pode depender das ausentes.
- **Módulos puros são puros.** Arquivos em `supabase/functions/_shared/billing/` não podem importar `Deno`, `jsr:*`, `npm:*` nem tocar rede, relógio ou ambiente. Se precisa saber a data de hoje, ela **entra como parâmetro**.
- **Imports com extensão `.ts` explícita** (`from "./document.ts"`). O Deno exige; o Vite aceita. Sem extensão, quebra em produção e passa no teste — o pior dos dois mundos.
- **Fuso horário:** `America/Sao_Paulo`. Nenhuma função pura chama `new Date()` sem argumento. A data de referência é sempre recebida como string `YYYY-MM-DD`.
- **Cortes de inadimplência:** `OVERDUE` = vencido há 1 a 4 dias; `DELINQUENT` = vencido há **5 dias ou mais**. Valores configuráveis, com estes defaults.
- **Sessão paralela de IA no mesmo repo:** antes de cada commit, rodar `git fetch` e conferir `git log --oneline HEAD..origin/main`. Commit isolado por assunto.
- **Fail closed.** Toda checagem de autorização nega quando o segredo está ausente ou vazio. Nunca o contrário.

## Escopo deste plano

Este plano cobre a **Fase 0** do spec (§9) e a fundação da Fase 1. Fica **fora**, para um segundo plano, tudo que exige publicação: importação real do Asaas, telas do dashboard, cron de reconciliação e as fases 2 a 4. O critério é objetivo: se o passo precisa de chave, deploy ou banco, não entra aqui.

Fica de fora **de propósito**, e não por esquecimento, mais uma coisa: o
espelhamento de `DELINQUENT` para `agency_ops.client_operational_status` via
`set_client_financial_legal_status` (spec §5.3). Ele escreve numa tabela que a
tela de hoje já lê e que dispara notificação — ligar isso antes de a
inadimplência derivada ter sido conferida contra os 6 marcados à mão faria o
sistema contradizer a operação em produção. Entra no plano da Fase 1, depois da
conferência.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `vitest.config.ts` | Criar. Runner, aponta para `tests/`. |
| `supabase/functions/_shared/billing/types.ts` | Criar. Tipos compartilhados. Sem lógica. |
| `supabase/functions/_shared/billing/document.ts` | Criar. Normalizar CNPJ/CPF e casar clientes com customers. |
| `supabase/functions/_shared/billing/charge-kind.ts` | Criar. Classificar `MENSALIDADE` / `IMPLANTACAO` / `EXTRA`. |
| `supabase/functions/_shared/billing/charge-mapper.ts` | Criar. Payload do Asaas → linha de `billing_charges`. |
| `supabase/functions/_shared/billing/payment-status.ts` | Criar. Derivar inadimplência. O coração. |
| `supabase/functions/_shared/billing/webhook-auth.ts` | Criar. Validar o token do webhook. |
| `tests/billing/*.test.ts` | Criar. Um arquivo por módulo. |
| `supabase/migrations/20260904120000_billing_asaas_foundation.sql` | Criar. **Escrita, não aplicada.** |
| `supabase/functions/agency-ops-asaas-webhook/index.ts` | Criar. Casca HTTP. Não deployada. |

---

### Task 1: Runner de teste e normalização de documento fiscal

Sem isto nada mais é testável. A normalização é o alicerce do elo: um documento mal normalizado casa o cliente errado, e cliente errado é boleto na mão de quem não deve.

**Files:**
- Create: `vitest.config.ts`
- Create: `supabase/functions/_shared/billing/document.ts`
- Test: `tests/billing/document.test.ts`
- Modify: `package.json` (devDependency + script `test`)

**Interfaces:**
- Consumes: nada.
- Produces: `normalizeDocument(value: string | null | undefined): string | null`

- [ ] **Step 1: Instalar o vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: Confirmar que o vite não foi rebaixado**

Run: `npm ls vite`
Expected: `vite@8.2.1` continua na árvore. Se o npm tiver trocado a major do vite, desfazer (`git checkout package.json package-lock.json`), reinstalar com `npm install -D vitest --legacy-peer-deps` e conferir de novo. O build do projeto depende do vite 8.

- [ ] **Step 3: Criar o `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Adicionar o script de teste**

Em `package.json`, dentro de `"scripts"`, ao lado de `"typecheck"`:

```json
"test": "vitest run"
```

- [ ] **Step 5: Escrever o teste que falha**

Criar `tests/billing/document.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeDocument } from "../../supabase/functions/_shared/billing/document.ts";

describe("normalizeDocument", () => {
  it("remove pontuacao de CNPJ", () => {
    expect(normalizeDocument("12.345.678/0001-95")).toBe("12345678000195");
  });

  it("remove pontuacao de CPF", () => {
    expect(normalizeDocument("123.456.789-09")).toBe("12345678909");
  });

  it("aceita documento ja limpo", () => {
    expect(normalizeDocument("12345678000195")).toBe("12345678000195");
  });

  it("devolve null para vazio, nulo e indefinido", () => {
    expect(normalizeDocument("")).toBeNull();
    expect(normalizeDocument("   ")).toBeNull();
    expect(normalizeDocument(null)).toBeNull();
    expect(normalizeDocument(undefined)).toBeNull();
  });

  it("devolve null para comprimento invalido", () => {
    expect(normalizeDocument("123")).toBeNull();
    expect(normalizeDocument("123456789012345")).toBeNull();
  });

  it("devolve null quando so ha pontuacao", () => {
    expect(normalizeDocument("../-.")).toBeNull();
  });
});
```

- [ ] **Step 6: Rodar o teste e confirmar que falha**

Run: `npm test`
Expected: FAIL — o módulo `document.ts` não existe ainda.

- [ ] **Step 7: Implementar o mínimo**

Criar `supabase/functions/_shared/billing/document.ts`:

```ts
/** Normaliza CNPJ (14) ou CPF (11) para so digitos. Devolve null se nao for nenhum dos dois. */
export function normalizeDocument(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) return null;
  return digits;
}
```

- [ ] **Step 8: Rodar o teste e confirmar que passa**

Run: `npm test`
Expected: PASS — 6 testes.

- [ ] **Step 9: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add package.json package-lock.json vitest.config.ts supabase/functions/_shared/billing/document.ts tests/billing/document.test.ts
git commit -m "test: vitest e normalizacao de documento fiscal para o elo Asaas"
```

---

### Task 2: Match determinístico entre cliente e customer do Asaas

Aqui mora o risco mais caro do projeto. A regra que importa não é casar — é **recusar-se a casar quando há ambiguidade**. Dois clientes com o mesmo CNPJ, ou dois customers com o mesmo, não podem virar um par automático.

**Files:**
- Create: `supabase/functions/_shared/billing/types.ts`
- Modify: `supabase/functions/_shared/billing/document.ts`
- Test: `tests/billing/match.test.ts`

**Interfaces:**
- Consumes: `normalizeDocument` da Task 1.
- Produces:
  - `matchClientsToCustomers(clients: ClientDocument[], customers: AsaasCustomer[]): MatchResult`
  - Tipos `ClientDocument`, `AsaasCustomer`, `MatchedPair`, `AmbiguousDocument`, `MatchResult` em `types.ts`.

- [ ] **Step 1: Criar os tipos**

Criar `supabase/functions/_shared/billing/types.ts`:

```ts
export type ChargeKind = "MENSALIDADE" | "IMPLANTACAO" | "EXTRA";
/**
 * Vocabulario imposto pelo CHECK de agency_ops.client_finance_controls.
 * CURRENT, DUE_SOON e OVERDUE ja existem no banco; DELINQUENT e acrescentado
 * pela migration da Task 7. Nao inventar valores: o insert falha.
 */
export type PaymentStatus = "CURRENT" | "DUE_SOON" | "OVERDUE" | "DELINQUENT";

export interface ClientDocument {
  client_id: string;
  document: string | null;
}

export interface AsaasCustomer {
  asaas_customer_id: string;
  cpfCnpj: string | null;
}

export interface MatchedPair {
  client_id: string;
  asaas_customer_id: string;
  matched_document: string;
}

export interface AmbiguousDocument {
  document: string;
  client_ids: string[];
  asaas_customer_ids: string[];
}

export interface MatchResult {
  matched: MatchedPair[];
  ambiguous: AmbiguousDocument[];
  clients_without_document: string[];
  clients_without_customer: string[];
  customers_without_client: string[];
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/billing/match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchClientsToCustomers } from "../../supabase/functions/_shared/billing/document.ts";

const CNPJ_A = "12345678000195";
const CNPJ_B = "98765432000112";

describe("matchClientsToCustomers", () => {
  it("casa cliente e customer pelo documento, ignorando pontuacao", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: "12.345.678/0001-95" }],
      [{ asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A }],
    );
    expect(result.matched).toEqual([
      { client_id: "c1", asaas_customer_id: "cus_1", matched_document: CNPJ_A },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("NAO casa quando dois clientes dividem o mesmo documento", () => {
    const result = matchClientsToCustomers(
      [
        { client_id: "c1", document: CNPJ_A },
        { client_id: "c2", document: CNPJ_A },
      ],
      [{ asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A }],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { document: CNPJ_A, client_ids: ["c1", "c2"], asaas_customer_ids: ["cus_1"] },
    ]);
  });

  it("NAO casa quando dois customers dividem o mesmo documento", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: CNPJ_A }],
      [
        { asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A },
        { asaas_customer_id: "cus_2", cpfCnpj: CNPJ_A },
      ],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous[0].asaas_customer_ids).toEqual(["cus_1", "cus_2"]);
  });

  it("separa cliente sem documento de cliente sem customer", () => {
    const result = matchClientsToCustomers(
      [
        { client_id: "sem_doc", document: null },
        { client_id: "sem_cus", document: CNPJ_B },
      ],
      [],
    );
    expect(result.clients_without_document).toEqual(["sem_doc"]);
    expect(result.clients_without_customer).toEqual(["sem_cus"]);
  });

  it("lista customer do Asaas que nao corresponde a nenhum cliente", () => {
    const result = matchClientsToCustomers([], [{ asaas_customer_id: "cus_9", cpfCnpj: CNPJ_B }]);
    expect(result.customers_without_client).toEqual(["cus_9"]);
  });

  it("trata documento invalido do Asaas como ausente", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: CNPJ_A }],
      [{ asaas_customer_id: "cus_1", cpfCnpj: "123" }],
    );
    expect(result.matched).toEqual([]);
    expect(result.clients_without_customer).toEqual(["c1"]);
    expect(result.customers_without_client).toEqual(["cus_1"]);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/billing/match.test.ts`
Expected: FAIL — `matchClientsToCustomers` não é exportada.

- [ ] **Step 4: Implementar**

Em `supabase/functions/_shared/billing/document.ts`: o bloco `import type` vai
no **topo do arquivo**, acima de `normalizeDocument`; a função nova vai no fim.
Import no meio ou no fim funciona em ESM, mas ninguém lê arquivo assim.

```ts
import type {
  AmbiguousDocument,
  AsaasCustomer,
  ClientDocument,
  MatchResult,
  MatchedPair,
} from "./types.ts";

/**
 * Casa clientes e customers do Asaas pelo documento fiscal normalizado.
 * Um documento com mais de um cliente OU mais de um customer nunca vira par:
 * vai para `ambiguous` e exige decisao humana.
 */
export function matchClientsToCustomers(
  clients: ClientDocument[],
  customers: AsaasCustomer[],
): MatchResult {
  const clientsByDoc = new Map<string, string[]>();
  const clients_without_document: string[] = [];

  for (const client of clients) {
    const doc = normalizeDocument(client.document);
    if (!doc) {
      clients_without_document.push(client.client_id);
      continue;
    }
    const bucket = clientsByDoc.get(doc);
    if (bucket) bucket.push(client.client_id);
    else clientsByDoc.set(doc, [client.client_id]);
  }

  const customersByDoc = new Map<string, string[]>();
  const customers_without_client: string[] = [];

  for (const customer of customers) {
    const doc = normalizeDocument(customer.cpfCnpj);
    if (!doc) {
      customers_without_client.push(customer.asaas_customer_id);
      continue;
    }
    const bucket = customersByDoc.get(doc);
    if (bucket) bucket.push(customer.asaas_customer_id);
    else customersByDoc.set(doc, [customer.asaas_customer_id]);
  }

  const matched: MatchedPair[] = [];
  const ambiguous: AmbiguousDocument[] = [];
  const clients_without_customer: string[] = [];

  for (const [document, client_ids] of clientsByDoc) {
    const asaas_customer_ids = customersByDoc.get(document) || [];
    if (asaas_customer_ids.length === 0) {
      clients_without_customer.push(...client_ids);
      continue;
    }
    if (client_ids.length > 1 || asaas_customer_ids.length > 1) {
      ambiguous.push({ document, client_ids, asaas_customer_ids });
      continue;
    }
    matched.push({
      client_id: client_ids[0],
      asaas_customer_id: asaas_customer_ids[0],
      matched_document: document,
    });
  }

  for (const [document, asaas_customer_ids] of customersByDoc) {
    if (!clientsByDoc.has(document)) customers_without_client.push(...asaas_customer_ids);
  }

  return {
    matched,
    ambiguous,
    clients_without_document,
    clients_without_customer,
    customers_without_client,
  };
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — 12 testes no total (6 da Task 1 + 6 desta).

- [ ] **Step 6: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/_shared/billing/types.ts supabase/functions/_shared/billing/document.ts tests/billing/match.test.ts
git commit -m "feat: match deterministico cliente-customer do Asaas, ambiguidade nunca casa sozinha"
```

---

### Task 3: Classificação da cobrança

`kind` decide em que gráfico o dinheiro entra. Implantação contada como mensalidade infla o MRR e mente sobre a saúde da carteira.

**Files:**
- Create: `supabase/functions/_shared/billing/charge-kind.ts`
- Test: `tests/billing/charge-kind.test.ts`

**Interfaces:**
- Consumes: tipo `ChargeKind` de `types.ts`.
- Produces: `classifyChargeKind(input: { subscriptionId: string | null; description: string | null }): ChargeKind`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/billing/charge-kind.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyChargeKind } from "../../supabase/functions/_shared/billing/charge-kind.ts";

describe("classifyChargeKind", () => {
  it("cobranca ligada a assinatura e mensalidade", () => {
    expect(classifyChargeKind({ subscriptionId: "sub_1", description: "qualquer coisa" }))
      .toBe("MENSALIDADE");
  });

  it("assinatura vence a descricao de implantacao", () => {
    expect(classifyChargeKind({ subscriptionId: "sub_1", description: "Implantacao" }))
      .toBe("MENSALIDADE");
  });

  it("avulsa com descricao de implantacao", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "Implantacao parcela 1/3" }))
      .toBe("IMPLANTACAO");
  });

  it("reconhece implantacao sem acento e com caixa alta", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "IMPLANTAÇÃO INICIAL" }))
      .toBe("IMPLANTACAO");
    expect(classifyChargeKind({ subscriptionId: null, description: "setup do projeto" }))
      .toBe("IMPLANTACAO");
    expect(classifyChargeKind({ subscriptionId: null, description: "Taxa de implementacao" }))
      .toBe("IMPLANTACAO");
  });

  it("avulsa sem palavra-chave e extra", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "Trafego adicional" }))
      .toBe("EXTRA");
  });

  it("avulsa sem descricao e extra", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: null })).toBe("EXTRA");
    expect(classifyChargeKind({ subscriptionId: "", description: "" })).toBe("EXTRA");
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/billing/charge-kind.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

Criar `supabase/functions/_shared/billing/charge-kind.ts`:

```ts
import type { ChargeKind } from "./types.ts";

const IMPLANTACAO = /implanta|implementa|setup/;

/** Remove acentos e baixa a caixa, para a comparacao nao depender de como foi digitado. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Cobranca ligada a assinatura e sempre mensalidade — o vinculo e mais
 * confiavel que qualquer texto livre digitado por gente.
 */
export function classifyChargeKind(input: {
  subscriptionId: string | null;
  description: string | null;
}): ChargeKind {
  if (input.subscriptionId) return "MENSALIDADE";
  const description = input.description ? fold(input.description) : "";
  if (IMPLANTACAO.test(description)) return "IMPLANTACAO";
  return "EXTRA";
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — 18 testes.

- [ ] **Step 5: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/_shared/billing/charge-kind.ts tests/billing/charge-kind.test.ts
git commit -m "feat: classifica cobranca em mensalidade, implantacao e extra"
```

---

### Task 4: Mapeamento do payload do Asaas para `billing_charges`

**Files:**
- Create: `supabase/functions/_shared/billing/charge-mapper.ts`
- Modify: `supabase/functions/_shared/billing/types.ts`
- Test: `tests/billing/charge-mapper.test.ts`

**Interfaces:**
- Consumes: `classifyChargeKind` da Task 3.
- Produces:
  - `mapAsaasPaymentToCharge(payment: AsaasPayment, clientId: string | null): BillingChargeRow`
  - Tipos `AsaasPayment` e `BillingChargeRow` em `types.ts`.

- [ ] **Step 1: Acrescentar os tipos**

Acrescentar a `supabase/functions/_shared/billing/types.ts`:

```ts
export interface AsaasPayment {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  value?: number | string | null;
  netValue?: number | string | null;
  dueDate?: string | null;
  status?: string | null;
  billingType?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  description?: string | null;
}

export interface BillingChargeRow {
  asaas_payment_id: string;
  client_id: string | null;
  asaas_subscription_id: string | null;
  kind: ChargeKind;
  value: number;
  net_value: number | null;
  due_date: string;
  status: string;
  billing_type: string | null;
  payment_date: string | null;
  invoice_url: string | null;
  bank_slip_url: string | null;
  description: string | null;
  raw: unknown;
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/billing/charge-mapper.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapAsaasPaymentToCharge } from "../../supabase/functions/_shared/billing/charge-mapper.ts";

const PAGAMENTO = {
  id: "pay_123",
  customer: "cus_1",
  subscription: "sub_1",
  value: 1200.5,
  netValue: 1180.2,
  dueDate: "2026-09-10",
  status: "RECEIVED",
  billingType: "BOLETO",
  paymentDate: "2026-09-09",
  invoiceUrl: "https://asaas.com/i/123",
  bankSlipUrl: "https://asaas.com/b/123",
  description: "Mensalidade setembro",
};

describe("mapAsaasPaymentToCharge", () => {
  it("mapeia os campos e classifica como mensalidade", () => {
    const row = mapAsaasPaymentToCharge(PAGAMENTO, "c1");
    expect(row.asaas_payment_id).toBe("pay_123");
    expect(row.client_id).toBe("c1");
    expect(row.asaas_subscription_id).toBe("sub_1");
    expect(row.kind).toBe("MENSALIDADE");
    expect(row.value).toBe(1200.5);
    expect(row.net_value).toBe(1180.2);
    expect(row.due_date).toBe("2026-09-10");
    expect(row.status).toBe("RECEIVED");
    expect(row.payment_date).toBe("2026-09-09");
  });

  it("aceita valor como string, que e o que a API devolve as vezes", () => {
    const row = mapAsaasPaymentToCharge({ ...PAGAMENTO, value: "1200.50", netValue: "1180.20" }, "c1");
    expect(row.value).toBe(1200.5);
    expect(row.net_value).toBe(1180.2);
  });

  it("client_id nulo e permitido: a cobranca chega antes do elo existir", () => {
    expect(mapAsaasPaymentToCharge(PAGAMENTO, null).client_id).toBeNull();
  });

  it("normaliza ausencia para null em vez de string vazia", () => {
    const row = mapAsaasPaymentToCharge(
      { id: "pay_9", dueDate: "2026-09-10", status: "PENDING", value: 100, subscription: "", description: "" },
      null,
    );
    expect(row.asaas_subscription_id).toBeNull();
    expect(row.description).toBeNull();
    expect(row.net_value).toBeNull();
    expect(row.billing_type).toBeNull();
    expect(row.kind).toBe("EXTRA");
  });

  it("usa confirmedDate quando paymentDate nao veio", () => {
    const row = mapAsaasPaymentToCharge(
      { ...PAGAMENTO, paymentDate: null, clientPaymentDate: null, confirmedDate: "2026-09-08" },
      "c1",
    );
    expect(row.payment_date).toBe("2026-09-08");
  });

  it("preserva o payload inteiro em raw", () => {
    expect(mapAsaasPaymentToCharge(PAGAMENTO, "c1").raw).toEqual(PAGAMENTO);
  });

  it("recusa pagamento sem id ou sem vencimento", () => {
    expect(() => mapAsaasPaymentToCharge({ ...PAGAMENTO, id: "" }, "c1")).toThrow("asaas_payment_id");
    expect(() => mapAsaasPaymentToCharge({ ...PAGAMENTO, dueDate: null }, "c1")).toThrow("due_date");
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/billing/charge-mapper.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 4: Implementar**

Criar `supabase/functions/_shared/billing/charge-mapper.ts`:

```ts
import { classifyChargeKind } from "./charge-kind.ts";
import type { AsaasPayment, BillingChargeRow } from "./types.ts";

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered ? rendered : null;
}

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapAsaasPaymentToCharge(
  payment: AsaasPayment,
  clientId: string | null,
): BillingChargeRow {
  const asaas_payment_id = text(payment.id);
  if (!asaas_payment_id) throw new Error("asaas_payment_id ausente no payload");

  const due_date = text(payment.dueDate);
  if (!due_date) throw new Error("due_date ausente no payload");

  const asaas_subscription_id = text(payment.subscription);
  const description = text(payment.description);
  const value = money(payment.value);

  return {
    asaas_payment_id,
    client_id: clientId,
    asaas_subscription_id,
    kind: classifyChargeKind({ subscriptionId: asaas_subscription_id, description }),
    value: value === null ? 0 : value,
    net_value: money(payment.netValue),
    due_date,
    status: text(payment.status) || "UNKNOWN",
    billing_type: text(payment.billingType),
    payment_date:
      text(payment.paymentDate) || text(payment.clientPaymentDate) || text(payment.confirmedDate),
    invoice_url: text(payment.invoiceUrl),
    bank_slip_url: text(payment.bankSlipUrl),
    description,
    raw: payment,
  };
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — 25 testes.

- [ ] **Step 6: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/_shared/billing/charge-mapper.ts supabase/functions/_shared/billing/types.ts tests/billing/charge-mapper.test.ts
git commit -m "feat: mapeia pagamento do Asaas para a linha de billing_charges"
```

---

### Task 5: Derivação da inadimplência

O coração do sistema. É esta função que substitui a flag que alguém marca à mão. Ela é pura de propósito: recebe as cobranças e a data de hoje, e não consulta relógio nem banco — assim um caso real que der errado vira teste em dois minutos.

**Files:**
- Create: `supabase/functions/_shared/billing/payment-status.ts`
- Modify: `supabase/functions/_shared/billing/types.ts`
- Test: `tests/billing/payment-status.test.ts`

**Interfaces:**
- Consumes: tipo `PaymentStatus` de `types.ts`.
- Produces:
  - `derivePaymentStatus(input: DeriveStatusInput): DerivedFinanceControl`
  - Tipos `ChargeSnapshot`, `DeriveStatusInput`, `DerivedFinanceControl` em `types.ts`.

- [ ] **Step 1: Acrescentar os tipos**

Acrescentar a `supabase/functions/_shared/billing/types.ts`:

```ts
export interface ChargeSnapshot {
  due_date: string;
  status: string;
  payment_date: string | null;
}

export interface DeriveStatusInput {
  charges: ChargeSnapshot[];
  today: string;
  /** Dias de atraso a partir dos quais o cliente e DELINQUENT. Default 5. */
  overdueDays?: number;
  /** Antecedencia que marca DUE_SOON. Default 3. */
  dueSoonDays?: number;
}

export interface DerivedFinanceControl {
  payment_status: PaymentStatus;
  overdue_since: string | null;
  next_due_date: string | null;
  last_payment_at: string | null;
  days_late: number;
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/billing/payment-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { derivePaymentStatus } from "../../supabase/functions/_shared/billing/payment-status.ts";

const HOJE = "2026-09-10";

describe("derivePaymentStatus", () => {
  it("sem cobranca vencida em aberto esta em dia", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-20", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.overdue_since).toBeNull();
    expect(result.next_due_date).toBe("2026-09-20");
    expect(result.days_late).toBe(0);
  });

  it("vencida ha 1 dia esta atrasada", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-09", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("OVERDUE");
    expect(result.overdue_since).toBe("2026-09-09");
    expect(result.days_late).toBe(1);
  });

  it("vencida ha 4 dias ainda e atraso", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-06", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("OVERDUE");
    expect(result.days_late).toBe(4);
  });

  it("vencida ha 5 dias e inadimplencia", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-05", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.days_late).toBe(5);
  });

  it("o corte e configuravel", () => {
    const charges = [{ due_date: "2026-09-08", status: "OVERDUE", payment_date: null }];
    expect(derivePaymentStatus({ charges, today: HOJE, overdueDays: 2 }).payment_status)
      .toBe("DELINQUENT");
    expect(derivePaymentStatus({ charges, today: HOJE, overdueDays: 10 }).payment_status)
      .toBe("OVERDUE");
  });

  it("cobranca paga nao conta como vencida, mesmo com data antiga", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-08-01", status: "RECEIVED", payment_date: "2026-08-03" },
        { due_date: "2026-07-01", status: "CONFIRMED", payment_date: "2026-07-01" },
        { due_date: "2026-06-01", status: "RECEIVED_IN_CASH", payment_date: "2026-06-02" },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.last_payment_at).toBe("2026-08-03");
  });

  it("cobranca cancelada ou estornada nao gera inadimplencia", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-07-01", status: "DELETED", payment_date: null },
        { due_date: "2026-07-15", status: "REFUNDED", payment_date: "2026-07-16" },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
  });

  it("usa a cobranca vencida MAIS ANTIGA para contar o atraso", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-09-09", status: "OVERDUE", payment_date: null },
        { due_date: "2026-07-10", status: "OVERDUE", payment_date: null },
        { due_date: "2026-08-10", status: "OVERDUE", payment_date: null },
      ],
      today: HOJE,
    });
    expect(result.overdue_since).toBe("2026-07-10");
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.days_late).toBe(62);
  });

  it("vencimento dentro de 3 dias e DUE_SOON", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-12", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DUE_SOON");
    expect(result.days_late).toBe(0);
  });

  it("vencimento hoje ainda nao e atraso, e DUE_SOON", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: HOJE, status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DUE_SOON");
  });

  it("atraso vence DUE_SOON quando ha as duas coisas", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-09-01", status: "OVERDUE", payment_date: null },
        { due_date: "2026-09-11", status: "PENDING", payment_date: null },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.next_due_date).toBe("2026-09-11");
  });

  // Guarda de regressao: o CHECK de client_finance_controls rejeita qualquer
  // valor fora desta lista, e a falha so apareceria em producao.
  it("so emite valores aceitos pelo CHECK do banco", () => {
    const PERMITIDOS = ["CURRENT", "DUE_SOON", "OVERDUE", "DELINQUENT"];
    const cenarios = [
      [],
      [{ due_date: "2026-09-30", status: "PENDING", payment_date: null }],
      [{ due_date: "2026-09-11", status: "PENDING", payment_date: null }],
      [{ due_date: "2026-09-09", status: "OVERDUE", payment_date: null }],
      [{ due_date: "2026-01-01", status: "OVERDUE", payment_date: null }],
    ];
    for (const charges of cenarios) {
      expect(PERMITIDOS).toContain(derivePaymentStatus({ charges, today: HOJE }).payment_status);
    }
  });

  it("cliente sem cobranca nenhuma esta em dia e sem proximo vencimento", () => {
    const result = derivePaymentStatus({ charges: [], today: HOJE });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.next_due_date).toBeNull();
    expect(result.last_payment_at).toBeNull();
  });

  it("atravessa a virada do ano sem errar a contagem", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2025-12-30", status: "OVERDUE", payment_date: null }],
      today: "2026-01-02",
    });
    expect(result.days_late).toBe(3);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/billing/payment-status.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 4: Implementar**

Criar `supabase/functions/_shared/billing/payment-status.ts`:

```ts
import type { ChargeSnapshot, DeriveStatusInput, DerivedFinanceControl } from "./types.ts";

/** Status do Asaas que significam dinheiro recebido. */
const PAGO = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"]);

/** Status que encerram a cobranca sem divida: nao geram inadimplencia. */
const ENCERRADO = new Set(["DELETED", "REFUNDED", "REFUND_REQUESTED", "CHARGEBACK_REQUESTED"]);

const DIA_MS = 86_400_000;

/** Converte YYYY-MM-DD em ms UTC. Trabalhar em UTC evita que horario de verao mova o dia. */
function toUtcMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DIA_MS);
}

function isOpen(charge: ChargeSnapshot): boolean {
  const status = String(charge.status || "").toUpperCase();
  return !PAGO.has(status) && !ENCERRADO.has(status);
}

function isPaid(charge: ChargeSnapshot): boolean {
  return PAGO.has(String(charge.status || "").toUpperCase());
}

/**
 * Deriva o estado financeiro do cliente a partir das cobrancas.
 * `today` entra como parametro (data em America/Sao_Paulo, calculada por quem
 * chama) para que a funcao seja deterministica e testavel.
 */
export function derivePaymentStatus(input: DeriveStatusInput): DerivedFinanceControl {
  const { charges, today } = input;
  const overdueDays = input.overdueDays ?? 5;
  const dueSoonDays = input.dueSoonDays ?? 3;

  const open = charges.filter(isOpen);
  const overdue = open.filter((charge) => charge.due_date < today);

  const overdue_since = overdue.length
    ? overdue.reduce((oldest, charge) => (charge.due_date < oldest ? charge.due_date : oldest), overdue[0].due_date)
    : null;

  const upcoming = open.filter((charge) => charge.due_date >= today);
  const next_due_date = upcoming.length
    ? upcoming.reduce((soonest, charge) => (charge.due_date < soonest ? charge.due_date : soonest), upcoming[0].due_date)
    : null;

  const payments = charges.filter(isPaid).map((charge) => charge.payment_date).filter((date): date is string => !!date);
  const last_payment_at = payments.length ? payments.reduce((latest, date) => (date > latest ? date : latest)) : null;

  const days_late = overdue_since ? daysBetween(overdue_since, today) : 0;
  const days_to_next = next_due_date ? daysBetween(today, next_due_date) : null;

  let payment_status: DerivedFinanceControl["payment_status"];
  if (days_late >= overdueDays) payment_status = "DELINQUENT";
  else if (days_late >= 1) payment_status = "OVERDUE";
  else if (days_to_next !== null && days_to_next <= dueSoonDays) payment_status = "DUE_SOON";
  else payment_status = "CURRENT";

  return { payment_status, overdue_since, next_due_date, last_payment_at, days_late };
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — 39 testes.

- [ ] **Step 6: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/_shared/billing/payment-status.ts supabase/functions/_shared/billing/types.ts tests/billing/payment-status.test.ts
git commit -m "feat: inadimplencia derivada do pagamento real, com corte configuravel em D+5"
```

---

### Task 6: Validação do token do webhook

Um webhook aberto deixa qualquer um inventar pagamento no sistema — e um pagamento inventado apaga uma inadimplência real. O teste que mais importa aqui é o de segredo ausente: tem que negar.

**Files:**
- Create: `supabase/functions/_shared/billing/webhook-auth.ts`
- Test: `tests/billing/webhook-auth.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `isAuthorizedWebhookToken(received: string | null | undefined, expected: string | null | undefined): boolean`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/billing/webhook-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAuthorizedWebhookToken } from "../../supabase/functions/_shared/billing/webhook-auth.ts";

describe("isAuthorizedWebhookToken", () => {
  it("aceita token igual", () => {
    expect(isAuthorizedWebhookToken("segredo-123", "segredo-123")).toBe(true);
  });

  it("recusa token diferente", () => {
    expect(isAuthorizedWebhookToken("errado", "segredo-123")).toBe(false);
  });

  it("recusa quando o segredo do servidor esta ausente ou vazio", () => {
    expect(isAuthorizedWebhookToken("qualquer", null)).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", undefined)).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", "")).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", "   ")).toBe(false);
  });

  it("recusa quando os dois lados estao vazios", () => {
    expect(isAuthorizedWebhookToken("", "")).toBe(false);
    expect(isAuthorizedWebhookToken(null, null)).toBe(false);
  });

  it("recusa token ausente com segredo configurado", () => {
    expect(isAuthorizedWebhookToken(null, "segredo-123")).toBe(false);
  });

  it("nao aceita prefixo do segredo", () => {
    expect(isAuthorizedWebhookToken("segredo", "segredo-123")).toBe(false);
    expect(isAuthorizedWebhookToken("segredo-1234", "segredo-123")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/billing/webhook-auth.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

Criar `supabase/functions/_shared/billing/webhook-auth.ts`:

```ts
/**
 * Compara o token do header com o segredo do servidor.
 * Nega quando o segredo nao esta configurado — um servidor mal configurado
 * fecha, nunca abre. A comparacao percorre o comprimento inteiro para nao
 * vazar onde as strings divergem.
 */
export function isAuthorizedWebhookToken(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const secret = (expected ?? "").trim();
  if (!secret) return false;

  const token = received ?? "";
  if (token.length !== secret.length) return false;

  let mismatch = 0;
  for (let index = 0; index < secret.length; index += 1) {
    mismatch |= token.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return mismatch === 0;
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — 45 testes.

- [ ] **Step 5: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/_shared/billing/webhook-auth.ts tests/billing/webhook-auth.test.ts
git commit -m "feat: valida token do webhook do Asaas, negando quando o segredo falta"
```

---

### Task 7: Migration da fundação de cobrança (escrita, não aplicada)

**Files:**
- Create: `supabase/migrations/20260904120000_billing_asaas_foundation.sql`

**Interfaces:**
- Consumes: nada.
- Produces: as tabelas `agency_ops.asaas_customers`, `agency_ops.billing_subscriptions`, `agency_ops.billing_charges`, `agency_ops.billing_webhook_events`, consumidas pela Task 8.

**IMPORTANTE:** esta migration **não é aplicada** nesta execução. Não rodar `apply_migration`, não rodar `execute_sql` com DDL, não usar o MCP do Supabase para escrever. O arquivo fica pronto no repo.

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/20260904120000_billing_asaas_foundation.sql`:

```sql
-- Fundacao da cobranca recorrente via Asaas.
-- Espelha customers, assinaturas e cobrancas; a inadimplencia passa a ser
-- derivada de agency_ops.billing_charges em vez de marcada a mao.
-- Spec: docs/superpowers/specs/2026-09-04-cobranca-recorrente-asaas-design.md

-- 1. O elo cliente <-> customer do Asaas.
create table if not exists agency_ops.asaas_customers (
  client_id         uuid primary key references agency_ops.clients(id) on delete cascade,
  asaas_customer_id text not null unique,
  matched_by        text not null check (matched_by in ('DOCUMENT','MANUAL')),
  matched_document  text,
  confirmed_by      text,
  confirmed_at      timestamptz,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table agency_ops.asaas_customers is
  'Elo entre cliente e customer do Asaas. confirmed_at nulo = candidato, nunca usado para emitir.';

-- 2. Espelho das assinaturas. due_day so existe aqui: nao ha dia de vencimento
--    em nenhuma outra tabela do schema.
create table if not exists agency_ops.billing_subscriptions (
  asaas_subscription_id text primary key,
  client_id             uuid references agency_ops.clients(id) on delete set null,
  value                 numeric(12,2) not null,
  due_day               int not null check (due_day between 1 and 31),
  cycle                 text not null,
  status                text not null,
  billing_type          text,
  next_due_date         date,
  raw                   jsonb,
  synced_at             timestamptz not null default now()
);

create index if not exists billing_subscriptions_client_idx
  on agency_ops.billing_subscriptions (client_id);

-- 3. A cobranca. Fonte da verdade de todo indicador financeiro.
create table if not exists agency_ops.billing_charges (
  asaas_payment_id      text primary key,
  client_id             uuid references agency_ops.clients(id) on delete set null,
  asaas_subscription_id text,
  kind                  text not null check (kind in ('MENSALIDADE','IMPLANTACAO','EXTRA')),
  value                 numeric(12,2) not null,
  net_value             numeric(12,2),
  due_date              date not null,
  status                text not null,
  billing_type          text,
  payment_date          date,
  invoice_url           text,
  bank_slip_url         text,
  description           text,
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists billing_charges_client_due_idx
  on agency_ops.billing_charges (client_id, due_date desc);
create index if not exists billing_charges_status_due_idx
  on agency_ops.billing_charges (status, due_date);
create index if not exists billing_charges_subscription_idx
  on agency_ops.billing_charges (asaas_subscription_id);

-- 4. Idempotencia do webhook. A unicidade de asaas_event_id e o que impede
--    que reprocessar a fila conte um pagamento duas vezes.
create table if not exists agency_ops.billing_webhook_events (
  id             bigserial primary key,
  asaas_event_id text not null unique,
  event          text not null,
  payment_id     text,
  payload        jsonb not null,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  error          text
);

create index if not exists billing_webhook_events_pendentes_idx
  on agency_ops.billing_webhook_events (received_at)
  where processed_at is null;

-- 5. RLS ligada e SEM policy: leitura exclusiva do service_role, ou seja, so
--    pelas edge functions. A chave anon nao alcanca dado financeiro.
alter table agency_ops.asaas_customers        enable row level security;
alter table agency_ops.billing_subscriptions  enable row level security;
alter table agency_ops.billing_charges        enable row level security;
alter table agency_ops.billing_webhook_events enable row level security;

revoke all on agency_ops.asaas_customers        from anon, authenticated;
revoke all on agency_ops.billing_subscriptions  from anon, authenticated;
revoke all on agency_ops.billing_charges        from anon, authenticated;
revoke all on agency_ops.billing_webhook_events from anon, authenticated;

grant select, insert, update, delete on agency_ops.asaas_customers        to service_role;
grant select, insert, update, delete on agency_ops.billing_subscriptions  to service_role;
grant select, insert, update, delete on agency_ops.billing_charges        to service_role;
grant select, insert, update, delete on agency_ops.billing_webhook_events to service_role;
grant usage, select on sequence agency_ops.billing_webhook_events_id_seq  to service_role;

-- 6. client_finance_controls ja existe com CHECK em payment_status aceitando
--    UNKNOWN, CURRENT, DUE_SOON, OVERDUE, NEGOTIATING, PAID e CANCELLED.
--    Falta separar atraso curto (OVERDUE, D+1 a D+4) de inadimplencia
--    (DELINQUENT, D+5 ou mais). A tabela esta vazia, entao nenhuma linha
--    existente viola a constraint nova.
alter table agency_ops.client_finance_controls
  drop constraint if exists client_finance_controls_payment_status_check;

alter table agency_ops.client_finance_controls
  add constraint client_finance_controls_payment_status_check
  check (payment_status in (
    'UNKNOWN','CURRENT','DUE_SOON','OVERDUE','DELINQUENT','NEGOTIATING','PAID','CANCELLED'
  ));
```

**Antes de aplicar, conferir que a tabela continua vazia.** Se alguém tiver
populado `client_finance_controls` entre a escrita e a aplicação, o `drop
constraint` seguido de `add` falha se houver linha fora do novo conjunto — o
que é o comportamento desejado, mas exige olhar antes em vez de descobrir no
meio da migration.

- [ ] **Step 2: Conferir que a migration não foi aplicada**

Run: `git status --short supabase/migrations/`
Expected: o arquivo aparece como novo e não rastreado. Confirmar por leitura que **nenhum** passo desta tarefa executou DDL contra `bfzdetibfcwihfkltbkp`. A verificação real do SQL acontece quando o Adler aplicar — está listada no checklist de entrega no fim deste plano.

- [ ] **Step 3: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/migrations/20260904120000_billing_asaas_foundation.sql
git commit -m "feat: migration da fundacao de cobranca Asaas (nao aplicada)"
```

---

### Task 8: Casca HTTP do webhook

A função só orquestra: valida, grava o bruto, mapeia com os módulos já testados e marca como processado. Nenhuma regra de negócio nova nasce aqui — se nascer, ela pertence a um módulo puro com teste.

**Files:**
- Create: `supabase/functions/agency-ops-asaas-webhook/index.ts`

**Interfaces:**
- Consumes: `isAuthorizedWebhookToken` (Task 6), `mapAsaasPaymentToCharge` (Task 4), `derivePaymentStatus` (Task 5), tabelas da Task 7 e a `agency_ops.client_finance_controls` existente.
- Produces: endpoint HTTP `POST /agency-ops-asaas-webhook`. Não deployado.

**Desvio consciente do spec.** O §4 do spec previa uma função SQL
`recalc_client_finance_controls`. Este plano faz a derivação em TypeScript, na
`derivePaymentStatus` da Task 5, e a função grava o resultado. Motivo: a regra
de inadimplência escrita nos dois lugares vira duas verdades, e a versão SQL
não teria como ser testada nesta máquina (sem Docker, sem `psql`). Uma regra,
um lugar, com 14 testes em volta.

- [ ] **Step 1: Escrever a função**

Criar `supabase/functions/agency-ops-asaas-webhook/index.ts`:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAuthorizedWebhookToken } from "../_shared/billing/webhook-auth.ts";
import { mapAsaasPaymentToCharge } from "../_shared/billing/charge-mapper.ts";
import { derivePaymentStatus } from "../_shared/billing/payment-status.ts";

/** Data de hoje em America/Sao_Paulo, no formato YYYY-MM-DD. */
function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const notFound = () => json({ error: "not_found" }, 404);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return notFound();

  // Token errado ou ausente nao revela que a rota existe.
  if (!isAuthorizedWebhookToken(req.headers.get("asaas-access-token"), Deno.env.get("ASAAS_WEBHOOK_TOKEN"))) {
    return notFound();
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !service) return json({ error: "server_configuration" }, 500);

  const body = await req.json().catch(() => null);
  const eventId = String(body?.id || "").trim();
  const event = String(body?.event || "").trim();
  const payment = body?.payment;
  if (!eventId || !event) return json({ error: "invalid_payload" }, 400);

  const db = createClient(supabaseUrl, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ops = db.schema("agency_ops");

  // Grava o bruto primeiro. Conflito no asaas_event_id significa evento ja
  // recebido: e sucesso, nao erro — o Asaas nao deve reenviar.
  const { data: stored, error: storeError } = await ops
    .from("billing_webhook_events")
    .insert({ asaas_event_id: eventId, event, payment_id: payment?.id ?? null, payload: body })
    .select("id")
    .maybeSingle();

  if (storeError) {
    if (storeError.code === "23505") return json({ ok: true, duplicate: true });
    return json({ error: "store_failed" }, 500);
  }

  try {
    if (payment?.id) {
      const { data: link } = await ops
        .from("asaas_customers")
        .select("client_id")
        .eq("asaas_customer_id", String(payment.customer || ""))
        .not("confirmed_at", "is", null)
        .maybeSingle();

      const row = mapAsaasPaymentToCharge(payment, link?.client_id ?? null);
      const { error: upsertError } = await ops
        .from("billing_charges")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "asaas_payment_id" });
      if (upsertError) throw new Error(upsertError.message);

      // A inadimplencia deixa de ser flag marcada a mao: e recalculada aqui,
      // a partir de todas as cobrancas do cliente.
      if (row.client_id) {
        const { data: charges, error: chargesError } = await ops
          .from("billing_charges")
          .select("due_date,status,payment_date")
          .eq("client_id", row.client_id);
        if (chargesError) throw new Error(chargesError.message);

        // Pausa nao entra aqui: vive em operational_status, eixo proprio, e
        // continua sendo decisao humana. A derivacao so olha o pagamento.
        const derived = derivePaymentStatus({
          charges: charges || [],
          today: todayInSaoPaulo(),
        });

        const { error: controlError } = await ops.from("client_finance_controls").upsert(
          {
            client_id: row.client_id,
            payment_status: derived.payment_status,
            overdue_since: derived.overdue_since,
            next_due_date: derived.next_due_date,
            last_payment_at: derived.last_payment_at,
            updated_by: "SISTEMA",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_id" },
        );
        if (controlError) throw new Error(controlError.message);
      }
    }

    await ops.from("billing_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", stored?.id);
    return json({ ok: true });
  } catch (caught) {
    // O evento ja esta persistido: registra a falha e responde 200 para o Asaas
    // nao reenviar. A fila com processed_at nulo e retentada depois.
    await ops
      .from("billing_webhook_events")
      .update({ error: caught instanceof Error ? caught.message : "unknown" })
      .eq("id", stored?.id);
    return json({ ok: true, deferred: true });
  }
});
```

- [ ] **Step 2: Conferir que a suíte inteira continua passando**

Run: `npm test`
Expected: PASS — 45 testes. A função não é testável nesta máquina (Deno ausente), mas os módulos que ela usa são, e nenhuma regra nova foi criada aqui.

- [ ] **Step 3: Conferir que nada foi publicado**

Run: `git log --oneline origin/main..HEAD`
Expected: lista todos os commits deste plano, **nenhum deles no origin**. Confirmar também que nenhum `wrangler deploy`, `supabase functions deploy` ou `git push` foi executado em nenhuma tarefa.

- [ ] **Step 4: Commitar**

```bash
git fetch
git log --oneline HEAD..origin/main
git add supabase/functions/agency-ops-asaas-webhook/index.ts
git commit -m "feat: casca HTTP do webhook do Asaas sobre os modulos testados"
```

---

## Checklist de entrega ao Adler

O que fica pronto e o que continua dependendo dele. Nada aqui é executado por este plano.

1. **Criar os três secrets** no Supabase: `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_ENV=sandbox`.
2. **Aplicar a migration** `20260904120000_billing_asaas_foundation.sql`, **dentro de uma transação explícita**. Antes do `COMMIT`, afirmar que o novo CHECK aceita `'DELINQUENT'` — o `drop constraint if exists` é silencioso quando erra o nome, e a migration "teria sucesso" deixando a constraint estreita no lugar, rejeitando todo insert de inadimplente. O nome foi conferido em produção (`client_finance_controls_payment_status_check`, única CHECK naquela coluna), mas a asserção antes do commit é o que transforma isso em garantia.
3. **Conferir a lista canônica de eventos e status do Asaas** contra a documentação oficial, comparando com **os dois conjuntos**, `PAGO` **e** `ENCERRADO`, em `payment-status.ts`. É a única parte do código escrita de memória sobre uma API de terceiro. Um status faltando no `PAGO` marca cliente pago como inadimplente; um faltando no `ENCERRADO` faz o mesmo, porque tudo que não está nos dois conjuntos é tratado como cobrança em aberto.
4. **Conferir a RLS da `client_finance_controls`.** Esta migration protege as quatro tabelas novas, mas a inadimplência derivada aterrissa numa tabela **pré-existente** cujo estado de RLS ela não checa nem altera. Sem isso, a promessa do §8 do spec — "a chave anon nunca alcança dado financeiro" — vale para o espelho e é falsa para a conclusão.
5. **Fazer deploy** da função e cadastrar a URL do webhook no painel do Asaas, em **sandbox**.
6. Só então rodar o ciclo simulado da Fase 0: criar → vencer → pagar.

### Bloqueante para a Fase 1, deliberadamente não resolvido nesta branch

**A derivação precisa de um gatilho por tempo, e ainda não tem um.** O Asaas emite
`PAYMENT_OVERDUE` **uma única vez**, em D+1. A `derivePaymentStatus` recebe `today`
como parâmetro e só roda quando chega evento — então nada dispara em D+5, e a linha de
controle continua dizendo `OVERDUE` enquanto o cliente está 5, 20 ou 40 dias atrasado,
até que algum evento não relacionado daquele cliente apareça (na prática, o
`PAYMENT_CREATED` do mês seguinte).

Consequência: a tela "Inadimplentes" do §7 do spec — o pedido original — apareceria
**vazia enquanto há gente devendo**. A falha é silenciosa e parece boa notícia.

Não foi corrigido aqui porque a correção exige invocação agendada de edge function, e
reimplementar a derivação em SQL contradiz a arquitetura inteira: a regra vive em um
lugar só, com testes. A Fase 1 precisa incluir um `pg_cron` diário (convenção
`agency_ops_*`) que reexecute a derivação para todo cliente com cobrança em aberto.
**Nenhum valor de `payment_status` é confiável antes disso.**

### Também para a Fase 1

**Drenar `billing_webhook_events`.** O índice parcial `billing_webhook_events_pendentes_idx`
existe para um consumidor que ainda não foi escrito. Enquanto ele não existir, um evento
que falhou no processamento fica parado indefinidamente — e a decisão da Task 4, de
recusar payload malformado em vez de fabricar R$ 0, apoia-se justamente em alguém
esvaziar essa fila.

## Verificação final

- [ ] `npm test` — suíte verde (o total cresceu além dos 45 previstos: as revisões
      acrescentaram testes discriminadores, de limite e de composição)
- [ ] `npm run typecheck` — **nenhum erro novo** além do pré-existente
      `app/briefing-staff-bridge.tsx(62,10)`, que pertence a outra frente de trabalho
- [ ] `git log --oneline origin/main..HEAD` — todos os commits locais, nenhum publicado
- [ ] Nenhuma tabela criada, alterada ou populada em `bfzdetibfcwihfkltbkp`
