"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, formatDate, formatMoney, formatNumber, supabase, text } from "../shared";
import "./finance.css";

type Row = Record<string, any>;
type Payload = { ok?: boolean; profile?: Row; summary?: Row; rows?: Row[]; policy?: Row; generated_at?: string };
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-adler-finance-api`;

function sourceLabel(value: unknown) {
  const source = String(value || "").toUpperCase();
  return ({ BRIEFING: "Briefing", MEETING: "Reunião", CONTRACT: "Contrato", CRM: "CRM", MANUAL: "Manual" } as Record<string, string>)[source] || text(value || "—");
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
  for (const key of ["monthly_evidence", "implementation_evidence", "term_evidence", "payment_evidence"]) for (const source of row[key]?.source_types || []) sources.add(String(source));
  if (row.canonical_source) sources.add(String(row.canonical_source));
  return [...sources];
}
function field(value: unknown) { return value === null || value === undefined ? "" : String(value); }
function financialStatusLabel(row: Row) {
  if (row.inadimplente && row.juridico) return "Inadimplente + Jurídico";
  if (row.inadimplente) return "Inadimplente";
  if (row.juridico) return "Jurídico";
  return "Regular";
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
  const [financialStatus, setFinancialStatus] = useState("ALL");
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState<Row>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

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
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível carregar os valores comerciais."); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!authReady) return; if (!session) { window.location.assign("/"); return; } load(); }, [authReady, session?.access_token]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (payload.rows || []).filter((row) => {
      const matchesQuery = !needle || [row.display_name, row.gt_owner, row.cs_owner, row.canonical_source, financialStatusLabel(row)].join(" ").toLocaleLowerCase("pt-BR").includes(needle);
      const matchesStatus = status === "CURRENT" || row.lifecycle === status;
      const hasMonthly = row.monthly_value !== null && row.monthly_value !== undefined;
      const hasImplementation = row.implementation_value !== null && row.implementation_value !== undefined;
      const hasCandidate = (!hasMonthly && row.monthly_evidence?.provisional) || (!hasImplementation && row.implementation_evidence?.provisional);
      const matchesCoverage = coverage === "ALL" || (coverage === "COMPLETE" && hasMonthly && hasImplementation) || (coverage === "MISSING" && (!hasMonthly || !hasImplementation)) || (coverage === "CANDIDATE" && hasCandidate);
      const matchesFinancial = financialStatus === "ALL"
        || (financialStatus === "REGULAR" && !row.inadimplente && !row.juridico)
        || (financialStatus === "INADIMPLENTE" && row.inadimplente)
        || (financialStatus === "JURIDICO" && row.juridico)
        || (financialStatus === "EXCLUDED" && row.excluded_from_real_revenue);
      return matchesQuery && matchesStatus && matchesCoverage && matchesFinancial;
    });
  }, [payload.rows, query, status, coverage, financialStatus]);

  function openEditor(row: Row) {
    setEditing(row); setSaveError("");
    setForm({ monthly_value: field(row.monthly_value), implementation_value: field(row.implementation_value), term_months: field(row.term_months), implementation_payment: field(row.implementation_payment), notes: field(row.commercial_notes) });
  }
  async function save() {
    if (!editing || saving) return;
    setSaving(true); setSaveError("");
    try {
      const response = await authenticatedFetch(API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: editing.client_id, ...form }), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setEditing(null); await load();
    } catch (caught) { setSaveError(caught instanceof Error ? caught.message : "Não foi possível salvar."); }
    finally { setSaving(false); }
  }

  const summary = payload.summary || {};
  const current = Number(summary.current_clients || 0);
  const monthlyCoverage = current ? Math.round((Number(summary.monthly_confirmed || 0) / current) * 100) : 0;
  const implementationCoverage = current ? Math.round((Number(summary.implementation_confirmed || 0) / current) * 100) : 0;
  if (!authReady || !session) return <main className="finance-loading">Carregando…</main>;

  return <main className="finance-shell">
    <header className="finance-top"><button className="finance-back" onClick={() => window.location.assign("/")}>← Dashboard</button><div className="finance-brand"><span><BrandMark /></span><div><small>Leonardo Imobi</small><b>Mensalidades & Implementações</b></div></div><button className="finance-refresh" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></header>
    <section className="finance-hero"><div><span className="finance-eyebrow">DIREÇÃO · FINANCEIRO</span><h1>Valores comerciais da carteira</h1><p>Mensalidade, implementação, prazo e condição comercial. O faturamento real desconta automaticamente clientes classificados como inadimplentes ou jurídicos na aba Clientes.</p></div><div className="finance-generated">{payload.generated_at ? `Atualizado ${formatDate(payload.generated_at)}` : "Aguardando carga"}</div></section>
    {error && <div className="finance-error">{error}</div>}
    <section className="finance-kpis">
      <article><small>Faturamento real</small><strong>{formatMoney(summary.monthly_total_real)}</strong><span>{formatNumber(summary.regular_clients, 0)} clientes faturáveis · {formatMoney(summary.monthly_total_excluded)} fora do real</span></article>
      <article><small>MRR contratado</small><strong>{formatMoney(summary.monthly_total_confirmed)}</strong><span>{formatNumber(summary.monthly_confirmed, 0)} de {formatNumber(current, 0)} clientes · {monthlyCoverage}% cobertura</span></article>
      <article><small>Implementações confirmadas</small><strong>{formatMoney(summary.implementation_total_confirmed)}</strong><span>{formatNumber(summary.implementation_confirmed, 0)} clientes · {implementationCoverage}% cobertura</span></article>
      <article><small>Em validação</small><strong>{formatNumber(Number(summary.monthly_candidates || 0) + Number(summary.implementation_candidates || 0), 0)}</strong><span>{formatNumber(summary.excluded_from_real_revenue_clients, 0)} fora do faturamento real</span></article>
    </section>
    <div className="finance-note"><b>Regra do faturamento real:</b> parte do MRR confirmado e exclui clientes marcados como Inadimplente ou Jurídico. Se o mesmo cliente estiver nos dois status, a mensalidade é descontada uma única vez.</div>
    <section className="finance-panel"><div className="finance-panel-head"><div><h2>Carteira financeira</h2><p>{rows.length} clientes no filtro · o status financeiro/jurídico vem da classificação feita pelo Leonardo na aba Clientes.</p></div><div className="finance-controls"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou responsável" /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="CURRENT">Ativos + onboarding</option><option value="ACTIVE">Ativos</option><option value="ONBOARDING">Onboarding</option></select><select value={financialStatus} onChange={(event) => setFinancialStatus(event.target.value)}><option value="ALL">Financeiro: todos</option><option value="REGULAR">Regulares</option><option value="INADIMPLENTE">Inadimplentes</option><option value="JURIDICO">Jurídico</option><option value="EXCLUDED">Fora do faturamento real</option></select><select value={coverage} onChange={(event) => setCoverage(event.target.value)}><option value="ALL">Toda a carteira</option><option value="COMPLETE">Completo</option><option value="MISSING">Com informação faltante</option><option value="CANDIDATE">Com candidato</option></select></div></div>
      <div className="finance-table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Mensalidade</th><th>Implementação</th><th>Pagamento</th><th>Prazo</th><th>Fontes</th><th>Atualização</th><th></th></tr></thead><tbody>{rows.map((row) => { const sources = sourceBadges(row); const financialLabel = financialStatusLabel(row); return <tr key={row.client_id}><td><b>{text(row.display_name)}</b><small>GT: {text(row.gt_owner || "não vinculado")}</small></td><td><span className={`status ${String(row.lifecycle).toLowerCase()}`}>{row.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}</span><small style={{marginTop:6,fontWeight:800,color:row.excluded_from_real_revenue?"#e6c66f":"#82e6b9"}}>{financialLabel}</small></td><td>{displayValue(row.monthly_value, row.monthly_evidence?.provisional)}</td><td>{displayValue(row.implementation_value, row.implementation_evidence?.provisional)}</td><td>{row.implementation_payment ? text(row.implementation_payment) : <span className="missing">Não confirmado</span>}</td><td>{row.term_months != null ? <strong>{formatNumber(row.term_months, 0)} meses</strong> : <span className="missing">Não confirmado</span>}</td><td><div className="source-list">{sources.length ? sources.map((source) => <span key={source}>{sourceLabel(source)}</span>) : <span className="missing">Sem evidência</span>}</div></td><td>{row.commercial_updated_at ? <><span>{formatDate(row.commercial_updated_at)}</span><small>{text(row.commercial_updated_by || row.canonical_source || "evidências vinculadas")}</small></> : <span className="missing">Sem consolidação</span>}</td><td><button className="finance-refresh" onClick={() => openEditor(row)}>Editar</button></td></tr>; })}{!rows.length && <tr><td colSpan={9} className="finance-empty">Nenhum cliente nesse filtro.</td></tr>}</tbody></table></div>
    </section>
    {editing && <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,.72)",display:"grid",placeItems:"center",padding:20}} onMouseDown={(e)=>{if(e.currentTarget===e.target&&!saving)setEditing(null)}}><section className="finance-panel" style={{width:"min(720px,96vw)",margin:0}}><div className="finance-panel-head"><div><h2>Editar · {text(editing.display_name)}</h2><p>Alteração manual registrada com o usuário autenticado.</p></div><button className="finance-refresh" onClick={()=>setEditing(null)} disabled={saving}>Fechar</button></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><label>Mensalidade<input className="control" type="number" min="0" step="0.01" value={form.monthly_value||""} onChange={e=>setForm(v=>({...v,monthly_value:e.target.value}))}/></label><label>Implementação<input className="control" type="number" min="0" step="0.01" value={form.implementation_value||""} onChange={e=>setForm(v=>({...v,implementation_value:e.target.value}))}/></label><label>Prazo (meses)<input className="control" type="number" min="1" max="120" value={form.term_months||""} onChange={e=>setForm(v=>({...v,term_months:e.target.value}))}/></label><label>Pagamento da implementação<input className="control" value={form.implementation_payment||""} onChange={e=>setForm(v=>({...v,implementation_payment:e.target.value}))}/></label></div><label style={{display:"block",marginTop:12}}>Observações<textarea className="control" style={{width:"100%",minHeight:100}} value={form.notes||""} onChange={e=>setForm(v=>({...v,notes:e.target.value}))}/></label>{saveError&&<div className="finance-error" style={{marginTop:12}}>{saveError}</div>}<div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:14}}><button className="finance-refresh" onClick={()=>setEditing(null)} disabled={saving}>Cancelar</button><button className="finance-refresh" onClick={save} disabled={saving}>{saving?"Salvando…":"Salvar alterações"}</button></div></section></div>}
  </main>;
}
