"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { API_URL, authenticatedFetch, supabase } from "./shared";

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

function installAgendaTab() {
  if (window.location.pathname !== "/") return;
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;
  if (container.querySelector("[data-agenda-nav]")) return;

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const focus = buttons.find((button) => normalize(button.title || button.textContent || "") === "foco do dia");
  const work = buttons.find((button) => normalize(button.title || button.textContent || "") === "central de trabalho");
  const template = focus || work || buttons[0];

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.agendaNav = "true";
  button.title = "Agenda";
  button.textContent = "Agenda";
  if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
  button.addEventListener("click", () => window.location.assign("/agenda"));

  if (focus?.nextSibling) container.insertBefore(button, focus.nextSibling);
  else if (work) container.insertBefore(button, work);
  else container.appendChild(button);
}

export default function AgendaNavigationBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); return; }
    let active = true;
    authenticatedFetch(`${API_URL}?view=home`, { cache: "no-store" })
      .then(async (response) => {
        if (!active || !response.ok) { if (active) setAllowed(false); return; }
        const body = await response.json().catch(() => ({}));
        const views = Array.isArray(body?.profile?.views) ? body.profile.views : [];
        if (active) setAllowed(views.includes("agenda"));
      })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!allowed || window.location.pathname !== "/") {
      document.querySelectorAll("[data-agenda-nav]").forEach((node) => node.remove());
      return;
    }

    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(installAgendaTab);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 1200);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.querySelectorAll("[data-agenda-nav]").forEach((node) => node.remove());
    };
  }, [allowed]);

  return null;
}
