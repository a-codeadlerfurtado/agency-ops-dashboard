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
  INTRO_MEETING: "1ª apresentação",
  PRODUCT_PERSONA_MEETING: "Produto + Persona",
  INTEGRATION_MEETING: "Integração GT",
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente", SCHEDULED: "Agendada", IN_PROGRESS: "Em andamento", DONE: "Concluída",
  SKIPPED: "Superada", BLOCKED: "Bloqueada", COMPLETED: "Concluída", OK: "OK",
  ATTENTION: "Atenção", HIGH: "Alta", CRITICAL: "Crítica",
};
const DONE = new Set(["DONE", "SKIPPED", "COMPLETED"]);

const PANORAMA_LANES = [
  { key: "INTRO", label: "1ª apresentação", help: "Cliente ainda está na primeira reunião ou aguardando a conclusão dessa etapa." },
  { key: "PRODUCT", label: "Produto + Persona", help: "Segunda reunião, formulários e definição de produto/persona." },
  { key: "INPUTS", label: "Insumos e materiais", help: "Formulários, persona e materiais necessários para a operação avançar." },
  { key: "INTEGRATION", label: "Integração com GT", help: "Reunião do gestor, acessos, contas e validações técnicas." },
  { key: "CREATIVE", label: "Produção e aprovação", help: "Criativos em produção, revisão ou aguardando aprovação." },
  { key: "LAUNCH", label: "Pronto para campanha", help: "Tudo preparado para publicação ou campanha entrando no ar." },
  { key: "BLOCKED", label: "Bloqueados / críticos", help: "Existe bloqueio, atraso relevante ou risco crítico exigindo ação." },
] as const;

function fmtDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function statusLabel(value: unknown) { return STATUS_LABEL[String(value || "").toUpperCase()] || text(value).replaceAll("_", " "); }
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (["BLOCKED", "CRITICAL", "OVERDUE"].includes(status)) return "bad";
  if (["SCHEDULED", "IN_PROGRESS", "ATTENTION", "HIGH"].includes(status)) return "warn";
  if (["DONE", "SKIPPED", "COMPLETED", "OK"].includes(status)) return "ok";
  return "muted";
}
function Pill({ value }: { value: unknown }) { return <span className={`oo-pill ${tone(value)}`}>{statusLabel(value)}</span>; }
function stageByCode(client: Row, code: string) { return (client.stages || []).find((stage: Row) => stage.stage_code === code) || null; }
function meetingSort(client: Row) {
  return Math.min(...MEETING_ORDER.map((code, index) => {
    const stage = stageByCode(client, code);
    return stage && !DONE.has(String(stage.status).toUpperCase()) ? index : 99;
  }), 99);
}
function currentStage(client: Row) { return stageByCode(client, String(client.current_stage || "")); }
function currentIsBlocked(client: Row) {
  return String(client.onboarding_risk || "").toUpperCase() === "CRITICAL"
    || (client.stages || []).some((stage: Row) => String(stage.status || "").toUpperCase() === "BLOCKED" || Boolean(stage.overdue));
}
function panoramaLane(client: Row) {
  if (currentIsBlocked(client)) return "BLOCKED";
  const stage = String(client.current_stage || "");
  if (["SALES_CONFIRMED", "OPERATIONAL_ACTIVATION", "INTRO_MEETING"].includes(stage)) return "INTRO";
  if (["PRODUCT_PERSONA_MEETING", "PRODUCT_FORM", "PERSONA_FORM"].includes(stage)) return "PRODUCT";
  if (["RAW_ASSETS"].includes(stage)) return "INPUTS";
  if (["INTEGRATION_MEETING", "ACCESS_VALIDATION"].includes(stage)) return "INTEGRATION";
  if (["CREATIVE_PRODUCTION", "CREATIVE_APPROVAL"].includes(stage)) return "CREATIVE";
  if (["READY_TO_LAUNCH", "CAMPAIGN_LAUNCH"].includes(stage)) return "LAUNCH";
  return "INTRO";
}
function currentMeet(client: Row) {
  for (const code of MEETING_ORDER) {
    const stage = stageByCode(client, code);
    if (stage && String(stage.status).toUpperCase() === "SCHEDULED") return stage;
  }
  return null;
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

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [session?.access_token, load]);

  const profile = payload?.profile || {}, summary = payload?.summary || {}, clients = payload?.clients || [];
  const isFocusedCs = ["Gustavo Lima", "Joel Antoniete"].includes(String(profile.person || ""));
  const isAdler = Boolean(profile.is_adler) || String(profile.person || "") === "Adler Furtado";
  const filteredClients = useMemo(() => clients.filter((client: Row) => !query.trim() || [client.display_name, client.gt_owner, client.cs_owner, client.current_stage_label].join(" ").toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR"))), [clients, query]);
  const visible = useMemo(() => [...filteredClients].sort((a: Row, b: Row) => meetingSort(a) - meetingSort(b) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR")), [filteredClients]);
  const panoramaGroups = useMemo(() => PANORAMA_LANES.map((lane) => [lane, filteredClients.filter((client: Row) => panoramaLane(client) === lane.key).sort((a: Row, b: Row) => String(a.display_name).localeCompare(String(b.display_name), "pt-BR"))] as const), [filteredClients]);
  const panoramaStats = useMemo(() => ({
    total: filteredClients.length,
    withoutGt: filteredClients.filter((client: Row) => !String(client.gt_owner || "").trim()).length,
    scheduled: filteredClients.filter((client: Row) => Boolean(currentMeet(client))).length,
    overdue: filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => Boolean(stage.overdue))).length,
    blocked: filteredClients.filter((client: Row) => (client.stages || []).some((stage: Row) => String(stage.status).toUpperCase() === "BLOCKED")).length,
    attention: filteredClients.filter((client: Row) => ["ATTENTION", "HIGH", "CRITICAL"].includes(String(client.onboarding_risk || "").toUpperCase())).length,
  }), [filteredClients]);

  function focusClient(client: Row) {
    setQuery(String(client.display_name || ""));
    setViewMode("client");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!ready) return <main className="oo-loading">Validando sessão…</main>;

  return <main className="oo-shell"><style>{styles}</style>
    <header className="oo-top">
      <div><button className="oo-back" onClick={() => window.location.assign("/")}>← Central de Operações</button><span className="oo-kicker">ONBOARDING · VISÃO GERAL DA OPERAÇÃO</span><h1>Onboarding completo</h1><p>{isAdler ? "Acompanhe cliente por cliente ou enxergue toda a operação no mesmo estilo do quadro dos gestores de tráfego." : "Todos os clientes, todas as reuniões e todas as etapas em uma única visão."}</p></div>
      <div className="oo-actions">{isFocusedCs && <button className="secondary" onClick={() => window.location.assign("/onboarding-focus")}>← Minha etapa</button>}<span>{loading ? "Sincronizando…" : `Atualizado ${fmtDateTime(payload?.generated_at)}`}</span><button onClick={load} disabled={loading}>Atualizar</button></div>
    </header>

    {error && <div className="oo-error"><b>Falha</b><span>{error}</span></div>}

    {isAdler && <section className="oo-view-switch"><div><b>Visualização do onboarding</b><span>A visão por cliente continua igual. A panorâmica usa o mesmo formato operacional de colunas e cards da tela dos GTs.</span></div><div className="oo-segmented"><button className={viewMode === "client" ? "active" : ""} onClick={() => setViewMode("client")}>Por cliente</button><button className={viewMode === "panorama" ? "active" : ""} onClick={() => setViewMode("panorama")}>Panorâmica</button></div></section>}

    {isAdler && viewMode === "panorama" ? <>
      <section className="op-source"><b>Visão panorâmica</b><span>Cada card é um cliente. Ele aparece na fase em que está agora. Bloqueios, atrasos e riscos críticos são puxados para a coluna de atenção.</span></section>
      <section className="op-metrics">
        <article><small>EM ONBOARDING</small><b>{panoramaStats.total}</b><span>clientes</span></article>
        <article><small>SEM GT DEFINIDO</small><b>{panoramaStats.withoutGt}</b><span>atribuição pendente</span></article>
        <article><small>REUNIÃO AGENDADA</small><b>{panoramaStats.scheduled}</b><span>com data/hora</span></article>
        <article className={panoramaStats.overdue ? "danger" : ""}><small>COM ATRASO</small><b>{panoramaStats.overdue}</b><span>prazo vencido</span></article>
        <article className={panoramaStats.blocked ? "danger" : ""}><small>BLOQUEADOS</small><b>{panoramaStats.blocked}</b><span>exigem ação</span></article>
        <article className={panoramaStats.attention ? "warn" : ""}><small>EM ATENÇÃO</small><b>{panoramaStats.attention}</b><span>risco elevado</span></article>
      </section>
      <section className="oo-toolbar op-toolbar"><div><b>Quadro operacional completo</b><span>Todos os clientes, todos os GTs e todas as fases do onboarding no mesmo padrão visual da tela dos gestores.</span></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou etapa…" /></section>
      <section className="op-board">{panoramaGroups.map(([lane, items]) => <article className={`op-lane ${lane.key === "BLOCKED" ? "danger" : ""}`} key={lane.key}>
        <div className="op-lane-head"><div><h2>{lane.label}</h2><p>{lane.help}</p></div><strong>{items.length}</strong></div>
        <div className="op-cards">{items.map((client: Row) => {
          const stage = currentStage(client);
          const meet = currentMeet(client);
          const due = client.next_action_due || stage?.scheduled_for || stage?.due_at;
          return <div className="op-card" key={String(client.case_id)}>
            <div className="op-card-top"><div><h3>{text(client.display_name)}</h3><span>GT {text(client.gt_owner || "não definido")} · CS {text(client.cs_owner || "não definido")}</span></div><Pill value={client.onboarding_risk || "OK"}/></div>
            <div className={`op-when ${stage?.overdue ? "bad" : ""}`}>{meet ? `Reunião: ${fmtDateTime(meet.scheduled_for || meet.due_at)}` : due ? `Próximo prazo: ${fmtDateTime(due)}` : "Sem data/hora consolidada"}</div>
            {meet?.meet_url && <a className="op-meet" href={String(meet.meet_url)} target="_blank" rel="noreferrer">↗ Entrar no Meet</a>}
            <div className="op-status-row">{MEETING_ORDER.map((code) => { const meeting = stageByCode(client, code); return <span key={code}>{MEETING_LABEL[code]} <Pill value={meeting?.status || "PENDING"}/></span>; })}</div>
            <div className="op-current"><small>ETAPA ATUAL</small><b>{text(client.current_stage_label || client.current_stage)}</b>{stage?.owner && <span>Responsável: {text(stage.owner)}</span>}</div>
            <p>{text(client.next_action || "Acompanhar a próxima etapa do onboarding.")}</p>
            <div className="op-card-foot"><small>Entrada: {client.entrada ? formatDate(client.entrada) : "—"}</small><button onClick={() => focusClient(client)}>Abrir cliente →</button></div>
          </div>;
        })}{!items.length && <div className="op-empty">Nenhum cliente nesta fase.</div>}</div>
      </article>)}</section>
    </> : <>
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
    </>}
  </main>;
}

const styles = `
:root{color-scheme:dark}.oo-shell{min-height:100vh;background:#04101c;color:#edf6ff;padding:34px clamp(18px,4vw,58px) 60px;font-family:Inter,system-ui,sans-serif}.oo-loading{min-height:100vh;background:#04101c;color:#b8cee1;display:grid;place-items:center}.oo-top{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;max-width:1500px;margin:0 auto 22px}.oo-top h1{font-family:'Inter Tight',Inter,sans-serif;font-size:clamp(30px,4vw,48px);letter-spacing:-.04em;margin:7px 0}.oo-top p{margin:0;color:#8faac2}.oo-kicker{display:block;color:#398fd8;font-size:10px;font-weight:800;letter-spacing:.16em}.oo-back{border:0;background:transparent;color:#78b8f0;padding:0;margin-bottom:16px;cursor:pointer;font-weight:700}.oo-actions{display:flex;align-items:center;gap:10px}.oo-actions>span{font-size:12px;color:#6edbb5}.oo-actions button,.secondary{border:1px solid #234563;background:#09243a;color:#eaf6ff;border-radius:9px;padding:9px 13px;cursor:pointer;font-weight:800}.secondary{background:#071a2a}.oo-error{max-width:1500px;margin:0 auto 18px;border:1px solid #6a2f3a;background:#2a1118;color:#ffc2cb;border-radius:12px;padding:12px 15px;display:flex;gap:10px}.oo-view-switch{max-width:1500px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 16px;background:#071a2b;border:1px solid #153550;border-radius:12px}.oo-view-switch b{display:block}.oo-view-switch span{display:block;color:#8faac2;font-size:12px;margin-top:3px}.oo-segmented{display:flex;padding:4px;background:#03101b;border:1px solid #173b58;border-radius:11px}.oo-segmented button{border:0;background:transparent;color:#7190ad;border-radius:8px;padding:9px 14px;font-weight:800;cursor:pointer}.oo-segmented button.active{background:#0b3655;color:#dff3ff;box-shadow:inset 0 0 0 1px #286b94}.oo-metrics{max-width:1500px;margin:0 auto 22px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px}.oo-metrics article{border:1px solid #153550;background:#071725;border-radius:12px;padding:14px}.oo-metrics article.danger{border-color:#66313b;background:#221117}.oo-metrics small{display:block;color:#6e91ad;font-size:9px;font-weight:800;letter-spacing:.1em}.oo-metrics b{display:block;font-size:28px;margin:7px 0 0}.oo-metrics span{font-size:11px;color:#7896ae}.oo-toolbar{max-width:1500px;margin:0 auto 14px;display:flex;align-items:center;justify-content:space-between;gap:18px}.oo-toolbar b{display:block}.oo-toolbar span{display:block;color:#7695b2;font-size:12px;margin-top:3px}.oo-toolbar input{min-width:340px;background:#071827;border:1px solid #174467;color:#eaf3ff;border-radius:10px;padding:11px 13px;outline:none}.oo-list{max-width:1500px;margin:0 auto;display:grid;gap:14px}.oo-client{background:#061522;border:1px solid #153c5a;border-radius:16px;padding:18px}.oo-client-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid #12314a}.oo-client-head h2{margin:0 0 5px;font-size:21px}.oo-client-head p{margin:0;color:#7e9ab5;font-size:13px}.oo-client-head>div:last-child{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.oo-current{font-size:12px;color:#7696b6}.oo-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;background:#0c2132;color:#92aec5;border:1px solid #284359}.oo-pill.ok{background:#0a2a24;color:#79dfbc;border-color:#1b5b4a}.oo-pill.warn{background:#2a2412;color:#efcd78;border-color:#665329}.oo-pill.bad{background:#2d151b;color:#f2a7b2;border-color:#66313b}.oo-meetings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.oo-meeting{background:#071c2e;border:1px solid #184665;border-radius:13px;padding:14px;min-height:184px}.oo-meeting.overdue{border-color:#7d3644}.oo-meeting-title{display:flex;justify-content:space-between;gap:10px}.oo-meeting-title small{font-size:9px;color:#5d8aac;font-weight:900;letter-spacing:.1em}.oo-meeting-title h3{font-size:15px;margin:3px 0 0}.oo-meeting p{margin:9px 0;font-size:12px;color:#8ba8c3}.oo-meeting .owner b{color:#d9ecff}.oo-meeting .when{font-weight:700;color:#b8d7f2}.oo-meeting .muted{font-weight:500;color:#617d97}.oo-meet{display:inline-block;background:#0d3b59;border:1px solid #286a93;color:#bfe8ff;text-decoration:none;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800}.oo-meeting .retry{color:#ffc36e}.oo-meeting .note{font-size:11px;line-height:1.4;color:#6f8da8}.oo-next{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:14px;padding:13px 14px;background:#071927;border-radius:11px}.oo-next small{display:block;color:#5e85a5;font-size:9px;font-weight:900;letter-spacing:.08em}.oo-next b{display:block;margin-top:3px}.oo-next em{display:block;color:#7996b2;font-size:11px;font-style:normal;margin-top:3px}.oo-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:12px}.oo-stage{background:#061a2a;border:1px solid #123953;border-radius:10px;padding:10px;min-height:105px}.oo-stage.overdue{border-color:#743540}.oo-stage>div{display:flex;gap:7px;align-items:flex-start;margin-bottom:8px}.oo-stage>div small{color:#477697;font-size:9px;font-weight:900}.oo-stage>div b{font-size:11px;line-height:1.25}.oo-stage p{margin:6px 0 0;color:#6687a3;font-size:10px}.oo-empty{padding:28px;text-align:center;color:#7894ad;border:1px dashed #21435d;border-radius:14px}
.op-source{max-width:1500px;margin:0 auto 18px;border:1px solid #153550;background:#071a2b;border-radius:12px;padding:12px 15px;display:flex;gap:10px;align-items:flex-start;font-size:12px}.op-source b{white-space:nowrap}.op-source span{color:#8faac2}.op-metrics{max-width:1500px;margin:0 auto 22px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.op-metrics article{border:1px solid #153550;background:#071725;border-radius:12px;padding:14px}.op-metrics article.warn{border-color:#665329;background:#19170d}.op-metrics article.danger{border-color:#66313b;background:#221117}.op-metrics small{display:block;color:#6e91ad;font-size:9px;font-weight:800;letter-spacing:.1em}.op-metrics b{display:block;font-size:28px;margin:7px 0 0}.op-metrics span{font-size:11px;color:#7896ae}.op-toolbar{margin-bottom:12px}.op-board{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:repeat(7,minmax(205px,1fr));gap:11px;align-items:start}.op-lane{border:1px solid #12314a;background:#061522;border-radius:14px;overflow:hidden}.op-lane.danger{border-color:#5a2935}.op-lane-head{padding:14px;border-bottom:1px solid #12314a;display:flex;justify-content:space-between;gap:10px;min-height:104px}.op-lane.danger .op-lane-head{border-bottom-color:#5a2935;background:#160e14}.op-lane-head h2{font-size:13px;margin:0 0 5px}.op-lane-head p{font-size:10px;line-height:1.45;color:#6f90aa;margin:0}.op-lane-head>strong{font-size:19px;color:#7ebdf1}.op-lane.danger .op-lane-head>strong{color:#f2a7b2}.op-cards{display:grid;gap:9px;padding:10px}.op-card{border:1px solid #173851;background:#081a29;border-radius:11px;padding:12px}.op-card-top{display:flex;justify-content:space-between;gap:8px}.op-card h3{font-size:13px;margin:0 0 4px}.op-card-top span{font-size:9.5px;color:#7595af}.op-when{margin:11px 0 9px;border-left:2px solid #418dc7;padding-left:8px;color:#d7ebfc;font-size:11px;font-weight:700}.op-when.bad{border-left-color:#bb4e60;color:#ffafb9}.op-meet{display:flex;align-items:center;justify-content:center;text-decoration:none;border:1px solid #247a61;background:#0c3a30;color:#a7f3d0;border-radius:9px;padding:9px 10px;font-size:10.5px;font-weight:800;margin-bottom:10px}.op-status-row{display:grid;gap:5px;margin-bottom:9px}.op-status-row>span{font-size:9px;color:#708ea6;display:flex;align-items:center;justify-content:space-between;gap:5px}.op-current{border:1px solid #26445c;background:#071725;border-radius:9px;padding:9px;margin:9px 0;display:grid;gap:3px}.op-current small{font-size:8px;color:#607f95;letter-spacing:.08em;font-weight:800}.op-current b{font-size:10.5px;color:#d7ebfc}.op-current span{font-size:9px;color:#728ca0}.op-card>p{font-size:10.5px;line-height:1.45;color:#9bb2c6;margin:8px 0}.op-card-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}.op-card-foot small{font-size:9px;color:#647f97}.op-card-foot button{border:0;background:transparent;color:#78b8f0;font-size:9px;font-weight:800;cursor:pointer;padding:2px}.op-empty{padding:18px 10px;text-align:center;color:#58758d;font-size:10px}
@media(max-width:1500px){.op-board{grid-template-columns:repeat(4,minmax(240px,1fr))}.oo-metrics{grid-template-columns:repeat(4,1fr)}}@media(max-width:1200px){.op-board{grid-template-columns:repeat(3,minmax(260px,1fr))}.op-metrics{grid-template-columns:repeat(3,1fr)}.oo-flow{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.op-board{grid-template-columns:repeat(2,minmax(260px,1fr))}}@media(max-width:760px){.oo-shell{padding:22px 14px 40px}.oo-top,.oo-toolbar,.oo-client-head,.oo-next,.oo-view-switch{align-items:flex-start;flex-direction:column}.oo-actions{width:100%;justify-content:space-between}.oo-segmented{width:100%}.oo-segmented button{flex:1}.oo-metrics,.op-metrics{grid-template-columns:repeat(2,1fr)}.op-board{grid-template-columns:1fr}.oo-meetings{grid-template-columns:1fr}.oo-flow{grid-template-columns:1fr 1fr}.oo-toolbar input{min-width:0;width:100%}.op-source{display:grid}}
`;