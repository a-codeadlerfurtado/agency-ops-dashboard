"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const FRIDAY_API = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;
const DASHBOARD_API = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api?view=home`;

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

function installDashboardTab(role: string | null) {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;

  const isCommercial = role === "COMMERCIAL";
  const label = isCommercial ? "Direção Comercial" : "Funil comercial";
  const href = isCommercial ? "/commercial-direction" : "/sales-funnel";
  const existing = container.querySelector<HTMLButtonElement>("[data-commercial-funnel-nav]");
  if (existing) {
    if (existing.dataset.commercialMode === (isCommercial ? "direction" : "funnel")) return;
    existing.remove();
  }

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const campaigns = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("campanhas"));
  const onboarding = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("onboarding"));
  const template = campaigns || onboarding || buttons[0];

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.commercialFunnelNav = "true";
  button.dataset.commercialMode = isCommercial ? "direction" : "funnel";
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
  const [profilePerson, setProfilePerson] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { ensureStyles(); removeLegacyShortcuts(); }, []);

  useEffect(() => {
    if (!session?.access_token) { setProfileRole(null); setProfilePerson(null); return; }
    let active = true;
    authenticatedFetch(DASHBOARD_API, { cache: "no-store" })
      .then(async (response) => {
        if (!active || !response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (active) {
          setProfileRole(String(body?.profile?.role || "") || null);
          setProfilePerson(String(body?.profile?.person || body?.preferences?.name || "") || null);
        }
      })
      .catch(() => { if (active) { setProfileRole(null); setProfilePerson(null); } });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    const isLeonardo = profileRole === "COMMERCIAL" && normalize(profilePerson || "") === "leonardo augusto";
    if (!isLeonardo) return;
    if (window.location.pathname === "/") window.location.replace("/commercial-direction");
  }, [profileRole, profilePerson]);

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
      document.querySelectorAll("[data-commercial-funnel-nav],[data-commercial-section-nav]").forEach((node) => node.remove());
    };
  }, [session, fridayAllowed, profileRole]);

  return null;
}
