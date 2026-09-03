# Cloudflare

## Recursos deste projeto

| Nome | Tipo | Estado |
|---|---|---|
| `imobi-board-worker` | Worker | codigo pronto, **nao deployado** |
| `imobi-board-sla` | Workflow | declarado no wrangler.jsonc |
| `LIMITE_INGEST` | Rate Limit | 120 req/60s por credencial |

## Recursos que NAO sao deste projeto

A conta hospeda cinco Workers em producao sem relacao com o Imobi-Board:

```
agency-ops-dashboard          agency-ops-dashboard-inbox-preview
agency-briefing-hub           agency-supabase-admin-bridge
imperial-imoveis-briefing
```

Nenhum comeca com `imobi-board`. **Confira o nome antes de qualquer deploy** —
`wrangler deploy` sobrescreve pelo nome sem perguntar.

## Deploy

```bash
cd workers/api
wrangler login                       # acao sua: envolve credencial da conta
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put AGENCY_BRIDGE_TOKEN
wrangler secret put META_VERIFY_TOKEN     # so quando ligar a Meta
wrangler deploy
```

Validar sem publicar:

```bash
wrangler deploy --dry-run
```

Ultima validacao: bundle de 10,67 KiB (3,69 KiB gzip), bindings `SLA`,
`LIMITE_INGEST` e `AMBIENTE` reconhecidos.

## Rotas

| Metodo | Rota | Auth |
|---|---|---|
| GET | `/health` | publica |
| GET | `/v1/ingest/leads/:integracao` | handshake da Meta (`hub.challenge`) |
| POST | `/v1/ingest/leads/:integracao` | Bearer token da credencial |
| GET | `/internal/agency/tenants/:id/performance` | Bearer `AGENCY_BRIDGE_TOKEN` |

Integracoes aceitas: `meta`, `meta-ads`, `webhook`, `site`, `form`.

## Por que nao ha Queues

Cloudflare Queues exige plano pago. A unica assincronia real hoje e o SLA, que o
Workflow resolve melhor (dorme o tempo exato em vez de reprocessar fila). A
ingestao responde em um round-trip. O codigo esta separado em modulos para
receber um consumer quando houver volume que justifique.

## Por que nao ha cron

Decisao de arquitetura, nao omissao. Ver `distribution.md`.
