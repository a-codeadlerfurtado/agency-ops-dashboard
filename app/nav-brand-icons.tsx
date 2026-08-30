"use client";

import { useEffect } from "react";

const STYLE_ID = "nav-brand-icons-style";

const ICONS: Record<string, string> = {
  meta: `<svg viewBox="0 0 32 20" aria-hidden="true"><path d="M2.6 15.7C4.8 9.1 7.1 4.3 10.2 4.3c4.4 0 6.4 8.7 8.7 11.3 1.2 1.4 2.4 2 3.8 2 3.3 0 5.6-2.9 5.6-6.3 0-4.2-3.3-8.5-7.5-8.5-4.9 0-7.8 7.6-10.2 12.2-1 2-1.9 3-3.5 3-1.9 0-3.2-1.3-3.2-3.4 0-2.2 1.5-5.6 3.6-8.4C9.5 3.6 12 2 14.8 2c4 0 6.7 3.4 9.1 7.5"/></svg>`,
  home: `<svg viewBox="0 0 24 24"><path d="M3.5 10.8 12 3.8l8.5 7v9.4a.8.8 0 0 1-.8.8h-5.2v-6.2h-5V21H4.3a.8.8 0 0 1-.8-.8z"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.6 1.6L13 7.4M8 15h8"/></svg>`,
  users: `<svg viewBox="0 0 24 24"><path d="M16 20v-1.6c0-2.2-1.8-4-4-4H7c-2.2 0-4 1.8-4 4V20"/><circle cx="9.5" cy="7.3" r="3.3"/><path d="M16.5 4.4a3 3 0 0 1 0 5.8M18.5 14.6c1.6.6 2.5 1.8 2.5 3.5V20"/></svg>`,
  heart: `<svg viewBox="0 0 24 24"><path d="M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 0 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1z"/></svg>`,
  route: `<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h3c5 0 1-12 6-12h1"/></svg>`,
  userplus: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.4c0-2.6 2.1-4.6 4.6-4.6h1.8c2.6 0 4.6 2.1 4.6 4.6V20M18 8v6M15 11h6"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M5 18.5 3.8 21l4.1-1.2c1.2.5 2.6.8 4.1.8 5 0 9-3.7 9-8.3S17 4 12 4s-9 3.7-9 8.3c0 2.4.8 4.5 2 6.2z"/></svg>`,
  note: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h7"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m7.5 12.5 3 3 6-7"/></svg>`,
  filecheck: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3m-9 7 2 2 4-4"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4"/></svg>`,
  chart: `<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-11M2 20h21"/></svg>`,
  palette: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.2a2.2 2.2 0 0 0 0-4.4h-.9a1.8 1.8 0 0 1 0-3.6H15a6 6 0 0 0 6-6c0-2.2-4-4-9-4z"/><circle cx="7.5" cy="9" r="1"/><circle cx="10" cy="6.5" r="1"/><circle cx="15" cy="7" r="1"/></svg>`,
  funnel: `<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24"><path d="M4 6.5h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h11"/><path d="M16 11h6v4h-6a2 2 0 0 1 0-4z"/></svg>`,
  gear: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5v-3l-2.1-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2.1h-3l-.7 2.1-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2.1.7v3l2.1.7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.1h3l.7-2.1 1.7-.7 1.9.9 2.1-2.1-.9-1.9z" transform="translate(1.3 .2) scale(.9)"/></svg>`,
  plug: `<svg viewBox="0 0 24 24"><path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5.2-3.4 8.3-8 10-4.6-1.7-8-4.8-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 8.2A7 7 0 0 1 18.8 10M17.8 15.8A7 7 0 0 1 5.2 14"/></svg>`,
  file: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3"/></svg>`,
  lock: `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
};

function norm(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isMetaRelated(node: HTMLElement, label: string, href: string) {
  if (
    node.hasAttribute("data-meta-consultant-nav") ||
    node.hasAttribute("data-meta-analysis-nav") ||
    node.hasAttribute("data-meta-performance-nav") ||
    node.hasAttribute("data-client-balances-nav")
  ) return true;

  if (href === "/campaigns" || href.startsWith("/meta-") || href.includes("meta-analysis") || href.includes("meta-performance")) return true;

  return [
    "consultor de performance",
    "campanhas",
    "analise meta semanal",
    "analises dos gts",
    "analise semanal",
    "relatorio meta",
    "relatorios meta",
    "performance meta",
    "saldo clientes",
    "inteligencia criativa",
  ].some((term) => label === term || label.startsWith(term));
}

function iconKind(node: HTMLElement) {
  const label = norm(node.getAttribute("title") || node.textContent);
  const href = node instanceof HTMLAnchorElement ? norm(node.getAttribute("href")) : "";

  if (isMetaRelated(node, label, href)) return "meta";
  if (label === "visao geral") return "home";
  if (label === "foco do dia" || label === "meu dia") return "target";
  if (label.startsWith("central de trabalho")) return "tasks";
  if (label === "clientes" || label === "carteira") return "users";
  if (label === "saude" || label.startsWith("saude da carteira")) return "heart";
  if (label === "onboarding" || label.startsWith("jornada do cliente")) return "route";
  if (label.startsWith("pre-clientes")) return "userplus";
  if (label === "conversas") return "chat";
  if (label === "diario") return "note";
  if (label === "equipe") return "users";
  if (label === "clickup") return "check";
  if (label === "evidencias") return "filecheck";
  if (label === "auditoria") return "search";
  if (label === "alertas" || label.startsWith("alertas operacionais")) return "bell";
  if (label.startsWith("desempenho op") || label.startsWith("desempenho da operacao")) return "chart";
  if (label.startsWith("central criativa")) return "palette";
  if (label.startsWith("funil comercial")) return "funnel";
  if (label === "financeiro" || label.startsWith("mensalidades")) return "wallet";
  if (label.startsWith("automacoes")) return "gear";
  if (label === "donnah" || href.includes("/integrations/donnah")) return "plug";
  if (label === "ia" || label.startsWith("ia (beta") || href === "/ia") return "sparkle";
  if (label.startsWith("atualizacoes")) return "refresh";
  if (label.startsWith("seguranca")) return "shield";
  if (label === "contratos") return "file";

  const group = String(node.dataset.navIaGroup || "");
  if (group === "inicio") return "home";
  if (group === "clientes") return "users";
  if (group === "performance") return "meta";
  if (group === "criativo") return "palette";
  if (group === "comercial") return "funnel";
  if (group === "gestao") return "gear";
  if (group === "sistemas") return "plug";
  return "file";
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .side-nav-items > button:not(.sidebar-ia-group-title),
    .side-nav-items > a,
    .side-nav-items button[data-nav-brand-icon]:not(.sidebar-ia-group-title),
    .side-nav-items a[data-nav-brand-icon] {
      display:flex!important;
      align-items:center!important;
      gap:9px!important;
    }
    .nav-brand-icon {
      width:17px!important;
      min-width:17px!important;
      height:17px!important;
      flex:0 0 17px!important;
      display:inline-flex!important;
      align-items:center!important;
      justify-content:center!important;
      color:color-mix(in srgb,var(--muted) 82%,var(--text))!important;
      opacity:1!important;
      pointer-events:none!important;
      position:relative!important;
      z-index:2!important;
    }
    .nav-brand-icon svg {
      width:16px!important;
      height:16px!important;
      display:block!important;
      fill:none!important;
      stroke:currentColor!important;
      stroke-width:1.75!important;
      stroke-linecap:round!important;
      stroke-linejoin:round!important;
      overflow:visible!important;
    }
    .nav-brand-icon[data-kind="meta"] {
      width:18px!important;
      min-width:18px!important;
      height:16px!important;
      flex-basis:18px!important;
    }
    .nav-brand-icon[data-kind="meta"] svg {
      width:18px!important;
      height:14px!important;
      stroke-width:1.65!important;
      vector-effect:non-scaling-stroke;
    }
    .side-nav-items > button:hover .nav-brand-icon,
    .side-nav-items > a:hover .nav-brand-icon,
    .side-nav-items > .active .nav-brand-icon {
      color:var(--text)!important;
    }
    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
    .side-nav:not(.open) .side-nav-items > a {
      justify-content:center!important;
      gap:0!important;
      overflow:hidden!important;
      white-space:nowrap!important;
      font-size:0!important;
      line-height:0!important;
      padding-left:0!important;
      padding-right:0!important;
    }
    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title) > :not(.nav-brand-icon),
    .side-nav:not(.open) .side-nav-items > a > :not(.nav-brand-icon) {
      display:none!important;
    }
    .side-nav:not(.open) .side-nav-items .nav-brand-icon {
      display:inline-flex!important;
      width:18px!important;
      min-width:18px!important;
      height:18px!important;
      flex:0 0 18px!important;
      margin:0 auto!important;
      font-size:16px!important;
      line-height:1!important;
      opacity:1!important;
      visibility:visible!important;
    }
  `;
  document.head.appendChild(style);
}

function decorate(node: HTMLElement) {
  if (node.classList.contains("sidebar-ia-group-title")) return;
  const kind = iconKind(node);
  const current = node.querySelector<HTMLElement>(":scope > .nav-brand-icon");

  if (current?.dataset.kind === kind && current.querySelector("svg")) {
    node.dataset.navBrandIcon = kind;
    return;
  }

  current?.remove();
  const icon = document.createElement("span");
  icon.className = "nav-brand-icon";
  icon.dataset.kind = kind;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICONS[kind] || ICONS.file;
  node.prepend(icon);
  node.dataset.navBrandIcon = kind;
}

function applyIcons() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;

  const candidates = Array.from(container.querySelectorAll<HTMLElement>("button, a")).filter((node) => {
    if (node.classList.contains("sidebar-ia-group-title")) return false;
    return node.closest(".side-nav-items") === container;
  });

  candidates.forEach(decorate);
}

export default function NavBrandIcons() {
  useEffect(() => {
    ensureStyles();
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(applyIcons);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "title", "href", "data-nav-ia-group"],
    });
    const timer = window.setInterval(schedule, 900);
    window.addEventListener("popstate", schedule);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("popstate", schedule);
      document.querySelectorAll(".nav-brand-icon").forEach((node) => node.remove());
      document.querySelectorAll<HTMLElement>("[data-nav-brand-icon]").forEach((node) => delete node.dataset.navBrandIcon);
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}
