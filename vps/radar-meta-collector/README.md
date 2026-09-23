# Radar Meta Collector

Coletor self-hosted e read-only para o Radar de Anuncios.

- Fonte: Meta Ads Library publica.
- Backend: `@thenavidm/facebook-ad-library-mcp@0.4.0` (browser backend).
- Nao exige conta Meta, Ads Library API, Foreplay ou Apify.
- `/health` e publico; `/search` e `/advertisers` exigem `Authorization: Bearer <RADAR_COLLECTOR_TOKEN>`.
- Busca limitada a anuncios ativos, pais informado (o Radar usa BR) e no maximo 30 resultados por chamada.
- Nao tenta resolver/burlar CAPTCHA. Falhas e rate limits devem ser tratados pelo worker como falha recuperavel.
- Segredos ficam apenas no ambiente/VPS e Supabase, nunca no repositorio.

## Runtime atual

O container de producao deve ser executado isolado, com limites conservadores:

- CPU: 0.75
- RAM: 1536 MB
- shm: 512 MB
- restart: unless-stopped
- rede: easypanel
- HTTPS via Traefik

Variaveis:

- `RADAR_COLLECTOR_TOKEN`
- `PORT=8788`

O Supabase usa adicionalmente `RADAR_COLLECTOR_URL`.
