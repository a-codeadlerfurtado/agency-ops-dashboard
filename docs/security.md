# Segurança e isolamento

O Imobi-Board é multi-tenant sobre um banco só. A regra que não pode falhar é
uma: **João, da Terra Concreta, nunca vê nada da Imobiliária Horizonte** — nem
alterando a URL, nem forjando o payload, nem chamando o Supabase direto do
navegador com o UUID em mãos.

Essa garantia está no PostgreSQL, não na aplicação. Se o frontend inteiro fosse
substituído por um script malicioso, o isolamento continuaria valendo.

---

## Onde vive a fronteira

```
Browser  ──►  PostgREST  ──►  RLS  ──►  dados
                               ▲
                        aqui, e só aqui
```

O cliente recebe apenas a chave `publishable`/`anon`. Ela não abre nada
sozinha: o papel `anon` **não tem `USAGE` no schema `imobi_board`** e não tem
grant em nenhuma tabela. Sem login, a superfície é literalmente zero.

Depois do login, o usuário vira `authenticated` e as políticas entram.

---

## Os helpers de política

Quatro funções em `imobi_board_priv` (schema não exposto ao PostgREST):

| Função | Devolve |
|---|---|
| `current_tenant_ids()` | tenants em que sou membro ativo |
| `admin_tenant_ids()` | subconjunto em que sou ADMIN |
| `tenant_peer_ids()` | usuários que dividem tenant comigo |
| `owns_contact(id)` / `owns_opportunity(id)` | o registro é meu? |

São `STABLE SECURITY DEFINER` com `set search_path = ''`. `SECURITY DEFINER`
ignora RLS por dentro — por isso o filtro por `auth.uid()` é explícito no corpo
de cada uma. `EXECUTE` foi revogado de `PUBLIC` e concedido só a
`authenticated`.

### Por que `(select helper())` e não `helper()`

```sql
-- custa uma chamada POR LINHA
using (tenant_id = any (imobi_board_priv.current_tenant_ids()))

-- custa uma chamada por QUERY (o planner vira InitPlan)
using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]))
```

A diferença é de 5 a 10x em CPU numa tabela grande. Como este banco divide
instância com uma operação viva, isso não é detalhe de performance — é
convivência.

O `::uuid[]` não é decorativo: sem ele o parser lê `ANY (subquery)` em vez de
`ANY (array)` e a migration falha com `operator does not exist: uuid = uuid[]`.

---

## Regra por tabela

| Tabela | ADMIN | BROKER |
|---|---|---|
| `tenants` | lê o próprio | lê o próprio |
| `memberships` | lê e escreve | **só lê** |
| `contacts` | tudo do tenant | só de quem tem oportunidade dele |
| `opportunities` | tudo do tenant | só as atribuídas a ele |
| `activities` | lê tudo do tenant | lê as suas — **ninguém apaga** |
| `tasks` | tudo do tenant | só as suas |
| `audit_logs` | só lê | sem acesso |
| `domain_events` | sem acesso | sem acesso |
| `lead_assignments` | tudo do tenant | só as suas |

Dois pontos que costumam passar batido:

**Lead na fila é invisível para corretor.** Uma oportunidade sem
`assigned_user_id` não aparece para nenhum BROKER — só para o ADMIN. É o
comportamento certo: lead ainda não distribuído não pertence a ninguém.

**`WITH CHECK` sempre reancora em `current_tenant_ids()`.** Sem isso, um
corretor poderia editar o próprio lead trocando o `tenant_id` no payload e
empurrá-lo para outra imobiliária — a checagem de "é meu" passaria. Com a
âncora, o destino precisa ser um tenant dele também.

**Histórico é append-only.** `activities` tem grant apenas de `SELECT, INSERT`.
Não existe UPDATE nem DELETE, nem para ADMIN. Um CRM em que o corretor pode
apagar o que registrou não serve para auditar SLA.

---

## Resultado dos testes

Executado em 03/09/2026 contra o banco real, com impersonação verdadeira
(`set role authenticated` + claim JWT), não simulação.

### Visibilidade

| Usuário | Papel | Oportunidades visíveis | Tenants |
|---|---|---|---|
| Carlos | ADMIN Terra Concreta | 24 | 1 |
| João | BROKER Terra Concreta | 8 | 1 |
| Maria | BROKER Terra Concreta | 7 | 1 |
| Pedro | BROKER Terra Concreta | 7 | 1 |
| Beatriz | ADMIN Horizonte | 6 | 1 |
| Rafael | BROKER Horizonte | 4 | 1 |
| sem membership | — | **0** | **0** |

A aritmética fecha: 8 + 7 + 7 = 22 dos 24 leads da Terra Concreta. Os 2
restantes estão sem dono e nenhum corretor os enxerga.

### Ataques

Doze tentativas, doze bloqueios.

| # | Tentativa | Como foi barrado |
|---|---|---|
| 1 | João edita lead da Maria (UUID conhecido) | 0 linhas |
| 2 | João se promove a ADMIN | 0 linhas |
| 3 | João repassa lead para colega | `42501` policy violation |
| 4 | João troca `tenant_id` no payload | `42501` policy violation |
| 5 | João lê lead de outro tenant por UUID | 0 linhas |
| 6 | João cria contato em outro tenant | `42501` policy violation |
| 7 | Rafael move etapa de lead de outro tenant | `42501` sem permissão |
| 8 | João apaga histórico | `42501` permission denied |
| 9 | João escreve em `domain_events` | `42501` permission denied |
| 10 | João lê `audit_logs` | 0 linhas |
| 11 | Maria aceita lead do Pedro | `42501` não atribuído a você |
| 12 | BROKER distribui lead | `42501` apenas o administrador |

E nos agregados:

| Tentativa | Resultado |
|---|---|
| João (BROKER) abre painel executivo | `42501` |
| Beatriz (ADMIN Horizonte) abre painel da Terra Concreta | `42501` |
| João abre ranking | `42501` |

Reproduza com `supabase/tests/rls_test.sql`.

---

## Service role

`SUPABASE_SERVICE_ROLE_KEY` ignora RLS por completo. Por isso:

- Nunca entra em bundle de frontend. Não há `VITE_` para ela.
- Existe só como secret do Worker (`wrangler secret put`).
- Nenhuma função chamada com ela aceita `tenant_id` vindo do request. Na
  ingestão, o tenant é derivado da credencial (`ingest_sources.token_sha256`);
  em `expirar_assignment`, é lido do próprio registro.

`expirar_assignment` e `agency_performance` têm `EXECUTE` concedido **apenas**
a `service_role` — não existe caminho pelo navegador para nenhuma das duas.

---

## Credenciais de ingestão

`ingest_sources` guarda **só o SHA-256** do token. O valor em claro aparece uma
vez, na criação, e não é recuperável. O ADMIN consegue listar as integrações do
próprio tenant, mas o que ele lê é o hash.

O Worker calcula o SHA-256 do token recebido e passa o hash para
`ingerir_lead`. Token inválido devolve `401` genérico — sem dizer se o token não
existe ou está inativo.

---

## Verificação automática do Supabase

O advisor de segurança aponta 367 avisos no projeto. **Um** é do
`imobi_board`: `domain_events` com RLS ligada e nenhuma policy — que é o
desenho pretendido (nega todo mundo; só `SECURITY DEFINER` escreve).

Zero avisos de `function_search_path_mutable`, `anon_security_definer_function_executable`
ou `authenticated_security_definer_function_executable` neste schema.

---

## Achado fora do escopo

O mesmo advisor aponta **9 tabelas do schema `public` com RLS desativado**,
legíveis e graváveis por qualquer um com a chave `anon` pública:

```
view_imoveis_imoveis      view_imoveis_leads         view_imoveis_chat_n8n
imobiliarias              regras_automacao           view_imoveis_origens
fhn_imoveis_leads         fhn_imoveisconversas       view_imoveis_leads_imoveis
```

Três delas contêm dados de lead de cliente. **Não são do Imobi-Board** e não
foram tocadas. Ativar RLS sem antes escrever as políticas derruba o que estiver
consumindo essas tabelas, então a correção precisa ser feita por quem conhece os
consumidores.
