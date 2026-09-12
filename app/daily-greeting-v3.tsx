"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const GREETING_API = `${SUPABASE_URL}/functions/v1/agency-ops-daily-greeting-api`;

type Greeting = {
  show: boolean;
  date: string;
  is_monday: boolean;
  person: string;
  first_name: string;
};

type OpeningPhase = "standby" | "boot" | "core" | "greet" | "finalize" | "ready";

type ProgressDetail = {
  progress?: number;
  currentTime?: number;
  duration?: number;
};

function saudacaoPorHorario(): string {
  const hora = new Date().getHours();
  if (hora >= 5 && hora < 12) { return 'Bom dia'; }
  if (hora >= 12 && hora < 18) { return 'Boa tarde'; }
  return 'Boa noite';
}

function CinematicCore({ speaking, finished, progress, phase }: { speaking: boolean; finished: boolean; progress: number; phase: OpeningPhase }) {
  const ringProgress = Math.max(2, Math.round(progress * 100));
  const nodes = [[50,16],[72,24],[84,45],[78,69],[58,82],[34,78],[18,58],[22,34],[50,35],[65,47],[60,65],[40,66],[34,47],[50,52]];
  return (
    <div className={`opsq-cinematic-core ${speaking ? "is-speaking" : ""} ${finished ? "is-finished" : ""} phase-${phase}`} aria-hidden="true">
      <div className="opsq-core-aura" />
      <div className="opsq-progress-orbit" style={{ background: `conic-gradient(from -90deg, rgba(92,207,255,.96) 0 ${ringProgress}%, rgba(42,109,146,.12) ${ringProgress}% 100%)` }} />
      <div className="opsq-orbit opsq-orbit-a"><i /><i /><i /></div>
      <div className="opsq-orbit opsq-orbit-b"><i /><i /></div>
      <div className="opsq-orbit opsq-orbit-c"><i /><i /><i /><i /></div>
      <span className="opsq-pulse pulse-a" /><span className="opsq-pulse pulse-b" /><span className="opsq-pulse pulse-c" />
      <div className="opsq-core-shell">
        <div className="opsq-core-scan" />
        <svg viewBox="0 0 100 100" className="opsq-intelligence-mesh">
          <defs>
            <radialGradient id="opsqCoreSphere" cx="43%" cy="38%" r="68%">
              <stop offset="0%" stopColor="#22658f" stopOpacity=".72" />
              <stop offset="42%" stopColor="#0b3450" stopOpacity=".86" />
              <stop offset="100%" stopColor="#020b12" stopOpacity="1" />
            </radialGradient>
            <filter id="opsqNodeGlow"><feGaussianBlur stdDeviation="1.1" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <circle cx="50" cy="50" r="46" fill="url(#opsqCoreSphere)" stroke="rgba(92,190,235,.38)" strokeWidth=".7" />
          <g className="opsq-mesh-lines" fill="none" stroke="#70c8ee" strokeWidth=".55" opacity=".62">
            <path d="M50 16 L72 24 L84 45 L78 69 L58 82 L34 78 L18 58 L22 34 Z" />
            <path d="M22 34 L50 35 L72 24 M84 45 L65 47 L50 35 L34 47 L18 58" />
            <path d="M78 69 L60 65 L65 47 L50 52 L40 66 L34 78" />
            <path d="M34 47 L50 52 L50 35 M40 66 L50 52 L60 65 M50 16 L50 35 M58 82 L60 65" />
          </g>
          <g className="opsq-mesh-secondary" fill="none" stroke="#33789d" strokeWidth=".32" opacity=".36">
            <ellipse cx="50" cy="50" rx="30" ry="43" /><ellipse cx="50" cy="50" rx="43" ry="23" /><path d="M13 50 H87 M50 13 V87" />
          </g>
          <g className="opsq-mesh-nodes" fill="#b9eaff" filter="url(#opsqNodeGlow)">
            {nodes.map(([cx,cy], index) => <circle key={index} cx={cx} cy={cy} r={index < 8 ? 1.15 : .82} style={{ animationDelay: `${index * 71}ms` }} />)}
          </g>
        </svg>
        <div className="opsq-core-eye"><span /><span /></div>
      </div>
      <div className="opsq-core-caption left"><small>VOICE CORE</small><strong>{speaking ? "ACTIVE" : finished ? "STABLE" : "STANDBY"}</strong></div>
      <div className="opsq-core-caption right"><small>SEQUENCE</small><strong>{String(Math.round(progress * 100)).padStart(2, "0")}%</strong></div>
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

  useEffect(() => {
    const onStart = () => {
      setLoading(false);
      setReady(true);
      setError(null);
      setFinished(false);
      setProgress(0);
      setPlaying(true);
    };
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<ProgressDetail>).detail || {};
      const next = Math.min(1, Math.max(0, Number(detail.progress || 0)));
      setLoading(false);
      setReady(true);
      setProgress(next);
      if (next < 1) setPlaying(true);
    };
    const onEnded = () => {
      setLoading(false);
      setReady(true);
      setPlaying(false);
      setProgress(1);
      setFinished(true);
      setError(null);
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail || {};
      setLoading(false);
      setPlaying(false);
      setError(detail.message || "Falha ao iniciar a voz automaticamente.");
    };

    window.addEventListener("opsq:greeting-audio-start", onStart);
    window.addEventListener("opsq:greeting-audio-progress", onProgress);
    window.addEventListener("opsq:greeting-audio-ended", onEnded);
    window.addEventListener("opsq:greeting-audio-error", onError);
    return () => {
      window.removeEventListener("opsq:greeting-audio-start", onStart);
      window.removeEventListener("opsq:greeting-audio-progress", onProgress);
      window.removeEventListener("opsq:greeting-audio-ended", onEnded);
      window.removeEventListener("opsq:greeting-audio-error", onError);
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
        if (!cancelled && response.ok && body?.ok && body?.show) {
          setProgress(0);
          setFinished(false);
          setPlaying(false);
          setError(null);
          setLoading(Boolean(body.is_monday));
          setReady(!body.is_monday);
          setGreeting(body as Greeting);
        }
      } catch {}
    }

    supabase.auth.getSession().then(({ data }) => void claim(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        claimedUser.current = null;
        setGreeting(null);
        setLoading(false);
        setReady(false);
        setPlaying(false);
        setFinished(false);
        setProgress(0);
        setError(null);
        return;
      }
      void claim(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (!greeting) return null;

  const horaLocal = new Date().getHours();
  const needsAudio = greeting.is_monday && horaLocal >= 5 && horaLocal < 12;
  const canEnter = !needsAudio || finished;
  const saudacao = saudacaoPorHorario();
  const phase: OpeningPhase = finished ? "ready" : !playing ? "standby" : progress < .13 ? "boot" : progress < .36 ? "core" : progress < .78 ? "greet" : "finalize";
  const showGreeting = phase === "greet" || phase === "finalize" || phase === "ready";
  const showReady = phase === "finalize" || phase === "ready";

  const close = () => {
    setGreeting(null);
  };

  const status = finished
    ? "TRANSMISSÃO CONCLUÍDA"
    : loading
      ? "CONECTANDO VOICE CORE"
      : playing
        ? phase === "boot" ? "INICIALIZANDO SISTEMA" : phase === "core" ? "VOICE CORE ONLINE" : phase === "greet" ? "TRANSMISSÃO ATIVA" : "FINALIZANDO SEQUÊNCIA"
        : error
          ? error
          : ready ? "VOICE CORE PRONTO" : "PREPARANDO SISTEMA";

  return (
    <div className={`opsq-opening phase-${phase}`} data-needs-audio={needsAudio ? "1" : "0"}>
      <style>{`
        @keyframes opsqGridDrift{from{transform:translateY(0)}to{transform:translateY(44px)}}
        @keyframes opsqScan{0%{transform:translateY(-25vh);opacity:0}12%{opacity:.5}88%{opacity:.2}100%{transform:translateY(115vh);opacity:0}}
        @keyframes opsqCoreBreathe{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.035);filter:brightness(1.18)}}
        @keyframes opsqOrbitA{to{transform:rotate(360deg)}}
        @keyframes opsqOrbitB{to{transform:rotate(-360deg)}}
        @keyframes opsqNode{0%,100%{opacity:.28;transform:scale(.75)}50%{opacity:1;transform:scale(1.5)}}
        @keyframes opsqPulse{0%{transform:translate(-50%,-50%) scale(.62);opacity:.58}100%{transform:translate(-50%,-50%) scale(1.72);opacity:0}}
        @keyframes opsqAppear{from{opacity:0;transform:translateY(14px);filter:blur(5px)}to{opacity:1;transform:none;filter:blur(0)}}
        @keyframes opsqBorderWake{0%,100%{box-shadow:0 0 18px rgba(67,183,239,.04),0 35px 120px rgba(0,0,0,.72)}50%{box-shadow:0 0 42px rgba(67,183,239,.10),0 35px 120px rgba(0,0,0,.72)}}
        .opsq-opening{position:fixed;inset:0;z-index:30000;display:grid;place-items:center;padding:20px;overflow:hidden;color:#eefaff;background:radial-gradient(circle at 50% 38%,rgba(18,78,112,.24),transparent 34%),radial-gradient(circle at 50% 88%,rgba(20,77,99,.08),transparent 36%),#01080e}
        .opsq-opening:before{content:"";position:absolute;inset:-80px;background-image:linear-gradient(rgba(57,132,168,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(57,132,168,.03) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at center,#000 12%,transparent 78%);animation:opsqGridDrift 7s linear infinite;pointer-events:none}
        .opsq-opening:after{content:"";position:absolute;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(97,206,255,.35),transparent);box-shadow:0 0 24px rgba(83,194,245,.18);animation:opsqScan 7s linear infinite;pointer-events:none}
        .opsq-opening-shell{position:relative;width:min(820px,100%);min-height:650px;border:1px solid rgba(74,177,225,.24);border-radius:24px;background:linear-gradient(180deg,rgba(4,22,34,.96),rgba(2,12,20,.99));padding:25px 34px 28px;display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;animation:opsqBorderWake 3.6s ease-in-out infinite;isolation:isolate}
        .opsq-opening-shell:before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 50% 42%,rgba(36,139,188,.11),transparent 34%)}
        .opsq-close-btn{position:absolute;right:17px;top:15px;z-index:20;width:36px;height:36px;border-radius:50%;border:1px solid rgba(116,190,224,.28);background:rgba(4,19,29,.82);color:#a9cddd;font-size:24px;line-height:1;display:grid;place-items:center;cursor:pointer;touch-action:manipulation} .opsq-close-btn:hover{color:#fff;border-color:rgba(116,210,255,.6)}
        .opsq-corner{position:absolute;width:38px;height:38px;border-color:rgba(93,200,249,.52);opacity:.7}.opsq-corner.tl{left:14px;top:14px;border-left:1px solid;border-top:1px solid}.opsq-corner.tr{right:14px;top:14px;border-right:1px solid;border-top:1px solid}.opsq-corner.bl{left:14px;bottom:14px;border-left:1px solid;border-bottom:1px solid}.opsq-corner.br{right:14px;bottom:14px;border-right:1px solid;border-bottom:1px solid}
        .opsq-opening-head{display:flex;justify-content:space-between;align-items:center;gap:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.opsq-opening-head b{color:#78d0fb;font-size:10.5px;letter-spacing:.16em}.opsq-opening-head span{color:#52798f;font-size:9px;letter-spacing:.13em}
        .opsq-opening-stage{display:grid;align-content:center;justify-items:center;padding:6px 0 2px}.opsq-stage-copy{height:122px;text-align:center;display:grid;align-content:start;justify-items:center;margin-top:-6px}.opsq-stage-kicker{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#5faed3;font-size:9px;font-weight:800;letter-spacing:.24em;margin-bottom:9px}.opsq-stage-copy h1{margin:0;font-family:Inter Tight,Inter,sans-serif;font-size:clamp(38px,6vw,59px);line-height:1;letter-spacing:-.045em}.opsq-stage-copy p{margin:13px 0 0;color:#9fbaca;font-size:14px;line-height:1.55;max-width:610px}.opsq-greeting-copy,.opsq-system-copy{animation:opsqAppear .65s ease both}.opsq-system-copy{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#77c9ef;font-size:14px;letter-spacing:.13em}.opsq-system-copy strong{display:block;color:#dff7ff;font-family:Inter Tight,Inter,sans-serif;font-size:30px;letter-spacing:-.025em;margin-top:7px}
        .opsq-cinematic-core{position:relative;width:310px;height:310px;display:grid;place-items:center;margin:2px auto 5px}.opsq-core-aura{position:absolute;width:205px;height:205px;border-radius:50%;background:radial-gradient(circle,rgba(62,178,229,.14),rgba(20,82,112,.055) 52%,transparent 72%);filter:blur(4px)}.opsq-progress-orbit{position:absolute;width:230px;height:230px;border-radius:50%;padding:1px;opacity:.82;mask:radial-gradient(farthest-side,transparent calc(100% - 1px),#000 0)}
        .opsq-orbit{position:absolute;border-radius:50%;border:1px solid rgba(74,175,218,.17)}.opsq-orbit i{position:absolute;width:4px;height:4px;border-radius:50%;background:#78d7ff;box-shadow:0 0 10px rgba(86,207,255,.8)}.opsq-orbit-a{width:252px;height:252px;border-style:dashed;animation:opsqOrbitA 16s linear infinite}.opsq-orbit-a i:nth-child(1){left:11%;top:18%}.opsq-orbit-a i:nth-child(2){right:8%;top:55%}.opsq-orbit-a i:nth-child(3){left:46%;bottom:-2px}.opsq-orbit-b{width:278px;height:202px;transform:rotate(-18deg);animation:opsqOrbitB 21s linear infinite}.opsq-orbit-b i:nth-child(1){left:8%;top:43%}.opsq-orbit-b i:nth-child(2){right:10%;top:28%}.opsq-orbit-c{width:192px;height:286px;transform:rotate(26deg);border-color:rgba(62,147,186,.12);animation:opsqOrbitA 25s linear infinite}.opsq-orbit-c i:nth-child(1){left:49%;top:-3px}.opsq-orbit-c i:nth-child(2){right:4%;top:38%}.opsq-orbit-c i:nth-child(3){left:5%;bottom:28%}.opsq-orbit-c i:nth-child(4){left:54%;bottom:-2px}
        .opsq-core-shell{position:relative;width:166px;height:166px;border-radius:50%;z-index:4;background:rgba(2,13,21,.7);box-shadow:0 0 34px rgba(50,161,211,.14),inset 0 0 34px rgba(46,137,181,.09);animation:opsqCoreBreathe 3.2s ease-in-out infinite}.opsq-intelligence-mesh{position:absolute;inset:0;width:100%;height:100%}.opsq-mesh-nodes circle{transform-box:fill-box;transform-origin:center;animation:opsqNode 1.9s ease-in-out infinite}.opsq-core-scan{position:absolute;z-index:5;left:20%;right:20%;top:50%;height:1px;background:linear-gradient(90deg,transparent,#71d6ff,transparent);box-shadow:0 0 8px rgba(92,210,255,.35)}.opsq-core-eye{position:absolute;z-index:6;left:50%;top:50%;width:50px;height:9px;transform:translate(-50%,-50%);display:flex;gap:7px;justify-content:center;opacity:.15}.opsq-core-eye span{width:17px;height:2px;background:linear-gradient(90deg,transparent,#89e5ff,transparent);box-shadow:0 0 10px rgba(102,218,255,.8)}
        .opsq-pulse{position:absolute;left:50%;top:50%;width:175px;height:175px;border:1px solid rgba(91,203,246,.35);border-radius:50%;transform:translate(-50%,-50%);opacity:0}.is-speaking .opsq-pulse{animation:opsqPulse 2.15s ease-out infinite}.is-speaking .pulse-b{animation-delay:.7s}.is-speaking .pulse-c{animation-delay:1.4s}.phase-core .opsq-core-eye,.phase-greet .opsq-core-eye{opacity:.9}.is-finished .opsq-core-shell{box-shadow:0 0 36px rgba(70,190,139,.14),inset 0 0 30px rgba(50,152,115,.08)}
        .opsq-core-caption{position:absolute;top:50%;transform:translateY(-50%);display:grid;gap:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.opsq-core-caption.left{right:calc(100% - 12px);text-align:right}.opsq-core-caption.right{left:calc(100% - 12px)}.opsq-core-caption small{font-size:7px;letter-spacing:.18em;color:#456e83}.opsq-core-caption strong{font-size:9px;letter-spacing:.13em;color:#7fc8e9}
        .opsq-opening-foot{display:grid;gap:13px}.opsq-transmission{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.opsq-transmission-label{display:grid;gap:2px;min-width:145px}.opsq-transmission-label b{font-size:9px;letter-spacing:.14em;color:#77c9ef}.opsq-transmission-label span{font-size:8px;letter-spacing:.08em;color:#4e7285}.opsq-transmission-track{height:2px;background:rgba(95,158,190,.12);overflow:hidden}.opsq-transmission-track>i{display:block;height:100%;background:linear-gradient(90deg,#2184bd,#6bd8ff);box-shadow:0 0 12px rgba(75,196,246,.35);transition:width .1s linear}.opsq-transmission-percent{font-size:9px;color:#699bb3}.opsq-action-row{height:45px;display:flex;justify-content:flex-end;align-items:center}.opsq-enter-btn{border:1px solid rgba(93,190,145,.55);background:linear-gradient(180deg,#176144,#124b36);color:#f0fff7;min-width:190px;border-radius:10px;padding:10px 16px;font-size:11px;font-weight:850;cursor:pointer}.opsq-wait-state{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px;letter-spacing:.11em;color:#476a7c}.opsq-status-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#4aa9d4;box-shadow:0 0 9px rgba(67,181,228,.7);margin-right:7px}.phase-ready .opsq-status-dot{background:#63c998}
        @media(max-width:700px){.opsq-opening-shell{min-height:620px;padding:22px 19px}.opsq-cinematic-core{width:270px;height:285px}.opsq-core-shell{width:150px;height:150px}.opsq-progress-orbit{width:208px;height:208px}.opsq-orbit-a{width:226px;height:226px}.opsq-orbit-b{width:245px;height:184px}.opsq-orbit-c{width:174px;height:250px}.opsq-core-caption{display:none}.opsq-opening-head span{display:none}.opsq-stage-copy h1{font-size:40px}.opsq-transmission{grid-template-columns:1fr auto}.opsq-transmission-label{grid-column:1/-1}.opsq-action-row{justify-content:stretch}.opsq-enter-btn{width:100%}}
      `}</style>

      <section role="dialog" aria-modal="true" aria-label="Abertura do OpsQuestion" className="opsq-opening-shell">
        <button type="button" className="opsq-close-btn" onClick={close} aria-label="Fechar introdução">×</button>
        <i className="opsq-corner tl" /><i className="opsq-corner tr" /><i className="opsq-corner bl" /><i className="opsq-corner br" />
        <header className="opsq-opening-head">
          <b>OPSQUESTION // MONDAY INITIALIZATION</b>
          <span>SESSION // {greeting.first_name.toUpperCase()} · OPS CORE</span>
        </header>

        <main className="opsq-opening-stage">
          <CinematicCore speaking={playing} finished={finished} progress={progress} phase={phase} />
          <div className="opsq-stage-copy">
            {showGreeting ? (
              <div className="opsq-greeting-copy">
                <div className="opsq-stage-kicker">{showReady ? "OPERATION LAYER // READY" : "VOICE TRANSMISSION // ACTIVE"}</div>
                <h1>{saudacao}, {greeting.first_name}.</h1>
                <p>Nova semana operacional iniciada. Organização, execução e bons resultados por aí.</p>
              </div>
            ) : phase === "core" ? (
              <div className="opsq-system-copy"><span>INTELLIGENCE MESH</span><strong>VOICE CORE ONLINE</strong></div>
            ) : (
              <div className="opsq-system-copy"><span>OPSQUESTION</span><strong>{playing ? "INITIALIZING" : "BOOT SEQUENCE"}</strong></div>
            )}
          </div>
        </main>

        <footer className="opsq-opening-foot">
          {needsAudio && (
            <div className="opsq-transmission">
              <div className="opsq-transmission-label">
                <b><span className="opsq-status-dot" />{status}</b>
                <span>{finished ? "OPERAÇÃO ONLINE" : playing ? "VOICE TRANSMISSION IN PROGRESS" : error ? "FALHA NA INICIALIZAÇÃO AUTOMÁTICA" : "OPSQUESTION AUDIO ENGINE"}</span>
              </div>
              <div className="opsq-transmission-track"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <div className="opsq-transmission-percent">{String(Math.round(progress * 100)).padStart(2, "0")}%</div>
            </div>
          )}

          <div className="opsq-action-row">
            {canEnter ? (
              <button className="opsq-enter-btn" onClick={close} autoFocus>Entrar no dashboard →</button>
            ) : (
              <span className="opsq-wait-state">SEQUÊNCIA AUTOMÁTICA EM EXECUÇÃO · NENHUMA AÇÃO NECESSÁRIA</span>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
