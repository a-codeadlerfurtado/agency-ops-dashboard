"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";
import type { Row } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-api`;

function shortName(name: unknown) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : (parts[0] || "GT");
}

export default function OnboardingAssignmentBridge() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Row[]>([]);
  const [panelTarget, setPanelTarget] = useState<Element | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [hiddenToastId, setHiddenToastId] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token || ""));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setToken(session?.access_token || ""));
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!token) { setItems([]); return; }
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      if (!response.ok) { setItems([]); return; }
      const body = await response.json();
      setItems(Array.isArray(body.assignment_notifications) ? body.assignment_notifications : []);
      setError("");
    } catch {
      // A ponte de notificação nunca derruba o dashboard principal.
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    load();
    const timer = window.setInterval(load, 30_000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [token, load]);

  useEffect(() => {
    const findPanel = () => setPanelTarget(document.querySelector(".notification-list"));
    findPanel();
    const observer = new MutationObserver(findPanel);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  async function assign(item: Row, gtOwner: string) {
    const requestId = String(item.metadata?.request_id || "");
    if (!requestId || !item.client_id) return;
    const actionKey = `${requestId}:${gtOwner}`;
    setBusy(actionKey); setError("");
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request_id: requestId, client_id: item.client_id, gt_owner: gtOwner }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || "Não foi possível atribuir o GT.");
      setHiddenToastId("");
      await load();
      // Força a atualização imediata da tela principal sem esperar o polling de 30s.
      const updateButton = Array.from(document.querySelectorAll("button")).find((button) => (button.textContent || "").trim() === "Atualizar") as HTMLButtonElement | undefined;
      updateButton?.click();
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível atribuir o GT.");
      await load();
    } finally { setBusy(""); }
  }

  const first = items[0];
  const toastVisible = Boolean(first && hiddenToastId !== String(first.id));
  const onOnboardingPage = typeof window !== "undefined" && window.location.pathname === "/onboarding";

  const cards = useMemo(() => items.map((item) => {
    const options: Row[] = Array.isArray(item.metadata?.gt_options) ? item.metadata.gt_options : [];
    return <div key={String(item.id)} style={{ border: "1px solid rgba(96,165,250,.28)", background: "rgba(8,24,43,.92)", borderRadius: 12, padding: 12, display: "grid", gap: 9 }}>
      <div style={{ display: "grid", gap: 3 }}>
        <b style={{ fontSize: 13 }}>{String(item.title || "Selecionar gestor de tráfego")}</b>
        <span style={{ fontSize: 12, lineHeight: 1.45, color: "#a9bed5" }}>{String(item.description || "Selecione o GT deste onboarding.")}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {options.map((option) => {
          const key = `${String(item.metadata?.request_id)}:${String(option.person)}`;
          return <button key={String(option.person)} disabled={Boolean(busy)} onClick={() => assign(item, String(option.person))} style={{ border: "1px solid #2f5d86", background: busy === key ? "#17324b" : "#0d2941", color: "#e7f3ff", borderRadius: 8, padding: "7px 10px", cursor: busy ? "wait" : "pointer", fontSize: 11.5, fontWeight: 700 }}>
            {busy === key ? "Atribuindo…" : shortName(option.person)}{option.carteira ? ` · ${option.carteira}` : ""}
          </button>;
        })}
      </div>
    </div>;
  }), [items, busy]);

  if (!token || !items.length) return null;

  return <>
    {panelTarget && createPortal(<div style={{ display: "grid", gap: 9, marginBottom: 10 }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".12em", color: "#6ea9df" }}>ONBOARDING · AÇÃO NECESSÁRIA</div>{cards}{error && <div style={{ color: "#fca5a5", fontSize: 11 }}>{error}</div>}</div>, panelTarget)}
    {toastVisible && !onOnboardingPage && <aside style={{ position: "fixed", zIndex: 10050, right: 22, top: 92, width: "min(520px, calc(100vw - 44px))", border: "1px solid #244767", background: "rgba(4,17,29,.98)", color: "#eff7ff", borderRadius: 14, padding: 14, boxShadow: "0 22px 70px rgba(0,0,0,.48)" }}>
      <button aria-label="Fechar por agora" onClick={() => setHiddenToastId(String(first.id))} style={{ position: "absolute", right: 10, top: 8, border: 0, background: "transparent", color: "#8ba8c3", fontSize: 18, cursor: "pointer" }}>×</button>
      <div style={{ color: "#65aef2", fontSize: 10, fontWeight: 800, letterSpacing: ".12em", marginBottom: 6 }}>ONBOARDING · SELECIONE O GT</div>
      <b style={{ display: "block", fontSize: 14, paddingRight: 24 }}>{String(first.client_display_name || first.title)}</b>
      <p style={{ margin: "5px 0 11px", color: "#a9bed5", fontSize: 12, lineHeight: 1.45 }}>{String(first.description || "Selecione o gestor de tráfego responsável.")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {(Array.isArray(first.metadata?.gt_options) ? first.metadata.gt_options : []).map((option: Row) => {
          const key = `${String(first.metadata?.request_id)}:${String(option.person)}`;
          return <button key={String(option.person)} disabled={Boolean(busy)} onClick={() => assign(first, String(option.person))} style={{ border: "1px solid #2f5d86", background: "#0d2941", color: "#e7f3ff", borderRadius: 8, padding: "8px 10px", cursor: busy ? "wait" : "pointer", fontSize: 11.5, fontWeight: 700 }}>
            {busy === key ? "Atribuindo…" : shortName(option.person)}{option.carteira ? ` · ${option.carteira}` : ""}
          </button>;
        })}
      </div>
      {items.length > 1 && <div style={{ marginTop: 10, color: "#7f9bb4", fontSize: 11 }}>+{items.length - 1} onboarding{items.length - 1 === 1 ? "" : "s"} aguardando definição.</div>}
      {error && <div style={{ marginTop: 8, color: "#fca5a5", fontSize: 11 }}>{error}</div>}
    </aside>}
  </>;
}
