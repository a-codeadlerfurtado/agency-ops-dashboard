"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";
import type { Row } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-api`;
const RECOMMENDATION_API = `${SUPABASE_URL}/functions/v1/agency-ops-gt-recommendation-api`;

function shortName(name: unknown) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : (parts[0] || "GT");
}

function RecommendationBox({ recommendation }: { recommendation?: Row | null }) {
  if (!recommendation) return <div style={{ border: "1px dashed rgba(116,159,196,.3)", borderRadius: 9, padding: "9px 10px", color: "#7f9bb4", fontSize: 11 }}>Analisando perfil do cliente, reuniões, briefing, WhatsApp e carga das carteiras…</div>;
  const scores: Row[] = Array.isArray(recommendation.gt_scores) ? recommendation.gt_scores : [];
  const evidence: Row[] = Array.isArray(recommendation.evidence) ? recommendation.evidence : [];
  return <div style={{ border: "1px solid rgba(82,210,145,.26)", background: "rgba(20,77,55,.18)", borderRadius: 10, padding: 10, display: "grid", gap: 7 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
      <div>
        <div style={{ color: "#6fe3a9", fontSize: 9.5, fontWeight: 900, letterSpacing: ".11em" }}>SUGESTÃO DO SISTEMA · DECISÃO HUMANA OBRIGATÓRIA</div>
        <b style={{ display: "block", marginTop: 3, fontSize: 13.5, color: "#edfff5" }}>{shortName(recommendation.recommended_gt)} <span style={{ color: "#83d8ad", fontSize: 11, fontWeight: 700 }}>· {Number(recommendation.confidence || 0)}% confiança</span></b>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        <span style={{ border: "1px solid rgba(111,227,169,.2)", borderRadius: 999, padding: "3px 7px", color: "#b9d9c8", fontSize: 9.5 }}>Complexidade {String(recommendation.complexity_band || "—").toLowerCase()} · {Number(recommendation.complexity_score || 0)}/100</span>
        <span style={{ border: "1px solid rgba(111,227,169,.2)", borderRadius: 999, padding: "3px 7px", color: "#b9d9c8", fontSize: 9.5 }}>{String(recommendation.relationship_profile || "perfil não determinado")}</span>
      </div>
    </div>
    <p style={{ margin: 0, color: "#b7ccbf", fontSize: 10.8, lineHeight: 1.48 }}>{String(recommendation.rationale || "")}</p>
    {scores.length > 0 && <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{scores.map((score) => <span key={String(score.person)} style={{ borderRadius: 6, padding: "3px 6px", background: score.person === recommendation.recommended_gt ? "rgba(69,180,125,.18)" : "rgba(255,255,255,.035)", color: score.person === recommendation.recommended_gt ? "#8ce9b7" : "#8fa89c", fontSize: 9.5 }}>{shortName(score.person)} {Number(score.score || 0)} · carga {Number(score.weighted_load || 0).toFixed(1)}</span>)}</div>}
    {evidence.length > 0 && <details style={{ color: "#89a99a", fontSize: 9.8 }}><summary style={{ cursor: "pointer" }}>Ver evidências usadas ({evidence.length})</summary><div style={{ display: "grid", gap: 4, marginTop: 5 }}>{evidence.slice(0, 4).map((item, index) => <div key={`${item.source}-${item.label}-${index}`}><b style={{ color: "#9fc3b1" }}>{String(item.source)} · {String(item.label)}</b><span style={{ display: "block", color: "#799486" }}>{String(item.excerpt || "")}</span></div>)}</div></details>}
    <div style={{ color: "#81a393", fontSize: 9.8, fontWeight: 700 }}>A recomendação não altera a carteira. O GT só é atribuído quando você clicar em uma das opções abaixo.</div>
  </div>;
}

export default function OnboardingAssignmentBridge() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Row[]>([]);
  const [recommendations, setRecommendations] = useState<Record<string, Row>>({});
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
    const timer = window.setTimeout(load, 25_000);
    return () => window.clearTimeout(timer);
  }, [token, load]);

  useEffect(() => {
    if (!token || !items.length) { if (!items.length) setRecommendations({}); return; }
    let active = true;
    Promise.all(items.map(async (item) => {
      const requestId = String(item.metadata?.request_id || "");
      if (!requestId || !item.client_id) return null;
      try {
        const response = await fetch(RECOMMENDATION_API, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
          body: JSON.stringify({ request_id: requestId, client_id: item.client_id }),
          cache: "no-store",
        });
        const body = await response.json().catch(() => null);
        return response.ok && body?.recommendation ? [requestId, body.recommendation] as const : null;
      } catch { return null; }
    })).then((rows) => {
      if (!active) return;
      const next: Record<string, Row> = {};
      rows.forEach((entry) => { if (entry) next[entry[0]] = entry[1]; });
      setRecommendations(next);
    });
    return () => { active = false; };
  }, [token, items]);

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
      const updateButton = Array.from(document.querySelectorAll("button")).find((button) => (button.textContent || "").trim() === "Atualizar") as HTMLButtonElement | undefined;
      updateButton?.click();
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível atribuir o GT.");
      await load();
    } finally { setBusy(""); }
  }

  const first = items[0];
  const firstRequestId = String(first?.metadata?.request_id || "");
  const toastVisible = Boolean(first && hiddenToastId !== String(first.id));
  const onOnboardingPage = typeof window !== "undefined" && window.location.pathname === "/onboarding";

  const cards = useMemo(() => items.map((item) => {
    const options: Row[] = Array.isArray(item.metadata?.gt_options) ? item.metadata.gt_options : [];
    const requestId = String(item.metadata?.request_id || "");
    const recommendation = recommendations[requestId];
    return <div key={String(item.id)} style={{ border: "1px solid rgba(96,165,250,.28)", background: "rgba(8,24,43,.92)", borderRadius: 12, padding: 12, display: "grid", gap: 9 }}>
      <div style={{ display: "grid", gap: 3 }}>
        <b style={{ fontSize: 13 }}>{String(item.title || "Selecionar gestor de tráfego")}</b>
        <span style={{ fontSize: 12, lineHeight: 1.45, color: "#a9bed5" }}>{String(item.description || "Selecione o GT deste onboarding.")}</span>
      </div>
      <RecommendationBox recommendation={recommendation} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {options.map((option) => {
          const key = `${requestId}:${String(option.person)}`;
          const recommended = recommendation?.recommended_gt === option.person;
          return <button key={String(option.person)} disabled={Boolean(busy)} onClick={() => assign(item, String(option.person))} style={{ border: `1px solid ${recommended ? "#4bc486" : "#2f5d86"}`, background: busy === key ? "#17324b" : recommended ? "#123a2c" : "#0d2941", color: "#e7f3ff", borderRadius: 8, padding: "7px 10px", cursor: busy ? "wait" : "pointer", fontSize: 11.5, fontWeight: 700 }}>
            {busy === key ? "Atribuindo…" : `${recommended ? "★ " : ""}${shortName(option.person)}`}{option.carteira ? ` · ${option.carteira}` : ""}
          </button>;
        })}
      </div>
    </div>;
  }), [items, busy, recommendations]);

  if (!token || !items.length) return null;

  return <>
    {panelTarget && createPortal(<div style={{ display: "grid", gap: 9, marginBottom: 10 }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".12em", color: "#6ea9df" }}>ONBOARDING · AÇÃO NECESSÁRIA</div>{cards}{error && <div style={{ color: "#fca5a5", fontSize: 11 }}>{error}</div>}</div>, panelTarget)}
    {toastVisible && !onOnboardingPage && <aside style={{ position: "fixed", zIndex: 10050, right: 22, top: 92, width: "min(560px, calc(100vw - 44px))", maxHeight: "calc(100vh - 116px)", overflow: "auto", border: "1px solid #244767", background: "rgba(4,17,29,.98)", color: "#eff7ff", borderRadius: 14, padding: 14, boxShadow: "0 22px 70px rgba(0,0,0,.48)" }}>
      <button aria-label="Fechar por agora" onClick={() => setHiddenToastId(String(first.id))} style={{ position: "absolute", right: 10, top: 8, border: 0, background: "transparent", color: "#8ba8c3", fontSize: 18, cursor: "pointer" }}>×</button>
      <div style={{ color: "#65aef2", fontSize: 10, fontWeight: 800, letterSpacing: ".12em", marginBottom: 6 }}>ONBOARDING · SELECIONE O GT</div>
      <b style={{ display: "block", fontSize: 14, paddingRight: 24 }}>{String(first.client_display_name || first.title)}</b>
      <p style={{ margin: "5px 0 11px", color: "#a9bed5", fontSize: 12, lineHeight: 1.45 }}>{String(first.description || "Selecione o gestor de tráfego responsável.")}</p>
      <RecommendationBox recommendation={recommendations[firstRequestId]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
        {(Array.isArray(first.metadata?.gt_options) ? first.metadata.gt_options : []).map((option: Row) => {
          const key = `${firstRequestId}:${String(option.person)}`;
          const recommended = recommendations[firstRequestId]?.recommended_gt === option.person;
          return <button key={String(option.person)} disabled={Boolean(busy)} onClick={() => assign(first, String(option.person))} style={{ border: `1px solid ${recommended ? "#4bc486" : "#2f5d86"}`, background: recommended ? "#123a2c" : "#0d2941", color: "#e7f3ff", borderRadius: 8, padding: "8px 10px", cursor: busy ? "wait" : "pointer", fontSize: 11.5, fontWeight: 700 }}>
            {busy === key ? "Atribuindo…" : `${recommended ? "★ " : ""}${shortName(option.person)}`}{option.carteira ? ` · ${option.carteira}` : ""}
          </button>;
        })}
      </div>
      {items.length > 1 && <div style={{ marginTop: 10, color: "#7f9bb4", fontSize: 11 }}>+{items.length - 1} onboarding{items.length - 1 === 1 ? "" : "s"} aguardando definição.</div>}
      {error && <div style={{ marginTop: 8, color: "#fca5a5", fontSize: 11 }}>{error}</div>}
    </aside>}
  </>;
}
