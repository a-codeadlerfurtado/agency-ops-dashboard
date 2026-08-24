# Agency Ops Dashboard

Dashboard "Central de Operações" — frontend em Vinext (Vite + React Server Components)
nativo para Cloudflare Workers, backend em Supabase (Postgres, Auth, Edge Functions).

## Stack
- `vinext` (framework baseado em Vite que reimplementa a API do Next.js), React 19 RSC
- Deploy: Cloudflare Workers (`wrangler.jsonc`, `worker/index.ts`)
- Backend: Supabase — projeto `bfzdetibfcwihfkltbkp` (Postgres + Auth + Edge Functions,
  schema `agency_ops`)

## Desenvolvimento local
```
npm install
npm run dev
```

## Build
```
npm run build
```
Gera `dist/client` (estático) e `dist/server` (Cloudflare Worker).

## Deploy
Configurado para deploy automático via Cloudflare Workers Builds (integração Git),
a cada push na branch principal.

## Edge Functions e migrações
As pastas `supabase/functions` e `supabase/migrations` são cópias de referência do que
já está em produção no projeto Supabase — não é necessário reaplicar as migrações
(confirmado já aplicadas em produção via `list_migrations`).

<!-- deploy trigger -->


<!-- deploy trigger: initial Cloudflare Workers build -->
<!-- deploy trigger: production worker aligned 2026-08-20T12:16-03:00 -->
<!-- deploy trigger: commercial-direction-v2 2026-08-24 -->
<!-- deploy trigger: leonardo-executive-home 2026-08-24T12:40-03:00 -->
