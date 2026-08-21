"use client";

import { useEffect } from "react";

export default function OnboardingNavBridge() {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (window.location.pathname === "/onboarding") return;
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (!target) return;
      const label = (target.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (label !== "onboarding") return;
      const nav = target.closest("nav, .view-nav, .side-nav, .sidenav, .sidebar");
      if (!nav) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign("/onboarding");
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
  return null;
}
