"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatDate, supabase, text } from "../shared";

type Row = Record<string, any>;
type Payload = { profile?: Row; definitions?: Row[]; clients?: Row[]; summary?: Row; generated_at?: string };
type ViewMode = "client" | "panorama";
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-overview-api`;
const MEETING_ORDER = ["INTRO_MEETING", "PRODUCT_PERSONA_MEETING", "INTEGRATION_MEETING"];
const MEETING_LABEL: Record<string, string> = {
  INTRO_MEETING: "1ª reunião de apresentação",
  PRODUCT_PERSONA_MEETING: "Produto + Persona",
  INTEGRATION_MEETING: "Integração com GT",
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente", SCHEDULED: "Agendada", IN_PROGRESS: "Em andamento", DONE: "Concluída",
  SKIPPED: "Superada", BLOCKED: "Bloqueada", COMPLETED: "Concluída",
};
const DONE_STATUS = new Set(["DONE", "SKIPPED", "COMPLETED"]);
const ACTIVE_STATUS = new Set(["SCHEDULED", "IN_PROGRESS", "BLOCKED"]);

function fmtDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function statusLabel(value: unknown) { return STATUS_LABEL[String(value || "").toUpperCase()] || text(value); }
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (status === "BLOCKED" || status === "OVERDUE" || status === "CRITICAL") return "bad";
  if (status === "SCHEDULED" || status === "IN_PROGRESS" || status === "HIGH" || status === "ATTENTION") return "warn";
  if (["DONE", "SKIPPED", "COMPLETED", "OK"].includes(status)) return "ok";
  return "muted";
}
function Pill({ value }: { value: unknown }) { return <span className={`oo-pill ${tone(value)}`}>{statusLabel(value)}</span>; }
function stageByCode(client: Row, code: string) { return (client.stages || []).find((stage: Row) => stage.stage_code === code) || null; }
function meetingSort(client: Row) {
  return Math.min(...MEETING_ORDER.map((code, index) => {
    const stage = stageByCode(client, code);
    return stage && !DONE_STATUS.has(String(stage.status)) ? index : 99;
  }), 99);
}
function stageMoment(stage: Row) { return stage?.scheduled_for || stage?.due_at || null; }
function stageCell(stage: Row | null) {
  if (!stage) return { symbol: "·", label: "Sem registro", cls: "pending" };
  if (stage.overdue) return { symbol: "!", label: "Atrasada", cls: "overdue" };
  const status = String(stage.status || "PENDING").toUpperCase();
  if (status === "BLOCKED") return { symbol: "!", label: "Bloqueada", cls: "blocked" };
  if (status === "SCHEDULED") return { symbol: "◷", label: "Agendada", cls: "scheduled" };
  if (status === "IN_PROGRESS") return { symbol: "●", label: "Em andamento", cls: "progress" };
  if (DONE_STATUS.has(status)) return { symbol: "✓", label: statusLabel(status), cls: "done" };
  return { symbol: "·", label: statusLabel(status), cls: "pending" };
}

export default function OnboardingOverviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("client");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(API_URL, { headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar o onboarding geral.");
    } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { if (!session?.access_token) return; load(); const timer = window.setInterval(load, 30000); return () => window.clearInterval(timer); }, [session?.access_token, load]);

  const profile = payload?.profile || {}, summary = payload?.summary || {}, clients = payload?.clients || [], definitions = payload?.definitions || [];
  const isFocusedCs = ["Gustavo Lima", "Joel Antoniete"].includes(String(profile.person || ""));
  const isAdler = Boolean(profile.is_adler) || String(profile.person || "") === "Adler Furtado";
  const filteredClients = useMemo(() => clients.filter((client: Row) => !query.trim() || [client.display_name, client.gt_owner, client.cs_owner, client.current_stage_label].join(" ").toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR"))), [clients, query]);
  const visible = useMemo(() => [...filteredClients].sort((a: Row, b: Row) => meetingSort(a) - meetingSort(b) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR")), [filteredClients]);
  const orderedDefinitions = useMemo(() => [...definitions].filter((row: Row) => String(row.code) !== "COMPLETED").sort((a: Row, b: Row) => Number(a.ordem || 999) - Number(b.ordem || 999) || String(a.label).localeCompare(String(b.label), "pt-BR")), [definitions]);

  const panorama = useMemo(() => {
    const now = Date.now();
    const inSevenDays = now + 7 * 86400000;
    const stageStats = orderedDefinitions.map((definition: Row) => {
      const stages = filteredClients.map((client: Row) => stageByCode(client, String(definition.code))).filter(Boolean) as Row[];
      const current = filteredClients.filter((client: Row) => String(client.current_stage) === String(definition.code)).length;
      const done = stages.filter((stage: Row) => DONE_STATUS.has(String(stage.status).toUpperCase())).length;
      const active = stages.filter((stage: Row) => ACTIVE_STATUS.has(String(stage.status).toUpperCase())).length;
      const blocked = stages.filter((stage: Row) => String(stage.status).toUpperCase() === "BLOCKED").length;
      const overdue = stages.filter((stage: Row) => Boolean(stage.overdue)).length;
      return { ...definition, current, done, active, blocked, overdue };
    });
    const urgent = filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => stage.overdue || String(stage.status).toUpperCase() === "BLOCKED") || ["CRITICAL", "HIGH"].includes(String(client.onboarding_risk || "").toUpperCase()))
      .sort((a: Row, b: Row) => Number((b.stages || []).filter((stage: Row) => stage.overdue || stage.status === "BLOCKED").length) - Number((a.stages || []).filter((stage: Row) => stage.overdue || stage.status === "BLOCKED").length));
    const upcoming = filteredClients.flatMap((client: Row) => (client.stages || []).filter((stage: Row) => MEETING_ORDER.includes(String(stage.stage_code)) && stageMoment(stage)).map((stage: Row) => ({ client, stage, at: new Date(String(stageMoment(stage))).getTime() })))
      .filter((item: Row) => Number.isFinite(item.at) && item.at >= now && item.at <= inSevenDays)
      .sort((a: Row, b: Row) => a.at - b.at);
    const unassigned = filteredClients.filter((client: Row) => !String(client.gt_owner || "").trim());
    const overdueClients = filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => stage.overdue));
    const blockedClients = filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => String(stage.status).toUpperCase() === "BLOCKED"));
    const scheduledClients = filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => String(stage.status).toUpperCase() === "SCHEDULED"));
    return { stageStats, urgent, upcoming, unassigned, overdueClients, blockedClients, scheduledClients };
  }, [filteredClients, orderedDefinitions]);

  function focusClient(client: Row) {
    setQuery(String(client.display_name || ""));
    setViewMode("client");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!ready) return <main className="oo-loading">Validando sessão…</main>;

  return <main className="oo-shell"><style>{styles}</style>
    <header className="oo-top">
      <div><button className="oo-back" onClick={() => window.location.assign("/")}>← Central de Operações</button><span className="oo-kicker">ONBOARDING · VISÃO GERAL DA OPERAÇÃO</span><h1>Onboarding completo</h1><p>{isAdler ? "Acompanhe cada cliente em detalhe ou enxergue a operação inteira em modo panorâmico." : "Todos os clientes, todas as reuniões e todas as etapas em uma única visão."}</p></div>
      <div className="oo-actions">{isFocusedCs && <button className="secondary" onClick={() => window.location.assign("/onboarding-focus")}>← Minha etapa</button>}<span>{loading ? "Sincronizando…" : `Atualizado ${fmtDateTime(payload?.generated_at)}`}</span><button onClick={load} disabled={loading}>Atualizar</button></div>
    </header>

    {error && <div className="oo-error"><b>Falha</b><span>{error}</span></div>}

    {isAdler && <section className="oo-view-switch"><div><b>Como você quer enxergar o onboarding?</b><span>A visão por cliente foi mantida. A panorâmica resume gargalos, agenda e avanço de toda a operação.</span></div><div className="oo-segmented"><button className={viewMode === "client" ? "active" : ""} onClick={() => setViewMode("client")}>Por cliente</button><button className={viewMode === "panorama" ? "active" : ""} onClick={() => setViewMode("panorama")}>Panorâmica</button></div></section>}

    <section className="oo-metrics">
      <article><small>CLIENTES EM ONBOARDING</small><b>{Number(summary.clients || 0)}</b><span>casos abertos</span></article>
      <article><small>1ª APRESENTAÇÃO</small><b>{Number(summary.intro_open || 0)}</b><span>em aberto</span></article>
      <article><small>PRODUTO + PERSONA</small><b>{Number(summary.product_persona_open || 0)}</b><span>em aberto</span></article>
      <article><small>INTEGRAÇÃO COM GT</small><b>{Number(summary.integration_open || 0)}</b><span>em aberto</span></article>
      <article><small>REUNIÕES AGENDADAS</small><b>{Number(summary.meetings_scheduled || 0)}</b><span>com status agendado</span></article>
      <article className={Number(summary.blocked || 0) ? "danger" : ""}><small>BLOQUEIOS</small><b>{Number(summary.blocked || 0)}</b><span>etapas bloqueadas</span></article>
      <article className={Number(summary.overdue || 0) ? "danger" : ""}><small>ETAPAS ATRASADAS</small><b>{Number(summary.overdue || 0)}</b><span>prazo vencido</span></article>
    </section>

    <section className="oo-toolbar"><div><b>{isAdler && viewMode === "panorama" ? "Visão panorâmica" : "Visão por cliente"}</b><span>{isAdler && viewMode === "panorama" ? "Funil, gargalos, agenda e matriz de avanço de todos os onboardings." : "As três reuniões principais ficam sempre abertas; o fluxo completo pode ser expandido."}</span></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou etapa…" /></section>

    {isAdler && viewMode === "panorama" ? <>
      <section className="oo-panorama-kpis">
        <article className={panorama.overdueClients.length ? "danger" : ""}><small>CLIENTES COM ATRASO</small><b>{panorama.overdueClients.length}</b><span>alguma etapa vencida</span></article>
        <article className={panorama.blockedClients.length ? "danger" : ""}><small>CLIENTES BLOQUEADOS</small><b>{panorama.blockedClients.length}</b><span>exigem destrave</span></article>
        <article><small>COM REUNIÃO AGENDADA</small><b>{panorama.scheduledClients.length}</b><span>qualquer etapa</span></article>
        <article className={panorama.unassigned.length ? "warn" : ""}><small>SEM GT DEFINIDO</small><b>{panorama.unassigned.length}</b><span>atribuição pendente</span></article>
        <article><small>PRÓXIMOS 7 DIAS</small><b>{panorama.upcoming.length}</b><span>reuniões previstas</span></article>
      </section>

      <section className="oo-panorama-block">
        <div className="oo-section-title"><div><span className="oo-kicker">FUNIL DA OPERAÇÃO</span><h2>Onde os clientes estão parando</h2><p>“Agora” mostra quantos clientes têm aquela etapa como etapa atual. Atraso e bloqueio destacam gargalos.</p></div></div>
        <div className="oo-stage-strip">{panorama.stageStats.map((stage: Row) => <article className={`${stage.overdue || stage.blocked ? "attention" : ""}`} key={String(stage.code)}><small>{Number(stage.ordem || 0).toString().padStart(2, "0")}</small><h3>{text(stage.label)}</h3><div className="oo-stage-now"><b>{Number(stage.current || 0)}</b><span>agora</span></div><div className="oo-stage-mini"><span><b>{Number(stage.done || 0)}</b> concluíram</span><span><b>{Number(stage.active || 0)}</b> ativos</span>{Number(stage.overdue || 0) > 0 && <span className="bad"><b>{Number(stage.overdue)}</b> atrasados</span>}{Number(stage.blocked || 0) > 0 && <span className="bad"><b>{Number(stage.blocked)}</b> bloqueados</span>}</div></article>)}</div>
      </section>

      <section className="oo-panorama-split">
        <article className="oo-panel"><div className="oo-panel-head"><div><span className="oo-kicker">ATENÇÃO AGORA</span><h2>Gargalos e exceções</h2></div><strong>{panorama.urgent.length}</strong></div><div className="oo-compact-list">{panorama.urgent.slice(0, 10).map((client: Row) => { const issues=(client.stages||[]).filter((stage:Row)=>stage.overdue||String(stage.status).toUpperCase()==="BLOCKED"); return <button key={String(client.case_id)} onClick={()=>focusClient(client)}><span><b>{text(client.display_name)}</b><small>{text(client.current_stage_label)} · GT {text(client.gt_owner || "não definido")}</small></span><em>{issues.length ? `${issues.length} ponto(s) crítico(s)` : text(client.onboarding_risk)}</em></button>;})}{!panorama.urgent.length && <div className="oo-panel-empty">Nenhum gargalo crítico neste filtro.</div>}</div></article>
        <article className="oo-panel"><div className="oo-panel-head"><div><span className="oo-kicker">AGENDA OPERACIONAL</span><h2>Próximos 7 dias</h2></div><strong>{panorama.upcoming.length}</strong></div><div className="oo-compact-list">{panorama.upcoming.slice(0, 12).map((item: Row) => <button key={`${item.client.case_id}:${item.stage.stage_code}:${item.at}`} onClick={()=>focusClient(item.client)}><span><b>{text(item.client.display_name)}</b><small>{text(item.stage.label)} · {text(item.stage.owner || "Responsável não definido")}</small></span><em>{fmtDateTime(stageMoment(item.stage))}</em></button>)}{!panorama.upcoming.length && <div className="oo-panel-empty">Nenhuma reunião nos próximos 7 dias neste filtro.</div>}</div></article>
      </section>

      <section className="oo-panorama-block">
        <div className="oo-section-title"><div><span className="oo-kicker">MATRIZ EXECUTIVA</span><h2>Cliente × etapa</h2><p>Uma linha por cliente. Clique no nome para abrir a visão detalhada daquele onboarding.</p></div><div className="oo-legend"><span><i className="done">✓</i> concluída</span><span><i className="scheduled">◷</i> agendada</span><span><i className="progress">●</i> andamento</span><span><i className="overdue">!</i> atraso/bloqueio</span><span><i className="pending">·</i> pendente</span></div></div>
        <div className="oo-matrix-wrap"><table className="oo-matrix"><thead><tr><th className="sticky client-col">Cliente</th><th className="sticky gt-col">GT</th>{orderedDefinitions.map((definition: Row)=><th key={String(definition.code)} title={text(definition.label)}><span>{Number(definition.ordem || 0).toString().padStart(2,"0")}</span>{text(definition.label)}</th>)}</tr></thead><tbody>{visible.map((client: Row)=><tr key={String(client.case_id)}><td className="sticky client-col"><button onClick={()=>focusClient(client)}><b>{text(client.display_name)}</b><small>{text(client.current_stage_label)}</small></button></td><td className="sticky gt-col">{text(client.gt_owner || "—")}</td>{orderedDefinitions.map((definition: Row)=>{const stage=stageByCode(client,String(definition.code));const cell=stageCell(stage);const moment=stage?stageMoment(stage):null;return <td key={String(definition.code)} title={`${text(definition.label)} · ${cell.label}${moment?` · ${fmtDateTime(moment)}`:""}`}><span className={`oo-matrix-status ${cell.cls}`}>{cell.symbol}</span></td>;})}</tr>)}{!visible.length&&!loading&&<tr><td colSpan={orderedDefinitions.length+2} className="oo-matrix-empty">Nenhum cliente encontrado neste filtro.</td></tr>}</tbody></table></div>
      </section>
    </> : <section className="oo-list">{visible.map((client: Row) => {
      const isOpen = Boolean(expanded[String(client.case_id)]);
      return <article className="oo-client" key={String(client.case_id)}>
        <div className="oo-client-head"><div><h2>{text(client.display_name)}</h2><p>{client.entrada ? `Cliente desde ${formatDate(client.entrada)}` : "Sem data de entrada"} · GT <b>{text(client.gt_owner || "não definido")}</b> · CS <b>{text(client.cs_owner || "não definido")}</b></p></div><div><Pill value={client.onboarding_risk}/><span className="oo-current">Atual: <b>{text(client.current_stage_label)}</b></span></div></div>

        <div className="oo-meetings">{MEETING_ORDER.map((code) => {
          const stage = stageByCode(client, code) || { stage_code: code, status: "PENDING", owner: code === "INTRO_MEETING" ? "Joel Antoniete" : code === "PRODUCT_PERSONA_MEETING" ? "Gustavo Lima" : client.gt_owner || "GT não definido" };
          const attempt = stage.last_attempt || {};
          return <section className={`oo-meeting ${stage.overdue ? "overdue" : ""}`} key={code}>
            <div className="oo-meeting-title"><div><small>REUNIÃO</small><h3>{MEETING_LABEL[code]}</h3></div><Pill value={stage.status}/></div>
            <p className="owner">Responsável: <b>{text(stage.owner)}</b></p>
            {stage.scheduled_for ? <p className="when">📅 {fmtDateTime(stage.scheduled_for)}</p> : stage.due_at ? <p className="when">Prazo: {fmtDateTime(stage.due_at)}</p> : <p className="when muted">Sem data/hora consolidada</p>}
            {stage.meet_url && <a className="oo-meet" href={String(stage.meet_url)} target="_blank" rel="noreferrer">Entrar no Meet ↗</a>}
            {stage.completed_at && <p className="done-at">Concluída {fmtDateTime(stage.completed_at)}</p>}
            {attempt.retry_required && <p className="retry">↻ Reagendamento necessário{attempt.reason_detail ? ` · ${text(attempt.reason_detail)}` : ""}</p>}
            {stage.notes && <p className="note">{text(stage.notes)}</p>}
          </section>;
        })}</div>

        <div className="oo-next"><span><small>PRÓXIMA AÇÃO</small><b>{text(client.next_action || "Sem próxima ação registrada")}</b>{client.next_action_due && <em>Prazo {fmtDateTime(client.next_action_due)}</em>}</span><button className="secondary" onClick={() => setExpanded((current) => ({ ...current, [String(client.case_id)]: !isOpen }))}>{isOpen ? "Ocultar fluxo completo" : "Ver fluxo completo"}</button></div>

        {isOpen && <div className="oo-flow">{(client.stages || []).map((stage: Row) => <div className={`oo-stage ${stage.overdue ? "overdue" : ""}`} key={String(stage.id)}><div><small>{Number(stage.ordem || 0).toString().padStart(2, "0")}</small><b>{text(stage.label)}</b></div><Pill value={stage.status}/><p>{stage.owner ? `Responsável: ${text(stage.owner)}` : "Etapa automática / sistêmica"}</p>{stage.scheduled_for && <p>Reunião: {fmtDateTime(stage.scheduled_for)}</p>}{stage.due_at && !stage.scheduled_for && <p>Prazo: {fmtDateTime(stage.due_at)}</p>}</div>)}</div>}
      </article>;
    })}{!visible.length && !loading && <div className="oo-empty">Nenhum cliente encontrado neste filtro.</div>}</section>}
  </main>;
}

const styles = `
:root{color-scheme:dark}.oo-shell{min-height:100vh;background:#03101c;color:#eaf3ff;padding:32px;font-family:Inter,system-ui,sans-serif}.oo-loading{min-height:100vh;background:#03101c;color:#dbeafe;display:grid;place-items:center}.oo-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;max-width:1580px;margin:0 auto 22px}.oo-top h1{font:800 34px/1.05 "Inter Tight",Inter,sans-serif;margin:7px 0}.oo-top p{margin:0;color:#8ea9c7}.oo-kicker{font-size:11px;font-weight:800;letter-spacing:.12em;color:#5caeff}.oo-back{border:0;background:transparent;color:#83bfff;padding:0 0 8px;cursor:pointer}.oo-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.oo-actions span{color:#6f8daa;font-size:12px}.oo-actions button,.secondary{border:1px solid #1f4e75;background:#092139;color:#dceeff;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}.secondary{background:#071a2a}.oo-error{max-width:1580px;margin:0 auto 16px;padding:14px 16px;border:1px solid #7f1d1d;background:#2b1017;border-radius:12px;display:flex;gap:12px}.oo-view-switch{max-width:1580px;margin:0 auto 16px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 16px;background:#061827;border:1px solid #174365;border-radius:14px}.oo-view-switch b{display:block}.oo-view-switch span{display:block;color:#7595b3;font-size:12px;margin-top:3px}.oo-segmented{display:flex;padding:4px;background:#03101b;border:1px solid #173b58;border-radius:11px}.oo-segmented button{border:0;background:transparent;color:#7190ad;border-radius:8px;padding:9px 14px;font-weight:800;cursor:pointer}.oo-segmented button.active{background:#0b3655;color:#dff3ff;box-shadow:inset 0 0 0 1px #286b94}.oo-metrics{max-width:1580px;margin:0 auto 18px;display:grid;grid-template-columns:repeat(7,minmax(140px,1fr));gap:10px}.oo-metrics article,.oo-panorama-kpis article{background:#071827;border:1px solid #153958;border-radius:14px;padding:14px}.oo-metrics small,.oo-panorama-kpis small{display:block;color:#6f91b2;font-size:10px;font-weight:800;letter-spacing:.06em}.oo-metrics b,.oo-panorama-kpis b{font-size:28px;display:block;margin:5px 0}.oo-metrics span,.oo-panorama-kpis span{font-size:12px;color:#8ca6bf}.oo-metrics .danger,.oo-panorama-kpis .danger{border-color:#783747;background:#24121b}.oo-panorama-kpis .warn{border-color:#735618;background:#2d220e}.oo-toolbar{max-width:1580px;margin:0 auto 14px;display:flex;align-items:center;justify-content:space-between;gap:18px}.oo-toolbar b{display:block}.oo-toolbar span{display:block;color:#7695b2;font-size:12px;margin-top:3px}.oo-toolbar input{min-width:340px;background:#071827;border:1px solid #174467;color:#eaf3ff;border-radius:10px;padding:11px 13px;outline:none}.oo-list{max-width:1580px;margin:0 auto;display:grid;gap:14px}.oo-client{background:#061522;border:1px solid #153c5a;border-radius:16px;padding:18px}.oo-client-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid #12314a}.oo-client-head h2{margin:0 0 5px;font-size:21px}.oo-client-head p{margin:0;color:#7e9ab5;font-size:13px}.oo-client-head>div:last-child{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.oo-current{font-size:12px;color:#7696b6}.oo-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;background:#122638;color:#87a3bd;border:1px solid #25435d}.oo-pill.ok{background:#082c29;color:#6ee7c2;border-color:#146354}.oo-pill.warn{background:#30230d;color:#f5c96a;border-color:#765619}.oo-pill.bad{background:#32151b;color:#ff9aa8;border-color:#7f3140}.oo-meetings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.oo-meeting{background:#071c2e;border:1px solid #184665;border-radius:13px;padding:14px;min-height:184px}.oo-meeting.overdue{border-color:#7d3644}.oo-meeting-title{display:flex;justify-content:space-between;gap:10px}.oo-meeting-title small{font-size:9px;color:#5d8aac;font-weight:900;letter-spacing:.1em}.oo-meeting-title h3{font-size:15px;margin:3px 0 0}.oo-meeting p{margin:9px 0;font-size:12px;color:#8ba8c3}.oo-meeting .owner b{color:#d9ecff}.oo-meeting .when{font-weight:700;color:#b8d7f2}.oo-meeting .muted{font-weight:500;color:#617d97}.oo-meet{display:inline-block;background:#0d3b59;border:1px solid #286a93;color:#bfe8ff;text-decoration:none;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800}.oo-meeting .retry{color:#ffc36e}.oo-meeting .note{font-size:11px;line-height:1.4;color:#6f8da8}.oo-next{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:14px;padding:13px 14px;background:#071927;border-radius:11px}.oo-next small{display:block;color:#5e85a5;font-size:9px;font-weight:900;letter-spacing:.08em}.oo-next b{display:block;margin-top:3px}.oo-next em{display:block;color:#7996b2;font-size:11px;font-style:normal;margin-top:3px}.oo-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:12px}.oo-stage{background:#061a2a;border:1px solid #123953;border-radius:10px;padding:10px;min-height:105px}.oo-stage.overdue{border-color:#743540}.oo-stage>div{display:flex;gap:7px;align-items:flex-start;margin-bottom:8px}.oo-stage>div small{color:#477697;font-size:9px;font-weight:900}.oo-stage>div b{font-size:11px;line-height:1.25}.oo-stage p{margin:6px 0 0;color:#6687a3;font-size:10px}.oo-empty{padding:28px;text-align:center;color:#7894ad;border:1px dashed #21435d;border-radius:14px}.oo-panorama-kpis{max-width:1580px;margin:0 auto 14px;display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:10px}.oo-panorama-block{max-width:1580px;margin:0 auto 14px;background:#051522;border:1px solid #153d5b;border-radius:16px;padding:16px}.oo-section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:13px}.oo-section-title h2,.oo-panel-head h2{font:800 20px/1.1 "Inter Tight",Inter,sans-serif;margin:4px 0}.oo-section-title p{margin:0;color:#718fab;font-size:12px}.oo-stage-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.oo-stage-strip article{position:relative;background:#071b2b;border:1px solid #17405e;border-radius:12px;padding:12px;min-height:145px}.oo-stage-strip article.attention{border-color:#70404a;background:#20151c}.oo-stage-strip article>small{color:#4e7fa0;font-size:9px;font-weight:900}.oo-stage-strip h3{font-size:12px;line-height:1.25;min-height:30px;margin:5px 0 8px}.oo-stage-now{display:flex;align-items:baseline;gap:6px}.oo-stage-now b{font:800 28px/1 "Inter Tight",Inter,sans-serif}.oo-stage-now span{color:#7999b7;font-size:11px}.oo-stage-mini{display:grid;gap:4px;margin-top:10px;color:#6f8da9;font-size:10px}.oo-stage-mini span{display:flex;gap:4px;align-items:center}.oo-stage-mini span b{color:#d8ebfb;font-size:11px}.oo-stage-mini span.bad,.oo-stage-mini span.bad b{color:#ff9aa8}.oo-panorama-split{max-width:1580px;margin:0 auto 14px;display:grid;grid-template-columns:1fr 1fr;gap:12px}.oo-panel{background:#051522;border:1px solid #153d5b;border-radius:16px;padding:16px;min-width:0}.oo-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px}.oo-panel-head>strong{font:800 28px/1 "Inter Tight",Inter,sans-serif;color:#92cfff}.oo-compact-list{display:grid;gap:7px}.oo-compact-list button{width:100%;border:1px solid #143a56;background:#071a29;color:#eaf3ff;border-radius:10px;padding:10px 11px;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;cursor:pointer}.oo-compact-list button:hover{border-color:#2b719c;background:#0a2134}.oo-compact-list button span{min-width:0}.oo-compact-list button b,.oo-compact-list button small{display:block}.oo-compact-list button small{color:#7190aa;font-size:10px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.oo-compact-list button em{font-style:normal;color:#f3c66c;font-size:10px;font-weight:800;white-space:nowrap}.oo-panel-empty{padding:24px;text-align:center;color:#6f8aa3;border:1px dashed #1d425d;border-radius:10px}.oo-legend{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;color:#6f8ca7;font-size:10px}.oo-legend span{display:flex;align-items:center;gap:5px}.oo-legend i{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-style:normal;font-weight:900}.oo-legend .done,.oo-matrix-status.done{background:#0c382f;color:#75e7c4}.oo-legend .scheduled,.oo-matrix-status.scheduled{background:#3a2b10;color:#ffd071}.oo-legend .progress,.oo-matrix-status.progress{background:#0b3352;color:#76c9ff}.oo-legend .overdue,.oo-matrix-status.overdue,.oo-matrix-status.blocked{background:#421b24;color:#ff98a7}.oo-legend .pending,.oo-matrix-status.pending{background:#142738;color:#6889a5}.oo-matrix-wrap{overflow:auto;border:1px solid #153a56;border-radius:12px;background:#04111d;max-height:62vh}.oo-matrix{border-collapse:separate;border-spacing:0;min-width:1450px;width:100%;font-size:10px}.oo-matrix th,.oo-matrix td{border-right:1px solid #102d43;border-bottom:1px solid #102d43;padding:8px;text-align:center;background:#061827}.oo-matrix th{position:sticky;top:0;z-index:4;background:#0a2032;color:#8fb0cc;font-weight:900;vertical-align:bottom;min-width:78px;max-width:110px}.oo-matrix th>span{display:block;color:#4e7897;font-size:8px;margin-bottom:4px}.oo-matrix .sticky{position:sticky;z-index:5;text-align:left}.oo-matrix th.sticky{z-index:7}.oo-matrix .client-col{left:0;min-width:210px;max-width:210px}.oo-matrix .gt-col{left:210px;min-width:125px;max-width:125px}.oo-matrix td.client-col,.oo-matrix td.gt-col{background:#071b2a}.oo-matrix td.client-col button{border:0;background:transparent;color:#eaf3ff;text-align:left;padding:0;cursor:pointer;width:100%}.oo-matrix td.client-col button b,.oo-matrix td.client-col button small{display:block}.oo-matrix td.client-col button small{margin-top:3px;color:#63839d;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.oo-matrix-status{width:25px;height:25px;border-radius:7px;display:grid;place-items:center;margin:auto;font-weight:900;font-size:12px}.oo-matrix-empty{padding:28px!important;color:#7894ad!important}.oo-matrix tbody tr:hover td:not(.sticky){background:#092033}@media(max-width:1200px){.oo-metrics{grid-template-columns:repeat(4,1fr)}.oo-flow{grid-template-columns:repeat(3,1fr)}.oo-panorama-kpis{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.oo-panorama-split{grid-template-columns:1fr}.oo-section-title{align-items:flex-start;flex-direction:column}.oo-legend{justify-content:flex-start}}@media(max-width:820px){.oo-shell{padding:18px}.oo-top,.oo-toolbar,.oo-client-head,.oo-next,.oo-view-switch{flex-direction:column;align-items:stretch}.oo-actions{justify-content:flex-start}.oo-segmented{width:100%}.oo-segmented button{flex:1}.oo-metrics{grid-template-columns:repeat(2,1fr)}.oo-panorama-kpis{grid-template-columns:repeat(2,1fr)}.oo-meetings{grid-template-columns:1fr}.oo-flow{grid-template-columns:1fr 1fr}.oo-toolbar input{min-width:0;width:100%}}`;
