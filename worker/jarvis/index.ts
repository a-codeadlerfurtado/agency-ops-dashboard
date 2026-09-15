/**
 * Roteador /api/jarvis/*.
 *
 * Montado em worker/entry.ts, ANTES do baseWorker -- mesmo lugar onde o
 * creative-vision ja e interceptado. O caminho /api/ai continua intocado: o
 * OpsQuestion de texto nao passa por aqui e nao muda de comportamento.
 */

import { CanalSse } from "./sse";
import { rodarAgente, pendenciaAberta, identificarUsuario, aquecerContextoLeve, ehTimeout, SIM, NAO, MODELO } from "./agent";
import { resolverPendencia } from "./confirm";
import { transcrever } from "./stt";
import { sintetizar } from "./tts";
import { rodarRondas } from "./routines";
import { aquecerEstadoOperacional } from "./prewarm";
import { RESPOSTA_CRIADOR, perguntaDeCriador } from "./identity";
import { RESPOSTA_BLOQUEIO, avaliarPergunta, temContextoDeMidia } from "./finance-guard";
import { ehSaudacao, respostaSaudacao } from "./smalltalk";
import { resolverClienteMencionado } from "./memory";
import { carregarMidiaClienteDia } from "./state";
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
    canal.emitir("speech_ready", { text: texto });
    canal.emitir("done", { atalho, tool_calls: 0 });
    canal.encerrar();
  });
  return resposta;
}

function dataBrasilia(offsetDays = 0): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const d = new Date(Date.UTC(n("year"), n("month") - 1, n("day") + offsetDays));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function detectarMidiaObjetiva(mensagem: string): { metric: "leads" | "spend" | "cpl"; date: string; rotulo: "hoje" | "ontem" } | null {
  const q = mensagem.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const rotulo = /\bontem\b/.test(q) ? "ontem" as const : /\bhoje\b/.test(q) ? "hoje" as const : null;
  if (!rotulo) return null;
  const metric = /\b(cpl|custo por lead)\b/.test(q) ? "cpl" as const
    : /\b(leads?|contatos?)\b/.test(q) ? "leads" as const
    : /\b(gastou|gasto|investimento|investiu|spend)\b/.test(q) ? "spend" as const
    : null;
  if (!metric) return null;
  return { metric, date: dataBrasilia(rotulo === "ontem" ? -1 : 0), rotulo };
}

async function consultarMidiaObjetiva(mensagem: string, date: string, jwt: string, env: EnvJarvis): Promise<any | null> {
  // Se o warm-lite terminou enquanto o usuario falava, resolve o cliente no KV e
  // consulta o snapshot por UUID. Evita a resolucao fuzzy no banco no caminho quente.
  let sub = ""; try { const b=jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"); sub=String(JSON.parse(atob(b))?.sub ?? ""); } catch {}
  if (sub && env.JARVIS_CACHE) {
    const clientes = await env.JARVIS_CACHE.get(`jarvis:clientes:v2:${sub}`, "json").catch(() => null);
    if (Array.isArray(clientes)) {
      const cliente = resolverClienteMencionado(mensagem, clientes as any[]);
      if (cliente?.client_id) { const direto = await carregarMidiaClienteDia(cliente.client_id, date, jwt, env).catch(() => null); if (direto?.ok) return direto; }
    }
  }
  const r = await fetch("https://bfzdetibfcwihfkltbkp.supabase.co/rest/v1/rpc/jarvis_direct_media_query_snapshot", {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`, apikey: env.SUPABASE_ANON_KEY ?? "",
      "content-type": "application/json", "content-profile": "agency_ops", accept: "application/json",
    },
    body: JSON.stringify({ p_query: mensagem, p_date: date }),
    signal: AbortSignal.timeout(4_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  return r.json().catch(() => null);
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

  // Relato Desktop Agent: permite STT com o token proprio do dispositivo,
  // validado no backend do Relato antes de gastar Workers AI. Nenhum segredo
  // de infraestrutura e distribuido no executavel.
  if (acao === "stt" && request.method === "POST") {
    const authHeader = request.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const deviceToken = (request.headers.get("x-meeting-device-token") ?? bearerToken).trim();
    if (deviceToken) {
      const probe = await fetch("https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api", {
        method: "POST",
        headers: { "content-type": "application/json", "x-meeting-device-token": deviceToken },
        body: JSON.stringify({ action: "device_probe" }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (!probe?.ok) return json({ ok: false, error: "invalid_relato_device" }, 401);
      return transcrever(request, env);
    }
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

  if (acao === "warm-lite") {
    const job = aquecerContextoLeve(jwt, env).catch(() => ({ ok: false, role: "UNASSIGNED" }));
    if (executionContext) executionContext.waitUntil(job); else void job;
    return json({ ok: true, started: true }, 202);
  }

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

  // Saudacao responde aqui, antes de identidade, clientes, conversa e modelo.
  // Dizer "nao consegui consultar agora" para um "oi" e' falha basica: nada
  // precisa ser consultado. Tambem sobrevive ao backend operacional fora do ar.
  if (ehSaudacao(mensagem)) {
    // Sem identificarUsuario de proposito: ele custa uma ida a profile-lite com
    // teto de 8s, e a meta aqui e' resposta praticamente instantanea. O nome
    // proprio seria simpatico, nao vale 8 segundos nem um ponto de falha.
    return respostaDireta(respostaSaudacao(mensagem), "saudacao");
  }

  // Métricas objetivas de mídia para hoje/ontem não precisam montar conversa,
  // catálogo, contexto de LLM nem chamar a Meta ao vivo. A RPC valida o usuário
  // e o escopo no próprio banco e lê o snapshot diário canônico. Isso elimina o
  // caminho que estava estourando timeout para perguntas simples como
  // "quantos leads o Caio Montenegro teve ontem?".
  const midiaObjetiva = detectarMidiaObjetiva(mensagem);
  if (midiaObjetiva) {
    const snap = await consultarMidiaObjetiva(mensagem, midiaObjetiva.date, jwt, env);
    if (snap?.ok === true) {
      const nome = String(snap.display_name ?? "O cliente");
      let texto = "";
      if (midiaObjetiva.metric === "leads") {
        const leads = Number(snap.leads ?? 0);
        texto = `${nome} teve ${leads} ${leads === 1 ? "lead" : "leads"} ${midiaObjetiva.rotulo}.`;
      } else if (midiaObjetiva.metric === "spend") {
        const spend = Number(snap.spend ?? 0);
        texto = `${nome} gastou ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(spend)} ${midiaObjetiva.rotulo}.`;
      } else {
        const cpl = snap.cpl === null || snap.cpl === undefined ? null : Number(snap.cpl);
        texto = cpl === null
          ? `${nome} não teve CPL calculável ${midiaObjetiva.rotulo}.`
          : `O CPL de ${nome} ${midiaObjetiva.rotulo} foi ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cpl)}.`;
      }
      return respostaDireta(texto, "snapshot_midia_direto");
    }
    if (snap?.error === "no_data") {
      return respostaDireta(`Não encontrei dados consolidados desse cliente para ${midiaObjetiva.rotulo}.`, "snapshot_midia_sem_dado");
    }
    if (snap?.error === "ambiguous_client") {
      return respostaDireta("Encontrei mais de um cliente possível. Me diga o nome completo do cliente.", "snapshot_midia_ambiguo");
    }
    // Para uma pergunta que é claramente uma métrica diária, não cai no caminho
    // pesado se a fonte direta falhar. Melhor responder um erro controlado em
    // Cedar do que exibir TimeoutError cru ou gastar 30s na API Meta.
    if (snap === null) {
      return respostaDireta("Não consegui consultar esse dado agora. Tenta novamente em alguns segundos.", "snapshot_midia_indisponivel");
    }
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
      const { resposta: textoResposta, chamadas, pendencia, conversation_id } = await rodarAgente(
        {
          conversation_id: (corpo.conversation_id as string) ?? null,
          message: mensagem,
          client_id: (corpo.client_id as string) ?? null,
          voice: corpo.voice === true,
        },
        jwt, env, canal, undefined, undefined,
        executionContext ? (promise) => executionContext.waitUntil(promise) : undefined,
      );
      if (corpo.voice === true && !pendencia && textoResposta) canal.emitir("speech_ready", { text: textoResposta });
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
