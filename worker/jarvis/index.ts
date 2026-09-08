/**
 * Roteador /api/jarvis/*.
 *
 * Montado em worker/entry.ts, ANTES do baseWorker -- mesmo lugar onde o
 * creative-vision ja e interceptado. O caminho /api/ai continua intocado: o
 * OpsQuestion de texto nao passa por aqui e nao muda de comportamento.
 */

import { CanalSse } from "./sse";
import { rodarAgente, pendenciaAberta, identificarUsuario, ehTimeout, SIM, NAO, MODELO } from "./agent";
import { resolverPendencia } from "./confirm";
import { transcrever } from "./stt";
import { sintetizar } from "./tts";
import { rodarRondas } from "./routines";
import { aquecerEstadoOperacional } from "./prewarm";
import { RESPOSTA_CRIADOR, perguntaDeCriador } from "./identity";
import { RESPOSTA_BLOQUEIO, avaliarPergunta, temContextoDeMidia } from "./finance-guard";
import type { EnvJarvis } from "./tools";

const MAX_JSON_BYTES = 64 * 1024;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Resposta constante pelo mesmo canal SSE do chat.
 *
 * O frontend so' sabe consumir stream; devolver JSON aqui quebraria a bolha de
 * conversa e o TTS junto. Mesmo formato do atalho de confirmacao por voz.
 */
function respostaDireta(texto: string, atalho: string): Response {
  const canal = new CanalSse();
  const resposta = new Response(canal.corpo, { headers: CanalSse.cabecalhos() });
  queueMicrotask(() => {
    canal.emitir("token", { text: texto });
    canal.emitir("done", { atalho, tool_calls: 0 });
    canal.encerrar();
  });
  return resposta;
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

export async function rotearJarvis(request: Request, env: EnvJarvis & { JARVIS_SERVICE_TOKEN?: string }, executionContext?: { waitUntil: (promise: Promise<unknown>) => void }): Promise<Response | null> {
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

  // Gate de rollout decidido aqui, e nao no navegador. O front consultava
  // user_preferences/team_roster direto no Supabase; no dominio de preview
  // esses fetches morrem no CORS, o gate reprovava e a Jarvis sumia inteira.
  // Mesma origem do app, resposta minima: so o booleano, nenhum dado de pessoa.
  if (acao === "access") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    const eu = await identificarUsuario(jwt, env);
    return json({ allowed: eu.papel === "MGMT" });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (acao === "warm") {
    const eu = await identificarUsuario(jwt, env);
    if (eu.papel !== "MGMT") return json({ ok: false, error: "forbidden" }, 403);
    const scopeKey = eu.userId ?? `${eu.papel}:${eu.pessoa}`;
    const job = aquecerEstadoOperacional(jwt, env, scopeKey).catch(() => ({ ok: false, media: 0, balances: 0 }));
    if (executionContext) executionContext.waitUntil(job); else void job;
    return json({ ok: true, started: true }, 202);
  }

  if (acao === "stt") return transcrever(request, env);

  if (acao === "tts") {
    // Mesma trava do frontend, agora do lado do servidor: a sintese custa por
    // caractere e nao pode ficar aberta a qualquer usuario autenticado so
    // porque o botao nao aparece para ele.
    const eu = await identificarUsuario(jwt, env);
    if (eu.papel !== "MGMT") {
      console.warn({ event: "jarvis_tts_negado", papel: eu.papel });
      return json({ erro: "fora_do_rollout" }, 403);
    }
    // A sintese e uma chamada paga separada da conversa. Reusa o limitador ja
    // ligado ao Worker, mas com chave propria para uma rafaga de audio nao
    // consumir o limite do chat nem permitir custo ilimitado por usuario.
    if (env.AI_RATE_LIMITER) {
      const bytes = new TextEncoder().encode(`jarvis:tts:${jwt}`);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const chave = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { success } = await env.AI_RATE_LIMITER.limit({ key: chave });
      if (!success) return json({ erro: "tts_rate_limited" }, 429);
    }
    return sintetizar(request, env);
  }

  if (acao === "confirm") {
    const corpo = await corpoJson(request);
    const actionId = String(corpo?.action_id ?? "").trim();
    const decisao = corpo?.decision === "cancel" ? "cancel" : "confirm";
    if (!actionId) return json({ ok: false, error: "action_id_obrigatorio" }, 400);
    const r = await resolverPendencia(actionId, decisao, jwt, env);
    return json(r, r.ok ? 200 : 409);
  }

  if (acao !== "chat") return json({ ok: false, error: "not_found" }, 404);

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

  // Duas respostas constantes que nao merecem uma rodada de modelo, e que o
  // modelo erraria de vez em quando se coubesse a ele: o bloqueio de dinheiro
  // interno (nao pode depender de obediencia a prompt) e a identidade do
  // criador (precisa ser o texto identico, nao uma parafrase).
  const veredicto = avaliarPergunta(mensagem);
  if (veredicto.bloqueado) {
    console.warn({ event: "jarvis_financeiro_bloqueado", motivo: veredicto.motivo, midia: temContextoDeMidia(mensagem) });
    return respostaDireta(RESPOSTA_BLOQUEIO, "bloqueio_financeiro");
  }
  if (perguntaDeCriador(mensagem)) {
    return respostaDireta(RESPOSTA_CRIADOR, "identidade_criador");
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
      const { chamadas, conversation_id } = await rodarAgente(
        {
          conversation_id: (corpo.conversation_id as string) ?? null,
          message: mensagem,
          client_id: (corpo.client_id as string) ?? null,
          voice: corpo.voice === true,
        },
        jwt, env, canal, undefined, undefined,
        executionContext ? (promise) => executionContext.waitUntil(promise) : undefined,
      );
      canal.emitir("done", {
        model: MODELO,
        tool_calls: chamadas.length,
        latency_ms: Date.now() - inicio,
        conversation_id,
      });
    } catch (erro) {
      // A mensagem tecnica fica NO LOG, nunca na tela. Foi assim que
      // "The operation was aborted due to timeout" -- texto do runtime, sem
      // nenhum contexto util para quem le -- acabou aparecendo como resposta da
      // Jarvis. O usuario recebe uma frase acionavel; o diagnostico sai no
      // console com nome e mensagem do erro.
      console.error({
        event: "jarvis_chat_falhou",
        error_name: erro instanceof Error ? erro.name : "unknown",
        error_message: erro instanceof Error ? erro.message : String(erro),
      });
      canal.emitir("error", {
        message: ehTimeout(erro)
          ? "Não consegui consultar agora. Tenta novamente em alguns segundos."
          : "Não consegui responder agora. Tenta de novo em instantes.",
      });
    } finally {
      canal.encerrar();
    }
  })();

  return resposta;
}

export { identificarUsuario };
