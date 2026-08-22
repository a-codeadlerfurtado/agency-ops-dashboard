"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import { DAILY_GREETING_AUDIO_B64_0 } from "./daily-greeting-audio-0";
import { DAILY_GREETING_AUDIO_B64_1 } from "./daily-greeting-audio-1";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-daily-greeting-api`;
const FULL_GREETING_AUDIO = `data:audio/mpeg;base64,${DAILY_GREETING_AUDIO_B64_0}${DAILY_GREETING_AUDIO_B64_1}`;
const FULL_GREETING_SECONDS = 12.24;

type Greeting = {
  show: boolean;
  date: string;
  weekday?: string;
  is_monday: boolean;
  person: string;
  first_name: string;
  role?: string;
  audio_url?: string | null;
  audio_parts?: string[] | null;
  audio_duration_seconds?: number | null;
};

function SpeakingOrb({ speaking, finished }: { speaking: boolean; finished: boolean }) {
  return (
    <div className={`opsq-speaking-orb ${speaking ? "is-speaking" : ""} ${finished ? "is-finished" : ""}`} aria-hidden="true">
      <span className="opsq-wave opsq-wave-1" />
      <span className="opsq-wave opsq-wave-2" />
      <span className="opsq-wave opsq-wave-3" />

      <div className="opsq-orb-core">
        <div className="opsq-orb-glow" />
        <svg viewBox="0 0 100 100" className="opsq-orb-network">
          <defs>
            <radialGradient id="opsqSphere" cx="38%" cy="35%" r="68%">
              <stop offset="0%" stopColor="#225376" />
              <stop offset="48%" stopColor="#0b2d45" />
              <stop offset="100%" stopColor="#020b12" />
            </radialGradient>
            <filter id="opsqGlow">
              <feGaussianBlur stdDeviation="1.4" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <circle cx="50" cy="50" r="46" fill="url(#opsqSphere)" stroke="#194866" strokeWidth="1.2" />
          <g fill="none" stroke="#5689a6" strokeWidth="0.72" opacity="0.68" filter="url(#opsqGlow)">
            <path d="M19 39 L31 30 L40 37 L52 23 L65 33 L78 29" />
            <path d="M15 54 L30 49 L40 58 L52 49 L64 55 L82 46" />
            <path d="M22 69 L34 61 L47 70 L58 60 L73 67" />
            <path d="M32 30 L30 49 L34 61" />
            <path d="M40 37 L40 58 L47 70" />
            <path d="M52 23 L52 49 L58 60" />
            <path d="M65 33 L64 55 L73 67" />
          </g>
          <g fill="#8cc4e2" opacity="0.88">
            {[ [19,39],[31,30],[40,37],[52,23],[65,33],[78,29],[15,54],[30,49],[40,58],[52,49],[64,55],[82,46],[22,69],[34,61],[47,70],[58,60],[73,67] ].map(([cx, cy], index) => (
              <circle key={index} cx={cx} cy={cy} r={index % 4 === 0 ? 1.4 : 0.85} />
            ))}
          </g>
        </svg>
      </div>

      <div className="opsq-voice-waveform">
        {[0,1,2,3,4,5,6,7,8,9,10].map((bar) => <span key={bar} style={{ animationDelay: `${bar * 55}ms` }} />)}
      </div>
    </div>
  );
}

export default function DailyGreeting() {
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioFinished, setAudioFinished] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const claimedUser = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const hasOpeningAudio = Boolean(
    greeting?.audio_duration_seconds || greeting?.audio_url || greeting?.audio_parts?.length,
  );

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
        if (!cancelled && response.ok && body?.ok && body?.show) setGreeting(body as Greeting);
      } catch {
        // O bom dia nunca pode impedir o carregamento do restante do dashboard.
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
    if (!greeting) return;
    if (!hasOpeningAudio) {
      setAudioFinished(true);
      return;
    }

    let disposed = false;
    const audio = new Audio(FULL_GREETING_AUDIO);
    audio.preload = "auto";
    audio.volume = 1;
    audioRef.current = audio;
    setAudioLoading(true);
    setAudioBlocked(false);
    setAudioPlaying(false);
    setAudioFinished(false);
    setAudioProgress(0);

    const onPlay = () => {
      setAudioPlaying(true);
      setAudioBlocked(false);
      setAudioFinished(false);
    };
    const onPause = () => setAudioPlaying(false);
    const onTimeUpdate = () => {
      if (!audio.duration || !Number.isFinite(audio.duration)) return;
      setAudioProgress(Math.min(1, audio.currentTime / audio.duration));
    };
    const onEnded = () => {
      setAudioPlaying(false);
      setAudioBlocked(false);
      setAudioLoading(false);
      setAudioProgress(1);
      setAudioFinished(true);
    };
    const onCanPlay = async () => {
      if (disposed) return;
      setAudioLoading(false);
      try {
        audio.currentTime = 0;
        await audio.play();
      } catch {
        if (!disposed) setAudioBlocked(true);
      }
    };
    const onError = () => {
      setAudioLoading(false);
      setAudioPlaying(false);
      setAudioBlocked(true);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("canplaythrough", onCanPlay, { once: true });
    audio.addEventListener("error", onError);
    audio.load();

    if (audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) onCanPlay();

    return () => {
      disposed = true;
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [greeting?.date, hasOpeningAudio]);

  if (!greeting) return null;

  const monday = greeting.is_monday;
  const audioSeconds = Math.round(FULL_GREETING_SECONDS);
  const canEnter = !hasOpeningAudio || audioFinished;

  const close = () => {
    if (!canEnter) return;
    audioRef.current?.pause();
    setGreeting(null);
  };

  const playOpening = async () => {
    try {
      const audio = audioRef.current;
      if (!audio) return setAudioBlocked(true);
      if (audio.ended || audio.currentTime >= audio.duration - 0.1) {
        audio.currentTime = 0;
        setAudioFinished(false);
        setAudioProgress(0);
      }
      await audio.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  };

  const statusText = audioFinished
    ? "Abertura concluída. Acesso liberado."
    : audioLoading
      ? "Preparando abertura completa…"
      : audioPlaying
        ? `OpsQuestion falando · ~${audioSeconds}s`
        : audioBlocked
          ? "Clique em tocar para ouvir a abertura e continuar."
          : "Aguardando reprodução…";

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
      <style>{`
        @keyframes opsqOrbSpeak {
          0%,100% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.055); filter: brightness(1.16); }
        }
        @keyframes opsqWaveOut {
          0% { transform: translate(-50%,-50%) scale(.72); opacity: .72; }
          100% { transform: translate(-50%,-50%) scale(1.5); opacity: 0; }
        }
        @keyframes opsqBarSpeak {
          0%,100% { transform: scaleY(.32); opacity: .35; }
          50% { transform: scaleY(1); opacity: 1; }
        }
        @keyframes opsqNetworkPulse {
          0%,100% { opacity: .58; }
          50% { opacity: 1; }
        }
        .opsq-speaking-orb { position:relative; width:190px; height:172px; margin:0 auto; display:grid; place-items:center; }
        .opsq-orb-core { position:relative; z-index:3; width:104px; height:104px; border-radius:999px; box-shadow:0 0 34px rgba(55,151,205,.16), inset 0 0 22px rgba(39,126,180,.17); }
        .opsq-orb-glow { position:absolute; inset:7px; border-radius:999px; background:radial-gradient(circle at 39% 34%, rgba(74,139,178,.34), rgba(10,39,59,.20) 46%, rgba(1,7,12,.75) 76%); box-shadow:inset 0 0 22px rgba(44,129,181,.25); }
        .opsq-orb-network { position:absolute; inset:0; width:100%; height:100%; }
        .opsq-speaking-orb.is-speaking .opsq-orb-core { animation:opsqOrbSpeak .78s ease-in-out infinite; }
        .opsq-speaking-orb.is-speaking .opsq-orb-network { animation:opsqNetworkPulse .58s ease-in-out infinite; }
        .opsq-wave { position:absolute; left:50%; top:48%; width:118px; height:118px; border-radius:999px; border:1px solid rgba(89,192,241,.52); transform:translate(-50%,-50%) scale(.75); opacity:0; z-index:1; }
        .opsq-speaking-orb.is-speaking .opsq-wave { animation:opsqWaveOut 1.65s ease-out infinite; }
        .opsq-speaking-orb.is-speaking .opsq-wave-2 { animation-delay:.46s; }
        .opsq-speaking-orb.is-speaking .opsq-wave-3 { animation-delay:.92s; }
        .opsq-speaking-orb.is-finished .opsq-orb-core { box-shadow:0 0 30px rgba(62,184,133,.18), inset 0 0 22px rgba(39,126,180,.17); }
        .opsq-voice-waveform { position:absolute; bottom:4px; left:50%; transform:translateX(-50%); height:31px; display:flex; align-items:center; gap:4px; z-index:4; }
        .opsq-voice-waveform span { width:3px; height:25px; border-radius:99px; background:linear-gradient(180deg,#86d2fa,#327ca8); transform:scaleY(.22); transform-origin:center; opacity:.26; }
        .opsq-speaking-orb.is-speaking .opsq-voice-waveform span { animation:opsqBarSpeak .58s ease-in-out infinite; }
        .opsq-speaking-orb.is-finished .opsq-voice-waveform span { background:linear-gradient(180deg,#83e0ba,#34795e); opacity:.42; transform:scaleY(.3); }
      `}</style>

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
          padding: "24px 28px 24px",
          display: "grid",
          gap: 15,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", inset: "0 0 auto", height: 2, background: "linear-gradient(90deg, transparent, rgba(91,194,255,.85), transparent)" }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: "#72bff0", fontSize: 10.5, fontWeight: 900, letterSpacing: ".14em" }}>
            {monday ? "OPSQUESTION · INÍCIO DE SEMANA" : "OPSQUESTION · ONLINE"}
          </span>
          <span style={{ color: "#557a92", fontSize: 9.5, fontWeight: 800, letterSpacing: ".08em" }}>SISTEMA OPERACIONAL</span>
        </div>

        <SpeakingOrb speaking={audioPlaying} finished={audioFinished} />

        <div style={{ display: "grid", gap: 8, textAlign: "center" }}>
          <h1 style={{ margin: 0, fontFamily: "Inter Tight, Inter, sans-serif", fontSize: "clamp(30px, 6vw, 46px)", lineHeight: 1.02, letterSpacing: "-.035em" }}>
            Bom dia, {greeting.first_name}.
          </h1>
          <p style={{ margin: "0 auto", color: "#adc4d4", fontSize: 14.5, lineHeight: 1.6, maxWidth: 520 }}>
            {monday
              ? "Nova semana operacional iniciada. Organização, execução e bons resultados por aí."
              : "OpsQuestion online. Que tenhamos um dia produtivo e uma excelente execução nas atividades de hoje."}
          </p>
        </div>

        {hasOpeningAudio && (
          <div style={{ border: "1px solid rgba(82,172,225,.18)", background: "rgba(15,51,73,.42)", borderRadius: 12, padding: "11px 13px", display: "grid", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 2 }}>
                <b style={{ color: "#ccecff", fontSize: 11.5 }}>Abertura do OpsQuestion</b>
                <span style={{ color: audioFinished ? "#78cda7" : "#718fa3", fontSize: 10 }}>{statusText}</span>
              </div>
              {!audioFinished && !audioLoading && audioBlocked && (
                <button
                  type="button"
                  onClick={playOpening}
                  autoFocus
                  style={{ border: "1px solid rgba(94,187,242,.45)", background: "#0b314a", color: "#e8f7ff", borderRadius: 9, padding: "8px 11px", cursor: "pointer", font: "inherit", fontSize: 10.5, fontWeight: 850 }}
                >
                  ▶ Tocar abertura
                </button>
              )}
            </div>
            <div style={{ height: 3, borderRadius: 999, overflow: "hidden", background: "rgba(120,163,190,.14)" }}>
              <div style={{ width: `${Math.round(audioProgress * 100)}%`, height: "100%", borderRadius: 999, background: audioFinished ? "#4aa77d" : "#55baf2", transition: "width .16s linear" }} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={close}
            disabled={!canEnter}
            autoFocus={canEnter}
            aria-disabled={!canEnter}
            style={{
              border: canEnter ? "1px solid rgba(93,190,145,.52)" : "1px solid rgba(112,135,151,.24)",
              background: canEnter ? "#15503a" : "#15212a",
              color: canEnter ? "#f0fff7" : "#667984",
              borderRadius: 11,
              padding: "11px 18px",
              cursor: canEnter ? "pointer" : "not-allowed",
              font: "inherit",
              fontSize: 12.5,
              fontWeight: 900,
              minWidth: 215,
              transition: "all .2s ease",
            }}
          >
            {canEnter ? "Entrar no dashboard" : audioPlaying ? "Aguarde o áudio terminar…" : "Ouça a abertura para continuar"}
          </button>
        </div>
      </section>
    </div>
  );
}
