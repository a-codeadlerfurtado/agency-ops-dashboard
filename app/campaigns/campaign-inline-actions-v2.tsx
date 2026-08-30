"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const PROFILE_URL = `${SUPABASE_URL}/functions/v1/agency-ops-profile-lite`;
const ACTION_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaign-inline-action-v2`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type Profile = { person: string; role: string };

function norm(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function statusFromCell(cell: HTMLElement | null) {
  const value = norm(cell?.textContent);
  if (value.includes("pausad")) return "PAUSED";
  if (value.includes("ativ")) return "ACTIVE";
  return "";
}
function clientNameFor(table: HTMLTableElement) {
  const detail = table.closest(".tc-client-detail");
  const direct = detail?.querySelector<HTMLElement>(".tc-client-title h2")?.textContent?.trim();
  if (direct) return direct;
  const detailCell = table.closest("td");
  const parentRow = detailCell?.closest("tr")?.previousElementSibling as HTMLElement | null;
  return parentRow?.querySelector<HTMLElement>("td b")?.textContent?.trim() || "";
}
function campaignTables() {
  return Array.from(document.querySelectorAll<HTMLTableElement>(".tc-table-wrap table")).filter((table) => {
    const headers = Array.from(table.querySelectorAll<HTMLElement>(":scope > thead > tr > th")).map((th) => norm(th.textContent));
    return headers[0] === "campanha" && headers[1] === "status";
  });
}
function humanError(code: unknown, body?: Row) {
  const key = String(code || "");
  const account = String(body?.account_name || body?.account_id || "").trim();
  const messages: Record<string, string> = {
    forbidden: "Você não tem permissão para alterar esta campanha.",
    client_not_found: "Cliente não encontrado.",
    client_ambiguous: "Há mais de um cliente com esse nome. A ação foi bloqueada.",
    client_churned: "Cliente churned: alteração de mídia bloqueada.",
    campaign_not_found: "Campanha não encontrada no inventário atual.",
    campaign_ambiguous: "Há campanhas com o mesmo nome nessa conta. A ação foi bloqueada para evitar erro.",
    meta_write_permission_missing: "O token de escrita da Meta não tem ads_management.",
    meta_account_access_missing: `O System User de escrita não tem acesso à conta Meta${account ? ` ${account}` : " deste cliente"}. A campanha não foi alterada.`,
    meta_capability_check_failed: "Não foi possível validar agora as permissões do token Meta.",
    meta_read_failed: "O token de escrita não conseguiu ler esta campanha na Meta. A campanha não foi alterada.",
    execution_failed: "A Meta recusou a alteração. A campanha permaneceu no estado anterior.",
    verification_failed: "A Meta recebeu a ação, mas não confirmou o estado final esperado.",
    rate_limited: "Muitas alterações foram feitas em pouco tempo. Aguarde um pouco.",
    audit_store_failed: "A ação foi bloqueada porque a auditoria não pôde ser registrada.",
  };
  return messages[key] || "Não foi possível alterar a campanha agora.";
}
function showToast(message: string, tone: "ok" | "error") {
  document.querySelector(".cia2-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `cia2-toast ${tone}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 220);
  }, tone === "error" ? 5200 : 3000);
}

export default function CampaignInlineActionsV2() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const canWriteRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { sessionRef.current = data.session; setSession(data.session); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { sessionRef.current = next; setSession(next); });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setProfile(null); canWriteRef.current = false; return; }
    let alive = true;
    fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("profile");
        const next: Profile = { person: String(body?.profile?.person || "").trim(), role: String(body?.profile?.role || "").trim().toUpperCase() };
        if (!alive) return;
        setProfile(next);
        canWriteRef.current = next.role === "GT" || next.person === "Adler Furtado";
      })
      .catch(() => { if (alive) { setProfile(null); canWriteRef.current = false; } });
    return () => { alive = false; };
  }, [session?.access_token]);

  const execute = useCallback(async (button: HTMLButtonElement) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.access_token || !canWriteRef.current || button.dataset.busy === "true") return;
    const row = button.closest<HTMLTableRowElement>("tr");
    const table = button.closest<HTMLTableElement>("table");
    if (!row || !table) return;
    const cells = row.querySelectorAll<HTMLElement>(":scope > td");
    const campaignCell = cells[0];
    const statusCell = cells[1];
    const current = statusFromCell(statusCell);
    if (!(current === "ACTIVE" || current === "PAUSED")) return;

    const clientName = clientNameFor(table);
    const campaignName = campaignCell?.querySelector<HTMLElement>("b")?.textContent?.trim() || "";
    const account = campaignCell?.querySelector<HTMLElement>("small")?.textContent?.trim() || "";
    if (!clientName || !campaignName) { showToast("Não consegui identificar cliente e campanha com segurança.", "error"); return; }

    const desired = current === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const originalLabel = button.textContent || (desired === "ACTIVE" ? "Ativar" : "Pausar");
    button.dataset.busy = "true";
    button.disabled = true;
    button.textContent = desired === "ACTIVE" ? "Ativando…" : "Pausando…";
    row.classList.add("cia2-changing");

    try {
      const response = await fetch(ACTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${currentSession.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, campaign_name: campaignName, account_key: account, desired_status: desired }),
        cache: "no-store",
      });
      const body: Row = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok || body?.status !== "VERIFIED") throw new Error(humanError(body?.error, body));

      const pill = statusCell?.querySelector<HTMLElement>(".tc-pill");
      if (pill) { pill.textContent = desired === "ACTIVE" ? "Ativa" : "Pausada"; pill.className = `tc-pill ${desired === "ACTIVE" ? "ok" : "muted"}`; }
      else if (statusCell) statusCell.textContent = desired === "ACTIVE" ? "Ativa" : "Pausada";
      button.textContent = desired === "ACTIVE" ? "Pausar" : "Ativar";
      button.className = `cia2-toggle ${desired === "ACTIVE" ? "pause" : "activate"}`;
      button.title = desired === "ACTIVE" ? "Pausar esta campanha na Meta" : "Ativar esta campanha na Meta";
      showToast(`${campaignName} · ${desired === "ACTIVE" ? "ativada" : "pausada"} e confirmada pela Meta.`, "ok");
    } catch (error) {
      button.textContent = originalLabel;
      showToast(error instanceof Error ? error.message : "Não foi possível alterar a campanha.", "error");
    } finally {
      delete button.dataset.busy;
      button.disabled = false;
      row.classList.remove("cia2-changing");
    }
  }, []);

  useEffect(() => {
    const canWrite = profile?.role === "GT" || profile?.person === "Adler Furtado";
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const table of campaignTables()) {
          const headerRow = table.querySelector<HTMLTableRowElement>(":scope > thead > tr");
          if (!headerRow) continue;
          let actionHead = headerRow.querySelector<HTMLTableCellElement>(":scope > th[data-cia2-action-head]");
          if (!canWrite) {
            actionHead?.remove();
            table.querySelectorAll("[data-cia2-action-cell]").forEach((node) => node.remove());
            continue;
          }
          if (!actionHead) { actionHead = document.createElement("th"); actionHead.dataset.cia2ActionHead = "true"; actionHead.textContent = "Ação"; headerRow.appendChild(actionHead); }

          table.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr").forEach((row) => {
            const cells = row.querySelectorAll<HTMLElement>(":scope > td");
            if (!cells.length || !cells[0]?.querySelector("b")) { if (cells[0]?.hasAttribute("colspan")) cells[0].setAttribute("colspan", String(headerRow.children.length || 9)); return; }
            let actionCell = row.querySelector<HTMLTableCellElement>(":scope > td[data-cia2-action-cell]");
            if (!actionCell) { actionCell = document.createElement("td"); actionCell.dataset.cia2ActionCell = "true"; row.appendChild(actionCell); }
            const current = statusFromCell(cells[1]);
            let button = actionCell.querySelector<HTMLButtonElement>("button.cia2-toggle");
            if (!(current === "ACTIVE" || current === "PAUSED")) { button?.remove(); return; }
            if (!button) {
              button = document.createElement("button");
              button.type = "button";
              button.className = "cia2-toggle";
              button.addEventListener("pointerdown", () => {
                const hostTable = button?.closest<HTMLTableElement>("table");
                if (!hostTable) return;
                const previous = hostTable.dataset.campaignNotes;
                hostTable.dataset.campaignNotes = "false";
                window.setTimeout(() => { if (previous === undefined) delete hostTable.dataset.campaignNotes; else hostTable.dataset.campaignNotes = previous; }, 0);
              });
              button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); execute(button!); });
              actionCell.appendChild(button);
            }
            if (button.dataset.busy === "true") return;
            const shouldActivate = current === "PAUSED";
            button.textContent = shouldActivate ? "Ativar" : "Pausar";
            button.className = `cia2-toggle ${shouldActivate ? "activate" : "pause"}`;
            button.title = shouldActivate ? "Ativar esta campanha na Meta" : "Pausar esta campanha na Meta";
          });
        }
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(sync, 1500);
    return () => { observer.disconnect(); clearInterval(timer); cancelAnimationFrame(frame); document.querySelectorAll("[data-cia2-action-head],[data-cia2-action-cell]").forEach((node) => node.remove()); };
  }, [profile?.role, profile?.person, execute]);

  return <style>{styles}</style>;
}

const styles = `
  th[data-cia2-action-head],td[data-cia2-action-cell]{width:92px;text-align:right!important;white-space:nowrap}
  .cia2-toggle{min-width:66px;border-radius:8px;padding:6px 10px;border:1px solid transparent;font:800 10px/1 Inter,system-ui,sans-serif;cursor:pointer;transition:.15s ease}
  .cia2-toggle:hover{transform:translateY(-1px)}.cia2-toggle:disabled{cursor:wait;opacity:.6;transform:none}
  .cia2-toggle.activate{background:rgba(75,212,155,.11);border-color:rgba(75,212,155,.28);color:#7ce0b7}.cia2-toggle.activate:hover{background:rgba(75,212,155,.18);border-color:rgba(75,212,155,.45)}
  .cia2-toggle.pause{background:rgba(255,107,120,.08);border-color:rgba(255,107,120,.22);color:#ff9aa4}.cia2-toggle.pause:hover{background:rgba(255,107,120,.14);border-color:rgba(255,107,120,.38)}
  tr.cia2-changing{opacity:.72}
  .cia2-toast{position:fixed;right:24px;bottom:24px;z-index:2147483600;max-width:min(520px,calc(100vw - 32px));padding:13px 15px;border-radius:10px;border:1px solid #29445b;background:#0d1722;color:#e8f2fa;font:700 11px/1.45 Inter,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.36);opacity:0;transform:translateY(8px);transition:.2s ease}.cia2-toast.show{opacity:1;transform:translateY(0)}
  .cia2-toast.ok{border-color:rgba(75,212,155,.42);background:#10231d}.cia2-toast.error{border-color:rgba(255,107,120,.42);background:#28161b}
  @media(max-width:720px){th[data-cia2-action-head],td[data-cia2-action-cell]{width:auto}.cia2-toggle{min-width:58px;padding:6px 8px}}
`;
