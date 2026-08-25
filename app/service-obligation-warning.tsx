"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./shared";

type Warning = {
  id: string;
  obligation_id: string;
  client_id: string;
  target_person: string;
  target_role?: string | null;
  severity: "HIGH" | "CRITICAL";
  title: string;
  situation?: string | null;
  action_now?: string | null;
  requester_name?: string | null;
  promise_owner?: string | null;
  execution_owner?: string | null;
  communication_owner?: string | null;
  request_text?: string | null;
  promise_text?: string | null;
  due_at?: string | null;
  overdue_minutes?: number | null;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  created_at: string;
};

const ops = supabase.schema("agency_ops");

function formatWhen(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function severityRank(value: Warning["severity"]) {
  return value === "CRITICAL" ? 2 : 1;
}

const ACTIONS = [
  ["CLAIM", "Estou cuidando"],
  ["WAITING_CLIENT", "Aguardando cliente"],
  ["CLIENT_PAUSED", "Cliente em pausa"],
  ["INTERNAL_WORK", "Trabalho em andamento"],
  ["WAITING_EXTERNAL", "Dependência externa"],
  ["SET_DEADLINE", "Definir prazo"],
  ["FALSE_ALERT", "Falso alerta"],
  ["RESOLVE", "Resolver"],
] as const;

export default function ServiceObligationWarning() {
  const [warning, setWarning] = useState<Warning | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [action, setAction] = useState<(typeof ACTIONS)[number][0]>("CLAIM");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const claimNext = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setWarning(null);
      return;
    }
    const { data, error: queryError } = await ops
      .from("service_obligation_interrupts")
      .select("id,obligation_id,client_id,target_person,target_role,severity,title,situation,action_now,requester_name,promise_owner,execution_owner,communication_owner,request_text,promise_text,due_at,overdue_minutes,acknowledged_at,resolved_at,created_at")
      .is("acknowledged_at", null)
      .is("resolved_at", null)
      .limit(25);
    if (queryError) return;
    const rows = ((data || []) as Warning[]).sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      if (sev) return sev;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    setWarning(rows[0] || null);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSessionUserId(data.session?.user?.id || null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUserId(session?.user?.id || null);
      if (!session) setWarning(null);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    let disposed = false;
    const channel = supabase
      .channel(`service-obligation-interrupt:${sessionUserId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "agency_ops", table: "service_obligation_interrupts" },
        (payload) => {
          if (disposed) return;
          const next = payload.new as Warning;
          const previous = payload.old as Partial<Warning>;
          if (next?.id && !next.acknowledged_at && !next.resolved_at) {
            setWarning((current) => {
              if (!current) return next;
              return severityRank(next.severity) > severityRank(current.severity) ? next : current;
            });
            return;
          }
          const changedId = next?.id || previous?.id;
          setWarning((current) => {
            if (!current || current.id !== changedId) return current;
            window.setTimeout(() => void claimNext(), 0);
            return null;
          });
        },
      )
      .subscribe((status) => {
        if (!disposed && status === "SUBSCRIBED") void claimNext();
      });
    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [sessionUserId, claimNext]);

  useEffect(() => {
    if (!warning || warning.severity !== "CRITICAL") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const stopEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", stopEscape, true);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", stopEscape, true);
    };
  }, [warning]);

  useEffect(() => {
    setAction("CLAIM");
    setReason("");
    setUntil("");
    setError("");
  }, [warning?.id]);

  const needsReason = useMemo(() => ["WAITING_CLIENT", "CLIENT_PAUSED", "INTERNAL_WORK", "WAITING_EXTERNAL", "FALSE_ALERT", "RESOLVE"].includes(action), [action]);
  const needsUntil = useMemo(() => ["CLIENT_PAUSED", "SET_DEADLINE"].includes(action), [action]);

  async function submitAction() {
    if (!warning || busy) return;
    if (needsReason && !reason.trim()) {
      setError("Explique o motivo para registrar essa decisão no histórico.");
      return;
    }
    if (needsUntil && !until) {
      setError("Defina até quando essa condição deve valer.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const untilIso = until ? new Date(until).toISOString() : null;
      const { error: rpcError } = await ops.rpc("act_on_service_obligation_interrupt", {
        p_interrupt_id: warning.id,
        p_action: action,
        p_reason: reason.trim() || null,
        p_until: untilIso,
      });
      if (rpcError) throw rpcError;
      setWarning(null);
      await claimNext();
    } catch {
      setError("Não consegui registrar a ação. Revise os campos e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  if (!warning) return null;
  const critical = warning.severity === "CRITICAL";

  return (
    <div className={critical ? "svc-obligation-shield" : "svc-obligation-high-wrap"} role="alertdialog" aria-modal={critical || undefined}>
      <style>{styles}</style>
      <section className={`svc-obligation-card ${critical ? "critical" : "high"}`}>
        <div className="svc-obligation-kicker">{critical ? "🚨 CRÍTICO — AÇÃO OPERACIONAL" : "⚠ ATENÇÃO ALTA — CLIENTE AGUARDANDO"}</div>
        <h2>{warning.title}</h2>
        {warning.situation && <pre className="svc-obligation-situation">{warning.situation}</pre>}

        <div className="svc-obligation-owners">
          <div><small>QUEM PEDIU</small><strong>{warning.requester_name || "Não identificado"}</strong></div>
          <div><small>QUEM PROMETEU</small><strong>{warning.promise_owner || "Sem promessa nominal"}</strong></div>
          <div><small>QUEM EXECUTA</small><strong>{warning.execution_owner || "A definir"}</strong></div>
          <div><small>QUEM COMUNICA</small><strong>{warning.communication_owner || "CS ainda não assumiu"}</strong></div>
        </div>

        {(warning.due_at || (warning.overdue_minutes || 0) > 0) && (
          <div className="svc-obligation-deadline">
            <span>Prazo relevante: <b>{formatWhen(warning.due_at)}</b></span>
            {(warning.overdue_minutes || 0) > 0 && <span>Atraso útil: <b>{warning.overdue_minutes} min</b></span>}
          </div>
        )}

        <div className="svc-obligation-action-now">
          <small>AÇÃO AGORA</small>
          <p>{warning.action_now || "Atualize o cliente e registre o andamento."}</p>
        </div>

        <div className="svc-obligation-form">
          <label>
            O que está acontecendo agora?
            <select value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
              {ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {needsReason && (
            <label>
              Motivo / contexto
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Registre o contexto real. Isso ficará auditado." rows={3} />
            </label>
          )}
          {(needsUntil || ["WAITING_CLIENT", "INTERNAL_WORK", "WAITING_EXTERNAL"].includes(action)) && (
            <label>
              Até quando? {needsUntil ? "(obrigatório)" : "(opcional)"}
              <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </label>
          )}
          {error && <div className="svc-obligation-error">{error}</div>}
          <button type="button" onClick={submitAction} disabled={busy}>{busy ? "REGISTRANDO…" : "REGISTRAR AÇÃO"}</button>
        </div>
        <p className="svc-obligation-foot">Não existe botão “dispensar”. Toda mudança fica registrada no histórico operacional.</p>
      </section>
    </div>
  );
}

const styles = `
.svc-obligation-shield{position:fixed;inset:0;z-index:49000;display:grid;place-items:center;padding:24px;background:rgba(13,5,7,.94);backdrop-filter:blur(14px);overflow:auto;color:#fff;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.svc-obligation-high-wrap{position:fixed;z-index:48000;right:22px;top:22px;width:min(560px,calc(100vw - 28px));max-height:calc(100vh - 44px);overflow:auto;color:#fff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;filter:drop-shadow(0 24px 50px rgba(0,0,0,.42))}
.svc-obligation-card{border-radius:20px;padding:26px;border:1px solid rgba(255,255,255,.13);background:linear-gradient(180deg,#17191d,#0e0f12);box-shadow:0 35px 100px rgba(0,0,0,.62)}
.svc-obligation-card.critical{width:min(920px,100%);border:2px solid rgba(255,73,73,.78);background:linear-gradient(180deg,#3c090d,#170406);box-shadow:0 30px 120px rgba(0,0,0,.72),0 0 90px rgba(255,40,40,.11)}
.svc-obligation-card.high{border-color:rgba(255,182,61,.5);background:linear-gradient(180deg,#2b210e,#12100b)}
.svc-obligation-kicker{font-size:11px;font-weight:900;letter-spacing:.12em;color:#ffb0a7}.svc-obligation-card.high .svc-obligation-kicker{color:#ffd88f}
.svc-obligation-card h2{margin:13px 0 16px;font-family:"Inter Tight",Inter,sans-serif;font-size:clamp(27px,4vw,47px);line-height:1;letter-spacing:-.035em}
.svc-obligation-situation{margin:0;padding:16px;border-radius:12px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.08);white-space:pre-wrap;font:500 13px/1.55 Inter,sans-serif;color:#f0dddd}
.svc-obligation-owners{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.svc-obligation-owners>div{padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.035)}
.svc-obligation-owners small,.svc-obligation-action-now small{display:block;font-size:9px;letter-spacing:.11em;font-weight:900;color:#c9a9a9}.svc-obligation-owners strong{display:block;margin-top:5px;font-size:12px;line-height:1.35}
.svc-obligation-deadline{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;padding:11px 13px;border-radius:10px;background:rgba(255,255,255,.05);font-size:12px;color:#e8d6d6}
.svc-obligation-action-now{margin-top:12px;padding:14px 16px;border-left:4px solid #ff5151;background:rgba(255,255,255,.05)}.svc-obligation-card.high .svc-obligation-action-now{border-left-color:#f7b73f}.svc-obligation-action-now p{margin:6px 0 0;font-size:14px;line-height:1.5;font-weight:700}
.svc-obligation-form{display:grid;gap:10px;margin-top:16px}.svc-obligation-form label{display:grid;gap:6px;font-size:11px;font-weight:800;color:#decaca}.svc-obligation-form select,.svc-obligation-form textarea,.svc-obligation-form input{width:100%;box-sizing:border-box;border-radius:9px;border:1px solid rgba(255,255,255,.13);background:#0d0e10;color:#fff;padding:11px 12px;font:500 12px/1.4 Inter,sans-serif;outline:none}.svc-obligation-form textarea{resize:vertical}.svc-obligation-form button{border:0;border-radius:10px;padding:13px 16px;background:#ff5555;color:#230000;font-weight:900;cursor:pointer}.svc-obligation-card.high .svc-obligation-form button{background:#f3b53f}.svc-obligation-form button:disabled{opacity:.6;cursor:wait}
.svc-obligation-error{padding:9px 11px;border-radius:8px;background:rgba(255,190,80,.12);color:#ffd69a;font-size:11px}.svc-obligation-foot{margin:10px 0 0;text-align:center;color:#987e80;font-size:9px}
@media(max-width:760px){.svc-obligation-shield{padding:12px}.svc-obligation-high-wrap{right:10px;top:10px;width:calc(100vw - 20px);max-height:calc(100vh - 20px)}.svc-obligation-card{padding:20px}.svc-obligation-owners{grid-template-columns:1fr 1fr}}
`;
