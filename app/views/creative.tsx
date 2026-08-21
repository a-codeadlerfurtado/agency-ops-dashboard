"use client";

import { useEffect, useMemo, useState } from "react";
import { Chip, api, text } from "../shared";
import type { Row } from "../shared";

function labelStatus(value: unknown) {
  const raw = String(value ?? "").toUpperCase();
  if (raw === "CONFIRMED" || raw === "CONFIRMED_FIXED" || raw === "CONFIRMED_PRODUCT") return "Confirmada";
  if (raw === "HISTORICAL") return "Histórica";
  if (raw === "NEEDS_VALIDATION" || raw === "PENDING") return "Pendente";
  return raw || "Sem status";
}

function palette(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function normRule(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

type RuleGroup = {
  key: string;
  title: string;
  description: string;
  kind: string;
  classification: string;
  statuses: string[];
  clients: { client_id: string; display_name: string }[];
};

export function CreativeCenter({ token }: { token: string }) {
  const [data, setData] = useState<Row | null>(null);
  const [mode, setMode] = useState<"clients" | "rules">("clients");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api("creative", token)
      .then((result) => { if (active) setData(result); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Falha ao carregar a Central Criativa"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const clients: Row[] = data?.clients || [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return clients.filter((client) => !needle || String(client.display_name || "").toLocaleLowerCase("pt-BR").includes(needle));
  }, [clients, query]);
  const selected = clients.find((client) => client.client_id === selectedId) || filtered[0] || null;
  const summary = data?.summary || {};

  const ruleGroups = useMemo<RuleGroup[]>(() => {
    const grouped = new Map<string, RuleGroup>();
    for (const client of clients) {
      for (const rule of (client.rules || []) as Row[]) {
        const description = String(rule.rule_text || rule.description || rule.content || "").trim();
        if (!description) continue;
        const kind = String(rule.rule_kind || rule.kind || "Diretriz").trim();
        const classification = String(rule.classification || "").trim();
        const title = String(rule.title || kind || "Diretriz").trim();
        const key = [normRule(kind), normRule(classification), normRule(description)].join("::");
        const current = grouped.get(key) || { key, title, description, kind, classification, statuses: [], clients: [] };
        const status = String(rule.status || "").trim();
        if (status && !current.statuses.includes(status)) current.statuses.push(status);
        if (!current.clients.some((item) => item.client_id === String(client.client_id))) {
          current.clients.push({ client_id: String(client.client_id), display_name: String(client.display_name || "Cliente") });
        }
        grouped.set(key, current);
      }
    }
    return [...grouped.values()].sort((a, b) => b.clients.length - a.clients.length || a.description.localeCompare(b.description, "pt-BR"));
  }, [clients]);

  const filteredRules = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return ruleGroups;
    return ruleGroups.filter((rule) => [rule.title, rule.description, rule.kind, rule.classification, ...rule.clients.map((client) => client.display_name)].join(" ").toLocaleLowerCase("pt-BR").includes(needle));
  }, [query, ruleGroups]);

  function openClientFromRule(clientId: string) {
    setSelectedId(clientId);
    setQuery("");
    setMode("clients");
  }

  return <section className="workspace">
    <div className="workspace-head">
      <div><span className="eyebrow">Design</span><h2>Central Criativa</h2><p>Regras, identidade visual e evidências. Consulte por cliente ou consolide as regras existentes na operação.</p></div>
      <span className="counter">{clients.length} clientes</span>
    </div>

    <div className="grid clickup-kpis">
      <article className="card metric"><div className="label">Clientes mapeados</div><div className="value blue">{summary.active_clients ?? clients.length}</div><div className="hint">ativos + onboarding</div></article>
      <article className="card metric"><div className="label">Com regras</div><div className="value green">{summary.clients_with_rules ?? 0}</div><div className="hint">diretrizes registradas</div></article>
      <article className="card metric"><div className="label">Evidências pendentes</div><div className="value yellow">{summary.pending_candidates ?? 0}</div><div className="hint">revisão humana necessária</div></article>
      <article className="card metric"><div className="label">Identidade incompleta</div><div className="value red">{summary.incomplete_brand_profiles ?? 0}</div><div className="hint">precisa de atenção</div></article>
    </div>

    <div className="filter-tabs" style={{ marginBottom: 14 }}>
      <button type="button" className={mode === "clients" ? "active" : ""} onClick={() => { setMode("clients"); setQuery(""); }}>Por Clientes</button>
      <button type="button" className={mode === "rules" ? "active" : ""} onClick={() => { setMode("rules"); setQuery(""); }}>Por Regras</button>
    </div>

    {error && <div className="error-box">{error}</div>}
    {loading && <div className="empty">Carregando diretrizes criativas…</div>}

    {!loading && mode === "rules" && <section className="card section">
      <div className="section-head"><div><div className="section-title">Regras consolidadas</div><div className="subtitle">A mesma base da visão por cliente, agrupada por diretriz. Nenhuma regra nova é criada aqui.</div></div><span className="counter">{filteredRules.length} de {ruleGroups.length}</span></div>
      <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar regra, categoria ou cliente…" style={{ width: "100%", marginBottom: 12 }} />
      <div style={{ display: "grid", gap: 8 }}>
        {filteredRules.map((rule) => <article className="productivity-row" key={rule.key} style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <b>{rule.title}</b>
            <small>{rule.description}</small>
            <small>{[rule.kind, rule.classification].filter(Boolean).join(" · ") || "Diretriz registrada"}</small>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {rule.clients.sort((a, b) => a.display_name.localeCompare(b.display_name, "pt-BR")).map((client) => <button type="button" className="btn" key={client.client_id} onClick={() => openClientFromRule(client.client_id)}>{client.display_name}</button>)}
            </div>
          </div>
          <div style={{ display: "grid", justifyItems: "end", gap: 4 }}><strong>{rule.clients.length} {rule.clients.length === 1 ? "cliente" : "clientes"}</strong><small>{rule.statuses.map(labelStatus).join(" · ") || "Sem status"}</small></div>
        </article>)}
        {!filteredRules.length && <div className="empty">Nenhuma regra encontrada.</div>}
      </div>
    </section>}

    {!loading && mode === "clients" && <div className="grid" style={{ gridTemplateColumns: "minmax(260px,.75fr) minmax(0,1.7fr)", gap: 16, alignItems: "start" }}>
      <section className="card section">
        <div className="section-title">Clientes</div>
        <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente…" style={{ width: "100%", marginBottom: 10 }} />
        <div style={{ display: "grid", gap: 6, maxHeight: 620, overflow: "auto" }}>
          {filtered.map((client) => <button key={client.client_id} type="button" className={selected?.client_id === client.client_id ? "primary" : "btn"} onClick={() => setSelectedId(client.client_id)} style={{ textAlign: "left", justifyContent: "space-between" }}>
            <span>{text(client.display_name)}</span>
          </button>)}
          {!filtered.length && <div className="empty">Nenhum cliente encontrado.</div>}
        </div>
      </section>

      <section className="card section">
        {!selected ? <div className="empty">Selecione um cliente.</div> : <>
          <div className="workspace-head" style={{ marginBottom: 12 }}><div><h3 style={{ margin: 0 }}>{text(selected.display_name)}</h3><p>{text(selected.designer_owner || "Designer não atribuído")}</p></div>{selected.health?.needs_attention && <Chip value="ATTENTION" />}</div>

          <div className="grid clickup-kpis">
            <article className="card metric"><div className="label">Regras</div><div className="value blue">{selected.health?.total_rules ?? selected.rules?.length ?? 0}</div><div className="hint">registradas</div></article>
            <article className="card metric"><div className="label">Históricas</div><div className="value yellow">{selected.health?.historical_rules ?? 0}</div><div className="hint">podem exigir validação</div></article>
            <article className="card metric"><div className="label">Pendentes</div><div className="value red">{selected.health?.pending_candidates ?? 0}</div><div className="hint">evidências a revisar</div></article>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>Identidade visual</div>
          <div className="productivity-row"><div><b>Paleta</b><small>{palette(selected.brand?.palette || selected.brand?.colors || selected.brand?.color_palette).join(" · ") || "Não confirmada"}</small></div><strong>{labelStatus(selected.brand?.status)}</strong></div>
          <div className="productivity-row"><div><b>Logo</b><small>{text(selected.brand?.logo_rules || selected.brand?.logo_rule || "Sem regra confirmada")}</small></div></div>
          <div className="productivity-row"><div><b>Direção visual</b><small>{text(selected.brand?.visual_direction || selected.brand?.direction || "Sem direção confirmada")}</small></div></div>

          <div className="section-title" style={{ marginTop: 18 }}>Regras por cliente</div>
          {(selected.rules || []).map((rule: Row, index: number) => <div className="productivity-row" key={rule.id || index}><div><b>{text(rule.title || rule.rule_kind || rule.kind || "Diretriz")}</b><small>{text(rule.rule_text || rule.description || rule.content)}</small></div><strong>{labelStatus(rule.status)}</strong></div>)}
          {!(selected.rules || []).length && <div className="empty">Nenhuma regra registrada.</div>}

          <div className="section-title" style={{ marginTop: 18 }}>Evidências pendentes</div>
          {(selected.candidates || []).filter((item: Row) => String(item.status).toUpperCase() === "PENDING").map((item: Row, index: number) => <div className="productivity-row" key={item.id || index}><div><b>{text(item.rule_text || item.candidate_text || item.description || "Evidência")}</b><small>{text(item.source_type || item.source || "Fonte não informada")}</small></div><strong>Pendente</strong></div>)}
          {!(selected.candidates || []).some((item: Row) => String(item.status).toUpperCase() === "PENDING") && <div className="empty">Sem evidências pendentes.</div>}

          <div className="section-title" style={{ marginTop: 18 }}>Ajustes e sinais recentes</div>
          {(selected.recent_adjustments || []).slice(0, 10).map((item: Row, index: number) => <div className="productivity-row" key={item.id || index}><div><b>{text(item.tipo || "Ajuste")}</b><small>{text(item.descricao)}</small></div></div>)}
          {!(selected.recent_adjustments || []).length && <div className="empty">Nenhum ajuste recente.</div>}
        </>}
      </section>
    </div>}
  </section>;
}
