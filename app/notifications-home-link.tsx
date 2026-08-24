"use client";

import { useEffect } from "react";

export default function NotificationsHomeLink() {
  useEffect(() => {
    const mount = () => {
      const panel = document.querySelector<HTMLElement>(".notification-panel");
      if (!panel || panel.querySelector("[data-notifications-home-link]")) return;

      const markRead = panel.querySelector<HTMLElement>(".mark-read");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.notificationsHomeLink = "true";
      button.className = "notifications-home-link";
      button.textContent = "Abrir Central de Notificações →";
      button.addEventListener("click", () => { window.location.href = "/notifications"; });

      if (markRead?.parentElement) markRead.parentElement.insertBefore(button, markRead.nextSibling);
      else panel.appendChild(button);
    };

    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
    return () => observer.disconnect();
  }, []);

  return <style>{`
    .notification-panel .notifications-home-link{
      width:calc(100% - 28px);margin:8px 14px 4px;padding:11px 13px;border-radius:10px;
      border:1px solid rgba(74,151,219,.28);background:rgba(48,130,205,.12);color:#dceeff;
      font:700 11px/1.2 Inter,system-ui,sans-serif;letter-spacing:.01em;cursor:pointer;text-align:center;
    }
    .notification-panel .notifications-home-link:hover{background:rgba(48,130,205,.2);border-color:rgba(74,151,219,.42);color:#fff}
  `}</style>;
}
