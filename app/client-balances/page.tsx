"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "../shared";
import "./client-balances.css";

type Row = Record<string, any>;
type Payload = { ok?: boolean; profile?: Row; rows?: Row[]; summary?: Row; sync?: Row; generated_at?: string };
type Segment = "PIX" | "CARD" | "NONE" | "ALL";
type Wallet = "ALL" | "Alfa" | "Bravo" | "Charlie";
const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-balances-api`;

function numberValue(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function money(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }) : "—";
}
function dateTime(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(d);
}
function method(row: Row): Segment | "OTHER" {
  if (!row.account_key) return "NONE";
  if (Number(row.funding_type) === 20) return "PIX";
  if (Number(row.funding_type) === 1) return "CARD";
  return "OTHER";
}
function metaBillingUrl(row: Row) {
  const id = String(row.meta_ad_account_id || "").replace(/^act_/i, "").trim();
  if (!/^\d+$/.test(id)) return null;
  const encoded = encodeURIComponent(id);
  return `https://business.facebook.com/billing_hub/accounts/details?asset_id=${encoded}&placement=ads_manager&payment_account_id=${encoded}`;
}
function cardStatus(row: Row) {
  const status = String(row.run_status || "UNKNOWN");
  if (status === "OK") return { tone: "ok", label: "Apto para rodar" };
  if (status === "BLOCKED") return { tone: "bad", label: "Conta bloqueada" };
  if (status === "ATTENTION") return { tone: "warn", label: "Verificar veiculação" };
  if (status === "NO_ACTIVE_CAMPAIGN") return { tone: "neutral", label: "Sem campanha ativa" };
  return { tone: "warn", label: "Não confirmado" };
}
function runwayTone(row: Row) {
  const balance = numberValue(row.available_balance);
  const days = row.days_remaining == null ? null : numberValue(row.days_remaining);
  if (balance <= 0) return "bad";
  if (days !== null && days <= 2) return "bad";
  if (days !== null && days <= 5) return "warn";
  return "ok";
}
function runwayLabel(row: Row) {
  const balance = numberValue(row.available_balance);
  const avg = numberValue(row.avg_daily_spend);
  const days = row.days_remaining == null ? null : numberValue(row.days_remaining);
  if (balance <= 0) return "0 dias";
  if (avg <= 0 || days === null) return "Sem média recente";
  if (days < 1) return "< 1 dia";
  return `${days.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}
function reportStatus(row: Row) {
  const type = method(row);
  if (type === "PIX") {
    const balance = numberValue(row.available_balance);
    const days = row.days_remaining == null ? null : numberValue(row.days_remaining);
    if (balance <= 0) return "RECARREGAR AGORA";
    if (days !== null && days <= 2) return "URGENTE";
    if (days !== null && days <= 5) return "ATENÇÃO";
    return "OK";
  }
  if (type === "CARD") return cardStatus(row).label;
  if (type === "NONE") return "Sem conta Meta vinculada";
  return String(row.run_status || "Não confirmado");
}
function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
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
  const [segment, setSegment] = useState<Segment>("PIX");
  const [urgency, setUrgency] = useState("ALL");
  const [wallet, setWallet] = useState<Wallet>("ALL");
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
      if (result.queued) setRefreshMessage("Nova leitura da Meta disparada. Até concluir, os números abaixo continuam mostrando a última leitura confirmada.");
      else if (result.reason === "cooldown") setRefreshMessage("A leitura é recente. O cooldown de 60 minutos evitou uma coleta duplicada.");
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

  const allRows = payload.rows || [];
  const walletRows = useMemo(() => allRows.filter((row) => wallet === "ALL" || String(row.carteira || "") === wallet), [allRows, wallet]);
  const pixRows = useMemo(() => walletRows.filter((row) => method(row) === "PIX"), [walletRows]);
  const cardRows = useMemo(() => walletRows.filter((row) => method(row) === "CARD"), [walletRows]);
  const noAccountRows = useMemo(() => walletRows.filter((row) => method(row) === "NONE"), [walletRows]);

  const portfolio = useMemo(() => {
    const totalBalance = pixRows.reduce((sum, row) => sum + numberValue(row.available_balance), 0);
    const avgPerDay = pixRows.reduce((sum, row) => sum + numberValue(row.avg_daily_spend), 0);
    const zero = pixRows.filter((row) => numberValue(row.available_balance) <= 0).length;
    const upTo2 = pixRows.filter((row) => numberValue(row.available_balance) > 0 && row.days_remaining != null && numberValue(row.days_remaining) <= 2).length;
    const threeTo5 = pixRows.filter((row) => row.days_remaining != null && numberValue(row.days_remaining) > 2 && numberValue(row.days_remaining) <= 5).length;
    const cardsOk = cardRows.filter((row) => String(row.run_status) === "OK").length;
    return { totalBalance, avgPerDay, zero, upTo2, threeTo5, cardsOk };
  }, [pixRows, cardRows]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return walletRows
      .filter((row) => {
        const type = method(row);
        const queryOk = !needle || [row.display_name,row.account_key,row.gt_owner,row.cs_owner,row.payment_display,row.carteira].join(" ").toLocaleLowerCase("pt-BR").includes(needle);
        const segmentOk = segment === "ALL" || type === segment;
        let urgencyOk = true;
        if (urgency !== "ALL") {
          if (type === "PIX") {
            const balance = numberValue(row.available_balance), days = row.days_remaining == null ? null : numberValue(row.days_remaining);
            urgencyOk = urgency === "ZERO" ? balance <= 0 : urgency === "UP_TO_2" ? balance > 0 && days !== null && days <= 2 : urgency === "UP_TO_5" ? balance > 0 && days !== null && days > 2 && days <= 5 : urgency === "HEALTHY" ? balance > 0 && (days === null || days > 5) : true;
          } else if (type === "CARD") urgencyOk = urgency === "HEALTHY" ? String(row.run_status) === "OK" : urgency === "PROBLEM" ? ["BLOCKED","ATTENTION","UNKNOWN"].includes(String(row.run_status)) : true;
        }
        return queryOk && segmentOk && urgencyOk;
      })
      .sort((a, b) => {
        const ta = method(a), tb = method(b);
        if (ta === "PIX" && tb === "PIX") {
          const da = a.days_remaining == null ? Number.POSITIVE_INFINITY : numberValue(a.days_remaining);
          const db = b.days_remaining == null ? Number.POSITIVE_INFINITY : numberValue(b.days_remaining);
          return da - db || numberValue(a.available_balance) - numberValue(b.available_balance) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR");
        }
        if (ta === "CARD" && tb === "CARD") {
          const rank = (row: Row) => String(row.run_status) === "BLOCKED" ? 0 : String(row.run_status) === "ATTENTION" ? 1 : String(row.run_status) === "UNKNOWN" ? 2 : String(row.run_status) === "NO_ACTIVE_CAMPAIGN" ? 3 : 4;
          return rank(a) - rank(b) || numberValue(b.spend_7d) - numberValue(a.spend_7d);
        }
        const order: Record<string, number> = { PIX: 0, CARD: 1, OTHER: 2, NONE: 3 };
        return (order[ta] ?? 9) - (order[tb] ?? 9);
      });
  }, [walletRows, query, segment, urgency]);

  const exportReport = useCallback(() => {
    const reportRows = [...walletRows].sort((a, b) => {
      const walletCompare = String(a.carteira || "").localeCompare(String(b.carteira || ""), "pt-BR");
      if (walletCompare) return walletCompare;
      const gtCompare = String(a.gt_owner || "").localeCompare(String(b.gt_owner || ""), "pt-BR");
      if (gtCompare) return gtCompare;
      if (method(a) === "PIX" && method(b) === "PIX") {
        const da = a.days_remaining == null ? Number.POSITIVE_INFINITY : numberValue(a.days_remaining);
        const db = b.days_remaining == null ? Number.POSITIVE_INFINITY : numberValue(b.days_remaining);
        if (da !== db) return da - db;
      }
      return String(a.display_name || "").localeCompare(String(b.display_name || ""), "pt-BR");
    });
    const headers = ["Carteira","GT","CS","Cliente","Pagamento","Saldo atual","Média/dia","Dias restantes","Gasto 7d","Situação","Conta Meta","Última leitura","Link cobrança"];
    const lines = reportRows.map((row) => {
      const type = method(row);
      const billingUrl = type === "PIX" ? metaBillingUrl(row) || "" : "";
      const payment = type === "PIX" ? "PIX / pré-pago" : type === "CARD" ? "Cartão / pós-pago" : type === "NONE" ? "Sem conta" : "Outro";
      return [
        row.carteira || "Sem carteira",
        row.gt_owner || "",
        row.cs_owner || "",
        row.display_name || "",
        payment,
        type === "PIX" ? numberValue(row.available_balance).toFixed(2).replace(".",",") : "",
        numberValue(row.avg_daily_spend).toFixed(2).replace(".",","),
        row.days_remaining == null ? "" : numberValue(row.days_remaining).toFixed(1).replace(".",","),
        numberValue(row.spend_7d).toFixed(2).replace(".",","),
        reportStatus(row),
        row.account_key || "",
        dateTime(row.checked_at),
        billingUrl,
      ].map(csvCell).join(";");
    });
    const csv = `\uFEFF${headers.map(csvCell).join(";")}\n${lines.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const scope = wallet === "ALL" ? "geral" : wallet.toLocaleLowerCase("pt-BR");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    link.href = href;
    link.download = `saldo-clientes-${scope}-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }, [walletRows, wallet]);

  useEffect(() => { setUrgency("ALL"); }, [segment]);

  if (!ready || !session) return <main className="cb-shell">Validando sessão…</main>;
  const sync = payload.sync || {};

  return <main className="cb-shell">
    <header className="cb-top">
      <button className="cb-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
      <div className="cb-title"><small>OPERAÇÃO · SALDO DE MÍDIA</small><h1>Saldo Clientes</h1><p>Quanto resta, quanto o cliente costuma gastar por dia e quantos dias de mídia ainda existem.</p></div>
      <div className="cb-meta"><b>{wallet === "ALL" ? (payload.profile?.scope === "ALL" ? "Carteira completa" : "Sua carteira") : `Carteira ${wallet}`}</b><br/>Última leitura: {dateTime(sync.last_success_at)}</div>
    </header>

    {error && <div className="cb-error">{error}</div>}
    {refreshMessage && <div className="cb-banner">{refreshMessage}</div>}
    {sync.age_minutes != null && Number(sync.age_minutes) >= 60 && <div className="cb-banner warn">Leitura com {sync.age_minutes} min. A abertura da aba já tenta atualizar por evento, respeitando o cooldown para não pesar o banco.</div>}

    <section className="cb-kpis cb-kpis-focus">
      <article className="primary"><small>SALDO PIX DISPONÍVEL</small><b>{money(portfolio.totalBalance)}</b><span>soma das contas pré-pagas visíveis</span></article>
      <article><small>RITMO MÉDIO / DIA</small><b>{money(portfolio.avgPerDay)}</b><span>média dos últimos 7 dias</span></article>
      <article className={portfolio.zero ? "danger" : ""}><small>SALDO ZERADO</small><b>{portfolio.zero}</b><span>precisam de recarga</span></article>
      <article className={portfolio.upTo2 ? "danger" : ""}><small>ATÉ 2 DIAS</small><b>{portfolio.upTo2}</b><span>risco imediato</span></article>
      <article className={portfolio.threeTo5 ? "warning" : ""}><small>3 A 5 DIAS</small><b>{portfolio.threeTo5}</b><span>planejar reposição</span></article>
    </section>

    <section className="cb-panel">
      <div className="cb-segments">
        <button className={segment === "PIX" ? "active" : ""} onClick={()=>setSegment("PIX")}>Saldo PIX <b>{pixRows.length}</b></button>
        <button className={segment === "CARD" ? "active" : ""} onClick={()=>setSegment("CARD")}>Cartão <b>{cardRows.length}</b></button>
        <button className={segment === "NONE" ? "active" : ""} onClick={()=>setSegment("NONE")}>Sem conta <b>{noAccountRows.length}</b></button>
        <button className={segment === "ALL" ? "active" : ""} onClick={()=>setSegment("ALL")}>Todos</button>
      </div>

      <div className="cb-toolbar">
        <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou conta Meta…" />
        <select value={wallet} onChange={(e)=>setWallet(e.target.value as Wallet)} aria-label="Filtrar por carteira">
          <option value="ALL">Geral · todas as carteiras</option>
          <option value="Alfa">Alfa · Rodrigo Cavalheiro</option>
          <option value="Bravo">Bravo · Felipe Oliveira</option>
          <option value="Charlie">Charlie · Yuri Melo</option>
        </select>
        {segment === "PIX" && <select value={urgency} onChange={(e)=>setUrgency(e.target.value)}><option value="ALL">Todas as autonomias</option><option value="ZERO">Saldo zerado</option><option value="UP_TO_2">Até 2 dias</option><option value="UP_TO_5">3 a 5 dias</option><option value="HEALTHY">Mais de 5 dias / sem média</option></select>}
        {segment === "CARD" && <select value={urgency} onChange={(e)=>setUrgency(e.target.value)}><option value="ALL">Todos os cartões</option><option value="PROBLEM">Com atenção</option><option value="HEALTHY">Aptos</option></select>}
        <button className="cb-refresh" onClick={exportReport}>Extrair relatório</button>
        <button className="cb-refresh" onClick={()=>requestRefresh(false)} disabled={refreshing}>{refreshing ? "Solicitando…" : "Atualizar leitura"}</button>
        <button className="cb-refresh secondary" onClick={load} disabled={loading}>{loading ? "Carregando…" : "Recarregar tela"}</button>
        <span className="cb-count">{rows.length} resultado(s)</span>
      </div>

      {segment === "PIX" && <div className="cb-explain">Ordenado automaticamente por <b>menor autonomia primeiro</b>. A média diária é o gasto dos últimos 7 dias dividido pelos dias do período disponível.</div>}
      {segment === "CARD" && <div className="cb-explain">Cartão não possui saldo disponível exposto pela Meta. Aqui mostramos apenas <b>capacidade de veiculação + ritmo de gasto</b>, sem inventar limite restante.</div>}

      <div className="cb-table-wrap"><table className="cb-table cb-table-focus"><thead>
        {segment === "CARD" ? <tr><th>Cliente</th><th>Situação</th><th>Média / dia</th><th>Gasto 7d</th><th>Último sinal</th><th>Conta</th><th>Leitura</th></tr> : segment === "NONE" ? <tr><th>Cliente</th><th>GT</th><th>CS</th><th>Situação</th></tr> : <tr><th>Cliente</th><th>Saldo agora</th><th>Média / dia</th><th>Dias restantes</th><th>Gasto 7d</th><th>Conta</th><th>Leitura</th></tr>}
      </thead><tbody>
        {rows.map((row,index)=>{
          const type=method(row);
          if(type === "PIX") {
            const tone=runwayTone(row), billingUrl=metaBillingUrl(row), emptyBalance=numberValue(row.available_balance)<=0;
            return <tr key={`${row.client_id}:${row.account_key}:${index}`} className={`cb-runway-row ${tone}`}>
              <td className="cb-client"><b>{row.display_name}</b><small>{row.carteira ? `${row.carteira} · ` : ""}GT: {row.gt_owner || "—"} · CS: {row.cs_owner || "—"}</small></td>
              <td className="cb-balance"><strong>{money(row.available_balance)}</strong><small>disponível agora</small></td>
              <td className="cb-daily"><strong>{money(row.avg_daily_spend)}</strong><small>por dia · {row.spend_window_days || 7}d</small></td>
              <td className="cb-days"><strong>{runwayLabel(row)}</strong>{emptyBalance && billingUrl ? <a className={`cb-status ${tone} cb-recharge-link`} href={billingUrl} target="_blank" rel="noopener noreferrer" title={`Abrir cobrança da conta ${row.account_key} na Meta`}>Recarregar agora ↗</a> : <span className={`cb-status ${tone}`}>{emptyBalance ? "Recarga indisponível" : row.days_remaining != null && numberValue(row.days_remaining)<=2 ? "Urgente" : row.days_remaining != null && numberValue(row.days_remaining)<=5 ? "Atenção" : "OK"}</span>}</td>
              <td className="cb-money"><strong>{money(row.spend_7d)}</strong><small>últimos 7 dias</small></td>
              <td className="cb-account"><b>{row.account_key}</b><small>{row.payment_display || "PIX / pré-pago"}</small></td>
              <td><b>{dateTime(row.checked_at)}</b><small>{row.latest_spend_date ? `mídia até ${String(row.latest_spend_date).slice(0,10).split("-").reverse().join("/")}` : "sem mídia recente"}</small></td>
            </tr>;
          }
          if(type === "CARD") { const info=cardStatus(row); return <tr key={`${row.client_id}:${row.account_key}:${index}`}>
            <td className="cb-client"><b>{row.display_name}</b><small>{row.carteira ? `${row.carteira} · ` : ""}GT: {row.gt_owner || "—"} · CS: {row.cs_owner || "—"}</small></td>
            <td><span className={`cb-status ${info.tone}`}>{info.label}</span></td>
            <td className="cb-daily"><strong>{money(row.avg_daily_spend)}</strong><small>por dia · {row.spend_window_days || 7}d</small></td>
            <td className="cb-money"><strong>{money(row.spend_7d)}</strong><small>últimos 7 dias</small></td>
            <td className="cb-signal"><strong>{numberValue(row.latest_day_spend)>0 ? money(row.latest_day_spend) : "—"}</strong><small>{numberValue(row.latest_day_spend)>0 ? "no último dia com mídia" : `${row.active_campaigns||0} campanha(s) ativa(s)`}</small></td>
            <td className="cb-account"><b>{row.account_key}</b><small>{row.payment_display || "Cartão / pós-pago"}</small></td>
            <td><b>{dateTime(row.checked_at)}</b></td>
          </tr>; }
          return <tr key={`${row.client_id}:none:${index}`}><td className="cb-client"><b>{row.display_name}</b><small>{row.carteira || "Sem carteira"}</small></td><td>{row.gt_owner || "—"}</td><td>{row.cs_owner || "—"}</td><td><span className="cb-status neutral">Sem conta Meta vinculada</span></td></tr>;
        })}
        {!rows.length && <tr><td colSpan={7} className="cb-empty">Nenhum cliente nesse filtro.</td></tr>}
      </tbody></table></div>
      <div className="cb-footer">Atualização por evento ao acessar a aba, cooldown global de 60 min e cron de segurança a cada 3 horas.</div>
    </section>
  </main>;
}
