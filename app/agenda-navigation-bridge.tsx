"use client";

import { useEffect } from "react";

export default function AgendaNavigationBridge() {
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem("leonardo-executive-panel") === "agenda") {
        window.sessionStorage.setItem("leonardo-executive-panel", "direction");
      }
    } catch { /* ignore */ }

    const style = document.createElement("style");
    style.id = "agenda-disabled-style";
    style.textContent = `
      [data-agenda-nav],
      [data-leonardo-panel="agenda"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);

    document.querySelectorAll("[data-agenda-nav]").forEach((node) => node.remove());

    return () => style.remove();
  }, []);

  return null;
}
