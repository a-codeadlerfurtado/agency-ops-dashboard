"use client";

import { useEffect } from "react";

export default function ProfileMenuDismiss() {
  useEffect(() => {
    function normalizeProfileMenu() {
      const menu = document.querySelector<HTMLElement>(".profile-menu");
      if (!menu) return;

      menu.querySelectorAll<HTMLButtonElement>(":scope > button").forEach((button) => {
        const label = (button.textContent || "").trim();

        // Esses três atalhos abriam exatamente o mesmo modal. Mantemos um único
        // ponto de entrada e deixamos claro que ele concentra perfil + preferências.
        if (label === "Meu perfil") {
          button.textContent = "Perfil e preferências";
          button.title = "Dados pessoais, aparência, sons e preferências";
          return;
        }

        if (label === "Configurações" || label === "Preferências") {
          button.style.display = "none";
          button.setAttribute("aria-hidden", "true");
          button.tabIndex = -1;
        }
      });
    }

    function closeOpenProfileMenu() {
      const menu = document.querySelector<HTMLElement>(".profile-menu");
      const trigger = document.querySelector<HTMLButtonElement>(".profile-trigger");
      if (!menu || !trigger) return;
      trigger.click();
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const menu = document.querySelector<HTMLElement>(".profile-menu");
      if (!menu) return;

      if (target.closest(".profile-menu") || target.closest(".profile-trigger")) return;
      closeOpenProfileMenu();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!document.querySelector(".profile-menu")) return;
      closeOpenProfileMenu();
    }

    normalizeProfileMenu();
    const observer = new MutationObserver(normalizeProfileMenu);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
