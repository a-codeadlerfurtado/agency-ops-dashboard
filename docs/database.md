# Banco

15 tabelas em `imobi_board`. Todas com RLS. Todas com `tenant_id`, direta ou
indiretamente.

## Identidade

| Tabela | Papel |
|---|---|
| `tenants` | a imobiliária |
| `profiles` | 1:1 com `auth.users` |
| `memberships` | quem pertence a qual tenant, com qual papel |

`memberships` é a tabela mais quente do banco: toda política de RLS passa por
ela. Daí o índice parcial `memberships_user_active_idx (user_id, tenant_id, role)
where status = 'ACTIVE'`.

## Comercial

| Tabela | Papel |
|---|---|
| `contacts` | a pessoa |
| `opportunities` | o interesse dela em comprar |
| `pipelines` / `pipeline_stages` | o funil |
| `activities` | histórico, append-only |
| `tasks` | follow-ups |

### Contato ≠ oportunidade

João Silva demonstra interesse no Vert Residence hoje e no Vista Home seis meses
depois. São **duas oportunidades e um contato**. Sem essa separação, ou se perde
o histórico ou se cria João duas vezes.

A deduplicação é garantida por índice, não por código:

```sql
create unique index contacts_tenant_phone_uq
  on contacts (tenant_id, phone_normalized) where phone_normalized is not null;
```

Parcial e por tenant. Telefone inválido vira `NULL` e simplesmente não participa
— não bloqueia o cadastro.

### Normalização

`imobi_board_priv.normalize_phone_br` é **a única** implementação. Fica no
banco, não na aplicação, porque o índice único depende de ela ser determinística
e igual em todos os caminhos de entrada (UI, ingestão, importação).

| Entrada | Saída |
|---|---|
| `(11) 99663-4567` | `5511996634567` |
| `11996634567` | `5511996634567` |
| `5511996634567` | `5511996634567` |
| `+55 11 99663-4567` | `5511996634567` |
| `11 9663-4567` | `5511996634567` |
| `(61) 3245-1200` | `556132451200` |
| `99663-4567` | `NULL` (sem DDD) |
| `abc` | `NULL` |

A quinta linha é a regra do nono dígito: celular antigo sem o 9 é corrigido, fixo
não.

### Histórico de etapa

Não há tabela dedicada. `activities` com `type = 'STATUS_CHANGE'` carrega
`from_stage_id`, `to_stage_id`, `created_by` e `created_at` — tudo o que a spec
pede, numa tabela que já precisava existir.

Grant apenas `SELECT, INSERT`. Ninguém edita nem apaga, nem o ADMIN.

## Distribuição

| Tabela | Papel |
|---|---|
| `lead_queues` | fila, estratégia, timeout de aceite, cursor do rodízio |
| `queue_members` | corretores na fila, com ordem |
| `lead_assignments` | cada tentativa de atribuição, com prazo |

Ver `distribution.md`.

## Infra

| Tabela | Papel |
|---|---|
| `domain_events` | outbox simples — sem grant para ninguém |
| `audit_logs` | operações sensíveis, leitura só do ADMIN |
| `ingest_sources` | credencial por integração (só o hash) |

`domain_events` **não é event sourcing**. A verdade está nas tabelas; os eventos
existem para o que vier depois (bridge, projeções, notificações).

---

## Índices

Foram criados deliberadamente, não um por coluna. Esta instância é compartilhada
com uma operação viva: cada índice custa em toda escrita.

| Índice | Serve |
|---|---|
| `opportunities_tenant_stage_idx` | Kanban e lista do ADMIN |
| `opportunities_assigned_idx` (parcial) | "Meus leads" — a query mais chamada |
| `opportunities_stale_idx` (parcial, `status='OPEN'`) | leads esquecidos |
| `opportunities_campaign_idx` (parcial) | atribuição por campanha |
| `opportunities_contact_idx (contact_id, assigned_user_id)` | ficha do lead **e** `owns_contact()` |
| `tasks_agenda_idx` (parcial, `status='OPEN'`) | hoje / atrasados / futuros |
| `domain_events_unprocessed_idx` (parcial) | fica minúsculo mesmo com milhões de linhas |
| `lead_assignments_uma_pendente_uq` | trava de corrida |

Os parciais são a razão de o custo se manter baixo: o índice de leads parados só
indexa oportunidades abertas, e o de eventos só os não processados.

---

## Tipos

Enums em vez de `text` + `check`: 4 bytes por linha e comparação por inteiro.
`tenant_status`, `member_role`, `member_status`, `opp_status`, `stage_kind`,
`activity_type`, `task_status`, `queue_strategy`, `assignment_status`.

`stage_kind` merece nota. O ADMIN pode renomear as etapas; `kind` preserva a
semântica para o funil e o analytics. A UI mostra `name`, o relatório lê `kind`.

---

## Constraints que valem citar

```sql
-- lead perdido exige motivo
check (status <> 'LOST' or lost_reason is not null)

-- tarefa concluída exige data de conclusão
check (status <> 'DONE' or completed_at is not null)

-- mudança de etapa exige etapa de destino
check (type <> 'STATUS_CHANGE' or to_stage_id is not null)

-- reenvio de webhook não vira lead novo
unique (tenant_id, source, external_event_id) where external_event_id is not null
```

A ordenação de etapas é `DEFERRABLE INITIALLY DEFERRED`, para permitir trocar
duas posições numa transação só. Efeito colateral: `ON CONFLICT` não aceita essa
constraint como árbitro — use `WHERE NOT EXISTS` ao semear.

---

## Estado atual (03/09/2026)

| | |
|---|---|
| Tenants | 2 |
| Usuários | 6 |
| Contatos | 31 |
| Oportunidades | 32 |
| Atividades | 52 |
| Follow-ups | 6 |
| Eventos de domínio | 16 |
