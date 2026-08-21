"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";
import type { Row } from "../shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-api`;

type Payload = {
  worklist: Row[];
  assignment_notifications: Row[];
  gt_options: Row[];
  profile?: Row;
  generated_at?: string;
};

const bucketOrder = ["WAITING_SCHEDULING", "SCHEDULED", "IN_PROGRESS", "ACCESS_VALIDATION", "BLOCKED"];
const bucketLabel: Record<string, string> = {
  WAITING_SCHEDULING: "Aguardando agendamento",
  SCHEDULED: "Integração agendada",
  IN_PROGRESS: "Integração em andamento",
  ACCESS_VALIDATION: "Validando acessos e contas",
  BLOCKED: "Integração bloqueada",
};
const bucketHelp: Record<string, string> = {
  WAITING_SCHEDULING: "Cliente já está na carteira do GT, mas a reunião de integração ainda não tem data/hora registrada.",
  SCHEDULED: "Reunião de integração marcada. Dia e hora aparecem no card.",
  IN_PROGRESS: "Integração iniciada e ainda em andamento.",
  ACCESS_VALIDATION: "Reunião feita; faltam validações de Meta, CRM, Google ou demais acessos aplicáveis.",
  BLOCKED: "Existe um bloqueio que impede a conclusão da integração ou dos acessos.",
};

function fmtDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function fmtDate(value: unknown) {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-").map(Number);
  return year && month && day ? new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day)) : raw;
}
function shortName(value: unknown) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : (parts[0] || "GT");
}
function chipLabel(value: unknown) {
  const raw = String(value || "—");
  const map: Record<string, string> = { PENDING: "Pendente", SCHEDULED: "Agendada", IN_PROGRESS: "Em andamento", DONE: "Concluída", SKIPPED: "Superada", BLOCKED: "Bloqueada", OK: "OK", ATTENTION: "Atenção", HIGH: "Alta", CRITICAL: "Crítica" };
  return map[raw] || raw.replaceAll("_", " ");
}
function Pill({ value }: { value: unknown }) {
  const raw = String(value || "");
  const tone = raw === "BLOCKED" || raw === "CRITICAL" ? "bad" : raw === "SCHEDULED" || raw === "IN_PROGRESS" || raw === "ATTENTION" || raw === "HIGH" ? "warn" : raw === "DONE" || raw === "OK" ? "ok" : "muted";
  return <span className={`ob-pill ${tone}`}>{chipLabel(raw)}</span>;
}

export default function OnboardingPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

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
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar onboarding.");
    } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 30_000);
    const updated = () => load();
    window.addEventListener("ops-onboarding-updated", updated);
    return () => { window.clearInterval(timer); window.removeEventListener("ops-onboarding-updated", updated); };
  }, [session?.access_token, load]);

  async function assign(item: Row, gtOwner: string) {
    if (!session?.access_token) return;
    const requestId = String(item.metadata?.request_id || "");
    const key = `${requestId}:${gtOwner}`;
    setBusy(key); setError("");
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId, client_id: item.client_id, gt_owner: gtOwner }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || "Falha ao atribuir GT.");
      await load();
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao atribuir GT.");
      await load();
    } finally { setBusy(""); }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of payload?.worklist || []) {
      const key = String(row.integration_bucket || "WAITING_SCHEDULING");
      map.set(key, [...(map.get(key) || []), row]);
    }
    return bucketOrder.map((key) => [key, map.get(key) || []] as const);
  }, [payload]);

  const rows = payload?.worklist || [];
  const requests = payload?.assignment_notifications || [];
  const profile = payload?.profile || {};
  const isGt = profile.role === "GT";
  const scheduled = rows.filter((row) => row.integration_bucket === "SCHEDULED").length;
  const waiting = rows.filter((row) => row.integration_bucket === "WAITING_SCHEDULING").length;
  const access = rows.filter((row) => row.integration_bucket === "ACCESS_VALIDATION").length;
  const blocked = rows.filter((row) => row.integration_bucket === "BLOCKED").length;

  if (!ready) return <main className="ob-loading">Validando sessão…</main>;

  return <main className="ob-shell"><style>{styles}</style>
    <header className="ob-top">
      <div>
        <button className="ob-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
        <span className="ob-kicker">ONBOARDING · RESPONSABILIDADE DO GT</span>
        <h1>Integração de contas</h1>
        <p>{isGt ? `Apenas os clientes atribuídos a ${profile.person || "este GT"}${profile.carteira ? ` · Carteira ${profile.carteira}` : ""}.` : "Visão consolidada dos clientes já atribuídos aos gestores de tráfego."}</p>
      </div>
      <div className="ob-actions"><span className={`ob-live ${loading ? "loading" : ""}`}>{loading ? "Sincronizando…" : `Atualizado ${fmtDateTime(payload?.generated_at)}`}</span><button onClick={load} disabled={loading}>Atualizar</button></div>
    </header>

    <section className="ob-source"><b>O que entra aqui</b><span>Agendamento da integração, reunião com GT, andamento da integração, validação de acessos/contas e bloqueios. Clientes não atribuídos não aparecem na carteira de nenhum GT.</span></section>

    {error && <div className="ob-error"><b>Falha</b><span>{error}</span></div>}

    {requests.length > 0 && <section className="ob-assignments">
      <div className="ob-section-head"><div><span className="ob-kicker">AÇÃO NECESSÁRIA · CS / ADLER</span><h2>Definir gestor após a 1ª apresentação</h2><p>Ao selecionar um GT abaixo, o banco é atualizado na hora e o cliente passa a pertencer à carteira escolhida.</p></div><strong>{requests.length}</strong></div>
      <div className="ob-assignment-grid">{requests.map((item) => {
        const options: Row[] = Array.isArray(item.metadata?.gt_options) ? item.metadata.gt_options : [];
        return <article className="ob-assignment-card" key={String(item.id)}><div><Pill value="HIGH"/><h3>{String(item.client_display_name || "Cliente")}</h3><p>{String(item.description || "Selecione o gestor de tráfego.")}</p></div><div className="ob-gt-options">{options.map((option) => {
          const key = `${String(item.metadata?.request_id)}:${String(option.person)}`;
          return <button disabled={Boolean(busy)} key={String(option.person)} onClick={() => assign(item, String(option.person))}><b>{busy === key ? "Atribuindo…" : shortName(option.person)}</b><small>Carteira {String(option.carteira || "—")}</small></button>;
        })}</div></article>;
      })}</div>
    </section>}

    <section className="ob-metrics">
      <article><small>NA FILA DO GT</small><b>{rows.length}</b><span>clientes</span></article>
      <article><small>AGUARDANDO MARCAÇÃO</small><b>{waiting}</b><span>sem data/hora</span></article>
      <article><small>REUNIÃO AGENDADA</small><b>{scheduled}</b><span>com data/hora</span></article>
      <article><small>VALIDANDO ACESSOS</small><b>{access}</b><span>pós-integração</span></article>
      <article><small>BLOQUEADOS</small><b>{blocked}</b><span>exigem ação</span></article>
    </section>

    <section className="ob-board">
      {groups.map(([bucket, items]) => <article className={`ob-lane ${bucket === "BLOCKED" ? "danger" : ""}`} key={bucket}>
        <div className="ob-lane-head"><div><h2>{bucketLabel[bucket]}</h2><p>{bucketHelp[bucket]}</p></div><strong>{items.length}</strong></div>
        <div className="ob-cards">{items.map((row) => {
          const due = row.integration_due_at || row.access_due_at;
          const dueLabel = row.integration_bucket === "SCHEDULED" ? `Reunião: ${fmtDateTime(due)}` : row.integration_bucket === "WAITING_SCHEDULING" ? "Reunião ainda não marcada" : row.integration_bucket === "ACCESS_VALIDATION" ? `Acessos: ${chipLabel(row.access_status)}` : due ? `Prazo: ${fmtDateTime(due)}` : "Sem prazo registrado";
          return <div className="ob-card" key={String(row.client_id)}>
            <div className="ob-card-top"><div><h3>{String(row.display_name)}</h3><span>{row.carteira ? `Carteira ${row.carteira}` : "Sem carteira"} · GT {String(row.gt_owner || "—")}</span></div><Pill value={row.onboarding_risk || "OK"}/></div>
            <div className="ob-when">{dueLabel}</div>
            <div className="ob-status-row"><span>Integração <Pill value={row.integration_status}/></span><span>Acessos <Pill value={row.access_status}/></span></div>
            <p>{String(row.integration_notes || row.access_notes || row.next_action || "Acompanhar a próxima etapa da integração.")}</p>
            <small>Entrada: {fmtDate(row.entrada)} · Etapa geral: {String(row.current_stage || "—").replaceAll("_", " ")}</small>
          </div>;
        })}{!items.length && <div className="ob-empty">Nenhum cliente neste status.</div>}</div>
      </article>)}
    </section>

    {!loading && rows.length === 0 && <section className="ob-zero"><b>{isGt ? "Sua carteira não tem integração pendente neste momento." : "Nenhuma integração de GT está pendente agora."}</b><span>{isGt ? "Quando um cliente for atribuído a você após a 1ª apresentação, ele entra automaticamente aqui — primeiro em “Aguardando agendamento” ou já com a data/hora se a reunião tiver sido marcada." : "Novas atribuições e mudanças de status aparecem automaticamente."}</span></section>}
  </main>;
}

const styles = `
:root{color-scheme:dark}.ob-shell{min-height:100vh;background:#04101c;color:#edf6ff;padding:34px clamp(18px,4vw,58px) 60px;font-family:Inter,system-ui,sans-serif}.ob-loading{min-height:100vh;background:#04101c;color:#b8cee1;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif}.ob-top{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;max-width:1500px;margin:0 auto 22px}.ob-top h1{font-family:'Inter Tight',Inter,sans-serif;font-size:clamp(30px,4vw,48px);letter-spacing:-.04em;margin:7px 0}.ob-top p{margin:0;color:#8faac2}.ob-back{border:0;background:transparent;color:#78b8f0;padding:0;margin-bottom:16px;cursor:pointer;font-weight:700}.ob-kicker{display:block;color:#398fd8;font-size:10px;font-weight:800;letter-spacing:.16em}.ob-actions{display:flex;align-items:center;gap:10px}.ob-actions button,.ob-gt-options button{border:1px solid #234563;background:#09243a;color:#eaf6ff;border-radius:9px;padding:9px 13px;cursor:pointer}.ob-actions button:disabled,.ob-gt-options button:disabled{opacity:.55;cursor:wait}.ob-live{font-size:12px;color:#6edbb5}.ob-live.loading{color:#e8c56e}.ob-source,.ob-error{max-width:1500px;margin:0 auto 18px;border:1px solid #153550;background:#071a2b;border-radius:12px;padding:12px 15px;display:flex;gap:10px;align-items:flex-start;font-size:12px}.ob-source b{white-space:nowrap}.ob-source span{color:#8faac2}.ob-error{border-color:#6a2f3a;background:#2a1118;color:#ffc2cb}.ob-assignments{max-width:1500px;margin:0 auto 22px;border:1px solid #244d70;background:linear-gradient(135deg,#071c30,#091522);border-radius:16px;padding:18px}.ob-section-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:14px}.ob-section-head h2{font-family:'Inter Tight',Inter,sans-serif;margin:5px 0;font-size:22px}.ob-section-head p{margin:0;color:#8faac2;font-size:12px}.ob-section-head>strong{font-size:25px;color:#7fc1ff}.ob-assignment-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.ob-assignment-card{border:1px solid #1d3e5a;background:#061522;border-radius:13px;padding:15px}.ob-assignment-card h3{font-size:17px;margin:9px 0 5px}.ob-assignment-card p{color:#9db3c7;font-size:12px;line-height:1.5;margin:0 0 13px}.ob-gt-options{display:flex;gap:8px;flex-wrap:wrap}.ob-gt-options button{display:grid;text-align:left;min-width:118px}.ob-gt-options small{font-size:10px;color:#80a4c3;margin-top:2px}.ob-metrics{max-width:1500px;margin:0 auto 22px;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.ob-metrics article{border:1px solid #153550;background:#071725;border-radius:12px;padding:14px}.ob-metrics small{display:block;color:#6e91ad;font-size:9px;font-weight:800;letter-spacing:.1em}.ob-metrics b{display:block;font-size:28px;margin:7px 0 0}.ob-metrics span{font-size:11px;color:#7896ae}.ob-board{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:repeat(5,minmax(230px,1fr));gap:11px;align-items:start}.ob-lane{border:1px solid #12314a;background:#061522;border-radius:14px;overflow:hidden}.ob-lane.danger{border-color:#5a2935}.ob-lane-head{padding:14px;border-bottom:1px solid #12314a;display:flex;justify-content:space-between;gap:10px}.ob-lane-head h2{font-size:13px;margin:0 0 5px}.ob-lane-head p{font-size:10px;line-height:1.45;color:#6f90aa;margin:0}.ob-lane-head>strong{font-size:19px;color:#7ebdf1}.ob-cards{display:grid;gap:9px;padding:10px}.ob-card{border:1px solid #173851;background:#081a29;border-radius:11px;padding:12px}.ob-card-top{display:flex;justify-content:space-between;gap:8px}.ob-card h3{font-size:13px;margin:0 0 4px}.ob-card-top span{font-size:9.5px;color:#7595af}.ob-when{margin:11px 0 9px;border-left:2px solid #418dc7;padding-left:8px;color:#d7ebfc;font-size:11px;font-weight:700}.ob-status-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:9px}.ob-status-row>span{font-size:9px;color:#708ea6;display:flex;align-items:center;gap:5px}.ob-card p{font-size:10.5px;line-height:1.45;color:#9bb2c6;margin:8px 0}.ob-card>small{font-size:9px;color:#647f97}.ob-pill{display:inline-block;border-radius:999px;border:1px solid #284359;background:#0c2132;color:#92aec5;padding:3px 7px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.ob-pill.ok{border-color:#1b5b4a;color:#79dfbc;background:#0a2a24}.ob-pill.warn{border-color:#665329;color:#efcd78;background:#2a2412}.ob-pill.bad{border-color:#66313b;color:#f2a7b2;background:#2d151b}.ob-empty{padding:18px 10px;text-align:center;color:#58758d;font-size:10px}.ob-zero{max-width:1500px;margin:18px auto 0;border:1px dashed #28506f;border-radius:14px;padding:25px;text-align:center;display:grid;gap:7px}.ob-zero b{font-size:14px}.ob-zero span{color:#809cb3;font-size:11px;max-width:780px;margin:auto;line-height:1.5}@media(max-width:1250px){.ob-board{grid-template-columns:repeat(2,minmax(280px,1fr))}.ob-metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.ob-shell{padding:22px 14px 40px}.ob-top{align-items:flex-start;flex-direction:column}.ob-actions{width:100%;justify-content:space-between}.ob-metrics{grid-template-columns:repeat(2,1fr)}.ob-board{grid-template-columns:1fr}.ob-assignment-grid{grid-template-columns:1fr}.ob-source{display:grid}}
`;
