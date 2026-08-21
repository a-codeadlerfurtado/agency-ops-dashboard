const AI_UPSTREAM = "https://centralops.yb4hto.easypanel.host/api/ai";
const AI_AUTHORIZE = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-ai-authorize";

export const dynamic = "force-dynamic";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function authorizeAdler(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return { response: json({ ok: false, error: "unauthorized" }, 401), authorization: "" };

  const authorizationResponse = await fetch(AI_AUTHORIZE, {
    method: "GET",
    headers: { authorization },
    cache: "no-store",
  });
  if (authorizationResponse.status === 401) return { response: json({ ok: false, error: "unauthorized" }, 401), authorization: "" };
  if (authorizationResponse.status === 403) return { response: json({ ok: false, error: "ai_beta" }, 403), authorization: "" };
  if (!authorizationResponse.ok) return { response: json({ ok: false, error: "auth_unavailable" }, 503), authorization: "" };
  return { response: null, authorization };
}

async function proxy(request: Request) {
  const incoming = new URL(request.url);
  const rawSuffix = incoming.pathname.slice("/api/ai".length);
  const safeSuffix = rawSuffix
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");

  // Healthcheck contains no customer data and remains public for monitoring.
  let validatedAuthorization = "";
  if (!(request.method === "GET" && safeSuffix === "health")) {
    const auth = await authorizeAdler(request);
    if (auth.response) return auth.response;
    validatedAuthorization = auth.authorization;
  }

  const target = `${AI_UPSTREAM}${safeSuffix ? `/${safeSuffix}` : ""}${incoming.search}`;
  const headers = new Headers();
  if (validatedAuthorization) headers.set("authorization", validatedAuthorization);
  for (const name of ["content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

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
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-ai-proxy", "centralops");

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
