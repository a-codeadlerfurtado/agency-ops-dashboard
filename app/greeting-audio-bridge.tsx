"use client";

import { useEffect } from "react";

const AUDIO_URL = "/api/greeting-audio?v=20260822-login-gesture-persistent-v10";
const ARMED_GAIN = 0.00001;

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
      if (target.closest(".auth-submit")) return true;
      if (event instanceof KeyboardEvent && event.key === "Enter" && target.closest(".auth-card form")) return true;
      return false;
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

        // As duas chamadas abaixo acontecem no MESMO call stack do clique/Enter
        // usado para autenticar. Depois da autenticação não pedimos autoplay de novo.
        if (graph.ctx.state !== "running") void graph.ctx.resume().catch(() => undefined);
        const playPromise = audio.play();
        primed = true;
        if (playPromise) {
          void playPromise.catch(() => {
            primed = false;
          });
        }
      } catch {
        primed = false;
      }
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

        // Se o play() já foi autorizado no login, apenas aumentar o ganho é suficiente.
        // Não existe uma segunda solicitação de autoplay após a autenticação.
        if (graph.ctx.state !== "running") void graph.ctx.resume().catch(() => undefined);
      } catch {}
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        releaseOpeningAudio();
        return;
      }

      if (!opening && openingActive) {
        openingActive = false;
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
      // O play original foi solicitado durante o gesto de login. Em navegadores
      // que só resolvem a Promise depois do buffer chegar, mantemos o mesmo pedido vivo.
      if (primed && audio.paused) {
        const playPromise = audio.play();
        if (playPromise) void playPromise.catch(() => undefined);
      }
    };

    document.addEventListener("pointerdown", primeFromLoginGesture, true);
    document.addEventListener("keydown", primeFromLoginGesture, true);
    audio.addEventListener("loadedmetadata", recoverAfterLoad);
    audio.addEventListener("canplay", recoverAfterLoad);

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const poll = window.setInterval(syncOpening, 80);
    syncOpening();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(poll);
      document.removeEventListener("pointerdown", primeFromLoginGesture, true);
      document.removeEventListener("keydown", primeFromLoginGesture, true);
      audio.removeEventListener("loadedmetadata", recoverAfterLoad);
      audio.removeEventListener("canplay", recoverAfterLoad);
      try { audio.pause(); } catch {}
      try { if (ctx && ctx.state !== "closed") void ctx.close(); } catch {}
      audio.src = "";
    };
  }, []);

  return null;
}
