"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, text } from "./shared";
import type { Row } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-wallet-management-api`;
const STYLE = `
.awm-overlay{position:fixed;inset:0;background:rgba(3,6,13,.78);backdrop-filter:blur(8px);z-index:2147483000;display:grid;place-items:center;padding:22px}
.awm-shell{width:min(1500px,96vw);height:min(900px,94vh);background:var(--surface,#0b0f18);border:1px solid rgba(148,163,184,.2);border-radius:20px;box-shadow:0 30px 100px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;color:var(--text,#f8fafc)}
.awm-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:22px 24px 16px;border-bottom:1px solid rgba(148,163,184,.14)}
.awm-head h2{margin:4px 0 4px;font-size:24px}.awm-head p{margin:0;color:#94a3b8}.awm-head button{border:0;background:transparent;color:inherit;font-size:26px;cursor:pointer}
.awm-tools{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 24px;border-bottom:1px solid rgba(148,163,184,.12)}
.awm-stat,.awm-search{background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.13);border-radius:12px;padding:11px 13px}.awm-stat small{display:block;color:#94a3b8}.awm-stat b{font-size:20px}.awm-search{grid-column:span 2;display:flex;align-items:center}.awm-search input{width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit}
.awm-error{margin:12px 24px 0;padding:10px 12px;border-radius:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.28);color:#fecaca}
.awm-board{display:flex;gap:12px;overflow:auto;padding:16px 24px 22px;flex:1;align-items:stretch}.awm-lane{min-width:280px;width:300px;background:rgba(148,163,184,.045);border:1px solid rgba(148,163,184,.13);border-radius:14px;padding:10px;display:flex;flex-direction:column}.awm-lane.drop{outline:2px solid #60a5fa;background:rgba(59,130,246,.08)}
.awm-lane-head{display:flex;justify-content:space-between;align-items:center;padding:4px 4px 10px}.awm-lane-head small{display:block;color:#94a3b8;margin-top:2px}.awm-count{border-radius:999px;padding:4px 8px;background:rgba(148,163,184,.1);font-size:12px}.awm-cards{display:flex;flex-direction:column;gap:8px;overflow:auto}.awm-card{padding:11px;border-radius:11px;background:rgba(15,23,42,.75);border:1px solid rgba(148,163,184,.13);cursor:grab}.awm-card:active{cursor:grabbing}.awm-card b{display:block;font-size:13px}.awm-card small{display:block;color:#94a3b8;margin:3px 0 8px}.awm-card select{width:100%;background:#111827;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:7px;font-size:12px}.awm-unassigned{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.05)}
.awm-history{width:360px;min-width:360px;border-left:1px solid rgba(148,163,184,.12);padding:16px;overflow:auto}.awm-history h3{margin:0 0 10px;font-size:15px}.awm-history article{padding:10px 0;border-bottom:1px solid rgba(148,163,184,.1)}.awm-history b{font-size:12px}.awm-history small{display:block;color:#94a3b8;margin-top:3px}.awm-body{display:flex;min-height:0;flex:1}.awm-empty{padding:12px;color:#64748b;font-size:12px}@media(max-width:900px){.awm-tools{grid-template-columns:1fr 1fr}.awm-search{grid-column:span 2}.awm-history{display:none}.awm-lane{min-width:260px}}
`;
function formatWhen(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export default function AdlerWalletManagement({ token, close, refresh }: { token: string; close: () => void; refresh?: () => Promise<void> }) {
  const [payload, setPayload] = useState<Row>({ clients: [], managers: [], history: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(API, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setPayload(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar carteiras."); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  const move = useCallback(async (client: Row, gtOwner: string | null) => {
    const current = String(client.gt_owner || "") || null;
    if (current === gtOwner) return;
    const destination = gtOwner || "Sem carteira";
    if (!window.confirm(`Mover ${client.display_name} de ${current || "Sem carteira"} para ${destination}?`)) return;
    setBusy(String(client.client_id)); setError("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ client_id: client.client_id, gt_owner: gtOwner }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      await Promise.all([load(), refresh?.()]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao mover cliente."); }
    finally { setBusy(""); setDragged(null); setDropTarget(null); }
  }, [token, load, refresh]);

  const clients: Row[] = payload.clients || [];
  const managers: Row[] = payload.managers || [];
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const visible = useMemo(() => clients.filter((client) => !needle || [client.display_name, client.gt_owner, client.cs_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle)), [clients, needle]);
  const unassigned = visible.filter((client) => !String(client.gt_owner || "").trim());
  const activeManagers = managers.map((manager) => ({ ...manager, clients: visible.filter((client) => String(client.gt_owner || "") === String(manager.person || "")) }));
  const assignedCount = clients.length - clients.filter((client) => !String(client.gt_owner || "").trim()).length;
  const lane = (manager: Row | null, rows: Row[]) => {
    const key = manager ? String(manager.person) : "__UNASSIGNED__";
    const target = manager ? String(manager.person) : null;
    const label = manager ? String(manager.person) : "Sem carteira";
    const wallet = manager?.carteira ? `Carteira ${manager.carteira}` : manager ? "Carteira sem codinome" : "Aguardando atribuição";
    return <section key={key} className={`awm-lane ${!manager ? "awm-unassigned" : ""} ${dropTarget === key ? "drop" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDropTarget(key); }} onDragLeave={() => setDropTarget((value) => value === key ? null : value)}
      onDrop={(event) => { event.preventDefault(); const id = dragged || event.dataTransfer.getData("text/plain"); const client = clients.find((row) => String(row.client_id) === id); if (client) void move(client, target); }}>
      <div className="awm-lane-head"><div><b>{label}</b><small>{wallet}</small></div><span className="awm-count">{rows.length}</span></div>
      <div className="awm-cards">{rows.map((client) => <article key={client.client_id} draggable={!busy} className="awm-card"
        onDragStart={(event) => { setDragged(String(client.client_id)); event.dataTransfer.setData("text/plain", String(client.client_id)); event.dataTransfer.effectAllowed = "move"; }}>
        <b>{text(client.display_name)}</b><small>{text(client.lifecycle)} · CS {text(client.cs_owner)}</small>
        <select disabled={busy === String(client.client_id)} value={String(client.gt_owner || "")} onChange={(event) => void move(client, event.target.value || null)}>
          <option value="">Sem carteira</option>{managers.map((gt) => <option key={gt.person} value={gt.person}>{gt.person}{gt.carteira ? ` · ${gt.carteira}` : ""}</option>)}
        </select>
      </article>)}{!rows.length && <div className="awm-empty">Nenhum cliente aqui.</div>}</div>
    </section>;
  };

  return <div className="awm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><style>{STYLE}</style><section className="awm-shell" role="dialog" aria-modal="true" aria-label="Gestão de carteiras">
    <header className="awm-head"><div><span className="eyebrow">Adler · Operações</span><h2>Gestão de carteiras</h2><p>Redistribua clientes entre gestores de tráfego e resolva clientes sem responsável.</p></div><button onClick={close} aria-label="Fechar">×</button></header>
    <div className="awm-tools">
      <div className="awm-stat"><small>Clientes em operação</small><b>{clients.length}</b></div>
      <div className="awm-stat"><small>Com GT</small><b>{assignedCount}</b></div>
      <div className="awm-stat"><small>Sem carteira</small><b>{clients.length - assignedCount}</b></div>
      <div className="awm-stat"><small>Gestores ativos</small><b>{managers.length}</b></div>
      <label className="awm-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, GT ou CS…" /></label>
    </div>
    {error && <div className="awm-error">{error}</div>}
    <div className="awm-body"><div className="awm-board">{lane(null, unassigned)}{activeManagers.map((manager) => lane(manager, manager.clients))}{loading && <div className="awm-empty">Carregando carteiras…</div>}</div>
      <aside className="awm-history"><h3>Histórico de remanejamentos</h3>{(payload.history || []).map((item: Row) => <article key={item.id}><b>{text(item.detail)}</b><small>{text(item.actor)} · {formatWhen(item.occurred_at)}</small></article>)}{!loading && !(payload.history || []).length && <div className="awm-empty">Nenhum remanejamento registrado ainda.</div>}</aside>
    </div>
  </section></div>;
}
