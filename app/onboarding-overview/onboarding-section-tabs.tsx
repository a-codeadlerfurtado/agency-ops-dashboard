"use client";

import { usePathname } from "next/navigation";

export default function OnboardingSectionTabs() {
  const pathname = usePathname();
  const history = pathname.startsWith("/onboarding-overview/history");
  return <nav className="onboarding-section-tabs" aria-label="Seções do onboarding">
    <style>{`
      .onboarding-section-tabs{position:sticky;top:0;z-index:80;display:flex;gap:8px;align-items:center;padding:10px max(18px,calc((100vw - 1540px)/2));background:rgba(8,13,24,.94);backdrop-filter:blur(16px);border-bottom:1px solid rgba(148,163,184,.16)}
      .onboarding-section-tabs a{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 15px;border-radius:10px;color:#94a3b8;text-decoration:none;font:700 13px/1.1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:1px solid transparent;transition:.16s ease}
      .onboarding-section-tabs a:hover{color:#e2e8f0;background:rgba(255,255,255,.04)}
      .onboarding-section-tabs a.active{color:#f8fafc;background:rgba(37,99,235,.16);border-color:rgba(96,165,250,.35)}
      .onboarding-section-tabs .dot{width:7px;height:7px;border-radius:999px;background:currentColor;opacity:.7}
      @media(max-width:720px){.onboarding-section-tabs{padding:9px 12px;overflow:auto}.onboarding-section-tabs a{white-space:nowrap}}
    `}</style>
    <a className={!history ? "active" : ""} href="/onboarding-overview"><span className="dot"/>Em andamento</a>
    <a className={history ? "active" : ""} href="/onboarding-overview/history"><span className="dot"/>Histórico de Onboardings</a>
  </nav>;
}
