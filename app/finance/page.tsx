"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, formatDate, formatMoney, formatNumber, supabase, text } from "../shared";
import "./finance.css";

type Row = Record<string, any>;
type Payload = {
  ok?: boolean;
  summary?: Row;
  rows?: Row[];
  policy?: Row;
  generated_at?: string;
};

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-adler-finance-api`;

function sourceLabel(value: unknown) {
  const source = String(value || "").toUpperCase();
  return ({ BRIEFING: "Briefing", MEETING: "Reunião", CONTRACT: "Contrato" } as Record<string, string>)[source] || text(value || "—");
}

function evidenceLabel(evidence: Row | null | undefined) {
  if (!evidence) return null;
  const value = evidence.numeric_value != null ? formatMoney(evidence.numeric_value) : text(evidence.text_value || "valor não estruturado");
  return `${value} · ${sourceLabel(evidence.source_type)} · ${Math.round(Number(evidence.confidence || 0) * 100)}%`;
}

function displayValue(value: unknown, evidence: Row | null | undefined) {
  if (value !== null && value !== undefined) return <strong>{formatMoney(value)}</strong>;
  if (evidence) return <span className="candidate">Candidato: {evidenceLabel(evidence)}</span>;
  return <span className="missing">Não confirmado</span>;
}

function sourceBadges(row: Row) {
  const sources = new Set<string>();
  for (const key of ["monthly_evidence", "implementation_evidence", "term_evidence", "payment_evidence"]) {
    for (const source of row[key]?.source_types || []) sources.add(String(source));
  }
  return [...sources];
}

export default function FinancePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [payload, setPayload] = useState<Payload>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("CURRENT");
  const [coverage, setCoverage] = useState("ALL");

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
      if (!response.ok || !json?.ok) throw new Error(response.status === 404 ? "Área financeira indisponível para este usuário." : json?.detail || json?.error || `API ${response.status}`);
      setPayload(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar os valores comerciais.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!authReady) return;
    if (!session) { window.location.assign("/"); return; }
    load();
  }, [authReady, session?.access_token]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (payload.rows || []).filter((row) => {
      const matchesQuery = !needle || [row.display_name, row.gt_owner, row.cs_owner, row.canonical_source]
        .join(" ").toLocaleLowerCase("pt-BR").includes(needle);
      const matchesStatus = status === "CURRENT" || row.lifecycle === status;
      const hasMonthly = row.monthly_value !== null && row.monthly_value !== undefined;
      const hasImplementation = row.implementation_value !== null && row.implementation_value !== undefined;
      const hasCandidate = (!hasMonthly && row.monthly_evidence?.provisional) || (!hasImplementation && row.implementation_evidence?.provisional);
      const matchesCoverage = coverage === "ALL"
        || (coverage === "COMPLETE" && hasMonthly && hasImplementation)
        || (coverage === "MISSING" && (!hasMonthly || !hasImplementation))
        || (coverage === "CANDIDATE" && hasCandidate);
      return matchesQuery && matchesStatus && matchesCoverage;
    });
  }, [payload.rows, query, status, coverage]);

  const summary = payload.summary || {};
  const current = Number(summary.current_clients || 0);
  const monthlyCoverage = current ? Math.round((Number(summary.monthly_confirmed || 0) / current) * 100) : 0;
  const implementationCoverage = current ? Math.round((Number(summary.implementation_confirmed || 0) / current) * 100) : 0;

  if (!authReady || !session) return <main className="finance-loading">Carregando…</main>;

  return <main className="finance-shell">
    <header className="finance-top">
      <button className="finance-back" onClick={() => window.location.assign("/")}>← Dashboard</button>
      <div className="finance-brand"><span><BrandMark /></span><div><small>Leonardo Imobi</small><b>Mensalidades & Implementações</b></div></div>
      <button className="finance-refresh" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
    </header>

    <section className="finance-hero">
      <div>
        <span className="finance-eyebrow">PRIVADO · ADLER ONLY</span>
        <h1>Valores comerciais da carteira</h1>
        <p>Mensalidade, implementação, prazo e condição comercial consolidados a partir de briefings, reuniões e contratos. Só valores confirmados entram nos totais; candidatos provisórios ficam sinalizados para validação.</p>
      </div>
      <div className="finance-generated">{payload.generated_at ? `Atualizado ${formatDate(payload.generated_at)}` : "Aguardando carga"}</div>
    </section>

    {error && <div className="finance-error">{error}</div>}

    <section className="finance-kpis">
      <article><small>MRR confirmado</small><strong>{formatMoney(summary.monthly_total_confirmed)}</strong><span>{formatNumber(summary.monthly_confirmed, 0)} de {formatNumber(current, 0)} clientes · {monthlyCoverage}% cobertura</span></article>
      <article><small>Implementações confirmadas</small><strong>{formatMoney(summary.implementation_total_confirmed)}</strong><span>{formatNumber(summary.implementation_confirmed, 0)} clientes com valor confirmado</span></article>
      <article><small>Prazos confirmados</small><strong>{formatNumber(summary.term_confirmed, 0)}</strong><span>de {formatNumber(current, 0)} clientes atuais</span></article>
      <article><small>Em validação</small><strong>{formatNumber(Number(summary.monthly_candidates || 0) + Number(summary.implementation_candidates || 0), 0)}</strong><span>{formatNumber(summary.monthly_candidates, 0)} mensalidades · {formatNumber(summary.implementation_candidates, 0)} implementações</span></article>
    </section>

    <section className="finance-panel">
      <div className="finance-panel-head">
        <div><h2>Carteira financeira</h2><p>{rows.length} clientes no filtro · valores provisórios nunca entram nos totais.</p></div>
        <div className="finance-controls">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou responsável" />
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="CURRENT">Ativos + onboarding</option>
            <option value="ACTIVE">Ativos</option>
            <option value="ONBOARDING">Onboarding</option>
          </select>
          <select value={coverage} onChange={(event) => setCoverage(event.target.value)}>
            <option value="ALL">Toda a carteira</option>
            <option value="COMPLETE">Mensal + implementação confirmados</option>
            <option value="MISSING">Com informação faltante</option>
            <option value="CANDIDATE">Com candidato para validar</option>
          </select>
        </div>
      </div>

      <div className="finance-table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Status</th><th>Mensalidade</th><th>Implementação</th><th>Pagamento da implementação</th><th>Prazo</th><th>Fontes</th><th>Atualização</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const sources = sourceBadges(row);
              return <tr key={row.client_id}>
                <td><b>{text(row.display_name)}</b><small>GT: {text(row.gt_owner || "não vinculado")}</small></td>
                <td><span className={`status ${String(row.lifecycle).toLowerCase()}`}>{row.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}</span></td>
                <td>{displayValue(row.monthly_value, row.monthly_evidence?.provisional)}{row.monthly_evidence?.confirmed && <small>Confirmado via {sourceLabel(row.monthly_evidence.confirmed.source_type)}</small>}</td>
                <td>{displayValue(row.implementation_value, row.implementation_evidence?.provisional)}{row.implementation_evidence?.confirmed && <small>Confirmado via {sourceLabel(row.implementation_evidence.confirmed.source_type)}</small>}</td>
                <td>{row.implementation_payment ? <><span>{text(row.implementation_payment)}</span>{Array.isArray(row.implementation_installments) && row.implementation_installments.length > 0 && <small>{row.implementation_installments.length} parcelas cadastradas</small>}</> : row.payment_evidence?.provisional ? <span className="candidate">Candidato: {text(row.payment_evidence.provisional.text_value || row.payment_evidence.provisional.evidence_excerpt)}</span> : <span className="missing">Não confirmado</span>}</td>
                <td>{row.term_months != null ? <strong>{formatNumber(row.term_months, 0)} meses</strong> : row.term_evidence?.provisional ? <span className="candidate">Candidato: {formatNumber(row.term_evidence.provisional.numeric_value, 0)} meses · {sourceLabel(row.term_evidence.provisional.source_type)}</span> : <span className="missing">Não confirmado</span>}</td>
                <td><div className="source-list">{sources.length ? sources.map((source) => <span key={source}>{sourceLabel(source)}</span>) : <span className="missing">Sem evidência</span>}</div></td>
                <td>{row.commercial_updated_at ? <><span>{formatDate(row.commercial_updated_at)}</span><small>{text(row.canonical_source || "evidências vinculadas")}</small></> : <span className="missing">Sem consolidação</span>}</td>
              </tr>;
            })}
            {!rows.length && <tr><td colSpan={8} className="finance-empty">Nenhum cliente nesse filtro.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <section className="finance-note">
      <b>Regra de leitura:</b> “Confirmado” é dado já consolidado no banco. “Candidato” é evidência provisória encontrada em reunião/briefing/contrato e precisa de validação antes de virar número financeiro ou entrar nos totais.
    </section>
  </main>;
}
