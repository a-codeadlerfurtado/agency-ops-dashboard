"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";
import type { Row } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-required-alerts-api`;
const ADLER_USER_ID = "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";
const MEETING_STAGES = new Set(["INTRO_MEETING", "PRODUCT_PERSONA_MEETING", "INTEGRATION_MEETING"]);

function when(value: unknown) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
}

function localParts(value?: unknown) {
  const d = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

export default function OnboardingRequiredAlerts() {
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [busy, setBusy] = useState<"" | "ACK" | "MEETING_SCHEDULED" | "MEETING_COMPLETED">("");
  const [error, setError] = useState("");
  const [panelTarget, setPanelTarget] = useState<Element | null>(null);
  const [formMode, setFormMode] = useState<"" | "schedule" | "complete">("");
  const [actionDate, setActionDate] = useState("");
  const [actionTime, setActionTime] = useState("");
  const [meetUrl, setMeetUrl] = useState("");
  const [profilePerson, setProfilePerson] = useState("");
  const [explicitAlertId, setExplicitAlertId] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) {
      setPending([]);
      setHistory([]);
      return;
    }
    try {
      const response = await authenticatedFetch(API_URL, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) return;
      setPending(Array.isArray(body.pending) ? body.pending : []);
      setHistory(Array.isArray(body.history) ? body.history : []);
      setProfilePerson(String(body?.profile?.person || ""));
      setError("");
    } catch {
      // Aviso auxiliar: nunca derruba o dashboard principal.
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session?.access_token, load]);

  useEffect(() => {
    const find = () => setPanelTarget(document.querySelector(".notification-list"));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const isAdler = session?.user?.id === ADLER_USER_ID || profilePerson === "Adler Furtado";
  const current = isAdler
    ? (explicitAlertId ? pending.find((item) => String(item.id) === explicitAlertId) || null : null)
    : (pending[0] || null);

  const actionType = String(current?.metadata?.action_type || "");
  const targetStage = String(current?.metadata?.target_stage || "");
  const isMeetingAlert = MEETING_STAGES.has(targetStage);
  const canSchedule = Boolean(isMeetingAlert && ["SCHEDULE_MEETING", "CONFIRM_MEETING_OUTCOME"].includes(actionType));
  const canComplete = Boolean(isMeetingAlert);

  useEffect(() => {
    setFormMode("");
    setActionDate("");
    setActionTime("");
    setMeetUrl("");
    setError("");
  }, [current?.id]);

  useEffect(() => {
    if (!isAdler) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ alertId?: string }>).detail;
      const alertId = String(detail?.alertId || "").trim();
      if (alertId) setExplicitAlertId(alertId);
    };
    window.addEventListener("open-onboarding-required-alert", handler as EventListener);
    return () => window.removeEventListener("open-onboarding-required-alert", handler as EventListener);
  }, [isAdler]);

  function openForm(mode: "schedule" | "complete") {
    setFormMode(mode);
    setError("");
    if (mode === "complete") {
      const defaults = localParts();
      setActionDate(defaults.date);
      setActionTime(defaults.time);
      setMeetUrl("");
      return;
    }
    const defaults = localParts(current?.metadata?.scheduled_for);
    setActionDate(actionType === "CONFIRM_MEETING_OUTCOME" ? "" : defaults.date);
    setActionTime(actionType === "CONFIRM_MEETING_OUTCOME" ? "" : defaults.time);
  }

  async function resolveAlert(alert: Row, action: "ACK" | "MEETING_SCHEDULED" | "MEETING_COMPLETED") {
    if (busy) return;

    if (action !== "ACK") {
      if (!actionDate || !actionTime) {
        setError(action === "MEETING_COMPLETED"
          ? "Informe a data e o horário em que a reunião foi realizada."
          : "Informe a data e o horário da reunião.");
        return;
      }
      if (action === "MEETING_SCHEDULED" && meetUrl.trim() && !/^https:\/\/meet\.google\.com\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(meetUrl.trim())) {
        setError("Informe um link válido do Google Meet ou deixe o campo vazio.");
        return;
      }
    }

    setBusy(action);
    setError("");
    try {
      const body = action === "MEETING_SCHEDULED"
        ? {
            id: alert.id,
            action,
            scheduled_date: actionDate,
            scheduled_time: actionTime,
            meet_url: meetUrl.trim() || undefined,
          }
        : action === "MEETING_COMPLETED"
          ? {
              id: alert.id,
              action,
              completed_date: actionDate,
              completed_time: actionTime,
            }
          : { id: alert.id, action };

      const response = await authenticatedFetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok || !responseBody?.ok) {
        throw new Error(responseBody?.detail || responseBody?.error || "Não foi possível registrar a ação.");
      }

      await load();
      setExplicitAlertId("");
      setFormMode("");
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: responseBody }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível registrar a ação.");
    } finally {
      setBusy("");
    }
  }

  const primaryAckLabel = current
    ? actionType === "SCHEDULE_MEETING"
      ? "Ainda não marquei"
      : actionType === "CONFIRM_MEETING_OUTCOME"
        ? "Ainda não confirmei"
        : String(current.ack_label || "Ciente")
    : "Ciente";

  return <>
    {panelTarget && history.length > 0 && createPortal(
      <section style={{ borderTop: "1px solid rgba(111,159,194,.16)", marginTop: 8, paddingTop: 10, display: "grid", gap: 7 }}>
        <div style={{ color: "#73aee0", fontSize: 9.5, fontWeight: 900, letterSpacing: ".11em" }}>ONBOARDING · AVISOS DE CIÊNCIA</div>
        {history.slice(0, 20).map((item) => {
          const scheduled = item.metadata?.scheduled_for;
          const completed = item.metadata?.completed_at;
          const clickable = isAdler && !item.acknowledged_at && item.ack_required !== false;
          const Tag = clickable ? "button" : "div";
          return <Tag
            key={String(item.id)}
            {...(clickable ? { type: "button" as const, onClick: () => setExplicitAlertId(String(item.id)) } : {})}
            style={{ border: "1px solid rgba(92,145,183,.2)", background: "rgba(8,25,39,.56)", borderRadius: 9, padding: "8px 9px", display: "grid", gap: 3, width: "100%", textAlign: "left", color: "inherit", font: "inherit", cursor: clickable ? "pointer" : "default" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <b style={{ color: "#dcebfa", fontSize: 11 }}>{String(item.title || "Aviso de onboarding")}</b>
              <span style={{ color: item.acknowledged_at ? "#76cfa0" : "#f2c06b", fontSize: 9, fontWeight: 800, whiteSpace: "nowrap" }}>
                {item.acknowledged_at ? "CIENTE" : "AGUARDANDO CIÊNCIA"}
              </span>
            </div>
            <span style={{ color: "#8faabd", fontSize: 10.3, lineHeight: 1.4 }}>{String(item.description || "")}</span>
            {(scheduled || completed) && <div style={{ marginTop: 2, borderLeft: "2px solid rgba(118,207,160,.55)", paddingLeft: 7, display: "grid", gap: 2 }}>
              {scheduled && <span style={{ color: "#91c9aa", fontSize: 10, fontWeight: 750 }}>Reunião marcada: {when(scheduled)}</span>}
              {completed && <span style={{ color: "#91c9aa", fontSize: 10, fontWeight: 750 }}>Reunião realizada: {when(completed)}</span>}
              {item.metadata?.acknowledged_person && <small style={{ color: "#6f9180", fontSize: 9 }}>Informado por {String(item.metadata.acknowledged_person)}</small>}
              {item.metadata?.meet_url && <a href={String(item.metadata.meet_url)} target="_blank" rel="noreferrer" style={{ color: "#74bdf0", fontSize: 9.5, width: "fit-content" }}>Abrir Google Meet</a>}
            </div>}
            <small style={{ color: "#637f94", fontSize: 9 }}>{when(item.occurred_at)}</small>
          </Tag>;
        })}
      </section>,
      panelTarget
    )}

    {current && createPortal(
      <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 20000, background: "rgba(1,8,14,.78)", backdropFilter: "blur(7px)", display: "grid", placeItems: "center", padding: 18 }}>
        <section role="dialog" aria-modal="true" aria-label="Aviso obrigatório de onboarding" style={{ width: "min(620px, 100%)", maxHeight: "calc(100vh - 36px)", overflow: "auto", border: "1px solid rgba(75,159,214,.4)", background: "linear-gradient(180deg,rgba(7,25,39,.99),rgba(4,16,27,.99))", color: "#eef8ff", borderRadius: 17, boxShadow: "0 28px 90px rgba(0,0,0,.62)", padding: 20, display: "grid", gap: 13 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ color: current.alert_type === "GT_ASSIGNMENT_INFO" ? "#76d8a7" : "#71b8ee", fontSize: 10, fontWeight: 900, letterSpacing: ".12em" }}>
              {current.alert_type === "GT_ASSIGNMENT_INFO" ? "CARTEIRA · NOVA ATRIBUIÇÃO" : "ONBOARDING · AÇÃO OBRIGATÓRIA"}
            </span>
            {pending.length > 1 && <span style={{ color: "#718ba0", fontSize: 10 }}>{pending.length} avisos pendentes</span>}
          </div>

          <div style={{ display: "grid", gap: 7 }}>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.2 }}>{String(current.title || "Aviso de onboarding")}</h2>
            <p style={{ margin: 0, color: "#b4c9d8", fontSize: 13.2, lineHeight: 1.58 }}>{String(current.description || "")}</p>
          </div>

          {current.actor && current.actor !== "onboarding_engine" && current.actor !== "onboarding_meeting_guardrail" && <div style={{ border: "1px solid rgba(118,216,167,.16)", background: "rgba(38,103,74,.12)", borderRadius: 9, padding: "7px 9px", color: "#9fcbb5", fontSize: 10.5 }}>
            Ação registrada por: <b>{String(current.actor)}</b>
          </div>}

          {formMode && <form
            onSubmit={(event) => {
              event.preventDefault();
              void resolveAlert(current, formMode === "complete" ? "MEETING_COMPLETED" : "MEETING_SCHEDULED");
            }}
            style={{ border: "1px solid rgba(113,184,238,.24)", background: "rgba(14,42,62,.48)", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}
          >
            <div>
              <b style={{ display: "block", fontSize: 12.5 }}>
                {formMode === "complete" ? "Informe quando a reunião foi realizada" : "Informe quando a reunião está marcada ou foi reagendada"}
              </b>
              <span style={{ color: "#829daf", fontSize: 10.5 }}>
                {formMode === "complete"
                  ? "Isso encerra a etapa da reunião e libera automaticamente a próxima cobrança do onboarding."
                  : "Isso atualiza o onboarding real do cliente e ativa os lembretes da reunião."}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
              <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>
                Data
                <input type="date" required value={actionDate} onChange={(event) => setActionDate(event.target.value)} style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit", colorScheme: "dark" }} />
              </label>
              <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>
                Horário
                <input type="time" required value={actionTime} onChange={(event) => setActionTime(event.target.value)} style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit", colorScheme: "dark" }} />
              </label>
            </div>

            {formMode === "schedule" && <label style={{ display: "grid", gap: 4, color: "#a9bfd0", fontSize: 10.5 }}>
              Link do Google Meet <span style={{ color: "#6f8798" }}>(opcional)</span>
              <input type="url" inputMode="url" value={meetUrl} onChange={(event) => setMeetUrl(event.target.value)} placeholder="https://meet.google.com/abc-defg-hij" style={{ border: "1px solid #31526b", background: "#071a29", color: "#eef8ff", borderRadius: 8, padding: "9px 10px", font: "inherit" }} />
            </label>}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="submit" disabled={Boolean(busy)} style={{ flex: "1 1 210px", border: "1px solid rgba(91,190,145,.58)", background: busy ? "#183328" : "#174c38", color: "#effff7", borderRadius: 9, padding: "10px 12px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 11.5, fontWeight: 850 }}>
                {busy
                  ? "Salvando…"
                  : formMode === "complete"
                    ? "Confirmar reunião realizada"
                    : "Salvar reunião marcada / reagendada"}
              </button>
              <button type="button" disabled={Boolean(busy)} onClick={() => { setFormMode(""); setError(""); }} style={{ border: "1px solid #31526b", background: "#0b2234", color: "#9eb8cb", borderRadius: 9, padding: "10px 12px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 11.5, fontWeight: 750 }}>
                Voltar
              </button>
            </div>
          </form>}

          <div style={{ color: "#718da2", fontSize: 10.3 }}>Este aviso continuará salvo na Central de Notificações após sua ciência.</div>
          {error && <div style={{ color: "#f8a9a9", fontSize: 11 }}>{error}</div>}

          {!formMode && <div style={{ display: "grid", gridTemplateColumns: canSchedule || canComplete ? "repeat(auto-fit,minmax(170px,1fr))" : "1fr", gap: 8 }}>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void resolveAlert(current, "ACK")}
              autoFocus
              style={{ border: "1px solid rgba(91,190,145,.58)", background: busy === "ACK" ? "#183328" : "#174c38", color: "#effff7", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}
            >
              {busy === "ACK" ? "Registrando…" : primaryAckLabel}
            </button>

            {canSchedule && <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => openForm("schedule")}
              style={{ border: "1px solid rgba(89,168,222,.5)", background: "#0c2b43", color: "#dff2ff", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}
            >
              {actionType === "CONFIRM_MEETING_OUTCOME" ? "Foi reagendada / já está marcada" : "Já marquei essa reunião"}
            </button>}

            {canComplete && <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => openForm("complete")}
              style={{ border: "1px solid rgba(202,166,91,.55)", background: "#443310", color: "#fff4d7", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}
            >
              Já foi realizada
            </button>}
          </div>}
        </section>
      </div>,
      document.body
    )}
  </>;
}
