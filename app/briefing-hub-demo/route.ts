/**
 * Modo apresentação do Briefing Hub.
 *
 * Três coisas se somaram para este endereço passar semanas mostrando a coisa
 * errada, e vale registrar as três porque cada uma escondia a seguinte.
 *
 * 1. `public/briefing-hub-demo.html` ocupava este caminho. O Workers Assets
 *    resolve o arquivo estático antes do route handler, então quem abria o
 *    link via um demo antigo -- uma fotografia do produto, congelada -- e esta
 *    rota nunca era executada.
 *
 * 2. Removido o estático, a rota rodou e respondeu 502. A versão anterior dela
 *    buscava o Hub e injetava os dados fictícios aqui dentro, mas esse fetch
 *    falha: os dois Workers vivem na mesma zona
 *    `lakassessoriadigital.workers.dev`, e a Cloudflare não despacha a
 *    sub-requisição para o segundo Worker nesse caso. A apresentação montada
 *    aqui nunca funcionou; o estático só escondia isso.
 *
 * 3. Quem consegue buscar o Hub é a Edge Function do Supabase, fora dessa
 *    zona. Só que ela responde `content-type: text/plain` e
 *    `Content-Security-Policy: default-src 'none'; sandbox` -- o navegador
 *    mostra o código-fonte, e a CSP bloquearia script, estilo e fonte mesmo se
 *    renderizasse.
 *
 * Daí este formato: buscar de lá e reservir daqui com os cabeçalhos certos. A
 * injeção dos dados fictícios continua acontecendo só na Edge Function, então
 * não há duas cópias da demonstração para divergirem -- que foi exatamente o
 * problema do item 1.
 */

const APRESENTACAO =
  "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/briefing-hub-presentation";

/**
 * O Hub não declara favicon — nem aqui, nem no portal real. A aba fica com o
 * ícone genérico do navegador, o que numa apresentação aparece o tempo todo,
 * ao lado das outras abas abertas.
 *
 * Como esta rota já serve o HTML, dá para injetar o `<link>`. Corrige a
 * demonstração, não o portal: lá a mesma linha precisa entrar no `<head>` do
 * fonte do Hub, e está documentada em docs/briefing-hub-marca-na-sidebar.md.
 */
const FAVICON =
  '<link rel="icon" href="/brand/briefing-hub-favicon.svg" type="image/svg+xml">';

function comFavicon(html: string) {
  if (/<link[^>]*rel=["'][^"']*icon/i.test(html)) return html;   // já tem, não duplica
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + FAVICON);
  return html.replace(/<html[^>]*>/i, (m) => m + FAVICON);
}

const CABECALHOS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

function indisponivel(motivo: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
    `<title>Modo apresentação indisponível</title>` +
    `<body style="font:15px/1.6 system-ui;background:#0b0f16;color:#e5e7eb;padding:40px">` +
    `<h1 style="font-size:19px">Modo apresentação indisponível</h1>` +
    `<p style="color:#94a3b8">${motivo}</p>` +
    `<p style="color:#94a3b8">A origem é a Edge Function <code>briefing-hub-presentation</code>.</p>`,
    { status: 502, headers: CABECALHOS },
  );
}

export async function GET(request: Request): Promise<Response> {
  let upstream: Response;
  try {
    const destino = new URL(APRESENTACAO);
    destino.search = new URL(request.url).search;
    upstream = await fetch(destino, {
      headers: { accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
      redirect: "follow",
    });
  } catch (e) {
    // dizer o motivo: um 502 mudo foi o que tornou a falha anterior invisivel
    return indisponivel(`Falha ao buscar a apresentação: ${(e as Error).message}`);
  }

  if (!upstream.ok) {
    return indisponivel(`A apresentação respondeu ${upstream.status}.`);
  }

  const html = await upstream.text();
  if (!/<html/i.test(html)) {
    return indisponivel("A apresentação não devolveu uma página HTML.");
  }

  return new Response(comFavicon(html), { status: 200, headers: CABECALHOS });
}
