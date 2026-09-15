"use client";

import { useEffect, useState } from "react";
import { loadProfileLite, supabase } from "./shared";

const ITEMS = [
  ["Financeiro", "/finance"],
  ["Onboarding", "/leonardo-onboarding"],
  ["Central Criativa", "/leonardo-creative"],
  ["Central de Trabalho", "/leonardo-work"],
  ["Diário", "/leonardo-diary"],
  ["TaskLog", "/leonardo-diary?tab=tasklog"],
] as const;

function clearInjected() {
  document.querySelectorAll("[data-leonardo-expanded-nav]").forEach((node) => node.remove());
}
function injectNav() {
  const nav = document.querySelector<HTMLElement>(".lc-sidebar nav");
  if (!nav) return;
  const template = nav.querySelector<HTMLButtonElement>("button");
  for (const [label, href] of ITEMS) {
    if (nav.querySelector(`[data-leonardo-expanded-nav="${label}"]`)) continue;
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label; button.title = label; button.dataset.leonardoExpandedNav = label;
    if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
    button.addEventListener("click", () => window.location.assign(href));
    nav.appendChild(button);
  }
  const foot = document.querySelector<HTMLElement>(".lc-side-foot small");
  if (foot) foot.textContent = "Diretor Comercial · gestão ativa";
}

export default function LeonardoExpandedAccess() {
  const [isCommercial, setIsCommercial] = useState(false);
  useEffect(() => {
    let active = true;
    const detect = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { if (active) setIsCommercial(false); return; }
      try {
        const body = await loadProfileLite();
        if (active) setIsCommercial(String(body?.profile?.role || "").toUpperCase() === "COMMERCIAL" && String(body?.profile?.person || "") === "Leonardo Augusto");
      } catch { if (active) setIsCommercial(false); }
    };
    detect();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => detect());
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!isCommercial) { clearInjected(); document.documentElement.classList.remove("leonardo-external-module"); return; }
    const external = window.location.pathname !== "/";
    document.documentElement.classList.toggle("leonardo-external-module", external);
    if (external) {
      clearInjected();
      const forceScroll = () => { document.body.style.overflow = "auto"; document.documentElement.style.overflow = "auto"; };
      forceScroll();
      const timer = window.setInterval(forceScroll, 600);
      return () => { window.clearInterval(timer); document.documentElement.classList.remove("leonardo-external-module"); };
    }
    let frame = 0;
    const apply = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(injectNav); };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 900);
    return () => {
      observer.disconnect(); window.clearInterval(timer); cancelAnimationFrame(frame); clearInjected();
      document.documentElement.classList.remove("leonardo-external-module");
    };
  }, [isCommercial]);

  return <style>{`html.leonardo-external-module .lc-root{display:none!important}`}</style>;
}
