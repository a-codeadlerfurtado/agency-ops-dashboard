"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const FRIDAY_API = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;
const DASHBOARD_API = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api?view=home`;

const EXECUTIVE_AREAS = [
  { key: "cockpit", label: "Cockpit" },
  { key: "commercial", label: "Comercial" },
  { key: "revenue", label: "Receita" },
  { key: "acquisition", label: "Aquisição" },
  { key: "postsale", label: "Pós-venda" },
  { key: "intelligence", label: "Inteligência" },
] as const;

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

function ensureStyles() {
  if (document.getElementById("commercial-navigation-style")) return;
  const style = document.createElement("style");
  style.id = "commercial-navigation-style";
  style.textContent = `
    .sales-funnel-shortcut,.friday-report-shortcut{display:none!important}
    .commercial-section-nav{max-width:1440px;margin:-10px auto 18px;display:flex;align-items:center;gap:8px;padding:7px;border:1px solid rgba(116,196,158,.16);background:rgba(8,22,20,.82);border-radius:12px;backdrop-filter:blur(12px)}
    .commercial-section-nav .commercial-section-label{padding:0 8px;color:#6f9184;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    .commercial-section-nav button{border:1px solid transparent;background:transparent;color:#91aa9f;border-radius:8px;padding:9px 12px;cursor:pointer;font:inherit;font-size:11px;font-weight:750}
    .commercial-section-nav button:hover{background:rgba(255,255,255,.045);color:#eef8f3}
    .commercial-section-nav button.active{border-color:rgba(103,215,161,.28);background:rgba(44,145,98,.14);color:#dff8ea}
    .side-nav-items [data-commercial-executive-nav="true"]{width:100%;text-align:left}
    @media(max-width:760px){.commercial-section-nav{margin:-6px 12px 14px;overflow:auto}.commercial-section-nav .commercial-section-label{display:none}.commercial-section-nav button{white-space:nowrap}}
  `;
  document.head.appendChild(style);
}

function removeLegacyShortcuts() {
  document.querySelectorAll(".sales-funnel-shortcut,.friday-report-shortcut").forEach((node) => node.remove());
}

function makeSectionButton(label: string, href: string, active: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = active ? "active" : "";
  button.addEventListener("click", () => window.location.assign(href));
  return button;
}

function restoreExecutiveSidebar() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;
  container.querySelectorAll<HTMLElement>("[data-commercial-executive-nav='true']").forEach((node) => node.remove());
  Array.from(container.children).forEach((raw) => {
    const node = raw as HTMLElement;
    if (node.dataset.commercialHiddenByExecutive !== "true") return;
    node.style.display = node.dataset.commercialOriginalDisplay === "__EMPTY__" ? "" : (node.dataset.commercialOriginalDisplay || "");
    delete node.dataset.commercialHiddenByExecutive;
    delete node.dataset.commercialOriginalDisplay;
  });
  delete container.dataset.commercialExecutiveSidebar;
}

function installExecutiveSidebar() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;
  container.dataset.commercialExecutiveSidebar = "true";

  const children = Array.from(container.children) as HTMLElement[];
  const contractNode = children.find((node) => normalize(node.getAttribute("title") || node.textContent || "") === "contratos") || null;
  const template = contractNode || children.find((node) => node.tagName === "BUTTON") || null;

  for (const node of children) {
    if (node.dataset.commercialExecutiveNav === "true") continue;
    const label = normalize(node.getAttribute("title") || node.textContent || "");
    const keep = label === "contratos";
    if (keep) {
      if (node.dataset.commercialHiddenByExecutive === "true") {
        node.style.display = node.dataset.commercialOriginalDisplay === "__EMPTY__" ? "" : (node.dataset.commercialOriginalDisplay || "");
        delete node.dataset.commercialHiddenByExecutive;
        delete node.dataset.commercialOriginalDisplay;
      }
      continue;
    }
    if (node.dataset.commercialHiddenByExecutive !== "true") {
      node.dataset.commercialOriginalDisplay = node.style.display || "__EMPTY__";
      node.dataset.commercialHiddenByExecutive = "true";
    }
    node.style.display = "none";
  }

  for (const area of EXECUTIVE_AREAS) {
    if (container.querySelector(`[data-commercial-executive-area="${area.key}"]`)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.commercialExecutiveNav = "true";
    button.dataset.commercialExecutiveArea = area.key;
    button.title = area.label;
    button.textContent = area.label;
    if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
    button.addEventListener("click", () => window.location.assign(`/commercial-direction?area=${area.key}`));
    if (contractNode) container.insertBefore(button, contractNode);
    else container.appendChild(button);
  }
}

function applyCommercialDirectionAreaFromQuery() {
  if (window.location.pathname !== "/commercial-direction") return;
  const requested = new URLSearchParams(window.location.search).get("area");
  if (!requested) return;
  const area = EXECUTIVE_AREAS.find((item) => item.key === requested);
  if (!area) return;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".cd-main-tabs button"));
  const target = buttons.find((button) => normalize(button.textContent || "") === normalize(area.label));
  if (!target || target.classList.contains("active")) return;
  target.click();
}

function installDashboardTab(role: string | null) {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;

  if (role === "COMMERCIAL") {
    container.querySelectorAll("[data-commercial-funnel-nav]").forEach((node) => node.remove());
    installExecutiveSidebar();
    return;
  }

  restoreExecutiveSidebar();
  const label = "Funil comercial";
  const href = "/sales-funnel";
  const existing = container.querySelector<HTMLButtonElement>("[data-commercial-funnel-nav]");
  if (existing) {
    if (existing.dataset.commercialMode === "funnel") return;
    existing.remove();
  }

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const campaigns = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("campanhas"));
  const onboarding = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("onboarding"));
  const template = campaigns || onboarding || buttons[0];

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.commercialFunnelNav = "true";
  button.dataset.commercialMode = "funnel";
  button.title = label;
  if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
  button.textContent = label;
  button.addEventListener("click", () => window.location.assign(href));

  if (campaigns) container.insertBefore(button, campaigns);
  else if (onboarding?.nextSibling) container.insertBefore(button, onboarding.nextSibling);
  else container.appendChild(button);
}

function installCommercialSubnav(path: string, fridayAllowed: boolean) {
  if (document.querySelector("[data-commercial-section-nav]")) return;
  const anchor = document.querySelector<HTMLElement>(path === "/sales-funnel" ? ".funnel-top" : ".fr-top");
  if (!anchor?.parentElement) return;

  const nav = document.createElement("nav");
  nav.className = "commercial-section-nav";
  nav.dataset.commercialSectionNav = "true";

  const label = document.createElement("span");
  label.className = "commercial-section-label";
  label.textContent = "Funil comercial";
  nav.appendChild(label);
  nav.appendChild(makeSectionButton("Visão do funil", "/sales-funnel", path === "/sales-funnel"));
  if (fridayAllowed || path === "/friday-report") nav.appendChild(makeSectionButton("Relatório de sexta", "/friday-report", path === "/friday-report"));
  anchor.parentElement.insertBefore(nav, anchor.nextSibling);
}

export default function CommercialNavigationBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [fridayAllowed, setFridayAllowed] = useState(false);
  const [profileRole, setProfileRole] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { ensureStyles(); removeLegacyShortcuts(); }, []);

  useEffect(() => {
    if (!session?.access_token) { setProfileRole(null); return; }
    let active = true;
    authenticatedFetch(DASHBOARD_API, { cache: "no-store" })
      .then(async (response) => {
        if (!active || !response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (active) setProfileRole(String(body?.profile?.role || "") || null);
      })
      .catch(() => { if (active) setProfileRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (profileRole !== "COMMERCIAL") return;
    const routeClients = (event: MouseEvent) => {
      if (window.location.pathname !== "/") return;
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".side-nav-items button") : null;
      if (!button) return;
      const label = normalize(button.title || button.textContent || "");
      if (label !== "clientes") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.assign("/commercial-clients");
    };
    document.addEventListener("click", routeClients, true);
    return () => document.removeEventListener("click", routeClients, true);
  }, [profileRole]);

  useEffect(() => {
    if (!session?.access_token) { setFridayAllowed(false); return; }
    const path = window.location.pathname;
    if (path !== "/sales-funnel" && path !== "/friday-report") return;
    let active = true;
    authenticatedFetch(FRIDAY_API, { cache: "no-store" })
      .then((response) => { if (active) setFridayAllowed(response.ok); })
      .catch(() => { if (active) setFridayAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!session) return;
    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const path = window.location.pathname;
        removeLegacyShortcuts();
        if (path === "/") installDashboardTab(profileRole);
        else if (profileRole !== "COMMERCIAL") restoreExecutiveSidebar();
        if (path === "/sales-funnel" || path === "/friday-report") installCommercialSubnav(path, fridayAllowed);
        if (profileRole === "COMMERCIAL" && path === "/commercial-direction") applyCommercialDirectionAreaFromQuery();
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 1200);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.querySelectorAll("[data-commercial-funnel-nav],[data-commercial-section-nav]").forEach((node) => node.remove());
      restoreExecutiveSidebar();
    };
  }, [session, fridayAllowed, profileRole]);

  return null;
}