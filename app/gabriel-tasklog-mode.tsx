"use client";

import { useEffect } from "react";
import { supabase } from "./shared";

const GABRIEL_EMAIL = "gabrielcastrodesouza1@gmail.com";

export default function GabrielTasklogMode() {
  useEffect(() => {
    let active = true;
    let isGabriel = false;

    const syncSession = async () => {
      const { data } = await supabase.auth.getSession();
      isGabriel = data.session?.user?.email?.toLowerCase() === GABRIEL_EMAIL;
      apply();
    };

    const apply = () => {
      if (!active || !isGabriel) return;

      const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".side-nav button"));
      const diaryNav = navButtons.find((button) => button.title === "Diário" || button.textContent?.trim() === "Diário");
      if (diaryNav) {
        diaryNav.title = "TaskLog";
        if (diaryNav.textContent?.trim() === "Diário") diaryNav.textContent = "TaskLog";
      }

      const workspaces = Array.from(document.querySelectorAll<HTMLElement>("section.workspace"));
      const diary = workspaces.find((section) => section.querySelector(":scope > .workspace-head h2")?.textContent?.trim() === "Diário");
      if (!diary) return;

      const title = diary.querySelector<HTMLElement>(":scope > .workspace-head h2");
      const description = diary.querySelector<HTMLElement>(":scope > .workspace-head p");
      if (title) title.textContent = "TaskLog";
      if (description) description.textContent = "Registro pessoal das atividades executadas por você.";

      const firstTabs = diary.querySelector<HTMLElement>(":scope > .filter-tabs");
      if (firstTabs) {
        const buttons = Array.from(firstTabs.querySelectorAll<HTMLButtonElement>("button"));
        const tasklog = buttons.find((button) => button.textContent?.trim() === "TaskLog");
        for (const button of buttons) {
          if (button !== tasklog) button.style.display = "none";
        }
        if (tasklog && !tasklog.classList.contains("active")) tasklog.click();
      }

      const scopeTabs = Array.from(diary.querySelectorAll<HTMLElement>(":scope > .filter-tabs"))[1];
      if (scopeTabs) scopeTabs.style.display = "none";
    };

    syncSession();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      isGabriel = session?.user?.email?.toLowerCase() === GABRIEL_EMAIL;
      apply();
    });

    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 500);

    return () => {
      active = false;
      subscription.unsubscribe();
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
