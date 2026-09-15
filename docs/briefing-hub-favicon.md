# Favicon do Briefing Hub

Os arquivos estão prontos em `public/brand/briefing-hub/` **deste** repositório.
Eles precisam ser copiados para o `public/` do repositório do Briefing Hub, que
não está acessível daqui — a busca por ele está registrada no fim deste
documento.

## Por que não foi aplicado direto no worker publicado

A MCP da Cloudflare tem `workers_get_worker_code`, mas **não tem ferramenta de
deploy**. Para reenviar o script seria preciso montar um projeto local com um
`wrangler.jsonc` inventado e rodar `wrangler deploy` sobre `agency-briefing-hub`
— o que apagaria bindings, variáveis e secrets do worker. O Hub conversa com o
Supabase (a CSP dele libera `connect-src` para
`https://bfzdetibfcwihfkltbkp.supabase.co`), então tem credenciais
configuradas. Seria derrubar o portal dos clientes para colocar um favicon.

## Arquivos

| Arquivo | Tamanho | O que é |
|---|---|---|
| `favicon.svg` | 1,9 KB | Variante reduzida da marca: duas respostas e o eixo do grafo. A marca completa vira borrão em 16px. |
| `favicon-32.png` | 1,0 KB | Rasterizado do SVG, fundo marinho `#071C3D`, 10% de respiro nas bordas. |
| `apple-touch-icon.png` | 7,5 KB | 180×180, mesmo desenho. iOS não aceita SVG aqui. |
| `favicon.ico` | 1,0 KB | PNG de 32px embrulhado em ICO. Todo navegador atual lê PNG-in-ICO, e o arquivo fica em 1 KB em vez dos ~4 KB de um BMP com máscara. |
| `manifest.webmanifest` | 447 B | `name`/`short_name` "Briefing Hub", `theme_color` `#071C3D`. |

Copiar os cinco para `public/` do Hub, na raiz — os caminhos abaixo são
absolutos e assumem isso.

## No `<head>`

```html
<title>Briefing Hub</title>
<meta name="theme-color" content="#071C3D">

<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="manifest" href="/manifest.webmanifest">
```

A ordem importa: o navegador usa o primeiro formato que entende. SVG primeiro
(escala em qualquer densidade), PNG depois, `.ico` por último como rede de
segurança para navegador antigo.

O `<title>` também entra aí. O HTML publicado hoje já tem `<title>Briefing
Hub</title>`, então esse item pode já estar resolvido — vale conferir no fonte.

## O ponto que provavelmente vai quebrar

O worker do Hub **devolve o mesmo HTML de 167 KB em qualquer caminho**.
Conferido:

```
/          200  167580 bytes  <title>Briefing Hub</title>
/cliente   200  167580 bytes  <title>Briefing Hub</title>
/staff     404
```

Ou seja: `/` e `/cliente` caem no HTML, e o resto dá 404. Se `/favicon.svg`
cair na mesma regra do SPA, o navegador vai receber HTML com
`content-type: text/html` no lugar do ícone e **descartar em silêncio** — o
sintoma é exatamente "coloquei o favicon e não apareceu".

Então o roteamento do worker precisa servir esses cinco caminhos como arquivo,
antes de qualquer fallback, com o content-type certo:

| Caminho | `content-type` |
|---|---|
| `/favicon.svg` | `image/svg+xml` |
| `/favicon-32.png` | `image/png` |
| `/apple-touch-icon.png` | `image/png` |
| `/favicon.ico` | `image/x-icon` |
| `/manifest.webmanifest` | `application/manifest+json` |

Se o Hub usar Workers Assets, basta os arquivos estarem em `public/` e o
`not_found_handling` não engolir extensões conhecidas. Se o worker montar as
respostas à mão, cada caminho precisa de um `case`.

## Conferência depois do deploy

```bash
for f in favicon.svg favicon-32.png apple-touch-icon.png favicon.ico manifest.webmanifest; do
  curl -sI "https://agency-briefing-hub.lakassessoriadigital.workers.dev/$f" \
    | grep -iE "^HTTP|^content-type"
done
```

Qualquer linha que devolva `text/html` significa que caiu no fallback do SPA e
o ícone não vai aparecer, mesmo com o `<link>` correto.

Cache: o Chrome guarda favicon com agressividade e não respeita `Ctrl+F5` para
esse recurso. **Confira em aba anônima**, ou abra a URL do ícone direto antes de
abrir o site.

## Dashboard interno

`agency-ops-dashboard` é build separado e tem identidade própria — o ícone da
aba dele é a marca do Agency Ops, não a do Briefing Hub. A aba "Briefings" é
uma área dentro desse produto (`app/briefing-staff-bridge.tsx`), não uma
instância do Hub. Trocar o favicon do dashboard inteiro por causa de uma aba
seria errado; foi deixado como está.

## Onde o fonte do Hub foi procurado

- `agency-ops-dashboard`, `centralops-ai`, `imobi-board` — busca por
  `bh-side-logo` e `applyClientIdentity`, strings que só existem no Hub
- `Downloads` e `Documents`, qualquer tipo de arquivo
- Repos públicos de `a-codeadlerfurtado` — 8, nenhum é o Hub
- Metadados do worker na Cloudflare — não registram origem
- `gh` CLI — não instalado

O repositório é privado. Extrair o token do Git para listar repos privados não
foi feito de propósito.
