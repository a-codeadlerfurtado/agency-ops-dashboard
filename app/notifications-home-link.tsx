"use client";

import { useEffect } from "react";

export default function NotificationsHomeLink() {
  useEffect(() => {
    const ensureLink = () => {
      const panel = document.querySelector<HTMLElement>(".notification-panel");
      if (!panel) return;

      const existing = panel.querySelector<HTMLAnchorElement>("[data-notifications-home-link]");
      if (existing) return;

      const link = document.createElement("a");
      link.href = "/notifications";
      link.dataset.notificationsHomeLink = "true";
      link.className = "notifications-home-link";
      link.setAttribute("aria-label", "Abrir Central de Notificações completa");
      link.innerHTML = "<span>Abrir Central de Notificações</span><b>→</b>";

      const heading = panel.querySelector<HTMLElement>(".panel-heading");
      if (heading?.parentElement === panel) {
        heading.insertAdjacentElement("afterend", link);
      } else {
        panel.prepend(link);
      }
    };

    const observer = new MutationObserver(ensureLink);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(ensureLink, 400);
    ensureLink();

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return <style>{`
    .notification-panel .notifications-home-link{
      display:flex!important;align-items:center;justify-content:space-between;gap:12px;
      margin:10px 14px 8px;padding:12px 14px;min-height:42px;border-radius:11px;
      border:1px solid rgba(74,151,219,.38);background:rgba(48,130,205,.17);color:#eef8ff!important;
      font:700 11px/1.2 Inter,system-ui,sans-serif;letter-spacing:.01em;text-decoration:none!important;
      cursor:pointer;position:relative;z-index:5;box-shadow:0 8px 24px rgba(0,0,0,.14)
    }
    .notification-panel .notifications-home-link b{font-size:16px;color:#83c8ff}
    .notification-panel .notifications-home-link:hover{background:rgba(48,130,205,.27);border-color:rgba(92,175,244,.58);color:#fff!important}
  `}</style>;
}
