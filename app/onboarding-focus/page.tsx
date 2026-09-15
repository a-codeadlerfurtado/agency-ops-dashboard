"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_ANON_KEY, SUPABASE_URL, formatDate, supabase, text } from "../shared";

type Row = Record<string, any>;
type Payload = { profile?: Row; items?: Row[]; summary?: Row; generated_at?: string };
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-focus-api`;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  SCHEDULED: "Agendada",
  IN_PROGRESS: "Em andamento",
  DONE: "Concluída",
  SKIPPED: "Superada",
  BLOCKED: "Bloqueada",
};

function fmtDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function statusLabel(value: unknown) {
  return STATUS_LABEL[String(value || "").toUpperCase()] || text(value);
}
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (status === "BLOCKED") return "bad";
  if (status === "SCHEDULED" || status === "IN_PROGRESS") return "warn";
  if (status === "DONE") return "ok";
  return "muted";
}
function StagePill({ value }: { value: unknown }) {
  return <span className={`of-pill ${tone(value)}`}>{statusLabel(value)}</span>;
}
function bucket(row: Row) {
  if (row.waiting_previous_stage) return "WAITING_PREVIOUS";
  if (row.stage_status === "BLOCKED") return "BLOCKED";
  if (row.stage_status === "SCHEDULED") return "SCHEDULED";
  if (row.stage_status === "IN_PROGRESS") return "IN_PROGRESS";
  if (["DONE", "SKIPPED"].includes(String(row.stage_status))) return "COMPLETED";
  return "ACTION";
}

export default function OnboardingFocusPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      if (!body.profile?.focus_stage) { window.location.replace("/onboarding?view=all"); return; }
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar sua etapa do onboarding.");
    } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [session?.access_token, load]);

  const profile = payload?.profile || {};
  const summary = payload?.summary || {};
  const isGustavo = profile.person === "Gustavo Lima";
  const items = payload?.items || [];
  const groups = useMemo(() => {
    const order = ["ACTION", "SCHEDULED", "IN_PROGRESS", "BLOCKED", "WAITING_PREVIOUS", "COMPLETED"];
    const labels: Record<string, [string, string]> = {
      ACTION: ["Precisa de ação", "Clientes cuja etapa está liberada e ainda precisa ser conduzida."],
      SCHEDULED: ["Reuniões agendadas", "Compromissos já identificados como agendados."],
      IN_PROGRESS: ["Em andamento", "Etapa iniciada e ainda não concluída."],
      BLOCKED: ["Bloqueados", "Algo impede a conclusão desta etapa."],
      WAITING_PREVIOUS: ["Aguardando etapa anterior", "Ainda não chegou a vez desta reunião no fluxo."],
      COMPLETED: ["Concluídos / superados", "Etapa já concluída ou superada por progressão do onboarding."],
    };
    const map = new Map<string, Row[]>();
    items.forEach((row) => { const key = bucket(row); map.set(key, [...(map.get(key) || []), row]); });
    return order.map((key) => ({ key, label: labels[key][0], help: labels[key][1], rows: map.get(key) || [] }))
      .filter((group) => group.key !== "COMPLETED" || showCompleted);
  }, [items, showCompleted]);

  if (!ready) return <main className="of-loading">Validando sessão…</main>;

  return <main className="of-shell"><style>{styles}</style>
    <header className="of-top">
      <button className="of-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
      <div className="of-brand"><span><BrandMark /></span><div><small>ONBOARDING · SUA RESPONSABILIDADE</small><h1>{text(profile.focus_label || "Minha etapa")}</h1><p>{text(profile.focus_description)}</p></div></div>
      <div className="of-actions">
        <button className="of-secondary" onClick={() => window.location.assign("/onboarding?view=all")}>Visão geral do onboarding</button>
        <button onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
      </div>
    </header>

    <section className="of-person"><div><b>{text(profile.person)}</b><span>{isGustavo ? "Sua tela abre primeiro nas reuniões de Produto + Persona. Você pode alternar para a visão completa para acompanhar e cobrar toda a equipe." : "Sua tela abre primeiro na 1ª reunião de apresentação. Você pode alternar para a visão completa para acompanhar e cobrar toda a equipe."}</span></div><small>{payload?.generated_at ? `Atualizado ${fmtDateTime(payload.generated_at)}` : ""}</small></section>

    {error && <div className="of-error">{error}</div>}

    <section className={`of-metrics ${isGustavo ? "with-forms" : ""}`}>
      <article><small>TOTAL EM ONBOARDING</small><b>{Number(summary.total || 0)}</b><span>casos abertos</span></article>
      <article><small>PRECISAM DE AÇÃO</small><b>{Number(summary.action || 0)}</b><span>na sua etapa</span></article>
      <article><small>AGENDADAS</small><b>{Number(summary.scheduled || 0)}</b><span>reuniões</span></article>
      <article><small>EM ANDAMENTO</small><b>{Number(summary.in_progress || 0)}</b><span>agora</span></article>
      <article><small>CONCLUÍDAS</small><b>{Number(summary.completed || 0)}</b><span>ou superadas</span></article>
      {isGustavo && <><article><small>FORM. PRODUTO</small><b>{Number(summary.product_forms_done || 0)}</b><span>concluídos</span></article><article><small>FORM. PERSONA</small><b>{Number(summary.persona_forms_done || 0)}</b><span>concluídos</span></article></>}
    </section>

    <div className="of-toolbar"><div><b>Minha fila</b><span>{items.length} clientes acompanhados nesta etapa</span></div><button className="of-secondary" onClick={() => setShowCompleted((value) => !value)}>{showCompleted ? "Ocultar concluídos" : "Mostrar concluídos"}</button></div>

    <section className="of-board">
      {groups.map((group) => <article className={`of-lane lane-${group.key.toLowerCase()}`} key={group.key}>
        <div className="of-lane-head"><div><h2>{group.label}</h2><p>{group.help}</p></div><strong>{group.rows.length}</strong></div>
        <div className="of-cards">{group.rows.map((row) => <div className="of-card" key={String(row.case_id)}>
          <div className="of-card-head"><div><h3>{text(row.display_name)}</h3><span>{row.entrada ? `Cliente desde ${formatDate(row.entrada)}` : "Sem data de entrada"}</span></div><StagePill value={row.stage_status}/></div>
          <div className="of-current"><small>ETAPA ATUAL DO ONBOARDING</small><b>{text(row.current_stage_label)}</b></div>
          {row.scheduled_for && <div className="of-meeting"><b>Reunião: {fmtDateTime(row.scheduled_for)}</b>{row.meet_url && <a href={String(row.meet_url)} target="_blank" rel="noreferrer">Entrar no Meet ↗</a>}</div>}
          {!row.scheduled_for && row.stage_status === "SCHEDULED" && <div className="of-note">Reunião marcada, mas sem data/hora consolidada na fonte.</div>}
          {row.waiting_previous_stage && <div className="of-note">Aguardando: {text(row.current_stage_label)}.</div>}
          {row.stage_blocked_type && <div className="of-note danger">Bloqueio: {text(row.stage_blocked_type)}</div>}
          {row.stage_notes && <p className="of-notes">{text(row.stage_notes)}</p>}
          {isGustavo && <div className="of-forms"><span>Produto <StagePill value={row.product_form_status}/></span><span>Persona <StagePill value={row.persona_form_status}/></span></div>}
          <div className="of-owners"><span>CS <b>{text(row.cs_owner)}</b></span><span>GT <b>{text(row.gt_owner)}</b></span></div>
          <div className="of-next"><small>PRÓXIMA AÇÃO GERAL</small><b>{text(row.next_action || "Sem próxima ação registrada")}</b>{row.next_action_due && <span>Prazo {fmtDateTime(row.next_action_due)}</span>}</div>
        </div>)}{!group.rows.length && <div className="of-empty">Nenhum cliente nesta situação.</div>}</div>
      </article>)}
    </section>
  </main>;
}

const styles = `
:root{color-scheme:dark}.of-shell{min-height:100vh;background:#071211;color:#e8f2ef;padding:28px clamp(18px,3vw,42px) 70px;font-family:Inter,system-ui,sans-serif}.of-loading{min-height:100vh;display:grid;place-items:center;background:#071211;color:#dbe7e3}.of-top{display:grid;grid-template-columns:auto 1fr auto;gap:22px;align-items:center;max-width:1500px;margin:0 auto 18px}.of-back,.of-actions button,.of-toolbar button{border:1px solid rgba(148,163,184,.18);background:rgba(12,29,27,.82);color:#dce9e5;border-radius:10px;padding:10px 13px;cursor:pointer}.of-brand{display:flex;gap:14px;align-items:center}.of-brand>span{width:44px;height:44px;display:grid;place-items:center}.of-brand small{font-size:10px;letter-spacing:.14em;color:#6dd7a3;font-weight:800}.of-brand h1{font-family:'Inter Tight',Inter,sans-serif;font-size:30px;margin:2px 0 4px}.of-brand p{margin:0;color:#91a8a1;max-width:760px;font-size:12px}.of-actions{display:flex;gap:8px}.of-actions button:not(.of-secondary){background:#dcebe5;color:#09211a;font-weight:800}.of-secondary{background:rgba(18,46,42,.72)!important}.of-person,.of-toolbar{max-width:1500px;margin:0 auto 14px;border:1px solid rgba(109,215,163,.17);background:rgba(11,31,28,.72);border-radius:14px;padding:13px 15px;display:flex;justify-content:space-between;gap:16px;align-items:center}.of-person div{display:flex;gap:12px;align-items:center}.of-person b{color:#78dda9}.of-person span,.of-person small,.of-toolbar span{font-size:11px;color:#91a8a1}.of-error{max-width:1500px;margin:0 auto 14px;padding:12px;border-radius:10px;background:rgba(185,28,28,.15);border:1px solid rgba(248,113,113,.25);color:#fecaca}.of-metrics{max-width:1500px;margin:0 auto 14px;display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:10px}.of-metrics.with-forms{grid-template-columns:repeat(7,minmax(130px,1fr))}.of-metrics article{border:1px solid rgba(148,163,184,.13);background:rgba(11,25,24,.86);border-radius:14px;padding:15px}.of-metrics small{font-size:9px;letter-spacing:.11em;color:#7f9991;font-weight:800}.of-metrics b{display:block;font-size:26px;margin:6px 0 1px}.of-metrics span{font-size:10px;color:#7f9991}.of-toolbar div{display:flex;gap:10px;align-items:baseline}.of-board{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;align-items:start}.of-lane{border:1px solid rgba(148,163,184,.13);background:rgba(8,23,21,.8);border-radius:16px;overflow:hidden}.of-lane-head{padding:14px 15px;border-bottom:1px solid rgba(148,163,184,.1);display:flex;justify-content:space-between;gap:12px}.of-lane-head h2{font-size:14px;margin:0 0 4px}.of-lane-head p{font-size:10px;color:#77928a;margin:0;line-height:1.4}.of-lane-head strong{font-size:20px}.lane-blocked{border-color:rgba(248,113,113,.28)}.lane-scheduled{border-color:rgba(251,191,36,.22)}.of-cards{padding:10px;display:grid;gap:9px}.of-card{background:rgba(10,30,27,.9);border:1px solid rgba(148,163,184,.12);border-radius:12px;padding:13px}.of-card-head{display:flex;justify-content:space-between;gap:10px}.of-card h3{font-size:14px;margin:0 0 3px}.of-card-head span{font-size:10px;color:#789188}.of-pill{display:inline-flex;padding:4px 7px;border-radius:999px;font-size:9px;font-weight:800;white-space:nowrap;border:1px solid rgba(148,163,184,.16);color:#a9bcb6}.of-pill.ok{color:#72dba5;border-color:rgba(114,219,165,.28);background:rgba(16,94,61,.14)}.of-pill.warn{color:#f4c96a;border-color:rgba(244,201,106,.26);background:rgba(133,89,10,.12)}.of-pill.bad{color:#fca5a5;border-color:rgba(252,165,165,.28);background:rgba(127,29,29,.15)}.of-current,.of-next{margin-top:11px;border-top:1px solid rgba(148,163,184,.09);padding-top:9px}.of-current small,.of-next small{display:block;font-size:8px;letter-spacing:.1em;color:#68827a;font-weight:800}.of-current b,.of-next b{display:block;font-size:11px;margin-top:3px}.of-next span{display:block;font-size:9px;color:#829a93;margin-top:3px}.of-meeting{margin-top:10px;padding:9px;border-radius:9px;background:rgba(38,112,78,.12);display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:10px}.of-meeting a{color:#78dda9;text-decoration:none;font-weight:800}.of-note{margin-top:9px;padding:8px;border-radius:8px;background:rgba(161,98,7,.1);color:#d9bd78;font-size:10px}.of-note.danger{background:rgba(153,27,27,.13);color:#fca5a5}.of-notes{font-size:10px;color:#91a8a1;line-height:1.45;margin:9px 0 0}.of-forms{display:flex;gap:8px;margin-top:10px}.of-forms>span{flex:1;display:flex;justify-content:space-between;align-items:center;background:rgba(148,163,184,.06);padding:7px 8px;border-radius:8px;font-size:9px;color:#8ea59e}.of-owners{display:flex;gap:12px;margin-top:9px;font-size:9px;color:#759088}.of-owners b{color:#c5d5d0}.of-empty{padding:24px 12px;text-align:center;color:#668078;font-size:10px}@media(max-width:1000px){.of-top{grid-template-columns:1fr}.of-back{justify-self:start}.of-actions{flex-wrap:wrap}.of-metrics,.of-metrics.with-forms{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.of-shell{padding:18px 12px 60px}.of-brand h1{font-size:24px}.of-person{align-items:flex-start;flex-direction:column}.of-person div{align-items:flex-start;flex-direction:column;gap:4px}.of-metrics,.of-metrics.with-forms{grid-template-columns:1fr 1fr}.of-board{grid-template-columns:1fr}.of-actions button{flex:1}.of-toolbar{align-items:flex-start;flex-direction:column}}
`;
