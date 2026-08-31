"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import NativeDashboard from "./dashboard-native";
import LeonardoNativeDashboard from "./leonardo-native-dashboard";
import LeonardoClientFinancialStatusBridge from "./leonardo-client-financial-status-bridge";
import WorkReassignmentBridge from "./work-reassignment-bridge";
import WorkReassignmentAwayBridge from "./work-reassignment-away-bridge";
import { loadProfileLite, supabase } from "./shared";

type RouteState = "loading" | "native" | "leonardo" | "error";

export default function DashboardRouter() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [route, setRoute] = useState<RouteState>("loading");

  const resolveRoute = useCallback(async (current: Session | null) => {
    setSession(current);
    if (!current) {
      setRoute("native");
      setAuthReady(true);
      return;
    }

    setRoute("loading");
    try {
      const body = await loadProfileLite();
      const role = String(body?.profile?.role || "").toUpperCase();
      const person = String(body?.profile?.person || "");
      setRoute(role === "COMMERCIAL" && person === "Leonardo Augusto" ? "leonardo" : "native");
    } catch {
      // Nunca renderiza o dashboard operacional enquanto o perfil autenticado
      // nao foi resolvido. Isso evita exatamente o flash/troca de camada que
      // existia no Leonardo e evita liberar uma casca incorreta em falha de rede.
      setRoute("error");
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) void resolveRoute(data.session); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => { if (active) void resolveRoute(current); });
    return () => { active = false; subscription.unsubscribe(); };
  }, [resolveRoute]);

  if (!authReady || route === "loading") {
    return <div className="auth-loading"><span className="dot loading"/> Validando perfil…</div>;
  }

  if (route === "error") {
    return <main className="auth-loading" style={{ display: "grid", gap: 12, placeItems: "center" }}>
      <span>Não foi possível validar o perfil agora.</span>
      <button className="btn" onClick={() => { setAuthReady(false); void supabase.auth.getSession().then(({ data }) => resolveRoute(data.session)); }}>Tentar novamente</button>
    </main>;
  }

  if (route === "leonardo" && session) return <>
    <LeonardoNativeDashboard session={session} />
    <LeonardoClientFinancialStatusBridge session={session} />
  </>;
  return <>
    <NativeDashboard />
    {session && <WorkReassignmentBridge session={session} />}
    {session && <WorkReassignmentAwayBridge session={session} />}
  </>;
}
