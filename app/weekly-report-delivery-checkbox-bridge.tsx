"use client";

import { useEffect, useRef, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

const REPORTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-weekly-reports-api`;
const DELIVERY_API = `${SUPABASE_URL}/functions/v1/agency-ops-weekly-report-delivery-api`;
const STYLE_ID = "weekly-report-delivery-checkbox-style";

function norm(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .wr-delivery-check{display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:0 10px;border:1px solid #32404a;border-radius:10px;background:#10191f;color:#9fb0bb;font-size:10px;font-weight:850;line-height:1.2;cursor:pointer;user-select:none;white-space:nowrap;transition:border-color .15s ease,background .15s ease,color .15s ease}
    .wr-delivery-check:hover{border-color:#526774;color:#dce6eb}
    .wr-delivery-check input{width:16px;height:16px;margin:0;accent-color:#45c983;cursor:pointer;flex:0 0 auto}
    .wr-delivery-check.checked{border-color:#2a6c4b;background:#0d2519;color:#92e8b6}
    .wr-delivery-check.busy{opacity:.6;cursor:wait}
    .wr-delivery-check.error{border-color:#81423e;color:#ffaaa2;background:#291513}
    @media(max-width:760px){.wr-delivery-check{width:100%;justify-content:center;min-height:42px}}
  `;
  document.head.appendChild(style);
}

export default function WeeklyReportDeliveryCheckboxBridge() {
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState(false);
  const cacheRef = useRef<{ key: string; reports: Row[] }>({ key: "", reports: [] });
  const fetchingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setToken(data.session?.access_token || "");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setToken(session?.access_token || ""));
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!token) { setAllowed(false); return; }
    let alive = true;
    fetch(`${REPORTS_API}?probe=1`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" })
      .then(async (response) => {
        if (!alive || !response.ok) { setAllowed(false); return; }
        const body = await response.json().catch(() => ({}));
        const role = String(body?.profile?.role || "").toUpperCase();
        setAllowed(role === "GT" || role === "MGMT");
      })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (!allowed || !token || window.location.pathname !== "/") return;
    ensureStyle();
    let frame = 0;
    let stopped = false;

    const headers = { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };

    const removeAll = () => document.querySelectorAll("[data-weekly-delivery-check]").forEach((node) => node.remove());

    const currentContext = () => {
      const workspace = document.querySelector<HTMLElement>(".weekly-reports-workspace");
      const periodSelect = workspace?.querySelector<HTMLSelectElement>(".wr-periodbar select.control");
      if (!workspace || !periodSelect) return null;
      const selectedText = norm(periodSelect.selectedOptions?.[0]?.textContent || "");
      if (!selectedText.includes("semanal")) return { weekly: false, workspace, periodSelect, start: "", end: "", gt: "" };
      const [start, end] = String(periodSelect.value || "").split("|");
      const gtSelect = workspace.querySelector<HTMLSelectElement>(".wr-head .wr-actions select.control");
      return { weekly: true, workspace, periodSelect, start: start || "", end: end || "", gt: String(gtSelect?.value || "") };
    };

    const postDelivery = async (reportId: string, sent: boolean) => {
      const response = await fetch(DELIVERY_API, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ report_id: reportId, sent }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      return body;
    };

    const renderChecks = (workspace: HTMLElement, reports: Row[]) => {
      const byClient = new Map(reports.map((report) => [norm(report.client_name), report]));
      workspace.querySelectorAll<HTMLElement>(".wr-row").forEach((row) => {
        const name = norm(row.querySelector<HTMLElement>(".wr-client > b")?.textContent);
        const report = byClient.get(name);
        const actions = row.querySelector<HTMLElement>(".wr-row-actions");
        const existing = row.querySelector<HTMLLabelElement>("[data-weekly-delivery-check]");
        if (!report || report.report_kind !== "WEEKLY" || !report.public_path || !actions) { existing?.remove(); return; }
        let label = existing;
        if (!label) {
          label = document.createElement("label");
          label.dataset.weeklyDeliveryCheck = "true";
          label.className = "wr-delivery-check";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.setAttribute("aria-label", `Marcar relatório de ${report.client_name} como enviado`);
          const text = document.createElement("span");
          text.textContent = "Enviado ao cliente";
          label.append(input, text);
          actions.prepend(label);
          input.addEventListener("change", async () => {
            const desired = input.checked;
            input.disabled = true;
            label!.classList.add("busy");
            label!.classList.remove("error");
            try {
              const result = await postDelivery(String(report.id), desired);
              report.shared_at = result.shared_at || null;
              label!.classList.toggle("checked", desired);
              cacheRef.current.reports = cacheRef.current.reports.map((item) => String(item.id) === String(report.id) ? { ...item, shared_at: result.shared_at || null } : item);
            } catch {
              input.checked = !desired;
              label!.classList.add("error");
            } finally {
              input.disabled = false;
              label!.classList.remove("busy");
            }
          });
        }
        const input = label.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (input && !input.disabled) input.checked = Boolean(report.shared_at);
        label.classList.toggle("checked", Boolean(report.shared_at));
      });
    };

    const sync = async () => {
      if (stopped) return;
      const ctx = currentContext();
      if (!ctx) { removeAll(); return; }
      if (!ctx.weekly || !ctx.start || !ctx.end) { removeAll(); return; }
      const key = `${ctx.start}|${ctx.end}|${ctx.gt}`;
      if (cacheRef.current.key === key && cacheRef.current.reports.length) {
        renderChecks(ctx.workspace, cacheRef.current.reports);
        return;
      }
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const params = new URLSearchParams({ period_start: ctx.start, period_end: ctx.end });
        if (ctx.gt) params.set("gt", ctx.gt);
        const response = await fetch(`${REPORTS_API}?${params}`, { headers, cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return;
        const reports = Array.isArray(body?.reports) ? body.reports : [];
        cacheRef.current = { key, reports };
        renderChecks(ctx.workspace, reports);
      } finally {
        fetchingRef.current = false;
      }
    };

    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => void sync());
    };

    const onChange = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".weekly-reports-workspace")) return;
      cacheRef.current.key = "";
      schedule();
    };
    const onClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest?.("button") as HTMLButtonElement | null;
      if (!button || !button.closest(".weekly-reports-workspace") || !norm(button.textContent).startsWith("copiar link")) return;
      const row = button.closest<HTMLElement>(".wr-row");
      const checkbox = row?.querySelector<HTMLInputElement>("[data-weekly-delivery-check] input[type=checkbox]");
      const label = row?.querySelector<HTMLElement>("[data-weekly-delivery-check]");
      if (checkbox) checkbox.checked = true;
      label?.classList.add("checked");
      const name = norm(row?.querySelector<HTMLElement>(".wr-client > b")?.textContent);
      cacheRef.current.reports = cacheRef.current.reports.map((report) => norm(report.client_name) === name ? { ...report, shared_at: new Date().toISOString() } : report);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("change", onChange, true);
    document.addEventListener("click", onClick, true);
    schedule();

    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("click", onClick, true);
      window.cancelAnimationFrame(frame);
      removeAll();
    };
  }, [allowed, token]);

  return null;
}
