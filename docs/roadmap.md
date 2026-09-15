# Roadmap

## V1 — completa

Toda a linha `anúncio → lead → distribuição → corretor → atendimento →
qualificação → imóvel → visita → proposta → venda → VGV → atribuição` está
implementada, testada e no ar.

| Passo | Entrega |
|---|---|
| 1 | Auditoria do ambiente, produção existente mapeada e protegida |
| 2 | Monorepo pnpm |
| 3 | Schemas `imobi_board` / `imobi_board_priv` no projeto `imobi-pro` |
| 4 | Banco base: tenants, perfis, contatos, oportunidades, funil, atividades, tarefas |
| 5 | RLS em todas as tabelas, com suíte de testes |
| 6 | Auth, resolução de tenant e papel |
| 7 | Layout, sidebar por papel, roteamento |
| 8 | Leads: lista, filtros, cadastro, ficha |
| 9 | Kanban com drag & drop e histórico de etapa |
| 10 | Follow-ups e painel pessoal do corretor |
| 11 | Tela de corretores |
| 12 | Filas, round robin, atribuição |
| 13 | Workflow de SLA na Cloudflare, com redistribuição |
| 14 | Imóveis, empreendimentos, mídia |
| 15 | Perfil de interesse do lead |
| 16 | Matching determinístico com score explicável |
| 17 | Visitas |
| 18 | Propostas |
| 19 | Vendas com snapshot de atribuição |
| 20 | Painéis, funil, ranking, VGV |
| 21 | Ingestão genérica com deduplicação e idempotência |
| 22 | Adapter da Meta Lead Ads (ver ressalva abaixo) |
| 23 | Contrato do bridge da agência |
| 24 | Hardening: RLS, índices, mobile, mensagens de erro |

### Critério da §120, verificado

```
lead da Meta → Terra Concreta → fila → João → SLA → aceite →
contato → qualificação → match com imóvel → visita → proposta →
venda → VGV → ranking → atribuição da venda ao anúncio
```

Rodou de ponta a ponta. A venda de R$ 875.000 da Olivia Ramos aparece no VGV,
no ranking do João e atribuída à campanha "Lancamento Vista Residence",
anúncio "Video tour 30s".

---

## Pendências reais

**Meta Lead Ads em produção.** O adapter existe, traduz o formato real
(`field_data` com `name`/`values`) e o `leadgen_id` já garante idempotência.
O handshake do webhook (`hub.challenge`) responde. Falta apenas conectar um app
Meta real e assinar o formulário — nada disso é código.

**Secret do Worker.** `SUPABASE_SERVICE_ROLE_KEY` não está configurado. Sem
ele, a ingestão por HTTP e o Workflow de SLA não funcionam em produção. O
`ingerir_lead` e o `expirar_assignment` foram testados direto no banco.

**`working_hours` da fila.** A coluna existe, o valor é gravado, mas o motor
ainda não a respeita: um lead que chega às 3h é distribuído e o SLA corre.

**Convite de corretor por e-mail.** A tela lista a equipe real; criar usuário
novo ainda passa pelo Supabase Auth na mão.

**Upload de foto de imóvel.** `property_media` existe com RLS; falta o
componente de upload para o Supabase Storage.

---

## V1.1 / V2

- controle de chaves (`property_keys`, `key_movements`)
- seleção personalizada de imóveis com link para o cliente favoritar
- pós-venda simples
- estratégias de fila além do round robin (peso, região, performance)
- calendário de visitas de verdade

## Módulo de IA (fora do core)

WhatsApp oficial, qualificação automática, follow-up e reativação. O core não
depende disso e não deve passar a depender: a integração entra pela API de
ingestão, como qualquer outra origem.

## Growth

Google Ads, conexão real do bridge com o dashboard da agência.

## Explicitamente fora

Site imobiliário, CMS, portais (Zap/VivaReal/OLX), ERP de locação, financeiro,
permutas, inbox multicanal, automation builder visual, reciclagem automática.
