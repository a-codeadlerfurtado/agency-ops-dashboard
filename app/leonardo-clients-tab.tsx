"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_URL, authenticatedFetch, text } from "./shared";

type Row = Record<string, any>;
const STATUS_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-client-status-api`;
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const num = (v: unknown) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const fmt = (v: unknown) => v ? new Intl.DateTimeFormat("pt-BR", { timeZone:"America/Sao_Paulo", dateStyle:"short", timeStyle:"short" }).format(new Date(String(v))) : "—";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const label = (r: Row) => r.inadimplente && r.juridico ? "Inadimplente + Jurídico" : r.inadimplente ? "Inadimplente" : r.juridico ? "Jurídico" : "Regular";

type Props = { rows: Row[] };

export default function LeonardoClientsTab({ rows }: Props) {
  const [statusRows, setStatusRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inad, setInad] = useState(false);
  const [jur, setJur] = useState(false);
  const [since, setSince] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState("");

  const loadStatuses = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const r = await authenticatedFetch(STATUS_API, { cache:"no-store" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.detail || b?.error || `API ${r.status}`);
      setStatusRows(b.items || []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar situação financeira/jurídica.");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => { void loadStatuses(); }, [loadStatuses]);

  const statusById = useMemo(() => new Map(statusRows.map(r => [String(r.client_id), r])), [statusRows]);
  const merged = useMemo(() => rows.map(r => ({ ...r, ...(statusById.get(String(r.client_id)) || {}) })), [rows, statusById]);
  const visible = useMemo(() => merged.filter(r => {
    const q = norm(query);
    if (q && !norm(`${r.display_name} ${r.lifecycle} ${r.service} ${r.cs_owner} ${r.gt_owner} ${label(r)}`).includes(q)) return false;
    if (filter === "INAD" && !r.inadimplente) return false;
    if (filter === "JUR" && !r.juridico) return false;
    if (filter === "REGULAR" && (r.inadimplente || r.juridico)) return false;
    return true;
  }), [merged, query, filter]);

  const selected = useMemo(() => selectedId ? merged.find(r => String(r.client_id) === selectedId) || null : null, [merged, selectedId]);
  const counts = useMemo(() => ({
    total: merged.length,
    inad: merged.filter(r => r.inadimplente).length,
    jur: merged.filter(r => r.juridico).length,
    regular: merged.filter(r => !r.inadimplente && !r.juridico).length,
  }), [merged]);

  function open(row: Row) {
    setSelectedId(String(row.client_id));
    setInad(Boolean(row.inadimplente));
    setJur(Boolean(row.juridico));
    const active = [row.inadimplente_record, row.juridico_record].filter(Boolean).sort((a: Row, b: Row) => +new Date(b.created_at || 0) - +new Date(a.created_at || 0));
    const latest = active[0] || null;
    setSince(String(latest?.since || today()));
    setNote(String(latest?.note || ""));
    setError("");
  }

  async function save() {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    try {
      const r = await authenticatedFetch(STATUS_API, {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({ action:"save_client_financial_legal", client_id:selected.client_id, inadimplente:inad, juridico:jur, since, note }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.detail || b?.error || `API ${r.status}`);
      if (b.client) setStatusRows(prev => prev.map(x => String(x.client_id) === String(b.client.client_id) ? b.client : x));
      await loadStatuses();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar ficha.");
    } finally {
      setSaving(false);
    }
  }

  const history = (selected?.history || []) as Row[];

  return <div className="leo-clients-native">
    <style>{styles}</style>
    <section className="grid kpis leo-client-kpis">
      <article className="metric"><span>CARTEIRA</span><b>{counts.total}</b><small>clientes cadastrados</small></article>
      <article className="metric"><span>INADIMPLENTES</span><b>{counts.inad}</b><small>marcados no sistema</small></article>
      <article className="metric"><span>JURÍDICO</span><b>{counts.jur}</b><small>em tratativa jurídica</small></article>
      <article className="metric"><span>REGULARES</span><b>{counts.regular}</b><small>sem marcação ativa</small></article>
    </section>

    {selected && <section className="card section leo-client-dossier">
      <div className="workspace-head">
        <div><span className="eyebrow">Ficha do cliente</span><h2>{text(selected.display_name)}</h2><p>Financeiro e jurídico integrados à carteira comercial. Alterações ficam registradas no banco.</p></div>
        <button className="btn ghost" onClick={() => setSelectedId(null)} disabled={saving}>Fechar ficha</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="leo-client-dossier-grid">
        <div className="leo-client-dossier-main">
          <div className="leo-client-flags">
            <label className={inad ? "active bad" : ""}><input type="checkbox" checked={inad} onChange={e => setInad(e.target.checked)}/><span><b>Inadimplente</b><small>Cliente com pendência financeira.</small></span></label>
            <label className={jur ? "active warn" : ""}><input type="checkbox" checked={jur} onChange={e => setJur(e.target.checked)}/><span><b>Jurídico</b><small>Cliente em tratativa ou situação jurídica.</small></span></label>
          </div>
          <div className="leo-client-form">
            <label>Desde quando<input className="control" type="date" value={since} onChange={e => setSince(e.target.value)}/></label>
            <label>Observação<textarea className="control" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} placeholder="Ex.: mensalidade em aberto, acordo em andamento, encaminhado ao jurídico..."/></label>
          </div>
          <div className="leo-client-save-row"><span className={`leo-client-chip ${inad || jur ? "alert" : "regular"}`}>{inad && jur ? "Inadimplente + Jurídico" : inad ? "Inadimplente" : jur ? "Jurídico" : "Regular"}</span><button className="btn primary" onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar ficha"}</button></div>
        </div>
        <aside className="leo-client-history">
          <div><b>Histórico</b><small>{history.length} registros recentes</small></div>
          {history.length ? history.map((e: Row) => <article key={e.id}><span className={e.active ? "active" : "resolved"}>{e.status === "inadimplente" ? "Inadimplência" : "Jurídico"} · {e.active ? "ativo" : "resolvido"}</span><p>{e.note || "Sem observação."}</p><small>Desde {e.since || "—"} · criado por {e.created_by || "—"} em {fmt(e.created_at)}{e.resolved_at ? ` · resolvido por ${e.resolved_by || "—"} em ${fmt(e.resolved_at)}` : ""}</small></article>) : <p className="empty">Nenhum registro anterior.</p>}
        </aside>
      </div>
    </section>}

    <section className="card section">
      <div className="workspace-head"><div><span className="eyebrow">Carteira</span><h2>Clientes</h2><p>Visão comercial, operacional e financeiro/jurídica no mesmo lugar.</p></div><span className="counter">{visible.length}</span></div>
      {error && !selected && <div className="error-box">{error}</div>}
      <div className="toolbar leo-client-toolbar">
        <input className="control" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar cliente, CS, GT ou status..."/>
        <select className="control" value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">Todos</option><option value="INAD">Inadimplentes</option><option value="JUR">Jurídico</option><option value="REGULAR">Regulares</option></select>
        <button className="btn ghost" onClick={loadStatuses} disabled={loadingStatus}>{loadingStatus ? "Atualizando…" : "Atualizar status"}</button>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Tempo</th><th>CS</th><th>GT</th><th>Campanhas</th><th>Financeiro / Jurídico</th></tr></thead><tbody>{visible.map(r => <tr key={r.client_id}><td><button className="leo-client-name" onClick={() => open(r)}><b>{text(r.display_name)}</b><small>Abrir ficha</small></button></td><td>{text(r.lifecycle)}</td><td>{text(r.service)}</td><td>{r.client_days == null ? "—" : `${num(r.client_days)}d`}</td><td>{text(r.cs_owner)}</td><td>{text(r.gt_owner)}</td><td>{r.campaign ? `${num(r.campaign.active_campaigns)} ativas` : "—"}</td><td><button className={`leo-client-chip ${r.inadimplente || r.juridico ? "alert" : "regular"}`} onClick={() => open(r)}>{label(r)}</button></td></tr>)}</tbody></table></div>
    </section>
  </div>;
}

const styles = `
.leo-clients-native{display:grid;gap:14px}.leo-client-kpis{grid-template-columns:repeat(4,minmax(130px,1fr))}.leo-client-kpis .metric{padding:15px 16px}.leo-client-kpis .metric>span{font-size:10px;letter-spacing:.08em;color:var(--muted);font-weight:800}.leo-client-kpis .metric>b{display:block;font-size:24px;margin-top:5px}.leo-client-kpis .metric>small{color:var(--muted);font-size:10px}.leo-client-toolbar{display:grid;grid-template-columns:minmax(240px,1fr) 180px auto;gap:8px;margin-bottom:14px}.leo-client-name{display:flex;flex-direction:column;align-items:flex-start;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;text-align:left}.leo-client-name small{font-size:10px;color:var(--muted);margin-top:2px}.leo-client-name:hover b{text-decoration:underline}.leo-client-chip{border:1px solid rgba(148,163,184,.28);border-radius:999px;padding:6px 9px;font-size:11px;font-weight:800;white-space:nowrap;background:transparent}.leo-client-chip.regular{background:rgba(16,185,129,.08);color:#34d399}.leo-client-chip.alert{background:rgba(239,68,68,.10);color:#f87171;border-color:rgba(239,68,68,.28)}button.leo-client-chip{cursor:pointer}.leo-client-dossier{border-color:rgba(59,130,246,.24)}.leo-client-dossier-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr);gap:18px}.leo-client-dossier-main{display:grid;gap:14px}.leo-client-flags{display:grid;grid-template-columns:1fr 1fr;gap:10px}.leo-client-flags label{display:flex;gap:10px;align-items:flex-start;padding:14px;border:1px solid var(--line);border-radius:12px;cursor:pointer}.leo-client-flags label span{display:flex;flex-direction:column}.leo-client-flags label small{color:var(--muted);font-size:11px;margin-top:3px}.leo-client-flags label.active.bad{border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.06)}.leo-client-flags label.active.warn{border-color:rgba(245,158,11,.45);background:rgba(245,158,11,.06)}.leo-client-form{display:grid;grid-template-columns:180px minmax(0,1fr);gap:10px}.leo-client-form label{display:grid;gap:6px;color:var(--muted);font-size:11px}.leo-client-form textarea{min-height:90px;resize:vertical}.leo-client-save-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.leo-client-history{border-left:1px solid var(--line);padding-left:18px}.leo-client-history>div{display:flex;justify-content:space-between;gap:12px}.leo-client-history>div small{color:var(--muted);font-size:10px}.leo-client-history article{padding:11px 0;border-bottom:1px solid var(--line)}.leo-client-history article span{font-size:10px;font-weight:900;text-transform:uppercase}.leo-client-history article span.active{color:#f59e0b}.leo-client-history article span.resolved{color:var(--muted)}.leo-client-history article p{font-size:12px;margin:5px 0}.leo-client-history article small,.leo-client-history .empty{color:var(--muted);font-size:10px;line-height:1.45}
@media(max-width:1000px){.leo-client-kpis{grid-template-columns:repeat(2,minmax(130px,1fr))}.leo-client-dossier-grid{grid-template-columns:1fr}.leo-client-history{border-left:0;border-top:1px solid var(--line);padding:16px 0 0}.leo-client-toolbar{grid-template-columns:1fr 160px}}
@media(max-width:700px){.leo-client-toolbar,.leo-client-form,.leo-client-flags{grid-template-columns:1fr}.leo-client-kpis{grid-template-columns:repeat(2,minmax(110px,1fr))}}
`;
