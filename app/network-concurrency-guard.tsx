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
  // A chave fica apenas em memoria e nunca e logada. Separar por token impede que
  // uma troca de usuario na mesma aba reaproveite resposta do perfil anterior.
  return token;
}

function cloneStored(stored: StoredResponse) {
  return new Response(stored.body.slice(0), {
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
  });
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

    const cacheTtl = (url: string) => {
      // Perfil e permissoes mudam raramente. Uma janela curta evita que varias
      // bridges consultem o banco novamente logo apos o primeiro carregamento.
      if (url.includes("/agency-ops-profile-lite")) return 20_000;
      return 0;
    };

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = requestMethod(input, init);
      const url = requestUrl(input);
      if (method !== "GET" || !url.startsWith(SUPABASE_FUNCTIONS_PREFIX)) {
        return originalFetch(input, init);
      }

      // A Home ja devolve gt_owner, personal_focus, design_focus e identidade ClickUp.
      // O page.tsx ainda faz uma chamada antiga de enriquecimento logo depois do home;
      // ela varre ClickUp de novo e chegou a levar mais de 100s. Na rota raiz esse
      // complemento e redundante, entao preservamos os dados do payload principal sem
      // abrir uma segunda consulta pesada por usuario.
      if (window.location.pathname === "/" && url.includes("/agency-ops-profile-data-api")) {
        return new Response(JSON.stringify({ profile: {}, focus: null, client_gt: [] }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      const key = `${authScope(input, init)}::${url}`;
      const cached = tinyCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cloneStored(cached.response);
      if (cached) tinyCache.delete(key);

      // Todas as requisicoes GET identicas do mesmo usuario compartilham a mesma
      // chamada enquanto ela estiver em voo. Isso impede que page + bridges lancem
      // cinco copias de view=home ao mesmo tempo.
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
      // Em producao o RootLayout nao desmonta. A restauracao evita comportamento
      // estranho em Fast Refresh durante desenvolvimento.
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
