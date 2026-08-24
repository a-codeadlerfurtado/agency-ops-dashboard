"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_URL, authenticatedFetch } from "./shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-team-now-api`;

function time(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(d);
}
function labelTopic(v: unknown) {
  const s = String(v || "").trim();
  if (!s) return "assunto não identificado";
  return s.charAt(0).toUpperCase() + s.slice(1).replaceAll("_", " ");
}

export default function TeamNowBridge() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [payload, setPayload] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      if (!response.ok) { setPayload(null); return; }
      const body = await response.json().catch(() => null);
      if (body?.ok) setPayload(body);
    } catch {
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (window.location.pathname !== "/") return;
    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (window.location.pathname !== "/") return;
    const attach = () => {
      const anchors = [...document.querySelectorAll<HTMLElement>("section.grid.kpis")];
      const anchor = anchors.find((node) => node.textContent?.includes("Clientes ativos")) || null;
      if (!anchor) { setTarget(null); return; }
      let host = anchor.parentElement?.querySelector<HTMLElement>(":scope > [data-team-now-host]") || null;
      if (!host) {
        host = document.createElement("div");
        host.dataset.teamNowHost = "true";
        anchor.insertAdjacentElement("afterend", host);
      }
      setTarget(host);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelectorAll("[data-team-now-host]").forEach((node) => node.remove());
    };
  }, []);

  const members: Row[] = payload?.members || [];
  const active = useMemo(() => members.filter((m) => m.presence === "IN_MEETING"), [members]);
  const probable = useMemo(() => members.filter((m) => m.presence === "PROBABLE"), [members]);

  if (!target || !payload) return null;

  return createPortal(
    <section className="team-now-card">
      <style>{styles}</style>
      <header className="team-now-head">
        <div>
          <span className="team-now-eyebrow">PRESENÇA · TEMPO REAL OPERACIONAL</span>
          <h2>Equipe agora</h2>
          <p>Quem está em reunião neste momento, com cliente/assunto quando houver evidência suficiente.</p>
        </div>
        <div className="team-now-summary">
          <span><b>{active.length}</b> em reunião</span>
          <span><b>{probable.length}</b> provável</span>
          <button type="button" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
        </div>
      </header>

      <div className="team-now-grid">
        {members.map((member) => {
          const meeting = member.meeting || null;
          const state = member.presence === "IN_MEETING" ? "live" : member.presence === "PROBABLE" ? "probable" : "free";
          const recentMeeting = meeting?.started_at ? `Última reunião ${time(meeting.started_at)}` : "Sem reunião detectada nas últimas 12h";
          return <article key={member.person} className={`team-now-person ${state}`}>
            <div className="team-now-person-top">
              <i />
              <div><b>{member.person}</b><small>{member.role}</small></div>
              <span>{member.presence_label}</span>
            </div>
            {member.presence === "IN_MEETING" || member.presence === "PROBABLE" ? <>
              <strong>{meeting?.client_name || "Cliente identificando…"}</strong>
              <p>{labelTopic(meeting?.topic)} · desde {time(meeting?.started_at)}</p>
              <footer>{meeting?.source === "WHATSAPP_MEET" ? "Meet/WhatsApp" : "Donnah"}{meeting?.confidence != null ? ` · ${Math.round(Number(meeting.confidence) * 100)}% confiança` : ""}</footer>
            </> : <>
              <strong>Disponível</strong>
              <p>{recentMeeting}</p>
              {meeting?.context_available && <footer>Contexto da última reunião já recebido</footer>}
            </>}
          </article>;
        })}
      </div>
      <div className="team-now-note"><b>Regra de confiança:</b> “Em reunião” exige início recente em andamento; “Provável” é detecção recente ainda sem confirmação contínua. Quando o Donnah entrega o contexto final, a reunião deixa de ser tratada como presença ao vivo.</div>
    </section>,
    target,
  );
}

const styles = `
.team-now-card{width:100%;margin:0 0 14px;border:1px solid rgba(92,143,126,.24);border-radius:16px;background:linear-gradient(145deg,rgba(15,30,25,.98),rgba(9,19,16,.98));padding:17px;color:#e9f4ef;font-family:Inter,system-ui,sans-serif}.team-now-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:13px}.team-now-eyebrow{font-size:9px;letter-spacing:.14em;color:#72b394;font-weight:850}.team-now-head h2{font:800 21px/1.1 'Inter Tight',Inter,sans-serif;margin:4px 0}.team-now-head p{font-size:10px;color:#789187;margin:0}.team-now-summary{display:flex;align-items:center;gap:7px}.team-now-summary span{border:1px solid #264238;background:#0b1814;border-radius:999px;padding:6px 9px;font-size:9px;color:#8ba59a}.team-now-summary span b{color:#e7f4ee}.team-now-summary button{border:1px solid #2b473d;background:#0b1814;color:#abc1b8;border-radius:8px;padding:7px 9px;font:inherit;font-size:9px;font-weight:750;cursor:pointer}.team-now-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.team-now-person{border:1px solid #1f352d;border-radius:12px;background:#09130f;padding:11px;min-height:132px}.team-now-person.live{border-color:rgba(255,91,83,.45);background:linear-gradient(160deg,rgba(66,21,19,.48),#0a1411)}.team-now-person.probable{border-color:rgba(240,190,86,.38)}.team-now-person-top{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:7px}.team-now-person-top i{width:8px;height:8px;border-radius:50%;background:#5f776d;box-shadow:0 0 0 4px rgba(95,119,109,.08)}.team-now-person.live .team-now-person-top i{background:#ff6f67;box-shadow:0 0 0 4px rgba(255,111,103,.09)}.team-now-person.probable .team-now-person-top i{background:#e9bd61;box-shadow:0 0 0 4px rgba(233,189,97,.09)}.team-now-person-top div b{display:block;font-size:10px}.team-now-person-top div small{display:block;color:#698176;font-size:8px;margin-top:2px}.team-now-person-top>span{font-size:8px;color:#81998f;text-align:right}.team-now-person.live .team-now-person-top>span{color:#ffaaa5}.team-now-person.probable .team-now-person-top>span{color:#f0cf87}.team-now-person>strong{display:block;font-size:11px;margin:13px 0 4px}.team-now-person>p{font-size:9px;color:#7e978d;margin:0;line-height:1.4}.team-now-person>footer{font-size:8px;color:#60796f;border-top:1px solid #182a23;margin-top:10px;padding-top:7px}.team-now-note{border-top:1px solid #1c3028;margin-top:12px;padding-top:10px;color:#6f887e;font-size:8px;line-height:1.45}.team-now-note b{color:#9cb4aa}@media(max-width:1180px){.team-now-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.team-now-head{align-items:flex-start;flex-direction:column}.team-now-summary{flex-wrap:wrap}.team-now-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){.team-now-grid{grid-template-columns:1fr}}
`;
