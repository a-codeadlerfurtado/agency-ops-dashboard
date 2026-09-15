"use client";

import { useEffect } from "react";
import { API_URL, SUPABASE_ANON_KEY, supabase } from "./shared";

export default function NotificationReadOnClick() {
  useEffect(() => {
    async function persistRead(id: string) {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;

      await fetch(`${API_URL}?view=notifications-read&client=hotfix-20260824`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id }),
        cache: "no-store",
      }).catch(() => undefined);
    }

    function markVisuallyRead(item: HTMLElement) {
      if (!item.classList.contains("unread")) return;
      item.classList.remove("unread");

      const badge = document.querySelector<HTMLElement>('button[aria-label="Notificações"] b');
      if (!badge) return;
      const current = Number((badge.textContent || "0").trim());
      if (!Number.isFinite(current) || current <= 1) badge.remove();
      else badge.textContent = String(current - 1);
    }

    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const item = target.closest<HTMLElement>(
        '.notification-panel .notification-list > button[data-notification-id]'
      );
      if (!item) return;

      const id = String(item.dataset.notificationId || "").trim();
      if (!id) return;

      markVisuallyRead(item);
      void persistRead(id);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
