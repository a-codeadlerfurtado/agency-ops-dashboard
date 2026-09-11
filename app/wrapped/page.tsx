"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authenticatedFetch, BrandMark, SUPABASE_URL, supabase } from "../shared";
import { buildStories, storyDuration, type WrappedMode } from "./story-engine";
import "./wrapped.css";

const WRAPPED_API = `${SUPABASE_URL}/functions/v1/agency-ops-wrapped-api`;
const SPEEDS = [0.75, 1, 1.25, 1.5];
const modeLabel: Record<WrappedMode, string> = { summary: "Resumo", full: "Completo", mgmt: "MGMT" };
const coverageLabel: Record<string, string> = { FULL: "FULL", PARTIAL_STRONG: "PARCIAL FORTE", PARTIAL: "PARCIAL" };

function labelMonth(key: string) {
  if (!key) return "";
  const value = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${key}-01T12:00:00Z`));
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function WrappedPage() {
  const [authReady, setAuthReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [role, setRole] = useState("");
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState("");
  const [mode, setMode] = useState<WrappedMode>("full");
  const [payload, setPayload] = useState<any>(null);
  const [loading, setLoading] = useState(true);  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number | null>(null);

  const stories = useMemo(() => payload ? buildStories(payload, mode) : [], [payload, mode]);
  const story = stories[index] || null;

  const goTo = useCallback((next: number) => {
    setProgress(0);
    setIndex(Math.max(0, Math.min(next, Math.max(0, stories.length - 1))));
  }, [stories.length]);
  const next = useCallback(() => {
    if (index >= stories.length - 1) { setPaused(true); setProgress(1); return; }
    goTo(index + 1);
  }, [goTo, index, stories.length]);
  const previous = useCallback(() => goTo(index - 1), [goTo, index]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSignedIn(Boolean(data.session));
      setAuthReady(true);
    }).catch(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;    setLoading(true); setError("");
    authenticatedFetch(`${WRAPPED_API}?months=1`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
        if (cancelled) return;
        setMonths(body.months || []);
        setRole(String(body.role || ""));
        setMonth((current) => current || body.default_month || body.months?.[0] || "");
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Falha ao abrir o Wrapped."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn]);

  useEffect(() => {
    if (!month || !signedIn) return;
    let cancelled = false;
    setLoading(true); setError(""); setPayload(null); setIndex(0); setProgress(0); setPaused(false);
    authenticatedFetch(`${WRAPPED_API}?month=${encodeURIComponent(month)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
        if (!cancelled) setPayload(body.payload);
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Falha ao carregar o mês."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, signedIn]);

  useEffect(() => {
    if (!story || paused) return;
    const duration = storyDuration(story) / speed;
    const interval = window.setInterval(() => {
      setProgress((current) => {
        const updated = current + 50 / duration;
        if (updated >= 1) { window.clearInterval(interval); window.setTimeout(next, 0); return 1; }
        return updated;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [story?.id, paused, speed, next]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.code === "Space") { event.preventDefault(); setPaused((value) => !value); }
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); next(); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); previous(); }
      else if (event.key === "Escape" && document.fullscreenElement) void document.exitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous]);

  useEffect(() => {
    const reveal = () => {
      setControls(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (!paused) hideTimer.current = window.setTimeout(() => setControls(false), 2600);
    };
    window.addEventListener("mousemove", reveal);
    window.addEventListener("touchstart", reveal, { passive: true });
    reveal();
    return () => {
      window.removeEventListener("mousemove", reveal);
      window.removeEventListener("touchstart", reveal);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [paused]);

  useEffect(() => {
    if (index >= stories.length && stories.length) setIndex(stories.length - 1);
  }, [index, stories.length]);

  const cycleSpeed = () => {
    const current = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(current + 1) % SPEEDS.length]);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  if (!authReady) return <main className="wrapped-state"><span className="wrapped-spinner" />Validando acesso…</main>;
  if (!signedIn) return <main className="wrapped-state"><BrandMark /><h1>Seu Wrapped está no dashboard.</h1><a href="/">Entrar no dashboard</a></main>;
  if (loading && !payload) return <main className="wrapped-state"><span className="wrapped-spinner" />Montando {month ? labelMonth(month) : "seu mês"}…</main>;
  if (error) return <main className="wrapped-state"><BrandMark /><h1>Não consegui abrir o Wrapped.</h1><p>{error}</p><a href="/">Voltar ao dashboard</a></main>;
  if (!story) return null;

  const tone = story.tone || "blue";
  const remainingMs = Math.max(0, storyDuration(story) * (1 - progress) / speed);
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return <main className={`wrapped-shell tone-${tone}${paused ? " is-paused" : ""}`} onDoubleClick={() => setPaused((value) => !value)}>
    <div className="wrapped-bg" aria-hidden="true"><i /><i /><i /><i /></div>

    <div className="wrapped-progress" aria-label={`Cena ${index + 1} de ${stories.length}`}>
      {stories.map((item, position) => <span key={item.id} className={position < index ? "done" : position === index ? "current" : ""}>
        <i style={{ transform: `scaleX(${position < index ? 1 : position === index ? progress : 0})` }} />
      </span>)}
    </div>

    <header className={`wrapped-top ${controls || paused ? "show" : ""}`}>
      <a className="wrapped-brand" href="/" aria-label="Voltar ao dashboard"><BrandMark /><span>Leonardo Imobi</span></a>
      <div className="wrapped-selectors">
        <select value={month} onChange={(event) => setMonth(event.target.value)} aria-label="Mês do Wrapped">
          {months.map((key) => <option key={key} value={key}>{labelMonth(key)}</option>)}
        </select>
        <div className="wrapped-mode">
          {(["summary", "full", ...(role === "MGMT" ? ["mgmt"] : [])] as WrappedMode[]).map((item) =>
            <button key={item} className={mode === item ? "active" : ""} onClick={() => { setMode(item); setIndex(0); setProgress(0); }}>{modeLabel[item]}</button>)}
        </div>
      </div>
      <button className="wrapped-fullscreen" onClick={fullscreen} title="Tela cheia">⛶</button>
    </header>

    <section className="wrapped-stage" key={story.id}>
      <div className="wrapped-chapter"><span>{story.chapter}</span><b>{String(index + 1).padStart(2, "0")} / {String(stories.length).padStart(2, "0")}</b></div>
      <div className="wrapped-story">
        {story.kicker && <div className="wrapped-kicker">{story.kicker}</div>}
        <h1>{story.title}</h1>
        {story.value && <div className="wrapped-value">{story.value}</div>}
        {story.subtitle && <p className="wrapped-subtitle">{story.subtitle}</p>}
        {story.stats?.length ? <div className="wrapped-stats">{story.stats.map((stat, pos) => <article key={`${stat.label}-${pos}`}>
          <small>{stat.label}</small><strong>{stat.value}</strong>{stat.delta && <span>{stat.delta}</span>}
        </article>)}</div> : null}
        {story.ranking?.length ? <div className="wrapped-ranking">{story.ranking.map((row, pos) => <div key={`${row.name}-${pos}`}>
          <em>{String(pos + 1).padStart(2, "0")}</em><span><b>{row.name}</b>{row.meta && <small>{row.meta}</small>}</span><strong>{row.value}</strong>
        </div>)}</div> : null}
        {story.note && <p className="wrapped-note">{story.note}</p>}
      </div>
    </section>
    <footer className={`wrapped-controls ${controls || paused ? "show" : ""}`}>
      <button onClick={previous} disabled={index === 0} aria-label="Cena anterior">←</button>
      <button className="wrapped-play" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Continuar" : "Pausar"}>{paused ? "▶" : "Ⅱ"}</button>
      <button onClick={next} disabled={index === stories.length - 1} aria-label="Próxima cena">→</button>
      <button className="wrapped-speed" onClick={cycleSpeed}>{speed}×</button>
      <span>{paused ? "Pausado" : `${seconds}s`}</span>
      <span className={`wrapped-coverage ${String(payload.coverage_tier || "").toLowerCase()}`}>{coverageLabel[payload.coverage_tier] || payload.coverage_tier}</span>
    </footer>

    <button className="wrapped-hit previous" onClick={previous} aria-label="Voltar uma cena" />
    <button className="wrapped-hit next" onClick={next} aria-label="Avançar uma cena" />
  </main>;
}
