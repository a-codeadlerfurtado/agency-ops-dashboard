"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, supabase } from "../shared";
import "./commercial-direction.css";

type Row = Record<string, any>;
type Tab = "overview" | "campaigns" | "funnel" | "portfolio";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const tabs: [Tab, string][] = [
  ["overview", "Visão Geral"],
  ["campaigns", "Campanhas"],
  ["funnel", "Funil Comercial"],
  ["portfolio", "Carteira"],
];
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
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}
function num(value: unknown) { return Number(value || 0).toLocaleString("pt-BR"); }
function pct(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—";
}
function date(value: unknown, withTime = false) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(parsed);
}
function text(value: unknown, fallback = "—") {
  const rendered = String(value ?? "").trim();
  return rendered || fallback;
}
function stageTone(stage: string) {
  const normalized = String(stage || "").toLowerCase();
  if (normalized === "negociacao" || normalized === "fechado") return "good";
  if (normalized === "proposta" || normalized === "reuniao") return "warm";
  if (normalized === "perdido") return "bad";
  return "muted";
}
function initialTab(): Tab {
  if (typeof window === "undefined") return "overview";
  const requested = new URLSearchParams(window.location.search).get("tab") as Tab | null;
  return tabs.some(([key]) => key === requested) ? requested! : "overview";
}

function Kpi({ label, value, hint, tone = "neutral" }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return <article className={`cd-kpi ${tone}`}><span>{label}</span><b>{value}</b>{hint && <small>{hint}</small>}</article>;
}
function Empty({ children }: { children?: React.ReactNode }) { return <div className="cd-empty">{children}</div>; }
function StagePill({ value }: { value: string }) {
  return <span className={`cd-pill ${stageTone(value)}`}>{stageLabel[String(value || "").toLowerCase()] || text(value)}</span>;
}

export default function CommercialDirectionPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [payload, setPayload] = useState<Row>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("ALL");
  const [lifecycle, setLifecycle] = useState("ACTIVE");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setAuthReady(true); });
    return () => subscription.unsubscribe();
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body || {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar o painel comercial.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authReady) return;
    if (!session) { window.location.assign("/"); return; }
    load();
  }, [authReady, session?.access_token]);

  function activate(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }

  const leads: Row[] = payload.leads || [];
  const owners = useMemo(() => [...new Set(leads.map((row) => String(row.owner_name || "")).filter(Boolean))], [leads]);
  const filteredLeads = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return leads.filter((row) => (
      (owner === "ALL" || row.owner_name === owner)
      && (!normalized || `${row.name || ""} ${row.company || ""} ${row.source || ""}`.toLocaleLowerCase("pt-BR").includes(normalized))
    ));
  }, [leads, owner, query]);
  const portfolio: Row[] = payload.portfolio_clients || [];
  const filteredPortfolio = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return portfolio.filter((row) => (
      (lifecycle === "ALL" || (lifecycle === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle)) : String(row.lifecycle) === lifecycle))
      && (!normalized || `${row.display_name || ""} ${row.service || ""} ${row.cs_owner || ""} ${row.gt_owner || ""}`.toLocaleLowerCase("pt-BR").includes(normalized))
    ));
  }, [portfolio, lifecycle, query]);
  const summary = payload.summary || {};

  if (!authReady || !session) return <main className="cd-loading">Carregando…</main>;
  return <main className="cd-shell">
    <header className="cd-top">
      <div className="cd-brand"><BrandMark /><span><small>Leonardo Imobi</small><b>Home Comercial</b></span></div>
      <div className="cd-profile"><b>{text(payload.profile?.person, "Direção Comercial")}</b><small>{text(payload.profile?.display_role, "Comercial")} · somente leitura</small></div>
    </header>

    <section className="cd-hero">
      <div><span>HOME · COMERCIAL</span><h1>Visão geral de vendas, campanhas e carteira. <em>Sem operação.</em></h1><p>Um painel focado em aquisição, pipeline e clientes. Conversas, clientes sem resposta, alertas de problema e controles operacionais não fazem parte deste perfil.</p></div>
      <div className="cd-refresh"><small>Atualizado {date(payload.generated_at, true)}</small><button onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></div>
    </section>

    <nav className="cd-tabs" aria-label="Áreas do painel comercial">
      {tabs.map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => activate(key)}>{label}</button>)}
    </nav>
    {error && <div className="cd-error">{error}</div>}

    {tab === "overview" && <>
      <section className="cd-kpis">
        <Kpi label="Leads abertos" value={num(summary.open_leads)} hint={`${num(summary.new_7d)} novos em 7 dias`} />
        <Kpi label="Oportunidades avançadas" value={num(summary.advanced_opportunities)} hint="reunião, proposta ou negociação" tone="good" />
        <Kpi label="Reuniões · 7 dias" value={num(summary.meetings_7d)} hint="agenda comercial" />
        <Kpi label="Forecast ponderado" value={money(summary.weighted_forecast_value)} hint="pipeline comercial" />
        <Kpi label="Clientes ativos" value={num(summary.active_clients)} hint="carteira atual" />
        <Kpi label="Campanhas ativas" value={num(summary.active_campaigns)} hint="clientes com mídia no ar" tone="good" />
      </section>
      <section className="cd-grid two">
        <article className="cd-card">
          <div className="cd-card-head"><div><span>TIME COMERCIAL</span><h2>Resultado por responsável</h2></div></div>
          {(payload.performance || []).map((row: Row) => <div className="cd-owner" key={row.owner_id}><div><b>{row.owner_name}</b><small>{num(row.open_leads)} abertos · {num(row.meetings)} reuniões · {num(row.proposals)} propostas · {num(row.negotiations)} negociações</small></div><div><b>{money(row.weighted_value)}</b><small>forecast ponderado</small></div></div>)}
        </article>
        <article className="cd-card">
          <div className="cd-card-head"><div><span>PIPELINE</span><h2>Distribuição por etapa</h2></div></div>
          {(payload.stage_summary || []).map((row: Row) => <div className="cd-stage-row" key={row.stage}><StagePill value={row.stage} /><div><b>{num(row.count)} oportunidades</b><small>{money(row.informed_value)} informado · {money(row.weighted_value)} ponderado</small></div></div>)}
        </article>
      </section>
    </>}

    {tab === "campaigns" && <section className="cd-card">
      <div className="cd-card-head"><div><span>CAMPANHAS</span><h2>Visão comercial da mídia ativa</h2></div><b>{num((payload.campaigns || []).length)}</b></div>
      <div className="cd-table"><table><thead><tr><th>Cliente</th><th>GT</th><th>Campanhas ativas</th><th>Investimento</th><th>Leads</th><th>CPL</th><th>CTR</th><th>Atualização</th></tr></thead><tbody>
        {(payload.campaigns || []).map((row: Row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{text(row.gt_owner)}</td><td><span className="cd-pill good">{num(row.active_campaigns)} ativas</span></td><td>{money(row.spend)}</td><td>{num(row.leads)}</td><td>{row.cost_per_result == null ? "—" : money(row.cost_per_result)}</td><td>{row.ctr == null ? "—" : pct(row.ctr)}</td><td>{date(row.latest_date)}</td></tr>)}
      </tbody></table></div>
      {!(payload.campaigns || []).length && <Empty>Nenhuma campanha ativa no snapshot atual.</Empty>}
    </section>}

    {tab === "funnel" && <section className="cd-card">
      <div className="cd-card-head"><div><span>FUNIL COMERCIAL</span><h2>Pipeline de vendas</h2></div><b>{filteredLeads.length}</b></div>
      <div className="cd-filters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar lead, empresa ou origem…" /><select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="ALL">Todos os responsáveis</option>{owners.map((name) => <option key={name}>{name}</option>)}</select></div>
      <div className="cd-table"><table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Entrada</th><th>Atualização</th><th>Valor</th></tr></thead><tbody>
        {filteredLeads.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b><small>{row.company ? text(row.name) : ""}</small></td><td>{text(row.owner_name)}</td><td><StagePill value={row.stage} /></td><td>{text(row.source)}</td><td>{date(row.created_at)}</td><td>{date(row.updated_at, true)}</td><td>{row.estimated_value ? money(row.estimated_value) : "não informado"}</td></tr>)}
      </tbody></table></div>
      {!filteredLeads.length && <Empty>Nenhuma oportunidade encontrada neste filtro.</Empty>}
    </section>}

    {tab === "portfolio" && <section className="cd-card">
      <div className="cd-card-head"><div><span>CARTEIRA</span><h2>Clientes e responsáveis</h2></div><b>{filteredPortfolio.length}</b></div>
      <div className="cd-filters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, serviço, CS ou GT…" /><select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}><option value="ACTIVE">Ativos e onboarding</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select></div>
      <div className="cd-table"><table><thead><tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Desde</th><th>Tempo conosco</th><th>CS</th><th>GT</th></tr></thead><tbody>
        {filteredPortfolio.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td><span className={`cd-pill ${row.lifecycle === "ACTIVE" ? "good" : row.lifecycle === "ONBOARDING" ? "warm" : "muted"}`}>{text(row.lifecycle)}</span></td><td>{text(row.service, "Não informado")}</td><td>{date(row.entrada)}</td><td>{row.client_days == null ? "—" : `${num(row.client_days)} dias`}</td><td>{text(row.cs_owner)}</td><td>{text(row.gt_owner)}</td></tr>)}
      </tbody></table></div>
      {!filteredPortfolio.length && <Empty>Nenhum cliente encontrado neste filtro.</Empty>}
    </section>}

    <footer className="cd-footer"><span>{text(payload.data_quality?.note)}</span><small>{num(payload.data_quality?.real_crm_owners)} responsáveis comerciais · {num(payload.data_quality?.crm_leads)} leads no funil</small></footer>
  </main>;
}
