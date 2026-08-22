"use client";

import { useEffect } from "react";

const AUDIO_URL = "/api/greeting-audio?v=20260822-force-audible-v9";
const SILENT_VOLUME = 0.001;

export default function GreetingAudioBridge() {
  useEffect(() => {
    const audio = new Audio(AUDIO_URL);
    audio.preload = "auto";
    audio.playsInline = true;
    audio.loop = true;
    audio.muted = false;
    audio.volume = SILENT_VOLUME;

    let openingActive = false;
    let disposed = false;

    const playFromGesture = () => {
      if (disposed) return;
      try {
        const opening = Boolean(document.querySelector(".opsq-opening"));
        audio.muted = false;

        if (opening) {
          // Caminho garantido: se o usuário interagir enquanto a abertura está
          // visível, o play audível acontece dentro do próprio gesto.
          openingActive = true;
          audio.loop = false;
          audio.volume = 1;
          try { audio.currentTime = 0; } catch {}
          const result = audio.play();
          if (result) void result.catch(() => undefined);
          return;
        }

        // No login, autorizamos o MESMO elemento como áudio audível, porém em
        // volume quase zero. Depois não precisamos pedir uma nova permissão.
        audio.loop = true;
        audio.volume = SILENT_VOLUME;
        if (audio.ended) audio.currentTime = 0;
        if (!audio.paused) return;
        const result = audio.play();
        if (result) void result.catch(() => undefined);
      } catch {}
    };

    const syncOpening = () => {
      if (disposed) return;
      const opening = Boolean(document.querySelector(".opsq-opening"));

      if (opening && !openingActive) {
        openingActive = true;
        try {
          audio.loop = false;
          audio.muted = false;
          audio.volume = 1;
          try { audio.currentTime = 0; } catch {}

          // Se o login já autorizou o player, ele continua tocando ao elevar o
          // volume. Se não autorizou, o botão/clique da abertura usa o caminho
          // acima e chama play() dentro de um gesto real.
          if (audio.paused) return;
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
      }
    };

    document.addEventListener("pointerdown", playFromGesture, true);
    document.addEventListener("keydown", playFromGesture, true);
    document.addEventListener("touchstart", playFromGesture, { capture: true, passive: true });

    const observer = new MutationObserver(syncOpening);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const poll = window.setInterval(syncOpening, 120);
    syncOpening();

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(poll);
      document.removeEventListener("pointerdown", playFromGesture, true);
      document.removeEventListener("keydown", playFromGesture, true);
      document.removeEventListener("touchstart", playFromGesture, true);
      try {
        audio.pause();
        audio.src = "";
      } catch {}
    };
  }, []);

  return null;
}
