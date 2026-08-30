"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, supabase } from "./shared";

type Row = Record<string, any>;
type Mode = "adsets" | "ads" | null;
type CacheEntry = { at: number; payload: Row };

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

function errorLabel(body: Row, fallback: string) {
  const code = String(body?.error || "");
  if (code === "budget_guard_blocked") {
    const guard = body?.budget_guard || {};
    const room = finite(guard.daily_increase_room);
    const requested = finite(guard.requested_daily_increase);
    return `Budget Guard bloqueou o aumento. Folga diária estimada: ${room === null ? "não confirmada" : money(room)}; aumento pedido: ${requested === null ? "—" : money(requested)}.`;
  }
  if (code === "currency_not_supported_for_inline_budget") return "Edição de budget inline foi bloqueada porque a conta não está em BRL.";
  if (code === "object_state_not_toggleable") return "Esse objeto está em um estado que não pode ser alternado diretamente.";
  return String(body?.detail || body?.error || fallback);
}

function partialLabel(payload: Row) {
  const errors: Row[] = payload?.account_errors || [];
  const coverage = payload?.coverage || {};
  if (!errors.length) return "";
  const first = errors[0];
  const stageLabels: Record<string, string> = {
    ADSETS_STRUCTURE: "estrutura de conjuntos",
    ADS_STRUCTURE: "estrutura de anúncios",
    ADSETS_INSIGHTS: "métricas de conjuntos",
    ADS_INSIGHTS: "métricas de anúncios",
  };
  const stage = stageLabels[String(first.stage || "")] || "leitura Meta";
  const loaded = `${number(coverage.adsets_loaded)} conjuntos e ${number(coverage.ads_loaded)} anúncios carregados`;
  return `Leitura parcial da Meta: falha em ${stage} na conta ${first.account_id || "vinculada"}. ${loaded}. O que respondeu foi mantido; ações continuam protegidas por validação de propriedade.`;
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
  const [editingId, setEditingId] = useState("");
  const [budgetValue, setBudgetValue] = useState("");
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
    if (!force && cached && Date.now() - cached.at < CACHE_MS) {
      setPayload(cached.payload);
      setError("");
      return;
    }
    setLoading(true); setError(""); setToast("");
    try {
      const response = await fetch(`${STRUCTURE_API}?client_name=${encodeURIComponent(name)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorLabel(body, `API ${response.status}`));
      cacheRef.current.set(name, { at: Date.now(), payload: body });
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar estrutura Meta.");
    } finally { setLoading(false); }
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
      if (!currentRoot || !detailHost || !tabs) {
        setRoot(null); setHost(null);
        return;
      }
      setRoot(currentRoot);
      setHost(detailHost);
      const ensureButton = (key: "adsets" | "ads", label: string) => {
        let button = tabs.querySelector<HTMLButtonElement>(`[data-aii-structure-tab="${key}"]`);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.dataset.aiiStructureTab = key;
          button.textContent = label;
          tabs.appendChild(button);
        }
        return button;
      };
      const adsetsButton = ensureButton("adsets", "Conjuntos");
      const adsButton = ensureButton("ads", "Anúncios");
      const open = (next: "adsets" | "ads") => {
        const name = String(currentRoot.querySelector(".aii-client-hero h2")?.textContent || "").trim();
        setClientName(name);
        setMode(next);
        setQuery(""); setEditingId(""); setError(""); setToast("");
        if (name) void load(name, false);
        else setError("Selecione um cliente antes de abrir Conjuntos ou Anúncios.");
      };
      const onSets = () => open("adsets");
      const onAds = () => open("ads");
      const onTabs = (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest("button") : null;
        if (!target || target.hasAttribute("data-aii-structure-tab")) return;
        setMode(null); setEditingId(""); setError(""); setToast("");
      };
      const onRootClick = (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest(".aii-client-row") : null;
        if (!target) return;
        setMode(null); setClientName(""); setEditingId(""); setError(""); setToast("");
      };
      cleanup?.();
      adsetsButton.addEventListener("click", onSets);
      adsButton.addEventListener("click", onAds);
      tabs.addEventListener("click", onTabs, true);
      currentRoot.addEventListener("click", onRootClick, true);
      cleanup = () => {
        adsetsButton.removeEventListener("click", onSets);
        adsButton.removeEventListener("click", onAds);
        tabs.removeEventListener("click", onTabs, true);
        currentRoot.removeEventListener("click", onRootClick, true);
      };
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(install);
    };
    install();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cleanup?.(); };
  }, [headers, load]);

  useEffect(() => {
    if (!root) return;
    root.classList.toggle("aii-structure-active", Boolean(mode));
    root.querySelectorAll<HTMLButtonElement>("[data-aii-structure-tab]").forEach((button) => button.classList.toggle("active", button.dataset.aiiStructureTab === mode));
    return () => root.classList.remove("aii-structure-active");
  }, [root, mode]);

  const mutate = useCallback(async (row: Row, objectType: "ADSET" | "AD", action: "SET_STATUS" | "SET_DAILY_BUDGET", value?: string) => {
    if (!headers || !clientName) return;
    const id = String(row.id || "");
    setBusyId(id); setError(""); setToast("");
    try {
      const bodyPayload: Row = { client_name: clientName, object_type: objectType, object_id: id, action };
      if (action === "SET_STATUS") bodyPayload.status = value;
      else bodyPayload.daily_budget = Number(String(value || "").replace(",", "."));
      const response = await fetch(ACTION_API, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(bodyPayload), cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) throw new Error(errorLabel(body, `Meta ${response.status}`));
      setToast(`${row.name || objectType}: alteração aplicada e verificada na Meta.`);
      setEditingId("");
      cacheRef.current.delete(clientName);
      await load(clientName, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao alterar objeto Meta.");
    } finally { setBusyId(""); }
  }, [headers, clientName, load]);

  const toggle = useCallback((row: Row, objectType: "ADSET" | "AD") => {
    const status = String(row.status || "").toUpperCase();
    if (!["ACTIVE", "PAUSED"].includes(status)) return;
    const desired = status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const verb = desired === "ACTIVE" ? "ativar" : "pausar";
    if (!window.confirm(`Confirmar ${verb} “${row.name}” na Meta? A alteração será auditada e verificada.`)) return;
    void mutate(row, objectType, "SET_STATUS", desired);
  }, [mutate]);

  const saveBudget = useCallback((row: Row) => {
    const numeric = Number(budgetValue.replace(",", "."));
    if (!Number.isFinite(numeric) || numeric < 1) { setError("Informe um budget diário válido em reais."); return; }
    const current = finite(row.daily_budget) === null ? null : Number(row.daily_budget) / 100;
    if (!window.confirm(`Alterar o budget diário de “${row.name}” de ${current === null ? "—" : money(current)} para ${money(numeric)}? O Budget Guard valida o teto mensal antes do aumento.`)) return;
    void mutate(row, "ADSET", "SET_DAILY_BUDGET", String(numeric));
  }, [budgetValue, mutate]);

  const rows = useMemo(() => {
    const source: Row[] = mode === "ads" ? payload.ads || [] : payload.adsets || [];
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return source;
    return source.filter((row) => `${row.name} ${row.campaign_name || ""} ${row.status || ""}`.toLocaleLowerCase("pt-BR").includes(needle));
  }, [payload, mode, query]);

  if (!host || !root || !mode) return null;
  const warning = partialLabel(payload);
  return createPortal(
    <section className="aii-structure-content">
      <div className="aii-structure-head">
        <div><span className="eyebrow">Meta ao vivo · 7 dias</span><h3>{mode === "adsets" ? "Conjuntos de anúncios" : "Anúncios"}</h3><p>{mode === "adsets" ? "Status, budget, otimização e performance por conjunto." : "Entrega e performance por anúncio, com controle de status."}</p></div>
        <div><input className="control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar ${mode === "adsets" ? "conjunto" : "anúncio"}`} /><button className="button secondary" disabled={loading || !clientName} onClick={() => void load(clientName, true)}>Atualizar Meta</button></div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {toast && <div className="aii-toast">{toast}</div>}
      {warning && <div className="aii-inline-warning">{warning}</div>}
      {loading ? <div className="card aii-structure-loading"><span className="aii-spinner"/><div><b>Lendo estrutura direto da Meta</b><small>A primeira leitura consulta a Meta; as próximas usam cache por 90 segundos.</small></div></div> :
      mode === "adsets" ? <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Conjunto</th><th>Status</th><th>Budget diário</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Otimização</th><th>Ações</th></tr></thead><tbody>
        {rows.map((row) => {
          const status = String(row.status || "").toUpperCase();
          const busy = busyId === String(row.id);
          const hasDaily = (finite(row.daily_budget) || 0) > 0;
          return <tr key={row.id}><td><b>{row.name}</b><small>ID {row.id}</small></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td>{editingId === String(row.id) ? <div className="aii-budget-edit"><span>R$</span><input value={budgetValue} onChange={(e) => setBudgetValue(e.target.value)} inputMode="decimal" autoFocus /><button disabled={busy} onClick={() => saveBudget(row)}>Salvar</button><button className="ghost" onClick={() => setEditingId("")}>×</button></div> : <div className="aii-budget-display"><b>{hasDaily ? budgetMoney(row.daily_budget) : "CBO / sem budget local"}</b>{hasDaily && <button onClick={() => { setEditingId(String(row.id)); setBudgetValue(String((Number(row.daily_budget) / 100).toFixed(2)).replace(".", ",")); }}>Editar</button>}</div>}</td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td><span className="aii-optimization">{String(row.optimization_goal || "—").replaceAll("_", " ")}</span></td><td><button className={`aii-toggle ${status === "ACTIVE" ? "pause" : "resume"}`} disabled={busy || !["ACTIVE","PAUSED"].includes(status)} onClick={() => toggle(row, "ADSET")}>{busy ? "Aplicando…" : status === "ACTIVE" ? "Pausar" : "Ativar"}</button></td></tr>;
        })}
        {!rows.length && <tr><td colSpan={9} className="aii-no-rows">{payload.partial ? "Nenhum conjunto pôde ser carregado na parte da leitura que respondeu." : "Nenhum conjunto encontrado."}</td></tr>}
      </tbody></table></div> : <div className="card aii-table-wrap"><table className="aii-table aii-structure-table"><thead><tr><th>Anúncio</th><th>Status</th><th>Gasto 7d</th><th>Resultados</th><th>CPR</th><th>CTR</th><th>Freq.</th><th>Ação</th></tr></thead><tbody>
        {rows.map((row) => {
          const status = String(row.status || "").toUpperCase();
          const busy = busyId === String(row.id);
          const image = String(row.creative?.thumbnail_url || row.creative?.image_url || "");
          return <tr key={row.id}><td><div className="aii-ad-name">{image ? <img src={image} alt="" /> : <span className="aii-ad-placeholder">AD</span>}<div><b>{row.name}</b><small>ID {row.id}</small></div></div></td><td><span className={`aii-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "Ativo" : status === "PAUSED" ? "Pausado" : status || "—"}</span></td><td>{money(row.spend)}</td><td>{number(row.results)}</td><td>{money(row.cost_per_result)}</td><td>{pct(row.ctr)}</td><td>{number(row.frequency, 2)}</td><td><button className={`aii-toggle ${status === "ACTIVE" ? "pause" : "resume"}`} disabled={busy || !["ACTIVE","PAUSED"].includes(status)} onClick={() => toggle(row, "AD")}>{busy ? "Aplicando…" : status === "ACTIVE" ? "Pausar" : "Ativar"}</button></td></tr>;
        })}
        {!rows.length && <tr><td colSpan={8} className="aii-no-rows">{payload.partial ? "Nenhum anúncio pôde ser carregado na parte da leitura que respondeu." : "Nenhum anúncio encontrado."}</td></tr>}
      </tbody></table></div>}
      <footer className="aii-structure-footer"><span>{rows.length} objetos</span><span>Primeira leitura ao vivo · cache 90s · ações sempre verificadas</span></footer>
    </section>,
    host,
  );
}