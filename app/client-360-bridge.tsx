"use client";

import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
type Payload = Row & { client: Row; campaigns: Row[]; data_confidence: { overall: number; sources: Row[] }; permissions: Row };
const API_360 = `${SUPABASE_URL}/functions/v1/agency-ops-client-360-api`;
const API_ACTIONS = `${SUPABASE_URL}/functions/v1/agency-ops-safe-actions-api`;
const SLOT = "client-360-unified-slot";

const fmt = (v: unknown) => v == null || v === "" ? "—" : String(v);
const brl = (v: unknown) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
const shortDate = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
};
const clip = (v: unknown, n = 180) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s || "—";
};
async function authedFetch(url: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sessão expirada");
  const response = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `API ${response.status}`);
  return payload;
}
function Badge({ children, tone = "" }: { children: React.ReactNode; tone?: string }) { return <span className={`c360-badge ${tone}`}>{children}</span>; }
function Metric({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) { return <div className="c360-metric"><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>; }
function List({ rows, render }: { rows: Row[]; render: (r: Row, i: number) => React.ReactNode }) { return rows.length ? <div className="c360-list">{rows.map(render)}</div> : <div className="c360-empty">Nenhum registro nesta fonte.</div>; }

function SafeMetaActions({ clientId, campaigns, onDone }: { clientId: string; campaigns: Row[]; onDone: () => void }) {
  const [cap, setCap] = useState<Row | null>(null);
  const [mode, setMode] = useState<"PAUSE" | "RESUME">("PAUSE");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Row | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    authedFetch(API_ACTIONS, { method: "POST", body: JSON.stringify({ action: "CAPABILITIES", client_id: clientId }) })
      .then((p) => { if (active) setCap(p); }).catch((e) => { if (active) setCap({ ok: false, error: e.message }); });
    return () => { active = false; };
  }, [clientId]);

  const unique = useMemo(() => [...new Map((campaigns || []).map((c) => [String(c.campaign_id), c])).values()], [campaigns]);
  const eligible = unique.filter((c) => mode === "PAUSE" ? String(c.campaign_status).toUpperCase() === "ACTIVE" : String(c.campaign_status).toUpperCase() === "PAUSED");
  function toggle(id: string) { setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }); setPreview(null); }
  function changeMode(next: "PAUSE" | "RESUME") { setMode(next); setSelected(new Set()); setPreview(null); setMessage(""); }
  async function makePreview() {
    setBusy(true); setMessage("");
    try {
      const p = await authedFetch(API_ACTIONS, { method: "POST", body: JSON.stringify({ action: "PREVIEW", action_type: mode, client_id: clientId, campaign_ids: [...selected] }) });
      setPreview(p.preview); setConfirmation(""); setPassword("");
    } catch (e: any) { setMessage(`Não foi possível gerar a prévia: ${e.message}`); }
    finally { setBusy(false); }
  }
  async function execute() {
    if (!preview?.id) return;
    setBusy(true); setMessage("");
    try {
      const p = await authedFetch(API_ACTIONS, { method: "POST", body: JSON.stringify({ action: "EXECUTE", client_id: clientId, preview_id: preview.id, confirmation, password }) });
      setMessage(p?.verification?.verified ? "Ação executada e verificada diretamente na Meta." : `Execução terminou com status ${p.status || "desconhecido"}.`);
      if (p?.verification?.verified) { setPreview(null); setSelected(new Set()); onDone(); }
    } catch (e: any) { setMessage(`A ação não foi concluída: ${e.message}`); }
    finally { setPassword(""); setBusy(false); }
  }

  if (cap === null) return <div className="c360-empty">Verificando permissão de escrita na Meta…</div>;
  if (!cap.meta_write) return <div className="c360-action-disabled"><b>Ações Meta bloqueadas.</b><span>O token atual não confirmou a permissão <code>ads_management</code>. A leitura continua funcionando, mas nenhuma alteração é liberada.</span></div>;

  return <div className="c360-actions">
    <div className="c360-action-head"><div><b>Central de Ações Seguras</b><small>Prévia → confirmação → senha → execução → verificação → auditoria.</small></div><Badge tone="ok">META WRITE CONFIRMADO</Badge></div>
    <div className="c360-action-tabs"><button className={mode === "PAUSE" ? "active" : ""} onClick={() => changeMode("PAUSE")}>Pausar campanhas</button><button className={mode === "RESUME" ? "active" : ""} onClick={() => changeMode("RESUME")}>Retomar campanhas</button></div>
    <div className="c360-campaign-picker">
      {eligible.length ? eligible.map((c) => { const id = String(c.campaign_id); return <label key={id}><input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} /><span><b>{c.campaign_name || id}</b><small>{id} · {c.campaign_status} · atualização {shortDate(c.checked_at)}</small></span></label>; }) : <div className="c360-empty">Nenhuma campanha elegível para esta ação.</div>}
    </div>
    {!preview ? <button className="c360-primary" disabled={!selected.size || busy} onClick={makePreview}>{busy ? "Gerando prévia…" : `Gerar prévia de ${selected.size} campanha${selected.size === 1 ? "" : "s"}`}</button> : <div className="c360-preview">
      <div className="c360-preview-title"><b>Prévia ao vivo</b><small>Válida até {shortDate(preview.expires_at)}. Se o estado da campanha mudar antes da confirmação, a execução é bloqueada.</small></div>
      <List rows={preview.preview_state || []} render={(r) => <div className="c360-row" key={r.id}><span><b>{r.name || r.id}</b><small>{r.id}</small></span><span className="c360-transition">{r.status} → <b>{r.new_status}</b></span></div>} />
      <div className="c360-confirm"><label>Digite <b>CONFIRMAR</b><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" /></label><label>Senha do Dashboard<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label></div>
      <div className="c360-action-buttons"><button onClick={() => setPreview(null)} disabled={busy}>Cancelar</button><button className="c360-danger" disabled={busy || confirmation.trim().toUpperCase() !== "CONFIRMAR" || !password} onClick={execute}>{busy ? "Executando e verificando…" : "Confirmar e executar"}</button></div>
    </div>}
    {message ? <div className="c360-action-message">{message}</div> : null}
  </div>;
}

function Panel({ clientName }: { clientName: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setError("");
    authedFetch(`${API_360}?name=${encodeURIComponent(clientName)}`).then((p) => { if (active) setData(p); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [clientName, reload]);
  if (error) return <section className="c360-shell"><div className="c360-error">Cliente 360 indisponível: {error}</div></section>;
  if (!data) return <section className="c360-shell"><div className="c360-empty">Montando Cliente 360…</div></section>;

  const meta = data.meta || {};
  const health = data.health || {};
  const op = data.operational || {};
  const confidence = Number(data.data_confidence?.overall || 0);
  const pending = (data.commitments?.length || 0) + (data.work_items?.filter((x: Row) => !["COMPLETED", "DONE", "CANCELLED"].includes(String(x.status).toUpperCase())).length || 0) + (data.clickup_tasks?.length || 0);
  return <section className="c360-shell">
    <div className="c360-head"><div><span className="c360-kicker">CONTEXTO UNIFICADO</span><h3>Cliente 360</h3><p>Operação, saúde, Meta, ClickUp, compromissos, ajustes, reuniões e integrações em uma única leitura.</p></div><div className="c360-confidence"><span>Data Confidence</span><strong>{confidence}%</strong><Badge tone={confidence >= 80 ? "ok" : confidence >= 55 ? "warn" : "bad"}>{confidence >= 80 ? "ALTA" : confidence >= 55 ? "MÉDIA" : "BAIXA"}</Badge></div></div>
    <div className="c360-ownerbar"><Badge>GT · {fmt(data.client.gt_owner)}</Badge><Badge>CS · {fmt(data.client.cs_owner)}</Badge><Badge>Design · {fmt(data.client.designer_owner)}</Badge><Badge tone="soft">{fmt(data.client.lifecycle)}</Badge></div>
    <div className="c360-metrics">
      <Metric label="Saúde" value={health.internal_band || health.external_health_status || "—"} note={health.internal_score != null ? `score ${health.internal_score}` : health.external_risk_level || null} />
      <Metric label="Investimento Meta" value={brl(meta.spend)} note={`${Number(meta.active_campaigns || 0)} ativas · ${Number(meta.paused_campaigns || 0)} pausadas`} />
      <Metric label="Leads Meta" value={fmt(meta.leads)} note={meta.cost_per_result != null ? `custo/result. ${brl(meta.cost_per_result)}` : null} />
      <Metric label="Pendências visíveis" value={pending} note={`${data.commitments?.length || 0} compromissos · ${data.clickup_tasks?.length || 0} ClickUp`} />
    </div>
    <div className="c360-now"><div><span>AGORA</span><b>{op.current_subject || op.summary_today || health.external_summary || "Sem assunto operacional consolidado."}</b></div><div><span>PRÓXIMO PASSO</span><b>{op.next_step || health.external_recommended_action || "Sem próximo passo consolidado."}</b><small>{op.action_owner ? `Responsável: ${op.action_owner}` : ""}{op.next_step_due ? ` · até ${shortDate(op.next_step_due)}` : ""}</small></div></div>

    <div className="c360-details-grid">
      <details open><summary>Pendências e execução <Badge>{pending}</Badge></summary><div className="c360-detail-body">
        <h4>Compromissos</h4><List rows={data.commitments || []} render={(r) => <div className="c360-row" key={`c-${r.id}`}><span><b>{clip(r.descricao, 130)}</b><small>{fmt(r.owner)} · {fmt(r.status)}</small></span><small>{r.due_at ? `prazo ${shortDate(r.due_at)}` : "sem prazo"}</small></div>} />
        <h4>ClickUp aberto</h4><List rows={data.clickup_tasks || []} render={(r) => <div className="c360-row" key={`t-${r.task_id}`}><span><b>{clip(r.name, 130)}</b><small>{fmt(r.assignee_names)} · {fmt(r.status)}</small></span><small>{r.due_date ? shortDate(r.due_date) : ""}</small></div>} />
        <h4>Central de Trabalho</h4><List rows={(data.work_items || []).filter((r: Row) => !["COMPLETED", "DONE", "CANCELLED"].includes(String(r.status).toUpperCase())).slice(0, 8)} render={(r) => <div className="c360-row" key={`w-${r.id}`}><span><b>{clip(r.title, 130)}</b><small>{fmt(r.target_person || r.target_role)} · {fmt(r.status)}</small></span><small>{fmt(r.priority)}</small></div>} />
      </div></details>

      <details><summary>Histórico operacional <Badge>{(data.adjustments?.length || 0) + (data.meetings?.length || 0)}</Badge></summary><div className="c360-detail-body">
        <h4>Ajustes recentes</h4><List rows={data.adjustments || []} render={(r) => <div className="c360-row" key={`a-${r.id}`}><span><b>{clip(r.descricao, 150)}</b><small>{fmt(r.request_origin || r.source)} · {fmt(r.status)}{r.is_recurrent ? " · recorrente" : ""}</small></span><small>{shortDate(r.occurred_at)}</small></div>} />
        <h4>Reuniões recentes</h4><List rows={data.meetings || []} render={(r) => <div className="c360-row c360-row-long" key={`m-${r.id}`}><span><b>{r.source_file_name || "Reunião"}</b><small>{clip(r.summary, 220)}</small></span><small>{shortDate(r.meeting_started_at || r.created_at)}</small></div>} />
      </div></details>

      <details><summary>Fontes e cobertura <Badge>{data.data_confidence?.sources?.length || 0}</Badge></summary><div className="c360-detail-body">
        <div className="c360-source-grid">{(data.data_confidence?.sources || []).map((s: Row) => <div key={s.source}><span>{s.source}</span><b>{s.state === "NA" ? "N/A" : `${s.score}%`}</b><small>{s.last_at ? shortDate(s.last_at) : s.state}</small></div>)}</div>
        <h4>Integrações vinculadas</h4><List rows={data.integrations || []} render={(r) => <div className="c360-row" key={`${r.system}-${r.external_id}`}><span><b>{fmt(r.system)}</b><small>{fmt(r.external_name || r.external_id)}</small></span><small>{r.is_primary ? "principal" : fmt(r.confidence)}</small></div>} />
      </div></details>
    </div>

    {data.permissions?.safe_meta_actions ? <SafeMetaActions clientId={data.client.id} campaigns={data.campaigns || []} onDone={() => setReload((x) => x + 1)} /> : null}
  </section>;
}

export default function Client360Bridge() {
  useEffect(() => {
    let active = true;
    const roots = new Map<HTMLElement, { key: string; root: Root }>();
    function scan() {
      if (!active) return;
      const container = document.querySelector(".ops-360") as HTMLElement | null;
      const grid = container?.querySelector(".ops-360-grid") as HTMLElement | null;
      const heading = container?.querySelector(".ops-360-head h2") as HTMLElement | null;
      if (!container || !grid || !heading) return;
      const name = (heading.textContent || "").trim();
      if (!name || /carregando|buscando/i.test(name)) return;
      let slot = grid.querySelector(`:scope > .${SLOT}`) as HTMLElement | null;
      if (!slot) { slot = document.createElement("div"); slot.className = SLOT; grid.insertBefore(slot, grid.firstChild); }
      const existing = roots.get(slot);
      if (existing?.key === name) return;
      if (existing) { existing.root.unmount(); roots.delete(slot); }
      const root = createRoot(slot); root.render(<Panel clientName={name} />); roots.set(slot, { key: name, root });
    }
    scan();
    const observer = new MutationObserver(scan); observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const timer = window.setInterval(scan, 1000);
    return () => { active = false; observer.disconnect(); window.clearInterval(timer); roots.forEach((x) => x.root.unmount()); roots.clear(); document.querySelectorAll(`.${SLOT}`).forEach((n) => n.remove()); };
  }, []);
  return null;
}
