"use client";

import { useEffect, useMemo, useState } from "react";
import { api, text } from "../shared";
import type { Row } from "../shared";

const GENERAL_SCOPE = "__GENERAL__";
type Tab = "summary" | "identity" | "audience" | "rules" | "materials" | "history";

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
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
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null && item !== undefined && item !== "")
      .map(([key, item]) => `${friendlyLabel(key)}: ${valueText(item)}`);
    return entries.join(" · ") || "Não informado";
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return String(value);
}

function friendlyLabel(key: string) {
  const map: Record<string, string> = {
    publico: "Público",
    audience: "Público",
    focos_produto: "Foco de produto",
    product_focus: "Foco de produto",
    objetivos: "Objetivos",
    objectives: "Objetivos",
    regiao: "Região",
    region: "Região",
    tipo_cliente: "Tipo de cliente",
    client_type: "Tipo de cliente",
    gargalos: "Gargalos",
    bottlenecks: "Gargalos",
    riscos: "Riscos",
    risks: "Riscos",
    condicoes_comerciais: "Condições comerciais",
    commercial_conditions: "Condições comerciais",
    responsaveis: "Responsáveis",
    responsibles: "Responsáveis",
    responsible_parties: "Responsáveis",
    orcamento_midia: "Orçamento de mídia",
    media_budget: "Orçamento de mídia",
  };
  return map[key] || key.replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function ruleKindLabel(value: unknown) {
  const map: Record<string, string> = {
    DESEJA: "Preferência",
    EVITAR: "Não fazer",
    COMO_APLICAR: "Como aplicar",
    IDENTIDADE: "Identidade",
    PROCESSO: "Processo",
    DADO_TECNICO: "Fato autorizado",
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
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${friendlyLabel(key)}: ${valueText(item)}`);
  }
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
        if (/^https?:\/\//i.test(url)) return [{ label: String(row.label || row.name || row.title || `Arquivo ${index + 1}`), url }];
      }
      return [];
    });
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) return [{ label: friendlyLabel(key), url: item }];
      return [];
    });
  }
  return [];
}

function latestTimestamp(client: Row) {
  const values = [
    client.brand?.updated_at,
    client.brand?.last_verified_at,
    ...(client.rules || []).flatMap((rule: Row) => [rule.updated_at, rule.last_confirmed_at, rule.observed_at]),
    ...(client.briefings || []).flatMap((briefing: Row) => [briefing.last_fetched_at]),
    ...(client.recent_adjustments || []).flatMap((item: Row) => [item.occurred_at]),
    ...(client.recent_materials || []).flatMap((item: Row) => [item.detected_at, item.drive_uploaded_at]),
  ].filter(Boolean).map((value) => new Date(String(value))).filter((date) => !Number.isNaN(date.getTime()));
  if (!values.length) return null;
  return values.sort((a, b) => b.getTime() - a.getTime())[0].toISOString();
}

function profileEntries(briefings: Row[]) {
  const profiles = briefings
    .map((briefing) => briefing.extracted_profile)
    .filter((profile) => profile && typeof profile === "object") as Record<string, unknown>[];
  if (!profiles.length) return [] as Array<{ key: string; label: string; value: string }>;

  const aliases: Array<[string, string[]]> = [
    ["publico", ["publico", "audience"]],
    ["focos_produto", ["focos_produto", "product_focus"]],
    ["objetivos", ["objetivos", "objectives"]],
    ["regiao", ["regiao", "region"]],
    ["tipo_cliente", ["tipo_cliente", "client_type"]],
    ["gargalos", ["gargalos", "bottlenecks"]],
    ["riscos", ["riscos", "risks"]],
    ["condicoes_comerciais", ["condicoes_comerciais", "commercial_conditions"]],
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

function documentationStatus(client: Row) {
  const confirmed = (client.rules || []).filter(isConfirmedRule).length;
  const hasBriefing = (client.briefings || []).length > 0;
  const brandConfirmed = String(client.brand?.status ?? "").toUpperCase() === "CONFIRMED";
  if (confirmed > 0 && (hasBriefing || brandConfirmed)) return { label: "Base confirmada", tone: "green" };
  if (confirmed > 0 || hasBriefing || client.brand) return { label: "Base parcial", tone: "yellow" };
  return { label: "Sem documentação", tone: "red" };
}

function RuleCard({ rule, badge }: { rule: Row; badge?: string }) {
  return <div className="productivity-row" style={{ alignItems: "flex-start", gap: 12 }}>
    <div style={{ minWidth: 0 }}>
      <b>{ruleKindLabel(rule.rule_kind || rule.candidate_kind)}</b>
      <small style={{ display: "block", lineHeight: 1.45, marginTop: 3 }}>{ruleText(rule)}</small>
      {rule.product_scope && <small style={{ display: "block", marginTop: 5, opacity: .72 }}>Produto / escopo: {text(rule.product_scope)}</small>}
    </div>
    {badge && <strong style={{ whiteSpace: "nowrap", fontSize: 11 }}>{badge}</strong>}
  </div>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="empty" style={{ padding: "14px 0" }}>{children}</div>;
}

export function CreativeCenter({ token }: { token: string }) {
  const [data, setData] = useState<Row | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState(GENERAL_SCOPE);
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api("creative", token)
      .then((result) => { if (active) setData(result); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Falha ao carregar a Central Criativa"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const clients: Row[] = data?.clients || [];
  const filtered = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return clients;
    return clients.filter((client) => {
      const scopes = [...(client.rules || []), ...(client.candidates || [])].map((item: Row) => item.product_scope).filter(Boolean).join(" ");
      return normalize(`${client.display_name || ""} ${scopes}`).includes(needle);
    });
  }, [clients, query]);

  const selected = filtered.find((client) => client.client_id === selectedId) || filtered[0] || null;

  useEffect(() => {
    setSelectedScope(GENERAL_SCOPE);
    setTab("summary");
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
  const fixedConfirmed = confirmedRules.filter((rule: Row) => String(rule.classification || "").toUpperCase() === "REGRA_FIXA" || isGeneralScope(rule));
  const productConfirmed = confirmedRules.filter((rule: Row) => !isGeneralScope(rule));
  const avoidRules = confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "EVITAR");
  const technicalRules = confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "DADO_TECNICO");
  const positiveRules = confirmedRules.filter((rule: Row) => !["EVITAR", "DADO_TECNICO"].includes(String(rule.rule_kind || "").toUpperCase()));
  const pendingRules = selected ? [
    ...(selected.rules || []).filter((rule: Row) => isPendingRule(rule) && scopeMatches(rule, selectedScope)),
    ...(selected.candidates || []).filter((rule: Row) => String(rule.status || "").toUpperCase() === "PENDING" && scopeMatches(rule, selectedScope)),
  ] : [];
  const historicalRules = selected ? (selected.rules || []).filter((rule: Row) => isHistoricalRule(rule) && scopeMatches(rule, selectedScope)) : [];
  const profile = selected ? profileEntries(selected.briefings || []) : [];
  const brandColors = selected ? paletteItems(selected.brand?.color_palette || selected.brand?.palette || selected.brand?.colors) : [];
  const brandFonts = selected ? fontItems(selected.brand?.fonts) : [];
  const brandAssets = selected ? assetLinks(selected.brand?.asset_links) : [];
  const lastUpdated = selected ? latestTimestamp(selected) : null;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "summary", label: "Antes de criar" },
    { key: "identity", label: "Identidade" },
    { key: "audience", label: "Público & abordagem" },
    { key: "rules", label: "Regras" },
    { key: "materials", label: "Materiais" },
    { key: "history", label: "Histórico" },
  ];

  return <section className="workspace">
    <div className="workspace-head">
      <div>
        <span className="eyebrow">Design</span>
        <h2>Central Criativa</h2>
        <p>Manual vivo por cliente. Consulte aqui as especificidades antes de iniciar qualquer criativo.</p>
      </div>
      <span className="counter">{clients.length} clientes</span>
    </div>

    {error && <div className="error-box">{error}</div>}
    {loading && <div className="empty">Carregando manuais criativos…</div>}

    {!loading && <div className="grid" style={{ gridTemplateColumns: "minmax(280px,.72fr) minmax(0,1.8fr)", gap: 16, alignItems: "start" }}>
      <aside className="card section" style={{ position: "sticky", top: 18 }}>
        <div className="section-title">Escolha o cliente</div>
        <p style={{ marginTop: 3 }}>Busque pelo nome ou por um produto / escopo já documentado.</p>
        <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou produto…" style={{ width: "100%", margin: "10px 0" }} />
        <div style={{ display: "grid", gap: 7, maxHeight: "68vh", overflow: "auto", paddingRight: 3 }}>
          {filtered.map((client) => {
            const status = documentationStatus(client);
            const confirmed = (client.rules || []).filter(isConfirmedRule).length;
            const active = selected?.client_id === client.client_id;
            return <button key={client.client_id} type="button" className={active ? "primary" : "btn"} onClick={() => setSelectedId(client.client_id)} style={{ textAlign: "left", display: "block", width: "100%", padding: "10px 12px" }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text(client.display_name)}</b>
                <span className={`value ${status.tone}`} style={{ fontSize: 11, whiteSpace: "nowrap" }}>{status.label}</span>
              </span>
              <small style={{ display: "block", marginTop: 4, opacity: .72 }}>{confirmed} regra{confirmed === 1 ? "" : "s"} confirmada{confirmed === 1 ? "" : "s"} · {(client.briefings || []).length} briefing{(client.briefings || []).length === 1 ? "" : "s"}</small>
            </button>;
          })}
          {!filtered.length && <EmptyNote>Nenhum cliente encontrado.</EmptyNote>}
        </div>
      </aside>

      <main style={{ minWidth: 0 }}>
        {!selected ? <section className="card section"><EmptyNote>Selecione um cliente para consultar o manual criativo.</EmptyNote></section> : <>
          <section className="card section" style={{ marginBottom: 12 }}>
            <div className="workspace-head" style={{ marginBottom: 10 }}>
              <div>
                <span className="eyebrow">Manual do cliente</span>
                <h3 style={{ margin: "2px 0 5px", fontSize: 24 }}>{text(selected.display_name)}</h3>
                <p style={{ margin: 0 }}>Designer: {text(selected.designer_owner || "não atribuído")} · Atualizado em {formatDateShort(lastUpdated)}</p>
              </div>
              <span className="counter">{documentationStatus(selected).label}</span>
            </div>

            {scopes.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,.6fr) minmax(0,1.4fr)", alignItems: "center", gap: 10, marginTop: 12 }}>
              <div>
                <b>Produto / escopo consultado</b>
                <small style={{ display: "block", opacity: .72 }}>Regras gerais continuam valendo junto.</small>
              </div>
              <select className="control" value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)} style={{ width: "100%" }}>
                <option value={GENERAL_SCOPE}>Geral do cliente</option>
                {scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
              </select>
            </div>}
          </section>

          <div className="filter-tabs" style={{ marginBottom: 12, overflowX: "auto", display: "flex", flexWrap: "nowrap" }}>
            {tabs.map((item) => <button key={item.key} type="button" className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)} style={{ whiteSpace: "nowrap" }}>{item.label}</button>)}
          </div>

          {tab === "summary" && <div style={{ display: "grid", gap: 12 }}>
            <section className="card section">
              <div className="workspace-head" style={{ marginBottom: 8 }}>
                <div><div className="section-title">Resumo antes de criar</div><p>Somente informação confirmada aparece como regra obrigatória aqui.</p></div>
                <span className="counter">{confirmedRules.length} confirmadas</span>
              </div>

              {!confirmedRules.length && <div className="error-box" style={{ marginBottom: 12 }}>
                Este cliente ainda não possui regra confirmada para este escopo. Use o briefing e os materiais como consulta e não trate itens pendentes ou históricos como regra atual.
              </div>}

              <div className="grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10 }}>
                <article className="card section" style={{ padding: 14 }}>
                  <div className="section-title">Obrigatório / preferido</div>
                  {positiveRules.slice(0, 8).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="USAR" />)}
                  {!positiveRules.length && <EmptyNote>Sem orientação positiva confirmada.</EmptyNote>}
                </article>
                <article className="card section" style={{ padding: 14 }}>
                  <div className="section-title">Não fazer</div>
                  {avoidRules.slice(0, 8).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="EVITAR" />)}
                  {!avoidRules.length && <EmptyNote>Sem restrição confirmada registrada.</EmptyNote>}
                </article>
                <article className="card section" style={{ padding: 14 }}>
                  <div className="section-title">Fatos autorizados</div>
                  {technicalRules.slice(0, 8).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="FATO" />)}
                  {!technicalRules.length && <EmptyNote>Nenhum dado técnico confirmado como regra. Consulte o briefing oficial.</EmptyNote>}
                </article>
              </div>
            </section>

            <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.15fr) minmax(280px,.85fr)", gap: 12 }}>
              <section className="card section">
                <div className="section-title">Público e contexto de comunicação</div>
                <p>Dados extraídos dos briefings vinculados; servem para orientar linguagem e escolha visual.</p>
                {profile.slice(0, 6).map((item) => <div className="productivity-row" key={item.key} style={{ alignItems: "flex-start" }}><div><b>{item.label}</b><small style={{ display: "block", lineHeight: 1.45 }}>{item.value}</small></div></div>)}
                {!profile.length && <EmptyNote>Nenhum perfil estruturado encontrado nos briefings.</EmptyNote>}
              </section>

              <section className="card section">
                <div className="section-title">Confiança da documentação</div>
                <div className="productivity-row"><div><b>Identidade visual</b><small>{selected.brand ? (String(selected.brand.status).toUpperCase() === "CONFIRMED" ? "Confirmada" : "Cadastrada, mas ainda não confirmada") : "Sem perfil cadastrado"}</small></div></div>
                <div className="productivity-row"><div><b>Briefings vinculados</b><small>{(selected.briefings || []).length} encontrado{(selected.briefings || []).length === 1 ? "" : "s"}</small></div></div>
                <div className="productivity-row"><div><b>Itens em validação</b><small>{pendingRules.length} — não aplicar automaticamente</small></div></div>
                <div className="productivity-row"><div><b>Histórico</b><small>{historicalRules.length} regra{historicalRules.length === 1 ? "" : "s"} antiga{historicalRules.length === 1 ? "" : "s"} para consulta</small></div></div>
              </section>
            </div>

            {productConfirmed.length > 0 && <section className="card section">
              <div className="section-title">Especificidades deste produto / escopo</div>
              <p>Estas regras se somam às regras gerais do cliente.</p>
              {productConfirmed.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="PRODUTO" />)}
            </section>}
          </div>}

          {tab === "identity" && <section className="card section">
            <div className="workspace-head" style={{ marginBottom: 12 }}><div><div className="section-title">Identidade visual</div><p>Use somente o que estiver confirmado. Ausência de informação não autoriza completar por conta própria.</p></div><span className="counter">{selected.brand ? String(selected.brand.status || "sem status") : "não cadastrada"}</span></div>
            {!selected.brand && <div className="error-box">Não existe perfil de identidade visual cadastrado para este cliente. Consulte os materiais e o briefing antes de produzir.</div>}
            {selected.brand && <>
              <div className="grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12 }}>
                <article className="card section" style={{ padding: 14 }}>
                  <div className="section-title">Paleta</div>
                  {brandColors.length > 0 ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{brandColors.map((color, index) => <span key={`${color}-${index}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid currentColor", borderRadius: 999, padding: "5px 9px", opacity: .88 }}><span aria-hidden style={{ width: 18, height: 18, borderRadius: 999, border: "1px solid rgba(127,127,127,.35)", background: validCssColor(color) ? color : "transparent" }} />{color}</span>)}</div> : <EmptyNote>Paleta não confirmada.</EmptyNote>}
                </article>
                <article className="card section" style={{ padding: 14 }}>
                  <div className="section-title">Fontes</div>
                  {brandFonts.length > 0 ? brandFonts.map((font, index) => <div className="productivity-row" key={`${font}-${index}`}><div><b>{font}</b></div></div>) : <EmptyNote>Fontes não cadastradas.</EmptyNote>}
                </article>
              </div>
              <div className="productivity-row" style={{ marginTop: 10, alignItems: "flex-start" }}><div><b>Regras de logo</b><small style={{ display: "block", lineHeight: 1.5 }}>{text(selected.brand.logo_rules || "Sem regra de logo confirmada")}</small></div></div>
              <div className="productivity-row" style={{ alignItems: "flex-start" }}><div><b>Direção visual</b><small style={{ display: "block", lineHeight: 1.5 }}>{text(selected.brand.visual_direction || "Sem direção visual confirmada")}</small></div></div>
              {brandAssets.length > 0 && <div style={{ marginTop: 14 }}><div className="section-title">Arquivos de marca</div><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>{brandAssets.map((asset) => <a className="btn" key={`${asset.label}-${asset.url}`} href={asset.url} target="_blank" rel="noreferrer">{asset.label}</a>)}</div></div>}
            </>}
            {confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "IDENTIDADE").length > 0 && <div style={{ marginTop: 16 }}><div className="section-title">Regras confirmadas de identidade</div>{confirmedRules.filter((rule: Row) => String(rule.rule_kind || "").toUpperCase() === "IDENTIDADE").map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="CONFIRMADA" />)}</div>}
          </section>}

          {tab === "audience" && <section className="card section">
            <div className="workspace-head" style={{ marginBottom: 12 }}><div><div className="section-title">Público & abordagem</div><p>Contexto estruturado dos briefings para ajudar na escolha da mensagem, headline e linguagem visual.</p></div><span className="counter">{profile.length} campos</span></div>
            {profile.map((item) => <div className="productivity-row" key={item.key} style={{ alignItems: "flex-start" }}><div><b>{item.label}</b><small style={{ display: "block", lineHeight: 1.55, marginTop: 3 }}>{item.value}</small></div></div>)}
            {!profile.length && <EmptyNote>Não há perfil estruturado suficiente para este cliente. Abra os briefings na aba Materiais.</EmptyNote>}
          </section>}

          {tab === "rules" && <div style={{ display: "grid", gap: 12 }}>
            <section className="card section">
              <div className="workspace-head" style={{ marginBottom: 10 }}><div><div className="section-title">Regras confirmadas</div><p>Estas são as únicas diretrizes tratadas como atuais e obrigatórias para o escopo selecionado.</p></div><span className="counter">{confirmedRules.length}</span></div>
              {fixedConfirmed.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="REGRA FIXA" />)}
              {productConfirmed.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="PRODUTO" />)}
              {!confirmedRules.length && <EmptyNote>Nenhuma regra confirmada para este escopo.</EmptyNote>}
            </section>

            <section className="card section">
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>Em validação — {pendingRules.length} item{pendingRules.length === 1 ? "" : "s"}</summary>
                <p>Use apenas como contexto. Estes itens ainda não foram confirmados como regra atual.</p>
                {pendingRules.slice(0, 50).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="NÃO CONFIRMADA" />)}
                {!pendingRules.length && <EmptyNote>Nenhum item pendente neste escopo.</EmptyNote>}
              </details>
            </section>

            <section className="card section">
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>Histórico — {historicalRules.length} item{historicalRules.length === 1 ? "" : "s"}</summary>
                <p>Referência antiga. Não aplicar automaticamente no criativo atual.</p>
                {historicalRules.slice(0, 50).map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="HISTÓRICA" />)}
                {!historicalRules.length && <EmptyNote>Sem regra histórica neste escopo.</EmptyNote>}
              </details>
            </section>
          </div>}

          {tab === "materials" && <div style={{ display: "grid", gap: 12 }}>
            <section className="card section">
              <div className="workspace-head" style={{ marginBottom: 10 }}><div><div className="section-title">Briefings vinculados</div><p>Fonte de contexto do cliente. Abra o original quando precisar conferir um detalhe.</p></div><span className="counter">{(selected.briefings || []).length}</span></div>
              {(selected.briefings || []).map((briefing: Row, index: number) => <div className="productivity-row" key={briefing.notion_page_id || briefing.page_url || index} style={{ alignItems: "center" }}><div style={{ minWidth: 0 }}><b>{text(briefing.title || "Briefing")}</b><small style={{ display: "block" }}>Atualizado em {formatDateShort(briefing.last_fetched_at)} · vínculo {text(briefing.match_status || "sem status")}</small></div>{briefing.page_url && <a className="btn" href={String(briefing.page_url)} target="_blank" rel="noreferrer">Abrir briefing</a>}</div>)}
              {!(selected.briefings || []).length && <EmptyNote>Nenhum briefing vinculado.</EmptyNote>}
            </section>

            <section className="card section">
              <div className="workspace-head" style={{ marginBottom: 10 }}><div><div className="section-title">Arquivos e materiais detectados</div><p>Use os nomes para localizar o material oficial na pasta do cliente. A presença aqui não substitui a validação da versão correta.</p></div><span className="counter">{(selected.recent_materials || []).length}</span></div>
              {(selected.recent_materials || []).map((item: Row, index: number) => <div className="productivity-row" key={item.id || index} style={{ alignItems: "flex-start" }}><div style={{ minWidth: 0 }}><b>{text(item.file_name || "Arquivo")}</b><small style={{ display: "block" }}>{text(item.file_kind || "tipo não identificado")} · detectado em {formatDateShort(item.detected_at || item.drive_uploaded_at)}</small></div></div>)}
              {!(selected.recent_materials || []).length && <EmptyNote>Nenhum material detectado para este cliente.</EmptyNote>}
            </section>
          </div>}

          {tab === "history" && <div style={{ display: "grid", gap: 12 }}>
            <section className="card section">
              <div className="workspace-head" style={{ marginBottom: 10 }}><div><div className="section-title">Aprendizados e ajustes recentes</div><p>Contexto para entender o que já aconteceu. Só vira obrigação quando também estiver registrado como regra confirmada.</p></div><span className="counter">{(selected.recent_adjustments || []).length}</span></div>
              {(selected.recent_adjustments || []).map((item: Row, index: number) => <div className="productivity-row" key={item.id || index} style={{ alignItems: "flex-start" }}><div><b>{text(item.tipo || "Registro")}</b><small style={{ display: "block", lineHeight: 1.5 }}>{text(item.descricao)}</small><small style={{ display: "block", marginTop: 4, opacity: .72 }}>{formatDateShort(item.occurred_at)}</small></div></div>)}
              {!(selected.recent_adjustments || []).length && <EmptyNote>Nenhum ajuste recente vinculado.</EmptyNote>}
            </section>

            <section className="card section">
              <div className="section-title">Regras históricas</div>
              <p>O que já foi observado no passado, mas não deve ser reaplicado sem confirmação atual.</p>
              {historicalRules.map((rule: Row, index: number) => <RuleCard key={rule.id || index} rule={rule} badge="HISTÓRICA" />)}
              {!historicalRules.length && <EmptyNote>Sem histórico de regras neste escopo.</EmptyNote>}
            </section>
          </div>}
        </>}
      </main>
    </div>}
  </section>;
}
