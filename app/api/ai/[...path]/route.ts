const AI_DATA = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-ai-workspace";

export const dynamic = "force-dynamic";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function proxy(request: Request) {
  const incoming = new URL(request.url);
  const rawSuffix = incoming.pathname.slice("/api/ai".length);
  const safeSuffix = rawSuffix
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");

  // Em producao o Worker intercepta /api/ai antes desta rota e executa a geracao
  // no binding Workers AI. Esta rota existe apenas como fallback para CRUD/health
  // em ambientes sem o runtime do Cloudflare. Nunca volta para a VPS/Hostinger.
  if (request.method === "POST" && safeSuffix === "chat") {
    return json({ ok: false, error: "workers_ai_runtime_required" }, 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!(request.method === "GET" && safeSuffix === "health") && !authorization.startsWith("Bearer ")) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const target = `${AI_DATA}${safeSuffix ? `/${safeSuffix}` : ""}${incoming.search}`;
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-ai-proxy", "supabase-edge-fallback");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
