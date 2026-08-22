"use client";

import { useEffect } from "react";

const AUDIO_URL = "/api/greeting-audio?v=20260822-predecoded-webaudio-v13";
const FALLBACK_DURATION = 22.824;

function emit(name: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export default function GreetingAudioBridge() {
  useEffect(() => {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      emit("opsq:greeting-audio-error", { message: "AudioContext indisponível neste navegador" });
      return;
    }

    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    let disposed = false;
    let openingActive = false;
    let unlocked = ctx.state === "running";
    let unlockPromise: Promise<void> | null = null;
    let source: AudioBufferSourceNode | null = null;
    let startedAt = 0;
    let duration = FALLBACK_DURATION;
    let announcedStart = false;
    let playbackStarted = false;

    const loadDecodedBuffer = async () => {
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${AUDIO_URL}&attempt=${attempt}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error(`Falha ao carregar áudio (${response.status})`);
          const bytes = await response.arrayBuffer();
          if (!bytes.byteLength) throw new Error("Arquivo de áudio vazio");
          const decoded = await ctx.decodeAudioData(bytes.slice(0));
          if (!decoded.duration || !Number.isFinite(decoded.duration)) throw new Error("Áudio inválido");
          duration = decoded.duration;
          return decoded;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await sleep(250 * (attempt + 1));
        }
      }

      throw lastError instanceof Error ? lastError : new Error("Não foi possível decodificar o áudio");
    };

    // Começa a baixar e decodificar assim que a tela de login monta. Isso não toca
    // nada e não depende de permissão de autoplay; apenas deixa o buffer pronto.
    const bufferPromise = loadDecodedBuffer();
    void bufferPromise.catch((error) => {
      if (!disposed) emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao preparar áudio" });
    });

    const isLoginGesture = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return false;
      if (event.type === "submit" && target.matches(".auth-card form")) return true;
      if (target.closest(".auth-submit")) return true;
      return event instanceof KeyboardEvent && event.key === "Enter" && Boolean(target.closest(".auth-card form"));
    };

    const unlockFromLoginGesture = (event: Event) => {
      if (disposed || !isLoginGesture(event)) return;

      try {
        // A permissão é conquistada no próprio gesto usado para entrar. Depois disso,
        // a abertura só cria um BufferSource em um contexto já liberado.
        if (!unlockPromise) {
          unlockPromise = (ctx.state === "running" ? Promise.resolve() : ctx.resume())
            .then(() => {
              unlocked = true;

              // Pulso silencioso de 20 ms mantém o contexto efetivamente ativado sem
              // consumir ou adiantar o áudio principal.
              const oscillator = ctx.createOscillator();
              const silentGain = ctx.createGain();
              silentGain.gain.value = 0;
              oscillator.connect(silentGain).connect(ctx.destination);
              oscillator.start();
              oscillator.stop(ctx.currentTime + 0.02);
            })
            .catch((error) => {
              unlocked = false;
              emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao liberar áudio no login" });
            });
        }
      } catch (error) {
        unlocked = false;
        emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao liberar áudio no login" });
      }
    };

    const announceStart = () => {
      if (announcedStart || !openingActive) return;
      announcedStart = true;
      emit("opsq:greeting-audio-start", { duration });
    };

    const stopPlayback = () => {
      if (source) {
        try { source.onended = null; source.stop(); } catch {}
        try { source.disconnect(); } catch {}
      }
      source = null;
      playbackStarted = false;
      announcedStart = false;
      startedAt = 0;
    };

    const startOpeningPlayback = async () => {
      if (disposed || !openingActive || playbackStarted) return;

      try {
        // O resume foi solicitado dentro do gesto de login. Esperamos essa mesma
        // Promise concluir; não pedimos uma nova interação ao usuário.
        if (unlockPromise) await unlockPromise;
        if (!unlocked && ctx.state === "running") unlocked = true;
        if (!unlocked) throw new Error("Áudio não foi liberado pelo gesto de login");

        const buffer = await bufferPromise;
        if (disposed || !openingActive || playbackStarted) return;

        const nextSource = ctx.createBufferSource();
        nextSource.buffer = buffer;
        nextSource.connect(master);
        nextSource.onended = () => {
          if (disposed || !openingActive || source !== nextSource) return;
          emit("opsq:greeting-audio-progress", { progress: 1, currentTime: duration, duration });
          emit("opsq:greeting-audio-ended");
          playbackStarted = false;
        };

        source = nextSource;
        playbackStarted = true;
        startedAt = ctx.currentTime;
        nextSource.start(0);
        announceStart();
      } catch (error) {
        playbackStarted = false;
        emit("opsq:greeting-audio-error", { message: error instanceof Error ? error.message : "Falha ao iniciar áudio automático" });
      }
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        announcedStart = false;
        playbackStarted = false;
        void startOpeningPlayback();
        return;
      }

      if (!opening && openingActive) {
        openingActive = false;
        stopPlayback();
      }
    };

    document.addEventListener("pointerdown", unlockFromLoginGesture, true);
    document.addEventListener("keydown", unlockFromLoginGesture, true);
    document.addEventListener("submit", unlockFromLoginGesture, true);

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const poll = window.setInterval(() => {
      syncOpening();
      if (!openingActive) return;

      if (!playbackStarted) {
        void startOpeningPlayback();
        return;
      }

      const elapsed = Math.max(0, ctx.currentTime - startedAt);
      const progress = Math.min(1, elapsed / Math.max(duration, 0.001));
      emit("opsq:greeting-audio-progress", { progress, currentTime: elapsed, duration });
    }, 80);

    syncOpening();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(poll);
      document.removeEventListener("pointerdown", unlockFromLoginGesture, true);
      document.removeEventListener("keydown", unlockFromLoginGesture, true);
      document.removeEventListener("submit", unlockFromLoginGesture, true);
      stopPlayback();
      try { master.disconnect(); } catch {}
      try { if (ctx.state !== "closed") void ctx.close(); } catch {}
    };
  }, []);

  return null;
}
