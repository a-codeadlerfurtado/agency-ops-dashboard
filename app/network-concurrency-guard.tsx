"use client";

import { useEffect } from "react";

const SUPABASE_FUNCTIONS_PREFIX = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/";
const PROFILE_API = `${SUPABASE_FUNCTIONS_PREFIX}agency-ops-profile-lite`;
const HOME_TIMEOUT_MS = 18_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const PROFILE_TIMEOUT_MS = 6_000;
const FAILURE_COOLDOWN_MS = 10_000;
const HOME_CACHE_MS = 120_000;
const HOME_STALE_MS = 10 * 60_000;
const INITIAL_HOME_JITTER_MS = 6_000;

type StoredResponse = {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
};
type LiteProfile = {
  person?: string | null;
  role?: string | null;
  access_level?: string | null;
  is_full?: boolean;
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
function mergedHeaders(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value));
  return headers;
}
function authScope(input: RequestInfo | URL, init?: RequestInit) {
  return mergedHeaders(input, init).get("authorization") || "anon";
}
function cloneStored(stored: StoredResponse) {
  return new Response(stored.body.slice(0), { status: stored.status, statusText: stored.statusText, headers: stored.headers });
}
function localJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function isHomeUrl(url: string) {
  return url.includes("/agency-ops-dashboard-api") && url.includes("view=home");
}
function rewriteProfileProbe(input: RequestInfo | URL) {
  const raw = requestUrl(input);
  if (window.location.pathname === "/") return { input, url: raw };
  if (!isHomeUrl(raw)) return { input, url: raw };
  const target = new URL(raw);
  target.pathname = target.pathname.replace("/agency-ops-dashboard-api", "/agency-ops-profile-lite");
  target.searchParams.delete("view");
  const nextUrl = target.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return { input: new Request(nextUrl, input), url: nextUrl };
  return { input: nextUrl, url: nextUrl };
}
function jitterFor(scope: string) {
  let hash = 0;
  for (let i = 0; i < scope.length; i++) hash = ((hash << 5) - hash + scope.charCodeAt(i)) | 0;
  return Math.abs(hash) % (INITIAL_HOME_JITTER_MS + 1);
}
function wait(ms: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, ms)); }

export default function NetworkConcurrencyGuard() {
  useEffect(() => {
    const w = window as typeof window & { __opsFetchConcurrencyGuard?: boolean; __opsOriginalFetch?: typeof window.fetch };
    if (w.__opsFetchConcurrencyGuard) return;
    w.__opsFetchConcurrencyGuard = true;

    const originalFetch = window.fetch.bind(window);
    w.__opsOriginalFetch = originalFetch;
    const inFlight = new Map<string, Promise<Response>>();
    const tinyCache = new Map<string, { expiresAt: number; response: StoredResponse }>();
    const staleHome = new Map<string, { expiresAt: number; response: StoredResponse }>();
    const profileCache = new Map<string, { expiresAt: number; profile: LiteProfile }>();
    const profileFlight = new Map<string, Promise<LiteProfile | null>>();
    const cooldown = new Map<string, number>();
    const firstHomeSeen = new Set<string>();
    let forceHomeRefresh = false;

    const cacheTtl = (url: string) => {
      if (url.includes("/agency-ops-profile-lite")) return 60_000;
      if (isHomeUrl(url)) return HOME_CACHE_MS;
      if (url.includes("/agency-ops-required-alerts-api")) return 60_000;
      if (url.includes("/agency-ops-onboarding-api")) return 60_000;
      if (url.includes("/agency-ops-team-now-api")) return 30_000;
      if (url.includes("/agency-ops-notifications-home")) return 30_000;
      if (url.includes("/agency-ops-cs-clients-api")) return 120_000;
      if (url.includes("view=clickup-range")) return 120_000;
      return 0;
    };

    function timeoutFor(url: string) {
      return isHomeUrl(url) ? HOME_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    }

    function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number) {
      const controller = new AbortController();
      const upstream = init?.signal;
      const onAbort = () => controller.abort(upstream?.reason);
      if (upstream?.aborted) onAbort();
      else upstream?.addEventListener("abort", onAbort, { once: true });
      const timer = window.setTimeout(() => controller.abort(new DOMException("Tempo limite da requisição excedido", "TimeoutError")), timeoutMs);
      return originalFetch(input, { ...init, signal: controller.signal }).finally(() => {
        window.clearTimeout(timer);
        upstream?.removeEventListener("abort", onAbort);
      });
    }

    async function getLiteProfile(rawInput: RequestInfo | URL, init?: RequestInit): Promise<LiteProfile | null> {
      const scope = authScope(rawInput, init);
      if (scope === "anon") return null;
      const cached = profileCache.get(scope);
      if (cached && cached.expiresAt > Date.now()) return cached.profile;
      if (cached) profileCache.delete(scope);
      const pending = profileFlight.get(scope);
      if (pending) return pending;
      const promise = fetchWithTimeout(PROFILE_API, { headers: mergedHeaders(rawInput, init), cache: "no-store" }, PROFILE_TIMEOUT_MS)
        .then(async (response) => {
          if (!response.ok) return null;
          const body = await response.json().catch(() => null);
          const profile = (body?.profile || null) as LiteProfile | null;
          if (profile) profileCache.set(scope, { expiresAt: Date.now() + 60_000, profile });
          return profile;
        })
        .catch(() => null)
        .finally(() => profileFlight.delete(scope));
      profileFlight.set(scope, promise);
      return promise;
    }

    async function localGate(rawInput: RequestInfo | URL, init: RequestInit | undefined, rawUrl: string) {
      const needsProfile = rawUrl.includes("/agency-ops-integration-health")
        || rawUrl.includes("/agency-ops-team-now-api")
        || rawUrl.includes("/agency-ops-contracts-api")
        || rawUrl.includes("/agency-ops-weekend-balance-api")
        || rawUrl.includes("/agency-ops-lead-quality-api")
        || rawUrl.includes("/agency-ops-onboarding-api")
        || rawUrl.includes("/agency-ops-required-alerts-api");
      if (!needsProfile) return null;
      const profile = await getLiteProfile(rawInput, init);

      // Sob saturacao, falhar fechado evita que uma checagem de perfil lenta dispare
      // justamente a API pesada que a checagem deveria impedir.
      if (!profile) {
        if (rawUrl.includes("/agency-ops-onboarding-api")) return localJson({ worklist: [], assignment_notifications: [], gt_options: [], playbook_slas: [], sla_summary: {}, generated_at: new Date().toISOString() });
        if (rawUrl.includes("/agency-ops-required-alerts-api")) return localJson({ ok: true, pending: [], history: [], generated_at: new Date().toISOString() });
        return localJson({ error: "profile_temporarily_unavailable" }, 503);
      }

      if (rawUrl.includes("/agency-ops-integration-health") && !profile.is_full) return localJson({ error: "forbidden" }, 403);
      if ((rawUrl.includes("/agency-ops-team-now-api") || rawUrl.includes("/agency-ops-contracts-api")) && profile.person !== "Adler Furtado") return localJson({ error: "forbidden" }, 403);
      if (rawUrl.includes("/agency-ops-weekend-balance-api") && profile.role !== "GT") return localJson({ eligible: false, alerts: [] });
      if (rawUrl.includes("/agency-ops-lead-quality-api") && profile.role !== "GT") return localJson({ eligible: false, incidents: [] });

      if (rawUrl.includes("/agency-ops-onboarding-api")) {
        const onboardingRoute = window.location.pathname === "/onboarding" || window.location.pathname.startsWith("/onboarding-");
        const canAssignAnywhere = profile.person === "Adler Furtado" || profile.role === "CS";
        const canWorkOnboardingHere = onboardingRoute && profile.role === "GT";
        if (!canAssignAnywhere && !canWorkOnboardingHere) {
          return localJson({
            worklist: [], assignment_notifications: [], gt_options: [], playbook_slas: [], sla_summary: {},
            profile: { person: profile.person, role: profile.role, can_assign_gt: false }, generated_at: new Date().toISOString(),
          });
        }
      }
      return null;
    }

    const onManualRefresh = (event: MouseEvent) => {
      const el = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      if (!el) return;
      if ((el.textContent || "").trim().toLowerCase() === "atualizar" && el.closest(".top")) forceHomeRefresh = true;
    };
    document.addEventListener("click", onManualRefresh, true);

    window.fetch = (async (rawInput: RequestInfo | URL, init?: RequestInit) => {
      const method = requestMethod(rawInput, init);
      const rawUrl = requestUrl(rawInput);
      if (method !== "GET" || !rawUrl.startsWith(SUPABASE_FUNCTIONS_PREFIX)) return originalFetch(rawInput, init);

      if (window.location.pathname === "/" && rawUrl.includes("/agency-ops-profile-data-api")) {
        return localJson({ profile: {}, focus: null, client_gt: [] });
      }

      const gated = await localGate(rawInput, init, rawUrl);
      if (gated) return gated;

      const rewritten = rewriteProfileProbe(rawInput);
      const input = rewritten.input;
      const url = rewritten.url;
      const scope = authScope(rawInput, init);
      const key = `${scope}::${url}`;
      const home = isHomeUrl(url);
      const bypassHomeCache = home && forceHomeRefresh;
      if (bypassHomeCache) forceHomeRefresh = false;

      const blockedUntil = cooldown.get(key) || 0;
      if (blockedUntil > Date.now() && !bypassHomeCache) {
        const stale = home ? staleHome.get(key) : null;
        if (stale && stale.expiresAt > Date.now()) return cloneStored(stale.response);
        return localJson({ error: "temporarily_unavailable", retry_after_ms: blockedUntil - Date.now() }, 503);
      }
      if (blockedUntil) cooldown.delete(key);

      const cached = tinyCache.get(key);
      if (!bypassHomeCache && cached && cached.expiresAt > Date.now()) return cloneStored(cached.response);
      if (cached && cached.expiresAt <= Date.now()) tinyCache.delete(key);
      const pending = inFlight.get(key);
      if (pending) return (await pending).clone();

      // Usuarios entrando juntos deixam de atingir a Home no mesmo milissegundo.
      if (home && !firstHomeSeen.has(scope)) {
        firstHomeSeen.add(scope);
        await wait(jitterFor(scope));
        const afterWait = tinyCache.get(key);
        if (!bypassHomeCache && afterWait && afterWait.expiresAt > Date.now()) return cloneStored(afterWait.response);
      }

      const request = fetchWithTimeout(input, init, timeoutFor(url))
        .then(async (response) => {
          const ttl = cacheTtl(url);
          if (ttl > 0 && response.ok) {
            try {
              const copy = response.clone();
              const body = await copy.arrayBuffer();
              const stored = { body, status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()) };
              tinyCache.set(key, { expiresAt: Date.now() + ttl, response: stored });
              if (home) staleHome.set(key, { expiresAt: Date.now() + HOME_STALE_MS, response: stored });
              if (url.includes("/agency-ops-profile-lite")) {
                const parsed = JSON.parse(new TextDecoder().decode(body));
                if (parsed?.profile) profileCache.set(scope, { expiresAt: Date.now() + ttl, profile: parsed.profile });
              }
            } catch { /* otimizacao nunca derruba resposta */ }
          }
          return response;
        })
        .catch((error) => {
          if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
            cooldown.set(key, Date.now() + FAILURE_COOLDOWN_MS);
            const stale = home ? staleHome.get(key) : null;
            if (stale && stale.expiresAt > Date.now()) return cloneStored(stale.response);
            return localJson({ error: "client_timeout", retry_after_ms: FAILURE_COOLDOWN_MS }, 504);
          }
          throw error;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return (await request).clone();
    }) as typeof window.fetch;

    return () => {
      document.removeEventListener("click", onManualRefresh, true);
      if (w.__opsOriginalFetch === originalFetch) { window.fetch = originalFetch; w.__opsFetchConcurrencyGuard = false; }
      inFlight.clear(); tinyCache.clear(); staleHome.clear(); profileCache.clear(); profileFlight.clear(); cooldown.clear(); firstHomeSeen.clear();
    };
  }, []);
  return null;
}
