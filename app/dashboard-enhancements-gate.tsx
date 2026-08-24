"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import DashboardEnhancements from "./dashboard-enhancements";

const PROFILE_API = `${SUPABASE_URL}/functions/v1/agency-ops-profile-lite`;

/**
 * Design e Direção Comercial têm homes próprias e deliberadamente limitadas ao
 * escopo do papel. A camada operacional ampla não deve recolocar tarefas,
 * produtividade individual, alertas técnicos ou controles de execução nessas telas.
 */
export default function DashboardEnhancementsGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setRole(null); return; }
    let active = true;
    authenticatedFetch(PROFILE_API, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json().catch(() => ({}));
        if (active) setRole(String(payload?.profile?.role || ""));
      })
      .catch(() => { if (active) setRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  if (!session || !role || role === "DESIGN" || role === "COMMERCIAL") return null;
  return <DashboardEnhancements />;
}
