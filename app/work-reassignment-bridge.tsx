"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  api,
  loadProfileLite,
  supabase,
  text,
} from "./shared";
import type { Row } from "./shared";

const REASSIGN_URL = `${SUPABASE_URL}/functions/v1/agency-ops-work-item-reassign-api`;
const WORK_ROLES = new Set(["GT", "CS", "DESIGN", "AI", "MGMT"]);
const REOPEN_KEY = "agency-ops-reassign-reopen-work";
const FLASH_KEY = "agency-ops-reassign-flash";

const roleLabel = (role: unknown) => ({
  GT: "Gestor de Tráfego",
  CS: "Customer Success",
  DESIGN: "Design",
  AI: "IA e Automação",
  MGMT: "Operações",
} as Record<string, string>)[String(role || "").toUpperCase()] || String(role || "");

function currentViewIsWork() {
  const active = document.querySelector(".side-nav-items button.active") as HTMLButtonElement | null;
  const label = active?.title || active?.textContent?.trim() || "";
  return label.includes("Central de Trabalho");
}

function reopenWorkAfterReload() {
  if (sessionStorage.getItem(REOPEN_KEY) !== "1") return;
  let done = false;
  const tryOpen = () => {
    if (done) return;
    const buttons = Array.from(document.querySelectorAll(".side-nav-items button")) as HTMLButtonElement[];
    const work = buttons.find((button) => {
      const label = button.title || button.textContent?.trim() || "";
      return label.includes("Central de Trabalho");
    });
    if (!work) return;
    done = true;
    sessionStorage.removeItem(REOPEN_KEY);
    work.click();
  };
  tryOpen();
  if (done) return;
  const observer = new MutationObserver(() => {
    tryOpen();
    if (done) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10000);
}

function hiddenForPreviousAssignee(item: Row, person: string) {
  if (!person || person === "Adler Furtado") return false;
  if (String(item.target_person || "") === person) return false;
  const previous = Array.isArray(item.metadata?.reassignment_previous_targets)
    ? item.metadata.reassignment_previous_targets.map(String)
    : [];
  return previous.includes(person);
}

export default function WorkReassignmentBridge({ session }: { session: Session }) {
  const [payload, setPayload] = useState<Row>({ items: [], roster: [] });
  const [profile, setProfile] = useState<Row>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetPerson, setTargetPerson] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  const loadContext = useCallback(async () => {
    try {
      const [work, lite] = await Promise.all([
        api("work", session.access_token),
        loadProfileLite(),
      ]);
      setPayload(work || { items: [], roster: [] });
      setProfile(lite?.profile || lite || {});
    } catch {
      // A Central nativa continua sendo a fonte de erro. A ponte apenas deixa de aparecer.
    }
  }, [session.access_token]);

  useEffect(() => { void loadContext(); }, [loadContext]);

  useEffect(() => {
    reopenWorkAfterReload();
    const message = sessionStorage.getItem(FLASH_KEY);
    if (!message) return;
    sessionStorage.removeItem(FLASH_KEY);
    setFlash(message);
    const timer = window.setTimeout(() => setFlash(""), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  const items: Row[] = payload.items || [];
  const roster: Row[] = payload.roster || [];
  const itemById = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const selected = selectedId ? itemById.get(selectedId) || null : null;
  const actorPerson = String(profile.person || "");

  const candidates = useMemo(() => roster
    .filter((row) => WORK_ROLES.has(String(row.role || "").toUpperCase()))
    .filter((row) => String(row.person || "") !== String(selected?.target_person || ""))
    .sort((a, b) => {
      const byRole = String(a.role || "").localeCompare(String(b.role || ""), "pt-BR");
      return byRole || String(a.person || "").localeCompare(String(b.person || ""), "pt-BR");
    }), [roster, selected?.target_person]);

  const canReassign = useCallback((item: Row) => {
    if (!actorPerson) return false;
    if (["COMPLETED", "DISMISSED"].includes(String(item.status || "").toUpperCase())) return false;
    if (String(profile.role || "").toUpperCase() === "MGMT") return true;
    if (String(item.target_person || "") === actorPerson) return true;
    if (String(item.created_by_person || "") === actorPerson) return true;
    return !item.target_person && String(item.target_role || "").toUpperCase() === String(profile.role || "").toUpperCase();
  }, [actorPerson, profile.role]);

  // A Central antiga ainda deixa o criador enxergar um item que foi posteriormente
  // encaminhado a outra pessoa. A cadeia de responsáveis anteriores, gravada pelo RPC,
  // é usada aqui para cumprir a regra operacional: saiu da pessoa, sai da fila dela.
  useEffect(() => {
    const scan = () => {
      document.querySelectorAll<HTMLElement>(".work-item[id^='work-']").forEach((card) => {
        const id = card.id.replace(/^work-/, "");
        const item = itemById.get(id);
        if (!item) return;

        const shouldHide = hiddenForPreviousAssignee(item, actorPerson);
        if (shouldHide) {
          card.style.display = "none";
          card.dataset.reassignedAway = "true";
          return;
        }
        if (card.dataset.reassignedAway === "true") {
          card.style.display = "";
          delete card.dataset.reassignedAway;
        }

        if (!card.classList.contains("expanded") || !canReassign(item)) return;
        const actions = card.querySelector<HTMLElement>(".work-actions");
        if (!actions || actions.querySelector("[data-work-reassign-button='true']")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.dataset.workReassignButton = "true";
        button.className = "muted";
        button.textContent = "Reatribuir responsável";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setSelectedId(id);
          setTargetPerson("");
          setReason("");
          setError("");
        });
        actions.insertBefore(button, actions.firstChild);
      });
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [itemById, actorPerson, canReassign]);

  // Reatribuição gera WORK_ITEM_REASSIGNED privado para o novo responsável.
  // Como platform_notifications já está no Supabase Realtime, quem estiver com a
  // Central aberta recebe a mudança por evento, sem polling adicional.
  useEffect(() => {
    if (!actorPerson) return;
    const channel = supabase
      .channel(`work-reassignment-${session.user.id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "agency_ops",
        table: "platform_notifications",
      }, (change) => {
        const row = change.new as Row;
        if (String(row.type || "") !== "WORK_ITEM_REASSIGNED") return;
        if (String(row.metadata?.target_person || "") !== actorPerson) return;
        if (!currentViewIsWork()) return;
        sessionStorage.setItem(REOPEN_KEY, "1");
        sessionStorage.setItem(FLASH_KEY, `Nova demanda reatribuída para você: ${text(row.title || "demanda")}`);
        window.location.reload();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [actorPerson, session.user.id]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !targetPerson || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(REASSIGN_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          work_item_id: selected.id,
          target_person: targetPerson,
          reason: reason.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages: Record<string, string> = {
          forbidden: "Você não tem permissão para reatribuir esta demanda.",
          work_item_closed: "Esta demanda já foi encerrada e não pode ser reatribuída.",
          already_assigned: "A demanda já está com essa pessoa.",
          target_not_active: "O colaborador escolhido não está ativo na equipe.",
          target_has_no_work_center: "Esse perfil não possui Central de Trabalho operacional.",
        };
        throw new Error(messages[String(body?.error || "")] || "Não foi possível reatribuir a demanda.");
      }

      const destination = String(body?.target?.person || targetPerson);
      sessionStorage.setItem(REOPEN_KEY, "1");
      sessionStorage.setItem(FLASH_KEY, `Demanda reatribuída para ${destination}. O histórico e a notificação foram registrados.`);
      setSelectedId(null);
      await loadContext();
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível reatribuir a demanda.");
    } finally {
      setBusy(false);
    }
  }

  const modal = selected && typeof document !== "undefined" ? createPortal(
    <>
      <div
        onClick={() => !busy && setSelectedId(null)}
        style={{ position: "fixed", inset: 0, zIndex: 10040, background: "rgba(5,8,15,.68)", backdropFilter: "blur(5px)" }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Reatribuir responsável"
        style={{
          position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
          zIndex: 10041, width: "min(560px,calc(100vw - 28px))", maxHeight: "calc(100vh - 40px)", overflowY: "auto",
          background: "var(--panel,#10141f)", color: "var(--text,#f8fafc)", border: "1px solid var(--line,#2a3040)",
          borderRadius: 16, boxShadow: "0 28px 90px rgba(0,0,0,.45)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 18 }}>
          <div>
            <span className="eyebrow">Central de Trabalho</span>
            <h2 style={{ margin: "4px 0 6px", fontSize: 21 }}>Reatribuir responsável</h2>
            <p style={{ margin: 0, opacity: .76, fontSize: 13.5 }}>A mesma demanda será movida. Cliente, contexto, prioridade, prazo, origem e evidências não serão recriados nem perdidos.</p>
          </div>
          <button type="button" className="muted" disabled={busy} onClick={() => setSelectedId(null)}>×</button>
        </div>

        <div style={{ border: "1px solid var(--line,#2a3040)", borderRadius: 12, padding: 13, marginBottom: 16 }}>
          <b style={{ display: "block", marginBottom: 5 }}>{text(selected.title)}</b>
          <small style={{ display: "block", opacity: .72 }}>
            {text(selected.clients?.display_name || "Solicitação geral")} · atual: {text(selected.target_person || selected.target_role || "sem responsável")}
          </small>
        </div>

        <form onSubmit={submit} style={{ display: "grid", gap: 13 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
            Novo responsável
            <select className="control" required value={targetPerson} onChange={(event) => setTargetPerson(event.target.value)}>
              <option value="">Selecione a pessoa…</option>
              {candidates.map((row) => <option key={row.person} value={row.person}>{row.person} · {roleLabel(row.role)}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
            Motivo da reatribuição <span style={{ opacity: .62 }}>(opcional)</span>
            <textarea
              className="control"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Ex.: demanda criada para o responsável errado"
            />
          </label>
          {error && <div className="error-box" style={{ margin: 0 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="muted" disabled={busy} onClick={() => setSelectedId(null)}>Cancelar</button>
            <button type="submit" className="primary" disabled={busy || !targetPerson}>{busy ? "Reatribuindo…" : "Reatribuir e notificar"}</button>
          </div>
        </form>
      </section>
    </>, document.body
  ) : null;

  return <>
    {modal}
    {flash && typeof document !== "undefined" && createPortal(
      <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 10050, maxWidth: 420, padding: "12px 15px", borderRadius: 12, background: "rgba(15,23,42,.96)", color: "#f8fafc", border: "1px solid #334155", boxShadow: "0 18px 48px rgba(0,0,0,.32)", fontSize: 13.5 }}>
        {flash}
      </div>, document.body
    )}
  </>;
}
