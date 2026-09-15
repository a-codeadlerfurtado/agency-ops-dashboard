"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api, authenticatedFetch, SUPABASE_URL, text } from "../shared";
import type { Row } from "../shared";

const GENERAL_SCOPE = "__GENERAL__";
const LEARNING_API = `${SUPABASE_URL}/functions/v1/agency-ops-creative-learning-api`;

type Tab = "summary" | "identity" | "audience" | "rules" | "materials" | "history";
type ClientFilter = "ALL" | "NO_RULES" | "LEARNING" | "CONFIRM" | "CONFLICT" | "COMPLETE";

type LearningProfile = Row & {
  client_id: string;
  coverage_pct: number;
  conflict_count: number;
  learned_count: number;
  weak_signal_count: number;
  evidence_count: number;
  evidence_sources: number;
  learned_items: Row[];
  questions: Row[];
  profile_status: string;
};

const ui: Record<string, CSSProperties> = {
  shell: { display: "grid", gridTemplateColumns: "minmax(250px, 310px) minmax(0, 1fr)", gap: 16, alignItems: "start" },
  panel: { border: "1px solid var(--line, #2b3944)", background: "var(--panel, #12191f)", borderRadius: 16 },
  soft: { border: "1px solid var(--line, #2b3944)", background: "rgba(255,255,255,.025)", borderRadius: 13 },
  button: { border: "1px solid var(--line, #33434f)", background: "rgba(255,255,255,.035)", color: "inherit", borderRadius: 10, padding: "9px 12px", cursor: "pointer", font: "inherit" },
  accentButton: { border: "1px solid rgba(255,122,47,.55)", background: "rgba(255,122,47,.12)", color: "inherit", borderRadius: 10, padding: "9px 12px", cursor: "pointer", font: "inherit", fontWeight: 700 },
  badge: { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--line, #33434f)", borderRadius: 999, padding: "4px 8px", fontSize: 11, lineHeight: 1.1, whiteSpace: "nowrap" },
  muted: { color: "var(--muted, #9eacb7)" },
};

function normalize(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

function formatDateShort(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Não informado";
  if (Array.isArray(value)) return value.map(valueText).filter((item) => item !== "Não informado").join(" · ") || "Não informado";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null && item !== undefined && item !== "")
      .map(([key, item]) => `${friendlyLabel(key)}: ${valueText(item)}`)
      .join(" · ") || "Não informado";
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return String(value);
}

function friendlyLabel(key: string) {
  const map: Record<string, string> = {
    publico: "Público", audience: "Público", focos_produto: "Foco de produto", product_focus: "Foco de produto",
    objetivos: "Objetivos", objectives: "Objetivos", regiao: "Região", region: "Região",
    tipo_cliente: "Tipo de cliente", client_type: "Tipo de cliente", gargalos: "Gargalos", bottlenecks: "Gargalos",
    riscos: "Riscos", risks: "Riscos", condicoes_comerciais: "Condições comerciais", commercial_conditions: "Condições comerciais",
    responsaveis: "Responsáveis", responsibles: "Responsáveis", responsible_parties: "Responsáveis",
    orcamento_midia: "Orçamento de mídia", media_budget: "Orçamento de mídia",
  };
  return map[key] || key.replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function ruleKindLabel(value: unknown) {
  const map: Record<string, string> = {
    DESEJA: "Preferência", EVITAR: "Não fazer", COMO_APLICAR: "Como aplicar", IDENTIDADE: "Identidade",
    PROCESSO: "Processo", DADO_TECNICO: "Fato autorizado",
  };
  return map[String(value ?? "").toUpperCase()] || "Diretriz";
}

function ruleText(rule: Row) {
  return text(rule.rule_text || rule.candidate_text || rule.description || rule.content || "Diretriz");
}

function isConfirmedRule(rule: Row) {
  return ["CONFIRMED", "CONFIRMED_FIXED", "CONFIRMED_PRODUCT"].includes(String(rule.status ?? "").toUpperCase());
}

function isPendingRule(rule: Row) {
  return ["NEEDS_VALIDATION", "PENDING"].includes(String(rule.status ?? "").toUpperCase());
}

function isHistoricalRule(rule: Row) {
  return String(rule.status ?? "").toUpperCase() === "HISTORICAL";
}

function isGeneralScope(rule: Row) {
  const scope = normalize(rule.product_scope);
  return !scope || scope === "todos os produtos" || scope === "geral" || String(rule.classification ?? "").toUpperCase() === "REGRA_FIXA";
}

function scopeMatches(rule: Row, scope: string) {
  if (scope === GENERAL_SCOPE) return isGeneralScope(rule);
  return isGeneralScope(rule) || String(rule.product_scope ?? "").trim() === scope;
}

function paletteItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(paletteItems).filter(Boolean);
  if (typeof value === "string") return value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(paletteItems).filter(Boolean);
  return [];
}

function validCssColor(value: string) {
  return /^(#[0-9a-f]{3,8}|rgb(a)?\(|hsl(a)?\()/i.test(value.trim());
}

function fontItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fontItems).filter(Boolean);
  if (typeof value === "string") return value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${friendlyLabel(key)}: ${valueText(item)}`);
  return [];
}

function assetLinks(value: unknown): Array<{ label: string; url: string }> {
  if (!value) return [];
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [{ label: "Abrir arquivo", url: value }] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) return [{ label: `Arquivo ${index + 1}`, url: item }];
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const url = String(row.url || row.href || row.link || "");
        return /^https?:\/\//i.test(url) ? [{ label: String(row.label || row.name || row.title || `Arquivo ${index + 1}`), url }] : [];
      }
      return [];
    });
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => typeof item === "string" && /^https?:\/\//i.test(item) ? [{ label: friendlyLabel(key), url: item }] : []);
  }
  return [];
}

function latestTimestamp(client: Row) {
  const values = [
    client.brand?.updated_at, client.brand?.last_verified_at, client.learning?.last_signal_at,
    ...(client.rules || []).flatMap((rule: Row) => [rule.updated_at, rule.last_confirmed_at, rule.observed_at]),
    ...(client.briefings || []).flatMap((briefing: Row) => [briefing.last_fetched_at]),
    ...(client.recent_adjustments || []).flatMap((item: Row) => [item.occurred_at]),
    ...(client.recent_materials || []).flatMap((item: Row) => [item.detected_at, item.drive_uploaded_at]),
  ].filter(Boolean).map((value) => new Date(String(value))).filter((date) => !Number.isNaN(date.getTime()));
  return values.length ? values.sort((a, b) => b.getTime() - a.getTime())[0].toISOString() : null;
}

function profileEntries(briefings: Row[]) {
  const profiles = briefings.map((briefing) => briefing.extracted_profile).filter((profile) => profile && typeof profile === "object") as Record<string, unknown>[];
  if (!profiles.length) return [] as Array<{ key: string; label: string; value: string }>;
  const aliases: Array<[string, string[]]> = [
    ["publico", ["publico", "audience"]], ["focos_produto", ["focos_produto", "product_focus"]],
    ["objetivos", ["objetivos", "objectives"]], ["regiao", ["regiao", "region"]],
    ["tipo_cliente", ["tipo_cliente", "client_type"]], ["gargalos", ["gargalos", "bottlenecks"]],
    ["riscos", ["riscos", "risks"]], ["condicoes_comerciais", ["condicoes_comerciais", "commercial_conditions"]],
  ];
  const result: Array<{ key: string; label: string; value: string }> = [];
  for (const [canonical, keys] of aliases) {
    let found: unknown = null;
    for (const profile of profiles) {
      for (const key of keys) {
        if (profile[key] !== null && profile[key] !== undefined && profile[key] !== "") { found = profile[key]; break; }
      }
      if (found !== null) break;
    }
    if (found !== null) result.push({ key: canonical, label: friendlyLabel(canonical), value: valueText(found) });
  }
  return result;
}

function emptyLearning(clientId: string): LearningProfile {
  return {
    client_id: clientId, coverage_pct: 0, conflict_count: 0, learned_count: 0, weak_signal_count: 0,
    evidence_count: 0, evidence_sources: 0, learned_items: [], questions: [], profile_status: "NEEDS_CONFIRMATION",
  };
}

function profileStatusLabel(status: unknown) {
  const map: Record<string, string> = { COMPLETE: "Completo", LEARNING: "Aprendendo", CONFLICT: "Conflito", NEEDS_CONFIRMATION: "Precisa confirmar" };
  return map[String(status ?? "").toUpperCase()] || "Precisa confirmar";
}

function reasonLabel(value: unknown) {
  const map: Record<string, string> = { CONFLICT: "sinais conflitantes", LOW_CONFIDENCE: "confirmar sinal", MISSING: "informação ausente" };
  return map[String(value ?? "").toUpperCase()] || "confirmar";
}

function Progress({ value }: { value: number }) {
  const safe = Math.max(0, Math.min(100, Number(value || 0)));
  return <div style={{ height: 5, borderRadius: 999, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${safe}%`, background: "linear-gradient(90deg, #ff7a2f, #f2b85b)", borderRadius: 999 }} />
  </div>;
}

function RuleCard({ rule, badge }: { rule: Row; badge?: string }) {
  return <div style={{ ...ui.soft, padding: 12, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
    <div style={{ minWidth: 0 }}>
      <b style={{ fontSize: 13 }}>{ruleKindLabel(rule.rule_kind || rule.candidate_kind)}</b>
      <div style={{ ...ui.muted, lineHeight: 1.45, marginTop: 4, fontSize: 13 }}>{ruleText(rule)}</div>
      {rule.product_scope && <div style={{ ...ui.muted, marginTop: 6, fontSize: 11 }}>Escopo: {text(rule.product_scope)}</div>}
    </div>
    {badge && <span style={ui.badge}>{badge}</span>}
  </div>;
}

function MiniList({ title, items, empty, kind }: { title: string; items: Row[]; empty: string; kind: "rule" | "learned" }) {
  return <div style={{ ...ui.panel, padding: 14, minHeight: 150 }}>
    <b>{title}</b>
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {!items.length && <span style={{ ...ui.muted, fontSize: 13, lineHeight: 1.45 }}>{empty}</span>}
      {items.slice(0, 5).map((item: Row, index) => kind === "rule"
        ? <div key={item.id || index} style={{ fontSize: 13, lineHeight: 1.45 }}>• {ruleText(item)}</div>
        : <div key={`${item.dimension || index}-${item.direction || ""}`} style={{ fontSize: 13, lineHeight: 1.4 }}>
            <div>{item.statement || "Preferência em aprendizado"}</div>
            <div style={{ ...ui.muted, fontSize: 11, marginTop: 3 }}>Aprendida · {Number(item.confidence || 0)}% · {Number(item.evidence_count || 0)} evidência(s)</div>
          </div>
      )}
    </div>
  </div>;
}

export function CreativeCenter({ token }: { token: string }) {
  const [data, setData] = useState<Row | null>(null);
  const [learning, setLearning] = useState<Row | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ClientFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState(GENERAL_SCOPE);
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api("creative", token),
      authenticatedFetch(LEARNING_API, { cache: "no-store" })
        .then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`Perfil criativo ${response.status}`)))
        .catch(() => ({ profiles: [], summary: {} })),
    ])
      .then(([base, learned]) => { if (active) { setData(base); setLearning(learned); } })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Falha ao carregar a Central Criativa"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const learningByClient = useMemo(() => new Map<string, LearningProfile>(
    ((learning?.profiles || []) as LearningProfile[]).map((row) => [String(row.client_id), row])
  ), [learning]);

  const clients: Row[] = useMemo(() => (data?.clients || []).map((client: Row) => ({
    ...client,
    learning: learningByClient.get(String(client.client_id)) || emptyLearning(String(client.client_id)),
  })), [data, learningByClient]);

  const filterCounts = useMemo(() => {
    const count = (predicate: (client: Row) => boolean) => clients.filter(predicate).length;
    const confirmedCount = (client: Row) => (client.rules || []).filter(isConfirmedRule).length;
    return {
      ALL: clients.length,
      NO_RULES: count((client) => confirmedCount(client) === 0),
      LEARNING: count((client) => client.learning?.profile_status === "LEARNING" || Number(client.learning?.learned_count || 0) > 0),
      CONFIRM: count((client) => client.learning?.profile_status === "NEEDS_CONFIRMATION"),
      CONFLICT: count((client) => Number(client.learning?.conflict_count || 0) > 0),
      COMPLETE: count((client) => client.learning?.profile_status === "COMPLETE"),
    };
  }, [clients]);

  const filtered = useMemo(() => {
    const needle = normalize(query);
    return clients.filter((client) => {
      const confirmed = (client.rules || []).filter(isConfirmedRule).length;
      const profile = client.learning || emptyLearning(String(client.client_id));
      const matchesFilter = filter === "ALL"
        || (filter === "NO_RULES" && confirmed === 0)
        || (filter === "LEARNING" && (profile.profile_status === "LEARNING" || Number(profile.learned_count || 0) > 0))
        || (filter === "CONFIRM" && profile.profile_status === "NEEDS_CONFIRMATION")
        || (filter === "CONFLICT" && Number(profile.conflict_count || 0) > 0)
        || (filter === "COMPLETE" && profile.profile_status === "COMPLETE");
      if (!matchesFilter) return false;
      if (!needle) return true;
      const scopes = [...(client.rules || []), ...(client.candidates || [])].map((item: Row) => item.product_scope).filter(Boolean).join(" ");
      const learned = (profile.learned_items || []).map((item: Row) => item.statement).join(" ");
      return normalize(`${client.display_name || ""} ${scopes} ${learned}`).includes(needle);
    });
  }, [clients, query, filter]);

  const selected = filtered.find((client) => client.client_id === selectedId) || filtered[0] || null;

  useEffect(() => {
    setSelectedScope(GENERAL_SCOPE);
    setTab("summary");
    setCopied(false);
  }, [selected?.client_id]);

  const scopes = useMemo(() => {
    if (!selected) return [] as string[];
    const unique = new Set<string>();
    for (const item of [...(selected.rules || []), ...(selected.candidates || [])]) {
      const scope = String(item.product_scope || "").trim();
      if (!scope || normalize(scope) === "todos os produtos" || normalize(scope) === "geral") continue;
      unique.add(scope);
    }
    return [...unique].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [selected]);

  const confirmedRules = useMemo(() => selected ? (selected.rules || []).filter((rule: Row) => isConfirmedRule(rule) && scopeMatches(rule, selectedScope)) : [], [selected, selectedScope]);
  const avoidRules = confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "EVITAR");
  const technicalRules = confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "DADO_TECNICO");
  const positiveRules = confirmedRules.filter((rule: Row) => !["EVITAR", "DADO_TECNICO"].includes(String(rule.rule_kind || "").toUpperCase()));
  const pendingRules = selected ? [
    ...(selected.rules || []).filter((rule: Row) => isPendingRule(rule) && scopeMatches(rule, selectedScope)),
    ...(selected.candidates || []).filter((rule: Row) => String(rule.status || "").toUpperCase() === "PENDING" && String(rule.candidate_kind || "").toUpperCase() !== "APROVACAO" && scopeMatches(rule, selectedScope)),
  ] : [];
  const historicalRules = selected ? (selected.rules || []).filter((rule: Row) => isHistoricalRule(rule) && scopeMatches(rule, selectedScope)) : [];
  const profile = selected ? profileEntries(selected.briefings || []) : [];
  const brandColors = selected ? paletteItems(selected.brand?.color_palette || selected.brand?.palette || selected.brand?.colors) : [];
  const brandFonts = selected ? fontItems(selected.brand?.fonts) : [];
  const brandAssets = selected ? assetLinks(selected.brand?.asset_links) : [];
  const lastUpdated = selected ? latestTimestamp(selected) : null;
  const learnedProfile: LearningProfile = selected?.learning || emptyLearning(String(selected?.client_id || ""));
  const learnedItems = (learnedProfile.learned_items || []).filter((item: Row) => ["LEARNED", "LEARNED_HIGH"].includes(String(item.status || "")));
  const questions = (learnedProfile.questions || []).slice(0, 4);

  async function copyQuestions() {
    if (!selected || !questions.length) return;
    const body = [
      `Pra alinharmos melhor o padrão criativo de ${selected.display_name} e reduzir retrabalho:`,
      "",
      ...questions.map((question: Row, index: number) => `${index + 1}. ${question.question}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "summary", label: "Resumo" }, { key: "identity", label: "Identidade" }, { key: "audience", label: "Público" },
    { key: "rules", label: "Regras & sinais" }, { key: "materials", label: "Materiais" }, { key: "history", label: "Histórico" },
  ];
  const filters: Array<{ key: ClientFilter; label: string }> = [
    { key: "ALL", label: "Todos" }, { key: "NO_RULES", label: "Sem regras" }, { key: "LEARNING", label: "Aprendendo" },
    { key: "CONFIRM", label: "Confirmar" }, { key: "CONFLICT", label: "Conflitos" }, { key: "COMPLETE", label: "Completo" },
  ];

  return <section className="workspace">
    <div className="workspace-head" style={{ alignItems: "flex-end" }}>
      <div>
        <span className="eyebrow">Design</span>
        <h2>Central Criativa</h2>
        <p>Regras confirmadas, preferências aprendidas e perguntas que faltam responder — em um só lugar.</p>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <span style={ui.badge}>{clients.length} clientes</span>
        <span style={ui.badge}>{filterCounts.NO_RULES} sem regras confirmadas</span>
        <span style={ui.badge}>{Number(learning?.summary?.with_evidence || 0)} com sinais aprendidos</span>
      </div>
    </div>

    {error && <div className="error-box">{error}</div>}
    {loading && <div className="empty">Carregando inteligência criativa…</div>}

    {!loading && <>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
        {filters.map((item) => <button key={item.key} onClick={() => setFilter(item.key)} style={{ ...(filter === item.key ? ui.accentButton : ui.button), padding: "7px 10px", fontSize: 12 }}>
          {item.label} <span style={{ opacity: .65 }}>· {filterCounts[item.key]}</span>
        </button>)}
      </div>

      <div style={ui.shell}>
        <aside style={{ ...ui.panel, padding: 12, position: "sticky", top: 12, maxHeight: "calc(100vh - 150px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar cliente ou preferência…"
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--line, #33434f)", background: "rgba(0,0,0,.15)", color: "inherit", borderRadius: 10, padding: "10px 11px", font: "inherit", outline: "none" }}
          />
          <div style={{ overflowY: "auto", marginTop: 10, display: "grid", gap: 7, paddingRight: 2 }}>
            {!filtered.length && <div style={{ ...ui.muted, padding: 12, fontSize: 13 }}>Nenhum cliente neste filtro.</div>}
            {filtered.map((client) => {
              const active = client.client_id === selected?.client_id;
              const confirmed = (client.rules || []).filter(isConfirmedRule).length;
              const lp: LearningProfile = client.learning || emptyLearning(String(client.client_id));
              return <button key={client.client_id} onClick={() => setSelectedId(String(client.client_id))} style={{ textAlign: "left", color: "inherit", cursor: "pointer", borderRadius: 11, padding: 11, border: active ? "1px solid rgba(255,122,47,.72)" : "1px solid var(--line, #2b3944)", background: active ? "rgba(255,122,47,.12)" : "rgba(255,255,255,.018)", font: "inherit" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                  <b style={{ fontSize: 13, lineHeight: 1.25 }}>{client.display_name}</b>
                  <span style={{ ...ui.muted, fontSize: 10 }}>{Number(lp.coverage_pct || 0)}%</span>
                </div>
                <div style={{ ...ui.muted, fontSize: 11, margin: "5px 0 7px" }}>
                  {confirmed} confirmada(s) · {Number(lp.learned_count || 0)} aprendida(s)
                </div>
                <Progress value={Number(lp.coverage_pct || 0)} />
                <div style={{ marginTop: 6, fontSize: 10, opacity: .72 }}>{profileStatusLabel(lp.profile_status)}</div>
              </button>;
            })}
          </div>
        </aside>

        <main style={{ minWidth: 0, display: "grid", gap: 12 }}>
          {!selected && <div style={{ ...ui.panel, padding: 24 }}>Selecione um cliente.</div>}
          {selected && <>
            <div style={{ ...ui.panel, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <span className="eyebrow">Manual do cliente</span>
                  <h2 style={{ margin: "4px 0 4px", fontSize: "clamp(22px, 2.3vw, 30px)" }}>{selected.display_name}</h2>
                  <div style={{ ...ui.muted, fontSize: 13 }}>
                    Designer: {selected.designer_owner || "não atribuído"} · Atualizado em {formatDateShort(lastUpdated)}
                  </div>
                </div>
                <div style={{ minWidth: 180 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, marginBottom: 7 }}>
                    <b>Perfil criativo</b><b>{Number(learnedProfile.coverage_pct || 0)}%</b>
                  </div>
                  <Progress value={Number(learnedProfile.coverage_pct || 0)} />
                  <div style={{ ...ui.muted, fontSize: 11, marginTop: 6 }}>
                    {profileStatusLabel(learnedProfile.profile_status)} · {Number(learnedProfile.evidence_count || 0)} sinais
                  </div>
                </div>
              </div>

              {scopes.length > 0 && <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 13, flexWrap: "wrap" }}>
                <span style={{ ...ui.muted, fontSize: 12 }}>Escopo:</span>
                <select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)} style={{ ...ui.button, padding: "7px 10px" }}>
                  <option value={GENERAL_SCOPE}>Geral</option>
                  {scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
                </select>
              </div>}
            </div>

            <div style={{ ...ui.panel, padding: 6, display: "flex", gap: 5, overflowX: "auto" }}>
              {tabs.map((item) => <button key={item.key} onClick={() => setTab(item.key)} style={{ ...(tab === item.key ? ui.accentButton : ui.button), borderColor: tab === item.key ? "rgba(255,122,47,.55)" : "transparent", whiteSpace: "nowrap", padding: "8px 11px" }}>{item.label}</button>)}
            </div>

            {tab === "summary" && <>
              {confirmedRules.length === 0 && <div style={{ ...ui.soft, padding: 13, borderColor: "rgba(87,169,232,.35)" }}>
                <b style={{ fontSize: 13 }}>Ainda não há regra confirmada neste escopo.</b>
                <div style={{ ...ui.muted, fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>
                  O sistema continua aprendendo com briefing, ajustes e WhatsApp. Preferências aprendidas ajudam o designer, mas nunca substituem fatos oficiais do imóvel.
                </div>
              </div>}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <MiniList title="Fazer" items={positiveRules} empty="Nenhuma orientação positiva confirmada." kind="rule" />
                <MiniList title="Evitar" items={avoidRules} empty="Nenhuma restrição confirmada." kind="rule" />
                <MiniList title="Preferências aprendidas" items={learnedItems} empty="Ainda sem padrão forte o suficiente para sugerir preferência." kind="learned" />
                <MiniList title="Fatos autorizados" items={technicalRules} empty="Nenhum fato técnico confirmado como regra. Consulte o briefing/material oficial." kind="rule" />
              </div>

              {(pendingRules.length > 0 || questions.length > 0) && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                <div style={{ ...ui.panel, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <b>Sinais a confirmar</b><span style={ui.badge}>{pendingRules.length}</span>
                  </div>
                  <div style={{ ...ui.muted, fontSize: 12, marginTop: 5 }}>Não são regras obrigatórias até alguém confirmar.</div>
                  <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                    {!pendingRules.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum sinal pendente.</span>}
                    {pendingRules.slice(0, 6).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="Confirmar" />)}
                  </div>
                </div>

                <div style={{ ...ui.panel, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div><b>Perguntas sugeridas</b><div style={{ ...ui.muted, fontSize: 12, marginTop: 4 }}>Pergunte só o que falta para o perfil ficar mais confiável.</div></div>
                    {questions.length > 0 && <button onClick={copyQuestions} style={ui.accentButton}>{copied ? "Copiado ✓" : "Copiar para WhatsApp"}</button>}
                  </div>
                  <div style={{ display: "grid", gap: 8, marginTop: 11 }}>
                    {!questions.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhuma pergunta prioritária agora.</span>}
                    {questions.map((question: Row, index: number) => <div key={question.dimension || index} style={{ ...ui.soft, padding: 11 }}>
                      <div style={{ fontSize: 13, lineHeight: 1.45 }}><b>{index + 1}.</b> {question.question}</div>
                      <div style={{ ...ui.muted, fontSize: 10, marginTop: 5, textTransform: "uppercase", letterSpacing: ".04em" }}>{reasonLabel(question.reason)}</div>
                    </div>)}
                  </div>
                </div>
              </div>}
            </>}

            {tab === "identity" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
              <div style={{ ...ui.panel, padding: 15 }}><b>Cores</b><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                {!brandColors.length && <span style={{ ...ui.muted, fontSize: 13 }}>Paleta não documentada.</span>}
                {brandColors.map((color, index) => <div key={`${color}-${index}`} style={{ ...ui.soft, padding: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  {validCssColor(color) && <span style={{ width: 18, height: 18, borderRadius: 5, background: color, border: "1px solid rgba(255,255,255,.2)" }} />}
                  <span style={{ fontSize: 12 }}>{color}</span>
                </div>)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Fontes</b><div style={{ display: "grid", gap: 7, marginTop: 12 }}>
                {!brandFonts.length && <span style={{ ...ui.muted, fontSize: 13 }}>Fontes não documentadas.</span>}
                {brandFonts.map((font, index) => <span key={`${font}-${index}`} style={{ fontSize: 13 }}>{font}</span>)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Arquivos da marca</b><div style={{ display: "grid", gap: 7, marginTop: 12 }}>
                {!brandAssets.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum link de ativo registrado.</span>}
                {brandAssets.map((asset, index) => <a key={`${asset.url}-${index}`} href={asset.url} target="_blank" rel="noreferrer" style={{ color: "inherit", fontSize: 13 }}>{asset.label} ↗</a>)}
              </div></div>
            </div>}

            {tab === "audience" && <div style={{ ...ui.panel, padding: 15 }}>
              <b>Público & abordagem do briefing</b>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 9, marginTop: 12 }}>
                {!profile.length && <span style={{ ...ui.muted, fontSize: 13 }}>O briefing ainda não possui perfil estruturado suficiente.</span>}
                {profile.map((item) => <div key={item.key} style={{ ...ui.soft, padding: 11 }}><b style={{ fontSize: 12 }}>{item.label}</b><div style={{ ...ui.muted, fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>{item.value}</div></div>)}
              </div>
            </div>}

            {tab === "rules" && <div style={{ display: "grid", gap: 10 }}>
              <div style={{ ...ui.panel, padding: 15 }}><b>Confirmadas · {confirmedRules.length}</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!confirmedRules.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhuma regra confirmada neste escopo.</span>}
                {confirmedRules.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="Confirmada" />)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Preferências aprendidas · {learnedItems.length}</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!learnedItems.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum aprendizado com confiança suficiente ainda.</span>}
                {learnedItems.map((item: Row, index: number) => <div key={`${item.dimension || index}-${item.direction || ""}`} style={{ ...ui.soft, padding: 12 }}>
                  <div style={{ fontSize: 13 }}>{item.statement}</div><div style={{ ...ui.muted, fontSize: 11, marginTop: 5 }}>Aprendida · {Number(item.confidence || 0)}% · {Number(item.evidence_count || 0)} evidência(s)</div>
                </div>)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Em confirmação · {pendingRules.length}</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!pendingRules.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum sinal pendente.</span>}
                {pendingRules.slice(0, 30).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="Pendente" />)}
              </div></div>
            </div>}

            {tab === "materials" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
              <div style={{ ...ui.panel, padding: 15 }}><b>Briefings</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!(selected.briefings || []).length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum briefing localizado.</span>}
                {(selected.briefings || []).map((briefing: Row, index: number) => <div key={briefing.notion_page_id || index} style={{ ...ui.soft, padding: 11 }}>
                  <b style={{ fontSize: 13 }}>{briefing.title || "Briefing"}</b>
                  <div style={{ ...ui.muted, fontSize: 11, marginTop: 4 }}>Atualizado em {formatDateShort(briefing.last_fetched_at)}</div>
                  {briefing.page_url && <a href={briefing.page_url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 7, color: "inherit", fontSize: 12 }}>Abrir briefing ↗</a>}
                </div>)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Materiais recentes</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!(selected.recent_materials || []).length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum material recente registrado.</span>}
                {(selected.recent_materials || []).slice(0, 30).map((material: Row, index: number) => <div key={material.id || index} style={{ ...ui.soft, padding: 11 }}>
                  <b style={{ fontSize: 13 }}>{material.file_name || "Material"}</b><div style={{ ...ui.muted, fontSize: 11, marginTop: 4 }}>{material.file_kind || "arquivo"} · {formatDateShort(material.detected_at || material.drive_uploaded_at)}</div>
                </div>)}
              </div></div>
            </div>}

            {tab === "history" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
              <div style={{ ...ui.panel, padding: 15 }}><b>Ajustes recentes</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!(selected.recent_adjustments || []).length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhum ajuste recente registrado.</span>}
                {(selected.recent_adjustments || []).slice(0, 30).map((item: Row, index: number) => <div key={item.id || index} style={{ ...ui.soft, padding: 11 }}>
                  <b style={{ fontSize: 12 }}>{item.tipo || "Ajuste"}</b><div style={{ ...ui.muted, fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>{item.descricao || "—"}</div><div style={{ ...ui.muted, fontSize: 10, marginTop: 5 }}>{formatDateShort(item.occurred_at)}</div>
                </div>)}
              </div></div>
              <div style={{ ...ui.panel, padding: 15 }}><b>Regras históricas</b><div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {!historicalRules.length && <span style={{ ...ui.muted, fontSize: 13 }}>Nenhuma regra histórica neste escopo.</span>}
                {historicalRules.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="Histórica" />)}
              </div></div>
            </div>}
          </>}
        </main>
      </div>
    </>}
  </section>;
}
