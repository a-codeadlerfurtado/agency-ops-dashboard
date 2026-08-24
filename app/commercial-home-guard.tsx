"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { loadProfileLite, supabase } from "./shared";

/**
 * O dashboard principal em / continua sendo a home operacional da gestão.
 * Perfis COMMERCIAL não devem carregar essa visão: a home deles é /commercial-home.
 *
 * A exceção é commercial_view, usada para abrir áreas comerciais que ainda vivem
 * dentro do shell principal (ex.: pré-clientes). Assim mantemos a navegação
 * comercial sem reexpor a Visão Geral operacional.
 */
export default function CommercialHomeGuard() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) return;
    let active = true;

    loadProfileLite()
      .then((body) => {
        if (!active) return;
        const role = String(body?.profile?.role || "").toUpperCase();
        if (role !== "COMMERCIAL") return;
        if (window.location.pathname !== "/") return;

        const params = new URLSearchParams(window.location.search);
        if (params.get("commercial_view")) return;

        document.documentElement.style.visibility = "hidden";
        window.location.replace("/commercial-home");
      })
      .catch(() => undefined);

    return () => { active = false; };
  }, [session?.access_token]);

  return null;
}
