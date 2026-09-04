/**
 * CORS para as rotas que o NAVEGADOR chama.
 *
 * A maior parte deste worker é servidor-para-servidor — Meta, Zapier, o site
 * do cliente — e nada disso passa por CORS. Mas a tela de Integrações chama
 * `/v1/meta/paginas` e `/v1/meta/assinar` direto do navegador, e aí o browser
 * exige `Access-Control-Allow-Origin` na resposta.
 *
 * Sem esse cabeçalho o erro não vira status HTTP: o navegador bloqueia a
 * leitura e o fetch estoura como "Failed to fetch", sem nada no lado do
 * servidor indicando problema. Foi exatamente o sintoma relatado.
 *
 * Origem é lista, não `*`: estes endpoints agem sobre dados de uma
 * imobiliária, e liberar qualquer site para chamá-los com o cookie/nonce do
 * usuário não tem por que.
 */

const LOCAIS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function permitidas(env: { APP_URL?: string; AMBIENTE?: string }): string[] {
  const lista = [(env.APP_URL ?? "").replace(/\/+$/, "")].filter(Boolean);
  // vite dev so entra fora de producao
  if (env.AMBIENTE !== "production") lista.push(...LOCAIS);
  return lista;
}

/** Devolve os cabeçalhos de CORS quando a origem é conhecida; senão, nada. */
export function cabecalhosCors(
  req: Request,
  env: { APP_URL?: string; AMBIENTE?: string }
): Record<string, string> {
  const origem = req.headers.get("origin");
  if (!origem || !permitidas(env).includes(origem)) return {};
  return {
    "Access-Control-Allow-Origin": origem,
    // a origem varia por requisicao: sem isto um cache guardaria a resposta
    // de uma origem e serviria para outra
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization,x-imobi-token",
    "Access-Control-Max-Age": "86400",
  };
}

/** Responde o preflight. O worker devolvia 404 aqui, que o navegador le como recusa. */
export function preflight(
  req: Request,
  env: { APP_URL?: string; AMBIENTE?: string }
): Response | null {
  if (req.method !== "OPTIONS") return null;
  const h = cabecalhosCors(req, env);
  // origem desconhecida: 403 seco, sem contar o que existe do outro lado
  if (Object.keys(h).length === 0) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: h });
}

/** Acrescenta CORS a uma resposta ja pronta, sem tocar no corpo nem no status. */
export function comCors(
  resposta: Response,
  req: Request,
  env: { APP_URL?: string; AMBIENTE?: string }
): Response {
  const extras = cabecalhosCors(req, env);
  if (Object.keys(extras).length === 0) return resposta;

  const headers = new Headers(resposta.headers);
  for (const [k, v] of Object.entries(extras)) headers.set(k, v);
  return new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers,
  });
}
