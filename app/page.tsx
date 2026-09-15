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
import { getSessionBounded, limparPerfilEmCache, loadProfileLite, perfilEmCache, supabase } from "./shared";

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
  // Gate VISUAL do Jarvis, resolvido aqui e uma vez so.
  // O router acabou de provar o papel via loadProfileLite; mandar o JarvisVoice
  // perguntar de novo em /api/jarvis/access -> identificarUsuario -> profile-lite
  // era uma segunda cadeia redundante que, ao estourar, escondia o botao. A
  // seguranca real continua nas rotas /api/jarvis/*, que nao mudaram.
  const [jarvisAllowed, setJarvisAllowed] = useState(false);

  const chaveDaSessao = (s: Session | null) => (s ? `${s.user.id}:${s.access_token}` : null);

  const resolveRoute = useCallback(async (current: Session | null) => {
    const requestId = ++routeRequest.current;
    setSession(current);

    if (!current) {
      // Logout: o perfil guardado nao pode sobreviver a troca de conta, senao a
      // proxima pessoa a entrar neste navegador abriria a tela com o papel de
      // quem saiu -- visual apenas, mas confuso e desnecessario.
      limparPerfilEmCache();
      resolvedKeyRef.current = null;
      setJarvisAllowed(false);
      setRoute("native");
      setAuthReady(true);
      return;
    }

    // Abre pelo ultimo perfil bom deste usuario e revalida em seguida.
    //
    // O /auth/v1/user do Supabase oscila entre 400ms e 10s, e todo profile-lite
    // passa por ele. Bloquear a tela nisso e' o que produz "Validando perfil..."
    // por 15 segundos ou mais. Com o cache, quem ja entrou uma vez abre na hora;
    // a chamada real continua correndo e corrige o papel se ele tiver mudado.
    //
    // Cache NAO e' autorizacao. Ele decide UNICAMENTE qual tela pintar no
    // primeiro frame. Nenhuma API, RPC, acao financeira, rota do Jarvis, triagem
    // ou escrita usa este valor: todas continuam validando JWT e permissao no
    // servidor. Tem prazo de 1 hora e morre no logout.
    const cache = perfilEmCache(current.user?.id);
    if (cache) {
      const papelCache = String(cache.role || "").toUpperCase();
      resolvedKeyRef.current = chaveDaSessao(current);
      setJarvisAllowed(papelCache === "MGMT");
      setRoute(papelCache === "COMMERCIAL" && String(cache.person || "") === "Leonardo Augusto" ? "leonardo" : "native");
      setAuthReady(true);
    } else {
      setRoute("loading");
      setAuthReady(false);
    }

    try {
      // Usa exatamente a sessÃ£o entregue pelo evento. loadProfileLite nÃ£o volta ao
      // mutex do Supabase, entÃ£o o callback de autenticaÃ§Ã£o nunca entra em deadlock.
      const body = await loadProfileLite(current);
      if (requestId !== routeRequest.current) return;

      const role = String(body?.profile?.role || "").toUpperCase();
      const person = String(body?.profile?.person || "");
      resolvedKeyRef.current = chaveDaSessao(current);
      setJarvisAllowed(role === "MGMT");
      setRoute(role === "COMMERCIAL" && person === "Leonardo Augusto" ? "leonardo" : "native");
    } catch {
      if (requestId !== routeRequest.current) return;

      // Com cache a tela ja esta aberta: uma revalidacao lenta nao derruba quem
      // ja estava trabalhando. Sem cache, cai na tela recuperavel -- o usuario
      // nunca fica preso em validacao infinita.
      if (!cache) setRoute("error");
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
    //
    // 20s, nao 8s: medido, o getSession leva mais de 10s quando o Auth do
    // Supabase esta em pico, e desistir em 8s mostrava "Nao foi possivel
    // validar" para uma sessao que ia responder. O teto existe contra travar
    // para sempre, nao para cortar uma chamada lenta porem viva. Alinhado com
    // PROFILE_LITE_TIMEOUT_MS.
    const limiteBoot = window.setTimeout(() => {
      if (!active || routeRequest.current > 0) return;
      ++routeRequest.current;
      setSession(null);
      setRoute("error");
      setAuthReady(true);
    }, 20_000);

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

      // Deixa o callback sÃ­ncrono retornar antes de qualquer trabalho assÃ­ncrono.
      // SIGNED_OUT nÃ£o consulta o Supabase e pode ser aplicado imediatamente.
      if (!current) {
        limparPerfilEmCache();
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
    return <div className="auth-loading"><span className="dot loading"/> Validando perfilâ€¦</div>;
  }

  if (route === "error") {
    return <main className="auth-loading" style={{ display: "grid", gap: 12, placeItems: "center" }}>
      <span>NÃ£o foi possÃ­vel validar o perfil agora.</span>
      <button
        className="btn"
        onClick={() => {
          setAuthReady(false);
          setRoute("loading");
          void getSessionBounded()
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

