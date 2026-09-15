"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const ENDPOINT = `${SUPABASE_URL}/functions/v1/agency-ops-meeting-transcript-api`;
const MARK = "data-leonardo-transcript-button";

function ensureStyles() {
  if (document.getElementById("leo-meeting-bridge-styles")) return;
  const style = document.createElement("style");
  style.id = "leo-meeting-bridge-styles";
  style.textContent = `
    .leo-transcript-action{margin-top:10px;display:flex;gap:8px;align-items:center}
    .leo-transcript-action button{border:1px solid rgba(255,132,69,.38);background:rgba(255,112,43,.12);color:#ffd2b9;border-radius:9px;padding:8px 11px;font:700 11px/1 Inter,sans-serif;cursor:pointer}
    .leo-transcript-action button:hover{background:rgba(255,112,43,.2);color:#fff}
    .leo-transcript-modal{position:fixed;inset:0;z-index:99999;background:rgba(2,7,13,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px}
    .leo-transcript-card{width:min(980px,96vw);max-height:88vh;display:flex;flex-direction:column;background:#0c1621;border:1px solid rgba(126,158,190,.25);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden}
    .leo-transcript-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px 20px;border-bottom:1px solid rgba(126,158,190,.15)}
    .leo-transcript-head small{display:block;color:#ff9b63;font:800 10px/1.2 Inter,sans-serif;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px}
    .leo-transcript-head h3{margin:0;color:#f2f7fb;font:800 20px/1.2 Inter,sans-serif}
    .leo-transcript-head p{margin:7px 0 0;color:#8fa5b9;font:500 12px/1.45 Inter,sans-serif}
    .leo-transcript-close{border:1px solid rgba(126,158,190,.2);background:rgba(255,255,255,.04);color:#d7e3ee;border-radius:9px;width:34px;height:34px;cursor:pointer;font-size:18px}
    .leo-transcript-body{padding:18px 20px;overflow:auto}
    .leo-transcript-summary{margin:0 0 16px;padding:12px 14px;border-radius:10px;background:rgba(53,120,174,.09);border:1px solid rgba(77,145,201,.17);color:#c8d6e3;font:500 12px/1.6 Inter,sans-serif}
    .leo-transcript-text{white-space:pre-wrap;word-break:break-word;margin:0;color:#d9e4ed;font:500 12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .leo-transcript-error{color:#ff9b91;padding:16px;font:600 12px/1.5 Inter,sans-serif}
  `;
  document.head.appendChild(style);
}

function closeModal(modal: HTMLElement) { modal.remove(); }

async function openTranscript(title: string, description: string) {
  const modal = document.createElement("div");
  modal.className = "leo-transcript-modal";
  const card = document.createElement("section");
  card.className = "leo-transcript-card";
  const head = document.createElement("div");
  head.className = "leo-transcript-head";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("small"); eyebrow.textContent = "Reunião do Leonardo";
  const h3 = document.createElement("h3"); h3.textContent = title || "Íntegra da reunião";
  const meta = document.createElement("p"); meta.textContent = "Carregando transcrição completa…";
  heading.append(eyebrow,h3,meta);
  const close = document.createElement("button"); close.className = "leo-transcript-close"; close.type = "button"; close.textContent = "×"; close.onclick = () => closeModal(modal);
  head.append(heading,close);
  const body = document.createElement("div"); body.className = "leo-transcript-body";
  card.append(head,body); modal.append(card); document.body.append(modal);
  modal.addEventListener("click",(event)=>{ if(event.target===modal) closeModal(modal); });

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Sessão expirada.");
    const url = new URL(ENDPOINT);
    url.searchParams.set("title", title);
    if (description) url.searchParams.set("description", description);
    const response = await fetch(url,{headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"});
    const payload = await response.json().catch(()=>({}));
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    const meeting = payload.meeting || {};
    const when = meeting.meeting_started_at ? new Date(meeting.meeting_started_at).toLocaleString("pt-BR") : "data não identificada";
    meta.textContent = `${meeting.client?.display_name || "Cliente"} · ${when} · ${Number(meeting.transcript_chars || 0).toLocaleString("pt-BR")} caracteres`;
    const summary = document.createElement("p"); summary.className = "leo-transcript-summary"; summary.textContent = meeting.donnah_summary || meeting.summary || description || "Sem resumo disponível.";
    const pre = document.createElement("pre"); pre.className = "leo-transcript-text"; pre.textContent = meeting.transcript_text || "Transcrição sem conteúdo.";
    body.replaceChildren(summary,pre);
  } catch (error) {
    const p = document.createElement("div"); p.className = "leo-transcript-error"; p.textContent = error instanceof Error ? error.message : "Não foi possível abrir a íntegra.";
    body.replaceChildren(p);
  }
}

export default function LeonardoMeetingNotificationBridge() {
  useEffect(() => {
    ensureStyles();
    const mount = () => {
      document.querySelectorAll<HTMLElement>(".client-notifications-bridge-host .cn-item").forEach((article) => {
        if (article.hasAttribute(MARK)) return;
        const title = article.querySelector<HTMLElement>("h4")?.textContent?.trim() || "";
        if (!title.startsWith("Leonardo · alinhamento com ")) return;
        const description = article.querySelector<HTMLElement>(".cn-description")?.textContent?.trim() || "";
        article.setAttribute(MARK,"1");
        const actions = document.createElement("div"); actions.className = "leo-transcript-action";
        const button = document.createElement("button"); button.type = "button"; button.textContent = "Ver íntegra da reunião";
        button.addEventListener("click",(event)=>{ event.preventDefault(); event.stopPropagation(); void openTranscript(title,description); });
        actions.append(button); article.append(actions);
      });
    };
    const observer = new MutationObserver(mount);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    mount();
    return () => observer.disconnect();
  },[]);
  return null;
}
