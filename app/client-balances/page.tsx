"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "../shared";
import "./client-balances.css";

type Row = Record<string, any>;
type Payload = { ok?: boolean; profile?: Row; rows?: Row[]; summary?: Row; sync?: Row; generated_at?: string };
const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-balances-api`;

function money(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
}
function dateTime(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(d);
}
function method(row: Row) {
  if (!row.account_key) return "NONE";
  if (Number(row.funding_type) === 20) return "PIX";
  if (Number(row.funding_type) === 1) return "CARD";
  return "OTHER";
}
function methodLabel(row: Row) {
  const type = method(row);
  if (type === "PIX") return "PIX / pré-pago";
  if (type === "CARD") return "Cartão / pós-pago";
  if (type === "NONE") return "Sem conta Meta";
  return row.funding_type_label || "Forma não identificada";
}
function statusInfo(row: Row) {
  const status = String(row.run_status || "UNKNOWN");
  if (status === "OK") return { tone: "ok", label: method(row) === "CARD" ? "Apto para rodar" : "Saldo OK" };
  if (status === "NO_BALANCE") return { tone: "bad", label: "Saldo zerado" };
  if (status === "LOW_BALANCE") return { tone: "warn", label: "Saldo baixo" };
  if (status === "BLOCKED") return { tone: "bad", label: "Conta bloqueada" };
  if (status === "ATTENTION") return { tone: "warn", label: "Verificar veiculação" };
  if (status === "NO_ACTIVE_CAMPAIGN") return { tone: "neutral", label: "Sem campanha ativa" };
  if (status === "NO_ACCOUNT") return { tone: "neutral", label: "Sem conta Meta" };
  return { tone: "warn", label: "Não confirmado" };
}

export default function ClientBalancesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload>({ rows: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [payment, setPayment] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const autoRefreshAttempted = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setReady(true); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);

  const requestRefresh = useCallback(async (automatic = false) => {
    if (!session?.access_token || refreshing) return;
    setRefreshing(true); if (!automatic) setRefreshMessage("");
    try {
      const response = await authenticatedFetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      const result = body?.refresh || {};
      if (result.queued) setRefreshMessage("Nova leitura da Meta foi disparada por evento. A tela continua mostrando o último valor confirmado até a coleta concluir.");
      else if (result.reason === "cooldown") setRefreshMessage("A coleta recente ainda está dentro do cooldown de 60 minutos; não foi criado outro processamento.");
      else setRefreshMessage("Já existe uma atualização em andamento; nenhuma execução duplicada foi criada.");
    } catch (caught) { if (!automatic) setError(caught instanceof Error ? caught.message : "Falha ao solicitar atualização."); }
    finally { setRefreshing(false); }
  }, [session?.access_token, refreshing]);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      if (response.status === 403) { window.location.replace("/"); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setPayload(body);
      if (body?.sync?.refresh_recommended && !autoRefreshAttempted.current) {
        autoRefreshAttempted.current = true;
        void requestRefresh(true);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível carregar os saldos."); }
    finally { setLoading(false); }
  }, [session?.access_token, requestRefresh]);

  useEffect(() => { if (ready && session?.access_token) void load(); }, [ready, session?.access_token]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (payload.rows || []).filter((row) => {
      const type = method(row);
      const s = String(row.run_status || "UNKNOWN");
      const queryOk = !needle || [row.display_name,row.account_key,row.gt_owner,row.cs_owner,row.payment_display].join(" ").toLocaleLowerCase("pt-BR").includes(needle);
      const paymentOk = payment === "ALL" || type === payment;
      const statusOk = status === "ALL" || s === status || (status === "ATTENTION_GROUP" && ["LOW_BALANCE","ATTENTION","UNKNOWN"].includes(s)) || (status === "CRITICAL_GROUP" && ["NO_BALANCE","BLOCKED"].includes(s));
      return queryOk && paymentOk && statusOk;
    });
  }, [payload.rows, query, payment, status]);

  if (!ready || !session) return <main className="cb-shell">Validando sessão…</main>;
  const summary = payload.summary || {}, sync = payload.sync || {};

  return <main className="cb-shell">
    <header className="cb-top">
      <button className="cb-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
      <div className="cb-title"><small>OPERAÇÃO · MÍDIA</small><h1>Saldo Clientes</h1><p>PIX mostra saldo real. Cartão mostra se a conta está apta a continuar veiculando, sem inventar um “saldo” que a Meta não fornece.</p></div>
      <div className="cb-meta"><b>{payload.profile?.scope === "ALL" ? "Carteira completa" : "Sua carteira"}</b><br/>Última coleta: {dateTime(sync.last_success_at)}</div>
    </header>

    {error && <div className="cb-error">{error}</div>}
    {refreshMessage && <div className="cb-banner">{refreshMessage}</div>}
    {sync.age_minutes != null && Number(sync.age_minutes) >= 60 && <div className="cb-banner warn">A leitura tem {sync.age_minutes} min. Ao abrir esta aba, o sistema tenta disparar uma atualização por evento, respeitando o cooldown global de 60 min.</div>}

    <section className="cb-kpis">
      <article><small>CLIENTES</small><b>{summary.clients || 0}</b><span>{payload.profile?.scope === "ALL" ? "carteira visível" : "na sua carteira"}</span></article>
      <article><small>CONTAS PIX</small><b>{summary.prepaid || 0}</b><span>saldo disponível real</span></article>
      <article><small>CONTAS CARTÃO</small><b>{summary.cards || 0}</b><span>condição de veiculação</span></article>
      <article><small>CRÍTICOS</small><b>{summary.critical || 0}</b><span>zerado ou bloqueado</span></article>
      <article><small>SEM CONTA META</small><b>{summary.no_account || 0}</b><span>integração ausente</span></article>
    </section>

    <section className="cb-panel">
      <div className="cb-toolbar">
        <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar cliente, conta, GT ou CS…" />
        <select value={payment} onChange={(e)=>setPayment(e.target.value)}><option value="ALL">Todas as formas</option><option value="PIX">PIX / pré-pago</option><option value="CARD">Cartão</option><option value="NONE">Sem conta Meta</option></select>
        <select value={status} onChange={(e)=>setStatus(e.target.value)}><option value="ALL">Todos os status</option><option value="CRITICAL_GROUP">Críticos</option><option value="ATTENTION_GROUP">Atenção</option><option value="OK">OK / apto</option><option value="NO_ACTIVE_CAMPAIGN">Sem campanha ativa</option><option value="NO_ACCOUNT">Sem conta Meta</option></select>
        <button className="cb-refresh" onClick={()=>requestRefresh(false)} disabled={refreshing}>{refreshing ? "Solicitando…" : "Atualizar saldos"}</button>
        <button className="cb-refresh" onClick={load} disabled={loading}>{loading ? "Carregando…" : "Recarregar tela"}</button>
        <span className="cb-count">{rows.length} conta(s)/linha(s)</span>
      </div>
      <div className="cb-table-wrap"><table className="cb-table"><thead><tr><th>Cliente</th><th>Conta Meta</th><th>Forma</th><th>Saldo / condição</th><th>Gasto 7d</th><th>Autonomia / sinal</th><th>Última leitura</th></tr></thead><tbody>
        {rows.map((row,index)=>{ const type=method(row), info=statusInfo(row); return <tr key={`${row.client_id}:${row.account_key||"none"}:${index}`}>
          <td className="cb-client"><b>{row.display_name}</b><small>GT: {row.gt_owner || "—"}</small><small>CS: {row.cs_owner || "—"}</small></td>
          <td className="cb-account"><b>{row.account_key || "—"}</b><small>{row.payment_display || (row.account_key ? "Método não detalhado" : "Nenhuma conta vinculada")}</small></td>
          <td><span className={`cb-pill ${type === "PIX" ? "pix" : type === "CARD" ? "card" : "none"}`}>{methodLabel(row)}</span></td>
          <td className="cb-money">{type === "PIX" ? <><strong>{money(row.available_balance)}</strong><small>saldo disponível na Meta</small></> : type === "CARD" ? <><span className={`cb-status ${info.tone}`}>{info.label}</span><small>pós-pago: saldo bancário não é exposto pela Meta</small></> : <span className={`cb-status ${info.tone}`}>{info.label}</span>}</td>
          <td className="cb-money"><strong>{money(row.spend_7d)}</strong><small>média {money(row.avg_daily_spend)}/dia</small></td>
          <td className="cb-signal">{type === "PIX" ? <><span className={`cb-status ${info.tone}`}>{info.label}</span><small>{row.days_remaining != null ? `~${row.days_remaining} dia(s) no ritmo recente` : "sem gasto suficiente para estimar"}</small></> : type === "CARD" ? <><span className={`cb-status ${info.tone}`}>{info.label}</span><small>{Number(row.latest_day_spend||0)>0 ? `último dia com ${money(row.latest_day_spend)} de gasto` : `${row.active_campaigns||0} campanha(s) ativa(s) na última leitura de mídia`}</small></> : <span className={`cb-status ${info.tone}`}>{info.label}</span>}</td>
          <td><b>{dateTime(row.checked_at)}</b><small>{row.latest_spend_date ? `mídia até ${new Intl.DateTimeFormat("pt-BR").format(new Date(`${String(row.latest_spend_date).slice(0,10)}T12:00:00`))}` : "sem gasto recente estruturado"}</small></td>
        </tr>; })}
        {!rows.length && <tr><td colSpan={7} className="cb-empty">Nenhum cliente nesse filtro.</td></tr>}
      </tbody></table></div>
      <div className="cb-footer">Atualização por evento ao acessar a aba, com cooldown global de 60 minutos. O cron de segurança roda a cada 3 horas; não existe polling de 5 em 5 minutos.</div>
    </section>
  </main>;
}
