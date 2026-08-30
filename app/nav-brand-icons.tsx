"use client";

import { useEffect } from "react";

const STYLE_ID = "nav-brand-icons-style";
const META_ICON = "data:image/png;base64,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";

const ICONS: Record<string, string> = {"home":"<svg viewBox=\"0 0 24 24\"><path d=\"M3.5 10.8 12 3.8l8.5 7v9.4a.8.8 0 0 1-.8.8h-5.2v-6.2h-5V21H4.3a.8.8 0 0 1-.8-.8z\"/></svg>","target":"<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.2\"/><circle cx=\"12\" cy=\"12\" r=\"3.2\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3\"/></svg>","tasks":"<svg viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"3.5\" width=\"16\" height=\"17\" rx=\"2\"/><path d=\"m8 9 1.6 1.6L13 7.4M8 15h8\"/></svg>","users":"<svg viewBox=\"0 0 24 24\"><path d=\"M16 20v-1.6c0-2.2-1.8-4-4-4H7c-2.2 0-4 1.8-4 4V20\"/><circle cx=\"9.5\" cy=\"7.3\" r=\"3.3\"/><path d=\"M16.5 4.4a3 3 0 0 1 0 5.8M18.5 14.6c1.6.6 2.5 1.8 2.5 3.5V20\"/></svg>","heart":"<svg viewBox=\"0 0 24 24\"><path d=\"M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 0 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1z\"/></svg>","route":"<svg viewBox=\"0 0 24 24\"><circle cx=\"5\" cy=\"18\" r=\"2\"/><circle cx=\"19\" cy=\"6\" r=\"2\"/><path d=\"M7 18h3c5 0 1-12 6-12h1\"/></svg>","userplus":"<svg viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"8\" r=\"3.2\"/><path d=\"M3.5 20v-1.4c0-2.6 2.1-4.6 4.6-4.6h1.8c2.6 0 4.6 2.1 4.6 4.6V20M18 8v6M15 11h6\"/></svg>","chat":"<svg viewBox=\"0 0 24 24\"><path d=\"M5 18.5 3.8 21l4.1-1.2c1.2.5 2.6.8 4.1.8 5 0 9-3.7 9-8.3S17 4 12 4s-9 3.7-9 8.3c0 2.4.8 4.5 2 6.2z\"/></svg>","note":"<svg viewBox=\"0 0 24 24\"><path d=\"M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z\"/><path d=\"M15 3.5V7h3M8 11h7M8 15h7\"/></svg>","check":"<svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"4\"/><path d=\"m7.5 12.5 3 3 6-7\"/></svg>","filecheck":"<svg viewBox=\"0 0 24 24\"><path d=\"M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z\"/><path d=\"M15 3.5V7h3m-9 7 2 2 4-4\"/></svg>","search":"<svg viewBox=\"0 0 24 24\"><circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\"/><path d=\"m15.5 15.5 5 5\"/></svg>","bell":"<svg viewBox=\"0 0 24 24\"><path d=\"M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4\"/></svg>","chart":"<svg viewBox=\"0 0 24 24\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20v-11M2 20h21\"/></svg>","palette":"<svg viewBox=\"0 0 24 24\"><path d=\"M12 3a9 9 0 1 0 0 18h1.2a2.2 2.2 0 0 0 0-4.4h-.9a1.8 1.8 0 0 1 0-3.6H15a6 6 0 0 0 6-6c0-2.2-4-4-9-4z\"/><circle cx=\"7.5\" cy=\"9\" r=\"1\"/><circle cx=\"10\" cy=\"6.5\" r=\"1\"/><circle cx=\"15\" cy=\"7\" r=\"1\"/></svg>","funnel":"<svg viewBox=\"0 0 24 24\"><path d=\"M3 5h18l-7 8v5l-4 2v-7z\"/></svg>","wallet":"<svg viewBox=\"0 0 24 24\"><path d=\"M4 6.5h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h11\"/><path d=\"M16 11h6v4h-6a2 2 0 0 1 0-4z\"/></svg>","gear":"<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9L1.1 5.9 2 7.8l-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z\" transform=\"translate(2.5 0) scale(.8)\"/></svg>","plug":"<svg viewBox=\"0 0 24 24\"><path d=\"M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6\"/></svg>","sparkle":"<svg viewBox=\"0 0 24 24\"><path d=\"m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z\"/></svg>","shield":"<svg viewBox=\"0 0 24 24\"><path d=\"M12 3 20 6v5c0 5.2-3.4 8.3-8 10-4.6-1.7-8-4.8-8-10V6z\"/><path d=\"m8.5 12 2.2 2.2 4.8-5\"/></svg>","refresh":"<svg viewBox=\"0 0 24 24\"><path d=\"M20 7v5h-5M4 17v-5h5\"/><path d=\"M6.2 8.2A7 7 0 0 1 18.8 10M17.8 15.8A7 7 0 0 1 5.2 14\"/></svg>","file":"<svg viewBox=\"0 0 24 24\"><path d=\"M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z\"/><path d=\"M15 3.5V7h3\"/></svg>","lock":"<svg viewBox=\"0 0 24 24\"><rect x=\"5\" y=\"10\" width=\"14\" height=\"11\" rx=\"2\"/><path d=\"M8 10V7a4 4 0 0 1 8 0v3\"/></svg>"};

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
    node.hasAttribute("data-meta-radar-nav")
  ) return true;

  if (
    href === "/meta-analysis" ||
    href === "/meta-performance" ||
    href === "/meta-radar" ||
    label === "campanhas" ||
    label.includes("meta ads") ||
    label.includes("relatorio meta") ||
    label.includes("relatorios meta") ||
    label.includes("analise meta") ||
    label.includes("performance meta") ||
    label.includes("inteligencia criativa") ||
    label.startsWith("saldo clientes")
  ) return true;

  return false;
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
  if (label === "equipe") return "users";
  if (label === "diario") return "note";
  if (label === "clickup") return "check";
  if (label === "evidencias") return "filecheck";
  if (label === "auditoria") return "search";
  if (label === "alertas" || label.startsWith("alertas operacionais")) return "bell";
  if (label.startsWith("desempenho op") || label.startsWith("desempenho da operacao")) return "chart";
  if (label.startsWith("central criativa")) return "palette";
  if (node.hasAttribute("data-commercial-funnel-nav") || href === "/sales-funnel" || label.startsWith("funil comercial")) return "funnel";
  if (node.hasAttribute("data-adler-finance-nav") || href === "/finance" || label === "financeiro" || label.startsWith("mensalidades")) return "wallet";
  if (node.hasAttribute("data-automation-health-nav") || href === "/automations" || label.startsWith("automacoes")) return "gear";
  if (node.hasAttribute("data-donnah-nav") || href.includes("/integrations/donnah") || label === "donnah") return "plug";
  if (href === "/ia" || label === "ia" || label.startsWith("ia (beta")) return "sparkle";
  if (label.startsWith("seguranca")) return "shield";
  if (label.startsWith("atualizacoes")) return "refresh";
  if (label === "contratos") return "file";
  if (label.startsWith("acessos")) return "lock";
  return "";
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .side-nav-items > button:not(.sidebar-ia-group-title),
    .side-nav-items > a {
      display:flex!important;
      align-items:center!important;
      gap:9px!important;
    }
    .nav-brand-icon {
      width:16px;
      height:16px;
      flex:0 0 16px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      color:color-mix(in srgb,var(--muted) 88%,var(--text));
      opacity:.92;
      transition:opacity .15s ease,color .15s ease,transform .15s ease;
      pointer-events:none;
    }
    .nav-brand-icon svg {
      width:15px;
      height:15px;
      display:block;
      fill:none;
      stroke:currentColor;
      stroke-width:1.75;
      stroke-linecap:round;
      stroke-linejoin:round;
      overflow:visible;
    }
    .nav-brand-icon[data-kind="meta"] {
      width:18px;
      height:14px;
      flex-basis:18px;
      background-image:url("${META_ICON}");
      background-size:18px auto;
      background-position:center;
      background-repeat:no-repeat;
      opacity:1;
    }
    .side-nav-items > button:hover .nav-brand-icon,
    .side-nav-items > a:hover .nav-brand-icon,
    .side-nav-items > .active .nav-brand-icon {
      color:var(--text);
      opacity:1;
    }
    .side-nav-items > .active .nav-brand-icon[data-kind="meta"] {
      transform:scale(1.04);
    }
    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
    .side-nav:not(.open) .side-nav-items > a {
      justify-content:center!important;
      gap:0!important;
    }
    .side-nav:not(.open) .nav-brand-icon {
      flex-basis:18px;
      margin:0!important;
    }
  `;
  document.head.appendChild(style);
}

function decorate(node: HTMLElement) {
  if (node.classList.contains("sidebar-ia-group-title")) return;
  const kind = iconKind(node);
  const current = node.querySelector<HTMLElement>(":scope > .nav-brand-icon");
  if (!kind) {
    current?.remove();
    delete node.dataset.navBrandIcon;
    return;
  }
  if (current?.dataset.kind === kind) return;

  current?.remove();
  const icon = document.createElement("span");
  icon.className = "nav-brand-icon";
  icon.dataset.kind = kind;
  icon.setAttribute("aria-hidden", "true");
  if (kind !== "meta") icon.innerHTML = ICONS[kind] || "";
  node.prepend(icon);
  node.dataset.navBrandIcon = kind;
}

function applyIcons() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;
  container.querySelectorAll<HTMLElement>(":scope > button, :scope > a").forEach(decorate);
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
      attributeFilter: ["class", "title", "href"],
    });
    const timer = window.setInterval(schedule, 1800);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.querySelectorAll(".nav-brand-icon").forEach((node) => node.remove());
      document.querySelectorAll<HTMLElement>("[data-nav-brand-icon]").forEach((node) => delete node.dataset.navBrandIcon);
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}
