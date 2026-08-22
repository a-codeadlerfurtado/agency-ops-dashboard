"use client";

import { useEffect } from "react";
import { GREETING_AUDIO_V6_00 } from "./greeting-audio-v6/part-00";
import { GREETING_AUDIO_V6_01 } from "./greeting-audio-v6/part-01";
import { GREETING_AUDIO_V6_02 } from "./greeting-audio-v6/part-02";
import { GREETING_AUDIO_V6_03 } from "./greeting-audio-v6/part-03";

const FALLBACK_DURATION = 22.824;
const FULL_GREETING_B64 = [
  GREETING_AUDIO_V6_00,
  GREETING_AUDIO_V6_03,
  GREETING_AUDIO_V6_02,
  GREETING_AUDIO_V6_01,
].join("").replace(/\s+/g, "");

function emit(name: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function base64ToArrayBuffer(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
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
      if (!FULL_GREETING_B64) throw new Error("Áudio embutido vazio");
      let bytes: ArrayBuffer;
      try {
        bytes = base64ToArrayBuffer(FULL_GREETING_B64);
      } catch (error) {
        throw new Error(error instanceof Error ? `Falha ao ler áudio embutido: ${error.message}` : "Falha ao ler áudio embutido");
      }
      if (!bytes.byteLength) throw new Error("Áudio embutido vazio");
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      if (!decoded.duration || !Number.isFinite(decoded.duration)) throw new Error("Áudio embutido inválido");
      duration = decoded.duration;
      return decoded;
    };

    // O buffer é preparado assim que a tela de login monta. Não existe mais
    // chamada HTTP para /api/greeting-audio, portanto um 500 do Worker não pode
    // bloquear a abertura.
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
        if (!unlockPromise) {
          unlockPromise = (ctx.state === "running" ? Promise.resolve() : ctx.resume())
            .then(() => {
              unlocked = true;
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
