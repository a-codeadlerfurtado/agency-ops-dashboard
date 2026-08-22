"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatDate, supabase, text } from "../shared";

type Row = Record<string, any>;
type Payload = { profile?: Row; definitions?: Row[]; clients?: Row[]; summary?: Row; generated_at?: string };
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

function fmtDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function statusLabel(value: unknown) { return STATUS_LABEL[String(value || "").toUpperCase()] || text(value); }
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (status === "BLOCKED" || status === "OVERDUE") return "bad";
  if (status === "SCHEDULED" || status === "IN_PROGRESS") return "warn";
  if (["DONE", "SKIPPED", "COMPLETED"].includes(status)) return "ok";
  return "muted";
}
function Pill({ value }: { value: unknown }) { return <span className={`oo-pill ${tone(value)}`}>{statusLabel(value)}</span>; }
function stageByCode(client: Row, code: string) { return (client.stages || []).find((stage: Row) => stage.stage_code === code) || null; }
function meetingSort(client: Row) {
  return Math.min(...MEETING_ORDER.map((code, index) => {
    const stage = stageByCode(client, code);
    return stage && !["DONE", "SKIPPED", "COMPLETED"].includes(String(stage.status)) ? index : 99;
  }), 99);
}

export default function OnboardingOverviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const profile = payload?.profile || {}, summary = payload?.summary || {}, clients = payload?.clients || [];
  const isFocusedCs = ["Gustavo Lima", "Joel Antoniete"].includes(String(profile.person || ""));
  const visible = useMemo(() => clients
    .filter((client: Row) => !query.trim() || [client.display_name, client.gt_owner, client.cs_owner, client.current_stage_label].join(" ").toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")))
    .sort((a: Row, b: Row) => meetingSort(a) - meetingSort(b) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR")), [clients, query]);

  if (!ready) return <main className="oo-loading">Validando sessão…</main>;

  return <main className="oo-shell"><style>{styles}</style>
    <header className="oo-top">
      <div><button className="oo-back" onClick={() => window.location.assign("/")}>← Central de Operações</button><span className="oo-kicker">ONBOARDING · VISÃO GERAL DA OPERAÇÃO</span><h1>Onboarding completo</h1><p>Todos os clientes, todas as reuniões e todas as etapas em uma única visão.</p></div>
      <div className="oo-actions">{isFocusedCs && <button className="secondary" onClick={() => window.location.assign("/onboarding-focus")}>← Minha etapa</button>}<span>{loading ? "Sincronizando…" : `Atualizado ${fmtDateTime(payload?.generated_at)}`}</span><button onClick={load} disabled={loading}>Atualizar</button></div>
    </header>

    {error && <div className="oo-error"><b>Falha</b><span>{error}</span></div>}

    <section className="oo-metrics">
      <article><small>CLIENTES EM ONBOARDING</small><b>{Number(summary.clients || 0)}</b><span>casos abertos</span></article>
      <article><small>1ª APRESENTAÇÃO</small><b>{Number(summary.intro_open || 0)}</b><span>em aberto</span></article>
      <article><small>PRODUTO + PERSONA</small><b>{Number(summary.product_persona_open || 0)}</b><span>em aberto</span></article>
      <article><small>INTEGRAÇÃO COM GT</small><b>{Number(summary.integration_open || 0)}</b><span>em aberto</span></article>
      <article><small>REUNIÕES AGENDADAS</small><b>{Number(summary.meetings_scheduled || 0)}</b><span>com status agendado</span></article>
      <article className={Number(summary.blocked || 0) ? "danger" : ""}><small>BLOQUEIOS</small><b>{Number(summary.blocked || 0)}</b><span>etapas bloqueadas</span></article>
      <article className={Number(summary.overdue || 0) ? "danger" : ""}><small>ETAPAS ATRASADAS</small><b>{Number(summary.overdue || 0)}</b><span>prazo vencido</span></article>
    </section>

    <section className="oo-toolbar"><div><b>Visão por cliente</b><span>As três reuniões principais ficam sempre abertas; o fluxo completo pode ser expandido.</span></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou etapa…" /></section>

    <section className="oo-list">{visible.map((client: Row) => {
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
    })}{!visible.length && !loading && <div className="oo-empty">Nenhum cliente encontrado neste filtro.</div>}</section>
  </main>;
}

const styles = `
:root{color-scheme:dark}.oo-shell{min-height:100vh;background:#03101c;color:#eaf3ff;padding:32px;font-family:Inter,system-ui,sans-serif}.oo-loading{min-height:100vh;background:#03101c;color:#dbeafe;display:grid;place-items:center}.oo-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;max-width:1580px;margin:0 auto 22px}.oo-top h1{font:800 34px/1.05 "Inter Tight",Inter,sans-serif;margin:7px 0}.oo-top p{margin:0;color:#8ea9c7}.oo-kicker{font-size:11px;font-weight:800;letter-spacing:.12em;color:#5caeff}.oo-back{border:0;background:transparent;color:#83bfff;padding:0 0 8px;cursor:pointer}.oo-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.oo-actions span{color:#6f8daa;font-size:12px}.oo-actions button,.secondary{border:1px solid #1f4e75;background:#092139;color:#dceeff;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}.secondary{background:#071a2a}.oo-error{max-width:1580px;margin:0 auto 16px;padding:14px 16px;border:1px solid #7f1d1d;background:#2b1017;border-radius:12px;display:flex;gap:12px}.oo-metrics{max-width:1580px;margin:0 auto 18px;display:grid;grid-template-columns:repeat(7,minmax(140px,1fr));gap:10px}.oo-metrics article{background:#071827;border:1px solid #153958;border-radius:14px;padding:14px}.oo-metrics small{display:block;color:#6f91b2;font-size:10px;font-weight:800;letter-spacing:.06em}.oo-metrics b{font-size:28px;display:block;margin:5px 0}.oo-metrics span{font-size:12px;color:#8ca6bf}.oo-metrics .danger{border-color:#783747;background:#24121b}.oo-toolbar{max-width:1580px;margin:0 auto 14px;display:flex;align-items:center;justify-content:space-between;gap:18px}.oo-toolbar b{display:block}.oo-toolbar span{display:block;color:#7695b2;font-size:12px;margin-top:3px}.oo-toolbar input{min-width:340px;background:#071827;border:1px solid #174467;color:#eaf3ff;border-radius:10px;padding:11px 13px;outline:none}.oo-list{max-width:1580px;margin:0 auto;display:grid;gap:14px}.oo-client{background:#061522;border:1px solid #153c5a;border-radius:16px;padding:18px}.oo-client-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid #12314a}.oo-client-head h2{margin:0 0 5px;font-size:21px}.oo-client-head p{margin:0;color:#7e9ab5;font-size:13px}.oo-client-head>div:last-child{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.oo-current{font-size:12px;color:#7696b6}.oo-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;background:#122638;color:#87a3bd;border:1px solid #25435d}.oo-pill.ok{background:#082c29;color:#6ee7c2;border-color:#146354}.oo-pill.warn{background:#30230d;color:#f5c96a;border-color:#765619}.oo-pill.bad{background:#32151b;color:#ff9aa8;border-color:#7f3140}.oo-meetings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.oo-meeting{background:#071c2e;border:1px solid #184665;border-radius:13px;padding:14px;min-height:184px}.oo-meeting.overdue{border-color:#7d3644}.oo-meeting-title{display:flex;justify-content:space-between;gap:10px}.oo-meeting-title small{font-size:9px;color:#5d8aac;font-weight:900;letter-spacing:.1em}.oo-meeting-title h3{font-size:15px;margin:3px 0 0}.oo-meeting p{margin:9px 0;font-size:12px;color:#8ba8c3}.oo-meeting .owner b{color:#d9ecff}.oo-meeting .when{font-weight:700;color:#b8d7f2}.oo-meeting .muted{font-weight:500;color:#617d97}.oo-meet{display:inline-block;background:#0d3b59;border:1px solid #286a93;color:#bfe8ff;text-decoration:none;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800}.oo-meeting .retry{color:#ffc36e}.oo-meeting .note{font-size:11px;line-height:1.4;color:#6f8da8}.oo-next{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:14px;padding:13px 14px;background:#071927;border-radius:11px}.oo-next small{display:block;color:#5e85a5;font-size:9px;font-weight:900;letter-spacing:.08em}.oo-next b{display:block;margin-top:3px}.oo-next em{display:block;color:#7996b2;font-size:11px;font-style:normal;margin-top:3px}.oo-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:12px}.oo-stage{background:#061a2a;border:1px solid #123953;border-radius:10px;padding:10px;min-height:105px}.oo-stage.overdue{border-color:#743540}.oo-stage>div{display:flex;gap:7px;align-items:flex-start;margin-bottom:8px}.oo-stage>div small{color:#477697;font-size:9px;font-weight:900}.oo-stage>div b{font-size:11px;line-height:1.25}.oo-stage p{margin:6px 0 0;color:#6687a3;font-size:10px}.oo-empty{padding:28px;text-align:center;color:#7894ad;border:1px dashed #21435d;border-radius:14px}@media(max-width:1200px){.oo-metrics{grid-template-columns:repeat(4,1fr)}.oo-flow{grid-template-columns:repeat(3,1fr)}}@media(max-width:820px){.oo-shell{padding:18px}.oo-top,.oo-toolbar,.oo-client-head,.oo-next{flex-direction:column;align-items:stretch}.oo-actions{justify-content:flex-start}.oo-metrics{grid-template-columns:repeat(2,1fr)}.oo-meetings{grid-template-columns:1fr}.oo-flow{grid-template-columns:1fr 1fr}.oo-toolbar input{min-width:0;width:100%}}`;
