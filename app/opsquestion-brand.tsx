"use client";

import { useEffect } from "react";

/**
 * Mantém a identidade do copiloto consistente sem acoplar o layout ao componente
 * legado AIAskWidget que ainda vive em app/page.tsx.
 */
export default function OpsQuestionBrand() {
  useEffect(() => {
    const applyBrand = () => {
      document.querySelectorAll("b").forEach((node) => {
        const text = node.textContent?.trim();
        if (text === "Perguntar à IA") node.textContent = "OpsQuestion";
        if (text === "Perguntar à IA · agency_ops") node.textContent = "OpsQuestion · agency_ops";
      });

      document.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
        if (input.placeholder === "Ex: quantos clientes estão em RED?") {
          input.placeholder = "Pergunte ao OpsQuestion…";
        }
      });
    };

    applyBrand();
    const observer = new MutationObserver(applyBrand);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
