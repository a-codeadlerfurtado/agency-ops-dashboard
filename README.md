# Imobi-Board

**CRM imobiliário que conecta anúncio, lead, corretor e venda.**

> **Staging no ar:** https://imobi-board-app.lakassessoriadigital.workers.dev
> API: https://imobi-board-worker.lakassessoriadigital.workers.dev

SaaS multi-tenant para imobiliárias e corretores. O foco é a linha
`anúncio → lead → distribuição → corretor → atendimento → qualificação → visita
→ proposta → venda`, preservando a atribuição de mídia do começo ao fim: quando
uma venda acontece, dá para dizer de qual anúncio ela veio.

Não é um ERP imobiliário. Locação, financeiro, portais, permutas e inbox
multicanal estão deliberadamente fora — ver `docs/roadmap.md`.

---

## Como está montado

```
imobi-board/
├─ apps/web/            React 19 + Vite. SPA, dark, mobile-first.
├─ workers/api/         Cloudflare Worker: ingestão + Workflow de SLA + bridge.
├─ packages/            domain / validation (regras puras compartilhadas).
├─ supabase/
│  ├─ migrations/       Schema versionado. Nada é aplicado fora daqui.
│  ├─ tests/            Suíte de RLS e isolamento.
│  └─ seed.sql          Dois tenants de demonstração.
└─ docs/
```

O banco é **PostgreSQL no Supabase**, num schema dedicado `imobi_board`. Toda a
regra de isolamento vive em RLS, no Postgres — não na aplicação.

---

## Requisitos

| Ferramenta | Versão | Necessário para |
|---|---|---|
| Node | >= 22 | tudo |
| pnpm | >= 10 | monorepo |
| wrangler | >= 4 | rodar/deployar o Worker |

Supabase CLI e Docker são opcionais: o desenvolvimento aponta para um projeto
Supabase remoto.

---

## Instalação

```bash
pnpm install
cp .env.example .env          # preencha com os valores do seu projeto
cp .env.example apps/web/.env
```

Seeds, em ordem: `supabase/seed.sql` e depois `supabase/seed_imoveis.sql`.

Variáveis mínimas para o frontend subir:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

`SUPABASE_SERVICE_ROLE_KEY` **nunca** vai para o frontend. Ela só existe como
secret do Worker — ver `docs/security.md`.

---

## Rodando

```bash
pnpm dev          # frontend em http://localhost:5173
pnpm dev:api      # worker em http://localhost:8787
pnpm typecheck    # checagem de tipos de todos os pacotes
pnpm build        # build de produção
```

### Contas de demonstração

Senha: `ImobiBoard#Demo2026` (ambiente de demonstração; trocar antes de
qualquer uso real).

| E-mail | Papel | Imobiliária |
|---|---|---|
| `carlos@terraconcreta.demo` | ADMIN | Terra Concreta |
| `joao@terraconcreta.demo` | BROKER | Terra Concreta |
| `maria@terraconcreta.demo` | BROKER | Terra Concreta |
| `pedro@terraconcreta.demo` | BROKER | Terra Concreta |
| `beatriz@horizonte.demo` | ADMIN | Imobiliária Horizonte |
| `rafael@horizonte.demo` | BROKER | Imobiliária Horizonte |

O segundo tenant existe para provar o isolamento: entre como Carlos e como
Beatriz e confira que nenhum vê o dado do outro.

---

## Migrations

Toda alteração de schema é uma migration numerada em `supabase/migrations/`.
Não se altera o banco pela UI.

```bash
# via Supabase CLI, se disponível
supabase db push

# ou aplique o arquivo no SQL Editor, em ordem numérica
```

| Migration | O que faz |
|---|---|
| `0001_core_schema` | 11 tabelas, enums, índices |
| `0002_rls` | RLS em tudo + helpers de política |
| `0003_rpc` | operações transacionais e normalização |
| `0004_analytics` | painéis, ranking, leads parados |
| `0005_distribuicao_sla` | filas, round robin, assignments |
| `0006_sla_nao_devolve_para_quem_perdeu` | correção de redistribuição |
| `0007_ingest_sources` | credenciais e endpoint de ingestão |
| `0008_agency_bridge` | contrato agregado para a agência |
| `0009_fk_membership_profile` | FK que o PostgREST precisa para embutir perfis |
| `0010_imoveis_interesse` | imóveis, empreendimentos, mídia, perfil de interesse |
| `0011_matching` | score determinístico lead × imóvel |
| `0012_visitas_propostas_vendas` | as três entidades + snapshot de atribuição |
| `0013_rpc_visitas_propostas_vendas` | operações transacionais e a trava da venda explícita |
| `0014_analytics_com_vgv` | VGV, SLA perdido e atribuição reais nos painéis |

---

## Testes

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/rls_test.sql
psql "$SUPABASE_DB_URL" -f supabase/tests/rls_comercial_test.sql
```

**24 tentativas de acesso indevido, 24 bloqueios.** As suítes cobrem
visibilidade por papel e por tenant, troca de `tenant_id` via payload,
autopromoção a ADMIN, leitura de proposta e venda de colega, escrita direta em
`sales` e `domain_events`, corretor mexendo no rodízio, venda fechada por
arrastar card, e o score do matching. Ver `docs/security.md`.

---

## Deploy

```bash
cd workers/api
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put AGENCY_BRIDGE_TOKEN
wrangler deploy
```

O Worker chama-se `imobi-board-worker`. **Confira o nome antes de deployar** —
a conta hospeda outros Workers em produção que não têm relação com este projeto.

O frontend é estático: `pnpm build` gera `apps/web/dist`, que sobe em Cloudflare
Workers Assets, Pages ou qualquer host estático.

---

## Decisões que valem saber antes de mexer

- **Sem cron, em lugar nenhum.** O SLA de aceite é um Cloudflare Workflow que
  dorme o tempo exato e acorda uma vez por lead. Um cron varrendo leads vencidos
  acordaria 1.440 vezes por dia para, quase sempre, não fazer nada.
- **RLS é a fronteira, não a aplicação.** As políticas usam helpers `STABLE`
  chamados dentro de `(select ...)`, o que os transforma em `InitPlan`:
  avaliados uma vez por query, não uma por linha.
- **Contato ≠ oportunidade.** A mesma pessoa interessada em dois produtos gera
  dois registros de oportunidade e um só de contato.
- **Escritas múltiplas viram RPC.** Mover um lead de etapa grava oportunidade,
  atividade e evento de domínio numa transação só — um request, não três.
- **`domain_events` não tem grant nenhum.** Só funções `SECURITY DEFINER`
  escrevem nela.

Detalhes em `docs/architecture.md`.
