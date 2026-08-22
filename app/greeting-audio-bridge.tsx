"use client";

import { useEffect } from "react";

const AUDIO_URL = "/api/greeting-audio?v=20260822-login-gesture-single-stream-v12";
const ARMED_GAIN = 0.00001;

function emit(name: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export default function GreetingAudioBridge() {
  useEffect(() => {
    const audio = new Audio(AUDIO_URL);
    audio.preload = "auto";
    audio.playsInline = true;
    audio.loop = true;
    audio.muted = false;
    audio.volume = 1;
    audio.load();

    let ctx: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let primed = false;
    let openingActive = false;
    let announcedStart = false;
    let disposed = false;

    const ensureGraph = () => {
      if (ctx && source && gain) return { ctx, gain };
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) throw new Error("AudioContext indisponível");
      ctx = new AudioCtx();
      source = ctx.createMediaElementSource(audio);
      gain = ctx.createGain();
      gain.gain.value = ARMED_GAIN;
      source.connect(gain);
      gain.connect(ctx.destination);
      return { ctx, gain };
    };

    const isLoginGesture = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return false;
      if (event.type === "submit" && target.matches(".auth-card form")) return true;
      if (target.closest(".auth-submit")) return true;
      return event instanceof KeyboardEvent && event.key === "Enter" && Boolean(target.closest(".auth-card form"));
    };

    const primeFromLoginGesture = (event: Event) => {
      if (disposed || openingActive || !isLoginGesture(event)) return;
      try {
        const graph = ensureGraph();
        graph.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
        graph.gain.gain.setValueAtTime(ARMED_GAIN, graph.ctx.currentTime);
        audio.loop = true;
        audio.muted = false;
        audio.volume = 1;
        try { audio.currentTime = 0; } catch {}

        // O play e o resume acontecem ainda dentro do gesto real de autenticação.
        if (graph.ctx.state !== "running") void graph.ctx.resume().catch(() => undefined);
        const playPromise = audio.play();
        primed = true;
        if (playPromise) {
          void playPromise.catch((error) => {
            primed = false;
            emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao autorizar áudio no login" });
          });
        }
      } catch (error) {
        primed = false;
        emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao preparar áudio" });
      }
    };

    const announceStart = () => {
      if (announcedStart || !openingActive) return;
      announcedStart = true;
      emit("opsq:greeting-audio-start", {
        duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 22.824,
      });
    };

    const releaseOpeningAudio = () => {
      if (disposed || !openingActive) return;
      try {
        const graph = ensureGraph();
        audio.loop = false;
        audio.muted = false;
        audio.volume = 1;
        try { audio.currentTime = 0; } catch {}
        graph.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
        graph.gain.gain.setValueAtTime(1, graph.ctx.currentTime);
        if (graph.ctx.state !== "running") void graph.ctx.resume().catch(() => undefined);
        if (!audio.paused) announceStart();
      } catch (error) {
        emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao liberar áudio" });
      }
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        announcedStart = false;
        releaseOpeningAudio();
        return;
      }

      if (!opening && openingActive) {
        openingActive = false;
        announcedStart = false;
        try {
          audio.pause();
          audio.loop = true;
          audio.muted = false;
          audio.volume = 1;
          audio.currentTime = 0;
          if (ctx && gain) gain.gain.setValueAtTime(ARMED_GAIN, ctx.currentTime);
        } catch {}
        primed = false;
      }
    };

    const recoverAfterLoad = () => {
      if (!openingActive) return;
      releaseOpeningAudio();
      if (primed && audio.paused) {
        const playPromise = audio.play();
        if (playPromise) {
          void playPromise.then(announceStart).catch((error) => {
            emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao continuar áudio" });
          });
        }
      }
    };

    const onPlaying = () => {
      if (openingActive) announceStart();
    };

    const onEnded = () => {
      if (!openingActive) return;
      emit("opsq:greeting-audio-progress", { progress: 1, currentTime: audio.duration || 22.824, duration: audio.duration || 22.824 });
      emit("opsq:greeting-audio-ended");
    };

    document.addEventListener("pointerdown", primeFromLoginGesture, true);
    document.addEventListener("keydown", primeFromLoginGesture, true);
    document.addEventListener("submit", primeFromLoginGesture, true);
    audio.addEventListener("loadedmetadata", recoverAfterLoad);
    audio.addEventListener("canplay", recoverAfterLoad);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const poll = window.setInterval(() => {
      syncOpening();
      if (!openingActive || audio.paused) return;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 22.824;
      const progress = Math.min(1, Math.max(0, audio.currentTime) / duration);
      emit("opsq:greeting-audio-progress", { progress, currentTime: audio.currentTime, duration });
    }, 80);
    syncOpening();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(poll);
      document.removeEventListener("pointerdown", primeFromLoginGesture, true);
      document.removeEventListener("keydown", primeFromLoginGesture, true);
      document.removeEventListener("submit", primeFromLoginGesture, true);
      audio.removeEventListener("loadedmetadata", recoverAfterLoad);
      audio.removeEventListener("canplay", recoverAfterLoad);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
      try { audio.pause(); } catch {}
      try { if (ctx && ctx.state !== "closed") void ctx.close(); } catch {}
      audio.src = "";
    };
  }, []);

  return null;
}
