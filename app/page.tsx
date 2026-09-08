"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import NativeDashboard from "./dashboard-native";
import LeonardoNativeDashboard from "./leonardo-native-dashboard";
import LeonardoClientFinancialStatusBridge from "./leonardo-client-financial-status-bridge";
import WorkReassignmentBridge from "./work-reassignment-bridge";
import WorkReassignmentAwayBridge from "./work-reassignment-away-bridge";
import BriefingStaffBridge from "./briefing-staff-bridge";
import MaterialTriageBridge from "./material-triage-bridge";
import JarvisVoice from "./jarvis-voice";
import { loadProfileLite, supabase } from "./shared";

type RouteState = "loading" | "native" | "leonardo" | "error";

export default function DashboardRouter() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [route, setRoute] = useState<RouteState>("loading");
  const routeRequest = useRef(0);
  // Ultima sessao JA resolvida com sucesso. Serve para ignorar evento de
  // autenticacao repetido: o supabase-js emite INITIAL_SESSION (e depois
  // SIGNED_IN/TOKEN_REFRESHED) para a MESMA sessao que o getSession do boot ja
  // entregou. Sem esta guarda, cada evento reabre a rota em "loading".
  const resolvedKeyRef = useRef<string | null>(null);

  const chaveDaSessao = (s: Session | null) => (s ? `${s.user.id}:${s.access_token}` : null);

  const resolveRoute = useCallback(async (current: Session | null) => {
    const requestId = ++routeRequest.current;
    setSession(current);

    if (!current) {
      resolvedKeyRef.current = null;
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
      resolvedKeyRef.current = chaveDaSessao(current);
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

    // Teto absoluto do boot. getSession() do supabase-js passa por um mutex
    // proprio e, se ele nao liberar, a promessa simplesmente nunca assenta --
    // nao ha' erro para capturar. Sem este limite a tela fica em "Validando
    // perfil..." para sempre, que foi exatamente o sintoma relatado.
    const limiteBoot = window.setTimeout(() => {
      if (!active || routeRequest.current > 0) return;
      ++routeRequest.current;
      setSession(null);
      setRoute("error");
      setAuthReady(true);
    }, 8_000);

    supabase.auth.getSession()
      .then(({ data, error }) => {
        window.clearTimeout(limiteBoot);
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
        window.clearTimeout(limiteBoot);
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
      // Mesma sessao ja' resolvida -> nada a fazer. Este `return` e' a correcao:
      // sem ele, INITIAL_SESSION logo apos o getSession do boot disparava um
      // segundo resolveRoute, que jogava a tela de volta para "Validando
      // perfil..." e descartava o primeiro pelo guarda de requestId. Quando o
      // segundo tambem nao conseguia concluir, a validacao ficava eterna.
      if (chaveDaSessao(current) === resolvedKeyRef.current) return;
      scheduleRoute(current);
    });

    return () => {
      active = false;
      window.clearTimeout(limiteBoot);
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
    {session && <JarvisVoice />}
    {session && <BriefingStaffBridge session={session} />}
    {session && <MaterialTriageBridge session={session} />}
    {session && <WorkReassignmentBridge session={session} />}
    {session && <WorkReassignmentAwayBridge session={session} />}
  </>;
}
