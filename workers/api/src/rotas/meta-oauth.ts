import { rpc, type Env } from "../lib/db";
import { json } from "./ingest";

/**
 * Conexao com a Meta por login, no lugar de copiar token na mao.
 *
 * O ponto de seguranca do desenho: a Meta devolve o `code` AQUI, no worker,
 * nunca no navegador. O worker troca o code por token, lista as paginas e
 * grava tudo no banco. O navegador so recebe de volta a lista de NOMES. O
 * token de pagina nasce e morre no servidor.
 *
 * Precisa de tres coisas que so o dono da conta Meta pode providenciar:
 *   META_APP_ID      (publico, tambem vai no frontend)
 *   META_APP_SECRET  (secret do worker)
 *   App Review aprovado para `leads_retrieval` -- sem isso a Meta recusa a
 *   permissao para qualquer conta que nao seja de desenvolvedor do app.
 */

// v26.0: mesma versao em que o webhook do app foi assinado. Manter as duas
// pontas na mesma versao evita diferenca de formato de payload entre elas.
const GRAPH = "https://graph.facebook.com/v26.0";

/**
 * Sem a chave de servico o worker nao fala com o banco, e todo erro daqui sai
 * disfarçado de outra coisa — 401 do PostgREST vira "autorizacao expirada" e
 * manda a pessoa mexer no token, que nao e o problema. Melhor dizer na cara.
 */
function semChaveDeServico(env: EnvMeta): Response | null {
  if (env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return json({
    erro: "O servidor ainda nao tem a chave de servico do Supabase " +
          "(SUPABASE_SERVICE_ROLE_KEY). Enquanto ela faltar, nada que dependa " +
          "do banco funciona -- inclusive esta importacao.",
  }, 503);
}

export interface EnvMeta extends Env {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  /** para onde devolver o navegador depois do login */
  APP_URL?: string;
}

interface PaginaDaMeta {
  id: string;
  name: string;
  access_token: string;
}

/** Onde o navegador volta a cair depois do dialogo da Meta. */
function voltarPara(env: EnvMeta, params: Record<string, string>): Response {
  const base = (env.APP_URL ?? "").replace(/\/+$/, "");
  const q = new URLSearchParams(params).toString();
  return Response.redirect(`${base}/#/integracoes?${q}`, 302);
}

/**
 * GET /v1/meta/oauth
 *
 * A Meta chama aqui com ?code=&state=. Tudo que der errado volta para a tela
 * como mensagem legivel: quem esta conectando nao deve cair num JSON de erro.
 */
export async function callbackOAuth(url: URL, env: EnvMeta): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const erroMeta = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (erroMeta) return voltarPara(env, { meta: "erro", motivo: erroMeta });
  if (!state || !code) return voltarPara(env, { meta: "erro", motivo: "Autorizacao incompleta." });

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return voltarPara(env, {
      meta: "erro",
      motivo: "O servidor esta sem a chave de servico do Supabase; a conexao nao pode ser salva.",
    });
  }

  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    return voltarPara(env, {
      meta: "erro",
      motivo: "O aplicativo Meta nao esta configurado neste ambiente.",
    });
  }

  try {
    // 1. code -> token de usuario (curta duracao)
    const redirect = `${new URL(url.href).origin}/v1/meta/oauth`;
    const troca = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${env.META_APP_ID}` +
      `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&code=${encodeURIComponent(code)}`
    );
    const dadosTroca = await troca.json() as { access_token?: string; error?: { message?: string } };
    if (!troca.ok || !dadosTroca.access_token) {
      throw new Error(dadosTroca.error?.message ?? "Nao foi possivel validar o login.");
    }

    // 2. curta -> longa duracao, para o token nao morrer em duas horas
    const longa = await fetch(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${env.META_APP_ID}` +
      `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(dadosTroca.access_token)}`
    );
    const dadosLonga = await longa.json() as { access_token?: string };
    const tokenUsuario = dadosLonga.access_token ?? dadosTroca.access_token;

    // 3. paginas que a pessoa administra, cada uma com o proprio token
    const contas = await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token&limit=100` +
      `&access_token=${encodeURIComponent(tokenUsuario)}`
    );
    const dadosContas = await contas.json() as { data?: PaginaDaMeta[]; error?: { message?: string } };
    if (!contas.ok) {
      throw new Error(dadosContas.error?.message ?? "Nao foi possivel listar as paginas.");
    }
    const paginas = dadosContas.data ?? [];
    if (paginas.length === 0) {
      return voltarPara(env, {
        meta: "vazio",
        motivo: "Nenhuma pagina encontrada nessa conta do Facebook.",
      });
    }

    // 4. guarda no banco. O state e de uso unico e morre aqui.
    const r = await rpc<{ paginas: number }>(env, "salvar_paginas_da_meta", {
      p_state: state,
      p_paginas: paginas,
    });

    return voltarPara(env, { meta: "ok", paginas: String(r?.paginas ?? paginas.length) });
  } catch (e) {
    console.error(JSON.stringify({
      evento: "meta.oauth_falhou",
      erro: e instanceof Error ? e.message : String(e),
    }));
    return voltarPara(env, {
      meta: "erro",
      motivo: e instanceof Error ? e.message : "Falha ao conectar com a Meta.",
    });
  }
}

/**
 * POST /v1/meta/paginas?n=<state>
 *
 * Caminho do token de usuario de sistema da Business Manager: em vez de login,
 * o ADMIN cola um token que ja tem acesso as paginas dos clientes da BM. O
 * worker usa esse token para listar as paginas e guarda cada page token.
 *
 * Vale a pena porque nao depende de App Review: a Meta so exige revisao para
 * usar permissao em nome de quem nao tem papel no aplicativo, e um usuario de
 * sistema da mesma BM do app pode ter papel nele.
 *
 * UMA pagina, buscada por id. Este fluxo ja listou tudo que o token enxerga
 * (/me/accounts + client_pages da BM) e isso estava errado: o token de uma
 * agencia alcanca as paginas de todos os clientes dela, e a lista aparecia
 * inteira para o admin de uma imobiliaria so. Pedir o id custa um campo a
 * mais e nao expoe carteira alheia.
 *
 * O login do Facebook (callbackOAuth, acima) continua listando -- la a pessoa
 * entra com a conta dela e as paginas listadas sao dela mesma.
 */
export async function listarPaginas(url: URL, env: EnvMeta): Promise<Response> {
  const state = url.searchParams.get("n");
  if (!state) return json({ erro: "Autorizacao ausente." }, 400);

  const falta = semChaveDeServico(env);
  if (falta) return falta;

  let token: string | null;
  try {
    token = await rpc<string | null>(env, "token_de_sistema", { p_state: state });
  } catch (e) {
    // Distinguir os dois casos importa: "autorizacao expirada" manda a pessoa
    // salvar o token de novo, e se o problema for outro ela repete para sempre.
    const msg = e instanceof Error ? e.message : String(e);
    if (/Autorizacao expirada/i.test(msg)) {
      return json({ erro: "Autorizacao expirada. Salve o token de novo." }, 403);
    }
    return json({ erro: `Nao foi possivel falar com o banco: ${msg}` }, 502);
  }
  if (!token) return json({ erro: "Nenhum token de sistema salvo." }, 409);

  // Uma pagina, informada por id -- e nao a lista do que o token enxerga.
  //
  // O token de uma agencia enxerga as paginas de TODOS os clientes dela.
  // Listar isso devolveria para o admin de uma imobiliaria o nome de todas as
  // outras. Pedir o id troca uma comodidade por nao vazar carteira alheia.
  const pageId = (url.searchParams.get("page_id") ?? "").trim();
  if (!pageId) {
    return json({ erro: "Informe o ID da pagina do Facebook." }, 400);
  }
  if (!/^\d{5,25}$/.test(pageId)) {
    return json({
      erro: "ID da pagina invalido: e so numero, sem espaco nem URL. " +
            "Voce encontra em Configuracoes da Pagina > Sobre.",
    }, 400);
  }

  try {
    const r = await fetch(
      `${GRAPH}/${encodeURIComponent(pageId)}?fields=id,name,access_token` +
      `&access_token=${encodeURIComponent(token)}`
    );
    const p = await r.json() as PaginaDaMeta & {
      error?: { message?: string; code?: number };
    };

    // Os dois jeitos de a Meta dizer "esse token nao manda nessa pagina":
    //
    //  - erro 100 / "does not exist, cannot be loaded due to missing
    //    permissions" -- o mesmo texto para id errado e para falta de acesso,
    //    de proposito, para nao revelar se a pagina existe;
    //  - resposta 200 com id e nome, mas SEM access_token -- acontece quando
    //    a conta de anuncios foi atribuida ao usuario de sistema e a Pagina
    //    nao. E o tropeco mais comum desta configuracao.
    //
    // Na pratica os dois pedem a mesma acao, entao a mensagem e uma so. O
    // texto original da Meta vai junto como detalhe, senao fica impossivel
    // diagnosticar o caso raro.
    const semAcesso = !r.ok || !p?.id || !p.access_token;
    if (semAcesso) {
      const daMeta = p?.error?.message;
      return json({
        erro: "Pagina nao esta atribuida ao usuario de sistema na BM. " +
              "Em Configuracoes do Negocio > Usuarios de sistema, atribua a " +
              "PAGINA (nao apenas a conta de anuncios) e gere o token de novo.",
        detalhe: daMeta ?? (p?.id ? "A Meta devolveu a pagina sem token de acesso." : undefined),
      }, 409);
    }

    const salvo = await rpc<{ paginas: number }>(env, "salvar_paginas_da_meta", {
      p_state: state,
      p_paginas: [{ id: p.id, name: p.name, access_token: p.access_token }],
    });
    return json({ ok: true, paginas: salvo?.paginas ?? 1, nome: p.name });
  } catch (e) {
    return json({ erro: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/**
 * POST /v1/meta/assinar?n=<nonce>
 *
 * Inscreve a pagina no webhook do app. O nonce e emitido pelo banco quando o
 * ADMIN escolhe a pagina, e vale uma vez -- e o que autoriza esta chamada sem
 * o worker precisar entender sessao de usuario.
 */
export async function assinarPagina(url: URL, env: EnvMeta): Promise<Response> {
  const nonce = url.searchParams.get("n");
  if (!nonce) return json({ erro: "Autorizacao ausente." }, 400);

  const falta = semChaveDeServico(env);
  if (falta) return falta;

  let fonte: { id: string; page_id: string; page_access_token: string };
  try {
    fonte = await rpc(env, "fonte_para_assinar", { p_nonce: nonce });
  } catch {
    return json({ erro: "Autorizacao expirada. Refaca a conexao." }, 403);
  }
  if (!fonte?.page_id || !fonte.page_access_token) {
    return json({ erro: "Conexao sem pagina ou sem token." }, 409);
  }

  try {
    // Formulario, e nao JSON: a Graph aceita JSON em algumas bordas e ignora
    // em outras, e `subscribed_apps` e das antigas. Form-encoded e o formato
    // que a documentacao usa e o que se comporta igual em todas as versoes.
    const corpoDaAssinatura = new URLSearchParams({
      subscribed_fields: "leadgen",
      access_token: fonte.page_access_token,
    });

    const r = await fetch(
      `${GRAPH}/${encodeURIComponent(fonte.page_id)}/subscribed_apps`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: corpoDaAssinatura.toString(),
      }
    );
    const corpo = await r.json() as { success?: boolean; error?: { message?: string } };
    if (!r.ok || corpo.success === false) {
      const msg = corpo.error?.message ?? `Meta respondeu ${r.status}`;
      await rpc(env, "marcar_assinada", { p_id: fonte.id, p_erro: msg });
      return json({ erro: msg }, 502);
    }

    await rpc(env, "marcar_assinada", { p_id: fonte.id, p_erro: null });
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rpc(env, "marcar_assinada", { p_id: fonte.id, p_erro: msg }).catch(() => {});
    return json({ erro: msg }, 502);
  }
}

/**
 * Webhook do app (uma URL para todas as imobiliarias).
 *
 * Com login, a Meta nao aceita uma URL por conexao: e uma por APP. O destino
 * de cada aviso sai do page_id que vem dentro do proprio evento.
 */
export function verificarWebhookDoApp(url: URL, env: EnvMeta): Response {
  const modo = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const desafio = url.searchParams.get("hub.challenge");

  if (modo === "subscribe" && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN) {
    return new Response(desafio ?? "", { status: 200 });
  }
  return json({ erro: "Verificacao recusada." }, 403);
}

/** Descobre a qual conexao pertence um page_id. */
export async function fonteDaPagina(
  env: EnvMeta,
  pageId: string
): Promise<{ token_sha256: string; page_access_token: string | null } | null> {
  try {
    return await rpc(env, "fonte_da_pagina", { p_page_id: pageId });
  } catch {
    return null;
  }
}
