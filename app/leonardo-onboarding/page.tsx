"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "../shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-overview-api`;
const WRITE_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-onboarding-write-api`;
const MEETINGS = [
  ["INTRO_MEETING", "1ª apresentação"],
  ["PRODUCT_PERSONA_MEETING", "Produto + Persona"],
  ["INTEGRATION_MEETING", "Integração GT"],
] as const;
const LANES = [
  ["INTRO", "1ª apresentação", "Cliente recém-vendido ou aguardando a primeira reunião."],
  ["PRODUCT", "Produto + Persona", "Reunião e formulários de produto/persona."],
  ["INPUTS", "Insumos e materiais", "Materiais necessários para a operação avançar."],
  ["INTEGRATION", "Integração com GT", "Integração, acessos e validações técnicas."],
  ["CREATIVE", "Produção e aprovação", "Criativos em produção, revisão ou aprovação."],
  ["LAUNCH", "Pronto para campanha", "Tudo pronto para publicação ou campanha entrando no ar."],
  ["BLOCKED", "Bloqueados / atenção", "Atrasos, bloqueios ou risco elevado exigindo ação."],
] as const;
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente", SCHEDULED: "Agendada", IN_PROGRESS: "Em andamento", DONE: "Concluída",
  SKIPPED: "Superada", BLOCKED: "Bloqueada", COMPLETED: "Concluída", OK: "OK",
  ATTENTION: "Atenção", HIGH: "Alta", CRITICAL: "Crítica",
};

function fmt(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(date);
}
function stageOf(client: Row, code: string) {
  return (client.stages || []).find((stage: Row) => String(stage.stage_code) === code) || null;
}
function currentStage(client: Row) { return stageOf(client, String(client.current_stage || "")); }
function currentMeet(client: Row) {
  for (const [code] of MEETINGS) {
    const stage = stageOf(client, code);
    if (stage && String(stage.status).toUpperCase() === "SCHEDULED") return stage;
  }
  return null;
}
function hasAttention(client: Row) {
  return String(client.onboarding_risk || "").toUpperCase() === "CRITICAL" ||
    (client.stages || []).some((stage: Row) => String(stage.status || "").toUpperCase() === "BLOCKED" || Boolean(stage.overdue));
}
function laneOf(client: Row) {
  if (hasAttention(client)) return "BLOCKED";
  const stage = String(client.current_stage || "");
  if (["SALES_CONFIRMED", "OPERATIONAL_ACTIVATION", "INTRO_MEETING"].includes(stage)) return "INTRO";
  if (["PRODUCT_PERSONA_MEETING", "PRODUCT_FORM", "PERSONA_FORM"].includes(stage)) return "PRODUCT";
  if (stage === "RAW_ASSETS") return "INPUTS";
  if (["INTEGRATION_MEETING", "ACCESS_VALIDATION"].includes(stage)) return "INTEGRATION";
  if (["CREATIVE_PRODUCTION", "CREATIVE_APPROVAL"].includes(stage)) return "CREATIVE";
  if (["READY_TO_LAUNCH", "CAMPAIGN_LAUNCH", "COMPLETED"].includes(stage)) return "LAUNCH";
  return "INTRO";
}
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (["BLOCKED", "CRITICAL", "OVERDUE"].includes(status)) return "bad";
  if (["SCHEDULED", "IN_PROGRESS", "ATTENTION", "HIGH"].includes(status)) return "warn";
  if (["DONE", "SKIPPED", "COMPLETED", "OK"].includes(status)) return "ok";
  return "muted";
}
function Pill({ value }: { value: unknown }) {
  const key = String(value || "PENDING").toUpperCase();
  return <span className={`lo-pill ${tone(key)}`}>{STATUS_LABEL[key] || key.replaceAll("_", " ")}</span>;
}

export default function LeonardoOnboardingPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Row>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Row>({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session); setReady(true);
      if (!data.session) window.location.assign("/");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next); if (!next) window.location.assign("/");
    });
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      if (String(body?.profile?.person || "") !== "Leonardo Augusto") throw new Error("Área disponível apenas para a Direção Comercial.");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar o onboarding.");
    } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [session?.access_token, load]);

  const clients: Row[] = data.clients || [];
  const definitions: Row[] = data.definitions || [];
  const filtered = useMemo(() => clients.filter((client) => {
    if (!query.trim()) return true;
    return [client.display_name, client.gt_owner, client.cs_owner, client.current_stage_label, client.next_action]
      .join(" ").toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR"));
  }), [clients, query]);
  const groups = useMemo(() => LANES.map(([key, label, help]) => ({
    key, label, help, items: filtered.filter((client) => laneOf(client) === key),
  })), [filtered]);
  const stats = useMemo(() => ({
    total: filtered.length,
    withoutGt: filtered.filter((client) => !String(client.gt_owner || "").trim()).length,
    scheduled: filtered.filter((client) => Boolean(currentMeet(client))).length,
    overdue: filtered.filter((client) => (client.stages || []).some((stage: Row) => Boolean(stage.overdue))).length,
    blocked: filtered.filter((client) => (client.stages || []).some((stage: Row) => String(stage.status || "").toUpperCase() === "BLOCKED")).length,
    attention: filtered.filter((client) => ["ATTENTION", "HIGH", "CRITICAL"].includes(String(client.onboarding_risk || "").toUpperCase())).length,
  }), [filtered]);

  function edit(client: Row) {
    const stage = currentStage(client);
    setSelected(client);
    setForm({
      current_stage: client.current_stage || "", onboarding_risk: client.onboarding_risk || "OK",
      next_action: client.next_action || "", next_action_due: client.next_action_due ? String(client.next_action_due).slice(0, 16) : "",
      stage_code: client.current_stage || "", stage_status: stage?.status || "PENDING",
      stage_due: stage?.due_at ? String(stage.due_at).slice(0, 16) : "",
    });
  }
  async function write(body: Row) {
    const response = await authenticatedFetch(WRITE_API, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json?.ok) throw new Error(json?.detail || json?.error || `API ${response.status}`);
  }
  async function save() {
    if (!selected || saving) return;
    setSaving(true); setError("");
    try {
      await write({ action: "update_case", case_id: selected.case_id, current_stage: form.current_stage, onboarding_risk: form.onboarding_risk, next_action: form.next_action, next_action_due: form.next_action_due || null });
      await write({ action: "update_stage", case_id: selected.case_id, stage_code: form.stage_code, status: form.stage_status, due_at: form.stage_due || null });
      setSelected(null); await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao salvar o onboarding.");
    } finally { setSaving(false); }
  }

  if (!ready || !session) return <main className="lo-loading">Carregando…</main>;

  return <main className="lo-root"><style>{styles}</style>
    <header className="lo-top">
      <div>
        <button onClick={() => window.location.assign("/")}>← Central Comercial</button>
        <span className="lo-kicker">DIREÇÃO COMERCIAL · ONBOARDING</span>
        <h1>Visão panorâmica do onboarding</h1>
        <p>Todos os clientes, fases, responsáveis, reuniões, atrasos e bloqueios em um único quadro.</p>
      </div>
      <div className="lo-actions"><small>{loading ? "Sincronizando…" : `Atualizado ${fmt(data.generated_at)}`}</small><button onClick={load} disabled={loading}>Atualizar</button></div>
    </header>

    {error && <div className="lo-error">{error}</div>}

    <section className="lo-metrics">
      <article><small>EM ONBOARDING</small><b>{stats.total}</b><span>clientes</span></article>
      <article><small>SEM GT DEFINIDO</small><b>{stats.withoutGt}</b><span>atribuição pendente</span></article>
      <article><small>REUNIÃO AGENDADA</small><b>{stats.scheduled}</b><span>com data/hora</span></article>
      <article className={stats.overdue ? "danger" : ""}><small>COM ATRASO</small><b>{stats.overdue}</b><span>prazo vencido</span></article>
      <article className={stats.blocked ? "danger" : ""}><small>BLOQUEADOS</small><b>{stats.blocked}</b><span>exigem ação</span></article>
      <article className={stats.attention ? "warn" : ""}><small>EM ATENÇÃO</small><b>{stats.attention}</b><span>risco elevado</span></article>
    </section>

    <section className="lo-toolbar">
      <div><b>Panorama completo</b><span>Cada card representa um cliente e fica automaticamente na fase atual.</span></div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, GT, CS, etapa ou próxima ação…" />
    </section>

    <div className="lo-board-wrap"><section className="lo-board">
      {groups.map((group) => <article className={`lo-lane ${group.key === "BLOCKED" ? "danger" : ""}`} key={group.key}>
        <header><div><h2>{group.label}</h2><p>{group.help}</p></div><strong>{group.items.length}</strong></header>
        <div className="lo-cards">
          {group.items.map((client) => {
            const stage = currentStage(client);
            const meet = currentMeet(client);
            const due = client.next_action_due || meet?.scheduled_for || stage?.due_at;
            return <div className="lo-card" key={String(client.case_id)}>
              <div className="lo-card-top"><div><h3>{client.display_name}</h3><span>GT {client.gt_owner || "não definido"} · CS {client.cs_owner || "não definido"}</span></div><Pill value={client.onboarding_risk || "OK"} /></div>
              <div className={`lo-when ${stage?.overdue ? "bad" : ""}`}>{meet ? `Reunião: ${fmt(meet.scheduled_for || meet.due_at)}` : due ? `Próximo prazo: ${fmt(due)}` : "Sem data/hora consolidada"}</div>
              {meet?.meet_url && <a className="lo-meet" href={String(meet.meet_url)} target="_blank" rel="noreferrer">↗ Entrar no Meet</a>}
              <div className="lo-meeting-row">{MEETINGS.map(([code, label]) => <span key={code}><small>{label}</small><Pill value={stageOf(client, code)?.status || "PENDING"} /></span>)}</div>
              <div className="lo-current"><small>ETAPA ATUAL</small><b>{client.current_stage_label || client.current_stage || "—"}</b>{stage?.owner && <span>Responsável: {stage.owner}</span>}</div>
              <p className="lo-next">{client.next_action || "Acompanhar a próxima etapa do onboarding."}</p>
              <footer><small>{client.entrada ? `Entrada ${fmt(client.entrada)}` : "Entrada não consolidada"}</small><button onClick={() => edit(client)}>Gerenciar →</button></footer>
            </div>;
          })}
          {!group.items.length && <div className="lo-empty">Nenhum cliente nesta fase.</div>}
        </div>
      </article>)}
    </section></div>

    {selected && <div className="lo-modal-bg" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setSelected(null); }}>
      <section className="lo-modal">
        <header><div><span>GERENCIAR ONBOARDING</span><h2>{selected.display_name}</h2><p>Alterações auditadas como Leonardo Augusto.</p></div><button onClick={() => setSelected(null)} disabled={saving}>×</button></header>
        <div className="lo-form">
          <label>Etapa atual<select value={form.current_stage} onChange={(event) => {
            const next = event.target.value; const stage = stageOf(selected, next);
            setForm((value) => ({ ...value, current_stage: next, stage_code: next, stage_status: stage?.status || "PENDING", stage_due: stage?.due_at ? String(stage.due_at).slice(0, 16) : "" }));
          }}>{definitions.map((row) => <option value={row.code} key={row.code}>{row.label}</option>)}</select></label>
          <label>Risco<select value={form.onboarding_risk} onChange={(event) => setForm((value) => ({ ...value, onboarding_risk: event.target.value }))}><option>OK</option><option>ATTENTION</option><option>HIGH</option><option>CRITICAL</option></select></label>
          <label>Status da etapa<select value={form.stage_status} onChange={(event) => setForm((value) => ({ ...value, stage_status: event.target.value }))}>{["PENDING", "SCHEDULED", "IN_PROGRESS", "DONE", "BLOCKED", "SKIPPED"].map((value) => <option value={value} key={value}>{STATUS_LABEL[value] || value}</option>)}</select></label>
          <label>Prazo da etapa<input type="datetime-local" value={form.stage_due || ""} onChange={(event) => setForm((value) => ({ ...value, stage_due: event.target.value }))} /></label>
          <label className="wide">Próxima ação<textarea value={form.next_action || ""} onChange={(event) => setForm((value) => ({ ...value, next_action: event.target.value }))} /></label>
          <label>Prazo da próxima ação<input type="datetime-local" value={form.next_action_due || ""} onChange={(event) => setForm((value) => ({ ...value, next_action_due: event.target.value }))} /></label>
        </div>
        <footer><button onClick={() => setSelected(null)} disabled={saving}>Cancelar</button><button className="save" onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar alterações"}</button></footer>
      </section>
    </div>}
  </main>;
}

const styles = `
.lo-root{min-height:100vh;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding-bottom:38px}.lo-loading{min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--muted)}.lo-top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:23px 28px;border-bottom:1px solid var(--line);background:var(--panel2);position:sticky;top:0;z-index:20;box-shadow:0 10px 30px rgba(0,0,0,.16)}.lo-top button,.lo-actions button,.lo-modal button{border:1px solid var(--line);background:#132640;color:var(--text);border-radius:10px;padding:9px 11px;cursor:pointer}.lo-top button:hover,.lo-actions button:hover,.lo-modal button:hover{border-color:var(--blue)}.lo-kicker{display:block;margin-top:13px;color:var(--blue);font-size:9px;font-weight:900;letter-spacing:.14em}.lo-top h1{margin:5px 0 4px;font-size:26px;letter-spacing:-.03em}.lo-top p{margin:0;color:var(--muted);font-size:12px}.lo-actions{display:flex;gap:9px;align-items:center}.lo-actions small{color:var(--muted);font-size:11px}.lo-error{margin:14px 28px;background:rgba(255,107,117,.1);border:1px solid rgba(255,107,117,.3);padding:12px;border-radius:11px;color:#ffb0b6}.lo-metrics{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px;padding:20px 28px 10px}.lo-metrics article{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:15px;box-shadow:var(--shadow)}.lo-metrics article.danger{border-color:rgba(255,107,117,.34);background:rgba(255,107,117,.06)}.lo-metrics article.warn{border-color:rgba(247,201,92,.3);background:rgba(247,201,92,.05)}.lo-metrics small{display:block;color:var(--muted);font-size:9px;font-weight:850;letter-spacing:.08em}.lo-metrics b{display:block;font-size:27px;margin-top:6px;letter-spacing:-.04em}.lo-metrics span{font-size:10px;color:var(--muted)}.lo-toolbar{margin:0 28px 14px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 15px;display:flex;justify-content:space-between;gap:15px;align-items:center}.lo-toolbar div{display:flex;flex-direction:column}.lo-toolbar b{font-size:12px}.lo-toolbar span{font-size:10px;color:var(--muted);margin-top:3px}.lo-toolbar input,.lo-form input,.lo-form select,.lo-form textarea{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:9px 10px;outline:none}.lo-toolbar input:focus,.lo-form input:focus,.lo-form select:focus,.lo-form textarea:focus{border-color:var(--blue)}.lo-toolbar input{min-width:330px;font-size:11px}.lo-board-wrap{overflow-x:auto;padding:0 28px 10px}.lo-board{display:grid;grid-template-columns:repeat(7,minmax(245px,1fr));gap:10px;min-width:1815px;align-items:start}.lo-lane{background:var(--panel);border:1px solid var(--line);border-radius:14px;min-height:480px;box-shadow:var(--shadow)}.lo-lane.danger{border-color:rgba(255,107,117,.34)}.lo-lane>header{padding:13px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:flex-start;background:var(--panel2);border-radius:14px 14px 0 0}.lo-lane h2{font-size:12px;margin:0}.lo-lane header p{font-size:8.5px;line-height:1.4;color:var(--muted);margin:4px 0 0}.lo-lane header strong{font-size:11px;background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:5px 8px}.lo-cards{display:grid;gap:8px;padding:9px}.lo-card{border:1px solid var(--line);background:#0a1727;border-radius:11px;padding:11px;transition:.16s ease}.lo-card:hover{border-color:var(--blue);transform:translateY(-1px)}:root[data-theme="light"] .lo-card{background:var(--panel2)}.lo-card-top{display:flex;justify-content:space-between;gap:8px}.lo-card h3{font-size:11.5px;margin:0}.lo-card-top>div>span{display:block;font-size:8px;color:var(--muted);margin-top:3px}.lo-pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 6px;font-size:7px;font-weight:850;white-space:nowrap}.lo-pill.ok{color:var(--green);background:rgba(49,212,155,.08);border-color:rgba(49,212,155,.24)}.lo-pill.warn{color:var(--yellow);background:rgba(247,201,92,.08);border-color:rgba(247,201,92,.24)}.lo-pill.bad{color:var(--red);background:rgba(255,107,117,.09);border-color:rgba(255,107,117,.25)}.lo-pill.muted{color:var(--muted)}.lo-when{margin:10px 0 7px;padding:7px 8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:8px}.lo-when.bad{color:var(--red);border-color:rgba(255,107,117,.3)}.lo-meet{display:block;margin-bottom:8px;color:var(--blue);font-size:8.5px;font-weight:800;text-decoration:none}.lo-meeting-row{display:grid;gap:5px;padding:8px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.lo-meeting-row>span{display:flex;justify-content:space-between;align-items:center;gap:8px}.lo-meeting-row small{font-size:7.5px;color:var(--muted)}.lo-current{margin-top:9px}.lo-current small{display:block;font-size:7px;color:var(--muted);font-weight:800;letter-spacing:.07em}.lo-current b{display:block;font-size:10px;margin-top:3px}.lo-current span{display:block;color:var(--muted);font-size:8px;margin-top:3px}.lo-next{font-size:9px;line-height:1.45;color:#d7e5f7;min-height:38px}.lo-card footer{display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px solid var(--line);padding-top:9px}.lo-card footer small{font-size:7.5px;color:var(--muted)}.lo-card footer button{border:0;background:transparent;color:var(--blue);font-size:8px;font-weight:850;cursor:pointer}.lo-empty{padding:30px 8px;text-align:center;color:var(--muted);font-size:9px}.lo-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:grid;place-items:center;padding:20px;backdrop-filter:blur(7px)}.lo-modal{width:min(820px,96vw);background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}.lo-modal>header{display:flex;justify-content:space-between;gap:14px;padding:18px;border-bottom:1px solid var(--line)}.lo-modal header span{color:var(--blue);font-size:8px;font-weight:900;letter-spacing:.11em}.lo-modal h2{margin:4px 0;font-size:20px}.lo-modal header p{margin:0;color:var(--muted);font-size:9px}.lo-modal header>button{width:34px;height:34px;padding:0}.lo-form{padding:18px;display:grid;grid-template-columns:repeat(2,1fr);gap:11px}.lo-form label{display:grid;gap:5px;color:var(--muted);font-size:9px}.lo-form label.wide{grid-column:1/-1}.lo-form textarea{min-height:90px;resize:vertical}.lo-modal>footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--line)}.lo-modal>footer .save{background:var(--brand);border-color:var(--brand);color:#fff}.lo-modal button:disabled{opacity:.55;cursor:not-allowed}@media(max-width:1100px){.lo-metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:720px){.lo-top{position:static;flex-direction:column;align-items:flex-start}.lo-actions{width:100%;justify-content:space-between}.lo-metrics{grid-template-columns:repeat(2,1fr);padding-left:16px;padding-right:16px}.lo-toolbar{margin-left:16px;margin-right:16px;flex-direction:column;align-items:stretch}.lo-toolbar input{min-width:0;width:100%}.lo-board-wrap{padding-left:16px;padding-right:16px}.lo-form{grid-template-columns:1fr}.lo-form label.wide{grid-column:auto}}
`;
