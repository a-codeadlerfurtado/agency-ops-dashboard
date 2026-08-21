const AI_UPSTREAM = "https://centralops.yb4hto.easypanel.host/api/ai";

export const dynamic = "force-dynamic";

async function proxy(request: Request) {
  const incoming = new URL(request.url);
  const rawSuffix = incoming.pathname.slice("/api/ai".length);
  const safeSuffix = rawSuffix
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  const target = `${AI_UPSTREAM}${safeSuffix ? `/${safeSuffix}` : ""}${incoming.search}`;

  const headers = new Headers();
  for (const name of ["authorization", "content-type", "accept"]) {
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
