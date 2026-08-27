"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { loadProfileLite, supabase } from "./shared";
import type { Row } from "./shared";

const REOPEN_KEY = "agency-ops-reassign-reopen-work";
const FLASH_KEY = "agency-ops-reassign-flash";

function currentViewIsWork() {
  const active = document.querySelector(".side-nav-items button.active") as HTMLButtonElement | null;
  const label = active?.title || active?.textContent?.trim() || "";
  return label.includes("Central de Trabalho");
}

export default function WorkReassignmentAwayBridge({ session }: { session: Session }) {
  const [person, setPerson] = useState("");

  useEffect(() => {
    let active = true;
    loadProfileLite().then((body) => {
      if (active) setPerson(String(body?.profile?.person || body?.person || ""));
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!person) return;
    const channel = supabase
      .channel(`work-reassignment-away-${session.user.id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "agency_ops",
        table: "platform_notifications",
      }, (change) => {
        const row = change.new as Row;
        if (!["WORK_ITEM_ASSIGNED", "WORK_ITEM_REASSIGNED"].includes(String(row.type || ""))) return;
        if (row.metadata?.assignment_superseded !== true) return;
        if (String(row.metadata?.target_person || "") !== person) return;
        if (!currentViewIsWork()) return;
        sessionStorage.setItem(REOPEN_KEY, "1");
        sessionStorage.setItem(FLASH_KEY, `A demanda “${String(row.title || "").replace(/^Nova demanda:\s*/i, "").replace(/^Demanda reatribuida:\s*/i, "") || "demanda"}” foi reatribuída e saiu da sua fila.`);
        window.location.reload();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [person, session.user.id]);

  return null;
}
