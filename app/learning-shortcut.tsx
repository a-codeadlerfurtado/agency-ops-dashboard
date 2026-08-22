"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

export default function LearningShortcut() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || typeof window === "undefined" || window.location.pathname !== "/campaigns") return;

    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const actions = document.querySelector<HTMLElement>(".tc-top-actions");
        if (!actions || actions.querySelector("[data-traffic-memory-button]")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.dataset.trafficMemoryButton = "true";
        button.className = "tc-memory-button";
        button.title = "Abrir histórico de decisões e biblioteca de experimentos de tráfego";
        button.innerHTML = '<span aria-hidden="true">◈</span><b>Memória de tráfego</b>';
        button.addEventListener("click", () => window.location.assign("/learning"));
        actions.insertBefore(button, actions.firstChild);
      });
    };

    const style = document.createElement("style");
    style.id = "traffic-memory-button-style";
    style.textContent = `
      .tc-memory-button{display:inline-flex!important;align-items:center!important;gap:7px!important;border:1px solid rgba(79,156,224,.30)!important;background:rgba(20,49,76,.42)!important;color:#dceeff!important}
      .tc-memory-button span{color:#72b4f0;font-size:14px}
      .tc-memory-button b{font:inherit;font-weight:760}
      .tc-memory-button:hover{border-color:rgba(92,173,242,.5)!important;background:rgba(25,65,99,.58)!important}
    `;
    if (!document.getElementById(style.id)) document.head.appendChild(style);

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.querySelectorAll("[data-traffic-memory-button]").forEach((node) => node.remove());
      document.getElementById("traffic-memory-button-style")?.remove();
    };
  }, [session]);

  return null;
}
