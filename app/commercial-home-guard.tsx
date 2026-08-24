"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { loadProfileLite, supabase } from "./shared";

const COMMERCIAL_STYLE_ID = "commercial-profile-scope-style";

function enableCommercialScope() {
  document.documentElement.classList.add("commercial-profile");
  if (document.getElementById(COMMERCIAL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COMMERCIAL_STYLE_ID;
  style.textContent = `
    html.commercial-profile aside:has(>button[aria-label="Saúde das integrações"]),
    html.commercial-profile .wba-backdrop,
    html.commercial-profile .lqa-backdrop{display:none!important}
  `;
  document.head.appendChild(style);
}

function disableCommercialScope() {
  document.documentElement.classList.remove("commercial-profile", "commercial-overview-active");
  document.getElementById(COMMERCIAL_STYLE_ID)?.remove();
}

function legacyDestination() {
  const path = window.location.pathname;
  if (!["/commercial-home", "/commercial-direction", "/commercial-clients"].includes(path)) return null;
  if (path === "/commercial-clients") return "/?commercial_view=clients";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (tab === "campaigns") return "/?commercial_view=campaigns";
  if (tab === "portfolio") return "/?commercial_view=clients";
  if (tab === "funnel") return "/?commercial_mode=funnel";
  return "/";
}

/**
 * COMMERCIAL permanece no shell principal do dashboard. As rotas comerciais
 * antigas existem apenas por compatibilidade e são normalizadas uma única vez
 * para /. Depois disso, nenhuma navegação do Leonardo sai do dashboard principal.
 *
 * OpsQuestion continua disponível. Apenas superfícies globais estritamente
 * operacionais são ocultadas para o papel comercial.
 */
export default function CommercialHomeGuard() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      disableCommercialScope();
      return;
    }
    let active = true;

    loadProfileLite()
      .then((body) => {
        if (!active) return;
        const role = String(body?.profile?.role || "").toUpperCase();
        if (role !== "COMMERCIAL") {
          disableCommercialScope();
          return;
        }

        enableCommercialScope();
        const destination = legacyDestination();
        if (destination) window.location.replace(destination);
      })
      .catch(() => undefined);

    return () => { active = false; };
  }, [session?.access_token]);

  return null;
}
