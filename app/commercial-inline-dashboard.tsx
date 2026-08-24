"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

type Row = Record<string, any>;
type Mode = "home" | "funnel" | "direction";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

const stageLabel: Record<string, string> = {
  novo: "Novo",
  qualificacao: "Qualificação",
  reuniao: "Reunião",
  proposta: "Proposta",
  negociacao: "Negociação",
  fechado: "Fechado",
  perdido: "Perdido",
};

function money(value: unknown) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(value: unknown) { return Number(value || 0).toLocaleString("pt-BR"); }
function text(value: unknown, fallback = "—") { const rendered = String(value ?? "").trim(); return rendered || fallback; }
function date(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="ci-kpi"><span>{label}</span><b>{value}</b><small>{hint}</small></article>;
}

function CommercialPanel({ payload, mode, loading, reload }: { payload: Row; mode: Mode; loading: boolean; reload: () => void }) {
  const summary = payload.summary || {};
  const leads: Row[] = payload.leads || [];
  const performance: Row[] = payload.performance || [];
  const stages: Row[] = payload.stage_summary || [];
  const advanced = useMemo(() => leads.filter((row) => ["reuniao", "proposta", "negociacao"].includes(String(row.stage || "").toLowerCase())).slice(0, 8), [leads]);

  return <section className="commercial-inline-panel">
    <style>{styles}</style>
    <div className="ci-head">
      <div><span>DIREÇÃO COMERCIAL</span><h2>{mode === "funnel" ? "Funil Comercial" : mode === "direction" ? "Direção Comercial" : "Home Comercial"}</h2><p>Vendas, campanhas, oportunidades e carteira. Sem blocos operacionais.</p></div>
      <div><small>Atualizado {date(payload.generated_at)}</small><button onClick={reload} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></div>
    </div>

    {mode === "home" && <>
      <div className="ci-kpis">
        <Kpi label="Leads abertos" value={num(summary.open_leads)} hint={`${num(summary.new_7d)} novos em 7 dias`} />
        <Kpi label="Oportunidades avançadas" value={num(summary.advanced_opportunities)} hint="reunião, proposta ou negociação" />
        <Kpi label="Reuniões · 7 dias" value={num(summary.meetings_7d)} hint="agenda comercial" />
        <Kpi label="Forecast ponderado" value={money(summary.weighted_forecast_value)} hint="pipeline comercial" />
        <Kpi label="Clientes ativos" value={num(summary.active_clients)} hint="carteira atual" />
        <Kpi label="Campanhas ativas" value={num(summary.active_campaigns)} hint="mídia no ar" />
      </div>
      <div className="ci-grid">
        <article className="ci-card"><div className="ci-card-head"><span>TIME COMERCIAL</span><h3>Resultado por responsável</h3></div>{performance.map((row) => <div className="ci-owner" key={row.owner_id || row.owner_name}><div><b>{text(row.owner_name)}</b><small>{num(row.open_leads)} abertos · {num(row.meetings)} reuniões · {num(row.proposals)} propostas</small></div><strong>{money(row.weighted_value)}</strong></div>)}{!performance.length && <div className="ci-empty">Sem dados de responsáveis agora.</div>}</article>
        <article className="ci-card"><div className="ci-card-head"><span>PIPELINE</span><h3>Distribuição por etapa</h3></div>{stages.map((row) => <div className="ci-stage" key={row.stage}><span>{stageLabel[String(row.stage || "").toLowerCase()] || text(row.stage)}</span><div><b>{num(row.count)} oportunidades</b><small>{money(row.weighted_value)} ponderado</small></div></div>)}{!stages.length && <div className="ci-empty">Sem pipeline disponível agora.</div>}</article>
      </div>
    </>}

    {mode === "funnel" && <article className="ci-card ci-wide"><div className="ci-card-head"><span>PIPELINE DE VENDAS</span><h3>Oportunidades comerciais</h3></div><div className="ci-table"><table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Atualização</th><th>Valor</th></tr></thead><tbody>{leads.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b><small>{row.company ? text(row.name) : ""}</small></td><td>{text(row.owner_name)}</td><td><span className="ci-pill">{stageLabel[String(row.stage || "").toLowerCase()] || text(row.stage)}</span></td><td>{text(row.source)}</td><td>{date(row.updated_at)}</td><td>{row.estimated_value ? money(row.estimated_value) : "não informado"}</td></tr>)}</tbody></table></div>{!leads.length && <div className="ci-empty">Nenhuma oportunidade no funil.</div>}</article>}

    {mode === "direction" && <div className="ci-grid direction">
      <article className="ci-card"><div className="ci-card-head"><span>GESTÃO COMERCIAL</span><h3>Performance do time</h3></div>{performance.map((row) => <div className="ci-owner" key={row.owner_id || row.owner_name}><div><b>{text(row.owner_name)}</b><small>{num(row.open_leads)} abertos · {num(row.meetings)} reuniões · {num(row.proposals)} propostas · {num(row.negotiations)} negociações</small></div><strong>{money(row.weighted_value)}</strong></div>)}{!performance.length && <div className="ci-empty">Sem dados de performance agora.</div>}</article>
      <article className="ci-card"><div className="ci-card-head"><span>PRIORIDADES DE VENDA</span><h3>Oportunidades avançadas</h3></div>{advanced.map((row) => <div className="ci-owner" key={row.id}><div><b>{text(row.company || row.name)}</b><small>{text(row.owner_name)} · {stageLabel[String(row.stage || "").toLowerCase()] || text(row.stage)}</small></div><strong>{row.estimated_value ? money(row.estimated_value) : "—"}</strong></div>)}{!advanced.length && <div className="ci-empty">Nenhuma oportunidade avançada agora.</div>}</article>
    </div>}
  </section>;
}

export default function CommercialInlineDashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [payload, setPayload] = useState<Row>({});
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("home");
  const [overviewActive, setOverviewActive] = useState(false);
  const handledQuery = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setRole(null); return; }
    let active = true;
    loadProfileLite().then((body) => { if (active) setRole(String(body?.profile?.role || "").toUpperCase()); }).catch(() => { if (active) setRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  const load = useCallback(async () => {
    if (!session?.access_token || role !== "COMMERCIAL") return;
    setLoading(true);
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setPayload(body || {});
    } finally { setLoading(false); }
  }, [session?.access_token, role]);

  useEffect(() => {
    if (role !== "COMMERCIAL") return;
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [role, load]);

  useEffect(() => {
    if (role !== "COMMERCIAL" || window.location.pathname !== "/") {
      document.documentElement.classList.remove("commercial-overview-active");
      setOverviewActive(false);
      setSlot(null);
      return;
    }

    let active = true;
    let frame = 0;
    const cleanupNodes = () => document.querySelectorAll("[data-commercial-inline-item]").forEach((node) => node.remove());
    const nativeButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".side-nav-items button"))
      .find((button) => !button.dataset.commercialInlineItem && normalize(button.title || button.textContent || "").startsWith(normalize(label)));

    const ensureHome = () => {
      const home = nativeButton("visão geral") || document.querySelector<HTMLButtonElement>("[data-commercial-native-home]");
      home?.click();
    };

    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!active) return;
        const shell = document.querySelector<HTMLElement>("main.shell");
        const nav = document.querySelector<HTMLElement>(".side-nav-items");
        if (!shell || !nav) return;

        const topTitle = document.querySelector<HTMLElement>(".top .brand h1");
        const topSubtitle = document.querySelector<HTMLElement>(".top .brand .subtitle");
        if (topTitle && topTitle.textContent !== "Central Comercial") topTitle.textContent = "Central Comercial";
        if (topSubtitle && topSubtitle.textContent !== "Vendas, campanhas, clientes e oportunidades em um só lugar") topSubtitle.textContent = "Vendas, campanhas, clientes e oportunidades em um só lugar";

        const home = nativeButton("visão geral") || document.querySelector<HTMLButtonElement>("[data-commercial-native-home]");
        if (home) {
          home.dataset.commercialNativeHome = "true";
          home.title = "Home Comercial";
          if (home.textContent?.trim() !== "Home Comercial") home.textContent = "Home Comercial";
        }
        const clients = nativeButton("clientes");
        const campaigns = nativeButton("campanhas");
        const preclients = nativeButton("pré-clientes") || nativeButton("pre-clientes") || nativeButton("pre clientes");
        const template = home || clients || campaigns || preclients || nav.querySelector<HTMLButtonElement>("button");

        const add = (key: string, label: string, action: () => void, before?: Element | null) => {
          if (nav.querySelector(`[data-commercial-inline-item="${key}"]`)) return;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.commercialInlineItem = key;
          button.title = label;
          button.textContent = label;
          if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
          button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); action(); });
          if (before) nav.insertBefore(button, before); else nav.appendChild(button);
        };

        add("funnel", "Funil Comercial", () => { setMode("funnel"); ensureHome(); }, campaigns || clients?.nextElementSibling || null);
        add("portfolio", "Carteira Comercial", () => clients?.click(), preclients?.nextElementSibling || null);
        add("direction", "Direção Comercial", () => { setMode("direction"); ensureHome(); });

        const activeButton = nav.querySelector<HTMLButtonElement>("button.active:not([data-commercial-inline-item])");
        const activeLabel = normalize(activeButton?.title || activeButton?.textContent || "");
        const homeActive = activeButton?.dataset.commercialNativeHome === "true" || activeLabel === "home comercial" || activeLabel === "visao geral";
        document.documentElement.classList.toggle("commercial-overview-active", Boolean(homeActive));
        setOverviewActive(Boolean(homeActive));

        nav.querySelectorAll<HTMLButtonElement>("[data-commercial-inline-item]").forEach((button) => button.classList.remove("active"));
        if (homeActive && mode !== "home") nav.querySelector<HTMLButtonElement>(`[data-commercial-inline-item="${mode}"]`)?.classList.add("active");

        let target = document.getElementById("commercial-inline-home-slot") as HTMLElement | null;
        if (!target) {
          target = document.createElement("div");
          target.id = "commercial-inline-home-slot";
          const sideNav = shell.querySelector(":scope > .side-nav");
          if (sideNav?.nextSibling) shell.insertBefore(target, sideNav.nextSibling); else shell.appendChild(target);
        }
        setSlot(target);

        if (!handledQuery.current) {
          handledQuery.current = true;
          const params = new URLSearchParams(window.location.search);
          const requestedView = normalize(params.get("commercial_view") || "");
          const requestedMode = normalize(params.get("commercial_mode") || "");
          if (requestedMode === "funnel" || requestedMode === "direction") {
            setMode(requestedMode as Mode); ensureHome();
          } else if (requestedView === "clients") clients?.click();
          else if (requestedView === "campaigns") campaigns?.click();
          else if (requestedView === "preclients") preclients?.click();
          if (requestedView || requestedMode) window.history.replaceState({}, "", "/");
        }
      });
    };

    const click = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".side-nav-items button") : null;
      if (!button || button.dataset.commercialInlineItem) return;
      const label = normalize(button.title || button.textContent || "");
      if (label === "home comercial" || label === "visao geral") setMode("home");
      window.setTimeout(apply, 0);
    };

    apply();
    document.addEventListener("click", click, true);
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 1000);
    return () => {
      active = false;
      document.removeEventListener("click", click, true);
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      cleanupNodes();
      document.getElementById("commercial-inline-home-slot")?.remove();
      document.documentElement.classList.remove("commercial-overview-active");
      setOverviewActive(false);
    };
  }, [role, mode]);

  if (role !== "COMMERCIAL" || !slot || !overviewActive) return null;
  return createPortal(<CommercialPanel payload={payload} mode={mode} loading={loading} reload={load} />, slot);
}

const styles = `
html.commercial-profile .source-banner{display:none!important}
html.commercial-profile.commercial-overview-active .shell > .grid.kpis,
html.commercial-profile.commercial-overview-active .shell > .grid.kpis ~ section,
html.commercial-profile.commercial-overview-active .shell > .grid.kpis ~ .grid.split{display:none!important}
html.commercial-profile.commercial-overview-active #commercial-inline-home-slot{display:block!important}
#commercial-inline-home-slot{margin:0 0 22px}
.commercial-inline-panel{display:grid;gap:16px;color:#edf5f2}
.ci-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:22px 24px;border:1px solid #293b38;border-radius:18px;background:linear-gradient(135deg,rgba(18,38,34,.96),rgba(13,20,23,.96))}
.ci-head>div:first-child span,.ci-card-head span{display:block;color:#68d5a4;font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.ci-head h2{font-family:'Inter Tight',Inter,sans-serif;font-size:34px;letter-spacing:-.035em;margin:5px 0 4px}.ci-head p{margin:0;color:#91a6a0}.ci-head>div:last-child{display:flex;align-items:center;gap:10px}.ci-head small{color:#728681}.ci-head button{border:1px solid #35534a;background:#152823;color:#dff8ea;border-radius:10px;padding:9px 12px;font-weight:750;cursor:pointer}
.ci-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.ci-kpi{border:1px solid #293b38;border-radius:15px;background:#10191c;padding:16px;min-width:0}.ci-kpi span,.ci-kpi small{display:block;color:#7f948e}.ci-kpi span{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.ci-kpi b{display:block;font-family:'Inter Tight',Inter,sans-serif;font-size:24px;margin:7px 0 4px;color:#f4fbf8}.ci-kpi small{font-size:10px;line-height:1.35}
.ci-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ci-card{border:1px solid #293b38;border-radius:17px;background:#10191c;padding:18px;min-width:0}.ci-card-head{margin-bottom:10px}.ci-card-head h3{margin:4px 0 0;font-family:'Inter Tight',Inter,sans-serif;font-size:20px}.ci-owner,.ci-stage{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:11px 0;border-top:1px solid #20302d}.ci-owner b,.ci-owner small,.ci-stage b,.ci-stage small{display:block}.ci-owner small,.ci-stage small{color:#82958f;margin-top:3px;font-size:10.5px}.ci-owner strong{font-size:12px;color:#bfe9d4;white-space:nowrap}.ci-stage>span,.ci-pill{border:1px solid #35534a;background:#152823;color:#bfe9d4;border-radius:999px;padding:5px 8px;font-size:10px;font-weight:750;white-space:nowrap}.ci-stage>div{flex:1}.ci-empty{padding:18px 0;color:#748982}.ci-wide{width:100%}.ci-table{overflow:auto}.ci-table table{width:100%;border-collapse:collapse}.ci-table th,.ci-table td{text-align:left;padding:11px 9px;border-top:1px solid #20302d;vertical-align:top;font-size:11px}.ci-table th{color:#70847e;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.ci-table td b,.ci-table td small{display:block}.ci-table td small{color:#748982;margin-top:3px}.ci-grid.direction{grid-template-columns:1.2fr .8fr}
@media(max-width:1200px){.ci-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:800px){.ci-head{align-items:flex-start;flex-direction:column}.ci-kpis{grid-template-columns:1fr 1fr}.ci-grid,.ci-grid.direction{grid-template-columns:1fr}.ci-head h2{font-size:28px}}
`;
