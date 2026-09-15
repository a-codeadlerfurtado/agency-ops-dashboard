"use client";

import { useEffect } from "react";

/**
 * Remove visualmente o widget legado AIAskWidget da Home. O OpsQuestion global,
 * montado no RootLayout, substitui esse componente em todas as rotas.
 */
export default function OpsQuestionBrand() {
  useEffect(() => {
    const hideLegacyWidget = () => {
      document.querySelectorAll("b").forEach((node) => {
        const text = node.textContent?.trim();
        if (text === "Perguntar à IA" || text === "Perguntar à IA · agency_ops") {
          const aside = node.closest("aside") as HTMLElement | null;
          if (aside) {
            aside.style.display = "none";
            aside.dataset.opsquestionLegacy = "hidden";
          }
        }
      });
    };

    hideLegacyWidget();
    const observer = new MutationObserver(hideLegacyWidget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
