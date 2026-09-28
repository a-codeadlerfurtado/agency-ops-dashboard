"use client";

import { useMemo, useState } from "react";

type Row = Record<string, any>;
type Filter = "ACTIVE" | "CHURNED" | "ALL";

const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const num = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const date = (value: unknown) => {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-").map(Number);
  return year && month && day ? new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day)) : raw;
};
const lifecycleLabel: Record<string, string> = { ACTIVE: "Ativo", ONBOARDING: "Onboarding", CHURNED: "Churn" };

export default function CloserClientsView({ rows, closerName }: { rows: Row[]; closerName: string }) {
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [query, setQuery] = useState("");
  const owned = useMemo(() => rows.filter((row) => norm(row.closer_origin).includes(norm(closerName)) && ["ACTIVE", "ONBOARDING", "CHURNED"].includes(String(row.lifecycle))), [rows, closerName]);
  const active = owned.filter((row) => row.lifecycle === "ACTIVE");
  const onboarding = owned.filter((row) => row.lifecycle === "ONBOARDING");
  const churned = owned.filter((row) => row.lifecycle === "CHURNED");
  const visible = useMemo(() => owned.filter((row) => {
    const statusOk = filter === "ALL" || (filter === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle)) : row.lifecycle === "CHURNED");
    const q = norm(query);
    return statusOk && (!q || norm(`${row.display_name || ""} ${row.service || ""} ${row.cs_owner || ""} ${row.gt_owner || ""}`).includes(q));
  }), [owned, filter, query]);

  return <section className="ccv-wrap">
    <style>{styles}</style>
    <div className="ccv-head"><div><span>CARTEIRA DO CLOSER</span><h2>Meus clientes fechados</h2><p>Clientes atribuídos a {closerName} pela origem comercial registrada no Dash Ops.</p></div><b>{owned.length} fechados</b></div>
    <div className="ccv-kpis">
      <article><span>Em operação</span><b>{active.length}</b><small>lifecycle ACTIVE</small></article>
      <article><span>Onboarding</span><b>{onboarding.length}</b><small>já fechados, ainda implantando</small></article>
      <article><span>Churn</span><b>{churned.length}</b><small>clientes que já saíram</small></article>
      <article><span>Total histórico</span><b>{owned.length}</b><small>inclui vendas compartilhadas</small></article>
    </div>
    <div className="ccv-tools"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, serviço, CS ou GT" /><div className="ccv-tabs"><button className={filter === "ACTIVE" ? "active" : ""} onClick={() => setFilter("ACTIVE")}>Ativos + onboarding ({active.length + onboarding.length})</button><button className={filter === "CHURNED" ? "active" : ""} onClick={() => setFilter("CHURNED")}>Churn ({churned.length})</button><button className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>Todos ({owned.length})</button></div></div>
    <div className="ccv-table"><table><thead><tr><th>Cliente</th><th>Status</th><th>Entrada</th><th>Saída</th><th>Tempo</th><th>Serviço</th><th>CS</th><th>GT</th><th>Fechamento</th></tr></thead><tbody>
      {visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td><span className={`ccv-status ${String(row.lifecycle).toLowerCase()}`}>{lifecycleLabel[row.lifecycle] || text(row.lifecycle)}</span></td><td>{date(row.entrada)}</td><td>{date(row.saida)}</td><td>{row.client_days == null ? "—" : `${num(row.client_days)}d`}</td><td>{text(row.service, "marketing")}</td><td>{text(row.cs_owner)}</td><td>{text(row.gt_owner)}</td><td>{String(row.closer_origin_status) === "MULTI" ? "Compartilhado" : "Individual"}</td></tr>)}
    </tbody></table>{!visible.length && <div className="ccv-empty">Nenhum cliente nesse filtro.</div>}</div>
  </section>;
}

const styles = `
.ccv-wrap{display:grid;gap:14px}.ccv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.ccv-head span{font-size:10px;letter-spacing:.12em;color:var(--muted);font-weight:900}.ccv-head h2{margin:4px 0 3px;font-size:24px}.ccv-head p{margin:0;color:var(--muted);font-size:12px}.ccv-head>b{border:1px solid var(--line);border-radius:999px;padding:7px 11px;font-size:12px;white-space:nowrap}.ccv-kpis{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px}.ccv-kpis article{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:15px}.ccv-kpis span,.ccv-kpis small{display:block;color:var(--muted);font-size:10px}.ccv-kpis b{display:block;font-size:25px;margin:4px 0}.ccv-tools{display:flex;justify-content:space-between;gap:10px;align-items:center}.ccv-tools input{min-width:280px;flex:1;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:10px 12px}.ccv-tabs{display:flex;gap:6px}.ccv-tabs button{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:9px;padding:9px 10px;cursor:pointer;font-weight:700;font-size:11px}.ccv-tabs button.active{background:rgba(3,89,166,.22);color:var(--text);border-color:rgba(59,130,246,.45)}.ccv-table{overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.ccv-table table{width:100%;border-collapse:collapse;min-width:950px}.ccv-table th,.ccv-table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:12px}.ccv-table th{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.ccv-status{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:5px 8px;font-size:10px;font-weight:900}.ccv-status.active{color:#34d399;background:rgba(16,185,129,.08)}.ccv-status.onboarding{color:#60a5fa;background:rgba(59,130,246,.08)}.ccv-status.churned{color:#f87171;background:rgba(239,68,68,.08)}.ccv-empty{padding:28px;text-align:center;color:var(--muted)}@media(max-width:800px){.ccv-head,.ccv-tools{align-items:stretch;flex-direction:column}.ccv-kpis{grid-template-columns:repeat(2,minmax(120px,1fr))}.ccv-tabs{overflow:auto}.ccv-tools input{min-width:0;width:100%}}
`;
