# agency-briefing-hub — CODIGO RECUPERADO, NAO E A FONTE ORIGINAL

Isto **nao** e o repositorio original do Briefing Hub. E o codigo extraido do
worker que estava publicado, em 06/09/2026, porque a fonte nao foi encontrada
em nenhum lugar desta maquina.

## De onde veio

Baixado da Cloudflare (`workers_get_worker_code`) a partir da versao em
producao. Vem como multipart de tres modulos, separados aqui sem alteracao:

| Modulo | O que e |
|---|---|
| `index.js` | o aplicativo em si, 227 mil caracteres — **intocado** |
| `home-screen-icons.js` | camada de icones e Tela de Inicio, adicionada depois |
| `home-screen-entry.js` | entrada: embrulha `index.js` com a camada acima |

## O que foi alterado

Uma coisa so, em `home-screen-icons.js`, na string `tags` da linha 28:

    + <meta name="apple-mobile-web-app-capable" content="yes">
    + <meta name="mobile-web-app-capable" content="yes">

Sem elas o iOS abre o Hub dentro do Safari, com a barra embaixo. O icone ja
funcionava; faltava so o modo tela cheia.

`apple-mobile-web-app-status-bar-style` foi deliberadamente **omitido**: o Hub
mistura telas de fundo claro e escuro e nao declara `theme-color`, entao fixar
a barra em preto poderia estragar as telas claras.

## Se a fonte original aparecer

Prefira ela. Este diretorio e uma reconstrucao a partir de codigo publicado —
serve para nao ficar sem nada, nao para virar a fonte de verdade. O que ele
tem de util e o registro do que foi mudado e por que.

## Cuidado ao publicar

Os tres secrets (`BRIEFING_SUPABASE_BRIDGE_SECRET`, `CRM_VAULT_SECRET`,
`DRIVE_BRIDGE_KEY`) nao estao no `wrangler.jsonc` e nao devem estar. Eles
sobrevivem a um deploy. O binding D1 e o `DRIVE_BRIDGE_URL` estao declarados
porque um deploy sem eles os apagaria.
