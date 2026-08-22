"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-api`;
const FOCUSED = new Set(["Gustavo Lima", "Joel Antoniete"]);

export default function OnboardingRoleRouter() {
  useEffect(() => {
    if (window.location.pathname !== "/onboarding") return;
    let active = true;
    let timer = 0;
    let observer: MutationObserver | null = null;

    const clearButton = () => {
      document.getElementById("ob-focus-switch")?.remove();
      document.getElementById("ob-focus-switch-style")?.remove();
    };

    const addFocusButton = () => {
      if (!active || document.getElementById("ob-focus-switch")) return;
      const actions = document.querySelector(".ob-actions");
      if (!actions) return;
      const button = document.createElement("button");
      button.id = "ob-focus-switch";
      button.type = "button";
      button.textContent = "← Minha etapa";
      button.title = "Voltar para a sua responsabilidade principal no onboarding";
      button.onclick = () => window.location.assign("/onboarding-focus");
      actions.insertBefore(button, actions.firstChild);
      if (!document.getElementById("ob-focus-switch-style")) {
        const style = document.createElement("style");
        style.id = "ob-focus-switch-style";
        style.textContent = "#ob-focus-switch{border-color:rgba(109,215,163,.32)!important;color:#8ae4b3!important;background:rgba(19,67,51,.2)!important;font-weight:800!important}";
        document.head.appendChild(style);
      }
    };

    const route = async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || !active) return;
      try {
        const response = await fetch(API_URL, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        if (!response.ok || !active) return;
        const body = await response.json().catch(() => ({}));
        const person = String(body?.profile?.person || "");
        if (!FOCUSED.has(person)) return;
        const params = new URLSearchParams(window.location.search);
        if (params.get("view") !== "all") {
          window.location.replace("/onboarding-focus");
          return;
        }
        addFocusButton();
        observer = new MutationObserver(addFocusButton);
        observer.observe(document.body, { childList: true, subtree: true });
        timer = window.setInterval(addFocusButton, 1000);
      } catch {
        // Se a identificação falhar, preserva a tela normal do onboarding.
      }
    };

    route();
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
      observer?.disconnect();
      clearButton();
    };
  }, []);

  return null;
}
