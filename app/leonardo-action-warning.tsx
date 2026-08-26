"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const LEONARDO_USER_ID = "334994a0-21ee-4a6e-9a03-5fbc3a3aed00";
const API = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;
const SHOWN_KEY = "leonardo-action-warning-shown";

function shownIds() {
  try { return new Set(JSON.parse(window.sessionStorage.getItem(SHOWN_KEY) || "[]") as string[]); }
  catch { return new Set<string>(); }
}
function remember(id: string) {
  try {
    const next = shownIds();
    next.add(id);
    window.sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...next].slice(-80)));
  } catch { /* storage indisponível não bloqueia o alerta */ }
}
function isLeonardoAction(row: Row) {
  return row?.metadata?.leonardo_action === true
    && String(row?.metadata?.target_person || "") === "Leonardo Augusto"
    && String(row?.status || "OPEN").toUpperCase() !== "RESOLVED";
}

export default function LeonardoActionWarning() {
  const [session, setSession] = useState<Session | null>(null);
  const [item, setItem] = useState<Row | null>(null);
  const queue = useRef<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const offer = useCallback((candidate: Row) => {
    if (!candidate?.id || !isLeonardoAction(candidate)) return;
    const id = String(candidate.id);
    if (shownIds().has(id)) return;
    setItem((current) => {
      if (!current) { remember(id); return candidate; }
      if (!queue.current.some((queued) => String(queued.id) === id)) queue.current.push(candidate);
      return current;
    });
  }, []);

  const close = useCallback(() => {
    setItem(null);
    const next = queue.current.shift();
    if (next) window.setTimeout(() => offer(next), 120);
  }, [offer]);

  useEffect(() => {
    if (!session?.access_token || session.user.id !== LEONARDO_USER_ID) { setItem(null); queue.current = []; return; }
    let active = true;

    fetch(API, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (!active) return;
        const candidates = (body?.items || []).filter(isLeonardoAction);
        if (candidates.length) offer(candidates[0]);
      })
      .catch(() => { /* Realtime continua sendo a fonte principal após o bootstrap */ });

    const channel = supabase
      .channel(`leonardo-action-warning:${session.user.id}`)
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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, close]);

  if (!item || session?.user?.id !== LEONARDO_USER_ID) return null;

  return <div className="leo-action-overlay" role="dialog" aria-modal="true" aria-label="Ação do Leonardo">
    <style>{styles}</style>
    <section className="leo-action-card">
      <div className="leo-action-head">
        <div><span>Acompanhamento · Customers Success</span><h2>Ação depende de você</h2></div>
        <button type="button" onClick={close} aria-label="Fechar">×</button>
      </div>
      <div className="leo-action-body">
        <div className="leo-action-badge">ATENÇÃO</div>
        <h3>{String(item.title || "Acompanhamento do time")}</h3>
        <p>{String(item.description || "Existe um acompanhamento do Customers Success que depende de uma ação sua.")}</p>
        <small>Esse aviso só é enviado quando o lembrete deixa explícito que Leonardo precisa executar ou conduzir a ação. Mera menção ao seu nome não gera alerta.</small>
      </div>
      <div className="leo-action-actions">
        <button className="secondary" type="button" onClick={close}>Fechar por agora</button>
        <button type="button" onClick={() => window.location.assign("/notifications")}>Abrir notificações</button>
      </div>
    </section>
  </div>;
}

const styles = `
.leo-action-overlay{position:fixed;inset:0;z-index:100120;background:rgba(2,7,13,.76);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,system-ui,sans-serif}
.leo-action-card{width:min(720px,96vw);background:#0c1722;border:1px solid rgba(255,154,91,.34);border-radius:18px;box-shadow:0 30px 100px rgba(0,0,0,.5);overflow:hidden;color:#eef5fb}
.leo-action-head{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
.leo-action-head span{display:block;color:#ff9f68;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px}
.leo-action-head h2{margin:0;font:800 27px/1.08 'Inter Tight',Inter,sans-serif}.leo-action-head>button{width:38px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#d9e6ef;font-size:22px;cursor:pointer}
.leo-action-body{padding:22px 24px}.leo-action-badge{display:inline-flex;padding:6px 9px;border-radius:999px;background:rgba(255,145,77,.12);border:1px solid rgba(255,145,77,.28);color:#ffb17e;font-size:10px;font-weight:800;letter-spacing:.08em}.leo-action-body h3{margin:14px 0 8px;font-size:18px}.leo-action-body p{margin:0;color:#bdcbd7;font-size:14px;line-height:1.65;white-space:pre-wrap}.leo-action-body small{display:block;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07);color:#71899d;font-size:11px;line-height:1.5}
.leo-action-actions{display:flex;justify-content:flex-end;gap:9px;padding:16px 24px 22px}.leo-action-actions button{border:1px solid rgba(91,181,239,.32);border-radius:10px;padding:10px 14px;background:#45aee8;color:#06131d;font-weight:800;cursor:pointer}.leo-action-actions button.secondary{background:rgba(255,255,255,.04);color:#a9becf;border-color:rgba(255,255,255,.12)}
@media(max-width:620px){.leo-action-overlay{padding:12px}.leo-action-head,.leo-action-body{padding-left:18px;padding-right:18px}.leo-action-actions{padding:14px 18px 18px;flex-direction:column-reverse}.leo-action-actions button{width:100%}}
`;
