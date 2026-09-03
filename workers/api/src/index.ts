import { ingerir, json } from "./rotas/ingest";
import { rpc, type Env } from "./lib/db";

export { WorkflowSla } from "./sla-workflow";

interface EnvComLimite extends Env {
  /** Rate limiting nativo da Cloudflare: sem Redis, sem KV, sem custo extra. */
  LIMITE_INGEST?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  META_VERIFY_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: EnvComLimite): Promise<Response> {
    const url = new URL(req.url);
    const partes = url.pathname.split("/").filter(Boolean);

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
        if (env.LIMITE_INGEST) {
          const chave = (req.headers.get("authorization") ?? req.headers.get("x-imobi-token") ?? "anon").slice(-32);
          const { success } = await env.LIMITE_INGEST.limit({ key: chave });
          if (!success) return json({ erro: "Muitas requisicoes." }, 429);
        }

        return ingerir(req, env, integracao);
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
  },
} satisfies ExportedHandler<EnvComLimite>;

function verificarWebhookMeta(url: URL, env: EnvComLimite): Response {
  const modo = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const desafio = url.searchParams.get("hub.challenge");

  if (modo === "subscribe" && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN) {
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
