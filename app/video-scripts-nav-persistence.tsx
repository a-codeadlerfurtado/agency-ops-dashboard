"use client";

import { useEffect } from "react";

export default function VideoScriptsNavPersistence() {
  useEffect(() => {
    if (window.location.pathname !== "/") return;

    let preserved: HTMLButtonElement | null = null;
    let applying = false;

    const ensure = () => {
      if (applying) return;
      applying = true;
      try {
        const container = document.querySelector<HTMLElement>(".side-nav-items");
        if (!container) return;

        const live = container.querySelector<HTMLButtonElement>("[data-video-scripts-nav]");
        if (!preserved && live) preserved = live;
        if (!preserved) return;

        if (live && live !== preserved) live.remove();
        if (preserved.parentElement !== container) container.appendChild(preserved);
      } finally {
        applying = false;
      }
    };

    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(ensure, 1000);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
