import handler from "vinext/server/fetch-handler";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const AI_WORKSPACE = `${SUPABASE}/functions/v1/agency-ops-ai-workspace`;
const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
const OPS_FAST_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

type WorkerEnv = {
  AI?: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  AI_RATE_LIMITER?: RateLimiter;
};

const MAX_JSON_BYTES = 128 * 1024;
const PUBLIC_AI_ACTIONS = new Set([
  "clients",
  "bootstrap",
  "conversations/list",
  "conversations/create",
  "conversations/get",
  "conversations/rename",
  "conversations/archive",
  "conversations/delete",
  "conversations/set-client",
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  `connect-src 'self' ${SUPABASE} wss://bfzdetibfcwihfkltbkp.supabase.co`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  // microphone=(self): a Jarvis usa a Web Speech API e o MediaRecorder na
  // propria origem. Com microphone=() o navegador nega antes de perguntar.
  // Continua negado para qualquer iframe ou terceiro.
  "permissions-policy": "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return secure(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));
}

function aiText(result: any): string | null {
  const candidates = [
    result?.response,
    result?.result?.response,
    result?.result?.text,
    result?.text,
    result?.choices?.[0]?.message?.content,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function rateLimitKey(authorization: string, action: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${authorization}:${action}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseJsonBody(request: Request): Promise<
  { ok: true; body: Record<string, unknown> } |
  { ok: false; response: Response }
> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return { ok: false, response: json({ ok: false, error: "content_type_required" }, 415) };
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    return { ok: false, response: json({ ok: false, error: "payload_too_large" }, 413) };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: json({ ok: false, error: "invalid_json" }, 400) };

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      return { ok: false, response: json({ ok: false, error: "payload_too_large" }, 413) };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_object");
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_json" }, 400) };
  }
}

async function edgeCall(request: Request, action: string, payload?: unknown): Promise<Response> {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  headers.set("content-type", "application/json");
  return fetch(`${AI_WORKSPACE}/${action}`, {
    method: action === "health" ? "GET" : "POST",
    headers,
    body: action === "health" ? undefined : JSON.stringify(payload ?? {}),
    redirect: "manual",
  });
}

async function handleAI(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.slice("/api/ai/".length).replace(/^\/+|\/+$/g, "");

  if (request.method === "GET" && action === "health") {
    const edge = await edgeCall(request, "health");
    const edgeBody = await edge.json().catch(() => ({}));
    return json({
      ok: edge.ok,
      service: "agency-ops-ai-cloudflare",
      runtime: "cloudflare-workers-ai+supabase-edge",
      model: AI_MODEL,
      ops_fast_model: OPS_FAST_MODEL,
      easy_panel_required: false,
      data_backend: edgeBody,
    }, edge.ok ? 200 : 503);
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);
  if (action !== "chat" && !PUBLIC_AI_ACTIONS.has(action)) return json({ ok: false, error: "not_found" }, 404);

  if (env.AI_RATE_LIMITER) {
    const key = await rateLimitKey(authorization, action);
    const { success } = await env.AI_RATE_LIMITER.limit({ key });
    if (!success) {
      console.warn({ event: "ai_rate_limited", action, request_id: requestId });
      return json({ ok: false, error: "rate_limited", request_id: requestId }, 429);
    }
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (action !== "chat") {
    const upstream = await edgeCall(request, action, body);
    if (!upstream.ok) {
      console.error({ event: "ai_upstream_failed", action, status: upstream.status, request_id: requestId });
      const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 404
        ? upstream.status
        : 502;
      return json({ ok: false, error: "upstream_failed", request_id: requestId }, status);
    }
    const raw = await upstream.text();
    return secure(new Response(raw, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    }));
  }

  if (!env.AI) return json({ ok: false, error: "workers_ai_not_configured" }, 503);

  const totalStarted = Date.now();
  const preparedResponse = await edgeCall(request, "prepare-chat", body);
  const prepared = await preparedResponse.json().catch(() => null) as any;
  if (!preparedResponse.ok || !prepared?.ok) {
    console.error({ event: "ai_prepare_failed", status: preparedResponse.status, request_id: requestId });
    const status = preparedResponse.status === 401 || preparedResponse.status === 403 || preparedResponse.status === 404
      ? preparedResponse.status
      : 502;
    return json({ ok: false, error: "prepare_chat_failed", request_id: requestId }, status);
  }

  const messages = [
    { role: "system", content: String(prepared.system || "") },
    ...((prepared.turns || []) as Array<{ role: string; content: string }>).map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: String(turn.content || ""),
    })),
  ];

  const useOpsFast = body.ops_fast === true;
  const selectedModel = useOpsFast ? OPS_FAST_MODEL : AI_MODEL;
  const started = Date.now();
  let result: any;
  try {
    const answerBudget = Math.max(600, Math.min(1600, Number(prepared.answer_budget || 1000)));
    if (useOpsFast) {
      result = await env.AI.run(selectedModel, {
        messages,
        max_tokens: Math.max(700, Math.min(1500, answerBudget + 300)),
        temperature: 0.15,
      });
    } else {
      const completionBudget = Math.max(1800, Math.min(3200, answerBudget * 2));
      result = await env.AI.run(selectedModel, {
        messages,
        max_completion_tokens: completionBudget,
        reasoning_effort: "low",
        temperature: 0.2,
      });
    }
  } catch (error) {
    console.error({
      event: "workers_ai_failed",
      model: selectedModel,
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ ok: false, error: "workers_ai_failed", request_id: requestId }, 502);
  }

  const modelLatency = Date.now() - started;
  const answer = aiText(result);
  if (!answer) {
    console.error({
      event: "empty_ai_answer",
      model: selectedModel,
      finish_reason: result?.choices?.[0]?.finish_reason ?? null,
      request_id: requestId,
    });
    return json({ ok: false, error: "empty_ai_answer", request_id: requestId }, 502);
  }

  const usage = result?.usage || result?.result?.usage || {};
  const completionResponse = await edgeCall(request, "complete-chat", {
    conversation_id: prepared.conversation_id,
    request_id: prepared.request_id,
    answer,
    original_message: String(body.message || ""),
    model: selectedModel,
    latency_ms: modelLatency,
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0) || null,
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0) || null,
    context_sources: prepared.context_sources || [],
    context_client: prepared.context_client || null,
    context_bytes: prepared.context_bytes || null,
    prepare_ms: prepared.prepare_ms || null,
    intents: prepared.intents || [],
  });
  const completed = await completionResponse.json().catch(() => null) as any;
  if (!completionResponse.ok || !completed?.ok) {
    console.error({ event: "ai_complete_failed", status: completionResponse.status, request_id: requestId });
    return json({ ok: false, error: "complete_chat_failed", request_id: requestId }, 502);
  }

  return json({
    ok: true,
    user_message: prepared.user_message,
    assistant_message: completed.assistant_message,
    conversation: completed.conversation,
    source: useOpsFast ? "workers_ai_ops_fast" : "workers_ai",
    provider_error: null,
    model: selectedModel,
    context_sources: prepared.context_sources || [],
    context_client: prepared.context_client || null,
    timing: {
      prepare_ms: Number(prepared.prepare_ms || 0) || null,
      model_ms: modelLatency,
      total_ms: Date.now() - totalStarted,
      context_bytes: Number(prepared.context_bytes || 0) || null,
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: unknown): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/ai" || url.pathname.startsWith("/api/ai/")) {
      const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
      try {
        return await handleAI(request, env, requestId);
      } catch (error) {
        console.error({
          event: "ai_request_failed",
          path: url.pathname,
          request_id: requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return json({ ok: false, error: "internal_error", request_id: requestId }, 500);
      }
    }

    const response = await handler.fetch(request, env, context);
    return secure(response);
  },
};
