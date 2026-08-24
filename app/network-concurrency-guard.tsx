"use client";

import { useEffect } from "react";

const SUPABASE_FUNCTIONS_PREFIX = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/";

type StoredResponse = {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
};

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function authScope(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value));
  const token = headers.get("authorization") || "anon";
  return token;
}

function cloneStored(stored: StoredResponse) {
  return new Response(stored.body.slice(0), {
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
  });
}

function rewriteProfileProbe(input: RequestInfo | URL, init?: RequestInit) {
  const raw = requestUrl(input);
  if (window.location.pathname === "/") return { input, url: raw };
  if (!raw.includes("/agency-ops-dashboard-api") || !raw.includes("view=home")) return { input, url: raw };

  const target = new URL(raw);
  target.pathname = target.pathname.replace("/agency-ops-dashboard-api", "/agency-ops-profile-lite");
  target.searchParams.delete("view");
  const nextUrl = target.toString();

  if (typeof Request !== "undefined" && input instanceof Request) {
    return { input: new Request(nextUrl, input), url: nextUrl };
  }
  return { input: nextUrl, url: nextUrl };
}

export default function NetworkConcurrencyGuard() {
  useEffect(() => {
    const w = window as typeof window & { __opsFetchConcurrencyGuard?: boolean; __opsOriginalFetch?: typeof window.fetch };
    if (w.__opsFetchConcurrencyGuard) return;
    w.__opsFetchConcurrencyGuard = true;

    const originalFetch = window.fetch.bind(window);
    w.__opsOriginalFetch = originalFetch;
    const inFlight = new Map<string, Promise<Response>>();
    const tinyCache = new Map<string, { expiresAt: number; response: StoredResponse }>();

    const cacheTtl = (url: string) => url.includes("/agency-ops-profile-lite") ? 20_000 : 0;

    window.fetch = (async (rawInput: RequestInfo | URL, init?: RequestInit) => {
      const method = requestMethod(rawInput, init);
      const rawUrl = requestUrl(rawInput);
      if (method !== "GET" || !rawUrl.startsWith(SUPABASE_FUNCTIONS_PREFIX)) {
        return originalFetch(rawInput, init);
      }

      if (window.location.pathname === "/" && rawUrl.includes("/agency-ops-profile-data-api")) {
        return new Response(JSON.stringify({ profile: {}, focus: null, client_gt: [] }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // Fora da Home, as bridges so usam view=home para descobrir perfil/permissao.
      // Trocar automaticamente pelo endpoint leve evita remontar o dashboard inteiro
      // quando o usuario esta em Agenda, Campanhas, Onboarding ou qualquer outra rota.
      const rewritten = rewriteProfileProbe(rawInput, init);
      const input = rewritten.input;
      const url = rewritten.url;

      const key = `${authScope(rawInput, init)}::${url}`;
      const cached = tinyCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cloneStored(cached.response);
      if (cached) tinyCache.delete(key);

      const pending = inFlight.get(key);
      if (pending) return (await pending).clone();

      const request = originalFetch(input, init)
        .then(async (response) => {
          const ttl = cacheTtl(url);
          if (ttl > 0 && response.ok) {
            try {
              const copy = response.clone();
              const body = await copy.arrayBuffer();
              tinyCache.set(key, {
                expiresAt: Date.now() + ttl,
                response: {
                  body,
                  status: response.status,
                  statusText: response.statusText,
                  headers: Array.from(response.headers.entries()),
                },
              });
            } catch {
              // Cache e otimista; qualquer falha deixa a resposta normal seguir.
            }
          }
          return response;
        })
        .finally(() => inFlight.delete(key));

      inFlight.set(key, request);
      return (await request).clone();
    }) as typeof window.fetch;

    return () => {
      if (w.__opsOriginalFetch === originalFetch) {
        window.fetch = originalFetch;
        w.__opsFetchConcurrencyGuard = false;
      }
      inFlight.clear();
      tinyCache.clear();
    };
  }, []);

  return null;
}
