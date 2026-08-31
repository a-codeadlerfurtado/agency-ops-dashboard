"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, supabase } from "./shared";

type Row = Record<string, any>;
type Mode = "adsets" | "ads" | null;
type CacheEntry = { at: number; payload: Row };
type Recommendation = { field: string; current: string; action: string; reason: string; confidence: "Alta" | "Média" | "Baixa"; tone: "good" | "info" | "warn" | "critical" };

const STRUCTURE_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-structure-api`;
const INTELLIGENCE_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-api`;
const ACTION_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-action-api`;
const BENCHMARK_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-benchmark-api`;
const CACHE_MS = 90_000;
const CONTEXT_CACHE_MS = 60_000;

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const money = (value: unknown) => finite(value) === null ? "—" : formatMoney(value);
const number = (value: unknown, digits = 0) => finite(value) === null ? "—" : formatNumber(value, digits);
const pct = (value: unknown, digits = 2) => finite(value) === null ? "—" : `${number(value, digits)}%`;
const budgetMoney = (value: unknown) => finite(value) === null ? "—" : formatMoney(Number(value) / 100);
const cleanAccount = (value: unknown) => String(value || "").replace(/^act_/, "").trim();
const list = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const ratio = (value: unknown, bench: unknown) => {
  const a = finite(value), b = finite(bench);
  return a !== null && b !== null && b > 0 ? a / b : null;
};

function errorLabel(body: Row, fallback: string) {
  const code = String(body?.error || "");
  if (code === "object_not_owned_by_client") return "Esse objeto não pertence a uma conta Meta vinculada a este cliente.";
  if (code === "meta_read_failed") return "A Meta não devolveu a configuração completa desse conjunto agora.";
  return String(body?.detail || body?.error || fallback);
}

function partialLabel(payload: Row) {
  const errors: Row[] = payload?.account_errors || [];
  const coverage = payload?.coverage || {};
  if (!errors.length) return "";
  const first = errors[0];
  const stageLabels: Record<string, string> = {
    ADSETS_STRUCTURE: "estrutura de conjuntos", ADS_STRUCTURE: "estrutura de anúncios",
    ADSETS_INSIGHTS: "métricas de conjuntos", ADS_INSIGHTS: "métricas de anúncios",
  };
  const stage = stageLabels[String(first.stage || "")] || "leitura Meta";
  const loaded = `${number(coverage.adsets_loaded)} conjuntos e ${number(coverage.ads_loaded)} anúncios carregados`;
  return `Leitura parcial da Meta: falha em ${stage} na conta ${first.account_id || "vinculada"}. ${loaded}. O que respondeu foi mantido.`;
}

function metaAdsetUrl(row: Row, state?: Row | null) {
  const account = cleanAccount(state?.account_id || row.account_id);
  const id = String(state?.id || row.id || "").trim();
  if (!account || !id) return "";
  return `https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=${encodeURIComponent(account)}&selected_adset_ids=${encodeURIComponent(id)}`;
}

function metaAdUrl(row: Row) {
  const account = cleanAccount(row.account_id);
  const id = String(row.id || "").trim();
  if (!account || !id) return "";
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(account)}&selected_ad_ids=${encodeURIComponent(id)}`;
}

function fieldSummary(state: Row, field: string) {
  const targeting = state?.targeting && typeof state.targeting === "object" ? state.targeting : {};
  const geo = targeting.geo_locations && typeof targeting.geo_locations === "object" ? targeting.geo_locations : {};
  if (field === "audience") {
    const ages = `${targeting.age_min || "—"}–${targeting.age_max || "—"}`;
    const customs = list(targeting.custom_audiences).length;
    const flex = list(targeting.flexible_spec).length;
    return `Idade ${ages} · ${customs} público(s) personalizado(s) · ${flex} grupo(s) de detalhamento`;
  }
  if (field === "location") {
    const countries = list<string>(geo.countries).join(", ");
    const regions = list(geo.regions).length;
    const cities = list(geo.cities).length;
    return countries || regions || cities ? `${countries || "sem país explícito"} · ${regions} região(ões) · ${cities} cidade(s)` : "Sem resumo geográfico disponível";
  }
  if (field === "placements") {
    const publishers = list<string>(targeting.publisher_platforms);
    const manual = publishers.length || ["facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions"].some((key) => list(targeting[key]).length);
    return manual ? `Manual · ${publishers.length ? publishers.join(", ") : "plataformas definidas por posição"}` : "Advantage+ / automático";
  }
  return "—";
}

function benchmarkUnavailableReason(benchmark: Row | null) {
  if (!benchmark) return "A coorte contextual ainda não foi carregada.";
  if (benchmark.status === "INSUFFICIENT_PROFILE") return "Não foi possível identificar um tipo de produto estruturado e inequívoco para este conjunto.";
  if (benchmark.status === "INSUFFICIENT_SAMPLE") return `A coorte correta não atingiu a amostra mínima (${number(benchmark.sample_size)} de ${number(benchmark.min_sample)}).`;
  if (benchmark.status === "INFORMATIONAL_ONLY") return "A comparação disponível é ampla demais para autorizar mudança; ela serve apenas como contexto.";
  return String(benchmark.methodology || "Não existe benchmark contextual suficiente para orientar alteração.");
}

function makeRecommendations(row: Row, state: Row, context: Row | null, benchmark: Row | null): Recommendation[] {
  const pacing = context?.pacing || {};
  const budget = context?.budget || {};
  const validBenchmark = Boolean(benchmark?.valid_for_recommendation);
  const b = validBenchmark ? benchmark : {};
  const cprRatio = validBenchmark ? ratio(row.cost_per_result, b.cpl) : null;
  const ctrRatio = validBenchmark ? ratio(row.ctr, b.ctr) : null;
  const cpcRatio = validBenchmark ? ratio(row.cpc, b.cpc) : null;
  const freqRatio = validBenchmark ? ratio(row.frequency, b.frequency) : null;
  const spend = finite(row.spend) || 0;
  const results = finite(row.results) || 0;
  const remaining = finite(pacing.remaining_budget);
  const monthly = finite(budget.monthly_budget);
  const paceStatus = String(pacing.status || "");
  const recs: Recommendation[] = [];
  const noBench = benchmarkUnavailableReason(benchmark);

  if (monthly === null) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Não aumentar verba até o teto mensal estar validado.", reason: "Budget mensal é uma restrição operacional obrigatória e independe de benchmark.", confidence: "Alta", tone: "critical" });
  } else if (remaining !== null && (remaining <= Math.max(5, monthly * .05) || ["OVER_PACE", "BUDGET_REACHED"].includes(paceStatus))) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Não aumentar. Se mexer, use redistribuição ou redução dentro do teto mensal.", reason: `Restante estimado ${money(remaining)} de ${money(monthly)}; pacing ${paceStatus || "indisponível"}.`, confidence: "Alta", tone: "warn" });
  } else if (validBenchmark && cprRatio !== null && cprRatio <= .85 && results >= 3) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Pode ser candidato a receber redistribuição de verba, sem aumentar o budget mensal do cliente.", reason: `CPR ${money(row.cost_per_result)} está ${number((1 - cprRatio) * 100, 0)}% abaixo da mediana da coorte correta (${money(b.cpl)}).`, confidence: "Média", tone: "good" });
  } else {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Manter o orçamento por enquanto.", reason: validBenchmark ? `CPR ${money(row.cost_per_result)} vs. coorte ${money(b.cpl)} não sustenta escala clara.` : `Sem recomendação de escala por benchmark. ${noBench}`, confidence: validBenchmark ? "Média" : "Alta", tone: "info" });
  }

  if (!validBenchmark) {
    recs.push({ field: "Público", current: fieldSummary(state, "audience"), action: "Não recomendar alteração de público por benchmark agora.", reason: noBench, confidence: "Alta", tone: "info" });
    recs.push({ field: "Localização", current: fieldSummary(state, "location"), action: "Não cortar ou ampliar praça com base em referência ampla.", reason: `${noBench} Use breakdown geográfico da própria conta como evidência adicional antes de mexer.`, confidence: "Alta", tone: "info" });
    recs.push({ field: "Posicionamentos", current: fieldSummary(state, "placements"), action: "Não restringir posicionamentos por benchmark insuficiente.", reason: `${noBench} O correto é abrir breakdown de placement na Meta e validar volume + custo por resultado.`, confidence: "Alta", tone: "info" });
    recs.push({ field: "Otimização", current: String(state.optimization_goal || "—").replaceAll("_", " "), action: "Manter o objetivo de otimização até haver evidência comparável ou problema técnico claro.", reason: noBench, confidence: "Alta", tone: "info" });
    recs.push({ field: "Estratégia de lance", current: String(state.bid_strategy || "—").replaceAll("_", " "), action: "Não alterar lance com base em benchmark amplo.", reason: noBench, confidence: "Alta", tone: "info" });
    recs.push({ field: "Criativo / entrega", current: `CTR ${pct(row.ctr)} · Freq. ${number(row.frequency, 2)}`, action: "Não concluir fadiga apenas pelo número atual.", reason: `${noBench} Compare também a tendência do próprio conjunto e os criativos da mesma campanha.`, confidence: "Alta", tone: "info" });
  } else {
    if ((freqRatio !== null && freqRatio >= 1.2 && ctrRatio !== null && ctrRatio <= .9) || (cprRatio !== null && cprRatio >= 1.25 && ctrRatio !== null && ctrRatio <= .9)) {
      recs.push({ field: "Público", current: fieldSummary(state, "audience"), action: "Testar uma variação de público por vez antes de aumentar verba.", reason: `CTR ${pct(row.ctr)} vs. coorte ${pct(b.ctr)}${freqRatio !== null ? `; frequência ${number(row.frequency, 2)} vs. ${number(b.frequency, 2)}` : ""}.`, confidence: "Média", tone: "warn" });
    } else {
      recs.push({ field: "Público", current: fieldSummary(state, "audience"), action: "Não alterar o público só para gerar atividade.", reason: `A leitura frente à coorte (${pct(b.ctr)} CTR mediano) não mostra desvio suficiente.`, confidence: "Média", tone: "good" });
    }

    recs.push({ field: "Localização", current: fieldSummary(state, "location"), action: "Usar o breakdown geográfico da Meta antes de mudar a praça.", reason: `A coorte confirma contexto regional (${benchmark?.scope?.city || benchmark?.scope?.state || "região compatível"}), mas não prova qual bairro/cidade interna está pior neste conjunto.`, confidence: "Alta", tone: "info" });

    if ((ctrRatio !== null && ctrRatio < .85) || (cpcRatio !== null && cpcRatio > 1.2)) {
      recs.push({ field: "Posicionamentos", current: fieldSummary(state, "placements"), action: "Investigar breakdown por posicionamento na Meta; só restringir placement com volume e ineficiência comprovada.", reason: `CTR ${pct(row.ctr)} vs. ${pct(b.ctr)} e CPC ${money(row.cpc)} vs. ${money(b.cpc)} justificam investigação, não corte automático.`, confidence: "Média", tone: "info" });
    } else {
      recs.push({ field: "Posicionamentos", current: fieldSummary(state, "placements"), action: "Manter os posicionamentos atuais.", reason: "Sem deterioração relevante de CTR/CPC frente à coorte contextual.", confidence: "Média", tone: "good" });
    }

    const optimization = String(state.optimization_goal || "—").replaceAll("_", " ");
    if (results < 5 && spend > 0) {
      recs.push({ field: "Otimização", current: optimization, action: "Não trocar o objetivo de otimização com esta amostra.", reason: `${number(results)} resultado(s) em 7 dias é pouco para atribuir o problema à otimização.`, confidence: "Alta", tone: "info" });
    } else if (ctrRatio !== null && ctrRatio >= 1 && cprRatio !== null && cprRatio > 1.2) {
      recs.push({ field: "Otimização", current: optimization, action: "Antes de mudar otimização, investigar o que acontece depois do clique/lead.", reason: "CTR está pelo menos na mediana da coorte, mas CPR está pior; isso reduz a evidência de problema de entrega.", confidence: "Média", tone: "info" });
    } else {
      recs.push({ field: "Otimização", current: optimization, action: "Manter o objetivo atual por enquanto.", reason: "A coorte contextual não mostra evidência suficiente para atribuir o desvio ao objetivo de otimização.", confidence: "Média", tone: "good" });
    }

    const bid = String(state.bid_strategy || "—").replaceAll("_", " ");
    if (/CAP/i.test(String(state.bid_strategy || "")) && ((cprRatio !== null && cprRatio > 1.15) || paceStatus === "UNDER_PACE")) {
      recs.push({ field: "Estratégia de lance", current: bid, action: "Revisar o cap na Meta como hipótese isolada.", reason: `Pacing ${paceStatus || "indisponível"} e CPR ${money(row.cost_per_result)} vs. coorte ${money(b.cpl)} justificam checar limitação de entrega.`, confidence: "Média", tone: "warn" });
    } else {
      recs.push({ field: "Estratégia de lance", current: bid, action: "Manter a estratégia de lance atual.", reason: "A coorte contextual não mostra evidência suficiente para trocar lance.", confidence: "Baixa", tone: "good" });
    }

    if ((ctrRatio !== null && ctrRatio < .85) || (freqRatio !== null && freqRatio > 1.2)) {
      recs.push({ field: "Criativo / entrega", current: `CTR ${pct(row.ctr)} · Freq. ${number(row.frequency, 2)}`, action: "Priorizar teste de criativo antes de reformar várias variáveis simultaneamente.", reason: `CTR/frequência desviam da coorte (${pct(b.ctr)} / ${number(b.frequency, 2)}).`, confidence: "Alta", tone: "warn" });
    } else {
      recs.push({ field: "Criativo / entrega", current: `CTR ${pct(row.ctr)} · Freq. ${number(row.frequency, 2)}`, action: "Sem urgência para trocar criativo por benchmark.", reason: "Os sinais de atração/saturação não estão suficientemente ruins frente à coorte correta.", confidence: "Média", tone: "good" });
    }
  }

  recs.push({ field: "Programação", current: `${state.start_time ? new Date(state.start_time).toLocaleDateString("pt-BR") : "início não informado"} → ${state.end_time ? new Date(state.end_time).toLocaleDateString("pt-BR") : "sem fim definido"}`, action: paceStatus === "OVER_PACE" ? "Não estender entrega sem primeiro corrigir pacing/orçamento na Meta." : "Manter datas, salvo necessidade comercial real.", reason: paceStatus === "OVER_PACE" ? "A projeção financeira já está acima do ritmo." : "Datas não devem ser alteradas para tentar resolver KPI sem relação causal comprovada.", confidence: "Alta", tone: paceStatus === "OVER_PACE" ? "warn" : "good" });

  return recs;
}

function rowSignal(context: Row | null) {
  const pacing = String(context?.pacing?.status || "");
  if (["OVER_PACE", "BUDGET_REACHED"].includes(pacing)) return { label: "Budget", tone: "warn" };
  return { label: "Analisar", tone: "muted" };
}

function cohortLabel(benchmark: Row | null) {
  if (!benchmark) return "Coorte não carregada";
  if (!benchmark.valid_for_recommendation) return "Benchmark insuficiente";
  const dims = list<string>(benchmark.dimensions).map((d) => d === "cidade" ? "cidade" : d === "estado" ? "estado" : d === "tipo_produto" ? "produto" : d === "faixa_ticket" ? "ticket" : d);
  return `${number(benchmark.sample_size)} pares · ${dims.join(" + ")}`;
}

export default function AdsIntelligenceStructureBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [clientName, setClientName] = useState("");
  const [payload, setPayload] = useState<Row>({ adsets: [], ads: [] });
  const [context, setContext] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [advisorRow, setAdvisorRow] = useState<Row | null>(null);
  const [advisorState, setAdvisorState] = useState<Row | null>(null);
  const [advisorBenchmark, setAdvisorBenchmark] = useState<Row | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const contextCacheRef = useRef<Map<string, CacheEntry>>(new Map());

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);
  const headers = useMemo(() => session?.access_token ? { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY } : null, [session?.access_token]);

  const loadContext = useCallback(async (clientId: string, force = false) => {
    if (!headers || !clientId) return null;
    const cached = contextCacheRef.current.get(clientId);
    if (!force && cached && Date.now() - cached.at < CONTEXT_CACHE_MS) { setContext(cached.payload); return cached.payload; }
    try {
      const response = await fetch(`${INTELLIGENCE_API}?client_id=${encodeURIComponent(clientId)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return null;
      contextCacheRef.current.set(clientId, { at: Date.now(), payload: body });
      setContext(body);
      return body;
    } catch { return null; }
  }, [headers]);

  const load = useCallback(async (name: string, force = false) => {
    if (!headers || !name) return;
    const cached = cacheRef.current.get(name);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) {
      setPayload(cached.payload); setError("");
      const id = String(cached.payload?.client?.id || ""); if (id) void loadContext(id, false);
      return;
    }
    setLoading(true); setError("");
    try {
      const response = await fetch(`${STRUCTURE_API}?client_name=${encodeURIComponent(name)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorLabel(body, `API ${response.status}`));
      cacheRef.current.set(name, { at: Date.now(), payload: body });
      setPayload(body);
      const id = String(body?.client?.id || ""); if (id) void loadContext(id, force);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar estrutura Meta."); }
    finally { setLoading(false); }
  }, [headers, loadContext]);

  useEffect(() => {
    if (!headers || window.location.pathname !== "/") return;
    let cleanup: (() => void) | null = null;
    let scheduled = false;
    const install = () => {
      scheduled = false;
      const currentRoot = document.querySelector<HTMLElement>(".ads-intelligence-host");
      const detailHost = currentRoot?.querySelector<HTMLElement>(".aii-detail");
      const tabs = currentRoot?.querySelector<HTMLElement>(".aii-tabs");
      if (!currentRoot || !detailHost || !tabs) { setRoot(null); setHost(null); return; }
      setRoot(currentRoot); setHost(detailHost);
      currentRoot.querySelectorAll<HTMLElement>(".aii-budget-card").forEach((card) => {
        const label = card.querySelector("small");
        if (label?.textContent?.trim() === "Gasto MTD") {
          label.textContent = "Gasto no mês";
          const description = card.querySelector("span");
          if (description) description.textContent = "quanto já foi gasto no mês atual até agora";
        }
      });
      const ensureButton = (key: "adsets" | "ads", label: string) => {
        let button = tabs.querySelector<HTMLButtonElement>(`[data-aii-structure-tab="${key}"]`);
        if (!button) { button = document.createElement("button"); button.type = "button"; button.dataset.aiiStructureTab = key; button.textContent = label; tabs.appendChild(button); }
        return button;
      };
      const adsetsButton = ensureButton("adsets", "Conjuntos");
      const adsButton = ensureButton("ads", "Anúncios");
      const open = (next: "adsets" | "ads") => {
        const name = String(currentRoot.querySelector(".aii-client-hero h2")?.textContent || "").trim();
        setClientName(name); setMode(next); setQuery(""); setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); setError("");
        if (name) void load(name, false); else setError("Selecione um cliente antes de abrir Conjuntos ou Anúncios.");
      };
      const onSets = () => open("adsets"); const onAds = () => open("ads");
      const onTabs = (event: Event) => { const target = event.target instanceof Element ? event.target.closest("button") : null; if (!target || target.hasAttribute("data-aii-structure-tab")) return; setMode(null); setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); };
      const onRootClick = (event: Event) => { const target = event.target instanceof Element ? event.target.closest(".aii-client-row") : null; if (!target) return; setMode(null); setClientName(""); setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); setContext(null); };
      cleanup?.(); adsetsButton.addEventListener("click", onSets); adsButton.addEventListener("click", onAds); tabs.addEventListener("click", onTabs, true); currentRoot.addEventListener("click", onRootClick, true);
      cleanup = () => { adsetsButton.removeEventListener("click", onSets); adsButton.removeEventListener("click", onAds); tabs.removeEventListener("click", onTabs, true); currentRoot.removeEventListener("click", onRootClick, true); };
    };
    const schedule = () => { if (scheduled) return; scheduled = true; window.requestAnimationFrame(install); };
    install(); const observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cleanup?.(); };
  }, [headers, load]);

  useEffect(() => {
    if (!root) return;
    root.classList.toggle("aii-structure-active", Boolean(mode));
    root.querySelectorAll<HTMLButtonElement>("[data-aii-structure-tab]").forEach((button) => button.classList.toggle("active", button.dataset.aiiStructureTab === mode));
    return () => root.classList.remove("aii-structure-active");
  }, [root, mode]);

  const openAdvisor = useCallback(async (row: Row) => {
    if (!headers || !clientName) return;
    setAdvisorRow(row); setAdvisorState(null); setAdvisorBenchmark(null); setAdvisorLoading(true); setError("");
    const clientId = String(payload?.client?.id || context?.client?.id || "");
    try {
      const statePromise = fetch(ACTION_API, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, object_type: "ADSET", object_id: String(row.id), action: "GET_STATE" }), cache: "no-store",
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.ok === false) throw new Error(errorLabel(body, `Meta ${response.status}`));
        return body.state || row;
      });
      const benchmarkPromise = clientId ? fetch(`${BENCHMARK_API}?client_id=${encodeURIComponent(clientId)}&campaign_name=${encodeURIComponent(String(row.campaign_name || ""))}&adset_name=${encodeURIComponent(String(row.name || ""))}&campaign_id=${encodeURIComponent(String(row.campaign_id || ""))}`, { headers, cache: "no-store" })
        .then(async (response) => { const body = await response.json().catch(() => ({})); return response.ok ? body.benchmark || null : null; })
        .catch(() => null) : Promise.resolve(null);
      const [state, benchmark] = await Promise.all([statePromise.catch((caught) => { setError(`${caught instanceof Error ? caught.message : "Não foi possível ler a configuração completa."} As recomendações usarão apenas os campos disponíveis.`); return row; }), benchmarkPromise]);
      setAdvisorState(state);
      setAdvisorBenchmark(benchmark);
    } finally { setAdvisorLoading(false); }
  }, [headers, clientName, payload?.client?.id, context?.client?.id]);

  const rows = useMemo(() => {
    const source: Row[] = mode === "ads" ? payload.ads || [] : payload.adsets || [];
    const needle = query.trim().toLocaleLowerCase("pt-BR"); if (!needle) return source;
    return source.filter((row) => `${row.name} ${row.campaign_name || ""} ${row.status || ""}`.toLocaleLowerCase("pt-BR").includes(needle));
  }, [payload, mode, query]);

  const recommendations = useMemo(() => advisorRow && advisorState ? makeRecommendations(advisorRow, advisorState, context, advisorBenchmark) : [], [advisorRow, advisorState, context, advisorBenchmark]);
  if (!host || !root || !mode) return null;
  const warning = partialLabel(payload);

  return createPortal(<>
    <section className="aii-structure-content">
      <div className="aii-structure-head">
        <div><span className="eyebrow">Meta ao vivo · 7 dias</span><h3>{mode === "adsets" ? "Conjuntos de anúncios" : "Anúncios"}</h3><p>{mode === "adsets" ? "Leitura, benchmark contextual e recomendação. A edição acontece no Gerenciador da Meta." : "Leitura de entrega e atalho para editar o anúncio na Meta."}</p></div>
        <div><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar ${mode === "adsets" ? "conjunto" : "anúncio"}`} /><button className="button secondary" disabled={loading || !clientName} onClick={() => void load(clientName, true)}>Atualizar Meta</button></div>
      </div>
      {error && <div className="error-box">{error}</div>}{warning && <div className="aii-inline-warning">{warning}</div>}
      {loading ? <div className="card aii-structure-loading"><span className="aii-spinner"/><div><b>Lendo estrutura direto da Meta</b><small>Dados ao vivo; benchmark só entra depois de validar a coorte.</small></div></div> : mode === "adsets" ?
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Conjunto</th><th>Status</th><th>Sinal</th><th>Budget</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Ações</th></tr></thead><tbody>{rows.map((row) => {
        const status = String(row.status || "").toUpperCase(); const hasDaily = (finite(row.daily_budget) || 0) > 0; const signal = rowSignal(context); const url = metaAdsetUrl(row);
        return <tr key={row.id}><td><b>{row.name}</b><small>ID {row.id}{row.source === "WAREHOUSE_SNAPSHOT" ? " · snapshot" : ""}</small></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td><span className={`aii-signal ${signal.tone}`}>{signal.label}</span></td><td><b>{hasDaily ? budgetMoney(row.daily_budget) : "CBO / sem budget local"}</b></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td><div className="aii-row-actions"><button className="aii-recommend-button" onClick={() => void openAdvisor(row)}>Recomendações</button>{url ? <a className="aii-meta-link" href={url} target="_blank" rel="noreferrer">Editar na Meta ↗</a> : <span className="muted">sem link</span>}</div></td></tr>;
      })}{!rows.length && <tr><td colSpan={9} className="aii-no-rows">{payload.partial ? "Nenhum conjunto pôde ser carregado na parte da leitura que respondeu." : "Nenhum conjunto encontrado."}</td></tr>}</tbody></table></div> :
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Anúncio</th><th>Status</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Freq.</th><th>Ação</th></tr></thead><tbody>{rows.map((row) => {
        const status = String(row.status || "").toUpperCase(); const image = String(row.creative?.thumbnail_url || row.creative?.image_url || ""); const url = metaAdUrl(row);
        return <tr key={row.id}><td><div className="aii-ad-name">{image ? <img src={image} alt="" /> : <span className="aii-ad-placeholder">AD</span>}<div><b>{row.name}</b><small>ID {row.id}</small></div></div></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td>{number(row.frequency, 2)}</td><td>{url ? <a className="aii-meta-link" href={url} target="_blank" rel="noreferrer">Editar na Meta ↗</a> : <span className="muted">sem link</span>}</td></tr>;
      })}{!rows.length && <tr><td colSpan={8} className="aii-no-rows">{payload.partial ? "Nenhum anúncio pôde ser carregado na parte da leitura que respondeu." : "Nenhum anúncio encontrado."}</td></tr>}</tbody></table></div>}
      <footer className="aii-structure-footer"><span>{rows.length} objetos</span><span>Ads Intelligence recomenda · Meta continua sendo a fonte de edição</span></footer>
    </section>

    {advisorRow && createPortal(<div className="aii-advisor-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); } }}><section className="aii-advisor-modal" role="dialog" aria-modal="true">
      <header><div><span className="eyebrow">Recomendações por campo</span><h3>{advisorRow.name}</h3><p>Benchmark só é usado quando a coorte tem evidência estruturada de produto + geografia compatível e amostra mínima. Sem isso, o sistema não inventa recomendação.</p></div><button onClick={() => { setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); }}>×</button></header>
      {advisorLoading ? <div className="aii-advisor-loading"><span className="aii-spinner"/><div><b>Validando configuração e coorte</b><small>Lendo Meta + produto estruturado + cidade/estado + ticket.</small></div></div> : <div className="aii-advisor-body">
        <div className={`aii-cohort-proof ${advisorBenchmark?.valid_for_recommendation ? "valid" : "insufficient"}`}>
          <div><small>COORTE USADA</small><b>{cohortLabel(advisorBenchmark)}</b><span>{advisorBenchmark?.methodology || "Sem benchmark contextual."}</span></div>
          <div className="aii-cohort-tags"><span>Produto: {advisorBenchmark?.scope?.product_name || advisorBenchmark?.scope?.product_type_key || "não resolvido"}</span><span>Local: {advisorBenchmark?.scope?.city || advisorBenchmark?.scope?.state || "não resolvido"}</span><span>Ticket: {advisorBenchmark?.scope?.ticket_band || "não resolvido"}</span><span>Match: {advisorBenchmark?.scope?.product_match || "—"}</span></div>
        </div>
        <div className="aii-advisor-kpis"><div><small>CPR conjunto</small><b>{money(advisorRow.cost_per_result)}</b><span>{advisorBenchmark?.valid_for_recommendation ? `coorte ${money(advisorBenchmark?.cpl)}` : "sem comparação autorizada"}</span></div><div><small>CTR conjunto</small><b>{pct(advisorRow.ctr)}</b><span>{advisorBenchmark?.valid_for_recommendation ? `coorte ${pct(advisorBenchmark?.ctr)}` : "sem comparação autorizada"}</span></div><div><small>Frequência</small><b>{number(advisorRow.frequency, 2)}</b><span>{advisorBenchmark?.valid_for_recommendation ? `coorte ${number(advisorBenchmark?.frequency, 2)}` : "sem comparação autorizada"}</span></div><div><small>Budget restante</small><b>{money(context?.pacing?.remaining_budget)}</b><span>teto {money(context?.budget?.monthly_budget)}</span></div></div>
        <div className="aii-advisor-grid">{recommendations.map((rec) => <article className={`aii-field-rec ${rec.tone}`} key={rec.field}><div className="aii-field-rec-top"><b>{rec.field}</b><span>Confiança {rec.confidence.toLowerCase()}</span></div><small className="current">Atual: {rec.current}</small><h4>{rec.action}</h4><p>{rec.reason}</p></article>)}</div>
        <div className="aii-advisor-note"><b>Regra de decisão</b><span>Nenhuma recomendação usa benchmark nacional ou carteira inteira como substituto de uma coorte comparável. Quando não há amostra suficiente, a decisão fica conservadora e pede evidência da própria conta.</span></div>
      </div>}
      <footer><div><b>Edição centralizada na Meta</b><span>O dashboard recomenda; o Gerenciador continua sendo a única fonte de edição.</span></div><div><button className="button secondary" onClick={() => { setAdvisorRow(null); setAdvisorState(null); setAdvisorBenchmark(null); }}>Fechar</button>{metaAdsetUrl(advisorRow, advisorState) ? <a className="button aii-meta-primary" href={metaAdsetUrl(advisorRow, advisorState)} target="_blank" rel="noreferrer">Editar este conjunto na Meta ↗</a> : null}</div></footer>
    </section></div>, document.body)}
  </>, host);
}