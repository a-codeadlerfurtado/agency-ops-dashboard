"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_URL, authenticatedFetch, formatMoney, text } from "./shared";
import type { Row } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const OPEN_STAGES = [
  ["novo", "Novo"],
  ["qualificacao", "Qualificação"],
  ["reuniao", "Reunião"],
  ["proposta", "Proposta"],
  ["negociacao", "Negociação"],
] as const;
const CLOSED_STAGES = [
  ["fechado", "Fechado"],
  ["perdido", "Perdido"],
] as const;
const ALL_STAGES = [...OPEN_STAGES, ...CLOSED_STAGES] as const;
const ADVANCED = new Set(["reuniao", "proposta", "negociacao"]);

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stageDays(value: unknown) {
  if (!value) return null;
  const parsed = new Date(String(value)).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function ageText(days: number | null) {
  if (days == null) return "tempo não informado";
  if (days === 0) return "movido hoje";
  if (days === 1) return "há 1 dia na etapa";
  return `há ${days} dias na etapa`;
}

function isPreclientsActive() {
  if (window.location.pathname !== "/") return false;
  const active = document.querySelector<HTMLButtonElement>(".side-nav-items button.active");
  const label = normalize(active?.title || active?.textContent || "");
  return label.startsWith("pre-clientes") || label.startsWith("pre clientes");
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="pk-kpi card"><span>{label}</span><b>{value}</b><small>{hint}</small></article>;
}

export default function PreclientsKanbanBridge() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [leads, setLeads] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        setAuthorized(false);
        return;
      }
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setLeads(Array.isArray(body?.leads) ? body.leads : []);
      setAuthorized(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar os pré-clientes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let frame = 0;
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!alive) return;
        const nextActive = isPreclientsActive();
        setActive(nextActive);
        const shell = document.querySelector<HTMLElement>("main.shell");
        if (!nextActive || !shell) {
          document.documentElement.classList.remove("preclients-kanban-active");
          document.getElementById("preclients-kanban-slot")?.remove();
          setSlot(null);
          return;
        }
        let target = document.getElementById("preclients-kanban-slot") as HTMLElement | null;
        if (!target) {
          target = document.createElement("div");
          target.id = "preclients-kanban-slot";
          const side = shell.querySelector(":scope > .side-nav");
          if (side?.nextSibling) shell.insertBefore(target, side.nextSibling);
          else shell.appendChild(target);
        }
        setSlot(target);
        document.documentElement.classList.toggle("preclients-kanban-active", authorized);
      });
    };
    sync();
    document.addEventListener("click", sync, true);
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const timer = window.setInterval(sync, 900);
    return () => {
      alive = false;
      document.removeEventListener("click", sync, true);
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.documentElement.classList.remove("preclients-kanban-active");
      document.getElementById("preclients-kanban-slot")?.remove();
    };
  }, [authorized]);

  useEffect(() => {
    if (!active) return;
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const visible = useMemo(() => {
    const needle = normalize(query);
    return leads.filter((lead) => {
      if (!showClosed && ["fechado", "perdido"].includes(normalize(lead.stage))) return false;
      if (!needle) return true;
      return normalize([lead.name, lead.company, lead.owner_name, lead.source].filter(Boolean).join(" ")).includes(needle);
    });
  }, [leads, query, showClosed]);

  const openLeads = useMemo(() => leads.filter((lead) => !["fechado", "perdido"].includes(normalize(lead.stage))), [leads]);
  const advanced = useMemo(() => openLeads.filter((lead) => ADVANCED.has(normalize(lead.stage))).length, [openLeads]);
  const pipelineValue = useMemo(() => openLeads.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0), [openLeads]);
  const stalled = useMemo(() => openLeads.filter((lead) => (stageDays(lead.updated_at) ?? 0) >= 3).length, [openLeads]);
  const stages = showClosed ? ALL_STAGES : OPEN_STAGES;

  async function moveLead(lead: Row, stage: string) {
    const id = String(lead.id || "");
    const previousStage = normalize(lead.stage) || "novo";
    if (!id || previousStage === stage || busy) return;
    setBusy(id);
    setError("");
    const previous = leads;
    const now = new Date().toISOString();
    setLeads((current) => current.map((item) => String(item.id) === id ? { ...item, stage, updated_at: now } : item));
    try {
      const response = await authenticatedFetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update_lead", lead_id: id, stage }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      if (body?.lead) {
        setLeads((current) => current.map((item) => String(item.id) === id ? { ...item, ...body.lead } : item));
      }
    } catch (caught) {
      setLeads(previous);
      setError(caught instanceof Error ? caught.message : "Não foi possível mover o pré-cliente.");
    } finally {
      setBusy("");
      setDragId(null);
    }
  }

  if (!active || !authorized || !slot) return null;

  return createPortal(
    <section className="pk-shell workspace">
      <style>{styles}</style>
      <div className="workspace-head pk-head">
        <div>
          <span className="eyebrow">Pipeline de fechamento</span>
          <h2>Pré-clientes</h2>
          <p>Arraste os cards entre as etapas. Cada mudança é salva no CRM comercial.</p>
        </div>
        <div className="pk-head-actions">
          <button className="btn" type="button" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
        </div>
      </div>

      <div className="pk-kpis">
        <Kpi label="Oportunidades abertas" value={String(openLeads.length)} hint="fora de fechado/perdido" />
        <Kpi label="Oportunidades avançadas" value={String(advanced)} hint="reunião, proposta ou negociação" />
        <Kpi label="Valor informado" value={formatMoney(pipelineValue)} hint="pipeline aberto" />
        <Kpi label="Paradas há 3+ dias" value={String(stalled)} hint="merecem follow-up" />
      </div>

      <div className="pk-toolbar card">
        <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar pré-cliente, responsável ou origem" />
        <label className="pk-toggle"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} /> Mostrar fechados e perdidos</label>
        <span>{visible.length} exibidos</span>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="pk-board" aria-label="Kanban de pré-clientes">
        {stages.map(([stage, label]) => {
          const cards = visible
            .filter((lead) => (normalize(lead.stage) || "novo") === stage)
            .sort((a, b) => new Date(String(b.updated_at || 0)).getTime() - new Date(String(a.updated_at || 0)).getTime());
          const stageValue = cards.reduce((sum, lead) => sum + (Number(lead.estimated_value) || 0), 0);
          return <section
            className={`pk-column card pk-stage-${stage}`}
            key={stage}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const lead = leads.find((item) => String(item.id) === dragId);
              if (lead) moveLead(lead, stage);
            }}
          >
            <div className="pk-column-head">
              <div><b>{label}</b><small>{stageValue ? formatMoney(stageValue) : "sem valor informado"}</small></div>
              <strong>{cards.length}</strong>
            </div>
            <div className="pk-cards">
              {cards.map((lead) => {
                const days = stageDays(lead.updated_at);
                const staleClass = (days ?? 0) >= 7 ? " very-stale" : (days ?? 0) >= 3 ? " stale" : "";
                const id = String(lead.id);
                return <article
                  key={id}
                  className={`pk-card${staleClass}${busy === id ? " busy" : ""}`}
                  draggable={busy !== id}
                  onDragStart={() => setDragId(id)}
                  onDragEnd={() => setDragId(null)}
                >
                  <div className="pk-card-top">
                    <div><b>{text(lead.company || lead.name)}</b>{lead.company && <small>{text(lead.name)}</small>}</div>
                    {(days ?? 0) >= 3 && <span>{days}d</span>}
                  </div>
                  <div className="pk-card-meta">
                    <span>{text(lead.owner_name || "Sem responsável")}</span>
                    <span>{text(lead.source || "Origem não informada")}</span>
                  </div>
                  <div className="pk-card-value">{Number(lead.estimated_value) > 0 ? formatMoney(lead.estimated_value) : "Valor não informado"}</div>
                  <small className="pk-age">{ageText(days)}</small>
                  <select
                    className="control pk-stage-select"
                    aria-label={`Mover ${text(lead.company || lead.name)} de etapa`}
                    value={normalize(lead.stage) || "novo"}
                    disabled={busy === id}
                    onChange={(event) => moveLead(lead, event.target.value)}
                  >
                    {ALL_STAGES.map(([value, option]) => <option key={value} value={value}>{option}</option>)}
                  </select>
                </article>;
              })}
              {!cards.length && <div className="pk-empty">Solte um card aqui</div>}
            </div>
          </section>;
        })}
      </div>
    </section>,
    slot,
  );
}

const styles = `
html.preclients-kanban-active main.shell > .workspace{display:none!important}
html.preclients-kanban-active main.shell > #preclients-kanban-slot{display:block!important;min-width:0}
.pk-shell{display:block!important;margin-top:4px}
.pk-head{align-items:center}.pk-head-actions{display:flex;gap:8px}.pk-kpis{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin-bottom:12px}.pk-kpi{padding:15px}.pk-kpi span,.pk-kpi small{display:block;color:var(--muted)}.pk-kpi span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:800}.pk-kpi b{display:block;font-size:24px;letter-spacing:-.035em;margin:6px 0 3px}.pk-kpi small{font-size:11px}
.pk-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px;margin-bottom:12px}.pk-toolbar input{flex:1;min-width:260px}.pk-toolbar>span{margin-left:auto;color:var(--muted);font-size:11px}.pk-toggle{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;cursor:pointer}.pk-toggle input{accent-color:var(--brand)}
.pk-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(255px,1fr);gap:12px;overflow-x:auto;padding:1px 1px 12px;align-items:start;scrollbar-width:thin}.pk-column{padding:12px;min-height:430px;box-shadow:none}.pk-column-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:2px 2px 12px;border-bottom:1px solid var(--line);margin-bottom:10px}.pk-column-head b,.pk-column-head small{display:block}.pk-column-head b{font-size:13px}.pk-column-head small{font-size:10px;color:var(--muted);margin-top:4px}.pk-column-head strong{min-width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--panel2);border:1px solid var(--line);font-size:11px}
.pk-cards{display:grid;gap:9px}.pk-card{padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--panel2);cursor:grab;transition:border-color .16s,transform .16s,opacity .16s}.pk-card:hover{border-color:var(--blue);transform:translateY(-1px)}.pk-card:active{cursor:grabbing}.pk-card.busy{opacity:.55;pointer-events:none}.pk-card.stale{border-color:color-mix(in srgb,var(--yellow) 46%,var(--line))}.pk-card.very-stale{border-color:color-mix(in srgb,var(--red) 50%,var(--line))}.pk-card-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.pk-card-top b,.pk-card-top small{display:block}.pk-card-top b{font-size:12.5px;line-height:1.25}.pk-card-top small{font-size:10px;color:var(--muted);margin-top:3px}.pk-card-top>span{font-size:9px;font-weight:800;color:var(--yellow);border:1px solid color-mix(in srgb,var(--yellow) 35%,var(--line));border-radius:999px;padding:3px 6px}.pk-card.very-stale .pk-card-top>span{color:var(--red);border-color:color-mix(in srgb,var(--red) 38%,var(--line))}.pk-card-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.pk-card-meta span{font-size:9.5px;color:var(--muted);padding:3px 6px;border-radius:999px;border:1px solid var(--line)}.pk-card-value{font-size:12px;font-weight:800;color:var(--green);margin-top:10px}.pk-age{display:block;color:var(--muted);font-size:10px;margin-top:4px}.pk-stage-select{width:100%;min-width:0!important;margin-top:10px;padding:7px 8px;font-size:10.5px}.pk-empty{min-height:82px;border:1px dashed var(--line);border-radius:11px;display:grid;place-items:center;color:var(--muted);font-size:10px}
.pk-stage-fechado .pk-column-head b{color:var(--green)}.pk-stage-perdido .pk-column-head b{color:var(--red)}
@media(max-width:900px){.pk-kpis{grid-template-columns:repeat(2,minmax(140px,1fr))}.pk-board{grid-auto-columns:minmax(245px,82vw)}.pk-toolbar>span{margin-left:0}.pk-head{align-items:flex-start;flex-direction:column}}
`;
