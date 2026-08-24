"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrandMark, supabase } from "../shared";

type Row = Record<string, any>;
type RangeMode = "TODAY" | "WEEK" | "MONTH" | "HISTORY";

const DAY_MS = 86_400_000;
const TZ = "America/Sao_Paulo";

function dateKey(value: unknown) {
  const d = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayDelta(value: unknown) {
  const eventKey = dateKey(value);
  const todayKey = dateKey(new Date());
  if (!eventKey || !todayKey) return 9999;
  return Math.round((Date.parse(`${eventKey}T12:00:00-03:00`) - Date.parse(`${todayKey}T12:00:00-03:00`)) / DAY_MS);
}

function dayLabel(key: string) {
  if (!key) return "Data não identificada";
  const date = new Date(`${key}T12:00:00-03:00`);
  const delta = dayDelta(date);
  if (delta === 0) return "Hoje";
  if (delta === 1) return "Amanhã";
  if (delta === -1) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(date);
}

function hour(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(date);
}

function statusLabel(status: unknown) {
  switch (String(status || "")) {
    case "IN_PROGRESS": return "Em reunião";
    case "COMPLETED": return "Realizada";
    case "NO_EVIDENCE": return "Sem evidência de início";
    default: return "Agendada";
  }
}

function roleLabel(role: unknown) {
  const value = String(role || "").toUpperCase();
  if (value === "GT") return "Gestor de Tráfego";
  if (value === "CS") return "CS";
  if (value === "DESIGN") return "Designer";
  if (value === "MGMT") return "Operações";
  if (value === "COMMERCIAL") return "Comercial";
  if (value === "AI") return "IA";
  return value || "Colaborador";
}

function safeMeet(value: unknown) {
  const raw = String(value || "").trim();
  return /^https:\/\/meet\.google\.com\//i.test(raw) ? raw : "";
}

export default function AgendaPage() {
  const [payload, setPayload] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RangeMode>("WEEK");
  const [person, setPerson] = useState("ALL");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        window.location.assign("/");
        return;
      }
      const from = new Date(Date.now() - 90 * DAY_MS).toISOString();
      const to = new Date(Date.now() + 180 * DAY_MS).toISOString();
      const { data, error: rpcError } = await supabase.rpc("agenda_for_current_user", { p_from: from, p_to: to });
      if (rpcError) throw rpcError;
      if (!data?.ok) throw new Error("Não foi possível carregar a agenda.");
      setPayload(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar a agenda.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const events: Row[] = payload?.events || [];
  const people: Row[] = payload?.people || [];
  const canViewAll = Boolean(payload?.profile?.can_view_all);
  const profilePerson = String(payload?.profile?.person || "");

  useEffect(() => {
    if (!canViewAll) setPerson(profilePerson || "ALL");
  }, [canViewAll, profilePerson]);

  const summary = useMemo(() => {
    const today = events.filter((event) => dayDelta(event.scheduled_for) === 0).length;
    const week = events.filter((event) => { const d = dayDelta(event.scheduled_for); return d >= 0 && d <= 6; }).length;
    const live = events.filter((event) => event.effective_status === "IN_PROGRESS").length;
    const next = events.find((event) => new Date(event.scheduled_for).getTime() >= Date.now() - 10 * 60_000);
    return { today, week, live, next };
  }, [events]);

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("pt-BR");
    return events.filter((event) => {
      const delta = dayDelta(event.scheduled_for);
      if (mode === "TODAY" && delta !== 0) return false;
      if (mode === "WEEK" && (delta < 0 || delta > 6)) return false;
      if (mode === "MONTH" && (delta < 0 || delta > 29)) return false;
      if (mode === "HISTORY" && delta >= 0) return false;
      if (canViewAll && person !== "ALL" && event.person !== person) return false;
      if (term) {
        const haystack = `${event.client_name || ""} ${event.topic || ""} ${event.person || ""}`.toLocaleLowerCase("pt-BR");
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [events, mode, person, query, canViewAll]);

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const event of visible) {
      const key = dateKey(event.scheduled_for);
      map.set(key, [...(map.get(key) || []), event]);
    }
    return [...map.entries()].sort(([a], [b]) => mode === "HISTORY" ? b.localeCompare(a) : a.localeCompare(b));
  }, [visible, mode]);

  return (
    <main className="agenda-shell">
      <style>{styles}</style>
      <header className="agenda-top">
        <button type="button" className="agenda-brand" onClick={() => window.location.assign("/")} aria-label="Voltar ao dashboard">
          <span className="agenda-logo"><BrandMark /></span>
          <span><b>Leonardo Imobi</b><small>Central de Operações</small></span>
        </button>
        <div className="agenda-top-actions">
          <span className="agenda-sync"><i className={loading ? "loading" : ""} />{loading ? "Atualizando…" : "Agenda sincronizada"}</span>
          <button type="button" onClick={() => void load()} disabled={loading}>Atualizar</button>
          <button type="button" onClick={() => window.location.assign("/")}>Voltar ao dashboard</button>
        </div>
      </header>

      <section className="agenda-hero">
        <div>
          <span className="agenda-eyebrow">AGENDA OPERACIONAL · AUTOMÁTICA</span>
          <h1>{canViewAll ? "Agenda da operação" : "Minha agenda"}</h1>
          <p>Reuniões entram automaticamente quando o banco identifica um agendamento confirmado. Propostas ainda sem confirmação não aparecem como reunião marcada.</p>
        </div>
        <div className="agenda-profile">
          <span>{profilePerson || "—"}</span>
          <small>{roleLabel(payload?.profile?.role)} · {canViewAll ? "visão da equipe" : "somente suas reuniões"}</small>
        </div>
      </section>

      {error && <div className="agenda-error">{error}</div>}

      <section className="agenda-metrics">
        <article><span>Hoje</span><b>{summary.today}</b><small>reuniões identificadas</small></article>
        <article><span>Próximos 7 dias</span><b>{summary.week}</b><small>na sua visão atual</small></article>
        <article><span>Agora</span><b>{summary.live}</b><small>com evidência de início</small></article>
        <article className="next"><span>Próxima reunião</span><b>{summary.next ? hour(summary.next.scheduled_for) : "—"}</b><small>{summary.next ? `${summary.next.client_name || "Sem cliente vinculado"} · ${summary.next.topic || "Reunião"}` : "Nenhuma próxima reunião identificada"}</small></article>
      </section>

      <section className="agenda-toolbar">
        <div className="agenda-tabs">
          {([['TODAY','Hoje'],['WEEK','7 dias'],['MONTH','30 dias'],['HISTORY','Histórico']] as [RangeMode,string][]).map(([key,label]) => (
            <button type="button" key={key} className={mode === key ? "active" : ""} onClick={() => setMode(key)}>{label}</button>
          ))}
        </div>
        <div className="agenda-filters">
          {canViewAll && <select value={person} onChange={(event) => setPerson(event.target.value)} aria-label="Filtrar por colaborador">
            <option value="ALL">Toda a equipe</option>
            {people.map((row) => <option key={row.person} value={row.person}>{row.person} · {roleLabel(row.role)}</option>)}
          </select>}
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, assunto ou pessoa" aria-label="Buscar na agenda" />
        </div>
      </section>

      <section className="agenda-content">
        {grouped.map(([key, rows]) => (
          <section className="agenda-day" key={key}>
            <header><div><span>{dayLabel(key)}</span><small>{new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${key}T12:00:00-03:00`))}</small></div><b>{rows.length}</b></header>
            <div className="agenda-list">
              {rows.map((event) => {
                const meet = safeMeet(event.meet_url);
                return <article className={`agenda-event ${String(event.effective_status || "").toLowerCase()}`} key={event.id}>
                  <div className="agenda-time"><b>{hour(event.scheduled_for)}</b><small>{Number(event.duration_minutes || 60)} min</small></div>
                  <div className="agenda-event-main">
                    <div className="agenda-event-title"><span className="agenda-status">{statusLabel(event.effective_status)}</span><h2>{event.topic || "Reunião / alinhamento"}</h2></div>
                    <p>{event.client_name || "Reunião sem cliente vinculado"}</p>
                    <footer>
                      <span>{event.person}</span>
                      <span>Origem: {event.presence_source ? "WhatsApp + Meet/Donnah" : "WhatsApp"}</span>
                      {event.confidence != null && <span>{Math.round(Number(event.confidence) * 100)}% de confiança</span>}
                    </footer>
                  </div>
                  <div className="agenda-event-actions">
                    {meet && event.effective_status !== "COMPLETED" && <a href={meet} target="_blank" rel="noreferrer">Abrir Meet</a>}
                    {event.actual_started_at && <small>Início detectado {hour(event.actual_started_at)}</small>}
                    {event.effective_status === "NO_EVIDENCE" && <small>O banco não encontrou evidência suficiente de início.</small>}
                  </div>
                </article>;
              })}
            </div>
          </section>
        ))}

        {!loading && !grouped.length && <div className="agenda-empty"><b>Nenhuma reunião neste filtro.</b><span>Quando um horário for efetivamente combinado e identificado pelo banco, ele entra aqui automaticamente.</span></div>}
        {loading && !payload && <div className="agenda-empty"><b>Carregando agenda…</b><span>Consultando agendamentos confirmados do seu perfil.</span></div>}
      </section>

      <aside className="agenda-rule"><b>Regra de acesso:</b> o filtro é aplicado no banco, não no navegador. Adler recebe o consolidado; os demais perfis recebem somente reuniões vinculadas ao próprio colaborador.</aside>
    </main>
  );
}

const styles = `
:root{color-scheme:dark}.agenda-shell{min-height:100vh;background:radial-gradient(circle at 18% 0%,rgba(36,105,80,.13),transparent 31%),#07100d;color:#eaf5ef;font-family:Inter,system-ui,sans-serif;padding:0 28px 42px}.agenda-top{height:72px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid rgba(116,178,151,.13);max-width:1440px;margin:0 auto}.agenda-brand{display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.agenda-logo{width:28px;height:36px;color:#ecf5f1}.agenda-brand b,.agenda-brand small{display:block}.agenda-brand b{font-size:12px}.agenda-brand small{font-size:9px;color:#6f8b7e;margin-top:2px}.agenda-top-actions{display:flex;align-items:center;gap:8px}.agenda-top-actions button,.agenda-toolbar button,.agenda-event-actions a{border:1px solid #29463a;background:#0b1914;color:#b9cec4;border-radius:9px;padding:8px 11px;font:700 10px/1 Inter,sans-serif;cursor:pointer;text-decoration:none}.agenda-top-actions button:hover,.agenda-toolbar button:hover,.agenda-event-actions a:hover{border-color:#3e6a58;color:#fff}.agenda-sync{font-size:9px;color:#739084;margin-right:5px}.agenda-sync i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#65bd91;margin-right:6px}.agenda-sync i.loading{background:#e4b85d;animation:ag-pulse 1s infinite}.agenda-hero{max-width:1440px;margin:30px auto 18px;display:flex;align-items:flex-end;justify-content:space-between;gap:22px}.agenda-eyebrow{font-size:9px;letter-spacing:.15em;color:#6dba95;font-weight:850}.agenda-hero h1{font:800 34px/1 'Inter Tight',Inter,sans-serif;margin:6px 0 9px}.agenda-hero p{max-width:760px;color:#7f9b8e;font-size:11px;line-height:1.55;margin:0}.agenda-profile{border:1px solid #213d31;background:#0a1712;border-radius:12px;padding:11px 13px;min-width:230px}.agenda-profile span,.agenda-profile small{display:block}.agenda-profile span{font-weight:800;font-size:11px}.agenda-profile small{color:#6d897c;font-size:9px;margin-top:4px}.agenda-error{max-width:1440px;margin:0 auto 14px;border:1px solid rgba(255,104,96,.3);background:rgba(90,27,24,.34);color:#ffb3ad;border-radius:10px;padding:11px 13px;font-size:10px}.agenda-metrics{max-width:1440px;margin:0 auto 16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 1.6fr;gap:9px}.agenda-metrics article{border:1px solid #1d382d;background:linear-gradient(155deg,#0b1a14,#09140f);border-radius:13px;padding:14px}.agenda-metrics article span,.agenda-metrics article small{display:block}.agenda-metrics article>span{font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:#658477;font-weight:800}.agenda-metrics article>b{font:800 25px/1 'Inter Tight',Inter,sans-serif;display:block;margin:8px 0 5px}.agenda-metrics article small{font-size:8px;color:#5f786d}.agenda-metrics article.next>b{font-size:21px}.agenda-metrics article.next small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agenda-toolbar{max-width:1440px;margin:0 auto 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}.agenda-tabs,.agenda-filters{display:flex;align-items:center;gap:7px}.agenda-toolbar button.active{background:rgba(67,172,123,.16);border-color:rgba(89,205,146,.35);color:#dbf5e7}.agenda-filters select,.agenda-filters input{border:1px solid #243f34;background:#091711;color:#d5e5dd;border-radius:9px;padding:9px 11px;font:600 10px/1 Inter,sans-serif;outline:none}.agenda-filters select{min-width:200px}.agenda-filters input{width:250px}.agenda-content{max-width:1440px;margin:0 auto}.agenda-day{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:14px 0;border-top:1px solid #162b22}.agenda-day>header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:5px 4px}.agenda-day>header div span,.agenda-day>header div small{display:block;text-transform:capitalize}.agenda-day>header div span{font:800 13px/1.2 'Inter Tight',Inter,sans-serif}.agenda-day>header div small{font-size:8px;color:#617b6f;margin-top:5px}.agenda-day>header>b{font-size:9px;color:#658477;border:1px solid #223d32;border-radius:999px;padding:4px 6px}.agenda-list{display:grid;gap:8px}.agenda-event{display:grid;grid-template-columns:82px minmax(0,1fr) 190px;gap:13px;align-items:center;border:1px solid #1c362b;background:#091610;border-radius:13px;padding:12px;position:relative;overflow:hidden}.agenda-event:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#638375}.agenda-event.in_progress:before{background:#4ed890}.agenda-event.completed:before{background:#5b8dff}.agenda-event.no_evidence:before{background:#d9aa58}.agenda-time{padding-left:6px}.agenda-time b,.agenda-time small{display:block}.agenda-time b{font:800 20px/1 'Inter Tight',Inter,sans-serif}.agenda-time small{font-size:8px;color:#60796e;margin-top:5px}.agenda-event-title{display:flex;align-items:center;gap:8px;min-width:0}.agenda-event-title h2{font:800 13px/1.2 'Inter Tight',Inter,sans-serif;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agenda-status{font-size:7px;font-weight:850;letter-spacing:.05em;text-transform:uppercase;border:1px solid #2b493c;color:#89a89a;border-radius:999px;padding:4px 6px;white-space:nowrap}.agenda-event.in_progress .agenda-status{border-color:rgba(78,216,144,.35);color:#82efb6}.agenda-event.completed .agenda-status{border-color:rgba(91,141,255,.34);color:#9ebdff}.agenda-event.no_evidence .agenda-status{border-color:rgba(217,170,88,.34);color:#e5c482}.agenda-event-main>p{font-size:10px;color:#91aa9e;margin:7px 0}.agenda-event-main footer{display:flex;gap:10px;flex-wrap:wrap}.agenda-event-main footer span{font-size:8px;color:#587166}.agenda-event-actions{display:flex;flex-direction:column;align-items:flex-end;gap:7px;text-align:right}.agenda-event-actions small{font-size:8px;color:#687f75;line-height:1.35;max-width:180px}.agenda-empty{border:1px dashed #294236;background:#09140f;border-radius:13px;padding:34px;text-align:center}.agenda-empty b,.agenda-empty span{display:block}.agenda-empty b{font-size:13px}.agenda-empty span{font-size:9px;color:#617a6f;margin-top:6px}.agenda-rule{max-width:1440px;margin:16px auto 0;border-top:1px solid #172c23;padding-top:12px;color:#567065;font-size:8px;line-height:1.5}.agenda-rule b{color:#86a397}@keyframes ag-pulse{50%{opacity:.35}}@media(max-width:980px){.agenda-metrics{grid-template-columns:repeat(2,1fr)}.agenda-day{grid-template-columns:1fr}.agenda-event{grid-template-columns:72px 1fr}.agenda-event-actions{grid-column:2;align-items:flex-start;text-align:left}.agenda-toolbar{align-items:flex-start;flex-direction:column}.agenda-filters{width:100%}.agenda-filters input{flex:1}.agenda-hero{align-items:flex-start;flex-direction:column}}@media(max-width:640px){.agenda-shell{padding:0 14px 30px}.agenda-top{height:auto;padding:13px 0;align-items:flex-start}.agenda-top-actions{flex-wrap:wrap;justify-content:flex-end}.agenda-sync{width:100%;text-align:right}.agenda-hero h1{font-size:28px}.agenda-profile{width:100%}.agenda-metrics{grid-template-columns:1fr 1fr}.agenda-event{grid-template-columns:60px minmax(0,1fr);padding:10px}.agenda-event-title{align-items:flex-start;flex-direction:column;gap:5px}.agenda-event-title h2{white-space:normal}.agenda-filters{flex-direction:column;align-items:stretch}.agenda-filters select,.agenda-filters input{width:100%;min-width:0}.agenda-tabs{width:100%;overflow:auto}.agenda-tabs button{white-space:nowrap}}
`;
