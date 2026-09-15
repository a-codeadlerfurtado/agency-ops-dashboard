"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

const ADLER_USER_ID = "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";

export default function AutomationNavBridge() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || session.user.id !== ADLER_USER_ID || typeof window === "undefined" || window.location.pathname !== "/") return;

    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const menu = document.querySelector<HTMLElement>(".side-nav-items");
        if (!menu || menu.querySelector("[data-automation-health-nav]")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.dataset.automationHealthNav = "true";
        button.title = "Central de Saúde das Automações";
        button.textContent = "Automações";
        button.addEventListener("click", () => window.location.assign("/automations"));

        const iaLink = Array.from(menu.children).find((node) => node instanceof HTMLAnchorElement && (node as HTMLAnchorElement).getAttribute("href") === "/ia");
        if (iaLink) menu.insertBefore(button, iaLink);
        else menu.appendChild(button);
      });
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.querySelectorAll("[data-automation-health-nav]").forEach((node) => node.remove());
    };
  }, [session]);

  return null;
}
