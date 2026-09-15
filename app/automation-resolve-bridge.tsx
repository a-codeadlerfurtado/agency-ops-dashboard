"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_URL, authenticatedFetch, formatDate, text } from "./shared";

type Row = Record<string, any>;

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-automation-health-api`;

function normalize(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
}

function leadIssueSummary(item: Row) {
  const required = Array.isArray(item.missing_required) ? item.missing_required.map(String) : [];
  const extras = Array.isArray(item.missing_extra_questions) ? item.missing_extra_questions : [];
  const parts = [
    ...required.map((field) => `${field} ausente ou inválido`),
    ...extras.map((row: Row) => `sem resposta em “${text(row?.question || "pergunta adicional")}”`),
  ];
  return parts.length ? parts.join(" · ") : text(item.detail || "Dado incompleto detectado");
}

function chooseIssue(payload: Row, title: string, detail: string): Row | null {
  const titleKey = normalize(title);
  const detailKey = normalize(detail);
  if (!titleKey) return null;

  const automations: Row[] = payload.automations || [];
  const automation = automations.find((item) => normalize(item.friendly_name) === titleKey);
  if (automation) return { ...automation, kind: "AUTOMATION", title: automation.friendly_name };

  const timeline: Row[] = payload.timeline || [];
  const titleMatches = timeline.filter((item) => normalize(item.title) === titleKey);
  const exact = titleMatches.filter((item) => {
    const candidateDetail = item.kind === "LEAD_DATA" ? leadIssueSummary(item) : text(item.detail || item.error || "");
    return normalize(candidateDetail) === detailKey;
  });

  const candidates = exact.length ? exact : titleMatches;
  if (!candidates.length) return null;

  const keys = new Set(candidates.map((item) => String(item.issue_key || "")).filter(Boolean));
  if (keys.size > 1) return null;
  return candidates[0];
}

export default function AutomationResolveBridge() {
  const [modal, setModal] = useState<HTMLElement | null>(null);
  const [payload, setPayload] = useState<Row | null>(null);
  const [issue, setIssue] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const readModal = useCallback((node: HTMLElement | null) => {
    if (!node) return { title: "", detail: "" };
    return {
      title: node.querySelector("header h3")?.textContent?.trim() || "",
      detail: node.querySelector("header p")?.textContent?.trim() || "",
    };
  }, []);

  const load = useCallback(async (node: HTMLElement) => {
    const { title, detail } = readModal(node);
    if (!title) return;
    setLoading(true);
    setError("");
    try {
      const url = new URL(API_URL);
      url.searchParams.set("days", "30");
      const response = await authenticatedFetch(url, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
      const selected = chooseIssue(body, title, detail);
      setIssue(selected);
      setDone(Boolean(selected?.dashboard_resolved || String(selected?.status || "").toUpperCase() === "RESOLVED"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível identificar a ocorrência.");
      setIssue(null);
    } finally {
      setLoading(false);
    }
  }, [readModal]);

  useEffect(() => {
    let last: HTMLElement | null = null;
    let timer = 0;
    const inspect = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = document.querySelector<HTMLElement>(".ah-modal");
        if (next === last) return;
        last = next;
        setModal(next);
        setIssue(null);
        setPayload(null);
        setDone(false);
        setError("");
        if (next) load(next);
      }, 30);
    };
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [load]);

  const incidentIds = useMemo(() => {
    if (!issue || issue.kind !== "LEAD_DATA" || !payload) return [] as string[];
    return (payload.incidents || [])
      .filter((item: Row) => String(item.issue_key || "") === String(issue.issue_key || "") && !item.dashboard_resolved)
      .map((item: Row) => String(item.id))
      .filter(Boolean);
  }, [issue, payload]);

  async function resolve() {
    if (!issue || resolving) return;
    const issueKey = String(issue.issue_key || "").trim();
    if (!issueKey) {
      setError("Não foi possível identificar este problema com segurança para dar baixa.");
      return;
    }

    setResolving(true);
    setError("");
    try {
      const response = await authenticatedFetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          issue_key: issueKey,
          issue_kind: issue.kind || "ISSUE",
          reference_id: issue.id || issue.job_name || null,
          incident_ids: incidentIds,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setDone(true);
      setIssue((current) => current ? { ...current, dashboard_resolved: true, status: "RESOLVED", resolved_at: body.resolved_at, resolved_by: body.resolved_by } : current);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível marcar como resolvido.");
    } finally {
      setResolving(false);
    }
  }

  if (!modal) return null;

  return createPortal(<>
    <style>{styles}</style>
    <div className={`ahr-box${done ? " resolved" : ""}`}>
      {done ? <>
        <div className="ahr-icon">✓</div>
        <div className="ahr-copy"><b>Resolvido</b><span>{issue?.resolved_by ? `Baixa registrada por ${text(issue.resolved_by)}` : "Baixa registrada"}{issue?.resolved_at ? ` · ${formatDate(issue.resolved_at)}` : ""}</span></div>
      </> : <>
        <div className="ahr-copy"><b>Já corrigiu este problema?</b><span>Marque como resolvido para tirar da fila de pendências. Se o mesmo erro acontecer novamente depois desta baixa, ele volta automaticamente.</span></div>
        <button type="button" onClick={resolve} disabled={loading || resolving || !issue}>{resolving ? "Salvando…" : loading ? "Identificando…" : "✓ Marcar como resolvido"}</button>
      </>}
      {error && <small className="ahr-error">{error}</small>}
    </div>
  </>, modal);
}

const styles = `
.ahr-box{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;margin-top:14px;border:1px solid #2f5f4c;background:linear-gradient(135deg,#0d241c,#081a16);border-radius:13px;padding:12px 13px}.ahr-copy b,.ahr-copy span{display:block}.ahr-copy b{font-size:11px;color:#d9f5e8}.ahr-copy span{margin-top:3px;font-size:9px;line-height:1.4;color:#83aa99;max-width:690px}.ahr-box button{border:1px solid #3d8669;background:#174c39;color:#dff8ed;border-radius:10px;padding:10px 13px;font-size:10px;font-weight:900;cursor:pointer;white-space:nowrap}.ahr-box button:hover{background:#1d5c45}.ahr-box button:disabled{opacity:.5;cursor:not-allowed}.ahr-box.resolved{grid-template-columns:34px minmax(0,1fr);border-color:#3a7c61;background:#0d291f}.ahr-icon{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;background:#1a553f;color:#83e1b8;font-size:18px;font-weight:900}.ahr-error{grid-column:1/-1;color:#ff9da7;font-size:9px}@media(max-width:680px){.ahr-box{grid-template-columns:1fr}.ahr-box button{width:100%}.ahr-box.resolved{grid-template-columns:34px 1fr}}
`;
