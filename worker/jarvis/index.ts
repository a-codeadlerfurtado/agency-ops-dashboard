/**
 * Roteador /api/jarvis/*.
 *
 * Montado em worker/entry.ts, ANTES do baseWorker -- mesmo lugar onde o
 * creative-vision ja e interceptado. O caminho /api/ai continua intocado: o
 * OpsQuestion de texto nao passa por aqui e nao muda de comportamento.
 */

import { CanalSse } from "./sse";
import { rodarAgente, pendenciaAberta, identificarUsuario, SIM, NAO, MODELO } from "./agent";
import { resolverPendencia } from "./confirm";
import { transcrever } from "./stt";
import { sintetizar } from "./tts";
import { rodarRondas } from "./routines";
import type { EnvJarvis } from "./tools";

const MAX_JSON_BYTES = 64 * 1024;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jwtDe(request: Request): string | null {
  const cabecalho = request.headers.get("authorization") ?? "";
  return cabecalho.startsWith("Bearer ") ? cabecalho.slice(7).trim() : null;
}

async function corpoJson(request: Request): Promise<Record<string, unknown> | null> {
  const declarado = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declarado) && declarado > MAX_JSON_BYTES) return null;
  try {
    const lido = await request.json();
    return lido && typeof lido === "object" && !Array.isArray(lido) ? (lido as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function rotearJarvis(request: Request, env: EnvJarvis & { JARVIS_SERVICE_TOKEN?: string }): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/jarvis" && !url.pathname.startsWith("/api/jarvis/")) return null;

  const acao = url.pathname.slice("/api/jarvis/".length).replace(/^\/+|\/+$/g, "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  // Rondas: unico caminho que nao usa JWT de usuario. Token de servico proprio.
  if (acao === "run") {
    if (request.headers.get("authorization") !== `Bearer ${env.JARVIS_SERVICE_TOKEN}` || !env.JARVIS_SERVICE_TOKEN) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    return rodarRondas(env as never);
  }

  const jwt = jwtDe(request);
  if (!jwt) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (acao === "stt") return transcrever(request, env);
  if (acao === "tts") return sintetizar(request, env);

  if (acao === "confirm") {
    const corpo = await corpoJson(request);
    const actionId = String(corpo?.action_id ?? "").trim();
    const decisao = corpo?.decision === "cancel" ? "cancel" : "confirm";
    if (!actionId) return json({ ok: false, error: "action_id_obrigatorio" }, 400);
    const r = await resolverPendencia(actionId, decisao, jwt, env);
    return json(r, r.ok ? 200 : 409);
  }

  if (acao !== "chat") return json({ ok: false, error: "not_found" }, 404);
  if (!env.AI) return json({ ok: false, error: "workers_ai_not_configured" }, 503);

  const corpo = await corpoJson(request);
  if (!corpo) return json({ ok: false, error: "invalid_json" }, 400);
  const mensagem = String(corpo.message ?? "").trim();
  if (!mensagem) return json({ ok: false, error: "message_obrigatoria" }, 400);

  if (env.AI_RATE_LIMITER) {
    const bytes = new TextEncoder().encode(`jarvis:${jwt}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const chave = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { success } = await env.AI_RATE_LIMITER.limit({ key: chave });
    if (!success) return json({ ok: false, error: "rate_limited" }, 429);
  }

  // "sim" / "nao" com pendencia aberta nao passam pelo modelo. Mandar um "sim"
  // solto para um LLM decidir o que confirmar e pedir para ele adivinhar.
  if (SIM.test(mensagem) || NAO.test(mensagem)) {
    const pendente = await pendenciaAberta(jwt, env);
    if (pendente) {
      const r = await resolverPendencia(pendente.id, SIM.test(mensagem) ? "confirm" : "cancel", jwt, env);
      const canal = new CanalSse();
      const resposta = new Response(canal.corpo, { headers: CanalSse.cabecalhos() });
      queueMicrotask(() => {
        canal.emitir("token", { text: r.result_text });
        canal.emitir("done", { atalho: "confirmacao_por_voz", ok: r.ok });
        canal.encerrar();
      });
      return resposta;
    }
  }

  const canal = new CanalSse();
  const resposta = new Response(canal.corpo, { headers: CanalSse.cabecalhos() });
  const inicio = Date.now();

  // Não await: a resposta precisa voltar agora para o stream abrir.
  void (async () => {
    try {
      const { chamadas } = await rodarAgente(
        {
          conversation_id: (corpo.conversation_id as string) ?? null,
          message: mensagem,
          client_id: (corpo.client_id as string) ?? null,
          voice: corpo.voice === true,
        },
        jwt, env, canal,
      );
      canal.emitir("done", {
        model: MODELO,
        tool_calls: chamadas.length,
        latency_ms: Date.now() - inicio,
      });
    } catch (erro) {
      canal.emitir("error", { message: erro instanceof Error ? erro.message : "falha interna" });
    } finally {
      canal.encerrar();
    }
  })();

  return resposta;
}

export { identificarUsuario };
