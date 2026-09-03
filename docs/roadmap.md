# Roadmap

## Feito nesta sessao

Banco completo (15 tabelas), RLS testada, autenticacao, tenant e papeis,
leads, pipeline Kanban, atividades, follow-ups, paineis de ADMIN e corretor,
ranking, filas com round robin, SLA por Workflow, ingestao com deduplicacao e
idempotencia, contrato do bridge da agencia.

## Proximo passo imediato

1. Expor o schema `imobi_board` no PostgREST (ver `supabase.md`) e validar a
   vertical no navegador.
2. `wrangler login` + deploy do `imobi-board-worker` em staging.
3. Ligar o Workflow de ponta a ponta com timeout curto e observar a
   redistribuicao acontecer sozinha.

## Resto da V1

| Passo | Item |
|---|---|
| 14 | `properties` / `developments` / `property_units` + midia |
| 15 | `lead_interests` (perfil de interesse) |
| 16 | matching deterministico com score explicavel |
| 17 | visitas |
| 18 | propostas |
| 19 | vendas + snapshot de atribuicao (destrava VGV) |
| 12b | telas de administracao de filas e corretores |
| 22 | integracao real com Meta Lead Ads |

`vgv` e `sla_perdido` aparecem como `--` nos paineis hoje. Nao sao zeros
falsos: as tabelas que os alimentam ainda nao existem.

## V1.1 / V2

- controle de chaves (`property_keys`, `key_movements`)
- selecao personalizada de imoveis com link para o cliente
- pos-venda simples

## Modulo de IA (fora do core)

WhatsApp oficial, qualificacao automatica, follow-up e reativacao. O core nao
depende disso e nao deve passar a depender: a integracao entra pela API, como
qualquer outra origem.

## Growth

Atribuicao Meta completa, Google Ads, conexao real do bridge com o dashboard da
agencia.

## Explicitamente fora

Site imobiliario, CMS, portais (Zap/VivaReal/OLX), ERP de locacao, financeiro,
permutas, inbox multicanal, automation builder visual, reciclagem automatica.
