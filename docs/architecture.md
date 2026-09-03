# Arquitetura

## Visão geral

```
   Meta Lead Ads / landing / formulário
                  │
                  ▼
   ┌──────────────────────────────┐
   │  imobi-board-worker          │   Cloudflare
   │  · ingestão + idempotência   │
   │  · Workflow de SLA           │
   │  · bridge da agência         │
   └──────────────┬───────────────┘
                  │ service role, RPC
                  ▼
   ┌──────────────────────────────┐
   │  PostgreSQL (schema          │   Supabase
   │  imobi_board)                │
   │  · RLS  · RPC transacionais  │
   │  · agregações               │
   └──────────────▲───────────────┘
                  │ anon key + JWT, RLS aplicada
                  │
   ┌──────────────┴───────────────┐
   │  imobi-board-app (React SPA) │
   └──────────────────────────────┘
```

O frontend fala direto com o Postgres via PostgREST — não há camada de API
intermediária para CRUD. Isso é possível porque a autorização está em RLS: não
existe query que o browser possa montar e que devolva dado de outro tenant.

O Worker existe para o que o browser **não pode** fazer: receber webhook de
terceiro, guardar service role e dormir por 5 minutos esperando um SLA.

---

## Por que schema dedicado

O Imobi-Board vive em `imobi_board`, não em `public`. Três razões:

1. O projeto Supabase é compartilhado e o `public` tem ~200 tabelas de outros
   sistemas. Há colisão direta de nomes: `profiles`, `leads`, `clients`,
   `contracts` já existem lá.
2. O projeto já usa esse padrão (`agency_ops`, `crm`, `sdr_monitor` estão
   expostos ao PostgREST).
3. Extrair o produto para um projeto próprio um dia é
   `pg_dump -n imobi_board`.

`imobi_board_priv` é um segundo schema, **não exposto**, onde ficam os helpers
`SECURITY DEFINER`. Separar os dois é o que impede um helper de virar superfície
de ataque.

---

## Regra: escrita múltipla vira RPC

Mover um lead de etapa precisa de três escritas: a oportunidade, a atividade de
histórico e o evento de domínio. Em REST isso seria três requests, três
round-trips e uma janela em que o histórico está incompleto.

`move_opportunity_stage` faz tudo numa transação:

```
FOR UPDATE na oportunidade      ← trava contra dois arrastes simultâneos
valida permissão
valida que a etapa é do funil dela
atualiza stage/status/timestamps
insere activity STATUS_CHANGE
emite domain_event
```

É também o que permite `domain_events` não ter grant nenhum: só a função,
`SECURITY DEFINER`, escreve nela.

As RPC de escrita são: `provision_tenant`, `create_opportunity`,
`move_opportunity_stage`, `distribuir_lead`, `aceitar_lead`,
`expirar_assignment`, `ingerir_lead`.

---

## Regra: agregação fica no banco

`dashboard_admin`, `dashboard_broker`, `ranking_corretores`, `leads_parados` e
`agency_performance` devolvem o resultado pronto. O browser não baixa 10 mil
oportunidades para contar seis números.

O painel do ADMIN inteiro — 8 cards, funil de 6 etapas e quebra por origem — é
**uma** chamada.

---

## Denormalizações deliberadas

Duas, ambas com motivo:

**`opportunities.last_interaction_at`** — mantido por trigger em toda inserção
de atividade. Sem ele, "leads sem interação há 30 dias" seria um `LEFT JOIN` com
`max(created_at)` em `activities` e varredura completa. Com ele, é um range scan
no índice parcial `opportunities_stale_idx`.

**`pipeline_stages.kind`** — o ADMIN pode renomear "Qualificado" para "Em
negociação"; o funil e o analytics continuam funcionando porque leem `kind`, não
`name`.

---

## O que não foi construído

Não há tabela de histórico de estágio. `activities` com
`type = 'STATUS_CHANGE'` e `from_stage_id`/`to_stage_id` carrega a mesma
informação que a spec pede — uma tabela e um índice a menos, numa instância
compartilhada.

Não há Cloudflare Queues. O Workflow cobre a assincronia que existe hoje (SLA), e
Queues exigem plano pago. A ingestão é rápida o suficiente para responder
inline. O código está separado em módulos para receber um consumer quando fizer
sentido.

Não há polling nem `setInterval` em lugar nenhum do frontend.
