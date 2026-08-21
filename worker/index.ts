import handler from "vinext/server/fetch-handler";

// O site nao devolvia nenhum cabecalho de seguranca. Sem eles o navegador aceita
// coisas que o dashboard nunca deveria permitir: ser embutido num iframe de outro
// site (clickjacking - a pessoa clica achando que esta em outro lugar e aprova um
// acesso aqui), carregar script de dominio estranho se alguem conseguir injetar
// HTML, e vazar a URL interna no Referer ao clicar num link externo.
//
// A CSP e' a trava principal. Ela e' escrita como lista do que o app REALMENTE usa:
// se amanha alguem injetar <script src="site-do-atacante">, o navegador recusa,
// porque o dominio nao esta aqui.
const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";

const CSP = [
  "default-src 'self'",
  // O bundle do vinext injeta estilo inline e o React hidrata com script inline
  // marcado; sem 'unsafe-inline' aqui a tela nao pinta.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // O app nao tem nenhuma tag <img>: so' o favicon e SVG inline.
  "img-src 'self' data:",
  // Unico destino externo: o Supabase (API, auth, realtime). O OpsQuestion nao entra
  // porque o widget fala com a edge function, nao com a VPS. Qualquer outro destino
  // e' recusado pelo navegador - inclusive uma tentativa de exfiltrar dado.
  `connect-src 'self' ${SUPABASE} wss://bfzdetibfcwihfkltbkp.supabase.co`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  // HTTPS obrigatorio por 2 anos, subdominios inclusos. Impede o downgrade para
  // http em rede hostil (wifi de coworking, por exemplo).
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  // O dashboard nao usa nenhuma dessas capacidades; negar evita que um script
  // injetado peca camera ou localizacao em nome do site.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export default {
  async fetch(request: Request, env: unknown, context: unknown): Promise<Response> {
    const response = await handler.fetch(request, env, context);

    // Resposta nova porque a original pode vir com headers imutaveis (asset estatico).
    const headers = new Headers(response.headers);
    for (const [nome, valor] of Object.entries(SECURITY_HEADERS)) headers.set(nome, valor);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
