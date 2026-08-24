"use client";

const GABRIEL_USER_ID = "197fb469-bc67-492c-9b74-154372760633";
const MARK = "__opsGabrielScopeFetchInstalled";

function bearerFrom(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value));
  const auth = headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
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

function rewriteUrl(raw: string) {
  if (raw.includes("/functions/v1/agency-ops-dashboard-api")) return raw.replace("/functions/v1/agency-ops-dashboard-api", "/functions/v1/agency-ops-dashboard-scope");
  if (raw.includes("/functions/v1/agency-ops-profile-data-api")) return raw.replace("/functions/v1/agency-ops-profile-data-api", "/functions/v1/agency-ops-gabriel-profile-data-api");
  if (raw.includes("/functions/v1/agency-ops-work-item-create-api")) return raw.replace("/functions/v1/agency-ops-work-item-create-api", "/functions/v1/agency-ops-gabriel-work-item-create-api");
  if (raw.includes("/functions/v1/agency-ops-ai-work-api")) return raw.replace("/functions/v1/agency-ops-ai-work-api", "/functions/v1/agency-ops-gabriel-ai-work-api");
  return raw;
}

function install() {
  if (typeof window === "undefined") return;
  const scope = window as typeof window & Record<string, unknown>;
  if (scope[MARK]) return;
  scope[MARK] = true;
  const original = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = bearerFrom(input, init);
    if (!token || tokenSubject(token) !== GABRIEL_USER_ID) return original(input, init);

    const raw = input instanceof Request ? input.url : String(input);
    const next = rewriteUrl(raw);
    if (next === raw) return original(input, init);

    if (input instanceof Request) return original(new Request(next, input), init);
    return original(next, init);
  }) as typeof window.fetch;
}

install();

export default function GabrielScopeNetwork() {
  install();
  return null;
}
