"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import NativeDashboard from "./dashboard-native";
import LeonardoNativeDashboard from "./leonardo-native-dashboard";
import LeonardoClientFinancialStatusBridge from "./leonardo-client-financial-status-bridge";
import WorkReassignmentBridge from "./work-reassignment-bridge";
import WorkReassignmentAwayBridge from "./work-reassignment-away-bridge";
import BriefingStaffBridge from "./briefing-staff-bridge";
import { loadProfileLite, supabase } from "./shared";

type RouteState = "loading" | "native" | "leonardo" | "error";

export default function DashboardRouter() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [route, setRoute] = useState<RouteState>("loading");
  const routeRequest = useRef(0);

  const resolveRoute = useCallback(async (current: Session | null) => {
    const requestId = ++routeRequest.current;
    setSession(current);

    if (!current) {
      setRoute("native");
      setAuthReady(true);
      return;
    }

    setRoute("loading");
    setAuthReady(false);

    try {
      // Usa exatamente a sessão entregue pelo evento. loadProfileLite não volta ao
      // mutex do Supabase, então o callback de autenticação nunca entra em deadlock.
      const body = await loadProfileLite(current);
      if (requestId !== routeRequest.current) return;

      const role = String(body?.profile?.role || "").toUpperCase();
      const person = String(body?.profile?.person || "");
      setRoute(role === "COMMERCIAL" && person === "Leonardo Augusto" ? "leonardo" : "native");
    } catch {
      if (requestId !== routeRequest.current) return;

      // O carregamento do perfil tem timeout de 10 segundos. Uma falha real termina
      // nesta tela recuperável; o usuário nunca fica preso em validação infinita.
      setRoute("error");
    } finally {
      if (requestId === routeRequest.current) setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let authTimer: number | null = null;

    const scheduleRoute = (current: Session) => {
      if (authTimer !== null) window.clearTimeout(authTimer);
      authTimer = window.setTimeout(() => {
        authTimer = null;
        if (active) void resolveRoute(current);
      }, 0);
    };

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          ++routeRequest.current;
          setSession(null);
          setRoute("error");
          setAuthReady(true);
          return;
        }
        void resolveRoute(data.session);
      })
      .catch(() => {
        if (!active) return;
        ++routeRequest.current;
        setSession(null);
        setRoute("error");
        setAuthReady(true);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => {
      if (!active) return;

      // Deixa o callback síncrono retornar antes de qualquer trabalho assíncrono.
      // SIGNED_OUT não consulta o Supabase e pode ser aplicado imediatamente.
      if (!current) {
        void resolveRoute(null);
        return;
      }
      scheduleRoute(current);
    });

    return () => {
      active = false;
      if (authTimer !== null) window.clearTimeout(authTimer);
      subscription.unsubscribe();
    };
  }, [resolveRoute]);

  if (!authReady || route === "loading") {
    return <div className="auth-loading"><span className="dot loading"/> Validando perfil…</div>;
  }

  if (route === "error") {
    return <main className="auth-loading" style={{ display: "grid", gap: 12, placeItems: "center" }}>
      <span>Não foi possível validar o perfil agora.</span>
      <button
        className="btn"
        onClick={() => {
          setAuthReady(false);
          setRoute("loading");
          void supabase.auth.getSession()
            .then(({ data, error }) => {
              if (error) throw error;
              return resolveRoute(data.session);
            })
            .catch(() => {
              setRoute("error");
              setAuthReady(true);
            });
        }}
      >
        Tentar novamente
      </button>
    </main>;
  }

  if (route === "leonardo" && session) return <>
    <LeonardoNativeDashboard session={session} />
    <LeonardoClientFinancialStatusBridge session={session} />
  </>;

  return <>
    <NativeDashboard />
    {session && <BriefingStaffBridge session={session} />}
    {session && <WorkReassignmentBridge session={session} />}
    {session && <WorkReassignmentAwayBridge session={session} />}
  </>;
}
