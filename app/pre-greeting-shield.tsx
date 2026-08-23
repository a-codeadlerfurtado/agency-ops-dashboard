"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

const ADLER_TEST_EMAIL = "adlerfurtadomkt01@gmail.com";

function expectsAudioGreeting(session: Session) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
  }).format(new Date());

  return weekday === "Monday" || session.user.email?.toLowerCase() === ADLER_TEST_EMAIL;
}

export default function PreGreetingShield() {
  const [visible, setVisible] = useState(false);
  const armed = useRef(false);
  const authCheckTimer = useRef<number | null>(null);
  const safetyTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (authCheckTimer.current !== null) window.clearTimeout(authCheckTimer.current);
      if (safetyTimer.current !== null) window.clearTimeout(safetyTimer.current);
      authCheckTimer.current = null;
      safetyTimer.current = null;
    };

    const dismiss = () => {
      armed.current = false;
      clearTimers();
      setVisible(false);
    };

    const onLoginSubmit = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches(".auth-card form")) return;

      armed.current = true;
      setVisible(true);
      clearTimers();

      // Se o login falhar, não deixa a camada visual presa sobre o formulário.
      authCheckTimer.current = window.setTimeout(async () => {
        if (!armed.current) return;
        const { data } = await supabase.auth.getSession();
        if (!data.session || !expectsAudioGreeting(data.session)) dismiss();
      }, 6000);

      // Proteção puramente visual: nunca pode bloquear a aplicação indefinidamente.
      safetyTimer.current = window.setTimeout(() => {
        if (armed.current) dismiss();
      }, 20000);
    };

    const onAudioStart = () => {
      if (armed.current) dismiss();
    };

    const onAudioError = () => {
      // Em caso de erro, revela a abertura real para que o estado/erro atual continue visível.
      if (armed.current) dismiss();
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!armed.current) return;
      if (!session) return;
      if (!expectsAudioGreeting(session)) dismiss();
    });

    document.addEventListener("submit", onLoginSubmit, true);
    window.addEventListener("opsq:greeting-audio-start", onAudioStart);
    window.addEventListener("opsq:greeting-audio-error", onAudioError);

    return () => {
      clearTimers();
      subscription.unsubscribe();
      document.removeEventListener("submit", onLoginSubmit, true);
      window.removeEventListener("opsq:greeting-audio-start", onAudioStart);
      window.removeEventListener("opsq:greeting-audio-error", onAudioError);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="opsq-pre-greeting-shield" aria-live="polite" aria-label="Preparando abertura">
      <style>{`
        @keyframes opsqPrePulse{0%,100%{opacity:.38;transform:scale(.92)}50%{opacity:1;transform:scale(1)}}
        @keyframes opsqPreSweep{0%{transform:translateX(-130%)}100%{transform:translateX(230%)}}
        .opsq-pre-greeting-shield{position:fixed;inset:0;z-index:30010;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 50% 42%,rgba(24,91,124,.18),transparent 34%),#01080e;color:#dff7ff;font-family:Inter,system-ui,sans-serif}
        .opsq-pre-greeting-shield:before{content:"";position:absolute;inset:-80px;background-image:linear-gradient(rgba(57,132,168,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(57,132,168,.025) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at center,#000 8%,transparent 72%);pointer-events:none}
        .opsq-pre-greeting-card{position:relative;width:min(430px,calc(100vw - 48px));display:grid;justify-items:center;gap:18px;text-align:center}
        .opsq-pre-greeting-mark{width:58px;height:58px;border-radius:50%;border:1px solid rgba(96,204,249,.38);box-shadow:0 0 42px rgba(64,184,236,.11);display:grid;place-items:center;animation:opsqPrePulse 1.7s ease-in-out infinite}
        .opsq-pre-greeting-mark:after{content:"";width:10px;height:10px;border-radius:50%;background:#7dd8ff;box-shadow:0 0 18px rgba(125,216,255,.75)}
        .opsq-pre-greeting-card strong{font-family:Inter Tight,Inter,sans-serif;font-size:22px;letter-spacing:-.025em;font-weight:700}
        .opsq-pre-greeting-card span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;letter-spacing:.18em;color:#6098b5;text-transform:uppercase}
        .opsq-pre-greeting-track{position:relative;width:190px;height:1px;overflow:hidden;background:rgba(89,164,199,.14)}
        .opsq-pre-greeting-track:after{content:"";position:absolute;inset:0 auto 0 0;width:42%;background:linear-gradient(90deg,transparent,#77d0fb,transparent);animation:opsqPreSweep 1.2s linear infinite}
      `}</style>
      <div className="opsq-pre-greeting-card">
        <div className="opsq-pre-greeting-mark" />
        <strong>Preparando sua abertura</strong>
        <div className="opsq-pre-greeting-track" />
        <span>Sincronizando Voice Core</span>
      </div>
    </div>
  );
}
