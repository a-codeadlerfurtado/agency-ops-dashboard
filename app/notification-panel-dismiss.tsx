"use client";

import { useEffect } from "react";

const NOTIFICATION_TRIGGER = 'button[aria-label="Notificações"]';

export default function NotificationPanelDismiss() {
  useEffect(() => {
    function closeOpenNotificationPanel() {
      const panel = document.querySelector<HTMLElement>(".notification-panel");
      const trigger = document.querySelector<HTMLButtonElement>(NOTIFICATION_TRIGGER);
      if (!panel || !trigger) return;
      trigger.click();
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const panel = document.querySelector<HTMLElement>(".notification-panel");
      if (!panel) return;

      if (target.closest(".notification-panel") || target.closest(NOTIFICATION_TRIGGER)) return;
      closeOpenNotificationPanel();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!document.querySelector(".notification-panel")) return;
      closeOpenNotificationPanel();
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
