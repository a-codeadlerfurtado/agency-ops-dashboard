"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, supabase } from "./shared";
import DashboardEnhancements from "./dashboard-enhancements";

/**
 * O perfil de Design já tem uma home própria, deliberadamente limitada a tarefas
 * criativas. A camada operacional ampla não deve recolocar clientes, campanhas ou
 * alertas genéricos nessa tela. Para os demais perfis, o próprio endpoint home já
 * devolve somente o escopo autorizado de cada sessão.
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
    api("home", session.access_token)
      .then((payload) => { if (active) setRole(String(payload?.profile?.role || "")); })
      .catch(() => { if (active) setRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  if (!session || !role || role === "DESIGN") return null;
  return <DashboardEnhancements />;
}
