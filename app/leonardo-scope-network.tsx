"use client";

const LEONARDO_USER_ID = "334994a0-21ee-4a6e-9a03-5fbc3a3aed00";
const MARK = "__opsLeonardoScopeFetchInstalled";

function bearerFrom(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value));
  return (headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function tokenSubject(token: string) {
  try {
    const part = token.split(".")[1];
    if (!part) return "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return String(JSON.parse(atob(base64))?.sub || "");
  } catch {
    return "";
  }
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));
}

function rewrite(raw: string) {
  if (raw.includes("/functions/v1/agency-ops-dashboard-api")) {
    return raw.replace("/functions/v1/agency-ops-dashboard-api", "/functions/v1/agency-ops-leonardo-dashboard-safe");
  }
  return raw;
}

function synthetic(raw: string): Promise<Response> | null {
  if (raw.includes("/functions/v1/agency-ops-profile-data-api")) {
    return json({ ok: true, client_gt: [], focus: null, scope: "COMMERCIAL_READ_ONLY" });
  }
  if (raw.includes("/functions/v1/agency-ops-client-notifications")) {
    return json({ ok: true, summary: {}, client: {}, items: [], scope: "COMMERCIAL_BLOCKED_OPERATIONAL_HISTORY" });
  }
  if (
    raw.includes("/functions/v1/agency-ops-integration-health") ||
    raw.includes("/functions/v1/agency-ops-weekend-balance-api") ||
    raw.includes("/functions/v1/agency-ops-lead-quality-api") ||
    raw.includes("/functions/v1/agency-ops-required-alerts-api")
  ) {
    return json({ ok: true, items: [], alerts: [], summary: {}, scope: "COMMERCIAL_NOT_APPLICABLE" });
  }
  return null;
}

function install() {
  if (typeof window === "undefined") return;
  const scope = window as typeof window & Record<string, unknown>;
  if (scope[MARK]) return;
  scope[MARK] = true;
  const original = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = bearerFrom(input, init);
    if (!token || tokenSubject(token) !== LEONARDO_USER_ID) return original(input, init);

    const raw = input instanceof Request ? input.url : String(input);
    const fake = synthetic(raw);
    if (fake) return fake;

    const next = rewrite(raw);
    if (next === raw) return original(input, init);

    if (input instanceof Request) {
      const clone = input.clone();
      const method = init?.method || clone.method;
      const body = ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : (init?.body ?? await clone.blob());
      return original(next, {
        method,
        headers: init?.headers || clone.headers,
        body,
        cache: init?.cache || clone.cache,
        credentials: init?.credentials || clone.credentials,
        mode: init?.mode || clone.mode,
        redirect: init?.redirect || clone.redirect,
        referrer: init?.referrer || clone.referrer,
        referrerPolicy: init?.referrerPolicy || clone.referrerPolicy,
        integrity: init?.integrity || clone.integrity,
        keepalive: init?.keepalive ?? clone.keepalive,
        signal: init?.signal || clone.signal,
      });
    }
    return original(next, init);
  }) as typeof window.fetch;
}

install();

export default function LeonardoScopeNetwork() {
  install();
  return null;
}
