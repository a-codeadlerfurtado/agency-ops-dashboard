import handler from "vinext/server/fetch-handler";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const AI_WORKSPACE = `${SUPABASE}/functions/v1/agency-ops-ai-workspace`;
const AI_MODEL = "@cf/zai-org/glm-4.7-flash";

type WorkerEnv = {
  AI?: {
    run: (model: string, input: Record<string, unknown>) => Promise<any>;
  };
};

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
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
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

async function handleAI(request: Request, env: WorkerEnv): Promise<Response> {
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
      easy_panel_required: false,
      data_backend: edgeBody,
    }, edge.ok ? 200 : 503);
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (action !== "chat") {
    const upstream = await edgeCall(request, action, body);
    const raw = await upstream.text();
    return secure(new Response(raw, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" },
    }));
  }

  if (!env.AI) return json({ ok: false, error: "workers_ai_not_configured" }, 503);

  const totalStarted = Date.now();
  const preparedResponse = await edgeCall(request, "prepare-chat", body);
  const prepared = await preparedResponse.json().catch(() => null) as any;
  if (!preparedResponse.ok || !prepared?.ok) {
    return json(prepared || { ok: false, error: "prepare_chat_failed" }, preparedResponse.status || 502);
  }

  const messages = [
    { role: "system", content: String(prepared.system || "") },
    ...((prepared.turns || []) as Array<{ role: string; content: string }>).map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: String(turn.content || ""),
    })),
  ];

  const started = Date.now();
  let result: any;
  try {
    const answerBudget = Math.max(600, Math.min(1600, Number(prepared.answer_budget || 1000)));
    result = await env.AI.run(AI_MODEL, {
      messages,
      max_tokens: answerBudget,
      temperature: 0.2,
    });
  } catch (error) {
    return json({ ok: false, error: "workers_ai_failed", detail: error instanceof Error ? error.message : String(error) }, 502);
  }

  const modelLatency = Date.now() - started;
  const answer = aiText(result);
  if (!answer) return json({ ok: false, error: "empty_ai_answer" }, 502);

  const usage = result?.usage || result?.result?.usage || {};
  const completionResponse = await edgeCall(request, "complete-chat", {
    conversation_id: prepared.conversation_id,
    request_id: prepared.request_id,
    answer,
    original_message: String(body.message || ""),
    model: AI_MODEL,
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
    return json(completed || { ok: false, error: "complete_chat_failed" }, completionResponse.status || 502);
  }

  return json({
    ok: true,
    user_message: prepared.user_message,
    assistant_message: completed.assistant_message,
    conversation: completed.conversation,
    source: "workers_ai",
    provider_error: null,
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
      return handleAI(request, env);
    }

    const response = await handler.fetch(request, env, context);
    return secure(response);
  },
};
