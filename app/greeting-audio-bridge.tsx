"use client";

import { useEffect } from "react";

const AUDIO_URL = "/api/greeting-audio?v=20260822-force-audible-v8";
const SILENT_VOLUME = 0.001;

export default function GreetingAudioBridge() {
  useEffect(() => {
    const audio = new Audio(AUDIO_URL);
    audio.preload = "auto";
    audio.playsInline = true;
    audio.loop = true;
    audio.muted = false;
    audio.volume = SILENT_VOLUME;

    let armed = false;
    let openingActive = false;
    let disposed = false;

    const armFromGesture = () => {
      if (disposed || openingActive) return;
      try {
        audio.muted = false;
        audio.volume = SILENT_VOLUME;
        audio.loop = true;
        if (audio.ended) audio.currentTime = 0;

        if (!audio.paused) {
          armed = true;
          return;
        }

        const result = audio.play();
        if (result) {
          void result.then(() => {
            if (!disposed) armed = true;
          }).catch(() => {
            armed = false;
          });
        } else {
          armed = true;
        }
      } catch {
        armed = false;
      }
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        try {
          // O elemento já foi autorizado por um gesto real do usuário no login.
          // Não chamamos play() aqui: apenas voltamos para 0s e elevamos o volume
          // do MESMO fluxo de mídia que já está reproduzindo.
          audio.loop = false;
          audio.muted = false;
          audio.currentTime = 0;
          audio.volume = 1;
        } catch {}
        return;
      }

      if (!opening && openingActive) {
        openingActive = false;
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.loop = true;
          audio.muted = false;
          audio.volume = SILENT_VOLUME;
        } catch {}
        armed = false;
      }
    };

    document.addEventListener("pointerdown", armFromGesture, true);
    document.addEventListener("keydown", armFromGesture, true);
    document.addEventListener("touchstart", armFromGesture, { capture: true, passive: true });

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const poll = window.setInterval(syncOpening, 120);
    syncOpening();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(poll);
      document.removeEventListener("pointerdown", armFromGesture, true);
      document.removeEventListener("keydown", armFromGesture, true);
      document.removeEventListener("touchstart", armFromGesture, true);
      try {
        audio.pause();
        audio.src = "";
      } catch {}
      void armed;
    };
  }, []);

  return null;
}
