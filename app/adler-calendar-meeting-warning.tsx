"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

const ADLER_USER_ID = "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";
const API = SUPABASE_URL + "/functions/v1/agency-ops-notifications-home";
const TYPES = new Set([
  "GOOGLE_CALENDAR_MEETING_CREATED",
  "GOOGLE_CALENDAR_MEETING_RESCHEDULED",
  "GOOGLE_CALENDAR_MEETING_CANCELLED",
]);
const SHOWN_KEY = "adler-calendar-meeting-warning-shown";

function shownIds() {
  try { return new Set(JSON.parse(window.sessionStorage.getItem(SHOWN_KEY) || "[]") as string[]); }
  catch { return new Set<string>(); }
}
function remember(id: string) {
  try {
    const next = shownIds();
    next.add(id);
    window.sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...next].slice(-120)));
  } catch { /* sessionStorage não pode impedir um alerta */ }
}
function isCalendarAlert(row: Row) {
  return TYPES.has(String(row?.type || "").toUpperCase())
    && row?.metadata?.private_to_person === true
    && String(row?.metadata?.target_person || "") === "Adler Furtado"
    && String(row?.status || "OPEN").toUpperCase() !== "RESOLVED";
}
function titleFor(item: Row) {
  return String(item?.title || "Nova alteração na sua Agenda Google");
}

export default function AdlerCalendarMeetingWarning() {
  const [session, setSession] = useState<Session | null>(null);
  const [item, setItem] = useState<Row | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const queue = useRef<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const offer = useCallback((candidate: Row) => {
    if (!candidate?.id || !isCalendarAlert(candidate)) return;
    const id = String(candidate.id);
    if (shownIds().has(id)) return;
    setItem((current) => {
      if (!current) {
        remember(id);
        return candidate;
      }
      if (!queue.current.some((queued) => String(queued.id) === id)) queue.current.push(candidate);
      return current;
    });
  }, []);

  const close = useCallback(() => {
    setItem(null);
    setAcknowledging(false);
    const next = queue.current.shift();
    if (next) window.setTimeout(() => offer(next), 120);
  }, [offer]);

  const acknowledge = useCallback(async () => {
    if (!item?.id || !session?.access_token || acknowledging) return;
    setAcknowledging(true);
    try {
      await fetch(API, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session.access_token,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "RESOLVE", notification_id: item.id }),
        cache: "no-store",
      });
    } finally {
      close();
    }
  }, [item?.id, session?.access_token, acknowledging, close]);

  useEffect(() => {
    if (!session?.access_token || session.user.id !== ADLER_USER_ID) {
      setItem(null);
      queue.current = [];
      return;
    }
    let active = true;

    fetch(API, {
      headers: {
        Authorization: "Bearer " + session.access_token,
        apikey: SUPABASE_ANON_KEY,
      },
      cache: "no-store",
    })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (!active) return;
        const candidates = (body?.items || []).filter(isCalendarAlert);
        if (candidates.length) offer(candidates[0]);
      })
      .catch(() => { /* Realtime continua sendo a fonte principal. */ });

    const channel = supabase
      .channel("adler-calendar-meeting-warning:" + session.user.id)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "agency_ops",
        table: "platform_notifications",
      }, (payload) => offer(payload.new as Row))
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [session?.access_token, session?.user?.id, offer]);

  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, close]);

  if (!item || session?.user?.id !== ADLER_USER_ID) return null;

  const meetingUrl = String(item?.metadata?.meet_url || item?.metadata?.html_link || "");
  const changeType = String(item?.metadata?.google_calendar_change_type || "");
  const eyebrow = changeType === "CREATED"
    ? "NOVA REUNIÃO"
    : changeType === "RESCHEDULED"
      ? "REUNIÃO REMARCADA"
      : "REUNIÃO CANCELADA";

  return <div className="adler-gcal-overlay" role="dialog" aria-modal="true" aria-label="Aviso de reunião">
    <style>{styles}</style>
    <section className="adler-gcal-card">
      <header>
        <div>
          <span>{eyebrow} · GOOGLE AGENDA</span>
          <h2>{titleFor(item)}</h2>
        </div>
        <button type="button" aria-label="Fechar por agora" onClick={close}>×</button>
      </header>

      <div className="adler-gcal-body">
        <div className="adler-gcal-badge">ONBOARDING ADLER</div>
        <h3>{String(item?.metadata?.google_calendar_creator_name || item?.actor || "Outro usuário")} fez uma alteração na sua agenda</h3>
        <p>{String(item?.description || "")}</p>
        <small>O aviso também fica salvo na Central de Notificações. Clicar em “Ciente” remove apenas o alerta pendente, sem apagar o histórico.</small>
      </div>

      <footer>
        {meetingUrl && changeType !== "CANCELLED" && <button
          className="secondary"
          type="button"
          onClick={() => window.open(meetingUrl, "_blank", "noopener,noreferrer")}
        >Abrir reunião</button>}
        <button type="button" onClick={acknowledge} disabled={acknowledging}>
          {acknowledging ? "Confirmando..." : "Ciente"}
        </button>
      </footer>
    </section>
  </div>;
}

const styles = [
  ".adler-gcal-overlay{position:fixed;inset:0;z-index:100180;background:rgba(2,7,13,.76);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,system-ui,sans-serif}",
  ".adler-gcal-card{width:min(760px,96vw);background:#0c1722;border:1px solid rgba(76,184,255,.38);border-radius:18px;box-shadow:0 30px 100px rgba(0,0,0,.55);overflow:hidden;color:#eef5fb}",
  ".adler-gcal-card header{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 18px;border-bottom:1px solid rgba(255,255,255,.08)}",
  ".adler-gcal-card header span{display:block;color:#70c5ff;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px}",
  ".adler-gcal-card header h2{margin:0;font:800 27px/1.08 'Inter Tight',Inter,sans-serif}",
  ".adler-gcal-card header>button{width:38px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#d9e6ef;font-size:22px;cursor:pointer}",
  ".adler-gcal-body{padding:22px 24px}",
  ".adler-gcal-badge{display:inline-flex;padding:6px 9px;border-radius:999px;background:rgba(69,174,232,.12);border:1px solid rgba(69,174,232,.28);color:#8ed4ff;font-size:10px;font-weight:800;letter-spacing:.08em}",
  ".adler-gcal-body h3{margin:14px 0 8px;font-size:18px}",
  ".adler-gcal-body p{margin:0;color:#bdcbd7;font-size:14px;line-height:1.7;white-space:pre-wrap}",
  ".adler-gcal-body small{display:block;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07);color:#71899d;font-size:11px;line-height:1.5}",
  ".adler-gcal-card footer{display:flex;justify-content:flex-end;gap:9px;padding:16px 24px 22px}",
  ".adler-gcal-card footer button{border:1px solid rgba(91,181,239,.32);border-radius:10px;padding:10px 16px;background:#45aee8;color:#06131d;font-weight:800;cursor:pointer}",
  ".adler-gcal-card footer button:disabled{opacity:.6;cursor:wait}",
  ".adler-gcal-card footer button.secondary{background:rgba(255,255,255,.04);color:#c2d6e4;border-color:rgba(255,255,255,.12)}",
  "@media(max-width:620px){.adler-gcal-overlay{padding:12px}.adler-gcal-card header,.adler-gcal-body{padding-left:18px;padding-right:18px}.adler-gcal-card footer{padding:14px 18px 18px;flex-direction:column-reverse}.adler-gcal-card footer button{width:100%}}",
].join("");
