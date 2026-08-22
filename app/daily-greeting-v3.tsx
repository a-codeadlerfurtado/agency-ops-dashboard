"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import { GREETING_AUDIO_V5_00 } from "./greeting-audio-v5/part-00";
import { GREETING_AUDIO_V5_01 } from "./greeting-audio-v5/part-01";
import { GREETING_AUDIO_V5_02 } from "./greeting-audio-v5/part-02";
import { GREETING_AUDIO_V5_03 } from "./greeting-audio-v5/part-03";
import { GREETING_AUDIO_V5_04 } from "./greeting-audio-v5/part-04";
import { GREETING_AUDIO_V5_05 } from "./greeting-audio-v5/part-05";
import { GREETING_AUDIO_V5_06 } from "./greeting-audio-v5/part-06";
import { GREETING_AUDIO_V5_07 } from "./greeting-audio-v5/part-07";
import { GREETING_AUDIO_V5_08 } from "./greeting-audio-v5/part-08";
import { GREETING_AUDIO_V5_09 } from "./greeting-audio-v5/part-09";

const GREETING_API = `${SUPABASE_URL}/functions/v1/agency-ops-daily-greeting-api`;
const FULL_GREETING_B64 = [
  GREETING_AUDIO_V5_00,
  GREETING_AUDIO_V5_01,
  GREETING_AUDIO_V5_02,
  GREETING_AUDIO_V5_03,
  GREETING_AUDIO_V5_04,
  GREETING_AUDIO_V5_05,
  GREETING_AUDIO_V5_06,
  GREETING_AUDIO_V5_07,
  GREETING_AUDIO_V5_08,
  GREETING_AUDIO_V5_09,
].join("");

type Greeting = {
  show: boolean;
  date: string;
  is_monday: boolean;
  person: string;
  first_name: string;
};

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor {
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext || w.webkitAudioContext!;
}

function decodeBundledAudio(): ArrayBuffer {
  const binary = atob(FULL_GREETING_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const claimedUser = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const endingNaturallyRef = useRef(false);

  const stopProgressTimer = () => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

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
      if (!session) claimedUser.current = null;
      claim(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!greeting?.is_monday) return;
    let cancelled = false;

    async function preload() {
      setLoading(true);
      setReady(false);
      setError(null);
      try {
        const bytes = decodeBundledAudio();
        const Ctor = getAudioContextCtor();
        const ctx = new Ctor();
        ctxRef.current = ctx;
        const decoded = await ctx.decodeAudioData(bytes.slice(0));
        if (cancelled) {
          await ctx.close().catch(() => undefined);
          return;
        }
        bufferRef.current = decoded;
        setReady(true);
        setLoading(false);

        try {
          await ctx.resume();
          if (ctx.state === "running") void startPlayback(ctx, decoded, false);
        } catch {
          // Se autoplay for bloqueado, o clique no botão desbloqueia o AudioContext.
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setReady(false);
          setError(e instanceof Error ? e.message : "Falha ao decodificar o áudio");
        }
      }
    }

    void preload();
    return () => {
      cancelled = true;
      stopProgressTimer();
      endingNaturallyRef.current = false;
      try { sourceRef.current?.stop(); } catch {}
      sourceRef.current = null;
      bufferRef.current = null;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    };
  }, [greeting?.date, greeting?.is_monday]);

  const startPlayback = async (ctxArg?: AudioContext, bufferArg?: AudioBuffer, fromClick = true) => {
    const ctx = ctxArg || ctxRef.current;
    const buffer = bufferArg || bufferRef.current;
    if (!ctx || !buffer) {
      setError("Áudio ainda não está pronto.");
      return;
    }
    if (playing) return;

    try {
      await ctx.resume();
      if (ctx.state !== "running") {
        if (fromClick) setError("Clique novamente em tocar para liberar o áudio.");
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      sourceRef.current = source;
      endingNaturallyRef.current = true;
      startedAtRef.current = ctx.currentTime;
      setError(null);
      setFinished(false);
      setProgress(0);
      setPlaying(true);

      stopProgressTimer();
      progressTimerRef.current = window.setInterval(() => {
        const elapsed = Math.max(0, ctx.currentTime - startedAtRef.current);
        setProgress(Math.min(1, elapsed / buffer.duration));
      }, 100);

      source.onended = () => {
        stopProgressTimer();
        sourceRef.current = null;
        setPlaying(false);
        if (endingNaturallyRef.current) {
          setProgress(1);
          setFinished(true);
        }
      };
      source.start(0);
    } catch (e) {
      setPlaying(false);
      setError(e instanceof Error ? e.message : "Não foi possível iniciar o áudio.");
    }
  };

  if (!greeting) return null;

  const needsAudio = greeting.is_monday;
  const canEnter = !needsAudio || finished;
  const close = () => {
    if (!canEnter) return;
    endingNaturallyRef.current = false;
    try { sourceRef.current?.stop(); } catch {}
    setGreeting(null);
  };

  const status = finished
    ? "Abertura concluída. Acesso liberado."
    : loading
      ? "Decodificando o áudio completo…"
      : playing
        ? "OpsQuestion falando · áudio completo"
        : error
          ? error
          : ready
            ? "Áudio pronto. Clique em tocar para continuar."
            : "Preparando áudio…";

  return (
    <div style={{ position:"fixed", inset:0, zIndex:30000, background:"radial-gradient(circle at 50% 35%,rgba(22,91,132,.20),rgba(1,8,14,.93) 48%,rgba(1,6,11,.98) 100%)", backdropFilter:"blur(9px)", display:"grid", placeItems:"center", padding:18 }}>
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
        {needsAudio && <div style={{ border:"1px solid rgba(82,172,225,.18)", background:"rgba(15,51,73,.42)", borderRadius:12, padding:"11px 13px", display:"grid", gap:9 }}><div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap" }}><div><b style={{ display:"block", color:"#ccecff", fontSize:11.5 }}>Abertura do OpsQuestion</b><span style={{ color:finished?"#78cda7":error?"#e7a19b":"#718fa3", fontSize:10 }}>{status}</span></div>{!finished && !loading && !playing && <button onClick={() => void startPlayback(undefined, undefined, true)} autoFocus style={{ border:"1px solid rgba(94,187,242,.45)", background:"#0b314a", color:"#e8f7ff", borderRadius:9, padding:"8px 12px", cursor:"pointer", fontWeight:850 }}>▶ Tocar abertura</button>}</div><div style={{ height:4, borderRadius:999, overflow:"hidden", background:"rgba(120,163,190,.14)" }}><div style={{ width:`${Math.round(progress*100)}%`, height:"100%", background:finished?"#4aa77d":"#55baf2", transition:"width .12s linear" }} /></div></div>}
        <div style={{ display:"flex", justifyContent:"flex-end" }}><button onClick={close} disabled={!canEnter} style={{ border:canEnter?"1px solid rgba(93,190,145,.52)":"1px solid rgba(112,135,151,.24)", background:canEnter?"#15503a":"#15212a", color:canEnter?"#f0fff7":"#667984", borderRadius:11, padding:"11px 18px", cursor:canEnter?"pointer":"not-allowed", fontWeight:900, minWidth:225 }}>{canEnter?"Entrar no dashboard":playing?"Aguarde o áudio terminar…":"Ouça a abertura para continuar"}</button></div>
      </section>
    </div>
  );
}
