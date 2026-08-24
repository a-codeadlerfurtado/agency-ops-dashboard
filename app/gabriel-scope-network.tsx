"use client";

import { useEffect } from "react";
import { supabase } from "./shared";

const GABRIEL_USER_ID = "197fb469-bc67-492c-9b74-154372760633";
const MARK = "__opsGabrielScopeFetchInstalled";
const BLOCKED_GABRIEL_APIS = [
  "/functions/v1/agency-ops-sales-funnel-api",
  "/functions/v1/agency-ops-friday-report-api",
  "/functions/v1/agency-ops-commercial-direction-api",
  "/functions/v1/agency-ops-commercial-portfolio-api",
];

const normalize = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

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
  if (raw.includes("/functions/v1/agency-ops-dashboard-api")) return raw.replace("/functions/v1/agency-ops-dashboard-api", "/functions/v1/agency-ops-gabriel-dashboard-safe");
  if (raw.includes("/functions/v1/agency-ops-profile-data-api")) return raw.replace("/functions/v1/agency-ops-profile-data-api", "/functions/v1/agency-ops-gabriel-profile-data-api");
  if (raw.includes("/functions/v1/agency-ops-work-item-create-api")) return raw.replace("/functions/v1/agency-ops-work-item-create-api", "/functions/v1/agency-ops-gabriel-work-item-create-api");
  if (raw.includes("/functions/v1/agency-ops-ai-work-api")) return raw.replace("/functions/v1/agency-ops-ai-work-api", "/functions/v1/agency-ops-gabriel-ai-work-api");
  if (raw.includes("/functions/v1/agency-ops-client-notifications")) return raw.replace("/functions/v1/agency-ops-client-notifications", "/functions/v1/agency-ops-gabriel-client-notifications");
  if (raw.includes("/functions/v1/agency-ops-notifications-home")) return raw.replace("/functions/v1/agency-ops-notifications-home", "/functions/v1/agency-ops-gabriel-notifications-home");
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
    if (BLOCKED_GABRIEL_APIS.some((part) => raw.includes(part))) {
      return new Response(JSON.stringify({ error: "forbidden", scope: "GABRIEL_AI_ONLY" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const next = rewriteUrl(raw);
    if (next === raw) return original(input, init);

    if (input instanceof Request) {
      const clone = input.clone();
      const method = init?.method || clone.method;
      const body = ["GET", "HEAD"].includes(method.toUpperCase())
        ? undefined
        : (init?.body ?? await clone.blob());
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

function removeCommercialUiForGabriel() {
  const forbidden = new Set([
    "funil comercial",
    "direcao comercial",
    "relatorio de sexta",
    "visao do funil",
  ]);
  document.querySelectorAll<HTMLElement>(".side-nav-items button,.side-nav-items a,[data-commercial-funnel-nav],[data-commercial-section-nav]").forEach((node) => {
    const label = normalize(node.getAttribute("title") || node.textContent || "");
    if (forbidden.has(label) || node.hasAttribute("data-commercial-section-nav")) node.remove();
  });
}

install();

export default function GabrielScopeNetwork() {
  install();

  useEffect(() => {
    let enabled = false;
    let frame = 0;

    const apply = () => {
      if (!enabled) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        removeCommercialUiForGabriel();
        if (["/sales-funnel", "/friday-report", "/commercial-direction", "/commercial-clients"].includes(window.location.pathname)) {
          window.location.replace("/");
        }
      });
    };

    const setSession = (userId?: string | null) => {
      enabled = String(userId || "") === GABRIEL_USER_ID;
      apply();
    };

    supabase.auth.getSession().then(({ data }) => setSession(data.session?.user?.id));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session?.user?.id));
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 900);

    return () => {
      subscription.unsubscribe();
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
