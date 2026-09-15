# Distribuição e SLA

## O problema

Um lead entra às 14h03. Se ninguém falar com ele em minutos, ele já está
conversando com outra imobiliária. O CRM precisa (a) escolher um corretor,
(b) cobrar o aceite, (c) redistribuir se o aceite não vier — sem depender de
alguém olhando a tela.

## Round robin

`lead_queues` guarda o cursor do rodízio em `cursor_sort_order`. Não é memória
do Worker: sobrevive a restart e não depende de a próxima requisição cair no
mesmo isolate.

`imobi_board_priv.distribuir()` faz:

```sql
pg_advisory_xact_lock( hash(queue_id) )   -- serializa por fila
próximo membro ativo com sort_order > cursor
   (se não houver, volta ao primeiro)
atualiza o cursor
cria lead_assignments (PENDING, expires_at = agora + timeout)
aponta opportunities.assigned_user_id
emite opportunity.assigned
```

A trava advisory cai sozinha no commit. Duas ingestões simultâneas na mesma fila
serializam ali e nenhuma lê o cursor desatualizado.

Segunda defesa, independente da primeira:

```sql
create unique index lead_assignments_uma_pendente_uq
  on lead_assignments (opportunity_id) where status = 'PENDING';
```

Mesmo com bug na aplicação, um lead não consegue ter duas atribuições pendentes.

### Verificado

Fila com João(0), Maria(1), Pedro(2). Quatro leads:

```
Lead 1 → João      Lead 3 → Pedro
Lead 2 → Maria     Lead 4 → João
```

---

## SLA sem cron

A spec proíbe cron, e com razão: varrer leads vencidos a cada minuto significa
1.440 execuções por dia, quase todas sem nada a fazer, disputando CPU com os
outros projetos da mesma conta.

Cada distribuição abre uma instância de Cloudflare Workflow:

```
lead atribuído
  └─ Workflow instance  id = assignment-<uuid>
       step.sleep(timeout)          ← não consome recurso enquanto dorme
       step.do → expirar_assignment
            ├─ aceito          → encerra
            ├─ ainda no prazo  → dorme o resto e reconfere
            └─ expirado        → MISSED, evento de SLA, redistribui
                                   └─ encadeia o Workflow do próximo
```

O id da instância deriva do assignment. Um webhook reentregue não cria dois
relógios para o mesmo lead.

### Idempotência

`expirar_assignment` decide tudo dentro de `FOR UPDATE` e devolve o motivo:

| Situação | Retorno | Efeito |
|---|---|---|
| já aceito | `ja_aceito` | nenhum |
| ainda no prazo | `ainda_no_prazo` + `expires_at` | nenhum |
| expirado, tem fila | `redistribuido` + novo id | MISSED + nova atribuição |
| expirado, 5ª tentativa | `devolvido_a_fila` | volta sem dono |
| fila sem corretor | `sem_corretor_disponivel` | volta sem dono |

O Workflow pode reexecutar o passo — a Cloudflare faz isso — e nada acontece
duas vezes. O Workflow não guarda estado próprio de propósito: a verdade é o
banco.

### Verificado

| Cenário | Resultado |
|---|---|
| Workflow acorda antes do prazo | `ainda_no_prazo`, sem efeito |
| Prazo estourado | `redistribuido`, novo assignment |
| Reexecução sobre lead já aceito | `ja_aceito`, sem efeito |
| João aceita o próprio lead | ok |
| Maria tenta aceitar lead do Pedro | `42501` |
| BROKER tenta distribuir | `42501` |

---

## O bug que apareceu no teste

Na primeira versão, "Teste Rodízio 2" foi redistribuído **da Maria para a
própria Maria**. O rodízio estava correto — o cursor é global e havia caído de
volta nela — mas o comportamento de produto é errado: quem acabou de estourar o
SLA não pode receber o mesmo lead de volta.

`0006` corrigiu: `distribuir()` recebe `p_excluir` e pula esse usuário, **desde
que haja outro corretor ativo** na fila. Com um único corretor, excluir deixaria
o lead sem destino — nesse caso ele volta para a mesma pessoa, que é o menos
ruim.

Confirmado depois da correção: Pedro perde o prazo → lead vai para João.

---

## Teto de tentativas

Após 5 voltas sem aceite, o lead volta para a fila sem dono e o ADMIN resolve na
mão. Sem teto, um lead ruim circularia para sempre entre corretores, gerando
Workflow atrás de Workflow.

---

## O que ainda não existe

- Estratégias `weighted`, por região ou por performance. O enum
  `queue_strategy` já existe com um valor só; adicionar é `ALTER TYPE`.
- `working_hours` está na tabela mas ainda não é respeitado — hoje um lead que
  chega às 3h da manhã é distribuído e o SLA corre normalmente.
- Tela de administração de filas. As tabelas e as RPC existem e têm RLS; falta
  a UI.
