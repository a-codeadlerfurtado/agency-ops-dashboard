"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const FRIDAY_API = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;
const DASHBOARD_API = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api?view=home`;
const LEONARDO_EMAIL = "lakassessoriadigital@gmail.com";

const LEONARDO_PANELS = [
  { key: "direction", label: "Direção Comercial", src: "/commercial-direction?embedded=1" },
  { key: "agenda", label: "Agenda", src: "/agenda?embedded=1" },
  { key: "clients", label: "Clientes", src: "/commercial-clients?embedded=1" },
] as const;

type LeonardoPanel = typeof LEONARDO_PANELS[number]["key"];

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
    .leonardo-exec-shortcut{border:1px solid rgba(112,221,183,.22)!important;background:rgba(16,45,36,.7)!important;color:#a9d9c8!important;border-radius:9px!important;padding:8px 11px!important;font-size:11px!important;font-weight:750!important;cursor:pointer!important}
    .leonardo-exec-shortcut:hover{background:rgba(31,92,68,.7)!important;color:#effff8!important}
    .side-nav-items [data-leonardo-panel]{width:100%;text-align:left}
    .side-nav-items [data-leonardo-panel].active{border-color:rgba(103,215,161,.28)!important;background:rgba(44,145,98,.14)!important;color:#dff8ea!important}
    .leonardo-single-screen{position:fixed;left:var(--sidenav-width,224px);right:0;top:72px;bottom:0;z-index:34;background:#07100d;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid rgba(112,160,140,.11)}
    .leonardo-single-screen-head{height:48px;flex:0 0 48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 18px;border-bottom:1px solid rgba(116,178,151,.13);background:rgba(7,16,13,.96);backdrop-filter:blur(12px)}
    .leonardo-single-screen-head div{display:flex;align-items:baseline;gap:8px}.leonardo-single-screen-head b{font-size:11px;color:#dcebe4}.leonardo-single-screen-head span{font-size:9px;color:#6f8b7e}.leonardo-single-screen-head small{font-size:9px;color:#668176}
    .leonardo-single-screen-frame-wrap{position:relative;flex:1;min-height:0;background:#07100d}
    .leonardo-single-screen-frame{display:block;width:100%;height:100%;border:0;background:#07100d}
    .leonardo-single-screen-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#07100d;color:#729284;font-size:10px;letter-spacing:.04em;z-index:2;transition:opacity .18s ease}
    .leonardo-single-screen-loading.done{opacity:0;pointer-events:none}
    @media(max-width:760px){.commercial-section-nav{margin:-6px 12px 14px;overflow:auto}.commercial-section-nav .commercial-section-label{display:none}.commercial-section-nav button{white-space:nowrap}.leonardo-exec-shortcut{display:none!important}.leonardo-single-screen{left:var(--sidenav-width,58px);top:68px}.leonardo-single-screen-head{padding:0 10px}.leonardo-single-screen-head span,.leonardo-single-screen-head small{display:none}}
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

function restoreLeonardoSidebar() {
  document.querySelectorAll<HTMLElement>("[data-leonardo-hidden]").forEach((node) => {
    node.style.display = node.dataset.leonardoOriginalDisplay === "__EMPTY__" ? "" : (node.dataset.leonardoOriginalDisplay || "");
    delete node.dataset.leonardoHidden;
    delete node.dataset.leonardoOriginalDisplay;
  });
  document.querySelectorAll("[data-leonardo-panel]").forEach((node) => node.remove());
}

function panelSource(key: LeonardoPanel) {
  return LEONARDO_PANELS.find((item) => item.key === key)?.src || LEONARDO_PANELS[0].src;
}

function setLeonardoPanel(key: LeonardoPanel) {
  const workspace = document.querySelector<HTMLElement>("[data-leonardo-single-screen]");
  const iframe = workspace?.querySelector<HTMLIFrameElement>("iframe[data-leonardo-frame]");
  const loader = workspace?.querySelector<HTMLElement>("[data-leonardo-loader]");
  if (!workspace || !iframe) return;

  workspace.dataset.activePanel = key;
  try { window.sessionStorage.setItem("leonardo-executive-panel", key); } catch { /* ignore */ }

  document.querySelectorAll<HTMLButtonElement>("[data-leonardo-panel]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leonardoPanel === key);
  });

  const target = panelSource(key);
  if (iframe.dataset.panel === key && iframe.getAttribute("src") === target) return;
  iframe.dataset.panel = key;
  loader?.classList.remove("done");
  iframe.src = target;
}

function customizeEmbeddedFrame(iframe: HTMLIFrameElement) {
  try {
    const frameWindow = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!frameWindow || !doc) return;

    let style = doc.getElementById("leonardo-embedded-style") as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement("style");
      style.id = "leonardo-embedded-style";
      style.textContent = `
        .cd-top,.agenda-top,header.top,.source-banner{display:none!important}
        .cd-shell{min-height:100vh!important;padding-top:0!important}
        .agenda-shell{min-height:100vh!important;padding-top:1px!important}
        main.shell{min-height:100vh!important;padding-left:0!important}
        .cd-hero,.agenda-hero{margin-top:22px!important}
        body{overflow:auto!important}
      `;
      doc.head.appendChild(style);
    }

    const panel = iframe.dataset.panel as LeonardoPanel;
    const capture = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor) {
        try {
          const url = new URL(anchor.href, frameWindow.location.origin);
          const mapped: Record<string, LeonardoPanel> = {
            "/": "direction",
            "/commercial-direction": "direction",
            "/agenda": "agenda",
            "/commercial-clients": "clients",
          };
          const next = mapped[url.pathname];
          if (next) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.postMessage({ type: "leonardo-panel", panel: next }, window.location.origin);
            return;
          }
        } catch { /* external link */ }
      }

      if (panel === "clients" && target.closest("tbody tr")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    if (!(doc as any).__leonardoCaptureInstalled) {
      (doc as any).__leonardoCaptureInstalled = true;
      doc.addEventListener("click", capture, true);
    }
  } catch { /* same-origin customization is progressive enhancement */ }
}

function ensureLeonardoWorkspace() {
  if (window.location.pathname !== "/") return;
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container) return;

  const template = Array.from(container.children).find((node) => node instanceof HTMLButtonElement) as HTMLButtonElement | undefined;
  Array.from(container.children).forEach((raw) => {
    const node = raw as HTMLElement;
    if (node.dataset.leonardoPanel) return;
    if (node.dataset.leonardoHidden !== "true") {
      node.dataset.leonardoHidden = "true";
      node.dataset.leonardoOriginalDisplay = node.style.display || "__EMPTY__";
    }
    node.style.display = "none";
  });

  for (const panel of LEONARDO_PANELS) {
    if (container.querySelector(`[data-leonardo-panel="${panel.key}"]`)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.leonardoPanel = panel.key;
    button.title = panel.label;
    button.textContent = panel.label;
    if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
    button.addEventListener("click", () => setLeonardoPanel(panel.key));
    container.appendChild(button);
  }

  let workspace = document.querySelector<HTMLElement>("[data-leonardo-single-screen]");
  if (!workspace) {
    workspace = document.createElement("section");
    workspace.className = "leonardo-single-screen";
    workspace.dataset.leonardoSingleScreen = "true";
    workspace.innerHTML = `
      <div class="leonardo-single-screen-head">
        <div><b>Perfil Leonardo</b><span>tudo na mesma tela</span></div>
        <small data-leonardo-current>Direção Comercial</small>
      </div>
      <div class="leonardo-single-screen-frame-wrap">
        <div class="leonardo-single-screen-loading" data-leonardo-loader>Carregando visão executiva…</div>
        <iframe class="leonardo-single-screen-frame" data-leonardo-frame title="Painel executivo do Leonardo"></iframe>
      </div>`;
    document.body.appendChild(workspace);

    const iframe = workspace.querySelector<HTMLIFrameElement>("iframe[data-leonardo-frame]")!;
    iframe.addEventListener("load", () => {
      customizeEmbeddedFrame(iframe);
      workspace?.querySelector<HTMLElement>("[data-leonardo-loader]")?.classList.add("done");
      const active = iframe.dataset.panel as LeonardoPanel;
      const label = LEONARDO_PANELS.find((item) => item.key === active)?.label || "Direção Comercial";
      const current = workspace?.querySelector<HTMLElement>("[data-leonardo-current]");
      if (current) current.textContent = label;
    });
  }

  let saved: LeonardoPanel = "direction";
  try {
    const raw = window.sessionStorage.getItem("leonardo-executive-panel");
    if (raw && LEONARDO_PANELS.some((item) => item.key === raw)) saved = raw as LeonardoPanel;
  } catch { /* ignore */ }
  setLeonardoPanel(saved);
}

function installLeonardoExecutiveShortcuts() {
  if (window.location.pathname !== "/commercial-direction") return;
  const header = document.querySelector<HTMLElement>(".cd-top");
  const mainTabs = document.querySelector<HTMLElement>(".cd-main-tabs");
  const cockpit = mainTabs ? Array.from(mainTabs.querySelectorAll<HTMLButtonElement>("button")).find((button) => normalize(button.textContent || "") === "cockpit") : null;
  if (cockpit) cockpit.textContent = "Visão Geral";

  if (window.self !== window.top) {
    if (header) header.style.display = "none";
    return;
  }

  if (!header) return;
  header.querySelectorAll('[data-leonardo-exec-shortcut="revenue"],[data-leonardo-exec-shortcut="contracts"],[data-leonardo-exec-shortcut="agenda"]').forEach((node) => node.remove());
  const first = header.querySelector<HTMLButtonElement>("button");
  if (first && first.dataset.leonardoHomeFixed !== "true") {
    first.dataset.leonardoHomeFixed = "true";
    first.textContent = "Dashboard";
    first.onclick = () => window.location.assign("/");
  }
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
    const email = String(session?.user?.email || "").toLowerCase();
    if (email !== LEONARDO_EMAIL) return;
    if (["/client-revenue", "/contracts"].includes(window.location.pathname)) window.location.replace("/");
  }, [session?.user?.email]);

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
    const leonardo = String(session?.user?.email || "").toLowerCase() === LEONARDO_EMAIL;
    if (profileRole !== "COMMERCIAL" || leonardo) return;
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
  }, [profileRole, session?.user?.email]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "leonardo-panel") return;
      const panel = String(event.data?.panel || "") as LeonardoPanel;
      if (LEONARDO_PANELS.some((item) => item.key === panel)) setLeonardoPanel(panel);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
    const leonardo = String(session.user.email || "").toLowerCase() === LEONARDO_EMAIL;
    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const path = window.location.pathname;
        removeLegacyShortcuts();
        if (leonardo && path === "/") ensureLeonardoWorkspace();
        else if (path === "/") installDashboardTab(profileRole);
        if (path === "/sales-funnel" || path === "/friday-report") installCommercialSubnav(path, fridayAllowed);
        if (leonardo) installLeonardoExecutiveShortcuts();
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
      document.querySelectorAll("[data-commercial-funnel-nav],[data-commercial-section-nav],[data-leonardo-exec-shortcut]").forEach((node) => node.remove());
      document.querySelector("[data-leonardo-single-screen]")?.remove();
      restoreLeonardoSidebar();
      document.documentElement.style.visibility = "";
    };
  }, [session, fridayAllowed, profileRole]);

  return null;
}
