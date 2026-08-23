"use client";

import { useEffect } from "react";

export default function ProfileMenuDismiss() {
  useEffect(() => {
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

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
