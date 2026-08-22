"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const GREETING_API = `${SUPABASE_URL}/functions/v1/agency-ops-daily-greeting-api`;
const AUDIO_URL = "/api/greeting-audio?v=20260822-mp3-v6-http-range";
const FALLBACK_DURATION = 22.824;

type Greeting = {
  show: boolean;
  date: string;
  is_monday: boolean;
  person: string;
  first_name: string;
};

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext || w.webkitAudioContext || null;
}

function SpeakingOrb({ speaking, finished }: { speaking: boolean; finished: boolean }) {
  return (
    <div className={`opsq3-orb ${speaking ? "speaking" : ""} ${finished ? "finished" : ""}`} aria-hidden="true">
      <i className="wave w1" /><i className="wave w2" /><i className="wave w3" />
      <div className="core">
        <svg viewBox="0 0 100 100">
          <defs>
            <radialGradient id="opsq3sphere" cx="38%" cy="34%" r="68%">
              <stop offset="0%" stopColor="#225d86" />
              <stop offset="52%" stopColor="#0a304a" />
              <stop offset="100%" stopColor="#020b12" />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="46" fill="url(#opsq3sphere)" stroke="#235b7d" strokeWidth="1" />
          <g fill="none" stroke="#7ec4e8" strokeWidth=".72" opacity=".72">
            <path d="M19 39 L31 30 L40 37 L52 23 L65 33 L78 29" />
            <path d="M15 54 L30 49 L40 58 L52 49 L64 55 L82 46" />
            <path d="M22 69 L34 61 L47 70 L58 60 L73 67" />
            <path d="M31 30 L30 49 L34 61 M40 37 L40 58 L47 70 M52 23 L52 49 L58 60 M65 33 L64 55 L73 67" />
          </g>
          <g fill="#a9dcf5">{[[19,39],[31,30],[40,37],[52,23],[65,33],[78,29],[15,54],[30,49],[40,58],[52,49],[64,55],[82,46],[22,69],[34,61],[47,70],[58,60],[73,67]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r={i % 4 === 0 ? 1.35 : .8} />)}</g>
        </svg>
      </div>
      <div className="bars">{Array.from({ length: 13 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 47}ms` }} />)}</div>
    </div>
  );
}

export default function DailyGreetingV3() {
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const claimedUser = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const endingNaturallyRef = useRef(false);
  const playGenerationRef = useRef(0);

  const stopProgressTimer = () => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  const markEnded = () => {
    stopProgressTimer();
    setPlaying(false);
    if (endingNaturallyRef.current) {
      setProgress(1);
      setFinished(true);
    }
  };

  const beginProgress = (duration: number, currentTime: () => number) => {
    endingNaturallyRef.current = true;
    setError(null);
    setFinished(false);
    setProgress(0);
    setPlaying(true);
    setLoading(false);
    stopProgressTimer();
    progressTimerRef.current = window.setInterval(() => {
      setProgress(Math.min(1, Math.max(0, currentTime()) / Math.max(.1, duration || FALLBACK_DURATION)));
    }, 100);
  };

  // A ativação de áudio acontece no gesto real do usuário ANTES da autenticação.
  // O contexto permanece vivo e é reutilizado quando a saudação chega do backend.
  useEffect(() => {
    const primeAudio = () => {
      try {
        const Ctor = getAudioContextCtor();
        if (!Ctor) return;
        let ctx = ctxRef.current;
        if (!ctx || ctx.state === "closed") {
          ctx = new Ctor();
          ctxRef.current = ctx;
        }
        if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
      } catch {}
    };

    document.addEventListener("pointerdown", primeAudio, true);
    document.addEventListener("keydown", primeAudio, true);
    document.addEventListener("touchstart", primeAudio, { capture: true, passive: true });

    const audio = new Audio(AUDIO_URL);
    audio.preload = "auto";
    audio.playsInline = true;
    audio.volume = 1;
    htmlAudioRef.current = audio;

    return () => {
      document.removeEventListener("pointerdown", primeAudio, true);
      document.removeEventListener("keydown", primeAudio, true);
      document.removeEventListener("touchstart", primeAudio, true);
      audio.pause();
      audio.src = "";
      htmlAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function claim(session: Session | null) {
      if (!session?.user?.id || claimedUser.current === session.user.id) return;
      claimedUser.current = session.user.id;
      try {
        const response = await authenticatedFetch(GREETING_API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "CLAIM" }),
          cache: "no-store",
        });
        const body = await response.json().catch(() => null);
        if (!cancelled && response.ok && body?.ok && body?.show) setGreeting(body as Greeting);
      } catch {}
    }

    supabase.auth.getSession().then(({ data }) => claim(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        claimedUser.current = null;
        playGenerationRef.current += 1;
        endingNaturallyRef.current = false;
        try { sourceRef.current?.stop(); } catch {}
        sourceRef.current = null;
        const audio = htmlAudioRef.current;
        if (audio) {
          audio.pause();
          try { audio.currentTime = 0; } catch {}
        }
        setGreeting(null);
        setPlaying(false);
        setFinished(false);
        setProgress(0);
      }
      claim(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const playWithWebAudio = async (ctx: AudioContext, generation: number) => {
    if (ctx.state !== "running") await ctx.resume();
    if (ctx.state !== "running") throw new Error("Saída de áudio bloqueada pelo navegador.");

    const response = await fetch(AUDIO_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Áudio HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    if (generation !== playGenerationRef.current) return;

    try { sourceRef.current?.stop(); } catch {}
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.buffer = decoded;
    source.connect(gain);
    gain.connect(ctx.destination);
    sourceRef.current = source;
    const startedAt = ctx.currentTime;
    source.onended = markEnded;
    source.start(0);
    beginProgress(decoded.duration || FALLBACK_DURATION, () => Math.max(0, ctx.currentTime - startedAt));
  };

  const playWithHtmlAudio = async () => {
    const audio = htmlAudioRef.current;
    if (!audio) throw new Error("Player HTML indisponível.");
    audio.pause();
    audio.muted = false;
    audio.volume = 1;
    try { audio.currentTime = 0; } catch {}
    audio.onended = markEnded;
    await audio.play();
    beginProgress(Number.isFinite(audio.duration) ? audio.duration : FALLBACK_DURATION, () => audio.currentTime);
  };

  const startPlayback = async (fromClick: boolean) => {
    if (playing || loading) return;
    const generation = ++playGenerationRef.current;
    setLoading(true);
    setError(null);
    endingNaturallyRef.current = false;

    try {
      let ctx = ctxRef.current;
      const Ctor = getAudioContextCtor();

      if (fromClick && Ctor && (!ctx || ctx.state === "closed" || ctx.state !== "running")) {
        if (ctx && ctx.state !== "closed") await ctx.close().catch(() => undefined);
        ctx = new Ctor();
        ctxRef.current = ctx;
        await ctx.resume();
      }

      if (ctx && ctx.state === "running") {
        await playWithWebAudio(ctx, generation);
        return;
      }

      if (fromClick) {
        await playWithHtmlAudio();
        return;
      }

      setLoading(false);
      setError("Áudio pronto. Clique em tocar para liberar a voz.");
    } catch (webAudioError) {
      if (fromClick) {
        try {
          await playWithHtmlAudio();
          return;
        } catch (htmlError) {
          setLoading(false);
          setPlaying(false);
          const first = webAudioError instanceof Error ? webAudioError.message : "Web Audio falhou";
          const second = htmlError instanceof Error ? htmlError.message : "HTML Audio falhou";
          setError(`${first} · ${second}`);
          return;
        }
      }
      setLoading(false);
      setPlaying(false);
      setError(webAudioError instanceof Error ? webAudioError.message : "Não foi possível iniciar a voz.");
    }
  };

  useEffect(() => {
    if (!greeting?.is_monday) return;
    void startPlayback(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greeting?.date, greeting?.is_monday]);

  useEffect(() => () => {
    playGenerationRef.current += 1;
    stopProgressTimer();
    endingNaturallyRef.current = false;
    try { sourceRef.current?.stop(); } catch {}
    sourceRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    const audio = htmlAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
    }
  }, []);

  if (!greeting) return null;

  const needsAudio = greeting.is_monday;
  const canEnter = !needsAudio || finished;
  const close = () => {
    if (!canEnter) return;
    playGenerationRef.current += 1;
    endingNaturallyRef.current = false;
    const audio = htmlAudioRef.current;
    if (audio) audio.pause();
    try { sourceRef.current?.stop(); } catch {}
    setGreeting(null);
  };

  const status = finished
    ? "Abertura concluída. Acesso liberado."
    : loading
      ? "Carregando MP3 da voz…"
      : playing
        ? "OpsQuestion falando · áudio MP3"
        : error
          ? error
          : "Áudio pronto.";

  return (
    <div className="opsq-opening" style={{ position:"fixed", inset:0, zIndex:30000, background:"radial-gradient(circle at 50% 35%,rgba(22,91,132,.20),rgba(1,8,14,.93) 48%,rgba(1,6,11,.98) 100%)", backdropFilter:"blur(9px)", display:"grid", placeItems:"center", padding:18 }}>
      <style>{`
        @keyframes orbTalk3{0%,100%{transform:scale(1)}50%{transform:scale(1.065);filter:brightness(1.2)}}
        @keyframes waveOut3{0%{transform:translate(-50%,-50%) scale(.72);opacity:.72}100%{transform:translate(-50%,-50%) scale(1.55);opacity:0}}
        @keyframes barTalk3{0%,100%{transform:scaleY(.25);opacity:.35}50%{transform:scaleY(1);opacity:1}}
        .opsq3-orb{position:relative;width:210px;height:180px;margin:auto;display:grid;place-items:center}.opsq3-orb .core{position:relative;z-index:3;width:112px;height:112px;border-radius:50%;box-shadow:0 0 38px rgba(55,151,205,.2)}.opsq3-orb svg{width:100%;height:100%}.opsq3-orb.speaking .core{animation:orbTalk3 .68s ease-in-out infinite}.opsq3-orb .wave{position:absolute;left:50%;top:47%;width:126px;height:126px;border:1px solid rgba(89,192,241,.52);border-radius:50%;transform:translate(-50%,-50%) scale(.75);opacity:0}.opsq3-orb.speaking .wave{animation:waveOut3 1.5s ease-out infinite}.opsq3-orb.speaking .w2{animation-delay:.42s}.opsq3-orb.speaking .w3{animation-delay:.84s}.opsq3-orb .bars{position:absolute;bottom:1px;left:50%;transform:translateX(-50%);height:34px;display:flex;align-items:center;gap:4px}.opsq3-orb .bars span{width:3px;height:27px;border-radius:99px;background:linear-gradient(#86d2fa,#327ca8);transform:scaleY(.2);opacity:.28}.opsq3-orb.speaking .bars span{animation:barTalk3 .48s ease-in-out infinite}.opsq3-orb.finished .bars span{background:linear-gradient(#83e0ba,#34795e);opacity:.45}
      `}</style>
      <section role="dialog" aria-modal="true" aria-label="Bom dia do OpsQuestion" style={{ width:"min(640px,100%)", border:"1px solid rgba(79,190,255,.48)", background:"linear-gradient(180deg,rgba(6,25,39,.99),rgba(3,14,24,.99))", borderRadius:20, boxShadow:"0 30px 110px rgba(0,0,0,.72)", color:"#eef8ff", padding:"24px 28px", display:"grid", gap:14 }}>
        <div style={{ display:"flex", justifyContent:"space-between", gap:12 }}><b style={{ color:"#72bff0", fontSize:10.5, letterSpacing:".14em" }}>OPSQUESTION · INÍCIO DE SEMANA</b><b style={{ color:"#557a92", fontSize:9.5, letterSpacing:".08em" }}>SISTEMA OPERACIONAL</b></div>
        <SpeakingOrb speaking={playing} finished={finished} />
        <div style={{ textAlign:"center" }}><h1 style={{ margin:0, fontFamily:"Inter Tight,Inter,sans-serif", fontSize:"clamp(30px,6vw,46px)", letterSpacing:"-.035em" }}>Bom dia, {greeting.first_name}.</h1><p style={{ color:"#adc4d4", fontSize:14.5, lineHeight:1.6 }}>Nova semana operacional iniciada. Organização, execução e bons resultados por aí.</p></div>
        {needsAudio && <div style={{ border:"1px solid rgba(82,172,225,.18)", background:"rgba(15,51,73,.42)", borderRadius:12, padding:"11px 13px", display:"grid", gap:9 }}><div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap" }}><div><b style={{ display:"block", color:"#ccecff", fontSize:11.5 }}>Abertura do OpsQuestion</b><span style={{ color:finished?"#78cda7":error?"#e7a19b":"#718fa3", fontSize:10 }}>{status}</span></div>{!finished && !playing && <button onClick={() => void startPlayback(true)} disabled={loading} autoFocus style={{ border:"1px solid rgba(94,187,242,.45)", background:"#0b314a", color:"#e8f7ff", borderRadius:9, padding:"8px 12px", cursor:loading?"wait":"pointer", fontWeight:850 }}>{loading?"Carregando…":"▶ Tocar abertura"}</button>}</div><div style={{ height:4, borderRadius:999, overflow:"hidden", background:"rgba(120,163,190,.14)" }}><div style={{ width:`${Math.round(progress*100)}%`, height:"100%", background:finished?"#4aa77d":"#55baf2", transition:"width .12s linear" }} /></div></div>}
        <div style={{ display:"flex", justifyContent:"flex-end" }}><button onClick={close} disabled={!canEnter} style={{ border:canEnter?"1px solid rgba(93,190,145,.52)":"1px solid rgba(112,135,151,.24)", background:canEnter?"#15503a":"#15212a", color:canEnter?"#f0fff7":"#667984", borderRadius:11, padding:"11px 18px", cursor:canEnter?"pointer":"not-allowed", fontWeight:900, minWidth:225 }}>{canEnter?"Entrar no dashboard":playing?"Aguarde o áudio terminar…":"Ouça a abertura para continuar"}</button></div>
      </section>
    </div>
  );
}
