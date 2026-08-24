"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

const FRIDAY_API = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;
const GABRIEL_USER_ID = "197fb469-bc67-492c-9b74-154372760633";
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
    .commercial-director-sidebar{position:fixed;z-index:120;left:14px;top:86px;bottom:18px;width:184px;padding:12px 10px;border:1px solid rgba(116,196,158,.18);border-radius:14px;background:rgba(7,20,18,.94);box-shadow:0 18px 48px rgba(0,0,0,.24);backdrop-filter:blur(18px);display:flex;flex-direction:column;gap:5px;overflow:auto}
    .commercial-director-sidebar .commercial-director-title{padding:7px 9px 12px;color:#6f9184;font-size:9px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid rgba(116,196,158,.12);margin-bottom:4px}
    .commercial-director-sidebar button{width:100%;border:1px solid transparent;background:transparent;color:#91aa9f;border-radius:9px;padding:10px 11px;text-align:left;cursor:pointer;font:inherit;font-size:11px;font-weight:750}
    .commercial-director-sidebar button:hover{background:rgba(255,255,255,.045);color:#eef8f3}
    .commercial-director-sidebar button.active{border-color:rgba(103,215,161,.28);background:rgba(44,145,98,.14);color:#dff8ea}
    html.commercial-director-page body{padding-left:212px!important}
    @media(max-width:900px){
      .commercial-section-nav{margin:-6px 12px 14px;overflow:auto}.commercial-section-nav .commercial-section-label{display:none}.commercial-section-nav button{white-space:nowrap}
      html.commercial-director-page body{padding-left:0!important;padding-bottom:76px!important}
      .commercial-director-sidebar{left:10px;right:10px;top:auto;bottom:10px;width:auto;height:auto;flex-direction:row;overflow-x:auto;padding:8px}
      .commercial-director-sidebar .commercial-director-title{display:none}.commercial-director-sidebar button{width:auto;white-space:nowrap}
    }
  `;
  document.head.appendChild(style);
}

function removeLegacyShortcuts() {
  document.querySelectorAll(".sales-funnel-shortcut,.friday-report-shortcut").forEach((node) => node.remove());
}

function removeCommercialNavigation() {
  document.querySelectorAll("[data-commercial-funnel-nav],[data-commercial-section-nav]").forEach((node) => node.remove());
}

function removeCommercialDirectorNavigation() {
  document.documentElement.classList.remove("commercial-director-page");
  document.querySelectorAll("[data-commercial-director-nav],[data-commercial-director-item]").forEach((node) => node.remove());
}

function makeSectionButton(label: string, href: string, active: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = active ? "active" : "";
  button.addEventListener("click", () => window.location.assign(href));
  return button;
}

function installDashboardTab() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container || container.querySelector("[data-commercial-funnel-nav]")) return;
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const campaigns = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("campanhas"));
  const onboarding = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("onboarding"));
  const template = campaigns || onboarding || buttons[0];
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.commercialFunnelNav = "true";
  button.title = "Funil comercial";
  if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
  button.textContent = "Funil comercial";
  button.addEventListener("click", () => window.location.assign("/sales-funnel"));
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

function makeDirectorButton(label: string, href: string, key: string, active = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.commercialDirectorItem = key;
  button.textContent = label;
  button.title = label;
  if (active) button.classList.add("active");
  button.addEventListener("click", () => window.location.assign(href));
  return button;
}

const directorItems = [
  ["home", "Home Comercial", "/commercial-home"],
  ["clients", "Clientes", "/commercial-clients"],
  ["funnel", "Funil Comercial", "/commercial-home?tab=funnel"],
  ["campaigns", "Campanhas", "/commercial-home?tab=campaigns"],
  ["preclients", "Pré-clientes", "/?commercial_view=preclients"],
  ["portfolio", "Carteira Comercial", "/commercial-home?tab=portfolio"],
  ["direction", "Direção Comercial", "/commercial-direction"],
] as const;

function currentDirectorKey() {
  const path = window.location.pathname;
  if (path === "/commercial-clients") return "clients";
  if (path === "/commercial-direction") return "direction";
  if (path === "/commercial-home") {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "funnel" || tab === "campaigns" || tab === "portfolio") return tab;
    return "home";
  }
  if (path === "/") {
    const view = new URLSearchParams(window.location.search).get("commercial_view");
    if (view === "preclients") return "preclients";
  }
  return "home";
}

function installCommercialDirectorSidebar() {
  const path = window.location.pathname;
  if (!["/commercial-home", "/commercial-direction", "/commercial-clients"].includes(path)) {
    document.documentElement.classList.remove("commercial-director-page");
    document.querySelector("[data-commercial-director-nav]")?.remove();
    return;
  }
  document.documentElement.classList.add("commercial-director-page");
  if (document.querySelector("[data-commercial-director-nav]")) return;
  const nav = document.createElement("aside");
  nav.className = "commercial-director-sidebar";
  nav.dataset.commercialDirectorNav = "true";
  const title = document.createElement("div");
  title.className = "commercial-director-title";
  title.textContent = "Direção Comercial";
  nav.appendChild(title);
  const active = currentDirectorKey();
  directorItems.forEach(([key, label, href]) => nav.appendChild(makeDirectorButton(label, href, key, key === active)));
  document.body.appendChild(nav);
}

function installCommercialDashboardItems() {
  if (window.location.pathname !== "/") return;
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const clients = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("clientes"));
  const campaigns = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("campanhas"));
  const preclients = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("pre clientes"));
  const template = clients || campaigns || buttons[0];
  const insert = (key: string, label: string, href: string, before?: Element | null) => {
    if (container.querySelector(`[data-commercial-director-item="${key}"]`)) return;
    const item = makeDirectorButton(label, href, key);
    if (template?.className) item.className = template.className.replace(/\bactive\b/g, "").trim();
    if (before) container.insertBefore(item, before); else container.appendChild(item);
  };
  insert("home", "Home Comercial", "/commercial-home", container.firstElementChild);
  insert("funnel", "Funil Comercial", "/commercial-home?tab=funnel", campaigns);
  insert("portfolio", "Carteira Comercial", "/commercial-home?tab=portfolio", preclients?.nextElementSibling || null);
  insert("direction", "Direção Comercial", "/commercial-direction");
}

function routeCommercialClients(event: MouseEvent) {
  if (window.location.pathname !== "/") return;
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".side-nav-items button") : null;
  if (!button) return;
  const label = normalize(button.title || button.textContent || "");
  if (label !== "clientes") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.location.assign("/commercial-clients");
}

function activateRequestedCommercialView() {
  if (window.location.pathname !== "/") return;
  const requested = new URLSearchParams(window.location.search).get("commercial_view");
  if (!requested) return;
  const labelByView: Record<string, string> = { preclients: "pre clientes", campaigns: "campanhas", clients: "clientes" };
  const label = labelByView[requested];
  if (!label || requested === "clients") return;
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".side-nav-items button"))
    .find((candidate) => normalize(candidate.title || candidate.textContent || "").startsWith(label));
  if (button && !button.classList.contains("active")) button.click();
}

function activateCommercialHomeTab() {
  if (window.location.pathname !== "/commercial-home") return;
  const requested = new URLSearchParams(window.location.search).get("tab");
  if (!requested) return;
  const labelByTab: Record<string, string> = { funnel: "funil comercial", campaigns: "campanhas", portfolio: "carteira" };
  const label = labelByTab[requested];
  if (!label) return;
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".cd-tabs button"))
    .find((candidate) => normalize(candidate.textContent || "") === label);
  if (button && !button.classList.contains("active")) button.click();
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
    loadProfileLite()
      .then((body) => { if (active) setProfileRole(String(body?.profile?.role || "") || null); })
      .catch(() => { if (active) setProfileRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (profileRole !== "COMMERCIAL" || !session) {
      removeCommercialDirectorNavigation();
      return;
    }
    document.addEventListener("click", routeCommercialClients, true);
    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        removeLegacyShortcuts();
        removeCommercialNavigation();
        installCommercialDashboardItems();
        installCommercialDirectorSidebar();
        activateRequestedCommercialView();
        activateCommercialHomeTab();
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 900);
    return () => {
      document.removeEventListener("click", routeCommercialClients, true);
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      removeCommercialDirectorNavigation();
    };
  }, [profileRole, session]);

  useEffect(() => {
    if (profileRole === "COMMERCIAL" || session?.user?.id === GABRIEL_USER_ID || !session?.access_token) { setFridayAllowed(false); return; }
    const path = window.location.pathname;
    if (path !== "/sales-funnel" && path !== "/friday-report") return;
    let active = true;
    authenticatedFetch(FRIDAY_API, { cache: "no-store" })
      .then((response) => { if (active) setFridayAllowed(response.ok); })
      .catch(() => { if (active) setFridayAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token, session?.user?.id, profileRole]);

  useEffect(() => {
    if (!session || profileRole === "COMMERCIAL") return;
    if (session.user.id === GABRIEL_USER_ID) {
      removeCommercialNavigation();
      return;
    }
    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const path = window.location.pathname;
        removeLegacyShortcuts();
        if (path === "/") installDashboardTab();
        if (path === "/sales-funnel" || path === "/friday-report") installCommercialSubnav(path, fridayAllowed);
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
      removeCommercialNavigation();
    };
  }, [session, fridayAllowed, profileRole]);

  return null;
}
