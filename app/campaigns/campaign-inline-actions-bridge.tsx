"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const PROFILE_URL = `${SUPABASE_URL}/functions/v1/agency-ops-profile-lite`;
const ACTION_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaign-inline-action`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;

type Profile = {
  person: string;
  role: string;
};

function norm(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function humanError(code: unknown) {
  const key = String(code || "");
  const messages: Record<string, string> = {
    forbidden: "Você não tem permissão para alterar esta campanha.",
    client_not_found: "Cliente não encontrado.",
    client_ambiguous: "Há mais de um cliente com esse nome. A ação foi bloqueada.",
    client_churned: "Cliente churned: alteração de mídia bloqueada.",
    campaign_not_found: "Campanha não encontrada no inventário atual.",
    campaign_ambiguous: "Há campanhas com o mesmo nome nessa conta. A ação foi bloqueada para evitar erro.",
    invalid_campaign_id: "O ID da campanha não é válido para alteração.",
    account_mismatch: "A conta da campanha não bate com o vínculo do cliente.",
    campaign_state_not_toggleable: "Essa campanha não está em um estado que permita ativar ou pausar.",
    meta_write_permission_missing: "A permissão de escrita da Meta não está disponível.",
    meta_capability_check_failed: "Não foi possível validar a permissão da Meta agora.",
    meta_read_failed: "Não foi possível confirmar o estado atual da campanha na Meta.",
    execution_failed: "A Meta recusou a alteração. Nenhuma confirmação de mudança foi registrada.",
    verification_failed: "A ação foi enviada, mas a Meta não confirmou o estado final esperado.",
    rate_limited: "Muitas alterações foram feitas em pouco tempo. Aguarde um pouco.",
    audit_store_failed: "A ação foi bloqueada porque a auditoria não pôde ser registrada.",
  };
  return messages[key] || "Não foi possível alterar a campanha agora.";
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
  const detailRow = detailCell?.closest("tr");
  const parentRow = detailRow?.previousElementSibling as HTMLElement | null;
  const portfolio = parentRow?.querySelector<HTMLElement>("td b")?.textContent?.trim();
  return portfolio || "";
}

function campaignTables() {
  return Array.from(document.querySelectorAll<HTMLTableElement>(".tc-table-wrap table")).filter((table) => {
    const headers = Array.from(table.querySelectorAll<HTMLElement>(":scope > thead > tr > th")).map((th) => norm(th.textContent));
    return headers[0] === "campanha" && headers[1] === "status";
  });
}

function showToast(message: string, tone: "ok" | "error") {
  document.querySelector(".cia-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `cia-toast ${tone}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.classList.add("show"), 20);
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 220);
  }, 2800);
}

export default function CampaignInlineActionsBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const canWriteRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      sessionRef.current = data.session;
      setSession(data.session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      sessionRef.current = next;
      setSession(next);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setProfile(null);
      canWriteRef.current = false;
      return;
    }
    let alive = true;
    fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("profile");
      const next: Profile = {
        person: String(body?.profile?.person || "").trim(),
        role: String(body?.profile?.role || "").trim().toUpperCase(),
      };
      if (!alive) return;
      setProfile(next);
      canWriteRef.current = next.role === "GT" || next.person === "Adler Furtado";
    }).catch(() => {
      if (!alive) return;
      setProfile(null);
      canWriteRef.current = false;
    });
    return () => { alive = false; };
  }, [session?.access_token]);

  const execute = useCallback(async (button: HTMLButtonElement) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.access_token || !canWriteRef.current || button.dataset.busy === "true") return;
    const row = button.closest("tr");
    const table = button.closest("table") as HTMLTableElement | null;
    if (!row || !table) return;

    const cells = row.querySelectorAll<HTMLElement>(":scope > td");
    const campaignCell = cells[0];
    const statusCell = cells[1];
    const current = statusFromCell(statusCell);
    if (!(current === "ACTIVE" || current === "PAUSED")) return;

    const clientName = clientNameFor(table);
    const campaignName = campaignCell?.querySelector<HTMLElement>("b")?.textContent?.trim() || "";
    const account = campaignCell?.querySelector<HTMLElement>("small")?.textContent?.trim() || "";
    if (!clientName || !campaignName) {
      showToast("Não consegui identificar cliente e campanha com segurança.", "error");
      return;
    }

    const desired = current === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const originalLabel = button.textContent || (desired === "ACTIVE" ? "Ativar" : "Pausar");
    button.dataset.busy = "true";
    button.disabled = true;
    button.textContent = desired === "ACTIVE" ? "Ativando…" : "Pausando…";
    row.classList.add("cia-changing");

    try {
      const response = await fetch(ACTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentSession.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_name: clientName,
          campaign_name: campaignName,
          account_key: account,
          desired_status: desired,
        }),
        cache: "no-store",
      });
      const body: Row = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok || body?.status !== "VERIFIED") throw new Error(humanError(body?.error));

      const pill = statusCell?.querySelector<HTMLElement>(".tc-pill");
      if (pill) {
        pill.textContent = desired === "ACTIVE" ? "Ativa" : "Pausada";
        pill.className = `tc-pill ${desired === "ACTIVE" ? "ok" : "muted"}`;
      } else if (statusCell) {
        statusCell.textContent = desired === "ACTIVE" ? "Ativa" : "Pausada";
      }
      button.textContent = desired === "ACTIVE" ? "Pausar" : "Ativar";
      button.className = `cia-toggle ${desired === "ACTIVE" ? "pause" : "activate"}`;
      button.title = desired === "ACTIVE" ? "Pausar esta campanha na Meta" : "Ativar esta campanha na Meta";
      showToast(`${campaignName} · ${desired === "ACTIVE" ? "ativada" : "pausada"} e confirmada pela Meta.`, "ok");
    } catch (error) {
      button.textContent = originalLabel;
      showToast(error instanceof Error ? error.message : "Não foi possível alterar a campanha.", "error");
    } finally {
      delete button.dataset.busy;
      button.disabled = false;
      row.classList.remove("cia-changing");
    }
  }, []);

  useEffect(() => {
    const canWrite = profile?.role === "GT" || profile?.person === "Adler Furtado";
    let frame = 0;

    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const tables = campaignTables();
        for (const table of tables) {
          const headerRow = table.querySelector<HTMLTableRowElement>(":scope > thead > tr");
          if (!headerRow) continue;
          let actionHead = headerRow.querySelector<HTMLTableCellElement>(":scope > th[data-cia-action-head]");
          if (!canWrite) {
            actionHead?.remove();
            table.querySelectorAll("[data-cia-action-cell]").forEach((node) => node.remove());
            continue;
          }
          if (!actionHead) {
            actionHead = document.createElement("th");
            actionHead.dataset.ciaActionHead = "true";
            actionHead.textContent = "Ação";
            headerRow.appendChild(actionHead);
          }

          table.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr").forEach((row) => {
            const cells = row.querySelectorAll<HTMLElement>(":scope > td");
            if (!cells.length || !cells[0]?.querySelector("b")) {
              const empty = cells[0];
              if (empty?.hasAttribute("colspan")) empty.setAttribute("colspan", String(headerRow?.children.length || 9));
              return;
            }
            let actionCell = row.querySelector<HTMLTableCellElement>(":scope > td[data-cia-action-cell]");
            if (!actionCell) {
              actionCell = document.createElement("td");
              actionCell.dataset.ciaActionCell = "true";
              row.appendChild(actionCell);
            }
            const current = statusFromCell(cells[1]);
            let button = actionCell.querySelector<HTMLButtonElement>("button.cia-toggle");
            if (!(current === "ACTIVE" || current === "PAUSED")) {
              button?.remove();
              return;
            }
            if (!button) {
              button = document.createElement("button");
              button.type = "button";
              button.className = "cia-toggle";
              button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                execute(button!);
              });
              actionCell.appendChild(button);
            }
            if (button.dataset.busy === "true") return;
            const shouldActivate = current === "PAUSED";
            button.textContent = shouldActivate ? "Ativar" : "Pausar";
            button.className = `cia-toggle ${shouldActivate ? "activate" : "pause"}`;
            button.title = shouldActivate ? "Ativar esta campanha na Meta" : "Pausar esta campanha na Meta";
          });
        }
      });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(sync, 1500);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.querySelectorAll("[data-cia-action-head],[data-cia-action-cell]").forEach((node) => node.remove());
    };
  }, [profile?.role, profile?.person, execute]);

  return <style>{styles}</style>;
}

const styles = `
  th[data-cia-action-head],td[data-cia-action-cell]{width:92px;text-align:right!important;white-space:nowrap}
  .cia-toggle{min-width:66px;border-radius:8px;padding:6px 10px;border:1px solid transparent;font:800 10px/1 Inter,system-ui,sans-serif;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease,transform .15s ease}
  .cia-toggle:hover{transform:translateY(-1px)}
  .cia-toggle:disabled{cursor:wait;opacity:.6;transform:none}
  .cia-toggle.activate{background:rgba(75,212,155,.11);border-color:rgba(75,212,155,.28);color:#7ce0b7}
  .cia-toggle.activate:hover{background:rgba(75,212,155,.18);border-color:rgba(75,212,155,.45)}
  .cia-toggle.pause{background:rgba(255,107,120,.08);border-color:rgba(255,107,120,.22);color:#ff9aa4}
  .cia-toggle.pause:hover{background:rgba(255,107,120,.14);border-color:rgba(255,107,120,.38)}
  tr.cia-changing{opacity:.72}
  .cia-toast{position:fixed;right:24px;bottom:24px;z-index:9999;max-width:min(440px,calc(100vw - 32px));padding:12px 14px;border-radius:10px;border:1px solid #29445b;background:#0d1722;color:#e8f2fa;font:700 11px/1.45 Inter,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.36);opacity:0;transform:translateY(8px);transition:.2s ease}
  .cia-toast.show{opacity:1;transform:translateY(0)}
  .cia-toast.ok{border-color:rgba(75,212,155,.42);background:#10231d}
  .cia-toast.error{border-color:rgba(255,107,120,.42);background:#28161b}
  @media(max-width:720px){th[data-cia-action-head],td[data-cia-action-cell]{width:auto}.cia-toggle{min-width:58px;padding:6px 8px}}
`;
