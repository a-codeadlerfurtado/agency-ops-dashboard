"use client";

import { usePathname } from "next/navigation";

export default function CampaignsSubnav() {
  const pathname = usePathname();
  const leads = pathname.startsWith("/campaigns/leads");
  const weekly = pathname.startsWith("/campaigns/weekly-report");
  const monthly = pathname.startsWith("/campaigns/monthly-report");
  const overview = !leads && !weekly && !monthly;
  return (
    <nav className="tc-area-subnav" aria-label="Central de Tráfego">
      <a className={overview ? "active" : ""} href="/campaigns">Visão geral</a>
      <a className={leads ? "active" : ""} href="/campaigns/leads">Conferência de Leads</a>
      <a className={weekly ? "active" : ""} href="/campaigns/weekly-report">Relatórios Semanais</a>
      <a className={monthly ? "active" : ""} href="/campaigns/monthly-report">Relatórios Mensais</a>
    </nav>
  );
}
