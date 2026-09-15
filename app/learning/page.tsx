"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, formatDate, formatNumber, supabase, text } from "../shared";
import "./learning.css";

type Row = Record<string, any>;
type Payload = {
  profile?: Row;
  clients?: Row[];
  decisions?: Row[];
  experiments?: Row[];
  stats?: Row;
  generated_at?: string;
};

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-learning-api`;

const decisionCategories: Record<string, string> = {
  STRATEGY: "Estratégia",
  BUDGET: "Orçamento",
  CAMPAIGN: "Campanha",
  CREATIVE: "Criativo",
  AUDIENCE: "Público",
  COMMUNICATION: "Comunicação",
  ONBOARDING: "Onboarding",
  PROCESS: "Processo",
  OTHER: "Outro",
};
const decisionStatuses: Record<string, string> = {
  ACTIVE: "Ativa",
  CLOSED: "Encerrada",
  SUPERSEDED: "Substituída",
  REVERSED: "Revertida",
};
const experimentTypes: Record<string, string> = {
  AUDIENCE: "Público",
  CREATIVE: "Criativo",
  BUDGET: "Orçamento",
  PLACEMENT: "Posicionamento",
  OBJECTIVE: "Objetivo",
  COPY: "Copy",
  LANDING_PAGE: "Landing page",
  CAMPAIGN_STRUCTURE: "Estrutura de campanha",
  OTHER: "Outro",
};
const experimentStatuses: Record<string, string> = {
  PLANNED: "Planejado",
  RUNNING: "Rodando",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado",
};
const conclusions: Record<string, string> = {
  ONGOING: "Em análise",
  WIN: "Vencedor",
  LOSS: "Perdedor",
  INCONCLUSIVE: "Inconclusivo",
};

function isoFromDate(value: string) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateInput(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function Pill({ value, tone = "" }: { value: string; tone?: string }) {
  return <span className={`learning-pill ${tone} ${String(value).toLowerCase()}`}>{value}</span>;
}

export default function LearningPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [payload, setPayload] = useState<Payload>({ clients: [], decisions: [], experiments: [], stats: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"decisions" | "experiments">("decisions");
  const [clientFilter, setClientFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [saving, setSaving] = useState("");
  const [decisionForm, setDecisionForm] = useState<Row>({ client_id: "", category: "STRATEGY", title: "", decision_text: "", reason: "", expected_impact: "" });
  const [experimentForm, setExperimentForm] = useState<Row>({ client_id: "", experiment_type: "AUDIENCE", title: "", hypothesis: "", variable_tested: "", control_description: "", variant_description: "", primary_metric: "CPL", baseline_value: "", start_date: "", end_date: "", status: "PLANNED", campaign_ids: "" });
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, Row>>({});
  const [experimentDrafts, setExperimentDrafts] = useState<Record<string, Row>>({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setAuthReady(true); });
    return () => subscription.unsubscribe();
  }, []);

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(`${API_URL}?view=overview`, { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.detail || json?.error || `API ${response.status}`);
      setPayload(json || {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar a memória de tráfego.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!authReady) return;
    if (!session) { window.location.assign("/"); return; }
    load();
  }, [authReady, session?.access_token]);

  async function post(view: string, body: Row) {
    const response = await authenticatedFetch(`${API_URL}?view=${encodeURIComponent(view)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.detail || json?.error || `API ${response.status}`);
    return json;
  }

  const clients = payload.clients || [];
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const clientMatch = (row: Row) => clientFilter === "ALL" || String(row.client_id) === clientFilter;
  const searchMatch = (row: Row) => !needle || [row.client_name, row.title, row.decision_text, row.reason, row.expected_impact, row.outcome, row.hypothesis, row.variable_tested, row.learning, row.result_summary]
    .filter(Boolean).join(" ").toLocaleLowerCase("pt-BR").includes(needle);
  const decisions = useMemo(() => (payload.decisions || []).filter((row) => clientMatch(row) && searchMatch(row)), [payload.decisions, clientFilter, needle]);
  const experiments = useMemo(() => (payload.experiments || []).filter((row) => clientMatch(row) && searchMatch(row)), [payload.experiments, clientFilter, needle]);
  const learnings = useMemo(() => experiments.filter((row) => row.learning).slice(0, 8), [experiments]);

  async function createDecision(event: React.FormEvent) {
    event.preventDefault();
    setSaving("decision-create"); setError("");
    try {
      await post("decision-create", decisionForm);
      setDecisionForm({ client_id: "", category: "STRATEGY", title: "", decision_text: "", reason: "", expected_impact: "" });
      setDecisionOpen(false);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao registrar decisão."); }
    finally { setSaving(""); }
  }

  async function updateDecision(row: Row) {
    const draft = decisionDrafts[String(row.id)] || { status: row.status, outcome: row.outcome || "" };
    setSaving(`decision-${row.id}`); setError("");
    try {
      await post("decision-update", { id: row.id, client_id: row.client_id, status: draft.status, outcome: draft.outcome });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao atualizar decisão."); }
    finally { setSaving(""); }
  }

  async function createExperiment(event: React.FormEvent) {
    event.preventDefault();
    setSaving("experiment-create"); setError("");
    try {
      await post("experiment-create", {
        ...experimentForm,
        start_at: isoFromDate(String(experimentForm.start_date || "")),
        end_at: isoFromDate(String(experimentForm.end_date || "")),
        campaign_ids: String(experimentForm.campaign_ids || "").split(",").map((x) => x.trim()).filter(Boolean),
      });
      setExperimentForm({ client_id: "", experiment_type: "AUDIENCE", title: "", hypothesis: "", variable_tested: "", control_description: "", variant_description: "", primary_metric: "CPL", baseline_value: "", start_date: "", end_date: "", status: "PLANNED", campaign_ids: "" });
      setExperimentOpen(false);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao registrar experimento."); }
    finally { setSaving(""); }
  }

  async function updateExperiment(row: Row) {
    const draft = experimentDrafts[String(row.id)] || {
      status: row.status,
      conclusion: row.conclusion,
      baseline_value: row.baseline_value ?? "",
      result_value: row.result_value ?? "",
      result_summary: row.result_summary || "",
      learning: row.learning || "",
      end_date: dateInput(row.end_at),
    };
    setSaving(`experiment-${row.id}`); setError("");
    try {
      await post("experiment-update", {
        id: row.id,
        client_id: row.client_id,
        status: draft.status,
        conclusion: draft.conclusion,
        baseline_value: draft.baseline_value,
        result_value: draft.result_value,
        result_summary: draft.result_summary,
        learning: draft.learning,
        end_at: isoFromDate(String(draft.end_date || "")),
      });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao atualizar experimento."); }
    finally { setSaving(""); }
  }

  const stats = payload.stats || {};
  const canExperiment = Boolean(payload.profile?.can_manage_experiments);

  if (!authReady || !session) return <main className="learning-loading">Carregando…</main>;

  return <main className="learning-shell">
    <header className="learning-top">
      <button className="learning-back" type="button" onClick={() => window.location.assign("/")}>← Dashboard</button>
      <div className="learning-brand"><span className="learning-logo"><BrandMark /></span><span><small>Leonardo Imobi</small><b>Memória de Tráfego</b></span></div>
      <div className="learning-user"><b>{text(payload.profile?.person || "Colaborador")}</b><small>{text(payload.profile?.role || "Operação")}</small></div>
    </header>

    <section className="learning-hero">
      <div><span className="learning-eyebrow">Decidir · testar · aprender</span><h1>O histórico precisa explicar <em>por que</em> a operação mudou.</h1><p>Decisões guardam contexto e motivo. Experimentos guardam hipótese, resultado e aprendizado para o time não repetir teste no escuro.</p></div>
      <div className="learning-hero-actions"><button onClick={() => { setTab("decisions"); setDecisionOpen(true); }}>+ Nova decisão</button>{canExperiment && <button onClick={() => { setTab("experiments"); setExperimentOpen(true); }}>+ Novo experimento</button>}</div>
    </section>

    <section className="learning-kpis">
      <article><small>Decisões · 30 dias</small><b>{formatNumber(stats.decisions_30d || 0, 0)}</b><span>mudanças registradas</span></article>
      <article><small>Decisões ativas</small><b>{formatNumber(stats.active_decisions || 0, 0)}</b><span>ainda válidas</span></article>
      <article><small>Experimentos rodando</small><b>{formatNumber(stats.experiments_running || 0, 0)}</b><span>testes em andamento</span></article>
      <article><small>Aprendizados</small><b>{formatNumber(stats.learnings_recorded || 0, 0)}</b><span>conclusões reutilizáveis</span></article>
    </section>

    {error && <div className="learning-error">{error}</div>}

    <section className="learning-toolbar">
      <div className="learning-tabs"><button className={tab === "decisions" ? "active" : ""} onClick={() => setTab("decisions")}>Decisões <b>{decisions.length}</b></button><button className={tab === "experiments" ? "active" : ""} onClick={() => setTab("experiments")}>Experimentos <b>{experiments.length}</b></button></div>
      <div className="learning-filters"><select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}><option value="ALL">Todos os clientes</option>{clients.map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}</select><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar decisão, hipótese ou aprendizado" /></div>
    </section>

    {tab === "decisions" && <>
      {decisionOpen && <form className="learning-form" onSubmit={createDecision}>
        <div className="learning-form-head"><div><span className="learning-eyebrow">Memória operacional</span><h2>Registrar decisão</h2></div><button type="button" onClick={() => setDecisionOpen(false)}>×</button></div>
        <div className="learning-form-grid"><label>Cliente<select required value={decisionForm.client_id} onChange={(e) => setDecisionForm((p) => ({ ...p, client_id: e.target.value }))}><option value="">Selecione…</option>{clients.map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}</select></label><label>Categoria<select value={decisionForm.category} onChange={(e) => setDecisionForm((p) => ({ ...p, category: e.target.value }))}>{Object.entries(decisionCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <label>Título<input required minLength={3} value={decisionForm.title} onChange={(e) => setDecisionForm((p) => ({ ...p, title: e.target.value }))} placeholder="Ex.: Reduzir orçamento da campanha de remarketing" /></label>
        <label>O que foi decidido<textarea required minLength={3} value={decisionForm.decision_text} onChange={(e) => setDecisionForm((p) => ({ ...p, decision_text: e.target.value }))} placeholder="Escreva a decisão de forma objetiva." /></label>
        <div className="learning-form-grid"><label>Por que decidimos isso<textarea value={decisionForm.reason} onChange={(e) => setDecisionForm((p) => ({ ...p, reason: e.target.value }))} placeholder="Evidência, contexto ou problema que levou à decisão." /></label><label>Impacto esperado<textarea value={decisionForm.expected_impact} onChange={(e) => setDecisionForm((p) => ({ ...p, expected_impact: e.target.value }))} placeholder="O que esperamos que mude depois dessa decisão." /></label></div>
        <div className="learning-form-actions"><span>Autor e horário são registrados automaticamente.</span><button disabled={saving === "decision-create"}>{saving === "decision-create" ? "Salvando…" : "Registrar decisão"}</button></div>
      </form>}

      <section className="learning-list">
        {!decisionOpen && <button className="learning-inline-create" onClick={() => setDecisionOpen(true)}>+ Registrar nova decisão</button>}
        {loading && <div className="learning-empty">Carregando decisões…</div>}
        {!loading && decisions.map((row) => {
          const draft = decisionDrafts[String(row.id)] || { status: row.status, outcome: row.outcome || "" };
          return <article className="learning-card" key={row.id}>
            <div className="learning-card-head"><div><span className="learning-client">{text(row.client_name)}</span><h3>{text(row.title)}</h3></div><div><Pill value={decisionCategories[row.category] || row.category} /><Pill value={decisionStatuses[row.status] || row.status} tone={row.status === "ACTIVE" ? "info" : ""} /></div></div>
            <p className="learning-decision">{text(row.decision_text)}</p>
            <div className="learning-context-grid"><div><small>POR QUÊ</small><p>{text(row.reason || "Motivo não registrado.")}</p></div><div><small>IMPACTO ESPERADO</small><p>{text(row.expected_impact || "Impacto não registrado.")}</p></div></div>
            {row.outcome && <div className="learning-outcome"><small>RESULTADO OBSERVADO</small><p>{text(row.outcome)}</p></div>}
            <div className="learning-meta"><span>{formatDate(row.decided_at)}</span><span>por <b>{text(row.created_by_person)}</b></span></div>
            <details className="learning-update"><summary>Registrar resultado / revisar status</summary><div className="learning-update-grid"><label>Status<select value={draft.status} onChange={(e) => setDecisionDrafts((p) => ({ ...p, [row.id]: { ...draft, status: e.target.value } }))}>{Object.entries(decisionStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Resultado observado<textarea value={draft.outcome} onChange={(e) => setDecisionDrafts((p) => ({ ...p, [row.id]: { ...draft, outcome: e.target.value } }))} placeholder="O que aconteceu depois dessa decisão?" /></label></div><button disabled={saving === `decision-${row.id}`} onClick={() => updateDecision(row)}>{saving === `decision-${row.id}` ? "Salvando…" : "Salvar resultado"}</button></details>
          </article>;
        })}
        {!loading && !decisions.length && <div className="learning-empty">Nenhuma decisão encontrada neste filtro.</div>}
      </section>
    </>}

    {tab === "experiments" && <>
      {learnings.length > 0 && <section className="learning-knowledge"><div className="learning-section-head"><div><span className="learning-eyebrow">Biblioteca viva</span><h2>Aprendizados reutilizáveis</h2></div><span>{learnings.length} recentes</span></div><div className="learning-knowledge-grid">{learnings.map((row) => <article key={row.id}><div><Pill value={text(row.client_name)} /><Pill value={conclusions[row.conclusion] || row.conclusion} tone={row.conclusion === "WIN" ? "success" : row.conclusion === "LOSS" ? "danger" : ""} /></div><h3>{text(row.title)}</h3><p>{text(row.learning)}</p><small>{experimentTypes[row.experiment_type] || row.experiment_type} · {row.primary_metric}</small></article>)}</div></section>}

      {experimentOpen && canExperiment && <form className="learning-form" onSubmit={createExperiment}>
        <div className="learning-form-head"><div><span className="learning-eyebrow">Teste controlado</span><h2>Registrar experimento</h2></div><button type="button" onClick={() => setExperimentOpen(false)}>×</button></div>
        <div className="learning-form-grid thirds"><label>Cliente<select required value={experimentForm.client_id} onChange={(e) => setExperimentForm((p) => ({ ...p, client_id: e.target.value }))}><option value="">Selecione…</option>{clients.map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}</select></label><label>Tipo<select value={experimentForm.experiment_type} onChange={(e) => setExperimentForm((p) => ({ ...p, experiment_type: e.target.value }))}>{Object.entries(experimentTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Métrica principal<select value={experimentForm.primary_metric} onChange={(e) => setExperimentForm((p) => ({ ...p, primary_metric: e.target.value }))}>{["CPL","CPA","CTR","CPM","LEADS","CONVERSIONS","ROAS","CPC","OTHER"].map((metric) => <option key={metric}>{metric}</option>)}</select></label></div>
        <label>Título<input required minLength={3} value={experimentForm.title} onChange={(e) => setExperimentForm((p) => ({ ...p, title: e.target.value }))} placeholder="Ex.: Público aberto vs. lookalike 1%" /></label>
        <label>Hipótese<textarea required minLength={3} value={experimentForm.hypothesis} onChange={(e) => setExperimentForm((p) => ({ ...p, hypothesis: e.target.value }))} placeholder="Ex.: público aberto deve reduzir o CPL sem derrubar a qualidade dos leads." /></label>
        <div className="learning-form-grid"><label>Variável testada<input value={experimentForm.variable_tested} onChange={(e) => setExperimentForm((p) => ({ ...p, variable_tested: e.target.value }))} placeholder="Público, criativo, orçamento…" /></label><label>Baseline<input type="number" step="any" value={experimentForm.baseline_value} onChange={(e) => setExperimentForm((p) => ({ ...p, baseline_value: e.target.value }))} placeholder="Valor antes do teste" /></label></div>
        <div className="learning-form-grid"><label>Controle<textarea value={experimentForm.control_description} onChange={(e) => setExperimentForm((p) => ({ ...p, control_description: e.target.value }))} placeholder="Como está hoje / grupo de controle." /></label><label>Variante<textarea value={experimentForm.variant_description} onChange={(e) => setExperimentForm((p) => ({ ...p, variant_description: e.target.value }))} placeholder="O que muda no teste." /></label></div>
        <div className="learning-form-grid thirds"><label>Início<input type="date" value={experimentForm.start_date} onChange={(e) => setExperimentForm((p) => ({ ...p, start_date: e.target.value }))} /></label><label>Fim previsto<input type="date" value={experimentForm.end_date} onChange={(e) => setExperimentForm((p) => ({ ...p, end_date: e.target.value }))} /></label><label>Status<select value={experimentForm.status} onChange={(e) => setExperimentForm((p) => ({ ...p, status: e.target.value }))}>{Object.entries(experimentStatuses).slice(0, 2).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <label>IDs das campanhas <span className="learning-hint">opcional · separados por vírgula</span><input value={experimentForm.campaign_ids} onChange={(e) => setExperimentForm((p) => ({ ...p, campaign_ids: e.target.value }))} placeholder="123456789, 987654321" /></label>
        <div className="learning-form-actions"><span>O aprendizado final será preenchido quando o teste terminar.</span><button disabled={saving === "experiment-create"}>{saving === "experiment-create" ? "Salvando…" : "Registrar experimento"}</button></div>
      </form>}

      <section className="learning-list">
        {canExperiment && !experimentOpen && <button className="learning-inline-create" onClick={() => setExperimentOpen(true)}>+ Registrar novo experimento</button>}
        {!canExperiment && <div className="learning-readonly">Seu perfil pode consultar a biblioteca. Criação e encerramento de experimentos ficam com GT/Operações.</div>}
        {loading && <div className="learning-empty">Carregando experimentos…</div>}
        {!loading && experiments.map((row) => {
          const draft = experimentDrafts[String(row.id)] || { status: row.status, conclusion: row.conclusion, baseline_value: row.baseline_value ?? "", result_value: row.result_value ?? "", result_summary: row.result_summary || "", learning: row.learning || "", end_date: dateInput(row.end_at) };
          return <article className="learning-card experiment" key={row.id}>
            <div className="learning-card-head"><div><span className="learning-client">{text(row.client_name)}</span><h3>{text(row.title)}</h3></div><div><Pill value={experimentTypes[row.experiment_type] || row.experiment_type} /><Pill value={experimentStatuses[row.status] || row.status} tone={row.status === "RUNNING" ? "info" : ""} /><Pill value={conclusions[row.conclusion] || row.conclusion} tone={row.conclusion === "WIN" ? "success" : row.conclusion === "LOSS" ? "danger" : ""} /></div></div>
            <div className="learning-hypothesis"><small>HIPÓTESE</small><p>{text(row.hypothesis)}</p></div>
            <div className="learning-context-grid three"><div><small>VARIÁVEL</small><p>{text(row.variable_tested || "Não informada")}</p></div><div><small>MÉTRICA</small><p>{text(row.primary_metric)}</p></div><div><small>PERÍODO</small><p>{row.start_at ? formatDate(row.start_at) : "Sem início"} → {row.end_at ? formatDate(row.end_at) : "em aberto"}</p></div></div>
            {(row.control_description || row.variant_description) && <div className="learning-context-grid"><div><small>CONTROLE</small><p>{text(row.control_description || "—")}</p></div><div><small>VARIANTE</small><p>{text(row.variant_description || "—")}</p></div></div>}
            <div className="learning-result-strip"><span><small>Baseline</small><b>{row.baseline_value ?? "—"}</b></span><span><small>Resultado</small><b>{row.result_value ?? "—"}</b></span><span><small>Variação</small><b>{row.delta_pct == null ? "—" : `${formatNumber(row.delta_pct, 1)}%`}</b></span></div>
            {row.result_summary && <div className="learning-outcome"><small>RESULTADO</small><p>{text(row.result_summary)}</p></div>}
            {row.learning && <div className="learning-learning"><small>APRENDIZADO</small><p>{text(row.learning)}</p></div>}
            <div className="learning-meta"><span>Criado {formatDate(row.created_at)}</span><span>por <b>{text(row.created_by_person)}</b></span></div>
            {canExperiment && <details className="learning-update"><summary>Atualizar resultado e aprendizado</summary><div className="learning-update-grid three"><label>Status<select value={draft.status} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, status: e.target.value } }))}>{Object.entries(experimentStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Conclusão<select value={draft.conclusion} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, conclusion: e.target.value } }))}>{Object.entries(conclusions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Data final<input type="date" value={draft.end_date} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, end_date: e.target.value } }))} /></label></div><div className="learning-update-grid"><label>Baseline<input type="number" step="any" value={draft.baseline_value} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, baseline_value: e.target.value } }))} /></label><label>Resultado<input type="number" step="any" value={draft.result_value} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, result_value: e.target.value } }))} /></label></div><label>Resumo do resultado<textarea value={draft.result_summary} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, result_summary: e.target.value } }))} placeholder="O que aconteceu nos números?" /></label><label>Aprendizado reutilizável<textarea value={draft.learning} onChange={(e) => setExperimentDrafts((p) => ({ ...p, [row.id]: { ...draft, learning: e.target.value } }))} placeholder="O que esse teste ensina para as próximas decisões?" /></label><button disabled={saving === `experiment-${row.id}`} onClick={() => updateExperiment(row)}>{saving === `experiment-${row.id}` ? "Salvando…" : "Salvar resultado"}</button></details>}
          </article>;
        })}
        {!loading && !experiments.length && <div className="learning-empty">Nenhum experimento encontrado neste filtro.</div>}
      </section>
    </>}
  </main>;
}
