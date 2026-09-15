"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";

type Row = Record<string, any>;
type Band = "ALL" | "ACTION_NOW" | "FOLLOW_UP" | "HEALTHY";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-radar-api`;
const CREATIVE_API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-creatives-api`;
const WORK_API = `${SUPABASE_URL}/functions/v1/agency-ops-work-item-create-api`;

const BAND: Record<string, { label: string; short: string; cls: string; glyph: string }> = {
  ACTION_NOW: { label: "Ação agora", short: "Crítico", cls: "danger", glyph: "!" },
  FOLLOW_UP: { label: "Acompanhar", short: "Atenção", cls: "warning", glyph: "~" },
  HEALTHY: { label: "Saudável", short: "Saudável", cls: "healthy", glyph: "✓" },
};

function finite(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function money(v: unknown) {
  const n = finite(v);
  return n === null ? "—" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v: unknown, digits = 0) {
  const n = finite(v);
  return n === null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pct(v: unknown, digits = 0) {
  const n = finite(v);
  return n === null ? "—" : `${num(n, digits)}%`;
}
function when(v: unknown) {
  if (!v) return "agora";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(d);
}
function initials(name: unknown) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]?.toUpperCase())
    .join("") || "?";
}
function toneClass(t: unknown) {
  return ["bad", "warn", "good", "info"].includes(String(t)) ? String(t) : "info";
}
function reasonHas(client: Row, codes: string[]) {
  return (client.evaluation?.reasons || []).some((r: Row) => codes.includes(String(r.code || "")));
}

export default function MetaRadarPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState<Row>({});
  const [gt, setGt] = useState("");
  const [band, setBand] = useState<Band>("ALL");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [featured, setFeatured] = useState<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) window.location.replace("/");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) window.location.replace("/");
    });
    return () => subscription.unsubscribe();
  }, []);

  const headers = useMemo<Record<string, string> | null>(() => session?.access_token ? {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
  } : null, [session?.access_token]);

  const hydrateFeatured = useCallback(async (body: Row, selectedGt?: string) => {
    if (!headers || String(body.profile?.role || "") === "DESIGN") return;
    const candidates: Row[] = (body.clients || [])
      .filter((c: Row) => Number(c.creative_coverage || 0) > 0)
      .sort((a: Row, b: Row) => Number(b.evaluation?.creative_signals?.best?.results || 0) - Number(a.evaluation?.creative_signals?.best?.results || 0))
      .slice(0, 3);
    if (!candidates.length) { setFeatured([]); return; }
    const rows = await Promise.all(candidates.map(async (c: Row) => {
      try {
        const p = new URLSearchParams({ client_id: String(c.client_id) });
        if (selectedGt && String(body.profile?.role || "") === "MGMT") p.set("gt", selectedGt);
        const r = await fetch(`${API}?${p}`, { headers, cache: "no-store" });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) return null;
        const current: Row[] = b.current_creatives || [];
        const bestId = String(c.evaluation?.creative_signals?.best?.ad_id || "");
        const creative = current.find((x: Row) => String(x.ad_id) === bestId) || current[0];
        return creative ? { ...creative, client_name: c.client_name, client_id: c.client_id, gt_owner: c.gt_owner } : null;
      } catch { return null; }
    }));
    setFeatured(rows.filter(Boolean) as Row[]);
  }, [headers]);

  const load = useCallback(async (selectedGt?: string) => {
    if (!headers) return;
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams();
      if (selectedGt) p.set("gt", selectedGt);
      const r = await fetch(`${API}?${p}`, { headers, cache: "no-store" });
      if (r.status === 404) { window.location.replace("/"); return; }
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.detail || b.error || `API ${r.status}`);
      setPayload(b);
      if (!selectedGt && b.selected_gt) setGt(String(b.selected_gt));
      void hydrateFeatured(b, selectedGt || String(b.selected_gt || ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar o Radar.");
    } finally {
      setLoading(false);
    }
  }, [headers, hydrateFeatured]);

  useEffect(() => { if (headers) void load(); }, [headers, load]);

  const role = String(payload.profile?.role || "");
  const clients: Row[] = payload.clients || [];
  const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
  const searched = useMemo(() => clients.filter((c) => !normalizedQuery || [c.client_name, c.gt_owner, c.cs_owner]
    .join(" ").toLocaleLowerCase("pt-BR").includes(normalizedQuery)), [clients, normalizedQuery]);
  const focusClients = useMemo(() => {
    if (normalizedQuery) return searched;
    if (band !== "ALL") return searched.filter((c) => c.evaluation?.band === band);
    return searched.filter((c) => c.evaluation?.band === "ACTION_NOW");
  }, [searched, band, normalizedQuery]);

  const openClient = useCallback(async (id: string) => {
    if (!headers) return;
    setDetailLoading(true);
    setDetail(null);
    setNotice("");
    try {
      const p = new URLSearchParams({ client_id: id });
      if (gt && role === "MGMT") p.set("gt", gt);
      const r = await fetch(`${API}?${p}`, { headers, cache: "no-store" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.detail || b.error || `API ${r.status}`);
      setDetail(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao abrir cliente.");
    } finally {
      setDetailLoading(false);
    }
  }, [headers, gt, role]);

  async function refreshCreatives() {
    if (!headers || !detail?.client?.client_id) return;
    setBusy("refresh"); setNotice("");
    try {
      const id = String(detail.client.client_id);
      const r = await fetch(`${CREATIVE_API}?client_id=${encodeURIComponent(id)}&period_days=7`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ client_id: id, period_days: 7, force: true }),
        cache: "no-store",
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.detail || b.error || `API ${r.status}`);
      await openClient(id);
      await load(gt);
      setNotice("Criativos atualizados e memória registrada.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Falha ao atualizar criativos."); }
    finally { setBusy(""); }
  }

  async function requestCreatives() {
    if (!headers || !detail?.client?.client_id) return;
    setBusy("request"); setNotice("");
    try {
      const c = detail.client, b = detail.briefing || {}, ev = detail.evaluation || {};
      const evidence = (ev.reasons || []).slice(0, 4).map((x: Row) => `- ${x.text}`).join("\n");
      const description = [
        `Motivo detectado pelo Radar: ${b.reason || "renovação de criativos"}.`,
        evidence ? `\nEvidências:\n${evidence}` : "",
        b.best_creative?.ad_name ? `\nMelhor criativo atual: ${b.best_creative.ad_name} — ${num(b.best_creative.results)} resultados · CPR ${money(b.best_creative.cost_per_result)}.` : "",
        `\nDireção sugerida: ${b.suggestion || "Criar novas variações."}`,
        `\nPróxima ação do Radar: ${ev.next_action || "—"}`,
      ].join("");
      const r = await fetch(WORK_API, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          title: b.title || `Novos criativos — ${c.display_name}`,
          description,
          client_id: c.client_id,
          type: "CREATIVE_REQUEST",
          priority: b.needed ? "HIGH" : "MEDIUM",
          target_role: "DESIGN",
          target_person: b.target_person || null,
          create_clickup: true,
          source: "meta_radar",
          source_id: `meta-radar:${c.client_id}:${new Date().toISOString().slice(0, 10)}`,
          metadata: { radar: true, briefing: b, evaluation_band: ev.band, score: ev.score },
        }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.detail || out.error || `API ${r.status}`);
      setNotice(`Demanda criada na Central${out.clickup?.id ? " e no ClickUp" : ""}.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Falha ao solicitar criativos."); }
    finally { setBusy(""); }
  }

  function changeGt(value: string) { setGt(value); setDetail(null); setBand("ALL"); void load(value); }

  if (!ready) return <main className="rv2-loading">Validando sessão…</main>;
  if (role === "DESIGN") return <DesignerCockpit payload={payload} loading={loading} error={error} />;

  const s = payload.summary || {};
  const changes: Row[] = (payload.changes || []).filter((x: Row) => !normalizedQuery || String(x.client_name || "").toLocaleLowerCase("pt-BR").includes(normalizedQuery));
  const actions = clients.filter((c) => c.evaluation?.band !== "HEALTHY").slice(0, 5);
  const totalSpend = clients.reduce((sum, c) => sum + (finite(c.meta?.spend) || 0), 0);
  const totalResults = clients.reduce((sum, c) => sum + (finite(c.meta?.results) || 0), 0);
  const blendedCpl = totalResults > 0 ? totalSpend / totalResults : null;
  const relationshipOk = clients.filter((c) => !reasonHas(c, ["CLIENT_WAITING", "COMPLAINT"])).length;
  const executionOk = clients.filter((c) => !reasonHas(c, ["TASK_OVERDUE", "OVERDUE_COMMITMENT", "BLOCKER"])).length;
  const financeOk = clients.filter((c) => !reasonHas(c, ["BALANCE_CRITICAL", "BALANCE_LOW", "META_DISABLED", "NO_DELIVERY"])).length;
  const relPct = clients.length ? Math.round(relationshipOk / clients.length * 100) : 0;
  const execPct = clients.length ? Math.round(executionOk / clients.length * 100) : 0;
  const finPct = clients.length ? Math.round(financeOk / clients.length * 100) : 0;
  const focusTitle = normalizedQuery ? "Resultados da busca" : band === "ALL" ? "Ação agora" : BAND[band]?.label;

  return <div className="rv2-app">
    <aside className="rv2-sidebar">
      <a className="rv2-brand" href="/"><span className="rv2-brand-mark">◎</span><b>AGENCY<br/>OPS <em>AI</em></b></a>
      <nav>
        <a href="/">⌂ <span>Visão geral</span></a>
        <a href="/meta-radar" className="active">◉ <span>Radar da carteira</span></a>
        <a href="/meta-performance">↗ <span>Performance Meta</span></a>
        <a href="/meta-analysis">▥ <span>Análise semanal</span></a>
      </nav>
      <div className="rv2-side-foot"><span>INTELIGÊNCIA</span><small>Meta + operação + execução</small></div>
    </aside>

    <main className="rv2-main">
      <header className="rv2-topbar">
        <div className="rv2-title"><h1>Radar da Carteira</h1><p>Inteligência operacional para decisões que movem resultado.</p></div>
        <div className="rv2-top-controls">
          {role === "MGMT" && <label className="rv2-select-wrap"><small>GT selecionado</small><select value={gt} onChange={(e) => changeGt(e.target.value)}><option value="">Todos os GTs</option>{(payload.gt_options || []).map((x: string) => <option key={x}>{x}</option>)}</select></label>}
          <label className="rv2-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente…"/></label>
          <button className="rv2-sync" onClick={() => load(gt)} disabled={loading}><small>{loading ? "Atualizando…" : "Atualizado"}</small><b>{when(payload.generated_at)}</b><span>↻</span></button>
        </div>
      </header>

      {error && <div className="rv2-error">{error}</div>}

      <section className="rv2-kpis">
        <KpiCard cls="danger" glyph="!" label="Ação agora" value={s.action_now ?? 0} helper="clientes exigem atenção imediata" active={band === "ACTION_NOW"} onClick={() => setBand(band === "ACTION_NOW" ? "ALL" : "ACTION_NOW")} />
        <KpiCard cls="warning" glyph="⌁" label="Acompanhar" value={s.follow_up ?? 0} helper="clientes em acompanhamento" active={band === "FOLLOW_UP"} onClick={() => setBand(band === "FOLLOW_UP" ? "ALL" : "FOLLOW_UP")} />
        <KpiCard cls="healthy" glyph="✓" label="Saudáveis" value={s.healthy ?? 0} helper="clientes sem ação urgente" active={band === "HEALTHY"} onClick={() => setBand(band === "HEALTHY" ? "ALL" : "HEALTHY")} />
        <KpiCard cls="creative" glyph="◇" label="Criativos mapeados" value={s.creative_covered ?? 0} helper={`de ${s.total ?? 0} clientes com captura`} />
      </section>

      <section className="rv2-primary-grid">
        <Panel className="rv2-risk-panel" title={focusTitle} badge={`${focusClients.length} clientes`} action={band !== "ALL" || normalizedQuery ? <button onClick={() => { setBand("ALL"); setQuery(""); }}>Limpar filtro</button> : null}>
          <div className="rv2-client-list">
            {focusClients.slice(0, 7).map((c) => <PriorityClient key={c.client_id} client={c} onOpen={() => openClient(String(c.client_id))} />)}
            {!loading && !focusClients.length && <div className="rv2-empty">Nenhum cliente encontrado nesse recorte.</div>}
          </div>
          {focusClients.length > 7 && <div className="rv2-panel-foot">Mostrando 7 de {focusClients.length} clientes.</div>}
        </Panel>

        <div className="rv2-side-stack">
          <Panel title="O que mudou hoje" icon="⌁" action={<span>{changes.length} sinais</span>}>
            <div className="rv2-events">
              {changes.slice(0, 5).map((x, i) => <button key={`${x.client_id}-${x.kind}-${i}`} className={`rv2-event ${toneClass(x.tone)}`} onClick={() => openClient(String(x.client_id))}>
                <span className="rv2-event-dot">{x.tone === "bad" ? "!" : x.tone === "good" ? "✓" : "↗"}</span>
                <div><b>{x.client_name}</b><p>{x.text}</p></div><small>agora</small>
              </button>)}
              {!changes.length && <div className="rv2-empty small">Nenhuma mudança relevante detectada.</div>}
            </div>
          </Panel>
          <Panel title="Próximas ações" icon="↗" action={<span>priorizadas</span>}>
            <div className="rv2-actions">
              {actions.map((c) => <button key={c.client_id} onClick={() => openClient(String(c.client_id))}><span className={`rv2-action-icon ${BAND[c.evaluation?.band]?.cls || "healthy"}`}>{BAND[c.evaluation?.band]?.glyph || "✓"}</span><div><b>{c.evaluation?.next_action || "Acompanhar cliente"}</b><small>{c.client_name}</small></div><em>›</em></button>)}
            </div>
          </Panel>
        </div>
      </section>

      <section className="rv2-secondary-grid">
        <Panel title="Criativos em destaque" icon="◇" action={<a href="/meta-performance">Ver Performance Meta →</a>}>
          <div className="rv2-featured-grid">
            {featured.map((r, i) => <FeaturedCreative key={`${r.client_id}:${r.ad_id}`} row={r} index={i} />)}
            {!featured.length && <div className="rv2-empty">Os criativos aparecem aqui conforme as capturas da Meta ganham cobertura.</div>}
          </div>
        </Panel>
        <Panel title="Saúde operacional" icon="⊙" action={<span>{clients.length} clientes</span>}>
          <div className="rv2-health-grid">
            <HealthCard glyph="♟" label="Relacionamento" value={relPct} helper="sem espera/reclamação crítica" cls={relPct >= 80 ? "healthy" : "warning"} />
            <HealthCard glyph="↗" label="Execução" value={execPct} helper="sem task/bloqueio crítico" cls={execPct >= 80 ? "healthy" : "warning"} />
            <HealthCard glyph="$" label="Financeiro / mídia" value={finPct} helper="sem alerta de saldo/entrega" cls={finPct >= 80 ? "healthy" : "warning"} />
          </div>
        </Panel>
      </section>

      <section className="rv2-bottom-strip">
        <div><span>PERFORMANCE DA CARTEIRA · 7 DIAS</span><p>Leitura consolidada dos clientes no filtro atual.</p></div>
        <MetricChip label="CPL / CPR médio" value={money(blendedCpl)} />
        <MetricChip label="Resultados" value={num(totalResults)} />
        <MetricChip label="Gasto" value={money(totalSpend)} />
        <div className="rv2-period">7 dias⌄</div>
      </section>
    </main>

    {(detailLoading || detail) && <aside className="rv2-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
      <section className="rv2-drawer">{detailLoading ? <div className="rv2-loading">Cruzando Meta, operação, saldo e ClickUp…</div> : detail && <ClientDrawer data={detail} notice={notice} busy={busy} onClose={() => setDetail(null)} onRefresh={refreshCreatives} onRequest={requestCreatives} />}</section>
    </aside>}
  </div>;
}

function KpiCard({ cls, glyph, label, value, helper, active, onClick }: { cls: string; glyph: string; label: string; value: unknown; helper: string; active?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "article";
  return <Tag className={`rv2-kpi ${cls} ${active ? "active" : ""}`} onClick={onClick as never}>
    <div><span className="rv2-kpi-label"><i>{glyph}</i>{label}</span><b>{String(value)}</b><p>{helper}</p><small>{onClick ? "Ver clientes →" : "Cobertura da carteira →"}</small></div><div className="rv2-kpi-art"><span>{glyph}</span></div>
  </Tag>;
}

function Panel({ title, icon, badge, action, className = "", children }: { title: string; icon?: string; badge?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section className={`rv2-panel ${className}`}><header><div>{icon && <i>{icon}</i>}<h2>{title}</h2>{badge && <span className="rv2-badge">{badge}</span>}</div>{action && <div className="rv2-panel-action">{action}</div>}</header>{children}</section>;
}

function PriorityClient({ client: c, onOpen }: { client: Row; onOpen: () => void }) {
  const ev = c.evaluation || {};
  const band = BAND[ev.band] || BAND.HEALTHY;
  const reason = (ev.reasons || [])[0];
  const changes: Row[] = ev.changes || [];
  const cplChange = changes.find((x) => x.kind === "CPL");
  const resultChange = changes.find((x) => x.kind === "RESULTADOS");
  return <button className={`rv2-client-row ${band.cls}`} onClick={onOpen}>
    <div className="rv2-client-id"><span>{initials(c.client_name)}</span><div><h3>{c.client_name}</h3><small>GT {c.gt_owner || "—"}</small></div><em>{band.short}</em></div>
    <div className="rv2-client-problem"><small>Principal problema</small><b>{reason?.text || "Sem problema crítico detectado"}</b><p>{reason?.action || "Monitoramento normal da conta."}</p></div>
    <div className="rv2-client-next"><small>Próxima ação</small><b>{ev.next_action || "Manter acompanhamento"}</b><p>{ev.band === "ACTION_NOW" ? "Sugerido para hoje" : ev.band === "FOLLOW_UP" ? "Acompanhar nos próximos dias" : "Sem urgência"}</p></div>
    <MetricMini label="Gasto (7d)" value={money(c.meta?.spend)} />
    <MetricMini label="CPL (7d)" value={money(c.meta?.cpl)} delta={cplChange?.value} />
    <MetricMini label="Resultados" value={num(c.meta?.results)} delta={resultChange?.value} invert />
    <span className="rv2-chevron">›</span>
  </button>;
}

function MetricMini({ label, value, delta, invert = false }: { label: string; value: string; delta?: unknown; invert?: boolean }) {
  const d = finite(delta);
  const good = d !== null ? (invert ? d > 0 : d < 0) : null;
  return <div className="rv2-mini"><small>{label}</small><b>{value}</b>{d !== null && <em className={good ? "good" : "bad"}>{d > 0 ? "↑" : "↓"} {Math.abs(d).toFixed(0)}%</em>}</div>;
}

function FeaturedCreative({ row: r, index }: { row: Row; index: number }) {
  const results = finite(r.results) || 0;
  const status = results <= 0 ? "Sem resultado" : index === 0 ? "Campeão" : "Em destaque";
  const cls = results <= 0 ? "bad" : index === 0 ? "champion" : "attention";
  const src = r.preview_url || r.image_url || r.thumbnail_url;
  return <article className="rv2-creative-card"><div className="rv2-creative-image">{src ? <img src={src} alt={r.ad_name || "Criativo"}/> : <span>Sem prévia</span>}<em className={cls}>{status}</em></div><div className="rv2-creative-copy"><div><h3>{r.ad_name || r.creative_name || "Criativo"}</h3><span>{r.client_name}</span><p>{r.campaign_name || "—"}</p></div><dl><div><dt>CPL / CPR</dt><dd>{money(r.cost_per_result ?? r.cpl)}</dd></div><div><dt>Resultados</dt><dd>{num(r.results)}</dd></div><div><dt>Gasto</dt><dd>{money(r.spend)}</dd></div><div><dt>CTR</dt><dd>{pct(r.ctr, 2)}</dd></div></dl></div></article>;
}

function HealthCard({ glyph, label, value, helper, cls }: { glyph: string; label: string; value: number; helper: string; cls: string }) {
  return <article className={`rv2-health ${cls}`}><div className="rv2-health-head"><i>{glyph}</i><div><b>{label}</b><span>{value >= 80 ? "● Bom" : "● Atenção"}</span></div></div><strong>{value}%</strong><p>{helper}</p><div className="rv2-progress"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div></article>;
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return <div className="rv2-metric-chip"><small>{label}</small><b>{value}</b></div>;
}

function ClientDrawer({ data, notice, busy, onClose, onRefresh, onRequest }: { data: Row; notice: string; busy: string; onClose: () => void; onRefresh: () => void; onRequest: () => void }) {
  const c = data.client || {}, e = data.evaluation || {}, w = data.windows || {}, creative = e.creative_signals || {}, bal = e.balance || {}, tasks = e.tasks || {};
  const band = BAND[e.band] || BAND.HEALTHY;
  return <>
    <header className="rv2-drawer-head"><button onClick={onClose}>×</button><div><span className={band.cls}>{band.label} · score {e.score ?? 0}</span><h2>{c.display_name}</h2><p>GT {c.gt_owner || "—"} · CS {c.cs_owner || "—"} · Design {c.designer_owner || "—"}</p></div><a href={`/meta-performance?client=${encodeURIComponent(c.client_id)}`}>Performance Meta ↗</a></header>
    <div className="rv2-drawer-body">
      <section className={`rv2-drawer-hero ${band.cls}`}><small>PRÓXIMA AÇÃO RECOMENDADA</small><h3>{e.next_action || "Manter acompanhamento"}</h3><div>{(e.reasons || []).slice(0, 5).map((r: Row, i: number) => <span className={toneClass(r.tone)} key={`${r.code}-${i}`}>{r.text}</span>)}</div></section>
      <section className="rv2-drawer-stats">
        <DrawerStat label="Tráfego" value={`${num(w[7]?.results)} resultados`} helper={`CPL ${money(w[7]?.cpl)} · CTR ${pct(w[7]?.ctr, 2)} · freq. ${num(w[7]?.frequency, 2)}`} cls="blue" />
        <DrawerStat label="Criativos" value={creative.best?.ad_name || "Sem campeão"} helper={`${creative.waste?.length || 0} sem resultado · ${creative.fatigue?.length || 0} em fadiga`} cls="orange" />
        <DrawerStat label="Execução" value={`${tasks.open || 0} tasks abertas`} helper={`${tasks.overdue || 0} vencidas · ${tasks.due_today || 0} vencem hoje`} cls="blue" />
        <DrawerStat label="Financeiro / mídia" value={bal.days_remaining !== null && bal.days_remaining !== undefined ? `~${num(bal.days_remaining, 1)} dias de saldo` : "Saldo indisponível"} helper={`Disponível ${money(bal.available_balance)} · gasto 7d ${money(bal.spend_7d)}`} cls="orange" />
      </section>
      <section className="rv2-drawer-section"><header><div><small>MEMÓRIA VISUAL</small><h3>Criativos atuais</h3></div><button onClick={onRefresh} disabled={busy === "refresh"}>{busy === "refresh" ? "Capturando…" : "Atualizar criativos"}</button></header><DrawerCreativeGrid rows={data.current_creatives || []} /></section>
      <section className={`rv2-brief ${data.briefing?.needed ? "needed" : ""}`}><div><small>BRIEFING AUTOMÁTICO</small><h3>{data.briefing?.needed ? "Renovação criativa recomendada" : "Radar criativo"}</h3><p>{data.briefing?.suggestion}</p></div><button onClick={onRequest} disabled={busy === "request"}>{busy === "request" ? "Criando demanda…" : "Solicitar novos criativos"}</button></section>
      {notice && <div className="rv2-notice">{notice}</div>}
      {(data.open_tasks || []).length > 0 && <section className="rv2-drawer-section"><header><div><small>EXECUÇÃO</small><h3>Tasks abertas</h3></div></header><div className="rv2-task-list">{data.open_tasks.slice(0, 8).map((t: Row) => <a key={t.task_id} href={t.url || "#"} target="_blank" rel="noreferrer"><div><b>{t.name}</b><span>{t.assignee_names || "Sem responsável"}</span></div><em>{t.due_date ? new Date(t.due_date).toLocaleDateString("pt-BR") : "sem prazo"}</em></a>)}</div></section>}
    </div>
  </>;
}

function DrawerStat({ label, value, helper, cls }: { label: string; value: string; helper: string; cls: string }) {
  return <article className={`rv2-dstat ${cls}`}><small>{label}</small><b>{value}</b><p>{helper}</p></article>;
}

function DrawerCreativeGrid({ rows }: { rows: Row[] }) {
  if (!rows.length) return <div className="rv2-empty">Nenhum criativo capturado ainda.</div>;
  return <div className="rv2-dcreative-grid">{rows.slice(0, 9).map((r) => { const src = r.preview_url || r.image_url || r.thumbnail_url; return <article key={String(r.ad_id)}><div>{src ? <img src={src} alt={r.ad_name || "Criativo"}/> : <span>Sem prévia</span>}</div><section><small>{r.ad_status || "CRIATIVO"}</small><h4>{r.ad_name || r.creative_name || r.ad_id}</h4><p>{r.campaign_name || "—"}</p><dl><div><dt>Resultados</dt><dd>{num(r.results)}</dd></div><div><dt>CPR</dt><dd>{money(r.cost_per_result ?? r.cpl)}</dd></div><div><dt>Gasto</dt><dd>{money(r.spend)}</dd></div></dl></section></article>; })}</div>;
}

function DesignerCockpit({ payload, loading, error }: { payload: Row; loading: boolean; error: string }) {
  const rows: Row[] = payload.top_creatives || [];
  return <main className="rv2-designer"><header><div><a href="/">← Voltar</a><small>INTELIGÊNCIA CRIATIVA</small><h1>O que está funcionando na agência</h1><p>Peças reais e resultados para o design criar com memória de performance.</p></div><div><b>{payload.creative_count || 0}</b><span>criativos mapeados</span></div></header>{error && <div className="rv2-error">{error}</div>}{loading ? <div className="rv2-loading">Carregando inteligência criativa…</div> : <section className="rv2-designer-grid">{rows.map((r, i) => <FeaturedCreative key={`${r.client_id}:${r.ad_id}`} row={r} index={i} />)}</section>}</main>;
}
