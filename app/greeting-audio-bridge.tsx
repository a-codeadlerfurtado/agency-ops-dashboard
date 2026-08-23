"use client";

import { useEffect } from "react";

const AUDIO_URL = "/audio/opsquestion-greeting-full-v6.mp3?v=20260822-webaudio-static-v16";
const FALLBACK_DURATION = 22.824;

function emit(name: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
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
    let keeperOscillator: OscillatorNode | null = null;
    let keeperGain: GainNode | null = null;
    let source: AudioBufferSourceNode | null = null;
    let startedAt = 0;
    let duration = FALLBACK_DURATION;
    let announcedStart = false;
    let playbackStarted = false;
    let playbackStarting = false;
    let playbackCompleted = false;

    const loadDecodedBuffer = async () => {
      const response = await fetch(AUDIO_URL, {
        cache: "force-cache",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Falha ao carregar MP3 (${response.status})`);

      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw new Error("MP3 vazio");

      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      if (!decoded.duration || !Number.isFinite(decoded.duration)) throw new Error("MP3 inválido");
      duration = decoded.duration;
      return decoded;
    };

    // Pré-carrega e decodifica o arquivo binário real ainda na tela de login.
    // Não usa <audio>, Blob URL, atob(), chunks base64 nem rota dinâmica.
    const bufferPromise = loadDecodedBuffer();
    void bufferPromise.catch((error) => {
      if (!disposed) {
        emit("opsq:greeting-audio-error", {
          message: error instanceof Error ? error.message : "Falha ao preparar o MP3",
        });
      }
    });

    const isLoginGesture = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return false;
      if (event.type === "submit" && target.matches(".auth-card form")) return true;
      if (target.closest(".auth-submit")) return true;
      return event instanceof KeyboardEvent && event.key === "Enter" && Boolean(target.closest(".auth-card form"));
    };

    const startKeeper = () => {
      if (keeperOscillator) return;
      try {
        keeperOscillator = ctx.createOscillator();
        keeperGain = ctx.createGain();
        keeperGain.gain.value = 0;
        keeperOscillator.connect(keeperGain).connect(ctx.destination);
        keeperOscillator.start();
      } catch {
        keeperOscillator = null;
        keeperGain = null;
      }
    };

    const stopKeeper = () => {
      if (keeperOscillator) {
        try { keeperOscillator.stop(); } catch {}
        try { keeperOscillator.disconnect(); } catch {}
      }
      if (keeperGain) {
        try { keeperGain.disconnect(); } catch {}
      }
      keeperOscillator = null;
      keeperGain = null;
    };

    const unlockFromLoginGesture = (event: Event) => {
      if (disposed || !isLoginGesture(event)) return;
      if (unlockPromise) return;

      try {
        unlockPromise = (ctx.state === "running" ? Promise.resolve() : ctx.resume())
          .then(() => {
            unlocked = ctx.state === "running";
            if (!unlocked) throw new Error("AudioContext não entrou em execução");

            // Mantém o contexto efetivamente ativo até a abertura aparecer.
            // O oscilador é inaudível (gain=0) e é encerrado assim que a voz começa.
            startKeeper();
          })
          .catch((error) => {
            unlocked = false;
            unlockPromise = null;
            emit("opsq:greeting-audio-error", {
              message: error instanceof Error ? error.message : "Falha ao liberar áudio no login",
            });
          });
      } catch (error) {
        unlocked = false;
        unlockPromise = null;
        emit("opsq:greeting-audio-error", {
          message: error instanceof Error ? error.message : "Falha ao liberar áudio no login",
        });
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
      playbackStarting = false;
      announcedStart = false;
      startedAt = 0;
    };

    const startOpeningPlayback = async () => {
      // IMPORTANTE: playbackStarting impede que o poll de 80 ms abra várias
      // reproduções concorrentes enquanto espera unlock/buffer. playbackCompleted
      // impede que o áudio recomece depois do onended enquanto a abertura ainda existe.
      if (disposed || !openingActive || playbackStarted || playbackStarting || playbackCompleted) return;
      playbackStarting = true;

      try {
        if (unlockPromise) await unlockPromise;
        if (!unlocked && ctx.state === "running") unlocked = true;
        if (!unlocked) throw new Error("Áudio não foi liberado pelo clique de login");

        const buffer = await bufferPromise;
        if (disposed || !openingActive || playbackStarted || playbackCompleted) return;

        if (ctx.state !== "running") {
          // O contexto foi previamente autorizado pelo clique do login. Esse resume
          // apenas recupera uma suspensão automática do navegador, sem novo gesto.
          await ctx.resume();
        }
        if (ctx.state !== "running") throw new Error("AudioContext suspenso");

        stopKeeper();

        const nextSource = ctx.createBufferSource();
        nextSource.buffer = buffer;
        nextSource.connect(master);
        nextSource.onended = () => {
          if (disposed || !openingActive || source !== nextSource) return;
          playbackCompleted = true;
          playbackStarted = false;
          source = null;
          emit("opsq:greeting-audio-progress", {
            progress: 1,
            currentTime: duration,
            duration,
          });
          emit("opsq:greeting-audio-ended");
        };

        source = nextSource;
        playbackStarted = true;
        startedAt = ctx.currentTime;
        nextSource.start(0);
        announceStart();
      } catch (error) {
        playbackStarted = false;
        emit("opsq:greeting-audio-error", {
          message: error instanceof Error ? error.message : "Falha ao iniciar áudio automático",
        });
      } finally {
        playbackStarting = false;
      }
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        announcedStart = false;
        playbackStarted = false;
        playbackStarting = false;
        playbackCompleted = false;
        void startOpeningPlayback();
        return;
      }

      if (!opening && openingActive) {
        openingActive = false;
        stopPlayback();
        stopKeeper();
        playbackCompleted = false;
      }
    };

    document.addEventListener("pointerdown", unlockFromLoginGesture, true);
    document.addEventListener("keydown", unlockFromLoginGesture, true);
    document.addEventListener("submit", unlockFromLoginGesture, true);

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const poll = window.setInterval(() => {
      syncOpening();
      if (!openingActive || playbackCompleted) return;

      if (!playbackStarted && !playbackStarting) {
        void startOpeningPlayback();
        return;
      }

      if (!playbackStarted) return;

      const elapsed = Math.max(0, ctx.currentTime - startedAt);
      const progress = Math.min(1, elapsed / Math.max(duration, 0.001));
      emit("opsq:greeting-audio-progress", {
        progress,
        currentTime: elapsed,
        duration,
      });
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
      stopKeeper();
      try { master.disconnect(); } catch {}
      try { if (ctx.state !== "closed") void ctx.close(); } catch {}
    };
  }, []);

  return null;
}
