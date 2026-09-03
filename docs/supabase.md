# Supabase

## Onde o Imobi-Board vive

Projeto: **imobi-pro** (`bfzdetibfcwihfkltbkp`), organizacao LAK, regiao
`us-east-2`, PostgreSQL 17.6.

Este projeto **nao e exclusivo do Imobi-Board**. O schema `public` tem ~200
tabelas de outros sistemas da agencia, com dados reais em producao. O
Imobi-Board ocupa dois schemas proprios e nao toca em nada fora deles:

| Schema | Exposto ao PostgREST | Conteudo |
|---|---|---|
| `imobi_board` | sim (ver abaixo) | 15 tabelas do produto |
| `imobi_board_priv` | **nao** | helpers SECURITY DEFINER |

## Passo obrigatorio: expor o schema

O PostgREST so responde por schemas listados em `pgrst.db_schemas`. Sem isso o
frontend recebe:

```
PGRST106  Invalid schema: imobi_board
```

Duas formas de resolver, ambas aditivas:

**Dashboard** — Settings > API > Exposed schemas > adicionar `imobi_board`.

**SQL** — preserva a lista atual inteira:

```sql
alter role authenticator set pgrst.db_schemas =
  'public, graphql_public, storage, agency_ops, crm, sdr_monitor, imobi_board';
notify pgrst, 'reload config';
```

Cuidado: essa configuracao vale para a API do projeto **inteiro**. Errar a lista
derruba `agency_ops` e `crm`, que estao em producao. Copie a lista existente e
apenas acrescente ao final.

## Chaves

| Chave | Onde pode aparecer |
|---|---|
| `anon` / `publishable` | frontend, bundle publico |
| `service_role` | **somente** secret do Worker |

A `anon` sozinha nao abre nada: o papel `anon` nao tem `USAGE` no schema.

## Auth

Usa `auth.users` do Supabase. O vinculo com a imobiliaria e `memberships`, no
schema do produto — `auth.users` fica intacto.

Ao semear usuarios por SQL, as colunas de token do `auth.users`
(`confirmation_token`, `recovery_token`, `email_change`, ...) precisam ser
string vazia, nunca `NULL`. Com `NULL` o GoTrue responde
`500 Database error querying schema` no login. Cada usuario tambem precisa de
uma linha em `auth.identities` com provider `email`.

## Extensoes

`pgcrypto` e `uuid-ossp` ja estavam instaladas, no schema `extensions`. O
Imobi-Board usa `extensions.digest` para o hash das credenciais de ingestao e
`gen_random_uuid()` nativo do PG17 para chaves.

Nenhuma extensao nova foi instalada.
