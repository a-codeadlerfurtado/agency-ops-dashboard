"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, supabase } from "./shared";

type Row = Record<string, any>;
type Mode = "adsets" | "ads" | null;
type CacheEntry = { at: number; payload: Row };
type AdsetDraft = {
  name: string;
  status: string;
  daily_budget: string;
  lifetime_budget: string;
  optimization_goal: string;
  billing_event: string;
  bid_strategy: string;
  bid_amount: string;
  destination_type: string;
  start_time: string;
  end_time: string;
  targeting: string;
  attribution_spec: string;
  promoted_object: string;
};

const STRUCTURE_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-structure-api`;
const ACTION_API = `${SUPABASE_URL}/functions/v1/agency-ops-ads-intelligence-action-api`;
const CACHE_MS = 90_000;

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const money = (value: unknown) => finite(value) === null ? "—" : formatMoney(value);
const number = (value: unknown, digits = 0) => finite(value) === null ? "—" : formatNumber(value, digits);
const pct = (value: unknown, digits = 2) => finite(value) === null ? "—" : `${number(value, digits)}%`;
const budgetMoney = (value: unknown) => finite(value) === null ? "—" : formatMoney(Number(value) / 100);
const jsonText = (value: unknown) => value && typeof value === "object" ? JSON.stringify(value, null, 2) : "";
const moneyInput = (value: unknown) => finite(value) === null ? "" : (Number(value) / 100).toFixed(2).replace(".", ",");
function dateInput(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function parseMoneyInput(value: string) {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
function parseJsonField(value: string, label: string) {
  const text = value.trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`${label}: JSON inválido.`); }
}
function errorLabel(body: Row, fallback: string) {
  const code = String(body?.error || "");
  if (code === "budget_guard_blocked") {
    const guard = body?.budget_guard || {};
    const room = finite(guard.daily_increase_room);
    const requested = finite(guard.requested_daily_increase);
    const remaining = finite(guard.remaining_budget);
    if (finite(guard.requested_lifetime_increase) !== null) return `Budget Guard bloqueou o aumento. Restante mensal estimado: ${remaining === null ? "não confirmado" : money(remaining)}.`;
    return `Budget Guard bloqueou o aumento. Folga diária estimada: ${room === null ? "não confirmada" : money(room)}; aumento pedido: ${requested === null ? "—" : money(requested)}.`;
  }
  if (code === "currency_not_supported_for_inline_budget") return "Edição de budget foi bloqueada porque a conta não está em BRL.";
  if (code === "object_state_not_toggleable") return "Esse objeto está em um estado que não pode ser alternado diretamente.";
  if (code === "no_changes") return "Nenhuma alteração foi detectada.";
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
  return `Leitura parcial da Meta: falha em ${stage} na conta ${first.account_id || "vinculada"}. ${loaded}. O que respondeu foi mantido; ações continuam protegidas por validação de propriedade.`;
}
function draftFromState(row: Row): AdsetDraft {
  return {
    name: String(row.name || ""), status: String(row.status || "").toUpperCase(),
    daily_budget: moneyInput(row.daily_budget), lifetime_budget: moneyInput(row.lifetime_budget),
    optimization_goal: String(row.optimization_goal || ""), billing_event: String(row.billing_event || ""),
    bid_strategy: String(row.bid_strategy || ""), bid_amount: moneyInput(row.bid_amount),
    destination_type: String(row.destination_type || ""), start_time: dateInput(row.start_time), end_time: dateInput(row.end_time),
    targeting: jsonText(row.targeting), attribution_spec: jsonText(row.attribution_spec), promoted_object: jsonText(row.promoted_object),
  };
}

export default function AdsIntelligenceStructureBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [clientName, setClientName] = useState("");
  const [payload, setPayload] = useState<Row>({ adsets: [], ads: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editState, setEditState] = useState<Row | null>(null);
  const [draft, setDraft] = useState<AdsetDraft | null>(null);
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);
  const headers = useMemo(() => session?.access_token ? { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY } : null, [session?.access_token]);

  const load = useCallback(async (name: string, force = false) => {
    if (!headers || !name) return;
    const cached = cacheRef.current.get(name);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) { setPayload(cached.payload); setError(""); return; }
    setLoading(true); setError(""); setToast("");
    try {
      const response = await fetch(`${STRUCTURE_API}?client_name=${encodeURIComponent(name)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorLabel(body, `API ${response.status}`));
      cacheRef.current.set(name, { at: Date.now(), payload: body });
      setPayload(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar estrutura Meta."); }
    finally { setLoading(false); }
  }, [headers]);

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
        setClientName(name); setMode(next); setQuery(""); setEditState(null); setDraft(null); setError(""); setToast("");
        if (name) void load(name, false); else setError("Selecione um cliente antes de abrir Conjuntos ou Anúncios.");
      };
      const onSets = () => open("adsets"); const onAds = () => open("ads");
      const onTabs = (event: Event) => { const target = event.target instanceof Element ? event.target.closest("button") : null; if (!target || target.hasAttribute("data-aii-structure-tab")) return; setMode(null); setEditState(null); setDraft(null); setError(""); setToast(""); };
      const onRootClick = (event: Event) => { const target = event.target instanceof Element ? event.target.closest(".aii-client-row") : null; if (!target) return; setMode(null); setClientName(""); setEditState(null); setDraft(null); setError(""); setToast(""); };
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

  const requestAction = useCallback(async (row: Row, objectType: "ADSET" | "AD", action: string, extra: Row = {}) => {
    if (!headers || !clientName) throw new Error("Cliente não selecionado.");
    const response = await fetch(ACTION_API, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, object_type: objectType, object_id: String(row.id || ""), action, ...extra }), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(errorLabel(body, `Meta ${response.status}`));
    return body;
  }, [headers, clientName]);

  const toggle = useCallback(async (row: Row, objectType: "ADSET" | "AD") => {
    const status = String(row.status || "").toUpperCase(); if (!["ACTIVE", "PAUSED"].includes(status)) return;
    const desired = status === "ACTIVE" ? "PAUSED" : "ACTIVE"; const verb = desired === "ACTIVE" ? "ativar" : "pausar";
    if (!window.confirm(`Confirmar ${verb} “${row.name}” na Meta? A alteração será auditada e verificada.`)) return;
    const id = String(row.id || ""); setBusyId(id); setError(""); setToast("");
    try { await requestAction(row, objectType, "SET_STATUS", { status: desired }); setToast(`${row.name}: ${desired === "ACTIVE" ? "ativado" : "pausado"} e verificado na Meta.`); cacheRef.current.delete(clientName); await load(clientName, true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao alterar status."); }
    finally { setBusyId(""); }
  }, [requestAction, clientName, load]);

  const openEditor = useCallback(async (row: Row) => {
    setEditorLoading(true); setError(""); setToast(""); setEditState(row); setDraft(draftFromState(row));
    try {
      const body = await requestAction(row, "ADSET", "GET_STATE");
      const state = body?.state || row; setEditState(state); setDraft(draftFromState(state));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível carregar todos os campos do conjunto."); }
    finally { setEditorLoading(false); }
  }, [requestAction]);

  const saveEditor = useCallback(async () => {
    if (!editState || !draft) return;
    const changes: Row = {};
    const before = draftFromState(editState);
    if (draft.name.trim() && draft.name.trim() !== before.name) changes.name = draft.name.trim();
    if (["ACTIVE", "PAUSED"].includes(draft.status) && draft.status !== before.status) changes.status = draft.status;
    for (const field of ["optimization_goal", "billing_event", "bid_strategy", "destination_type"] as const) {
      const value = draft[field].trim(); if (value && value !== before[field]) changes[field] = value;
    }
    for (const field of ["daily_budget", "lifetime_budget", "bid_amount"] as const) {
      if (draft[field] === before[field]) continue;
      const value = parseMoneyInput(draft[field]); if (value === null || value < 0) { setError(`${field}: informe um valor válido.`); return; }
      changes[field] = value;
    }
    for (const field of ["start_time", "end_time"] as const) {
      if (draft[field] && draft[field] !== before[field]) changes[field] = new Date(draft[field]).toISOString();
    }
    try {
      if (draft.targeting !== before.targeting) changes.targeting = parseJsonField(draft.targeting, "Público e posicionamentos");
      if (draft.attribution_spec !== before.attribution_spec) changes.attribution_spec = parseJsonField(draft.attribution_spec, "Atribuição");
      if (draft.promoted_object !== before.promoted_object) changes.promoted_object = parseJsonField(draft.promoted_object, "Objeto promovido");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "JSON inválido."); return; }
    Object.keys(changes).forEach((key) => { if (changes[key] === null) delete changes[key]; });
    if (!Object.keys(changes).length) { setError("Nenhuma alteração foi detectada."); return; }
    const labels: Record<string, string> = { name: "nome", status: "status", daily_budget: "budget diário", lifetime_budget: "budget total", optimization_goal: "otimização", billing_event: "cobrança", bid_strategy: "estratégia de lance", bid_amount: "lance", destination_type: "destino", start_time: "início", end_time: "fim", targeting: "público/posicionamentos", attribution_spec: "atribuição", promoted_object: "objeto promovido" };
    if (!window.confirm(`Aplicar na Meta as alterações de ${Object.keys(changes).map((key) => labels[key] || key).join(", ")} em “${editState.name}”? O backend fará preflight, Budget Guard quando aplicável, auditoria e releitura pós-ação.`)) return;
    const id = String(editState.id); setBusyId(id); setError(""); setToast("");
    try {
      await requestAction(editState, "ADSET", "PATCH_ADSET", { changes });
      setToast(`${changes.name || editState.name}: alterações aplicadas e relidas na Meta.`); setEditState(null); setDraft(null); cacheRef.current.delete(clientName); await load(clientName, true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao editar conjunto."); }
    finally { setBusyId(""); }
  }, [editState, draft, requestAction, clientName, load]);

  const rows = useMemo(() => {
    const source: Row[] = mode === "ads" ? payload.ads || [] : payload.adsets || [];
    const needle = query.trim().toLocaleLowerCase("pt-BR"); if (!needle) return source;
    return source.filter((row) => `${row.name} ${row.campaign_name || ""} ${row.status || ""}`.toLocaleLowerCase("pt-BR").includes(needle));
  }, [payload, mode, query]);

  if (!host || !root || !mode) return null;
  const warning = partialLabel(payload);
  return createPortal(<>
    <section className="aii-structure-content">
      <div className="aii-structure-head"><div><span className="eyebrow">Meta ao vivo · 7 dias</span><h3>{mode === "adsets" ? "Conjuntos de anúncios" : "Anúncios"}</h3><p>{mode === "adsets" ? "Performance e edição avançada do conjunto, com Budget Guard e auditoria." : "Entrega e performance por anúncio, com controle de status."}</p></div><div><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar ${mode === "adsets" ? "conjunto" : "anúncio"}`} /><button className="button secondary" disabled={loading || !clientName} onClick={() => void load(clientName, true)}>Atualizar Meta</button></div></div>
      {error && <div className="error-box">{error}</div>}{toast && <div className="aii-toast">{toast}</div>}{warning && <div className="aii-inline-warning">{warning}</div>}
      {loading ? <div className="card aii-structure-loading"><span className="aii-spinner"/><div><b>Lendo estrutura direto da Meta</b><small>A primeira leitura consulta a Meta; as próximas usam cache por 90 segundos.</small></div></div> : mode === "adsets" ?
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Conjunto</th><th>Status</th><th>Budget diário</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Otimização</th><th>Ações</th></tr></thead><tbody>{rows.map((row) => { const status = String(row.status || "").toUpperCase(); const busy = busyId === String(row.id); const hasDaily = (finite(row.daily_budget) || 0) > 0; return <tr key={row.id}><td><b>{row.name}</b><small>ID {row.id}{row.source === "WAREHOUSE_SNAPSHOT" ? " · snapshot" : ""}</small></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td><b>{hasDaily ? budgetMoney(row.daily_budget) : "CBO / sem budget local"}</b></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td><span className="aii-optimization">{String(row.optimization_goal || "—").replaceAll("_", " ")}</span></td><td><div className="aii-row-actions"><button className="aii-edit-button" disabled={busy} onClick={() => void openEditor(row)}>Editar</button><button className={`aii-toggle ${status === "ACTIVE" ? "pause" : "resume"}`} disabled={busy || !["ACTIVE","PAUSED"].includes(status)} onClick={() => void toggle(row, "ADSET")}>{busy ? "Aplicando…" : status === "ACTIVE" ? "Pausar" : "Ativar"}</button></div></td></tr>; })}{!rows.length && <tr><td colSpan={9} className="aii-no-rows">{payload.partial ? "Nenhum conjunto pôde ser carregado na parte da leitura que respondeu." : "Nenhum conjunto encontrado."}</td></tr>}</tbody></table></div> :
      <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Anúncio</th><th>Status</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Freq.</th><th>Ação</th></tr></thead><tbody>{rows.map((row) => { const status = String(row.status || "").toUpperCase(); const busy = busyId === String(row.id); const image = String(row.creative?.thumbnail_url || row.creative?.image_url || ""); return <tr key={row.id}><td><div className="aii-ad-name">{image ? <img src={image} alt="" /> : <span className="aii-ad-placeholder">AD</span>}<div><b>{row.name}</b><small>ID {row.id}</small></div></div></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td>{number(row.frequency, 2)}</td><td><button className={`aii-toggle ${status === "ACTIVE" ? "pause" : "resume"}`} disabled={busy || !["ACTIVE","PAUSED"].includes(status)} onClick={() => void toggle(row, "AD")}>{busy ? "Aplicando…" : status === "ACTIVE" ? "Pausar" : "Ativar"}</button></td></tr>; })}{!rows.length && <tr><td colSpan={8} className="aii-no-rows">{payload.partial ? "Nenhum anúncio pôde ser carregado na parte da leitura que respondeu." : "Nenhum anúncio encontrado."}</td></tr>}</tbody></table></div>}
      <footer className="aii-structure-footer"><span>{rows.length} objetos</span><span>Leitura ao vivo + fallback · cache 90s · ações verificadas</span></footer>
    </section>
    {editState && draft && createPortal(<div className="aii-editor-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busyId) { setEditState(null); setDraft(null); } }}><section className="aii-editor-modal" role="dialog" aria-modal="true"><header><div><span className="eyebrow">Editor de conjunto</span><h3>{editState.name}</h3><p>Edite os principais campos que a Marketing API aceita. A Meta ainda valida compatibilidade com objetivo, CBO, categoria especial e estado do conjunto.</p></div><button disabled={Boolean(busyId)} onClick={() => { setEditState(null); setDraft(null); }}>×</button></header>{editorLoading ? <div className="aii-editor-loading"><span className="aii-spinner"/>Lendo configuração completa…</div> : <div className="aii-editor-body">
      <div className="aii-editor-section"><div className="aii-editor-section-title"><b>Básico</b><small>identificação e entrega</small></div><div className="aii-form-grid"><label className="wide">Nome<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}><option value={draft.status}>{draft.status || "—"}</option><option value="ACTIVE">ACTIVE</option><option value="PAUSED">PAUSED</option></select></label><label>Destino<input list="aii-destinations" value={draft.destination_type} onChange={(e) => setDraft({ ...draft, destination_type: e.target.value.toUpperCase() })}/></label></div></div>
      <div className="aii-editor-section"><div className="aii-editor-section-title"><b>Orçamento e lance</b><small>Budget Guard é aplicado quando houver aumento</small></div><div className="aii-form-grid"><label>Budget diário (R$)<input inputMode="decimal" value={draft.daily_budget} onChange={(e) => setDraft({ ...draft, daily_budget: e.target.value })} placeholder="CBO / vazio"/></label><label>Budget total (R$)<input inputMode="decimal" value={draft.lifetime_budget} onChange={(e) => setDraft({ ...draft, lifetime_budget: e.target.value })}/></label><label>Estratégia de lance<input list="aii-bids" value={draft.bid_strategy} onChange={(e) => setDraft({ ...draft, bid_strategy: e.target.value.toUpperCase() })}/></label><label>Valor do lance (R$)<input inputMode="decimal" value={draft.bid_amount} onChange={(e) => setDraft({ ...draft, bid_amount: e.target.value })}/></label><label>Evento de cobrança<input list="aii-billing" value={draft.billing_event} onChange={(e) => setDraft({ ...draft, billing_event: e.target.value.toUpperCase() })}/></label><label>Otimização<input list="aii-optimization-goals" value={draft.optimization_goal} onChange={(e) => setDraft({ ...draft, optimization_goal: e.target.value.toUpperCase() })}/></label></div></div>
      <div className="aii-editor-section"><div className="aii-editor-section-title"><b>Programação</b><small>datas do conjunto</small></div><div className="aii-form-grid"><label>Início<input type="datetime-local" value={draft.start_time} onChange={(e) => setDraft({ ...draft, start_time: e.target.value })}/></label><label>Fim<input type="datetime-local" value={draft.end_time} onChange={(e) => setDraft({ ...draft, end_time: e.target.value })}/></label></div></div>
      <div className="aii-editor-section"><div className="aii-editor-section-title"><b>Público e posicionamentos</b><small>edição avançada do targeting retornado pela Meta</small></div><label className="aii-json-field">Targeting JSON<textarea value={draft.targeting} onChange={(e) => setDraft({ ...draft, targeting: e.target.value })} spellCheck={false}/><span>Inclui geografia, idade quando permitido, públicos, exclusões, plataformas, posições e dispositivos. Restrições de Housing continuam sendo aplicadas pela Meta.</span></label></div>
      <details className="aii-editor-section aii-editor-advanced"><summary>Mais configurações avançadas</summary><div className="aii-form-grid advanced-json"><label>Atribuição<textarea value={draft.attribution_spec} onChange={(e) => setDraft({ ...draft, attribution_spec: e.target.value })} spellCheck={false}/></label><label>Objeto promovido<textarea value={draft.promoted_object} onChange={(e) => setDraft({ ...draft, promoted_object: e.target.value })} spellCheck={false}/></label></div></details>
      <datalist id="aii-bids"><option value="LOWEST_COST_WITHOUT_CAP"/><option value="LOWEST_COST_WITH_BID_CAP"/><option value="COST_CAP"/></datalist><datalist id="aii-billing"><option value="IMPRESSIONS"/><option value="LINK_CLICKS"/></datalist><datalist id="aii-optimization-goals"><option value="LEAD_GENERATION"/><option value="OFFSITE_CONVERSIONS"/><option value="LANDING_PAGE_VIEWS"/><option value="LINK_CLICKS"/><option value="REACH"/><option value="IMPRESSIONS"/><option value="QUALITY_LEAD"/></datalist><datalist id="aii-destinations"><option value="WEBSITE"/><option value="MESSENGER"/><option value="WHATSAPP"/><option value="ON_AD"/></datalist>
    </div>}<footer><div><b>Alteração protegida</b><span>preflight de propriedade · Budget Guard · audit log · releitura pós-ação</span></div><div><button className="button secondary" disabled={Boolean(busyId)} onClick={() => { setEditState(null); setDraft(null); }}>Cancelar</button><button className="button" disabled={Boolean(busyId) || editorLoading} onClick={() => void saveEditor()}>{busyId ? "Aplicando na Meta…" : "Salvar alterações"}</button></div></footer></section></div>, document.body)}
  </>, host);
}
