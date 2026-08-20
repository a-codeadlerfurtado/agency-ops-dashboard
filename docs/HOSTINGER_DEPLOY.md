# Deploy da Central de Operações + IA na VPS Hostinger

Documento operacional. Descreve o ambiente **real** encontrado na VPS em
2026-08-20 e o procedimento de deploy, rollback e verificação.

## Ambiente encontrado (inventário 2026-08-20)

| Item | Valor |
|---|---|
| Hostname | `srv1837879.hstgr.cloud` |
| IPv4 | `179.197.228.160` |
| Plano | KVM 2 — 2 vCPU, 7.8 GiB RAM, 96 GB disco |
| SO | Ubuntu 24.04.4 LTS, kernel 6.8.0-134 |
| Local | Brasil — Campinas |
| Orquestração | **EasyPanel** (porta 3000) sobre **Docker Swarm** (1 nó) |
| Docker | 29.6.1 · Compose v5.3.0 |
| Reverse proxy | **Traefik 3.6.7**, portas 80/443 |
| Domínio curinga | `*.yb4hto.easypanel.host` |
| Swap | **0 B** |
| Firewall UFW | **inativo** |
| Node/PM2/nginx no host | ausentes — tudo roda em contêiner |

Projetos EasyPanel já existentes — **não derrubar**:

- `crm` → `crm_crm` (EasyPanel CRM)
- `agente_ia` → `evolution-api`, `evolution-api-db` (Postgres 17),
  `evolution-api-redis`, `redis`

## Provedor de IA

A Central usa **OpenAI (`gpt-5-mini`)**, o mesmo modelo e a mesma chave que o
serviço `opsquestion` já roda nesta VPS. Os dois respondem sobre o mesmo dado
operacional — modelos diferentes divergiriam entre a resposta da IA e a
evidência que o próprio OpsQuestion devolve como fonte.

A documentação anterior especificava Anthropic/Claude; a troca foi decisão do
Adler em 2026-08-20.

## Por que EasyPanel e não systemd/nginx

A VPS já padroniza Docker Swarm + Traefik. Isso entrega, sem código novo:
restart automático, HTTPS Let's Encrypt, proxy reverso, logs centralizados e
rollback por versão de imagem. Introduzir systemd + nginx ao lado disso criaria
um segundo padrão concorrente para os mesmos requisitos.

## Arquitetura de deploy

Dois serviços no **mesmo projeto** EasyPanel, atrás do **mesmo domínio** — é
isso que torna `/api/ai` same-origin e dispensa CORS:

```
Traefik (443, HTTPS)
  ├── PathPrefix(/api/ai) ──► centralops-ai   (server/, Node 22, porta 8787)
  └── /                   ──► centralops-web  (vinext,      porta 3000)
```

O navegador enxerga um único domínio. Nenhuma credencial privilegiada existe no
bundle do frontend: o browser manda apenas o `access_token` do Supabase, e o
backend resolve identidade e permissões antes de tocar em dado privado.

## Secrets (somente na VPS)

Configurar em **Environment** do serviço `centralops-ai`. Nunca no repositório,
no frontend, em log ou em screenshot.

| Variável | Observação |
|---|---|
| `SUPABASE_URL` | `https://bfzdetibfcwihfkltbkp.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | chave pública `sb_publishable_...` (a mesma do frontend) |
| `SUPABASE_SECRET_KEY` | **privada** — `sb_secret_...` (ou `service_role` legado) |
| `OPENAI_API_KEY` | **privada** |
| `OPENAI_MODEL` | `gpt-5-mini` |
| `PORT` | `8787` |
| `ALLOWED_ORIGINS` | vazio em produção (same-origin) |
| `GIT_COMMIT` | commit publicado, aparece no healthcheck |

O serviço **falha ao subir** se qualquer variável obrigatória faltar — proposital:
é melhor não subir do que subir sem saber validar um token.

## Procedimento

1. **Snapshot** da VPS pelo hPanel (Backups & Monitoring) antes de mexer.
2. No EasyPanel, criar o projeto `centralops`.
3. Criar o serviço **App** `centralops-ai`:
   - Source: GitHub `a-codeadlerfurtado/agency-ops-dashboard`, branch `feature/ai-workspace`
   - Build: Dockerfile, path `server/Dockerfile`, context `server`
   - Environment: as variáveis acima
   - Domains: domínio do projeto, **Path `/api/ai`**, porta `8787`, HTTPS ligado
4. Criar o serviço **App** `centralops-web`:
   - Mesma origem; Dockerfile na raiz, context `.`
   - Domains: mesmo domínio, Path `/`, porta `3000`, HTTPS ligado
5. Deploy dos dois e conferir o healthcheck.

## Verificação pós-deploy

```bash
curl -s https://<dominio>/api/ai/health
# {"ok":true,"service":"agency-ops-ai-server","commit":"<sha>","model":"gpt-5-mini",...}

# Sem token precisa recusar:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<dominio>/api/ai/conversations/list
# 401
```

## Rollback

O EasyPanel guarda as versões de imagem: **Deployments → versão anterior →
Redeploy**. Como o backend é stateless (todo estado vive no Supabase), voltar a
versão não perde histórico de conversa.

Se o problema for de dados, o Supabase tem backup próprio e as migrations da IA
são aditivas — nenhuma delas altera tabela pré-existente.

## Pendências de infraestrutura conhecidas

Levantadas no inventário; **não** introduzidas por este deploy:

- **UFW inativo** e sem regras no painel. Hoje 22/80/443/3000 estão expostos.
  A porta 3000 é o próprio EasyPanel — vale restringi-la por IP.
- **Swap 0 B** com 7.8 GiB de RAM. O build do frontend em contêiner é o passo
  mais pesado; se houver OOM durante o build, criar 2 GB de swap resolve.
- **21 atualizações** pendentes e *system restart required* há 33 dias.
- 2 processos zumbis.
