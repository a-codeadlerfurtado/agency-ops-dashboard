"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import type { Row } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-required-alerts-api`;

function when(value: unknown) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
}

export default function OnboardingRequiredAlerts() {
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [busy, setBusy] = useState<"" | "ACK" | "MEETING_SCHEDULED">("");
  const [error, setError] = useState("");
  const [panelTarget, setPanelTarget] = useState<Element | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [meetUrl, setMeetUrl] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) { setPending([]); setHistory([]); return; }
    try {
      const response = await authenticatedFetch(API_URL, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) return;
      setPending(Array.isArray(body.pending) ? body.pending : []);
      setHistory(Array.isArray(body.history) ? body.history : []);
      setError("");
    } catch {
      // Aviso auxiliar: nunca derruba o dashboard principal.
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 15_000);
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [session?.access_token, load]);

  useEffect(() => {
    const find = () => setPanelTarget(document.querySelector(".notification-list"));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const current = pending[0] || null;
  const canSchedule = Boolean(current?.alert_type === "ONBOARDING_MEETING_HANDOFF" && current?.metadata?.action_type === "SCHEDULE_MEETING");

  useEffect(() => {
    setScheduleOpen(false);
    setScheduledDate("");
    setScheduledTime("");
    setMeetUrl("");
    setError("");
  }, [current?.id]);

  async function resolveAlert(alert: Row, action: "ACK" | "MEETING_SCHEDULED") {
    if (busy) return;
    if (action === "MEETING_SCHEDULED") {
      if (!scheduledDate || !scheduledTime) { setError("Informe a data e o horário da reunião."); return; }
      if (meetUrl.trim() && !/^https:\/\/meet\.google\.com\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(meetUrl.trim())) {
        setError("Informe um link válido do Google Meet ou deixe o campo vazio."); return;
      }
    }
    setBusy(action); setError("");
    try {
      const response = await authenticatedFetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "MEETING_SCHEDULED" ? {
          id: alert.id,
          action,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime,
          meet_url: meetUrl.trim() || undefined,
        } : { id: alert.id, action }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || "Não foi possível registrar a ação.");
      await load();
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível registrar a ação.");
    } finally { setBusy(""); }
  }

  return <>
    {panelTarget && history.length > 0 && createPortal(
      <section style={{ borderTop: "1px solid rgba(111,159,194,.16)", marginTop: 8, paddingTop: 10, display: "grid", gap: 7 }}>
        <div style={{ color: "#73aee0", fontSize: 9.5, fontWeight: 900, letterSpacing: ".11em" }}>ONBOARDING · AVISOS DE CIÊNCIA</div>
        {history.slice(0, 20).map((item) => {
          const scheduled = item.metadata?.ack_action === "MEETING_SCHEDULED" && item.metadata?.scheduled_for;
          return <div key={String(item.id)} style={{ border: "1px solid rgba(92,145,183,.2)", background: "rgba(8,25,39,.56)", borderRadius: 9, padding: "8px 9px", display: "grid", gap: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <b style={{ color: "#dcebfa", fontSize: 11 }}>{String(item.title || "Aviso de onboarding")}</b>
              <span style={{ color: item.acknowledged_at ? "#76cfa0" : "#f2c06b", fontSize: 9, fontWeight: 800, whiteSpace: "nowrap" }}>{item.acknowledged_at ? "CIENTE" : "AGUARDANDO CIÊNCIA"}</span>
            </div>
            <span style={{ color: "#8faabd", fontSize: 10.3, lineHeight: 1.4 }}>{String(item.description || "")}</span>
            {scheduled && <div style={{ marginTop: 2, borderLeft: "2px solid rgba(118,207,160,.55)", paddingLeft: 7, display: "grid", gap: 2 }}>
              <span style={{ color: "#91c9aa", fontSize: 10, fontWeight: 750 }}>Reunião informada: {when(item.metadata.scheduled_for)}</span>
              {item.metadata?.acknowledged_person && <small style={{ color: "#6f9180", fontSize: 9 }}>Informado por {String(item.metadata.acknowledged_person)}</small>}
              {item.metadata?.meet_url && <a href={String(item.metadata.meet_url)} target="_blank" rel="noreferrer" style={{ color: "#74bdf0", fontSize: 9.5, width: "fit-content" }}>Abrir Google Meet</a>}
            </div>}
            <small style={{ color: "#637f94", fontSize: 9 }}>{when(item.occurred_at)}</small>
          </div>;
        })}
      </section>,
      panelTarget
    )}

    {current && createPortal(
      <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 20000, background: "rgba(1,8,14,.78)", backdropFilter: "blur(7px)", display: "grid", placeItems: "center", padding: 18 }}>
        <section role="dialog" aria-modal="true" aria-label="Aviso obrigatório de onboarding" style={{ width: "min(590px, 100%)", maxHeight: "calc(100vh - 36px)", overflow: "auto", border: "1px solid rgba(75,159,214,.4)", background: "linear-gradient(180deg,rgba(7,25,39,.99),rgba(4,16,27,.99))", color: "#eef8ff", borderRadius: 17, boxShadow: "0 28px 90px rgba(0,0,0,.62)", padding: 20, display: "grid", gap: 13 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ color: current.alert_type === "GT_ASSIGNMENT_INFO" ? "#76d8a7" : "#71b8ee", fontSize: 10, fontWeight: 900, letterSpacing: ".12em" }}>{current.alert_type === "GT_ASSIGNMENT_INFO" ? "CARTEIRA · NOVA ATRIBUIÇÃO" : "ONBOARDING · PRÓXIMA AÇÃO"}</span>
            {pending.length > 1 && <span style={{ color: "#718ba0", fontSize: 10 }}>{pending.length} avisos pendentes</span>}
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.2 }}>{String(current.title || "Aviso de onboarding")}</h2>
            <p style={{ margin: 0, color: "#b4c9d8", fontSize: 13.2, lineHeight: 1.58 }}>{String(current.description || "")}</p>
          </div>
          {current.actor && current.actor !== "onboarding_engine" && <div style={{ border: "1px solid rgba(118,216,167,.16)", background: "rgba(38,103,74,.12)", borderRadius: 9, padding: "7px 9px", color: "#9fcbb5", fontSize: 10.5 }}>Ação registrada por: <b>{String(current.actor)}</b></div>}

          {canSchedule && scheduleOpen && <form onSubmit={(event) => { event.preventDefault(); resolveAlert(current, "MEETING_SCHEDULED"); }} style={{ border: "1px solid rgba(113,184,238,.24)", background: "rgba(14,42,62,.48)", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
            <div>
              <b style={{ display: "block", fontSize: 12.5 }}>Informe quando a reunião foi marcada</b>
              <span style={{ color: "#829daf", fontSize: 10.5 }}>Isso atualiza o onboarding real do cliente para reunião agendada.</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
              <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>Data
                <input type="date" required value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit", colorScheme: "dark" }} />
              </label>
              <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>Horário
                <input type="time" required value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit", colorScheme: "dark" }} />
              </label>
            </div>
            <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>Link do Google Meet <span style={{ color: "#6f8798" }}>(opcional)</span>
              <input type="url" inputMode="url" value={meetUrl} onChange={(event) => setMeetUrl(event.target.value)} placeholder="https://meet.google.com/abc-defg-hij" style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit" }} />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="submit" disabled={Boolean(busy)} style={{ flex: "1 1 210px", border: "1px solid rgba(91,190,145,.58)", background: busy === "MEETING_SCHEDULED" ? "#183328" : "#174c38", color: "#effff7", borderRadius: 9, padding: "10px 12px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 11.5, fontWeight: 850 }}>{busy === "MEETING_SCHEDULED" ? "Salvando…" : "Salvar reunião marcada"}</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => { setScheduleOpen(false); setError(""); }} style={{ border: "1px solid #31526b", background: "#0b2234", color: "#9eb8cb", borderRadius: 9, padding: "10px 12px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 11.5, fontWeight: 750 }}>Voltar</button>
            </div>
          </form>}

          <div style={{ color: "#718da2", fontSize: 10.3 }}>Este aviso continuará salvo na Central de Notificações após sua ciência.</div>
          {error && <div style={{ color: "#f8a9a9", fontSize: 11 }}>{error}</div>}

          {!scheduleOpen && <div style={{ display: "grid", gridTemplateColumns: canSchedule ? "minmax(0,1fr) minmax(0,1fr)" : "1fr", gap: 8 }}>
            <button type="button" disabled={Boolean(busy)} onClick={() => resolveAlert(current, "ACK")} autoFocus style={{ border: "1px solid rgba(91,190,145,.58)", background: busy === "ACK" ? "#183328" : "#174c38", color: "#effff7", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}>
              {busy === "ACK" ? "Registrando…" : String(current.ack_label || "Ciente")}
            </button>
            {canSchedule && <button type="button" disabled={Boolean(busy)} onClick={() => { setScheduleOpen(true); setError(""); }} style={{ border: "1px solid rgba(89,168,222,.5)", background: "#0c2b43", color: "#dff2ff", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}>Já marquei essa reunião</button>}
          </div>}
        </section>
      </div>,
      document.body
    )}
  </>;
}
