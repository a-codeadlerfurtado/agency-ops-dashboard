"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

export default function NotificationsHomeLink() {
  useEffect(() => {
    let remoteItems: Row[] = [];
    let loading = false;
    let lastLoadedAt = 0;

    const getToken = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token || "";
    };

    const loadRemote = async (force = false) => {
      if (loading || (!force && Date.now() - lastLoadedAt < 5000)) return;
      const panel = document.querySelector<HTMLElement>(".notification-panel");
      if (!panel) return;
      const token = await getToken();
      if (!token) return;
      loading = true;
      try {
        const response = await fetch(API_URL, {
          headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body?.ok) {
          remoteItems = (body.items || []).filter((item: Row) => item.kind === "NOTIFICATION");
          lastLoadedAt = Date.now();
        }
      } finally {
        loading = false;
      }
    };

    const matchItem = (button: HTMLElement) => {
      const title = norm(button.querySelector("b")?.textContent || "");
      if (!title) return null;
      const smalls = [...button.querySelectorAll("small")].map((node) => norm(node.textContent || "")).filter(Boolean);
      const description = smalls.join(" ");
      const candidates = remoteItems.filter((item) => norm(item.title) === title);
      if (!candidates.length) return null;
      const exact = candidates.find((item) => {
        const itemDescription = norm(item.description || "");
        return itemDescription && description && (description.includes(itemDescription.slice(0, 70)) || itemDescription.includes(description.slice(0, 70)));
      });
      const active = candidates.find((item) => String(item.status || "").toUpperCase() !== "RESOLVED");
      return exact || active || candidates[0];
    };

    const decrementBellBadge = () => {
      const bell = document.querySelector<HTMLButtonElement>('button[aria-label="Notificações"]');
      const badge = bell?.querySelector<HTMLElement>("b");
      if (!badge) return;
      const current = Number(String(badge.textContent || "").replace(/\D/g, ""));
      if (!Number.isFinite(current)) return;
      if (current <= 1) badge.remove();
      else badge.textContent = String(current - 1);
    };

    const resolveNotification = async (item: Row, button: HTMLElement, control: HTMLElement) => {
      if (control.dataset.busy === "1") return;
      control.dataset.busy = "1";
      control.textContent = "Salvando…";
      const token = await getToken();
      if (!token) { control.textContent = "Resolvida"; control.dataset.busy = "0"; return; }
      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_ANON_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "RESOLVE", notification_id: item.id }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        item.status = "RESOLVED";
        item.resolved_at = body.resolved_at;
        item.resolved_by = body.resolved_by;
        decrementBellBadge();
        button.style.transition = "opacity .18s ease, transform .18s ease, max-height .2s ease";
        button.style.opacity = "0";
        button.style.transform = "translateX(10px)";
        window.setTimeout(() => button.remove(), 190);
      } catch {
        control.textContent = "Tentar novamente";
        control.dataset.busy = "0";
      }
    };

    const ensureUI = async () => {
      const panel = document.querySelector<HTMLElement>(".notification-panel");
      if (!panel) return;

      let link = panel.querySelector<HTMLAnchorElement>("[data-notifications-home-link]");
      if (!link) {
        link = document.createElement("a");
        link.href = "/notifications";
        link.dataset.notificationsHomeLink = "true";
        link.className = "notifications-home-link";
        link.setAttribute("aria-label", "Abrir Central de Notificações completa");
        link.innerHTML = "<span>Abrir Central de Notificações</span><b>→</b>";
        const heading = panel.querySelector<HTMLElement>(".panel-heading");
        if (heading?.parentElement === panel) heading.insertAdjacentElement("afterend", link);
        else panel.prepend(link);
      }

      await loadRemote();

      panel.querySelectorAll<HTMLElement>(".notification-list > button").forEach((button) => {
        const item = matchItem(button);
        if (!item) return;
        const status = String(item.status || "").toUpperCase();
        if (status === "RESOLVED") {
          button.style.display = "none";
          return;
        }
        if (item.metadata?.access_request_id) return;
        if (button.querySelector("[data-notification-resolve]")) return;

        const control = document.createElement("span");
        control.dataset.notificationResolve = "true";
        control.className = "notification-resolve-action";
        control.setAttribute("role", "button");
        control.setAttribute("tabindex", "0");
        control.setAttribute("aria-label", `Marcar ${item.title || "notificação"} como resolvida`);
        control.textContent = "✓ Resolvida";
        const act = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          (event as any).stopImmediatePropagation?.();
          void resolveNotification(item, button, control);
        };
        control.addEventListener("click", act);
        control.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key === "Enter" || (event as KeyboardEvent).key === " ") act(event);
        });
        button.appendChild(control);
      });
    };

    const observer = new MutationObserver(() => { void ensureUI(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(() => { void ensureUI(); }, 700);
    void ensureUI();

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
    .notification-panel .notification-list>button{position:relative}
    .notification-panel .notification-resolve-action{
      display:inline-flex;align-items:center;justify-content:center;margin-top:8px;margin-left:auto;padding:6px 9px;
      width:max-content;border:1px solid rgba(65,190,136,.28);border-radius:8px;background:rgba(45,166,113,.11);
      color:#9ae4bf;font:700 9px/1 Inter,system-ui,sans-serif;letter-spacing:.02em;cursor:pointer;position:relative;z-index:8
    }
    .notification-panel .notification-resolve-action:hover{background:rgba(45,166,113,.2);border-color:rgba(78,211,151,.45);color:#c5f7dc}
  `}</style>;
}
