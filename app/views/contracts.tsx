"use client";

import { useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, Chip, formatDate, formatDay, formatNumber, text } from "../shared";
import type { Row } from "../shared";

const CONTRACTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-contracts-api`;

function contractLabel(state: string) {
  const labels: Record<string, string> = {
    ACTIVE: "Contrato vigente",
    EXPIRING_60: "Vence em até 60 dias",
    EXPIRING_30: "Vence em até 30 dias",
    EXPIRING_15: "Vence em até 15 dias",
    EXPIRING_7: "Vence em até 7 dias",
    EXPIRED: "Contrato vencido",
    TERM_UNKNOWN: "Vigência a identificar",
    NO_CONTRACT: "Sem contrato localizado",
  };
  return labels[state] || state || "—";
}

function contractTone(state: string) {
  if (state === "ACTIVE") return "#22c55e";
  if (["EXPIRING_60", "EXPIRING_30"].includes(state)) return "#f59e0b";
  if (["EXPIRING_15", "EXPIRING_7", "EXPIRED"].includes(state)) return "#ef4444";
  return "#94a3b8";
}

function daysLabel(days: unknown, state: string) {
  if (days === null || days === undefined) return "—";
  const n = Number(days);
  if (state === "EXPIRED" || n < 0) return `Venceu há ${Math.abs(n)} dia${Math.abs(n) === 1 ? "" : "s"}`;
  if (n === 0) return "Vence hoje";
  return `${n} dia${n === 1 ? "" : "s"} restantes`;
}

export function ContractsCenter({ token }: { token: string }) {
  const [payload, setPayload] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");
  const [lifecycle, setLifecycle] = useState("ACTIVE");

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch(CONTRACTS_API, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) throw new Error(response.status === 404 ? "Área privada indisponível para este usuário." : "Falha ao carregar contratos.");
      setPayload(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar contratos.");
      setPayload(null);
    } finally { setLoading(false); }
  }

  async function markAllRead() {
    await fetch(CONTRACTS_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_all_notifications_read" }),
    });
    await load();
  }

  useEffect(() => { load(); }, [token]);

  const summary = payload?.summary || {};
  const contracts = payload?.contracts || [];
  const notifications = payload?.notifications || [];
  const unread = notifications.filter((n: Row) => !n.read_at).length;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return contracts.filter((row: Row) => {
      const lifecycleOk = lifecycle === "ALL" || (lifecycle === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(row.lifecycle) : row.lifecycle === lifecycle);
      const stateOk = state === "ALL" || row.contract_state === state;
      const searchOk = !needle || [row.display_name, row.document_name, row.cs_owner, row.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle);
      return lifecycleOk && stateOk && searchOk;
    });
  }, [contracts, query, state, lifecycle]);

  if (error) return <section className="workspace"><div className="error-box">{error}</div></section>;

  return <section className="workspace">
    <div className="workspace-head">
      <div>
        <span className="eyebrow">PRIVADO · ADLER ONLY</span>
        <h2>Contratos</h2>
        <p>Autentique, vigência, renovação e cruzamento com atividade operacional.</p>
      </div>
      <button className="btn" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar contratos"}</button>
    </div>

    <section className="grid kpis">
      {[
        ["Clientes ativos", summary.active_clients, "#60a5fa"],
        ["Contratos OK", summary.contracts_ok, "#22c55e"],
        ["Vencendo", summary.expiring, "#f59e0b"],
        ["Vencidos + cliente ativo", summary.expired_active, "#ef4444"],
        ["Vigência desconhecida", summary.term_unknown, "#a78bfa"],
        ["Sem contrato localizado", summary.no_contract, "#94a3b8"],
      ].map(([label, value, color]) => <article key={String(label)} className="card" style={{ padding: 15, borderColor: `${color}33` }}>
        <small style={{ color: "#94a3b8", fontSize: 11 }}>{String(label)}</small>
        <div style={{ fontSize: 27, lineHeight: 1, fontWeight: 800, marginTop: 8, color: String(color) }}>{formatNumber(value)}</div>
      </article>)}
    </section>

    {Number(payload?.source?.documents_ingested || 0) === 0 && <div className="media-note" style={{ marginBottom: 14 }}>
      ⚠ A estrutura privada já está pronta, mas ainda há <b>0 documentos da Autentique ingeridos</b>. Enquanto o backfill/API não for conectado, os clientes aparecem como “Sem contrato localizado”.
    </div>}

    <section className="card section">
      <div className="section-head">
        <div>
          <div className="section-title">Carteira contratual</div>
          <div className="subtitle">{filtered.length} registros no filtro · fonte: {text(payload?.source?.provider || "Autentique")}</div>
        </div>
        <div className="toolbar">
          <input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, CS, GT ou documento" />
          <select className="control" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
            <option value="ACTIVE">Clientes atuais</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option>
          </select>
          <select className="control" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="ALL">Todos os estados</option>
            <option value="ACTIVE">Contrato vigente</option><option value="EXPIRING_60">Vence em 60 dias</option><option value="EXPIRING_30">Vence em 30 dias</option><option value="EXPIRING_15">Vence em 15 dias</option><option value="EXPIRING_7">Vence em 7 dias</option><option value="EXPIRED">Vencido</option><option value="TERM_UNKNOWN">Vigência desconhecida</option><option value="NO_CONTRACT">Sem contrato</option>
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Status cliente</th><th>Contrato</th><th>Vigência</th><th>Prazo</th><th>Operação 30d</th><th>Situação</th><th>Documento</th></tr></thead>
          <tbody>{filtered.map((row: Row) => {
            const operationalAfterExpiry = row.contract_state === "EXPIRED" && ["ACTIVE", "ONBOARDING"].includes(row.lifecycle) && Number(row.tasks_last_30d || 0) > 0;
            return <tr key={row.client_id}>
              <td><div className="name">{text(row.display_name)}</div><div className="small">CS: {text(row.cs_owner)} · GT: {text(row.gt_owner)}</div></td>
              <td><Chip value={row.lifecycle} /></td>
              <td><div>{text(row.document_name)}</div><div className="small">{text(row.document_status)}</div></td>
              <td><div>{formatDay(row.contract_start_date)} → {formatDay(row.contract_end_date)}</div><div className="small">{row.term_confidence != null ? `Confiança: ${Math.round(Number(row.term_confidence) * 100)}%` : text(row.term_source)}</div></td>
              <td><b style={{ color: contractTone(row.contract_state) }}>{daysLabel(row.days_remaining, row.contract_state)}</b></td>
              <td><div>{formatNumber(row.tasks_last_30d)} tasks</div><div className="small">Última: {row.last_task_at ? formatDate(row.last_task_at) : "sem atividade recente"}</div></td>
              <td><div style={{ color: contractTone(row.contract_state), fontWeight: 700 }}>{contractLabel(row.contract_state)}</div>{operationalAfterExpiry && <div className="small" style={{ color: "#fca5a5", marginTop: 4 }}>RENOVAÇÃO NECESSÁRIA · cliente segue operando</div>}{row.renewal_pending && <div className="small" style={{ color: "#fbbf24" }}>Novo documento em processo de renovação</div>}</td>
              <td>{row.signed_file_url || row.original_file_url ? <a className="btn" href={row.signed_file_url || row.original_file_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Abrir</a> : <span className="small">—</span>}</td>
            </tr>;
          })}{!filtered.length && <tr><td colSpan={8} className="empty">Nenhum contrato nesse filtro.</td></tr>}</tbody>
        </table>
      </div>
    </section>

    <section className="card section" style={{ marginTop: 14 }}>
      <div className="section-head"><div><div className="section-title">Alertas privados de contratos</div><div className="subtitle">Somente Adler · {unread} não lido(s)</div></div>{unread > 0 && <button className="btn" onClick={markAllRead}>Marcar como lidos</button>}</div>
      <div className="notification-list">{notifications.slice(0, 30).map((item: Row) => <div className={`notification-action${item.read_at ? "" : " unread"}`} key={item.id}><Chip value={item.level}/><span><b>{text(item.title)}</b><small>{text(item.description)} · {formatDate(item.occurred_at)}</small></span></div>)}{!notifications.length && <div className="empty">Nenhum alerta contratual privado.</div>}</div>
    </section>
  </section>;
}
