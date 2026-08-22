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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panelTarget, setPanelTarget] = useState<Element | null>(null);

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

  async function acknowledge(alert: Row) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await authenticatedFetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: alert.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || "Não foi possível registrar sua ciência.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível registrar sua ciência.");
    } finally { setBusy(false); }
  }

  const current = pending[0] || null;

  return <>
    {panelTarget && history.length > 0 && createPortal(
      <section style={{ borderTop: "1px solid rgba(111,159,194,.16)", marginTop: 8, paddingTop: 10, display: "grid", gap: 7 }}>
        <div style={{ color: "#73aee0", fontSize: 9.5, fontWeight: 900, letterSpacing: ".11em" }}>ONBOARDING · AVISOS DE CIÊNCIA</div>
        {history.slice(0, 20).map((item) => <div key={String(item.id)} style={{ border: "1px solid rgba(92,145,183,.2)", background: "rgba(8,25,39,.56)", borderRadius: 9, padding: "8px 9px", display: "grid", gap: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <b style={{ color: "#dcebfa", fontSize: 11 }}>{String(item.title || "Aviso de onboarding")}</b>
            <span style={{ color: item.acknowledged_at ? "#76cfa0" : "#f2c06b", fontSize: 9, fontWeight: 800, whiteSpace: "nowrap" }}>{item.acknowledged_at ? "CIENTE" : "AGUARDANDO CIÊNCIA"}</span>
          </div>
          <span style={{ color: "#8faabd", fontSize: 10.3, lineHeight: 1.4 }}>{String(item.description || "")}</span>
          <small style={{ color: "#637f94", fontSize: 9 }}>{when(item.occurred_at)}</small>
        </div>)}
      </section>,
      panelTarget
    )}

    {current && createPortal(
      <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 20000, background: "rgba(1,8,14,.78)", backdropFilter: "blur(7px)", display: "grid", placeItems: "center", padding: 18 }}>
        <section role="dialog" aria-modal="true" aria-label="Aviso obrigatório de onboarding" style={{ width: "min(590px, 100%)", border: "1px solid rgba(75,159,214,.4)", background: "linear-gradient(180deg,rgba(7,25,39,.99),rgba(4,16,27,.99))", color: "#eef8ff", borderRadius: 17, boxShadow: "0 28px 90px rgba(0,0,0,.62)", padding: 20, display: "grid", gap: 13 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ color: current.alert_type === "GT_ASSIGNMENT_INFO" ? "#76d8a7" : "#71b8ee", fontSize: 10, fontWeight: 900, letterSpacing: ".12em" }}>{current.alert_type === "GT_ASSIGNMENT_INFO" ? "CARTEIRA · NOVA ATRIBUIÇÃO" : "ONBOARDING · PRÓXIMA AÇÃO"}</span>
            {pending.length > 1 && <span style={{ color: "#718ba0", fontSize: 10 }}>{pending.length} avisos pendentes</span>}
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.2 }}>{String(current.title || "Aviso de onboarding")}</h2>
            <p style={{ margin: 0, color: "#b4c9d8", fontSize: 13.2, lineHeight: 1.58 }}>{String(current.description || "")}</p>
          </div>
          {current.actor && current.actor !== "onboarding_engine" && <div style={{ border: "1px solid rgba(118,216,167,.16)", background: "rgba(38,103,74,.12)", borderRadius: 9, padding: "7px 9px", color: "#9fcbb5", fontSize: 10.5 }}>Ação registrada por: <b>{String(current.actor)}</b></div>}
          <div style={{ color: "#718da2", fontSize: 10.3 }}>Este aviso continuará salvo na Central de Notificações após sua ciência.</div>
          {error && <div style={{ color: "#f8a9a9", fontSize: 11 }}>{error}</div>}
          <button type="button" disabled={busy} onClick={() => acknowledge(current)} autoFocus style={{ border: "1px solid rgba(91,190,145,.58)", background: busy ? "#183328" : "#174c38", color: "#effff7", borderRadius: 10, padding: "11px 14px", cursor: busy ? "wait" : "pointer", font: "inherit", fontSize: 12.5, fontWeight: 850 }}>
            {busy ? "Registrando…" : String(current.ack_label || "Ciente")}
          </button>
        </section>
      </div>,
      document.body
    )}
  </>;
}
