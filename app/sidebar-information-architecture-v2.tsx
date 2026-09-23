"use client";

import { useEffect, useRef } from "react";
import { loadProfileLite, supabase } from "./shared";

type GroupKey = "inicio" | "clientes" | "performance" | "criativo" | "comercial" | "gestao" | "sistemas";

type GroupDef = {
  key: GroupKey;
  label: string;
  description: string;
  order: number;
};

type Placement = {
  group: GroupKey;
  order: number;
};

const GROUPS: GroupDef[] = [
  { key: "inicio", label: "INÍCIO", description: "Prioridades, rotina e execução do dia", order: 100 },
  { key: "clientes", label: "CLIENTES", description: "Carteira, jornada, relacionamento e briefings", order: 200 },
  { key: "performance", label: "TRÁFEGO & RESULTADOS", description: "Campanhas, Meta, saldos e inteligência de mídia", order: 300 },
  { key: "gestao", label: "GESTÃO", description: "Equipe, capacidade, diagnóstico, auditoria e financeiro", order: 400 },
  { key: "comercial", label: "COMERCIAL", description: "Pré-clientes, funil e acompanhamento comercial", order: 500 },
  { key: "criativo", label: "CONTEÚDO & CRIATIVO", description: "Criativos, roteiros, vídeos e inteligência criativa", order: 600 },
  { key: "sistemas", label: "SISTEMAS & IA", description: "IA, Relato, automações, ClickUp e segurança", order: 700 },
];

const ROLE_GROUP_ORDER: Record<string, GroupKey[]> = {
  MGMT: ["inicio", "clientes", "performance", "gestao", "comercial", "criativo", "sistemas"],
  GT: ["inicio", "clientes", "performance", "criativo", "sistemas", "gestao", "comercial"],
  CS: ["inicio", "clientes", "comercial", "criativo", "sistemas", "gestao", "performance"],
  DESIGN: ["inicio", "criativo", "clientes", "sistemas", "gestao", "performance", "comercial"],
  COMMERCIAL: ["inicio", "comercial", "clientes", "gestao", "sistemas", "performance", "criativo"],
  AI: ["inicio", "sistemas", "gestao", "clientes", "performance", "criativo", "comercial"],
};

function groupOrder(role: string, key: GroupKey) {
  const list = ROLE_GROUP_ORDER[role] || ROLE_GROUP_ORDER.MGMT;
  const index = list.indexOf(key);
  return (index < 0 ? 99 : index + 1) * 100;
}

const STYLE_ID = "sidebar-information-architecture-style";

function norm(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .side-nav-items{gap:2px!important}
    .side-nav-items .sidebar-ia-group-title{
      display:flex;align-items:center;gap:7px;width:100%;min-height:26px;margin:8px 0 1px;padding:6px 10px 4px;
      border:0!important;background:transparent!important;color:var(--muted)!important;border-radius:7px!important;
      font-size:8px!important;font-weight:900!important;letter-spacing:.12em!important;text-transform:uppercase;text-align:left;cursor:default;
      box-shadow:none!important;transition:color .15s ease,background .15s ease;
    }
    .sidebar-ia-group-title .sidebar-ia-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sidebar-ia-group-title .sidebar-ia-group-count{margin-left:auto;color:color-mix(in srgb,var(--muted) 72%,transparent);font-size:8px;font-weight:800;letter-spacing:0}
    .sidebar-ia-group-title[data-has-active="true"]{color:var(--text)!important}
    .sidebar-ia-group-title[data-has-active="true"]:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
    .side-nav-items>[data-nav-ia-group]{position:relative}
    .side-nav-items>[data-nav-ia-group="performance"].active{box-shadow:inset 3px 0 var(--accent)!important}
    .side-nav:not(.open) .sidebar-ia-group-title{height:9px;min-height:9px;margin:6px 8px 3px;padding:0;border-top:1px solid var(--line)!important;border-radius:0!important;pointer-events:none}
    .side-nav:not(.open) .sidebar-ia-group-title>*{display:none!important}
    .side-nav:not(.open) .sidebar-ia-group-title[data-has-active="true"]:before{display:none}
    @media(max-width:720px){.side-nav-items .sidebar-ia-group-title{margin-top:6px}}
  `;
  document.head.appendChild(style);
}



function placementFor(node: HTMLElement): Placement {
  const label = norm(node.getAttribute("title") || node.textContent);
  const href = node instanceof HTMLAnchorElement ? norm(node.getAttribute("href")) : "";

  if (label === "visao geral") return { group: "inicio", order: 10 };
  if (label === "foco do dia" || label === "meu dia") return { group: "inicio", order: 20 };
  if (label.startsWith("central de trabalho")) return { group: "inicio", order: 30 };
  if (label === "alertas" || label.startsWith("alertas operacionais")) return { group: "inicio", order: 40 };
  if (label === "diario") return { group: "inicio", order: 50 };

  if (label === "clientes" || label === "carteira") return { group: "clientes", order: 10 };
  if (label === "saude" || label.startsWith("saude da carteira")) return { group: "clientes", order: 20 };
  if (label === "conversas") return { group: "clientes", order: 30 };
  if (label === "onboarding" || label.startsWith("jornada do cliente")) return { group: "clientes", order: 40 };
  if (node.hasAttribute("data-briefing-staff-nav") || label === "briefing hub") return { group: "clientes", order: 50 };

  if (node.hasAttribute("data-ads-intelligence-nav") || label === "ads intelligence") return { group: "performance", order: 4 };
  if (node.hasAttribute("data-meta-consultant-nav")) return { group: "performance", order: 5 };
  if (label === "campanhas") return { group: "performance", order: 10 };
  if (node.hasAttribute("data-meta-analysis-nav") || href === "/meta-analysis" || label.startsWith("analise meta")) return { group: "performance", order: 30 };
  if (label.includes("relatorio meta") || label.includes("relatorios meta")) return { group: "performance", order: 40 };
  if (node.hasAttribute("data-meta-performance-nav") || href === "/meta-performance" || label === "performance meta") return { group: "performance", order: 50 };
  if (node.hasAttribute("data-client-balances-nav") || label.startsWith("saldo clientes")) return { group: "performance", order: 60 };

  if (label === "equipe") return { group: "gestao", order: 10 };
  if (label.startsWith("desempenho op") || label.startsWith("desempenho da operacao")) return { group: "gestao", order: 20 };
  if (label === "capacidade" || label.startsWith("capacidade operacional")) return { group: "gestao", order: 25 };
  if (node.hasAttribute("data-diagnostics-nav") || href === "/diagnostics" || label === "central de diagnostico") return { group: "gestao", order: 30 };
  if (label === "auditoria") return { group: "gestao", order: 40 };
  if (label === "evidencias") return { group: "gestao", order: 50 };
  if (label === "contratos") return { group: "gestao", order: 60 };
  if (node.hasAttribute("data-adler-finance-nav") || href === "/finance" || label.startsWith("mensalidades") || label === "financeiro") return { group: "gestao", order: 70 };
  if (href === "/wrapped" || label === "wrapped") return { group: "gestao", order: 80 };

  if (label.startsWith("pre-clientes") || label.startsWith("pre clientes")) return { group: "comercial", order: 10 };
  if (node.hasAttribute("data-commercial-funnel-nav") || href === "/sales-funnel" || label.startsWith("funil comercial")) return { group: "comercial", order: 20 };
  if (label.startsWith("acompanhamento comercial")) return { group: "comercial", order: 30 };

  if (label.startsWith("central criativa")) return { group: "criativo", order: 10 };
  if (node.hasAttribute("data-video-scripts-nav") || label.startsWith("producao de roteiros")) return { group: "criativo", order: 20 };
  if (label.startsWith("videos automaticos")) return { group: "criativo", order: 30 };
  if (node.hasAttribute("data-meta-radar-nav") || href === "/meta-radar" || href === "/creative-intelligence" || label.startsWith("inteligencia criativa")) return { group: "criativo", order: 40 };
  if (node.hasAttribute("data-ad-radar-nav") || label === "radar de anuncios") return { group: "criativo", order: 50 };

  if (href === "/ia" || label === "ia" || label.startsWith("ia (beta")) return { group: "sistemas", order: 10 };
  if (node.hasAttribute("data-meetings-nav") || label === "relato ai") return { group: "sistemas", order: 20 };
  if (node.hasAttribute("data-automation-health-nav") || href === "/automations" || label.startsWith("automacoes")) return { group: "sistemas", order: 30 };
  if (node.hasAttribute("data-donnah-nav") || href.includes("/integrations/donnah") || label === "donnah") return { group: "sistemas", order: 40 };
  if (label === "clickup") return { group: "sistemas", order: 50 };
  if (node.hasAttribute("data-security-center-nav") || label === "seguranca") return { group: "sistemas", order: 60 };
  if (node.hasAttribute("data-system-updates-nav") || label === "atualizacoes") return { group: "sistemas", order: 70 };

  return { group: "sistemas", order: 90 };
}

function directNavItems(container: HTMLElement) {
  return Array.from(container.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement &&
    (node.tagName === "BUTTON" || node.tagName === "A") &&
    !node.classList.contains("sidebar-ia-group-title")
  );
}

function ensureGroupHeader(container: HTMLElement, def: GroupDef, order: number) {
  let header = container.querySelector<HTMLElement>(`:scope > [data-sidebar-ia-group-header="${def.key}"]`);
  if (!header) {
    header = document.createElement("div");
    header.className = "sidebar-ia-group-title";
    header.dataset.sidebarIaGroupHeader = def.key;
    header.title = def.description;
    header.innerHTML = `<span class="sidebar-ia-group-name"></span><span class="sidebar-ia-group-count"></span>`;
    container.appendChild(header);
  }
  header.style.order = String(order);
  const label = header.querySelector<HTMLElement>(".sidebar-ia-group-name");
  if (label) label.textContent = def.label;
  return header;
}

export default function SidebarInformationArchitecture() {
  const roleRef = useRef("");

  useEffect(() => {
    ensureStyles();
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      if (!data.session) return;
      try {
        const body = await loadProfileLite();
        if (!alive) return;
        roleRef.current = String(body?.profile?.role || "");
      } catch { /* agrupamento funciona mesmo sem perfil */ }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let frame = 0;
    let applying = false;

    const apply = () => {
      if (applying || window.location.pathname !== "/") return;
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!container) return;
      applying = true;
      try {
        const role = roleRef.current;
        const items = directNavItems(container);
        const counts = new Map<GroupKey, number>();
        const activeGroups = new Set<GroupKey>();

        for (const item of items) {
          const placement = placementFor(item);
          item.dataset.navIaGroup = placement.group;
          item.style.order = String(groupOrder(role, placement.group) + placement.order);
          counts.set(placement.group, (counts.get(placement.group) || 0) + 1);
          if (item.classList.contains("active")) activeGroups.add(placement.group);
        }


        for (const def of GROUPS) {
          const count = counts.get(def.key) || 0;
          const header = ensureGroupHeader(container, def, groupOrder(role, def.key));
          header.hidden = count === 0;
          header.dataset.hasActive = activeGroups.has(def.key) ? "true" : "false";
          const countNode = header.querySelector<HTMLElement>(".sidebar-ia-group-count");
          if (countNode) countNode.textContent = count ? String(count) : "";
        }

      } finally {
        applying = false;
      }
    };

    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(apply);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "title", "href"] });
    const timer = window.setInterval(schedule, 1800);
    window.addEventListener("popstate", schedule);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("popstate", schedule);
      document.querySelectorAll(".sidebar-ia-group-title").forEach((node) => node.remove());
      document.querySelectorAll<HTMLElement>("[data-nav-ia-group]").forEach((node) => {
        delete node.dataset.navIaGroup;
        node.style.removeProperty("order");
      });
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}

