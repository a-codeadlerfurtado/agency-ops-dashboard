"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./shared";

type AlertRow = {
  id: string;
  client_name: string;
  level: "COBRAR_AGORA" | "ACOMPANHAR_HOJE" | "VERIFICAR_INTERNO";
  priority: string;
  owner_area?: string | null;
  owner_person?: string | null;
  context?: string | null;
  situation?: string | null;
  charge_action?: string | null;
  confidence?: string | null;
  occurrence_count: number;
  status: string;
  first_seen_slot: string;
  last_seen_slot: string;
  first_seen_at: string;
  last_seen_at: string;
};

type ActionMode = "AGUARDANDO_CLIENTE" | "PRAZO_COMBINADO" | "FALSO_POSITIVO" | null;

const rank = (row: AlertRow) => {
  const level = row.level === "COBRAR_AGORA" ? 0 : row.level === "ACOMPANHAR_HOJE" ? 1 : 2;
  const priority = row.priority === "CRITICAL" ? 0 : row.priority === "HIGH" ? 1 : 2;
  return level * 10 + priority;
};

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function label(level: AlertRow["level"]) {
  if (level === "COBRAR_AGORA") return "COBRAR AGORA";
  if (level === "ACOMPANHAR_HOJE") return "ACOMPANHAR HOJE";
  return "VERIFICAR INTERNAMENTE";
}

export default function ManagerAttentionRadarWarning() {
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");

  const sortRows = useCallback((rows: AlertRow[]) => [...rows].sort((a, b) => rank(a) - rank(b) || new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime()), []);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) { setAlerts([]); return; }
    const { data, error: queryError } = await supabase
      .schema("agency_ops")
      .from("manager_attention_alerts")
      .select("id,client_name,level,priority,owner_area,owner_person,context,situation,charge_action,confidence,occurrence_count,status,first_seen_slot,last_seen_slot,first_seen_at,last_seen_at")
      .eq("status", "OPEN")
      .order("first_seen_at", { ascending: true })
      .limit(30);
    if (queryError) return;
    setAlerts(sortRows((data || []) as AlertRow[]));
  }, [sortRows]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setSessionUserId(data.session?.user?.id || null); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUserId(session?.user?.id || null);
      if (!session) setAlerts([]);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    let disposed = false;
    const channel = supabase
      .channel(`manager-attention-radar:${sessionUserId}`)
      .on("postgres_changes", { event: "*", schema: "agency_ops", table: "manager_attention_alerts" }, (payload) => {
        if (disposed) return;
        const next = payload.new as AlertRow;
        const old = payload.old as Partial<AlertRow>;
        if (next?.id && next.status === "OPEN") {
          setAlerts((current) => sortRows([...current.filter((x) => x.id !== next.id), next]));
        } else {
          const id = next?.id || old?.id;
          if (id) setAlerts((current) => current.filter((x) => x.id !== id));
        }
      })
      .subscribe((status) => { if (!disposed && status === "SUBSCRIBED") void load(); });
    return () => { disposed = true; void supabase.removeChannel(channel); };
  }, [sessionUserId, load, sortRows]);

  useEffect(() => {
    if (!alerts.length) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("keydown", blockEscape, true);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", blockEscape, true); };
  }, [alerts.length]);

  useEffect(() => {
    if (index >= alerts.length) setIndex(Math.max(0, alerts.length - 1));
  }, [alerts.length, index]);

  const current = alerts[index] || null;
  const counts = useMemo(() => ({
    red: alerts.filter((x) => x.level === "COBRAR_AGORA").length,
    orange: alerts.filter((x) => x.level === "ACOMPANHAR_HOJE").length,
    gray: alerts.filter((x) => x.level === "VERIFICAR_INTERNO").length,
  }), [alerts]);

  async function act(action: string, actionNote?: string, snoozed?: string | null) {
    if (!current || busy) return;
    setBusy(true); setError("");
    const { error: rpcError } = await supabase.schema("agency_ops").rpc("manager_attention_alert_action", {
      p_id: current.id,
      p_action: action,
      p_note: actionNote || null,
      p_snoozed_until: snoozed || null,
    });
    if (rpcError) {
      setError("Não consegui registrar a ação. Tente novamente.");
      setBusy(false);
      return;
    }
    setAlerts((rows) => rows.filter((x) => x.id !== current.id));
    setActionMode(null); setNote(""); setUntil(""); setBusy(false);
  }

  async function submitMode() {
    if (!current || !actionMode) return;
    if (actionMode === "FALSO_POSITIVO") {
      if (!note.trim()) { setError("Explique por que este alerta é falso positivo."); return; }
      await act(actionMode, note.trim(), null);
      return;
    }
    if (!note.trim() || !until) { setError("Informe o motivo e até quando devemos congelar este alerta."); return; }
    const parsed = new Date(until);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) { setError("Escolha um prazo futuro válido."); return; }
    await act(actionMode, note.trim(), parsed.toISOString());
  }

  if (!current) return null;
  const repeated = Number(current.occurrence_count || 1) > 1;

  return (
    <div className="mgr-radar-shield" role="alertdialog" aria-modal="true" aria-labelledby="mgr-radar-title">
      <style>{styles}</style>
      <section className={`mgr-radar-card ${current.level.toLowerCase()}`}>
        <header className="mgr-radar-head">
          <div>
            <div className="mgr-radar-kicker">🧭 RADAR GERENCIAL · {current.last_seen_slot}</div>
            <h1 id="mgr-radar-title">{label(current.level)}</h1>
          </div>
          <div className="mgr-radar-counter">{index + 1} / {alerts.length}</div>
        </header>

        <div className="mgr-radar-summary">
          <span className="red">🔴 {counts.red}</span><span className="orange">🟠 {counts.orange}</span><span>⚪ {counts.gray}</span>
          {repeated && <b>⚠ CONTINUA ABERTO · {current.occurrence_count}º corte</b>}
        </div>

        <div className="mgr-radar-client">
          <small>CLIENTE</small><strong>{current.client_name}</strong>
          <span>{[current.owner_person, current.owner_area].filter(Boolean).join(" · ") || "Responsável a confirmar"}</span>
        </div>

        <div className="mgr-radar-block"><small>CONTEXTO COMPROVADO</small><p>{current.context || "Sem contexto textual suficiente."}</p></div>
        <div className="mgr-radar-grid">
          <div><small>SITUAÇÃO AGORA</small><p>{current.situation || "—"}</p></div>
          <div className="action"><small>O QUE COBRAR</small><p>{current.charge_action || "Verificar e fechar a pendência com evidência."}</p></div>
        </div>

        <div className="mgr-radar-meta">
          <span>Confiança: <b>{String(current.confidence || "MEDIA").toLowerCase()}</b></span>
          <span>Primeiro sinal: <b>{fmt(current.first_seen_at)}</b></span>
          <span>Último corte: <b>{current.last_seen_slot}</b></span>
        </div>

        {actionMode && (
          <div className="mgr-radar-form">
            <strong>{actionMode === "FALSO_POSITIVO" ? "Por que é falso positivo?" : actionMode === "AGUARDANDO_CLIENTE" ? "O que estamos aguardando do cliente?" : "Qual prazo foi combinado?"}</strong>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Registre o contexto para que o próximo gerente/CS saiba exatamente o motivo." />
            {actionMode !== "FALSO_POSITIVO" && <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />}
            <div className="mgr-radar-form-actions"><button onClick={() => { setActionMode(null); setError(""); }}>Cancelar</button><button className="primary" onClick={submitMode} disabled={busy}>Confirmar</button></div>
          </div>
        )}

        {error && <div className="mgr-radar-error">{error}</div>}

        {!actionMode && <div className="mgr-radar-actions">
          <button className="charge" onClick={() => act("COBRADO")} disabled={busy}>✓ COBRADO</button>
          <button className="resolve" onClick={() => act("RESOLVIDO")} disabled={busy}>✓ RESOLVIDO</button>
          <button onClick={() => setActionMode("AGUARDANDO_CLIENTE")} disabled={busy}>AGUARDANDO CLIENTE</button>
          <button onClick={() => setActionMode("PRAZO_COMBINADO")} disabled={busy}>PRAZO COMBINADO</button>
          <button className="false" onClick={() => setActionMode("FALSO_POSITIVO")} disabled={busy}>FALSO POSITIVO</button>
        </div>}

        {alerts.length > 1 && <footer className="mgr-radar-nav">
          <button onClick={() => setIndex((i) => (i - 1 + alerts.length) % alerts.length)}>← anterior</button>
          <span>A tela só sai quando cada item recebe uma ação.</span>
          <button onClick={() => setIndex((i) => (i + 1) % alerts.length)}>próximo →</button>
        </footer>}
      </section>
    </div>
  );
}

const styles = `
.mgr-radar-shield{position:fixed;inset:0;z-index:49000;display:grid;place-items:center;padding:22px;background:rgba(4,8,15,.96);backdrop-filter:blur(14px);color:#eef4ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;overflow:auto}
.mgr-radar-card{width:min(940px,100%);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:28px;background:linear-gradient(180deg,#101a2a,#080d16);box-shadow:0 35px 120px rgba(0,0,0,.72)}
.mgr-radar-card.cobrar_agora{border-color:rgba(255,79,79,.62);box-shadow:0 35px 120px rgba(0,0,0,.72),0 0 80px rgba(255,55,55,.10)}
.mgr-radar-card.acompanhar_hoje{border-color:rgba(255,179,71,.52)}
.mgr-radar-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.mgr-radar-kicker{font-size:11px;font-weight:850;letter-spacing:.13em;color:#8fa5c8}.mgr-radar-head h1{margin:9px 0 0;font-family:"Inter Tight",Inter,sans-serif;font-size:clamp(32px,5vw,56px);line-height:.95;letter-spacing:-.04em}.cobrar_agora .mgr-radar-head h1{color:#ff6666}.acompanhar_hoje .mgr-radar-head h1{color:#ffbd68}.mgr-radar-counter{padding:8px 11px;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#aab8ce;font-weight:800}
.mgr-radar-summary{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0 12px}.mgr-radar-summary span{padding:6px 9px;border-radius:8px;background:rgba(255,255,255,.06);font-size:12px}.mgr-radar-summary b{margin-left:auto;color:#ff8c8c;font-size:12px;letter-spacing:.04em}
.mgr-radar-client{padding:17px 18px;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:rgba(255,255,255,.035)}.mgr-radar-client small,.mgr-radar-block small,.mgr-radar-grid small{display:block;color:#8194b1;font-size:9px;font-weight:850;letter-spacing:.13em}.mgr-radar-client strong{display:block;margin-top:5px;font-size:25px}.mgr-radar-client span{display:block;margin-top:4px;color:#98a9c1;font-size:13px}
.mgr-radar-block{margin-top:11px;padding:17px 18px;border-radius:13px;background:#0c1422;border:1px solid rgba(255,255,255,.08)}.mgr-radar-block p,.mgr-radar-grid p{margin:8px 0 0;font-size:14px;line-height:1.55;color:#dce5f2}.mgr-radar-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.mgr-radar-grid>div{padding:17px 18px;border-radius:13px;background:#0c1422;border:1px solid rgba(255,255,255,.08)}.mgr-radar-grid .action{border-color:rgba(85,160,255,.25);background:rgba(35,99,185,.10)}
.mgr-radar-meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:11px;color:#7689a7;font-size:11px}.mgr-radar-meta b{color:#aec0d9}
.mgr-radar-actions{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:20px}.mgr-radar-actions button,.mgr-radar-form-actions button,.mgr-radar-nav button{border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 10px;background:#111d2e;color:#dbe7f7;font-weight:800;font-size:11px;cursor:pointer}.mgr-radar-actions .charge{background:#1c5fbd;border-color:#337bd8}.mgr-radar-actions .resolve{background:#176b4c;border-color:#298564}.mgr-radar-actions .false{color:#b7c2d2}.mgr-radar-actions button:hover,.mgr-radar-form-actions button:hover,.mgr-radar-nav button:hover{filter:brightness(1.13)}
.mgr-radar-form{margin-top:18px;padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:13px;background:#0b1421}.mgr-radar-form strong{display:block;margin-bottom:9px}.mgr-radar-form textarea{width:100%;min-height:90px;resize:vertical;border:1px solid rgba(255,255,255,.13);border-radius:10px;background:#07101c;color:#eef4ff;padding:11px;font:inherit}.mgr-radar-form input{width:100%;margin-top:9px;border:1px solid rgba(255,255,255,.13);border-radius:10px;background:#07101c;color:#eef4ff;padding:11px}.mgr-radar-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}.mgr-radar-form-actions .primary{background:#246dcc}.mgr-radar-error{margin-top:12px;padding:10px 12px;border-radius:9px;background:rgba(255,90,90,.12);color:#ffadad;font-size:12px}
.mgr-radar-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:15px;padding-top:13px;border-top:1px solid rgba(255,255,255,.08)}.mgr-radar-nav span{font-size:10px;color:#7587a1;text-align:center}.mgr-radar-nav button{padding:8px 10px;background:transparent}
@media(max-width:760px){.mgr-radar-shield{padding:10px}.mgr-radar-card{padding:20px}.mgr-radar-grid{grid-template-columns:1fr}.mgr-radar-actions{grid-template-columns:1fr 1fr}.mgr-radar-actions .false{grid-column:1/-1}.mgr-radar-head h1{font-size:34px}.mgr-radar-nav span{display:none}}
`;
