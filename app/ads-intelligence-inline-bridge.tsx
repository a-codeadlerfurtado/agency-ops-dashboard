"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, initials, supabase } from "./shared";

type Row = Record<string, any>;
type Tab = "decision" | "campaigns" | "benchmark" | "ai";
type CacheEntry = { at: number; body: Row };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-api`;
const AI_API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-consultant-ai`;
const CAMPAIGN_ACTION_API = `${SUPABASE_URL}/functions/v1/agency-ops-campaign-inline-action-v2`;
const DETAIL_CACHE_MS = 60_000;
const LIST_CACHE_MS = 45_000;
const AI_TIMEOUT_MS = 25_000;

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const money = (value: unknown) => finite(value) === null ? "—" : formatMoney(value);
const number = (value: unknown, digits = 0) => finite(value) === null ? "—" : formatNumber(value, digits);
const percent = (value: unknown, digits = 1) => finite(value) === null ? "—" : `${number(value, digits)}%`;

function remainingDaysLabel(value: unknown) {
  const days = finite(value);
  if (days === null) return "dias restantes indisponíveis";
  const rounded = Math.max(0, Math.round(days));
  return rounded === 1 ? "1 dia restante" : `${rounded} dias restantes`;
}
function paceLabel(status: string) {
  if (status === "OVER_PACE") return "Acima do ritmo";
  if (status === "UNDER_PACE") return "Abaixo do ritmo";
  if (status === "BUDGET_REACHED") return "Budget atingido";
  if (status === "MTD_UNAVAILABLE") return "Leitura MTD pendente";
  if (status === "NO_BUDGET") return "Budget não validado";
  return "No ritmo";
}
function paceTone(status: string) {
  if (["BUDGET_REACHED", "NO_BUDGET"].includes(status)) return "critical";
  if (["OVER_PACE", "MTD_UNAVAILABLE"].includes(status)) return "warn";
  if (status === "UNDER_PACE") return "info";
  return "good";
}
function priorityLabel(value: string) {
  if (value === "CRITICAL") return "Crítica";
  if (value === "HIGH") return "Alta";
  if (value === "MEDIUM") return "Média";
  return "Baixa";
}
function priorityTone(value: string) {
  if (value === "CRITICAL") return "critical";
  if (value === "HIGH") return "warn";
  if (value === "MEDIUM") return "info";
  return "good";
}
function categoryLabel(value: string) {
  const labels: Record<string, string> = {
    BUDGET: "Budget", DELIVERY: "Entrega", BALANCE: "Saldo", CREATIVE: "Criativo",
    FUNNEL: "Funil", PERFORMANCE: "Performance", REALLOCATION: "Redistribuição",
    PACING: "Pacing", HOLD: "Manter",
  };
  return labels[value] || value;
}

function buildAiPrompt(detail: Row) {
  const compact = {
    cliente: {
      nome: detail.client?.display_name,
      gt: detail.client?.gt_owner,
      cs: detail.client?.cs_owner,
    },
    budget: detail.budget,
    pacing: detail.pacing,
    benchmark_interno: detail.benchmark,
    meta_7d: detail.windows?.[7] || detail.windows?.["7"] || null,
    meta_7d_anterior: detail.previous_7d || null,
    campanhas: (detail.campaigns || []).slice(0, 30).map((c: Row) => ({
      id: c.campaign_id, nome: c.campaign_name, status: c.campaign_status,
      gasto: c.spend, resultados: c.results, cpr: c.cost_per_result ?? c.cpl,
      ctr: c.ctr, cpm: c.cpm, frequencia: c.frequency,
    })),
    criativos: (detail.creatives || []).slice(0, 20).map((c: Row) => ({
      nome: c.ad_name, campanha: c.campaign_name, status: c.ad_status,
      gasto: c.spend, resultados: c.results, cpr: c.cost_per_result ?? c.cpl,
      ctr: c.ctr, frequencia: c.frequency,
    })),
    recomendacoes_deterministicas: detail.recommendations,
    politica: detail.policy,
  };
  return `Você é o ADS INTELLIGENCE, copiloto sênior de mídia da agência imobiliária.

REGRA FINANCEIRA ABSOLUTA:
- O budget mensal cadastrado é TETO OPERACIONAL, não sugestão.
- Nunca recomende aumentar o gasto total acima do budget mensal.
- Antes de falar em escala, valide gasto MTD, budget restante, dias restantes e pacing.
- Se houver espaço dentro do budget, diga exatamente que é redistribuição/consumo do budget aprovado, não aumento de verba do cliente.
- Se a leitura MTD estiver indisponível, NÃO recomende aumento total de gasto.

NÃO SEJA UMA IA OBCECADA POR AUMENTAR ORÇAMENTO. Considere como soluções válidas: redistribuir verba sem aumentar total, reduzir, pausar, consolidar estrutura, trocar criativo, testar nova mensagem/oferta, revisar LP/formulário, investigar qualidade e atendimento dos leads, geografia/posicionamento quando houver evidência, corrigir saldo/pagamento, ou simplesmente NÃO ALTERAR.

Benchmarks internos são referência comparativa, nunca meta universal. Diferencie fato de hipótese. Não invente causalidade nem informação ausente.

DADOS ATUAIS DO DASHBOARD:
${JSON.stringify(compact)}

Responda em português do Brasil, curto e executivo, com estas seções exatamente:
DIAGNÓSTICO
RESTRIÇÃO DE BUDGET
3 MELHORES AÇÕES AGORA
O QUE EU NÃO FARIA
EXPERIMENTO CONTROLADO
O QUE MEDIR NAS PRÓXIMAS 48H

Em 3 MELHORES AÇÕES AGORA, priorize ações específicas e diferentes entre si. Se a melhor decisão for não mexer, diga isso explicitamente.`;
}

function AiAnswer({ text }: { text: string }) {
  const sections = text.split(/\n(?=[A-ZÁÉÍÓÚÃÕÇ0-9 ][A-ZÁÉÍÓÚÃÕÇ0-9 ]{3,}\n)/g);
  return <div className="aii-ai-answer">
    {sections.map((section, index) => {
      const lines = section.trim().split("\n").filter(Boolean);
      const title = lines[0] || "";
      const body = lines.slice(1);
      return <div key={`${title}-${index}`}>
        <h4>{title}</h4>
        {body.map((line, i) => <p key={i} className={/^[-•\d]/.test(line.trim()) ? "bullet" : ""}>{line.replace(/^[-•]\s*/, "")}</p>)}
      </div>;
    })}
  </div>;
}

export default function AdsIntelligenceInlineBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [active, setActive] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [payload, setPayload] = useState<Row>({ clients: [], summary: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("decision");
  const [aiCache, setAiCache] = useState<Record<string, string>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [actionId, setActionId] = useState("");
  const [toast, setToast] = useState("");
  const detailCacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const listLoadedAtRef = useRef(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);
  const headers = useMemo(() => session?.access_token ? {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
  } : null, [session?.access_token]);

  useEffect(() => {
    if (!headers) { setAllowed(false); return; }
    let alive = true;
    fetch(`${API}?probe=1`, { headers, cache: "no-store" })
      .then((response) => { if (alive) setAllowed(response.ok); })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
  }, [headers]);

  const loadList = useCallback(async (force = false) => {
    if (!headers) return;
    if (!force && payload.clients?.length && Date.now() - listLoadedAtRef.current < LIST_CACHE_MS) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(API, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
      listLoadedAtRef.current = Date.now();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar Ads Intelligence.");
    } finally { setLoading(false); }
  }, [headers, payload.clients?.length]);

  const openClient = useCallback(async (id: string, force = false) => {
    if (!headers || !id) return;
    setSelectedId(id); setError(""); setTab("decision"); setToast("");
    const cached = detailCacheRef.current.get(id);
    if (!force && cached && Date.now() - cached.at < DETAIL_CACHE_MS) {
      setDetail(cached.body);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    setDetail((current) => String(current?.client?.id || "") === id ? current : null);
    try {
      const response = await fetch(`${API}?client_id=${encodeURIComponent(id)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      detailCacheRef.current.set(id, { at: Date.now(), body });
      setDetail(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao abrir cliente.");
    } finally { setDetailLoading(false); }
  }, [headers]);

  const runAi = useCallback(async (force = false) => {
    if (!headers || !detail?.client?.id) return;
    const key = String(detail.client.id);
    if (!force && aiCache[key]) return;
    setAiLoading(true); setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const response = await fetch(AI_API, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ question: buildAiPrompt(detail) }),
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) throw new Error(body?.error || body?.detail || `IA ${response.status}`);
      const answer = String(body.answer || "").trim();
      if (!answer) throw new Error("A IA não devolveu uma leitura utilizável.");
      setAiCache((current) => ({ ...current, [key]: answer }));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setError("O AI Copilot passou de 25s. O Decision Engine continua disponível imediatamente; tente o diagnóstico novamente depois.");
      else setError(caught instanceof Error ? caught.message : "Falha ao gerar leitura da IA.");
    } finally {
      window.clearTimeout(timeout);
      setAiLoading(false);
    }
  }, [headers, detail, aiCache]);

  const toggleCampaign = useCallback(async (campaign: Row) => {
    if (!headers || !detail?.client?.display_name) return;
    const current = String(campaign.campaign_status || "").toUpperCase();
    const desired = current === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const verb = desired === "PAUSED" ? "pausar" : "ativar";
    if (!window.confirm(`Confirmar ${verb} “${campaign.campaign_name}” na Meta? A ação será auditada e verificada após a execução.`)) return;
    const id = String(campaign.campaign_id || campaign.campaign_name);
    setActionId(id); setError(""); setToast("");
    try {
      const response = await fetch(CAMPAIGN_ACTION_API, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          client_name: detail.client.display_name,
          campaign_name: campaign.campaign_name,
          account_key: campaign.account_key || campaign.meta_ad_account_id || "",
          desired_status: desired,
        }),
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) throw new Error(body.detail || body.error || `Meta ${response.status}`);
      setToast(`${campaign.campaign_name}: ${desired === "ACTIVE" ? "ativada" : "pausada"} e verificada na Meta.`);
      const clientId = String(detail.client.id);
      detailCacheRef.current.delete(clientId);
      listLoadedAtRef.current = 0;
      await openClient(clientId, true);
      await loadList(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao alterar campanha.");
    } finally { setActionId(""); }
  }, [headers, detail, openClient, loadList]);

  useEffect(() => { if (active && headers) void loadList(false); }, [active, headers, loadList]);

  useEffect(() => {
    if (!allowed || window.location.pathname !== "/") { setActive(false); return; }
    let cleanup: (() => void) | null = null;
    const install = () => {
      const shell = document.querySelector<HTMLElement>(".shell");
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!shell || !container) return;
      setHost(shell);
      let button = container.querySelector<HTMLButtonElement>("[data-ads-intelligence-nav]");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.adsIntelligenceNav = "true";
        button.title = "Ads Intelligence";
        button.textContent = "Ads Intelligence";
        const campaigns = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.trim() === "Campanhas");
        if (campaigns) container.insertBefore(button, campaigns);
        else container.appendChild(button);
      }
      const onOpen = () => {
        shell.classList.add("ads-intelligence-active");
        setActive(true);
      };
      const onOtherNav = (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest("button,a") : null;
        if (!target || target === button || target.hasAttribute("data-ads-intelligence-nav")) return;
        shell.classList.remove("ads-intelligence-active");
        setActive(false);
      };
      cleanup?.();
      button.addEventListener("click", onOpen);
      container.addEventListener("click", onOtherNav, true);
      cleanup = () => {
        button?.removeEventListener("click", onOpen);
        container.removeEventListener("click", onOtherNav, true);
      };
    };
    install();
    const timer = window.setInterval(install, 2500);
    return () => {
      window.clearInterval(timer);
      cleanup?.();
      document.querySelector(".shell")?.classList.remove("ads-intelligence-active");
    };
  }, [allowed]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (payload.clients || []).filter((row: Row) => {
      if (attentionOnly && !row.attention) return false;
      if (!needle) return true;
      return `${row.client_name} ${row.gt_owner}`.toLocaleLowerCase("pt-BR").includes(needle);
    });
  }, [payload.clients, query, attentionOnly]);

  if (!allowed || !active || !host) return null;
  const pacing = detail?.pacing || {};
  const budget = detail?.budget || {};
  const benchmark = detail?.benchmark || payload.benchmark || {};
  const current7 = detail?.windows?.[7] || detail?.windows?.["7"] || null;
  const aiText = detail?.client?.id ? aiCache[String(detail.client.id)] : "";

  return createPortal(
    <section className="ads-intelligence-host">
      <header className="aii-head">
        <div>
          <span className="eyebrow">Performance · decisão · operação</span>
          <h2>Ads Intelligence</h2>
          <p>Meta Ads com contexto da agência: budget como restrição, benchmark interno, diagnóstico e ação auditada.</p>
        </div>
        <div className="aii-head-actions">
          <span className="aii-policy-pill">Budget guardrail ativo</span>
          <button className="button secondary" onClick={() => void loadList(true)} disabled={loading}>Atualizar</button>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}
      {toast && <div className="aii-toast">{toast}</div>}

      <div className="aii-summary-grid">
        <div className="card aii-summary"><small>Carteira</small><b>{number(payload.summary?.total)}</b><span>clientes no escopo</span></div>
        <div className="card aii-summary"><small>Pedem atenção</small><b>{number(payload.summary?.attention)}</b><span>budget, saldo ou performance</span></div>
        <div className="card aii-summary"><small>Budget conhecido</small><b>{number(payload.summary?.budget_covered)}</b><span>com teto financeiro cadastrado</span></div>
        <div className="card aii-summary"><small>Benchmark interno</small><b>{number(benchmark.sample_size)}</b><span>contas válidas na janela de 7d</span></div>
      </div>

      <div className="aii-layout">
        <aside className="card aii-client-list">
          <div className="aii-list-head">
            <div><b>Portfólio</b><small>{visible.length} clientes</small></div>
            <input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou GT" />
            <label className="aii-check"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} /> Só atenção</label>
          </div>
          <div className="aii-client-scroll">
            {loading && !payload.clients?.length && <div className="aii-list-state">Atualizando carteira…</div>}
            {visible.map((row: Row) => <button key={row.client_id} className={`aii-client-row ${selectedId === row.client_id ? "active" : ""}`} onClick={() => void openClient(String(row.client_id), false)}>
              <span className="avatar">{initials(row.client_name)}</span>
              <span className="copy"><b>{row.client_name}</b><small>GT {row.gt_owner || "—"}</small><em>{row.monthly_budget ? `Budget ${money(row.monthly_budget)}` : "Budget não validado"}</em></span>
              <span className={`dot ${row.attention ? "warn" : "good"}`} />
            </button>)}
          </div>
        </aside>

        <main className="aii-detail">
          {!selectedId && <div className="card aii-empty"><div><span className="aii-orb">AI</span><h3>Escolha um cliente</h3><p>O Ads Intelligence cruza budget, pacing, Meta, benchmarks e estrutura antes de sugerir qualquer ação.</p></div></div>}
          {detailLoading && !detail && <div className="card aii-empty"><div><span className="aii-spinner"/><h3>Lendo conta e budget</h3><p>Consultando gasto MTD e contexto operacional.</p></div></div>}
          {detail && <>
            <section className={`card aii-client-hero ${detailLoading ? "is-refreshing" : ""}`}>
              <div className="aii-client-title"><span className="avatar">{initials(detail.client?.display_name)}</span><div><span className="eyebrow">Conta selecionada</span><h2>{detail.client?.display_name}</h2><p>GT {detail.client?.gt_owner || "—"} · CS {detail.client?.cs_owner || "—"}</p></div></div>
              <div className={`aii-pace-state ${paceTone(pacing.status)}`}><small>Pacing mensal</small><b>{paceLabel(pacing.status)}</b><span>{detailLoading ? "atualizando…" : pacing.source === "META_LIVE" ? "Meta ao vivo" : pacing.source === "META_LIVE_PARTIAL" ? "Meta parcial" : "leitura protegida"}</span></div>
            </section>

            <section className="aii-budget-grid">
              <div className="card aii-budget-card"><small>Budget mensal</small><b>{money(budget.monthly_budget)}</b><span>teto operacional</span></div>
              <div className="card aii-budget-card"><small>Gasto MTD</small><b>{money(pacing.mtd_spend)}</b><span>acumulado do mês</span></div>
              <div className="card aii-budget-card"><small>Restante</small><b>{money(pacing.remaining_budget)}</b><span>{remainingDaysLabel(pacing.remaining_days)}</span></div>
              <div className="card aii-budget-card"><small>Ritmo ideal daqui</small><b>{pacing.ideal_daily_remaining === null || pacing.ideal_daily_remaining === undefined ? "—" : `${money(pacing.ideal_daily_remaining)}/dia`}</b><span>para respeitar o teto</span></div>
              <div className={`card aii-budget-card ${paceTone(pacing.status)}`}><small>Projeção do mês</small><b>{money(pacing.projected_month_spend)}</b><span>{finite(pacing.variance) === null ? "sem projeção segura" : Number(pacing.variance) > 0 ? `${money(pacing.variance)} acima` : `${money(Math.abs(Number(pacing.variance)))} abaixo`}</span></div>
            </section>

            <nav className="aii-tabs">
              <button className={tab === "decision" ? "active" : ""} onClick={() => setTab("decision")}>Decision Engine</button>
              <button className={tab === "campaigns" ? "active" : ""} onClick={() => setTab("campaigns")}>Campanhas</button>
              <button className={tab === "benchmark" ? "active" : ""} onClick={() => setTab("benchmark")}>Benchmark</button>
              <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI Copilot</button>
            </nav>

            {tab === "decision" && <div className="aii-tab-content">
              <div className="aii-section-title"><div><span className="eyebrow">Decision Engine</span><h3>O que fazer agora</h3></div><small>ações dentro do budget aprovado</small></div>
              <div className="aii-recommendations">
                {(detail.recommendations || []).map((rec: Row, index: number) => <article className={`card aii-rec ${priorityTone(rec.priority)}`} key={`${rec.category}-${index}`}>
                  <div className="aii-rec-top"><span>{categoryLabel(rec.category)}</span><em>{priorityLabel(rec.priority)}</em></div>
                  <h4>{rec.title}</h4>
                  <p className="action">{rec.action}</p>
                  <p className="reason">{rec.reason}</p>
                  <footer><span>Efeito no budget: {rec.budget_effect === "NEUTRAL" ? "neutro" : rec.budget_effect === "WITHIN_BUDGET" ? "dentro do teto" : rec.budget_effect === "REDUCE" ? "redução" : "bloqueado"}</span><span>Confiança {String(rec.confidence || "").toLowerCase()}</span></footer>
                </article>)}
              </div>
              <div className="aii-kpis">
                <div className="card"><small>Gasto 7d</small><b>{money(current7?.spend)}</b></div>
                <div className="card"><small>Resultados 7d</small><b>{number(current7?.results)}</b></div>
                <div className="card"><small>CPL / CPR</small><b>{money(current7?.cpl ?? current7?.cost_per_result)}</b></div>
                <div className="card"><small>CTR</small><b>{percent(current7?.ctr, 2)}</b></div>
                <div className="card"><small>Frequência</small><b>{number(current7?.frequency, 2)}</b></div>
              </div>
            </div>}

            {tab === "campaigns" && <div className="aii-tab-content">
              <div className="aii-section-title"><div><span className="eyebrow">Operação Meta</span><h3>Campanhas</h3></div><small>pause/ative com auditoria e verificação pós-ação</small></div>
              <div className="card aii-table-wrap"><table className="aii-table"><thead><tr><th>Campanha</th><th>Status</th><th>Gasto</th><th>Resultados</th><th>CPL/CPR</th><th>CTR</th><th>Freq.</th><th>Ação</th></tr></thead><tbody>
                {(detail.campaigns || []).map((c: Row) => {
                  const status = String(c.campaign_status || "").toUpperCase();
                  const toggleable = ["ACTIVE", "PAUSED"].includes(status);
                  const busy = actionId === String(c.campaign_id || c.campaign_name);
                  return <tr key={`${c.meta_ad_account_id}-${c.campaign_id}`}><td><b>{c.campaign_name}</b><small>{c.objective || "—"}</small></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativa" : status === "PAUSED" ? "Pausada" : status || "—"}</span></td><td>{money(c.spend)}</td><td>{number(c.results)}</td><td>{money(c.cost_per_result ?? c.cpl)}</td><td>{percent(c.ctr, 2)}</td><td>{number(c.frequency, 2)}</td><td>{toggleable ? <button className={`aii-toggle ${status === "ACTIVE" ? "pause" : "resume"}`} disabled={busy} onClick={() => void toggleCampaign(c)}>{busy ? "Aplicando…" : status === "ACTIVE" ? "Pausar" : "Ativar"}</button> : <span className="muted">indisponível</span>}</td></tr>;
                })}
              </tbody></table></div>
            </div>}

            {tab === "benchmark" && <div className="aii-tab-content">
              <div className="aii-section-title"><div><span className="eyebrow">Benchmark interno</span><h3>Contexto antes de julgar KPI</h3></div><small>{number(benchmark.sample_size)} contas · mediana 7d</small></div>
              <div className="aii-benchmark-grid">
                {[
                  ["CPL / CPR", current7?.cpl ?? current7?.cost_per_result, benchmark.cpl, true],
                  ["CTR", current7?.ctr, benchmark.ctr, false],
                  ["CPC", current7?.cpc, benchmark.cpc, true],
                  ["CPM", current7?.cpm, benchmark.cpm, true],
                  ["Frequência", current7?.frequency, benchmark.frequency, null],
                ].map(([label, own, bench, inverse]) => {
                  const a = finite(own), b = finite(bench);
                  const diff = a !== null && b !== null && b !== 0 ? ((a / b) - 1) * 100 : null;
                  const good = diff === null || inverse === null ? null : inverse ? diff <= 0 : diff >= 0;
                  return <div className="card aii-benchmark" key={String(label)}><small>{label}</small><div><span><em>Cliente</em><b>{String(label).includes("CTR") || String(label).includes("Frequência") ? number(a, 2) : money(a)}</b></span><span><em>Agência</em><b>{String(label).includes("CTR") || String(label).includes("Frequência") ? number(b, 2) : money(b)}</b></span></div><p className={good === null ? "" : good ? "good" : "bad"}>{diff === null ? "Sem comparação segura" : `${diff > 0 ? "+" : ""}${number(diff, 1)}% vs. mediana`}</p></div>;
                })}
              </div>
              <p className="aii-method">{benchmark.methodology}</p>
            </div>}

            {tab === "ai" && <div className="aii-tab-content">
              <section className="card aii-ai-card">
                <div className="aii-section-title"><div><span className="eyebrow">AI Copilot</span><h3>Leitura consultiva da conta</h3></div>{aiText && <button className="button secondary" disabled={aiLoading} onClick={() => void runAi(true)}>{aiLoading ? "Analisando…" : "Reanalisar"}</button>}</div>
                {aiLoading && !aiText && <div className="aii-ai-loading"><span className="aii-spinner"/><div><b>Cruzando contexto</b><small>Budget, pacing, benchmark, campanhas e criativos. Limite de espera: 25s.</small></div></div>}
                {aiText ? <AiAnswer text={aiText} /> : !aiLoading ? <div className="aii-ai-placeholder"><p>O Decision Engine acima é imediato. O Copilot é uma camada adicional e só roda quando você pedir, para não travar a navegação.</p><button className="button" onClick={() => void runAi(false)}>Gerar diagnóstico</button></div> : null}
              </section>
            </div>}
          </>}
        </main>
      </div>
    </section>,
    host,
  );
}