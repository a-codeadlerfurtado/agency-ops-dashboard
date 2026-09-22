"use client";

import React from "react";

const STYLE_ID = "nav-brand-icons-v3-style";

const ICONS: Record<string, string> = {
  grid: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`,
  home: `<svg viewBox="0 0 24 24"><path d="M3.5 10.8 12 3.8l8.5 7v9.4a.8.8 0 0 1-.8.8h-5.2v-6.2h-5V21H4.3a.8.8 0 0 1-.8-.8z"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.6 1.6L13 7.4M8 15h8"/></svg>`,
  clients: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20M17 8h4M19 6v4"/></svg>`,
  heart: `<svg viewBox="0 0 24 24"><path d="M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 0 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1z"/><path d="M7 12h3l1-2 2 4 1-2h3"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M5 18.5 3.8 21l4.1-1.2c1.2.5 2.6.8 4.1.8 5 0 9-3.7 9-8.3S17 4 12 4s-9 3.7-9 8.3c0 2.4.8 4.5 2 6.2z"/><path d="M8 12h8M8 9h5"/></svg>`,
  route: `<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h3c5 0 1-12 6-12h1"/></svg>`,
  briefing: `<svg viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 9h7M8.5 13h7M8.5 17h4"/></svg>`,
  ads: `<svg viewBox="0 0 24 24"><path d="M4 13v-2l11-5v12zM15 9l4-2v10l-4-2M6 13l1.5 6h3L9 13"/></svg>`,
  compass: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>`,
  campaign: `<svg viewBox="0 0 24 24"><path d="M4 14V9l12-4v13zM16 8l4-1v9l-4-1M6 14l1.5 5h3L9 14"/></svg>`,
  analysis: `<svg viewBox="0 0 24 24"><path d="M4 19V9M9 19V5M14 19v-7"/><circle cx="17.5" cy="15.5" r="3.5"/><path d="m20 18 2 2"/></svg>`,
  trend: `<svg viewBox="0 0 24 24"><path d="M4 18 10 12l4 4 6-8M15 8h5v5"/></svg>`,
  coins: `<svg viewBox="0 0 24 24"><ellipse cx="9" cy="6" rx="5" ry="2.5"/><path d="M4 6v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V6M4 10v4c0 1.4 2.2 2.5 5 2.5 1 0 2-.2 2.8-.5"/><path d="M14 14h6v6h-6zM17 14v6"/></svg>`,
  team: `<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="2.7"/><circle cx="16.5" cy="9" r="2.3"/><path d="M2.8 20v-1.3A4.2 4.2 0 0 1 7 14.5h2a4.2 4.2 0 0 1 4.2 4.2V20M13.5 15.5c.7-.7 1.7-1 2.8-1h.8a3.9 3.9 0 0 1 3.9 3.9V20"/></svg>`,
  chart: `<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-11M2 20h21"/></svg>`,
  gauge: `<svg viewBox="0 0 24 24"><path d="M4 18a8 8 0 1 1 16 0M7 18h10M12 14l4-4"/><circle cx="12" cy="18" r="1"/></svg>`,
  diagnostic: `<svg viewBox="0 0 24 24"><path d="M6 3v6a6 6 0 0 0 12 0V3M4 3h4M16 3h4M12 15v2a4 4 0 0 0 4 4h1"/><circle cx="19" cy="18" r="2"/></svg>`,
  audit: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M8 10.5l1.5 1.5 3-3"/></svg>`,
  evidence: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3m-9 7 2 2 4-4"/></svg>`,
  contract: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h5M15 17l3-3"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24"><path d="M4 6.5h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h11"/><path d="M16 11h6v4h-6a2 2 0 0 1 0-4z"/></svg>`,
  wrapped: `<svg viewBox="0 0 24 24"><rect x="3.5" y="8" width="17" height="12" rx="2"/><path d="M12 8v12M3.5 12h17M7.5 8C5 8 5 4.5 7.2 4.5 9.2 4.5 12 8 12 8M16.5 8C19 8 19 4.5 16.8 4.5 14.8 4.5 12 8 12 8"/></svg>`,
  userplus: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.4c0-2.6 2.1-4.6 4.6-4.6h1.8c2.6 0 4.6 2.1 4.6 4.6V20M18 8v6M15 11h6"/></svg>`,
  funnel: `<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>`,
  handshake: `<svg viewBox="0 0 24 24"><path d="m8 12 3-3a2 2 0 0 1 3 0l2 2 4-4M4 8l4 4-3 3-3-3zM20 8l-4 4 3 3 3-3z"/><path d="m9 14 2 2m0-4 3 3m0-4 3 3"/></svg>`,
  palette: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.2a2.2 2.2 0 0 0 0-4.4h-.9a1.8 1.8 0 0 1 0-3.6H15a6 6 0 0 0 6-6c0-2.2-4-4-9-4z"/><circle cx="7.5" cy="9" r="1"/><circle cx="10" cy="6.5" r="1"/><circle cx="15" cy="7" r="1"/></svg>`,
  pen: `<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4M4 20l3-1"/></svg>`,
  video: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3zM8 9l4 3-4 3z"/></svg>`,
  radar: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 12 19 5"/></svg>`,
  note: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h7"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4"/></svg>`,
  clickup: `<svg viewBox="0 0 24 24"><path d="m5 13 7 5 7-5M7 9l5-4 5 4M8 12l4 3 4-3"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
  mic: `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>`,
  workflow: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M9 6.5h4a3 3 0 0 1 3 3v5.5M15 17.5h-4a3 3 0 0 1-3-3V9"/></svg>`,
  plug: `<svg viewBox="0 0 24 24"><path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6"/></svg>`,
  shield: `<svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5.2-3.4 8.3-8 10-4.6-1.7-8-4.8-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 8.2A7 7 0 0 1 18.8 10M17.8 15.8A7 7 0 0 1 5.2 14"/></svg>`,
};

function norm(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function svgFor(kind: string) {
  const source = ICONS[kind] || ICONS.grid;
  return source.replace(
    "<svg ",
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" `,
  );
}

function kindFor(item: HTMLElement) {
  if (item.hasAttribute("data-briefing-staff-nav")) return "briefing";
  if (item.hasAttribute("data-ads-intelligence-nav")) return "ads";
  if (item.hasAttribute("data-meta-consultant-nav")) return "compass";
  if (item.hasAttribute("data-meta-analysis-nav")) return "analysis";
  if (item.hasAttribute("data-meta-performance-nav")) return "trend";
  if (item.hasAttribute("data-client-balances-nav")) return "coins";
  if (item.hasAttribute("data-diagnostics-nav")) return "diagnostic";
  if (item.hasAttribute("data-adler-finance-nav")) return "wallet";
  if (item.hasAttribute("data-commercial-funnel-nav")) return "funnel";
  if (item.hasAttribute("data-video-scripts-nav")) return "pen";
  if (item.hasAttribute("data-meta-radar-nav")) return "radar";
  if (item.hasAttribute("data-meetings-nav")) return "mic";
  if (item.hasAttribute("data-automation-health-nav")) return "workflow";
  if (item.hasAttribute("data-donnah-nav")) return "plug";
  if (item.hasAttribute("data-security-center-nav")) return "shield";
  if (item.hasAttribute("data-system-updates-nav")) return "refresh";
  const href = item instanceof HTMLAnchorElement ? norm(item.getAttribute("href")) : "";
  if (href === "/meta-analysis") return "analysis";
  if (href === "/meta-performance") return "trend";
  if (href === "/diagnostics") return "diagnostic";
  if (href === "/finance") return "wallet";
  if (href === "/wrapped") return "wrapped";
  if (href === "/sales-funnel") return "funnel";
  if (href === "/creative-intelligence" || href === "/meta-radar") return "radar";
  if (href === "/automations") return "workflow";
  if (href.includes("/integrations/donnah")) return "plug";
  if (href === "/ia") return "sparkle";

  const label = norm(item.getAttribute("title") || item.textContent);
  if (label === "visao geral" || label === "home comercial") return "home";
  if (label === "foco do dia" || label === "meu dia") return "target";
  if (label.startsWith("central de trabalho")) return "tasks";
  if (label === "clientes" || label === "carteira") return "clients";
  if (label === "saude" || label.startsWith("saude da carteira")) return "heart";
  if (label === "conversas") return "chat";
  if (label === "onboarding" || label.startsWith("jornada do cliente")) return "route";
  if (label === "briefing hub") return "briefing";
  if (label === "ads intelligence") return "ads";
  if (label === "consultor de performance") return "compass";
  if (label === "campanhas") return "campaign";
  if (label.includes("analise meta") || label.includes("analises dos gts")) return "analysis";
  if (label === "performance meta") return "trend";
  if (label.startsWith("saldo clientes")) return "coins";
  if (label === "equipe") return "team";
  if (label.startsWith("desempenho op") || label.startsWith("desempenho da operacao")) return "chart";
  if (label === "capacidade" || label.startsWith("capacidade operacional")) return "gauge";
  if (label.startsWith("central de diagnostico")) return "diagnostic";
  if (label === "auditoria") return "audit";
  if (label === "evidencias") return "evidence";
  if (label === "contratos") return "contract";
  if (label === "financeiro" || label.startsWith("mensalidades")) return "wallet";
  if (label.startsWith("wrapped")) return "wrapped";
  if (label.startsWith("pre-clientes") || label.startsWith("pre clientes")) return "userplus";
  if (label.startsWith("funil comercial")) return "funnel";
  if (label.startsWith("acompanhamento comercial")) return "handshake";
  if (label.startsWith("central criativa")) return "palette";
  if (label.startsWith("producao de roteiros")) return "pen";
  if (label.startsWith("videos automaticos")) return "video";
  if (label.startsWith("inteligencia criativa")) return "radar";
  if (label === "diario") return "note";
  if (label === "alertas" || label.startsWith("alertas operacionais")) return "bell";
  if (label === "clickup") return "clickup";
  if (label === "ia" || label.startsWith("ia da agencia") || label.startsWith("ia em desenvolvimento")) return "sparkle";
  if (label === "relato ai" || label === "reunioes") return "mic";
  if (label === "automacoes" || label.startsWith("central de saude das automacoes")) return "workflow";
  if (label.startsWith("donnah")) return "plug";
  if (label.startsWith("seguranca")) return "shield";
  if (label.startsWith("atualizacoes")) return "refresh";
  return "grid";
}

const CSS = `
.side-nav-items > button:not(.sidebar-ia-group-title),
.side-nav-items > a{
  display:flex!important;
  align-items:center!important;
  justify-content:flex-start!important;
  gap:11px!important;
  text-indent:0!important;
}
.side-nav-items .ops-nav-icon-v3{
  display:inline-flex!important;
  align-items:center!important;
  justify-content:center!important;
  width:18px!important;
  min-width:18px!important;
  height:18px!important;
  flex:0 0 18px!important;
  margin:0!important;
  padding:0!important;
  opacity:1!important;
  visibility:visible!important;
  color:color-mix(in srgb,var(--text) 72%,var(--muted))!important;
  pointer-events:none!important;
}
.side-nav-items .ops-nav-icon-v3 svg{display:block!important;width:18px!important;height:18px!important;overflow:visible!important}
.side-nav-items > button:not(.sidebar-ia-group-title):hover .ops-nav-icon-v3,
.side-nav-items > a:hover .ops-nav-icon-v3,
.side-nav-items > button:not(.sidebar-ia-group-title).active .ops-nav-icon-v3,
.side-nav-items > a.active .ops-nav-icon-v3{opacity:1!important;visibility:visible!important;color:var(--text)!important}
.side-nav-items > button:not(.sidebar-ia-group-title) > .nav-brand-icon,
.side-nav-items > a > .nav-brand-icon{display:none!important}
.side-nav-items > button:not(.sidebar-ia-group-title) > span[aria-hidden="true"]:not(.ops-nav-icon-v3),
.side-nav-items > a > span[aria-hidden="true"]:not(.ops-nav-icon-v3),
.side-nav-items > button:not(.sidebar-ia-group-title) > svg,
.side-nav-items > a > svg,
.side-nav-items > button:not(.sidebar-ia-group-title) > img,
.side-nav-items > a > img{display:none!important}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
.side-nav:not(.open) .side-nav-items > a{justify-content:center!important;gap:0!important;padding-left:0!important;padding-right:0!important}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title) > :not(.ops-nav-icon-v3),
.side-nav:not(.open) .side-nav-items > a > :not(.ops-nav-icon-v3){display:none!important}
`;

export default function NavBrandIconsV3() {
  React.useEffect(() => {
    let frame = 0;
    const apply = () => {
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!container) return;
      const items = Array.from(container.children).filter((node): node is HTMLElement =>
        node instanceof HTMLElement &&
        (node.tagName === "BUTTON" || node.tagName === "A") &&
        !node.classList.contains("sidebar-ia-group-title")
      );
      for (const item of items) {
        const kind = kindFor(item);
        let icon = item.querySelector<HTMLElement>(":scope > .ops-nav-icon-v3");
        if (!icon) {
          icon = document.createElement("span");
          icon.className = "ops-nav-icon-v3";
          icon.setAttribute("aria-hidden", "true");
          item.insertBefore(icon, item.firstChild);
        }
        if (icon.dataset.kind !== kind) {
          icon.dataset.kind = kind;
          icon.innerHTML = svgFor(kind);
        }
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "href", "class"] });
    const timer = window.setInterval(schedule, 1200);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
      document.querySelectorAll(".ops-nav-icon-v3").forEach((node) => node.remove());
    };
  }, []);

  return <style id="nav-brand-icons-v3-style" dangerouslySetInnerHTML={{ __html: CSS }} />;
}

