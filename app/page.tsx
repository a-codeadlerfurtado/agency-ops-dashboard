"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import NativeDashboard from "./dashboard-native";
import LeonardoNativeDashboard from "./leonardo-native-dashboard";
import LeonardoClientFinancialStatusBridge from "./leonardo-client-financial-status-bridge";
import WorkReassignmentBridge from "./work-reassignment-bridge";
import WorkReassignmentAwayBridge from "./work-reassignment-away-bridge";
import BriefingStaffBridge from "./briefing-staff-bridge";
import { supabase } from "./shared";

type RouteState = "loading" | "native" | "leonardo" | "error";
type RouteProfile = { person: string; role: string };

const ROUTE_PROFILE_TIMEOUT_MS = 4_000;

async function loadRouteProfile(current: Session): Promise<RouteProfile> {
  const userKey = current.user.id;
  if (!userKey) throw new Error("profile_user_missing");

  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("profile_route_timeout")), ROUTE_PROFILE_TIMEOUT_MS);
  });

  const read = (async () => {
    const ops = supabase.schema("agency_ops");
    const { data: pref, error: prefError } = await ops
      .from("user_preferences")
      .select("collaborator_person,name")
      .eq("user_key", userKey)
      .maybeSingle();

    if (prefError) throw prefError;
    const person = String(pref?.collaborator_person || pref?.name || "").trim();
    if (!person) throw new Error("profile_not_found");

    const { data: roster, error: rosterError } = await ops
      .from("team_roster")
      .select("person,role")
      .eq("person", person)
      .eq("is_former", false)
      .maybeSingle();

    if (rosterError) throw rosterError;
    if (!roster?.person || !roster?.role) throw new Error("profile_not_found");

    return {
      person: String(roster.person),
      role: String(roster.role).toUpperCase(),
    };
  })();

  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export default function DashboardRouter() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [route, setRoute] = useState<RouteState>("loading");
  const routeRequest = useRef(0);
  const routedUser = useRef("");

  const resolveRoute = useCallback(async (current: Session | null) => {
    const requestId = ++routeRequest.current;
    setSession(current);

    if (!current) {
      routedUser.current = "";
      setRoute("native");
      setAuthReady(true);
      return;
    }

    setRoute("loading");
    setAuthReady(false);

    try {
      // A decisão de rota precisa ser barata e não pode depender de uma Edge Function
      // disputando o Auth com o restante do Dashboard. As duas leituras abaixo usam
      // o JWT já presente na sessão e respeitam o RLS do schema agency_ops.
      const profile = await loadRouteProfile(current);
      if (requestId !== routeRequest.current) return;

      routedUser.current = current.user.id;
      setRoute(profile.role === "COMMERCIAL" && profile.person === "Leonardo Augusto" ? "leonardo" : "native");
    } catch {
      if (requestId !== routeRequest.current) return;
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, current) => {
      if (!active) return;

      if (!current) {
        void resolveRoute(null);
        return;
      }

      // Refresh de token não muda o papel do usuário. Atualizamos somente a sessão
      // entregue aos componentes e evitamos refazer a validação de perfil inteira.
      if (event === "TOKEN_REFRESHED") {
        setSession(current);
        return;
      }

      // SIGNED_IN pode ser emitido novamente ao recuperar foco. Se já roteamos o
      // mesmo usuário, não geramos novas consultas desnecessárias.
      if (event === "SIGNED_IN" && routedUser.current === current.user.id) {
        setSession(current);
        return;
      }

      if (event === "SIGNED_IN" || event === "USER_UPDATED") scheduleRoute(current);
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
