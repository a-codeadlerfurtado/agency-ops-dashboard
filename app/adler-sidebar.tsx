"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { api, supabase } from "./shared";

const INTERNAL_LABELS: Record<string, string> = {
  overview: "Visão geral",
  focus: "Foco do dia",
  work: "Central de Trabalho",
  clients: "Clientes",
  creative: "Central Criativa",
  health: "Saúde",
  preclients: "Pré-clientes",
  conversations: "Conversas",
  team: "Equipe",
  diary: "Diário",
  clickup: "ClickUp",
  evidence: "Evidências",
  audit: "Auditoria",
  alerts: "Alertas",
  opsperf: "Desempenho OP",
  contracts: "Contratos",
};

type NavEntry = {
  key: string;
  label: string;
  view?: string;
  href?: string;
  badge?: number;
};

type NavGroup = {
  key: string;
  label: string;
  children: NavEntry[];
};

function normalized(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function activeViewFromOldNav() {
  const active = document.querySelector(".side-nav-items > button.active") as HTMLButtonElement | null;
  const label = normalized(active?.title || active?.textContent || "");
  return Object.entries(INTERNAL_LABELS).find(([, value]) => normalized(value) === label)?.[0] || "overview";
}

function clickOldView(view: string) {
  const label = INTERNAL_LABELS[view];
  if (!label) return;
  const buttons = Array.from(document.querySelectorAll(".side-nav-items > button")) as HTMLButtonElement[];
  const button = buttons.find((item) => normalized(item.title || item.textContent || "") === normalized(label));
  button?.click();
}

export default function AdlerSidebar() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [home, setHome] = useState<any>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [activeView, setActiveView] = useState("overview");
  const [contractsAvailable, setContractsAvailable] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ operation: true, clients: true, commercial: true, management: true });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) { setProfile(null); setHome(null); }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) return;
    let active = true;
    const load = () => api("home", session.access_token)
      .then((payload) => {
        if (!active) return;
        setProfile(payload?.profile || null);
        setHome(payload || null);
      })
      .catch(() => { if (active) setProfile(null); });
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session?.access_token]);

  const isAdler = profile?.person === "Adler Furtado" && String(profile?.role || "").toUpperCase() === "MGMT";

  useEffect(() => {
    if (!isAdler || window.location.pathname !== "/") {
      document.querySelector(".side-nav-items")?.classList.remove("adler-nav-active");
      setContainer(null);
      return;
    }
    let alive = true;
    const mount = () => {
      if (!alive) return;
      const node = document.querySelector(".side-nav-items") as HTMLElement | null;
      if (!node) return;
      node.classList.add("adler-nav-active");
      setContainer(node);
      setActiveView(activeViewFromOldNav());
      const buttons = Array.from(node.querySelectorAll(":scope > button")) as HTMLButtonElement[];
      setContractsAvailable(buttons.some((button) => normalized(button.title || button.textContent || "") === "contratos"));
    };
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const timer = window.setInterval(mount, 700);
    return () => {
      alive = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.querySelector(".side-nav-items")?.classList.remove("adler-nav-active");
    };
  }, [isAdler]);

  const allowed = useMemo(() => new Set<string>(Array.isArray(profile?.views) ? profile.views : []), [profile?.views]);
  const can = (view: string) => view === "contracts" ? contractsAvailable : !allowed.size || allowed.has(view);

  const groups = useMemo<NavGroup[]>(() => {
    const waiting = (home?.conversations || []).filter((row: any) => row.waiting_for_agency || row.conversation_status === "WAITING_AGENCY").length;
    const criticalHealth = (home?.clients || []).filter((row: any) => row.priority === "ATTENTION").length;
    const alerts = (home?.alerts || []).length;
    const preclients = (home?.preclients || []).length;
    return [
      {
        key: "operation",
        label: "Operação",
        children: [
          { key: "focus", label: "Hoje", view: "focus" },
          { key: "work", label: "Solicitações", view: "work" },
          { key: "alerts", label: "Incidentes", view: "alerts", badge: alerts },
        ].filter((item) => can(String(item.view))),
      },
      {
        key: "clients",
        label: "Clientes",
        children: [
          { key: "clients", label: "Carteira", view: "clients" },
          { key: "health", label: "Saúde", view: "health", badge: criticalHealth },
          { key: "conversations", label: "Conversas", view: "conversations", badge: waiting },
        ].filter((item) => can(String(item.view))),
      },
      {
        key: "commercial",
        label: "Comercial",
        children: [
          { key: "sales-funnel", label: "Funil", href: "/sales-funnel" },
          ...(can("preclients") ? [{ key: "preclients", label: "Pré-clientes", view: "preclients", badge: preclients }] : []),
          { key: "friday-report", label: "Relatório de sexta", href: "/friday-report" },
        ],
      },
      {
        key: "management",
        label: "Gestão",
        children: [
          ...(can("team") ? [{ key: "team", label: "Equipe", view: "team" }] : []),
          ...(can("opsperf") ? [{ key: "opsperf", label: "Desempenho OP", view: "opsperf" }] : []),
          ...(can("diary") ? [{ key: "diary", label: "Registros", view: "diary" }] : []),
        ],
      },
    ];
  }, [allowed, contractsAvailable, home]);

  useEffect(() => {
    const group = groups.find((item) => item.children.some((child) => child.view === activeView));
    if (group) setOpenGroups((current) => current[group.key] ? current : { ...current, [group.key]: true });
  }, [activeView, groups]);

  if (!isAdler || !container || window.location.pathname !== "/") return null;

  const go = (entry: NavEntry) => {
    if (entry.href) { window.location.assign(entry.href); return; }
    if (entry.view) {
      setActiveView(entry.view);
      clickOldView(entry.view);
    }
  };

  const single = (entry: NavEntry) => <button type="button" key={entry.key} className={`adler-nav-single ${entry.view === activeView ? "active" : ""}`} onClick={() => go(entry)}>
    <span>{entry.label}</span>{entry.badge ? <b className="adler-nav-badge">{entry.badge > 99 ? "99+" : entry.badge}</b> : null}
  </button>;

  return createPortal(<>
    <style>{`
      .side-nav-items.adler-nav-active > button,.side-nav-items.adler-nav-active > a,.side-nav-items.adler-nav-active > .ops-nav-group-label{display:none!important}
      .side-nav-items.adler-nav-active{gap:3px}
      .adler-nav{display:flex;flex-direction:column;gap:3px;width:100%;padding-bottom:16px}
      .adler-nav button{position:relative}
      .adler-nav-single,.adler-nav-parent,.adler-nav-child{width:100%;display:flex!important;align-items:center;justify-content:space-between;gap:8px}
      .adler-nav-parent{margin-top:5px;font-size:10px!important;letter-spacing:.08em;text-transform:uppercase;color:#71869e!important;background:transparent!important;border-color:transparent!important;font-weight:800!important}
      .adler-nav-parent:hover{color:#d7e4f2!important;background:rgba(255,255,255,.035)!important}
      .adler-nav-chevron{font-size:12px;transition:transform .16s ease}.adler-nav-chevron.open{transform:rotate(90deg)}
      .adler-nav-children{display:grid;gap:2px;padding:1px 0 4px 10px;border-left:1px solid rgba(93,146,205,.16);margin-left:10px}
      .adler-nav-child{font-size:11px!important;padding-left:13px!important;color:#8ea4ba!important}
      .adler-nav-child.active{color:#eef6ff!important;background:rgba(55,139,226,.12)!important;border-color:rgba(75,151,232,.2)!important}
      .adler-nav-single{margin-top:2px}
      .adler-nav-badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,91,105,.14);color:#ff8995;font-size:9px;font-weight:900}
      .sidebar-collapsed .adler-nav-parent,.sidebar-collapsed .adler-nav-child,.sidebar-collapsed .adler-nav-single{font-size:0!important;padding-left:8px!important;padding-right:8px!important;justify-content:center}
      .sidebar-collapsed .adler-nav-parent span:first-child::first-letter,.sidebar-collapsed .adler-nav-child span:first-child::first-letter,.sidebar-collapsed .adler-nav-single span:first-child::first-letter{font-size:11px}
      .sidebar-collapsed .adler-nav-children{padding-left:0;margin-left:0;border-left:0}
      .sidebar-collapsed .adler-nav-chevron,.sidebar-collapsed .adler-nav-badge{display:none}
    `}</style>
    <div className="adler-nav" aria-label="Navegação do perfil Adler">
      {single({ key: "overview", label: "Visão geral", view: "overview" })}
      {groups.map((group) => <div className="adler-nav-group" key={group.key}>
        <button type="button" className="adler-nav-parent" aria-expanded={Boolean(openGroups[group.key])} onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}>
          <span>{group.label}</span><span className={`adler-nav-chevron ${openGroups[group.key] ? "open" : ""}`}>›</span>
        </button>
        {openGroups[group.key] && <div className="adler-nav-children">{group.children.map((entry) => <button type="button" key={entry.key} className={`adler-nav-child ${entry.view === activeView ? "active" : ""}`} onClick={() => go(entry)}><span>{entry.label}</span>{entry.badge ? <b className="adler-nav-badge">{entry.badge > 99 ? "99+" : entry.badge}</b> : null}</button>)}</div>}
      </div>)}
      {can("creative") && single({ key: "creative", label: "Central Criativa", view: "creative" })}
      {single({ key: "onboarding", label: "Onboarding", href: "/onboarding" })}
      {single({ key: "campaigns", label: "Campanhas", href: "/campaigns" })}
      {can("clickup") && single({ key: "clickup", label: "ClickUp", view: "clickup" })}
      {can("evidence") && single({ key: "evidence", label: "Evidências", view: "evidence" })}
      {can("audit") && single({ key: "audit", label: "Auditoria", view: "audit" })}
      {contractsAvailable && single({ key: "contracts", label: contractsAvailable ? "Contratos" : "Contratos", view: "contracts" })}
      {single({ key: "ia", label: "IA", href: "/ia" })}
    </div>
  </>, container);
}
