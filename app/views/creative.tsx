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

export function CreativeCenter({ token }: { token: string }) {
  const [data, setData] = useState<Row | null>(null);
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

  return <section className="workspace">
    <div className="workspace-head">
      <div><span className="eyebrow">Design</span><h2>Central Criativa</h2><p>Regras, identidade visual e evidências por cliente. O manual histórico não vira regra fixa sem confirmação.</p></div>
      <span className="counter">{clients.length} clientes</span>
    </div>

    <div className="grid clickup-kpis">
      <article className="card metric"><div className="label">Clientes mapeados</div><div className="value blue">{summary.active_clients ?? clients.length}</div><div className="hint">ativos + onboarding</div></article>
      <article className="card metric"><div className="label">Com regras</div><div className="value green">{summary.clients_with_rules ?? 0}</div><div className="hint">diretrizes registradas</div></article>
      <article className="card metric"><div className="label">Evidências pendentes</div><div className="value yellow">{summary.pending_candidates ?? 0}</div><div className="hint">revisão humana necessária</div></article>
      <article className="card metric"><div className="label">Identidade incompleta</div><div className="value red">{summary.incomplete_brand_profiles ?? 0}</div><div className="hint">precisa de atenção</div></article>
    </div>

    {error && <div className="error-box">{error}</div>}
    {loading && <div className="empty">Carregando diretrizes criativas…</div>}

    {!loading && <div className="grid" style={{ gridTemplateColumns: "minmax(260px,.75fr) minmax(0,1.7fr)", gap: 16, alignItems: "start" }}>
      <section className="card section">
        <div className="section-title">Clientes</div>
        <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente…" style={{ width: "100%", marginBottom: 10 }} />
        <div style={{ display: "grid", gap: 6, maxHeight: 620, overflow: "auto" }}>
          {filtered.map((client) => <button key={client.client_id} type="button" className={selected?.client_id === client.client_id ? "primary" : "btn"} onClick={() => setSelectedId(client.client_id)} style={{ textAlign: "left", justifyContent: "space-between" }}>
            <span>{text(client.display_name)}</span>
            {client.health?.needs_attention ? <span>!</span> : null}
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
