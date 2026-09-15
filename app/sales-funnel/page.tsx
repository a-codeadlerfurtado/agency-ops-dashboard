"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, formatDate, formatNumber, supabase, text } from "../shared";
import "./sales-funnel.css";

type Row = Record<string, any>;
type Payload = {
  profile?: Row;
  clients?: Row[];
  commercial_reports?: Row[];
  marketing_evidence?: Row[];
  sales?: Row[];
  media?: Row[];
  transcript_health?: Row | null;
  coverage?: Row;
  generated_at?: string;
};
type Tab = "clients" | "commercial" | "sales" | "evidence";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-sales-funnel-api`;
const stages = [
  ["leads", "Leads"],
  ["conversations", "Em conversa"],
  ["visits_scheduled", "Visitas agendadas"],
  ["visits_completed", "Visitas realizadas"],
  ["proposals", "Propostas"],
  ["documents", "Documentação"],
  ["sales", "Vendas"],
] as const;

function cutoffFor(period: string) {
  if (period === "ALL") return 0;
  return Date.now() - Number(period) * 86_400_000;
}
function within(value: unknown, cutoff: number) {
  if (!cutoff) return true;
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) && time >= cutoff;
}
function pct(value: number, base: number) {
  if (!base) return "—";
  return `${Math.round((value / base) * 100)}%`;
}
function sourceLabel(value: string) {
  const map: Record<string, string> = {
    COMERCIAL: "Comercial",
    MARKETING: "Marketing",
    WHATSAPP: "WhatsApp",
    TRANSCRIPT: "Reunião",
    DONNAH: "Reunião",
    DRIVE_TRANSCRIPT: "Reunião",
    META: "Meta",
  };
  return map[String(value || "").toUpperCase()] || text(value || "—");
}
function stageLabel(value: string) {
  return ({ VISIT_SCHEDULED: "Visita agendada", VISIT_COMPLETED: "Visita realizada", PROPOSAL: "Proposta", DOCUMENT: "Documentação" } as Record<string, string>)[value] || value;
}
function dateOnly(value: unknown) {
  const raw = String(value || "").slice(0, 10);
  const [year, month, day] = raw.split("-").map(Number);
  if (!year || !month || !day) return "—";
  return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
}
function monthOnly(value: unknown) {
  const raw = String(value || "").slice(0, 10);
  const [year, month] = raw.split("-").map(Number);
  if (!year || !month) return "—";
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric" }).format(new Date(year, month - 1, 1)).replace(" de ", "/");
}
function saleFilterDate(row: Row) {
  return row.sale_date || row.sale_period_end || row.reported_at || row.event_at;
}
function saleDateLabel(row: Row) {
  const precision = String(row.date_precision || "UNKNOWN").toUpperCase();
  if (precision === "EXACT" && row.sale_date) return dateOnly(row.sale_date);
  if (precision === "REPORTED_DAY" && row.sale_date) return `${dateOnly(row.sale_date)} · confirmada no mesmo dia`;
  if (precision === "MONTH" && row.sale_period_start) return `${monthOnly(row.sale_period_start)} · dia exato não informado`;
  if (precision === "PERIOD" && row.sale_period_start && row.sale_period_end) return `${dateOnly(row.sale_period_start)} a ${dateOnly(row.sale_period_end)}`;
  if (precision === "BEFORE_REPORT" && row.sale_period_end) return `Até ${dateOnly(row.sale_period_end)}`;
  if (row.sale_date) return dateOnly(row.sale_date);
  return `Relatada em ${row.reported_at ? dateOnly(row.reported_at) : "data não informada"} · data da venda não informada`;
}
function attributionLabel(value: unknown) {
  if (value === "AGENCY") return "Agência";
  if (value === "THIRD_PARTY") return "Terceiro / concorrência";
  return "Origem não explícita";
}

export default function SalesFunnelPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [payload, setPayload] = useState<Payload>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("30");
  const [clientFilter, setClientFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("clients");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setAuthReady(true); });
    return () => subscription.unsubscribe();
  }, []);

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API_URL, { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.detail || json?.error || `API ${response.status}`);
      setPayload(json || {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar o funil comercial.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!authReady) return;
    if (!session) { window.location.assign("/"); return; }
    load();
  }, [authReady, session?.access_token]);

  const cutoff = cutoffFor(period);
  const reports = useMemo(() => (payload.commercial_reports || []).filter((row) => !row.is_aggregate && within(row.event_at, cutoff)), [payload.commercial_reports, cutoff]);
  const evidence = useMemo(() => (payload.marketing_evidence || []).filter((row) => within(row.event_at, cutoff)), [payload.marketing_evidence, cutoff]);
  const sales = useMemo(() => (payload.sales || []).filter((row) => within(saleFilterDate(row), cutoff)), [payload.sales, cutoff]);
  const mediaByClient = useMemo(() => new Map((payload.media || []).map((row) => [String(row.client_id), row])), [payload.media]);

  const clientStats = useMemo(() => {
    const map = new Map<string, Row>();
    for (const client of payload.clients || []) {
      const id = String(client.client_id);
      const media = mediaByClient.get(id) || {};
      map.set(id, {
        client_id: id, client_name: client.display_name, gt_owner: client.gt_owner, cs_owner: client.cs_owner,
        priority: client.priority, meta_leads: Number(media.leads || 0), spend: Number(media.spend || 0),
        leads: 0, conversations: 0, visits_scheduled_commercial: 0, visits_completed_commercial: 0, proposals_commercial: 0,
        visits_scheduled_marketing: 0, visits_completed_marketing: 0, proposals_marketing: 0, documents: 0,
        sales: 0, sales_agency: 0, sales_unknown: 0, sales_third_party: 0, reports: 0,
      });
    }
    for (const row of reports) {
      const item = map.get(String(row.client_id)); if (!item) continue;
      item.reports += 1;
      item.leads += Number(row.leads_received || 0);
      item.conversations += Number(row.conversations || 0);
      item.visits_scheduled_commercial += Number(row.visits_scheduled || 0);
      item.visits_completed_commercial += Number(row.visits_completed || 0);
      item.proposals_commercial += Number(row.proposals || 0);
    }
    for (const row of evidence) {
      const item = map.get(String(row.client_id)); if (!item) continue;
      if (row.stage === "VISIT_SCHEDULED") item.visits_scheduled_marketing += Number(row.quantity || 0);
      if (row.stage === "VISIT_COMPLETED") item.visits_completed_marketing += Number(row.quantity || 0);
      if (row.stage === "PROPOSAL") item.proposals_marketing += Number(row.quantity || 0);
      if (row.stage === "DOCUMENT") item.documents += Number(row.quantity || 0);
    }
    for (const row of sales) {
      const item = map.get(String(row.client_id)); if (!item) continue;
      const quantity = Number(row.quantity || 0);
      if (row.attribution === "THIRD_PARTY") item.sales_third_party += quantity;
      else {
        item.sales += quantity;
        if (row.attribution === "AGENCY") item.sales_agency += quantity;
        else item.sales_unknown += quantity;
      }
    }
    for (const item of map.values()) {
      item.leads = item.leads || item.meta_leads;
      item.leads_source = item.reports ? "COMERCIAL" : item.meta_leads ? "META" : "";
      item.visits_scheduled = item.visits_scheduled_commercial || item.visits_scheduled_marketing;
      item.visits_scheduled_source = item.visits_scheduled_commercial ? "COMERCIAL" : item.visits_scheduled_marketing ? "WHATSAPP" : "";
      item.visits_completed = item.visits_completed_commercial || item.visits_completed_marketing;
      item.visits_completed_source = item.visits_completed_commercial ? "COMERCIAL" : item.visits_completed_marketing ? "WHATSAPP" : "";
      item.proposals = item.proposals_commercial || item.proposals_marketing;
      item.proposals_source = item.proposals_commercial ? "COMERCIAL" : item.proposals_marketing ? "WHATSAPP" : "";
    }
    return [...map.values()];
  }, [payload.clients, reports, evidence, sales, mediaByClient]);

  const filteredClients = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return clientStats.filter((row) => (clientFilter === "ALL" || row.client_id === clientFilter) && (!needle || [row.client_name, row.gt_owner, row.cs_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle)))
      .sort((a, b) => Number(b.sales) - Number(a.sales) || Number(b.visits_completed) - Number(a.visits_completed) || Number(b.visits_scheduled) - Number(a.visits_scheduled));
  }, [clientStats, clientFilter, query]);

  const totals = useMemo(() => filteredClients.reduce((sum, row) => ({
    leads: sum.leads + Number(row.leads || 0), conversations: sum.conversations + Number(row.conversations || 0),
    visits_scheduled: sum.visits_scheduled + Number(row.visits_scheduled || 0), visits_completed: sum.visits_completed + Number(row.visits_completed || 0),
    proposals: sum.proposals + Number(row.proposals || 0), documents: sum.documents + Number(row.documents || 0), sales: sum.sales + Number(row.sales || 0),
    sales_agency: sum.sales_agency + Number(row.sales_agency || 0), sales_third_party: sum.sales_third_party + Number(row.sales_third_party || 0),
  }), { leads: 0, conversations: 0, visits_scheduled: 0, visits_completed: 0, proposals: 0, documents: 0, sales: 0, sales_agency: 0, sales_third_party: 0 }), [filteredClients]);

  const commercialRanking = useMemo<Row[]>(() => {
    const map = new Map<string, Row>();
    for (const row of reports) {
      if (clientFilter !== "ALL" && String(row.client_id) !== clientFilter) continue;
      const key = text(row.reporter || "Não identificado");
      const item = map.get(key) || { reporter: key, clients: new Set<string>(), reports: 0, leads: 0, calls: 0, answered: 0, conversations: 0, visits_scheduled: 0, visits_completed: 0, proposals: 0 };
      item.clients.add(text(row.client_name)); item.reports += 1; item.leads += Number(row.leads_received || 0); item.calls += Number(row.calls_made || 0); item.answered += Number(row.calls_answered || 0); item.conversations += Number(row.conversations || 0); item.visits_scheduled += Number(row.visits_scheduled || 0); item.visits_completed += Number(row.visits_completed || 0); item.proposals += Number(row.proposals || 0); map.set(key, item);
    }
    return [...map.values()].map((row): Row => ({ ...row, clients: [...(row.clients as Set<string>)].join(", ") })).sort((a: Row, b: Row) => b.visits_completed - a.visits_completed || b.proposals - a.proposals || b.visits_scheduled - a.visits_scheduled || b.leads - a.leads);
  }, [reports, clientFilter]);

  const champions = useMemo(() => filteredClients.filter((row) => row.sales > 0).sort((a, b) => b.sales - a.sales || b.sales_agency - a.sales_agency).slice(0, 10), [filteredClients]);
  const filteredSales = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return sales.filter((row) => (clientFilter === "ALL" || String(row.client_id) === clientFilter) && (!needle || `${row.client_name} ${row.evidence}`.toLocaleLowerCase("pt-BR").includes(needle)))
      .sort((a, b) => new Date(String(saleFilterDate(b))).getTime() - new Date(String(saleFilterDate(a))).getTime());
  }, [sales, clientFilter, query]);
  const recentEvidence = useMemo<Row[]>(() => ([...evidence.map((row) => ({ ...row, kind: stageLabel(row.stage) })), ...sales.map((row) => ({ ...row, kind: row.attribution === "THIRD_PARTY" ? "Venda por terceiro" : "Venda" }))] as Row[])
    .filter((row: Row) => clientFilter === "ALL" || String(row.client_id) === clientFilter)
    .sort((a: Row, b: Row) => new Date(String(b.event_at)).getTime() - new Date(String(a.event_at)).getTime()).slice(0, 50), [evidence, sales, clientFilter]);

  const transcriptBroken = payload.transcript_health && payload.transcript_health.health_status !== "HEALTHY";

  if (!authReady || !session) return <main className="funnel-loading">Carregando…</main>;

  return <main className="funnel-shell">
    <header className="funnel-top">
      <button className="funnel-back" onClick={() => window.location.assign("/")}>← Dashboard</button>
      <div className="funnel-brand"><span><BrandMark /></span><div><small>Leonardo Imobi</small><b>Funil Comercial</b></div></div>
      <div className="funnel-user"><b>{text(payload.profile?.person || "Colaborador")}</b><small>{text(payload.profile?.role || "Operação")}</small></div>
    </header>

    <section className="funnel-hero">
      <div><span className="funnel-eyebrow">Marketing + Comercial + Vendas</span><h1>Do lead até a <em>venda</em>, com evidência.</h1><p>Vendas vêm de uma base canônica auditável. A data da venda fica separada da data em que ela foi relatada; quando a fonte só informa mês ou período, o funil mostra essa precisão sem inventar um dia.</p></div>
      <div className="funnel-coverage"><b>{formatNumber(payload.coverage?.linked_groups || 0, 0)}</b><span>grupos vinculados</span><b>{formatNumber(payload.coverage?.canonical_sale_events || 0, 0)}</b><span>eventos de venda</span></div>
    </section>

    {transcriptBroken && <div className="funnel-error"><b>Transcripts com ingest interrompido.</b> O Drive possui arquivos mais novos, mas o Supabase não está recebendo essas reuniões. Último ingest registrado: {payload.transcript_health?.last_ingest_at ? formatDate(payload.transcript_health.last_ingest_at) : "não informado"}. O funil continua usando WhatsApp e os transcripts auditados manualmente, mas novas reuniões só entrarão automaticamente quando a ponte Drive/Make → Supabase voltar.</div>}

    <section className="funnel-filters">
      <div className="funnel-periods">{[["7","7 dias"],["30","30 dias"],["ALL","Todo período"]].map(([value,label]) => <button key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{label}</button>)}</div>
      <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}><option value="ALL">Todos os clientes</option>{(payload.clients || []).map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}</select>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou evidência" />
      <button className="funnel-refresh" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
    </section>

    {error && <div className="funnel-error">{error}</div>}

    <section className="funnel-flow">
      {stages.map(([key, label], index) => {
        const value = Number((totals as any)[key] || 0);
        const prev = index ? Number((totals as any)[stages[index - 1][0]] || 0) : 0;
        return <article key={key} className={key === "sales" ? "winner" : ""}><small>{label}</small><b>{formatNumber(value, 0)}</b><span>{index ? `${pct(value, prev)} da etapa anterior` : "topo do funil"}</span></article>;
      })}
    </section>

    <section className="funnel-context">
      <article><small>Vendas com origem na agência</small><b>{formatNumber(totals.sales_agency, 0)}</b><span>evidência cita tráfego, campanha, anúncio ou lead</span></article>
      <article><small>Vendas sem origem explícita</small><b>{formatNumber(totals.sales - totals.sales_agency, 0)}</b><span>venda confirmada, atribuição ainda não comprovada</span></article>
      <article><small>Vendidos por terceiro</small><b>{formatNumber(totals.sales_third_party, 0)}</b><span>concorrência, proprietário ou terceiro; não soma como venda da agência</span></article>
      <article><small>Sinais para revisar</small><b>{formatNumber(payload.coverage?.sale_candidates_review || 0, 0)}</b><span>menções ambíguas preservadas sem inflar o total</span></article>
    </section>

    <section className="funnel-tabs">
      <button className={tab === "clients" ? "active" : ""} onClick={() => setTab("clients")}>Clientes</button>
      <button className={tab === "sales" ? "active" : ""} onClick={() => setTab("sales")}>Vendas & datas</button>
      <button className={tab === "commercial" ? "active" : ""} onClick={() => setTab("commercial")}>Comerciais</button>
      <button className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>Evidências</button>
    </section>

    {tab === "clients" && <div className="funnel-two-col">
      <section className="funnel-card funnel-clients"><div className="funnel-card-head"><div><span className="funnel-eyebrow">Resultado por cliente</span><h2>Quem está avançando no funil</h2></div><b>{filteredClients.length}</b></div>
        <div className="funnel-table-wrap"><table><thead><tr><th>Cliente</th><th>Leads</th><th>Agendadas</th><th>Realizadas</th><th>Propostas</th><th>Docs</th><th>Vendas</th><th>Conv.</th></tr></thead><tbody>{filteredClients.map((row) => <tr key={row.client_id}><td><strong>{row.client_name}</strong><small>GT {text(row.gt_owner)} · CS {text(row.cs_owner)}</small></td><td>{formatNumber(row.leads,0)}<small>{sourceLabel(row.leads_source)}</small></td><td>{formatNumber(row.visits_scheduled,0)}<small>{sourceLabel(row.visits_scheduled_source)}</small></td><td>{formatNumber(row.visits_completed,0)}<small>{sourceLabel(row.visits_completed_source)}</small></td><td>{formatNumber(row.proposals,0)}<small>{sourceLabel(row.proposals_source)}</small></td><td>{formatNumber(row.documents,0)}<small>{row.documents ? "WhatsApp" : "—"}</small></td><td><b className={row.sales ? "sale-count" : ""}>{formatNumber(row.sales,0)}</b><small>{row.sales_agency ? `${row.sales_agency} atrib. agência` : row.sales_unknown ? `${row.sales_unknown} sem origem explícita` : ""}</small></td><td>{pct(Number(row.sales), Number(row.leads))}</td></tr>)}</tbody></table></div>
      </section>
      <section className="funnel-card champions"><div className="funnel-card-head"><div><span className="funnel-eyebrow">Campeões</span><h2>Ranking de vendas</h2></div></div>{champions.map((row, index) => <div className="champion-row" key={row.client_id}><span>{index + 1}</span><div><b>{row.client_name}</b><small>{row.sales_agency ? `${row.sales_agency} com atribuição à agência` : "origem não explícita"}</small></div><strong>{row.sales}</strong></div>)}{!champions.length && <div className="funnel-empty">Nenhuma venda confirmada nesse recorte.</div>}</section>
    </div>}

    {tab === "sales" && <section className="funnel-card"><div className="funnel-card-head"><div><span className="funnel-eyebrow">Registro canônico</span><h2>Vendas e datas confirmadas</h2><p>A data da venda é exibida somente quando a evidência permite. “Relatada em” não é tratada como data da venda.</p></div><b>{filteredSales.length}</b></div>
      <div className="funnel-table-wrap"><table><thead><tr><th>Cliente</th><th>Qtd.</th><th>Data / período</th><th>Origem</th><th>Fonte</th><th>VGV</th><th>Evidência</th></tr></thead><tbody>{filteredSales.map((row) => <tr key={row.sale_key || row.id}><td><strong>{row.client_name}</strong>{row.property_reference && <small>{row.property_reference}</small>}</td><td><b className={row.attribution !== "THIRD_PARTY" ? "sale-count" : ""}>{formatNumber(row.quantity,0)}</b></td><td className="compact-text"><strong>{saleDateLabel(row)}</strong>{row.reported_at && <small>Relato: {formatDate(row.reported_at)}</small>}</td><td><strong>{attributionLabel(row.attribution)}</strong></td><td>{sourceLabel(row.source)}</td><td>{row.vgv ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(row.vgv)) : "—"}</td><td className="compact-text">{text(row.evidence)}</td></tr>)}</tbody></table></div>
      {!filteredSales.length && <div className="funnel-empty">Nenhuma venda confirmada nesse recorte.</div>}
    </section>}

    {tab === "commercial" && <section className="funnel-card"><div className="funnel-card-head"><div><span className="funnel-eyebrow">Performance declarada</span><h2>Resultado dos comerciais</h2><p>Somente respostas numéricas reais nos grupos [COMERCIAL]. Perguntas vazias e acumulados mensais/semanais são retirados do total para reduzir duplicidade.</p></div><b>{commercialRanking.length}</b></div>
      <div className="funnel-table-wrap"><table><thead><tr><th>Comercial</th><th>Clientes</th><th>Reportes</th><th>Leads</th><th>Ligações</th><th>Atendidas</th><th>Conversas</th><th>Visitas ag.</th><th>Visitas real.</th><th>Propostas</th><th>Visita/lead</th></tr></thead><tbody>{commercialRanking.map((row, index) => <tr key={row.reporter}><td><span className="rank">{index + 1}</span><strong>{row.reporter}</strong></td><td className="compact-text">{row.clients}</td><td>{row.reports}</td><td>{row.leads}</td><td>{row.calls}</td><td>{row.answered}</td><td>{row.conversations}</td><td>{row.visits_scheduled}</td><td><b>{row.visits_completed}</b></td><td>{row.proposals}</td><td>{pct(row.visits_completed,row.leads)}</td></tr>)}</tbody></table></div>
      {!commercialRanking.length && <div className="funnel-empty">Nenhum reporte comercial numérico nesse período.</div>}
    </section>}

    {tab === "evidence" && <section className="funnel-card"><div className="funnel-card-head"><div><span className="funnel-eyebrow">Rastreabilidade</span><h2>Evidências que sustentam o funil</h2><p>Visitas, propostas, documentação e vendas mantêm a fonte e o texto que sustentam cada registro.</p></div><b>{recentEvidence.length}</b></div>
      <div className="evidence-list">{recentEvidence.map((row) => <article key={`${row.kind}-${row.message_id}-${row.stage || row.attribution}-${row.sale_key || ""}`}><div className="evidence-head"><span className={`evidence-pill ${String(row.source || "").toLowerCase()}`}>{sourceLabel(row.source)}</span><b>{row.client_name}</b><small>{row.sale_date || row.sale_period_end ? saleDateLabel(row) : formatDate(row.event_at)}</small></div><div className="evidence-body"><strong>{row.kind} · {formatNumber(row.quantity,0)}</strong><p>{text(row.evidence)}</p>{row.attribution && <span className={`attrib ${String(row.attribution).toLowerCase()}`}>{attributionLabel(row.attribution)}</span>}</div></article>)}</div>
      {!recentEvidence.length && <div className="funnel-empty">Nenhuma evidência encontrada nesse recorte.</div>}
    </section>}

    <footer className="funnel-footer">Atualizado {payload.generated_at ? formatDate(payload.generated_at) : "agora"} · {formatNumber(payload.coverage?.commercial_messages || 0,0)} mensagens comerciais lidas · {formatNumber(payload.coverage?.whatsapp_stage_candidate_messages || 0,0)} mensagens de etapas analisadas · {formatNumber(payload.coverage?.canonical_sale_events || 0,0)} eventos de venda canônicos.</footer>
  </main>;
}
