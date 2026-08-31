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
  return `Leitura parcial da Meta: falha em ${stage} na conta ${first.account_id || "vinculada"}. ${loaded}. O que respondeu foi mantido; recomendações continuam usando apenas dados disponíveis.`;
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
    const manual = publishers.length || ["facebook_positions","instagram_positions","messenger_positions","audience_network_positions"].some((key) => list(targeting[key]).length);
    return manual ? `Manual · ${publishers.length ? publishers.join(", ") : "plataformas definidas por posição"}` : "Advantage+ / automático";
  }
  return "—";
}

function makeRecommendations(row: Row, state: Row, context: Row | null): Recommendation[] {
  const benchmark = context?.benchmark || {};
  const pacing = context?.pacing || {};
  const budget = context?.budget || {};
  const cprRatio = ratio(row.cost_per_result, benchmark.cpl);
  const ctrRatio = ratio(row.ctr, benchmark.ctr);
  const cpcRatio = ratio(row.cpc, benchmark.cpc);
  const freqRatio = ratio(row.frequency, benchmark.frequency);
  const spend = finite(row.spend) || 0;
  const results = finite(row.results) || 0;
  const remaining = finite(pacing.remaining_budget);
  const monthly = finite(budget.monthly_budget);
  const paceStatus = String(pacing.status || "");
  const recs: Recommendation[] = [];

  if (monthly === null) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Não aumentar verba até o teto mensal estar validado.", reason: "O Ads Intelligence não deve recomendar escala sem uma restrição financeira confiável.", confidence: "Alta", tone: "critical" });
  } else if (remaining !== null && (remaining <= Math.max(5, monthly * .05) || ["OVER_PACE","BUDGET_REACHED"].includes(paceStatus))) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Não aumentar. Se mexer, use redistribuição ou redução dentro do teto mensal.", reason: `Restante estimado ${money(remaining)} de ${money(monthly)} e pacing ${paceStatus || "indisponível"}.`, confidence: "Alta", tone: "warn" });
  } else if (cprRatio !== null && cprRatio <= .85 && results >= 3) {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "É candidato a receber redistribuição de verba, sem aumentar o budget mensal do cliente.", reason: `CPR ${money(row.cost_per_result)} está ${number((1 - cprRatio) * 100, 0)}% abaixo da mediana interna (${money(benchmark.cpl)}).`, confidence: "Média", tone: "good" });
  } else {
    recs.push({ field: "Orçamento", current: finite(state.daily_budget) ? `${budgetMoney(state.daily_budget)}/dia` : "CBO / sem budget local", action: "Manter o orçamento por enquanto; não há evidência forte para escalar este conjunto.", reason: `CPR atual ${money(row.cost_per_result)} vs. mediana interna ${money(benchmark.cpl)}.`, confidence: "Média", tone: "info" });
  }

  if ((freqRatio !== null && freqRatio >= 1.2 && ctrRatio !== null && ctrRatio <= .9) || (cprRatio !== null && cprRatio >= 1.25 && ctrRatio !== null && ctrRatio <= .9)) {
    recs.push({ field: "Público", current: fieldSummary(state, "audience"), action: "Testar uma variação de público por vez antes de aumentar verba.", reason: `CTR ${pct(row.ctr)} vs. benchmark ${pct(benchmark.ctr)}${freqRatio !== null ? `; frequência ${number(row.frequency, 2)} vs. ${number(benchmark.frequency, 2)}` : ""}. O sinal combina pior atração com possível saturação/aderência baixa.`, confidence: "Média", tone: "warn" });
  } else {
    recs.push({ field: "Público", current: fieldSummary(state, "audience"), action: "Não alterar o público só para gerar atividade.", reason: `Não há desvio suficientemente forte no benchmark agregado para justificar mexer na segmentação agora. CTR ${pct(row.ctr)} vs. ${pct(benchmark.ctr)}.`, confidence: "Média", tone: "good" });
  }

  recs.push({ field: "Localização", current: fieldSummary(state, "location"), action: cprRatio !== null && cprRatio > 1.2 ? "Abrir o breakdown geográfico na Meta e revisar apenas regiões com gasto relevante e CPR pior." : "Manter; não restringir localização por feeling.", reason: "O benchmark interno atual é agregado e não possui mediana geográfica por cidade/região para este conjunto. A recomendação segura é usar o breakdown da Meta antes de cortar praça.", confidence: "Baixa", tone: cprRatio !== null && cprRatio > 1.2 ? "info" : "good" });

  const placementCurrent = fieldSummary(state, "placements");
  if ((ctrRatio !== null && ctrRatio < .85) || (cpcRatio !== null && cpcRatio > 1.2)) {
    recs.push({ field: "Posicionamentos", current: placementCurrent, action: "Abrir breakdown por posicionamento na Meta antes de limitar entrega; corte apenas placement com volume e ineficiência comprovada.", reason: `CTR ${pct(row.ctr)} vs. ${pct(benchmark.ctr)} e CPC ${money(row.cpc)} vs. ${money(benchmark.cpc)} indicam que vale investigar onde a entrega está pior, mas o benchmark não identifica sozinho qual placement é o culpado.`, confidence: "Média", tone: "info" });
  } else {
    recs.push({ field: "Posicionamentos", current: placementCurrent, action: "Manter os posicionamentos atuais.", reason: "Sem deterioração relevante de CTR/CPC frente à mediana interna, restringir placements tende a adicionar complexidade sem evidência.", confidence: "Média", tone: "good" });
  }

  const optimization = String(state.optimization_goal || "—").replaceAll("_", " ");
  if (results < 5 && spend > 0) {
    recs.push({ field: "Otimização", current: optimization, action: "Não trocar o objetivo de otimização com esta amostra.", reason: `${number(results)} resultado(s) em 7 dias é pouco para atribuir o problema ao optimization goal.`, confidence: "Alta", tone: "info" });
  } else if (ctrRatio !== null && ctrRatio >= 1 && cprRatio !== null && cprRatio > 1.2) {
    recs.push({ field: "Otimização", current: optimization, action: "Antes de mudar otimização, investigar o que acontece depois do clique/lead.", reason: "CTR está pelo menos no benchmark, mas CPR está pior; isso reduz a evidência de que o problema principal seja a entrega do anúncio.", confidence: "Média", tone: "info" });
  } else {
    recs.push({ field: "Otimização", current: optimization, action: "Manter o objetivo atual por enquanto.", reason: "O benchmark disponível não mostra evidência suficiente para atribuir o desvio ao objetivo de otimização.", confidence: "Média", tone: "good" });
  }

  const bid = String(state.bid_strategy || "—").replaceAll("_", " ");
  if (/CAP/i.test(String(state.bid_strategy || "")) && (cprRatio !== null && cprRatio > 1.15 || paceStatus === "UNDER_PACE")) {
    recs.push({ field: "Estratégia de lance", current: bid, action: "Revisar o cap na Meta; ele pode estar limitando a entrega ou encarecendo a obtenção de volume.", reason: `Pacing ${paceStatus || "indisponível"} e CPR ${money(row.cost_per_result)} vs. ${money(benchmark.cpl)}. Faça a mudança como teste controlado, não junto com público/criativo.`, confidence: "Média", tone: "warn" });
  } else {
    recs.push({ field: "Estratégia de lance", current: bid, action: "Manter a estratégia de lance atual.", reason: "Não há evidência benchmark suficiente para trocar lance sem isolar outras variáveis.", confidence: "Baixa", tone: "good" });
  }

  if ((ctrRatio !== null && ctrRatio < .85) || (freqRatio !== null && freqRatio > 1.2)) {
    recs.push({ field: "Criativo / entrega", current: `CTR ${pct(row.ctr)} · Freq. ${number(row.frequency, 2)}`, action: "Priorizar teste de criativo antes de reformar público, lance e otimização ao mesmo tempo.", reason: `CTR/frequência estão desviando da referência interna (${pct(benchmark.ctr)} / ${number(benchmark.frequency, 2)}).`, confidence: "Alta", tone: "warn" });
  } else {
    recs.push({ field: "Criativo / entrega", current: `CTR ${pct(row.ctr)} · Freq. ${number(row.frequency, 2)}`, action: "Sem urgência para trocar criativo por benchmark.", reason: "Os principais sinais de atração/saturação não estão suficientemente ruins frente à referência interna.", confidence: "Média", tone: "good" });
  }

  recs.push({ field: "Programação", current: `${state.start_time ? new Date(state.start_time).toLocaleDateString("pt-BR") : "início não informado"} → ${state.end_time ? new Date(state.end_time).toLocaleDateString("pt-BR") : "sem fim definido"}`, action: paceStatus === "OVER_PACE" ? "Não estender entrega sem primeiro corrigir pacing/orçamento no Meta." : "Manter datas, salvo necessidade comercial real.", reason: paceStatus === "OVER_PACE" ? "A projeção financeira já está acima do ritmo; estender/antecipar entrega pode ampliar o desvio." : "Datas não devem ser alteradas para tentar resolver um KPI sem relação causal comprovada.", confidence: "Alta", tone: paceStatus === "OVER_PACE" ? "warn" : "good" });

  return recs;
}

function rowSignal(row: Row, context: Row | null) {
  const bench = context?.benchmark || {};
  const pacing = context?.pacing || {};
  const cprRatio = ratio(row.cost_per_result, bench.cpl);
  const ctrRatio = ratio(row.ctr, bench.ctr);
  if (["OVER_PACE","BUDGET_REACHED"].includes(String(pacing.status || ""))) return { label: "Budget", tone: "warn" };
  if ((cprRatio !== null && cprRatio > 1.25) || (ctrRatio !== null && ctrRatio < .8)) return { label: "Revisar", tone: "warn" };
  if (cprRatio !== null || ctrRatio !== null) return { label: "Saudável", tone: "good" };
  return { label: "Sem leitura", tone: "muted" };
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
        setClientName(name); setMode(next); setQuery(""); setAdvisorRow(null); setAdvisorState(null); setError("");
        if (name) void load(name, false); else setError("Selecione um cliente antes de abrir Conjuntos ou Anúncios.");
      };
      const onSets = () => open("adsets"); const onAds = () => open("ads");
      const onTabs = (event: Event) => { const target = event.target instanceof Element ? event.target.closest("button") : null; if (!target || target.hasAttribute("data-aii-structure-tab")) return; setMode(null); setAdvisorRow(null); setAdvisorState(null); };
      const onRootClick = (event: Event) => { const target = event.target instanceof Element ? event.target.closest(".aii-client-row") : null; if (!target) return; setMode(null); setClientName(""); setAdvisorRow(null); setAdvisorState(null); setContext(null); };
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
    setAdvisorRow(row); setAdvisorState(null); setAdvisorLoading(true); setError("");
    try {
      const response = await fetch(ACTION_API, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, object_type: "ADSET", object_id: String(row.id), action: "GET_STATE" }), cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) throw new Error(errorLabel(body, `Meta ${response.status}`));
      setAdvisorState(body.state || row);
    } catch (caught) {
      setAdvisorState(row);
      setError(caught instanceof Error ? `${caught.message} As recomendações abaixo usarão apenas os campos já carregados.` : "Não foi possível ler a configuração completa.");
    } finally { setAdvisorLoading(false); }
  }, [headers, clientName]);

  const rows = useMemo(() => {
    const source: Row[] = mode === "ads" ? payload.ads || [] : payload.adsets || [];
    const needle = query.trim().toLocaleLowerCase("pt-BR"); if (!needle) return source;
    return source.filter((row) => `${row.name} ${row.campaign_name || ""} ${row.status || ""}`.toLocaleLowerCase("pt-BR").includes(needle));
  }, [payload, mode, query]);

  const recommendations = useMemo(() => advisorRow && advisorState ? makeRecommendations(advisorRow, advisorState, context) : [], [advisorRow, advisorState, context]);
  if (!host || !root || !mode) return null;
  const warning = partialLabel(payload);

  return createPortal(<>
    <section className="aii-structure-content">
      <div className="aii-structure-head">
        <div><span className="eyebrow">Meta ao vivo · 7 dias</span><h3>{mode === "adsets" ? "Conjuntos de anúncios" : "Anúncios"}</h3><p>{mode === "adsets" ? "Leitura, benchmark e recomendação. A edição acontece no Gerenciador da Meta." : "Leitura de entrega e atalho para editar o anúncio na Meta."}</p></div>
        <div><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar ${mode === "adsets" ? "conjunto" : "anúncio"}`} /><button className="button secondary" disabled={loading || !clientName} onClick={() => void load(clientName, true)}>Atualizar Meta</button></div>
      </div>
      {error && <div className="error-box">{error}</div>}{warning && <div className="aii-inline-warning">{warning}</div>}
      {loading ? <div className="card aii-structure-loading"><span className="aii-spinner"/><div><b>Lendo estrutura direto da Meta</b><small>Dados ao vivo + contexto de benchmark interno.</small></div></div> : mode === "adsets" ?
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Conjunto</th><th>Status</th><th>Sinal</th><th>Budget</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Ações</th></tr></thead><tbody>{rows.map((row) => {
        const status = String(row.status || "").toUpperCase(); const hasDaily = (finite(row.daily_budget) || 0) > 0; const signal = rowSignal(row, context); const url = metaAdsetUrl(row);
        return <tr key={row.id}><td><b>{row.name}</b><small>ID {row.id}{row.source === "WAREHOUSE_SNAPSHOT" ? " · snapshot" : ""}</small></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td><span className={`aii-signal ${signal.tone}`}>{signal.label}</span></td><td><b>{hasDaily ? budgetMoney(row.daily_budget) : "CBO / sem budget local"}</b></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td><div className="aii-row-actions"><button className="aii-recommend-button" onClick={() => void openAdvisor(row)}>Recomendações</button>{url ? <a className="aii-meta-link" href={url} target="_blank" rel="noreferrer">Editar na Meta ↗</a> : <span className="muted">sem link</span>}</div></td></tr>;
      })}{!rows.length && <tr><td colSpan={9} className="aii-no-rows">{payload.partial ? "Nenhum conjunto pôde ser carregado na parte da leitura que respondeu." : "Nenhum conjunto encontrado."}</td></tr>}</tbody></table></div> :
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Anúncio</th><th>Status</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Freq.</th><th>Ação</th></tr></thead><tbody>{rows.map((row) => {
        const status = String(row.status || "").toUpperCase(); const image = String(row.creative?.thumbnail_url || row.creative?.image_url || ""); const url = metaAdUrl(row);
        return <tr key={row.id}><td><div className="aii-ad-name">{image ? <img src={image} alt="" /> : <span className="aii-ad-placeholder">AD</span>}<div><b>{row.name}</b><small>ID {row.id}</small></div></div></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td>{number(row.frequency, 2)}</td><td>{url ? <a className="aii-meta-link" href={url} target="_blank" rel="noreferrer">Editar na Meta ↗</a> : <span className="muted">sem link</span>}</td></tr>;
      })}{!rows.length && <tr><td colSpan={8} className="aii-no-rows">{payload.partial ? "Nenhum anúncio pôde ser carregado na parte da leitura que respondeu." : "Nenhum anúncio encontrado."}</td></tr>}</tbody></table></div>}
      <footer className="aii-structure-footer"><span>{rows.length} objetos</span><span>Ads Intelligence recomenda · Meta continua sendo a fonte de edição</span></footer>
    </section>

    {advisorRow && createPortal(<div className="aii-advisor-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { setAdvisorRow(null); setAdvisorState(null); } }}><section className="aii-advisor-modal" role="dialog" aria-modal="true">
      <header><div><span className="eyebrow">Recomendações por campo</span><h3>{advisorRow.name}</h3><p>Benchmark interno, performance de 7 dias e pacing financeiro orientam a decisão. Campos sem benchmark granular são marcados com confiança menor — sem inventar certeza.</p></div><button onClick={() => { setAdvisorRow(null); setAdvisorState(null); }}>×</button></header>
      {advisorLoading ? <div className="aii-advisor-loading"><span className="aii-spinner"/><div><b>Lendo configuração do conjunto</b><small>Buscando estado atual na Meta antes de recomendar.</small></div></div> : <div className="aii-advisor-body">
        <div className="aii-advisor-kpis"><div><small>CPR conjunto</small><b>{money(advisorRow.cost_per_result)}</b><span>benchmark {money(context?.benchmark?.cpl)}</span></div><div><small>CTR conjunto</small><b>{pct(advisorRow.ctr)}</b><span>benchmark {pct(context?.benchmark?.ctr)}</span></div><div><small>Frequência</small><b>{number(advisorRow.frequency, 2)}</b><span>benchmark {number(context?.benchmark?.frequency, 2)}</span></div><div><small>Budget restante</small><b>{money(context?.pacing?.remaining_budget)}</b><span>teto {money(context?.budget?.monthly_budget)}</span></div></div>
        <div className="aii-advisor-grid">{recommendations.map((rec) => <article className={`aii-field-rec ${rec.tone}`} key={rec.field}><div className="aii-field-rec-top"><b>{rec.field}</b><span>Confiança {rec.confidence.toLowerCase()}</span></div><small className="current">Atual: {rec.current}</small><h4>{rec.action}</h4><p>{rec.reason}</p></article>)}</div>
        <div className="aii-advisor-note"><b>Regra de decisão</b><span>Não mude orçamento, público, posicionamento, lance, otimização e criativo ao mesmo tempo. Escolha a hipótese com melhor evidência, altere na Meta e reavalie após nova amostra.</span></div>
      </div>}
      <footer><div><b>Edição centralizada na Meta</b><span>O dashboard recomenda e preserva uma única fonte de verdade para configuração.</span></div><div><button className="button secondary" onClick={() => { setAdvisorRow(null); setAdvisorState(null); }}>Fechar</button>{metaAdsetUrl(advisorRow, advisorState) ? <a className="button aii-meta-primary" href={metaAdsetUrl(advisorRow, advisorState)} target="_blank" rel="noreferrer">Editar este conjunto na Meta ↗</a> : null}</div></footer>
    </section></div>, document.body)}
  </>, host);
}