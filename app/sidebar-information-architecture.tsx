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
  contextual?: boolean;
};

const GROUPS: GroupDef[] = [
  { key: "inicio", label: "INÍCIO", description: "Prioridades, rotina e execução do dia", order: 100 },
  { key: "clientes", label: "CLIENTES", description: "Carteira, jornada, relacionamento e saúde", order: 200 },
  { key: "performance", label: "PERFORMANCE", description: "Decisão de mídia, campanhas e análises Meta", order: 300 },
  { key: "criativo", label: "CRIATIVO", description: "Produção e inteligência criativa", order: 400 },
  { key: "comercial", label: "COMERCIAL", description: "Funil, pré-clientes e vendas", order: 500 },
  { key: "gestao", label: "GESTÃO", description: "Equipe, operação, auditoria e financeiro", order: 600 },
  { key: "sistemas", label: "SISTEMAS", description: "IA, automações e integrações", order: 700 },
];

const STYLE_ID = "sidebar-information-architecture-style";
const STORAGE_PREFIX = "ops-sidebar-groups:v1:";

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
      font-size:8px!important;font-weight:900!important;letter-spacing:.12em!important;text-transform:uppercase;text-align:left;cursor:pointer;
      box-shadow:none!important;transition:color .15s ease,background .15s ease;
    }
    .side-nav-items .sidebar-ia-group-title:hover{color:var(--text)!important;background:rgba(62,146,220,.055)!important}
    .sidebar-ia-group-title .sidebar-ia-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sidebar-ia-group-title .sidebar-ia-group-count{margin-left:auto;color:color-mix(in srgb,var(--muted) 72%,transparent);font-size:8px;font-weight:800;letter-spacing:0}
    .sidebar-ia-group-title .sidebar-ia-group-chevron{color:var(--muted);font-size:10px;line-height:1;transform:rotate(0deg);transition:transform .15s ease}
    .sidebar-ia-group-title[data-collapsed="true"] .sidebar-ia-group-chevron{transform:rotate(-90deg)}
    .sidebar-ia-group-title[data-has-active="true"]{color:var(--text)!important}
    .sidebar-ia-group-title[data-has-active="true"]:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
    .side-nav-items>[data-nav-ia-contextual="true"]{display:none!important}
    .side-nav-items>[data-nav-ia-collapsed="true"]{display:none!important}
    .side-nav-items>[data-nav-ia-group]{position:relative}
    .side-nav-items>[data-nav-ia-group="performance"].active{box-shadow:inset 3px 0 var(--accent)!important}
    .side-nav:not(.open) .sidebar-ia-group-title{height:9px;min-height:9px;margin:6px 8px 3px;padding:0;border-top:1px solid var(--line)!important;border-radius:0!important;pointer-events:none}
    .side-nav:not(.open) .sidebar-ia-group-title>*{display:none!important}
    .side-nav:not(.open) .sidebar-ia-group-title[data-has-active="true"]:before{display:none}
    @media(max-width:720px){.side-nav-items .sidebar-ia-group-title{margin-top:6px}}
  `;
  document.head.appendChild(style);
}

function defaultsForRole(role: string): Record<GroupKey, boolean> {
  const collapsed: Record<GroupKey, boolean> = {
    inicio: false,
    clientes: false,
    performance: true,
    criativo: true,
    comercial: true,
    gestao: true,
    sistemas: true,
  };
  if (role === "GT") collapsed.performance = false;
  if (role === "DESIGN") { collapsed.clientes = true; collapsed.criativo = false; }
  if (role === "COMMERCIAL") { collapsed.clientes = true; collapsed.comercial = false; }
  if (role === "MGMT") collapsed.performance = false;
  if (role === "AI") { collapsed.gestao = false; collapsed.sistemas = false; }
  return collapsed;
}

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId || "anon"}`;
}

function readCollapsed(userId: string, role: string): Record<GroupKey, boolean> {
  const fallback = defaultsForRole(role);
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<GroupKey, boolean>>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function writeCollapsed(userId: string, value: Record<GroupKey, boolean>) {
  try { window.localStorage.setItem(storageKey(userId), JSON.stringify(value)); } catch { /* modo privado */ }
}

function placementFor(node: HTMLElement): Placement {
  const label = norm(node.getAttribute("title") || node.textContent);
  const href = node instanceof HTMLAnchorElement ? norm(node.getAttribute("href")) : "";

  if (node.hasAttribute("data-meta-consultant-nav")) return { group: "performance", order: 5 };
  if (node.hasAttribute("data-meta-analysis-nav") || href === "/meta-analysis") return { group: "performance", order: 30 };
  if (node.hasAttribute("data-meta-performance-nav") || href === "/meta-performance" || label === "performance meta") return { group: "performance", order: 80, contextual: true };
  if (node.hasAttribute("data-client-balances-nav") || label.startsWith("saldo clientes")) return { group: "performance", order: 90, contextual: true };
  if (node.hasAttribute("data-commercial-funnel-nav") || href === "/sales-funnel" || label.startsWith("funil comercial")) return { group: "comercial", order: 10 };
  if (node.hasAttribute("data-adler-finance-nav") || href === "/finance" || label.startsWith("mensalidades") || label === "financeiro") return { group: "gestao", order: 50 };
  if (node.hasAttribute("data-automation-health-nav") || href === "/automations" || label.startsWith("automacoes")) return { group: "sistemas", order: 10 };
  if (node.hasAttribute("data-donnah-nav") || href.includes("/integrations/donnah") || label === "donnah") return { group: "sistemas", order: 20 };
  if (href === "/ia" || label === "ia" || label.startsWith("ia (beta")) return { group: "sistemas", order: 30 };
  if (href === "/meta-radar" || label.startsWith("inteligencia criativa")) return { group: "criativo", order: 20 };

  if (label === "visao geral") return { group: "inicio", order: 10 };
  if (label === "foco do dia" || label === "meu dia") return { group: "inicio", order: 20 };
  if (label.startsWith("central de trabalho")) return { group: "inicio", order: 30 };
  if (label === "alertas" || label.startsWith("alertas operacionais")) return { group: "inicio", order: 40 };
  if (label === "diario") return { group: "inicio", order: 50 };

  if (label === "clientes" || label === "carteira") return { group: "clientes", order: 10 };
  if (label === "saude" || label.startsWith("saude da carteira")) return { group: "clientes", order: 20 };
  if (label === "conversas") return { group: "clientes", order: 30 };
  if (label === "onboarding" || label.startsWith("jornada do cliente")) return { group: "clientes", order: 40 };
  if (label.startsWith("pre-clientes")) return { group: "clientes", order: 50 };

  if (label === "campanhas") return { group: "performance", order: 10 };
  if (label.startsWith("analise meta semanal") || label.startsWith("analises dos gts") || label.startsWith("analise semanal")) return { group: "performance", order: 30 };
  if (label.includes("relatorio meta") || label.includes("relatorios meta")) return { group: "performance", order: 40 };

  if (label.startsWith("central criativa")) return { group: "criativo", order: 10 };

  if (label === "equipe") return { group: "gestao", order: 10 };
  if (label.startsWith("desempenho op") || label.startsWith("desempenho da operacao")) return { group: "gestao", order: 20 };
  if (label === "auditoria") return { group: "gestao", order: 30 };
  if (label === "contratos") return { group: "gestao", order: 40 };
  if (label === "evidencias") return { group: "gestao", order: 80, contextual: true };
  if (label === "clickup") return { group: "sistemas", order: 80, contextual: true };

  return { group: "sistemas", order: 90 };
}

function directNavItems(container: HTMLElement) {
  return Array.from(container.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement &&
    (node.tagName === "BUTTON" || node.tagName === "A") &&
    !node.classList.contains("sidebar-ia-group-title")
  );
}

function ensureGroupHeader(container: HTMLElement, def: GroupDef) {
  let header = container.querySelector<HTMLButtonElement>(`:scope > [data-sidebar-ia-group-header="${def.key}"]`);
  if (!header) {
    header = document.createElement("button");
    header.type = "button";
    header.className = "sidebar-ia-group-title";
    header.dataset.sidebarIaGroupHeader = def.key;
    header.title = def.description;
    header.innerHTML = `<span class="sidebar-ia-group-name"></span><span class="sidebar-ia-group-count"></span><span class="sidebar-ia-group-chevron">⌄</span>`;
    container.appendChild(header);
  }
  header.style.order = String(def.order);
  const label = header.querySelector<HTMLElement>(".sidebar-ia-group-name");
  if (label) label.textContent = def.label;
  return header;
}

export default function SidebarInformationArchitecture() {
  const roleRef = useRef("");
  const userRef = useRef("");

  useEffect(() => {
    ensureStyles();
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      userRef.current = data.session?.user.id || "";
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
        const userId = userRef.current;
        const collapsed = readCollapsed(userId, role);
        const items = directNavItems(container);
        const counts = new Map<GroupKey, number>();
        const activeGroups = new Set<GroupKey>();

        for (const item of items) {
          const placement = placementFor(item);
          item.dataset.navIaGroup = placement.group;
          item.style.order = String((GROUPS.find((g) => g.key === placement.group)?.order || 900) + placement.order);
          if (placement.contextual) item.dataset.navIaContextual = "true";
          else delete item.dataset.navIaContextual;
          if (!placement.contextual) counts.set(placement.group, (counts.get(placement.group) || 0) + 1);
          if (item.classList.contains("active")) activeGroups.add(placement.group);
        }

        for (const group of activeGroups) collapsed[group] = false;

        for (const def of GROUPS) {
          const count = counts.get(def.key) || 0;
          const header = ensureGroupHeader(container, def);
          header.hidden = count === 0;
          header.dataset.collapsed = collapsed[def.key] ? "true" : "false";
          header.dataset.hasActive = activeGroups.has(def.key) ? "true" : "false";
          const countNode = header.querySelector<HTMLElement>(".sidebar-ia-group-count");
          if (countNode) countNode.textContent = count ? String(count) : "";
          header.onclick = () => {
            const next = readCollapsed(userRef.current, roleRef.current);
            next[def.key] = !next[def.key];
            writeCollapsed(userRef.current, next);
            schedule();
          };
        }

        for (const item of items) {
          const group = item.dataset.navIaGroup as GroupKey | undefined;
          if (!group) continue;
          if (item.dataset.navIaContextual === "true") {
            delete item.dataset.navIaCollapsed;
            continue;
          }
          if (collapsed[group] && !activeGroups.has(group)) item.dataset.navIaCollapsed = "true";
          else delete item.dataset.navIaCollapsed;
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
        delete node.dataset.navIaContextual;
        delete node.dataset.navIaCollapsed;
        node.style.removeProperty("order");
      });
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}
