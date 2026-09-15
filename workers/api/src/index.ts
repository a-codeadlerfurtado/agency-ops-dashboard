import { ingerir, json, tokenDoRequest, webhookDoApp } from "./rotas/ingest";
import {
  assinarPagina, callbackOAuth, listarPaginas, verificarWebhookDoApp, type EnvMeta,
} from "./rotas/meta-oauth";
import { rpc, sha256Hex, type Env } from "./lib/db";
import { comCors, preflight } from "./lib/cors";
import { trocarCodigoImobia, verificarAssinaturaImobia, encaminharWebhookWhatsAppImobia, type EnvImobiaMetaBroker } from "./rotas/imobia-meta-broker";

export { WorkflowSla } from "./sla-workflow";

interface EnvComLimite extends EnvMeta, EnvImobiaMetaBroker {
  /** Rate limiting nativo da Cloudflare: sem Redis, sem KV, sem custo extra. */
  LIMITE_INGEST?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  META_VERIFY_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: EnvComLimite): Promise<Response> {
    // O preflight vem antes de tudo: nao passa por rota nem por autorizacao,
    // e o worker respondia 404 nele, que o navegador le como recusa.
    const antes = preflight(req, env);
    if (antes) return antes;

    // O CORS entra num lugar so, na saida. Espalhar cabecalho por rota
    // garantiria esquecer de alguma -- foi assim que este bug nasceu.
    return comCors(await rotear(req, env), req, env);
  },
} satisfies ExportedHandler<EnvComLimite>;

async function rotear(req: Request, env: EnvComLimite): Promise<Response> {
  const url = new URL(req.url);
  const partes = url.pathname.split("/").filter(Boolean);

  {
    try {
      // ---------------------------------------------------------- saude
      if (url.pathname === "/health") {
        return json({ ok: true, servico: "imobi-board-worker", ambiente: env.AMBIENTE });
      }

      // ------------------------------------------- POST /v1/ingest/leads/:x
      if (partes[0] === "v1" && partes[1] === "ingest" && partes[2] === "leads" && partes[3]) {
        const integracao = partes[3];

        // Handshake do webhook da Meta (GET com hub.challenge).
        if (req.method === "GET") {
          return verificarWebhookMeta(url, env);
        }
        if (req.method !== "POST") {
          return json({ erro: "Metodo nao permitido." }, 405);
        }

        // Rate limit por credencial, nao por IP: a Meta chama de muitos IPs, e
        // limitar por IP puniria o cliente certo e deixaria passar o errado.
        // Le pela mesma funcao da ingestao: a Meta manda o token na URL, e
        // olhar so o header jogaria todas as imobiliarias no balde "anon".
        if (env.LIMITE_INGEST) {
          const chave = (tokenDoRequest(req) ?? "anon").slice(-32);
          const { success } = await env.LIMITE_INGEST.limit({ key: chave });
          if (!success) return json({ erro: "Muitas requisicoes." }, 429);
        }

        return ingerir(req, env, integracao);
      }

      // ------------------------------------------- broker Meta da ImoBia
      if (url.pathname === "/internal/imobia/meta/exchange") {
        return trocarCodigoImobia(req, env);
      }
      if (url.pathname === "/internal/imobia/meta/verify-signature") {
        return verificarAssinaturaImobia(req, env);
      }

      // ------------------------------------------- conexao com a Meta
      if (partes[0] === "v1" && partes[1] === "meta") {
        // retorno do dialogo de login
        if (partes[2] === "oauth") return callbackOAuth(url, env);

        // lista as paginas usando o token de sistema da BM
        if (partes[2] === "paginas" && req.method === "POST") {
          return listarPaginas(url, env);
        }

        // inscricao da pagina no webhook, autorizada por nonce de uso unico.
        // "testar" e a mesma coisa: reassina e confere o acesso a leads, entao
        // testar tambem conserta uma inscricao que tenha caido.
        if ((partes[2] === "assinar" || partes[2] === "testar") && req.method === "POST") {
          return assinarPagina(url, env);
        }

        // webhook do app: uma URL para todas as imobiliarias
        if (partes[2] === "webhook") {
          if (req.method === "GET") return verificarWebhookDoApp(url, env);
          if (req.method === "POST") {
            const wpp = await encaminharWebhookWhatsAppImobia(req.clone(), env);
            if (wpp) return wpp;
            return webhookDoApp(req, env);
          }
          return json({ erro: "Metodo nao permitido." }, 405);
        }
      }

      // ------------------- GET /internal/agency/tenants/:id/performance
      // Contrato do bridge com o dashboard da agencia (spec 55). Existe, e
      // autenticado, e NAO esta conectado a producao nenhuma.
      if (partes[0] === "internal" && partes[1] === "agency" &&
          partes[2] === "tenants" && partes[3] && partes[4] === "performance") {
        return performanceDaAgencia(req, env, partes[3], url);
      }

      return json({ erro: "Rota nao encontrada." }, 404);
    } catch (e) {
      // Erro tecnico fica no log; o cliente recebe algo utilizavel (spec 106).
      console.error(JSON.stringify({
        evento: "worker.erro_nao_tratado",
        rota: url.pathname,
        erro: e instanceof Error ? e.message : String(e),
      }));
      return json({ erro: "Erro interno." }, 500);
    }
  }
}

/**
 * Handshake de verificacao da Meta.
 *
 * A pessoa cola a URL de callback (que ja carrega ?k=<token>) e, no campo
 * "Token de verificacao", o MESMO token. Um valor so para copiar, em vez de
 * dois segredos diferentes -- era o pedido de "facil".
 *
 * Os dois lados sao checados: o token tem que bater com o da URL e tem que
 * existir como fonte ativa no banco. Sem a segunda checagem a Meta diria
 * "conectado" para um token que ja foi regerado aqui, e o ADMIN so descobriria
 * quando o lead nao chegasse.
 */
async function verificarWebhookMeta(url: URL, env: EnvComLimite): Promise<Response> {
  const modo = url.searchParams.get("hub.mode");
  const informado = url.searchParams.get("hub.verify_token");
  const desafio = url.searchParams.get("hub.challenge");
  const daUrl = url.searchParams.get("k");

  if (modo !== "subscribe" || !informado) {
    return json({ erro: "Verificacao recusada." }, 403);
  }

  // caminho por fonte: o token da URL e o do campo precisam ser o mesmo
  if (daUrl && informado === daUrl) {
    try {
      const ativa = await rpc<boolean>(env, "fonte_ativa", {
        p_token_sha256: await sha256Hex(daUrl),
      });
      if (ativa) return new Response(desafio ?? "", { status: 200 });
      return json({ erro: "Conexao nao encontrada ou desativada no Imobi-Board." }, 403);
    } catch {
      return json({ erro: "Nao foi possivel validar a conexao agora." }, 503);
    }
  }

  // compatibilidade: instalacao antiga com um verify token global no worker
  if (env.META_VERIFY_TOKEN && informado === env.META_VERIFY_TOKEN) {
    return new Response(desafio ?? "", { status: 200 });
  }

  return json({ erro: "Verificacao recusada." }, 403);
}

interface Performance {
  leads: number; contacted: number; qualified: number;
  visits: number; proposals: number; sales: number; vgv: number | null;
  breakdown: { campaign: unknown[]; adset: unknown[]; ad: unknown[] };
}

async function performanceDaAgencia(
  req: Request, env: EnvComLimite, tenantId: string, url: URL
): Promise<Response> {
  const auth = req.headers.get("authorization");
  const esperado = env.AGENCY_BRIDGE_TOKEN;

  if (!esperado) {
    return json({ erro: "Bridge da agencia nao configurado neste ambiente." }, 503);
  }
  if (!auth?.startsWith("Bearer ") || !comparacaoConstante(auth.slice(7), esperado)) {
    return json({ erro: "Nao autorizado." }, 401);
  }

  const dias = Number(url.searchParams.get("dias") ?? 30);
  const desde = new Date(Date.now() - Math.min(Math.max(dias, 1), 365) * 86_400_000);

  const dados = await rpc<Performance>(env, "agency_performance", {
    p_tenant_id: tenantId,
    p_desde: desde.toISOString(),
  });

  return json(dados);
}

/** Comparacao em tempo constante: nao entrega o token por timing. */
function comparacaoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}
