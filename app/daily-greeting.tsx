"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-daily-greeting-api`;

type Greeting = {
  show: boolean;
  date: string;
  weekday?: string;
  is_monday: boolean;
  person: string;
  first_name: string;
  role?: string;
  audio_url?: string | null;
};

export default function DailyGreeting() {
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const claimedUser = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function claim(session: Session | null) {
      if (!session?.user?.id || claimedUser.current === session.user.id) return;
      claimedUser.current = session.user.id;
      try {
        const response = await authenticatedFetch(API_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "CLAIM" }),
          cache: "no-store",
        });
        const body = await response.json().catch(() => null);
        if (!cancelled && response.ok && body?.ok && body?.show) {
          setGreeting(body as Greeting);
        }
      } catch {
        // Saudação é complementar: nunca pode bloquear a operação do dashboard.
      }
    }

    supabase.auth.getSession().then(({ data }) => claim(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) claimedUser.current = null;
      claim(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!greeting?.audio_url) return;

    let disposed = false;
    let objectUrl: string | null = null;
    let audio: HTMLAudioElement | null = null;
    setAudioLoading(true);
    setAudioBlocked(false);

    const prepareAndPlay = async () => {
      try {
        // O arquivo é baixado por inteiro antes de iniciar. Isso evita áudio picotado
        // por streaming/range/cache intermediário no Worker/Cloudflare.
        const response = await fetch(greeting.audio_url as string, {
          cache: "reload",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(`audio_http_${response.status}`);
        const blob = await response.blob();
        if (disposed) return;

        objectUrl = URL.createObjectURL(blob);
        audio = new Audio();
        audio.preload = "auto";
        audio.volume = 0.9;
        audio.src = objectUrl;
        audioRef.current = audio;

        const onPlay = () => { setAudioPlaying(true); setAudioBlocked(false); };
        const onPause = () => setAudioPlaying(false);
        const onEnded = () => setAudioPlaying(false);
        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        audio.addEventListener("ended", onEnded);

        await new Promise<void>((resolve, reject) => {
          if (!audio) return reject(new Error("audio_not_created"));
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error("audio_decode_failed")); };
          const cleanup = () => {
            audio?.removeEventListener("canplaythrough", ready);
            audio?.removeEventListener("error", failed);
          };
          audio.addEventListener("canplaythrough", ready, { once: true });
          audio.addEventListener("error", failed, { once: true });
          audio.load();
          if (audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) ready();
        });

        if (disposed || !audio) return;
        setAudioLoading(false);
        audio.currentTime = 0;
        await audio.play();
      } catch {
        if (!disposed) {
          setAudioLoading(false);
          setAudioBlocked(true);
        }
      }
    };

    prepareAndPlay();

    return () => {
      disposed = true;
      setAudioLoading(false);
      audio?.pause();
      if (audioRef.current === audio) audioRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [greeting?.date, greeting?.audio_url]);

  if (!greeting) return null;

  const monday = greeting.is_monday;
  const hasOpeningAudio = Boolean(greeting.audio_url);
  const close = () => {
    audioRef.current?.pause();
    setGreeting(null);
  };
  const playOpening = async () => {
    try {
      if (!audioRef.current) return setAudioBlocked(true);
      if (audioRef.current.ended || audioRef.current.currentTime >= audioRef.current.duration - 0.1) {
        audioRef.current.currentTime = 0;
      }
      await audioRef.current.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  };

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 30000,
        background: "radial-gradient(circle at 50% 35%, rgba(22,91,132,.20), rgba(1,8,14,.93) 48%, rgba(1,6,11,.98) 100%)",
        backdropFilter: "blur(9px)",
        display: "grid",
        placeItems: "center",
        padding: 18,
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Bom dia do OpsQuestion"
        style={{
          width: "min(640px, 100%)",
          border: monday ? "1px solid rgba(79,190,255,.48)" : "1px solid rgba(82,153,198,.35)",
          background: "linear-gradient(180deg, rgba(6,25,39,.99), rgba(3,14,24,.99))",
          borderRadius: 20,
          boxShadow: monday ? "0 30px 110px rgba(0,0,0,.72), 0 0 54px rgba(49,151,213,.13)" : "0 30px 100px rgba(0,0,0,.68)",
          color: "#eef8ff",
          padding: "26px 28px 24px",
          display: "grid",
          gap: 18,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", inset: "0 0 auto", height: 2, background: "linear-gradient(90deg, transparent, rgba(91,194,255,.85), transparent)" }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: "#72bff0", fontSize: 10.5, fontWeight: 900, letterSpacing: ".14em" }}>
            {monday ? "OPSQUESTION · INÍCIO DE SEMANA" : "OPSQUESTION · ONLINE"}
          </span>
          <span style={{ color: "#557a92", fontSize: 9.5, fontWeight: 800, letterSpacing: ".08em" }}>
            SISTEMA OPERACIONAL
          </span>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <h1 style={{ margin: 0, fontFamily: "Inter Tight, Inter, sans-serif", fontSize: "clamp(30px, 6vw, 46px)", lineHeight: 1.02, letterSpacing: "-.035em" }}>
            Bom dia, {greeting.first_name}.
          </h1>
          <p style={{ margin: 0, color: "#adc4d4", fontSize: 15, lineHeight: 1.65, maxWidth: 550 }}>
            {monday
              ? "Nova semana operacional iniciada. Organização, execução e bons resultados por aí."
              : "OpsQuestion online. Que tenhamos um dia produtivo e uma excelente execução nas atividades de hoje."}
          </p>
        </div>

        {hasOpeningAudio && (
          <div style={{ border: "1px solid rgba(82,172,225,.18)", background: "rgba(15,51,73,.42)", borderRadius: 12, padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 2 }}>
              <b style={{ color: "#ccecff", fontSize: 11.5 }}>Abertura de segunda-feira</b>
              <span style={{ color: "#718fa3", fontSize: 10 }}>
                {audioLoading ? "Carregando áudio completo…" : audioPlaying ? "Áudio em reprodução · 10s" : audioBlocked ? "Reprodução automática bloqueada ou indisponível." : "Áudio de abertura carregado · 10s"}
              </span>
            </div>
            {!audioLoading && audioBlocked && (
              <button
                type="button"
                onClick={playOpening}
                style={{ border: "1px solid rgba(94,187,242,.45)", background: "#0b314a", color: "#e8f7ff", borderRadius: 9, padding: "8px 11px", cursor: "pointer", font: "inherit", fontSize: 10.5, fontWeight: 850 }}
              >
                ▶ Tocar abertura
              </button>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={close}
            autoFocus
            style={{
              border: "1px solid rgba(93,190,145,.52)",
              background: "#15503a",
              color: "#f0fff7",
              borderRadius: 11,
              padding: "11px 18px",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12.5,
              fontWeight: 900,
              minWidth: 168,
            }}
          >
            Entrar no dashboard
          </button>
        </div>
      </section>
    </div>
  );
}
