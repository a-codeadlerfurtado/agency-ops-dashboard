"use client";

import { usePathname } from "next/navigation";

export default function CampaignsSubnav() {
  const pathname = usePathname();
  const leads = pathname.startsWith("/campaigns/leads");
  return (
    <nav className="tc-area-subnav" aria-label="Central de Tráfego">
      <a className={!leads ? "active" : ""} href="/campaigns">Visão geral</a>
      <a className={leads ? "active" : ""} href="/campaigns/leads">Conferência de Leads</a>
    </nav>
  );
}
