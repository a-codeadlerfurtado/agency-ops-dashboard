"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-lead-quality-api`;

type MissingExtra = { question?: string; line?: number };
type Incident = {
  id: string;
  message_id: string;
  client_id: string | null;
  client_name: string | null;
  target_gt: string | null;
  product_label: string | null;
  missing_required: string[];
  missing_extra_questions: MissingExtra[];
  occurrence_no: number;
  severity: "ATTENTION" | "CRITICAL";
  status: string;
  raw_text: string | null;
  created_at: string;
};

const when = (value: string) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
}).format(new Date(value));

export default function LeadQualityAlert() {
  const [session, setSession] = useState<Session | null>(null);
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setEligible(null);
      if (!next) setIncidents([]);
    });
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) {
      setIncidents([]);
      setEligible(null);
      return;
    }
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = await response.json();
      const canReceive = Boolean(body?.eligible);
      setEligible(canReceive);
      setIncidents(canReceive && Array.isArray(body?.incidents) ? body.incidents : []);
    } catch {}
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    const timer = window.setTimeout(load, 55_000);
    return () => window.clearTimeout(timer);
  }, [load, session?.access_token]);

  const sorted = useMemo(() => [...incidents].sort((a, b) =>
    Number(b.occurrence_no) - Number(a.occurrence_no) ||
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  ), [incidents]);
  const incident = sorted[0] ?? null;

  const acknowledge = useCallback(async () => {
    if (!incident || !session?.access_token || acking) return;
    setAcking(true);
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ incident_id: incident.id }),
      });
      if (!response.ok) return;
      await load();
    } finally {
      setAcking(false);
    }
  }, [acking, incident, load, session?.access_token]);

  if (!incident) return null;

  const occurrence = Number(incident.occurrence_no || 1);
  const recurrent = occurrence >= 2;
  const critical = occurrence >= 3;
  const eyebrow = critical
    ? `RECORRÊNCIA CRÍTICA · ${occurrence}ª OCORRÊNCIA DO MESMO PRODUTO`
    : recurrent
      ? `${occurrence}ª OCORRÊNCIA DO MESMO PRODUTO · URGENTE`
      : "ALERTA DE QUALIDADE DE LEAD · SUA CARTEIRA";
  const title = critical
    ? "Falha recorrente no envio de leads"
    : recurrent
      ? "O mesmo produto falhou novamente"
      : "Lead incompleto enviado ao cliente";
  const extras = Array.isArray(incident.missing_extra_questions) ? incident.missing_extra_questions : [];
  const required = Array.isArray(incident.missing_required) ? incident.missing_required : [];

  return (
    <div className={`lqa-backdrop ${recurrent ? "recurrent" : ""} ${critical ? "critical" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="lqa-title" aria-describedby="lqa-desc">
      <style>{styles}</style>
      <section className="lqa-card">
        <div className="lqa-warning" aria-hidden="true">!</div>
        <div className="lqa-heading">
          <span>{eyebrow}</span>
          <h2 id="lqa-title">{title}</h2>
          <p id="lqa-desc">
            Um disparo de <strong>{incident.product_label || "produto não identificado"}</strong> para <strong>{incident.client_name || "cliente não identificado"}</strong> chegou com dado obrigatório ou resposta incompleta. Corrija a origem antes que o próximo lead seja perdido.
          </p>
        </div>

        <div className="lqa-meta">
          <div><span>Cliente</span><b>{incident.client_name || "Não identificado"}</b></div>
          <div><span>Produto</span><b>{incident.product_label || "Não identificado"}</b></div>
          <div><span>Ocorrência</span><b>{occurrence}ª neste produto</b></div>
          <div><span>Detectado</span><b>{when(incident.created_at)}</b></div>
        </div>

        <div className="lqa-missing">
          <h3>O que chegou incompleto</h3>
          <div className="lqa-chips">
            {required.map((field) => <span key={field}>{field}: AUSENTE / INVÁLIDO</span>)}
            {extras.map((item, index) => <span key={`${item.question || "pergunta"}-${index}`}>Pergunta sem resposta: {item.question || `campo adicional ${index + 1}`}</span>)}
          </div>
        </div>

        <div className="lqa-content">
          <div className="lqa-content-head"><b>Conteúdo exato do disparo</b><small>Mensagem capturada pela Z-API</small></div>
          <pre>{incident.raw_text || "[SEM CONTEÚDO DE TEXTO]"}</pre>
        </div>

        <div className="lqa-footer">
          <div>
            <b>{recurrent ? "Isto já aconteceu antes neste mesmo produto." : "Ação imediata necessária."}</b>
            <span>{sorted.length > 1 ? `Há ${sorted.length} alertas pendentes na sua carteira. Ao reconhecer este, o próximo será exibido.` : "O reconhecimento fica registrado com seu usuário e horário."}</span>
          </div>
          <button disabled={acking} onClick={acknowledge}>{acking ? "Registrando…" : "Ciente — vou resolver"}</button>
        </div>
      </section>
    </div>
  );
}

const styles = `.lqa-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(10,2,4,.96);backdrop-filter:blur(12px);display:grid;place-items:center;padding:8px;font-family:Inter,system-ui,sans-serif;color:#fff;overflow:hidden;box-sizing:border-box}.lqa-card{width:min(980px,100%);height:min(760px,calc(100dvh - 16px));min-height:0;overflow:hidden;border:1px solid #6d2831;border-radius:22px;background:radial-gradient(circle at 12% 0,rgba(255,78,94,.22),transparent 34%),linear-gradient(145deg,#1a080b,#0a0d13 58%);box-shadow:0 42px 120px rgba(0,0,0,.68);padding:22px;display:grid;grid-template-columns:66px minmax(0,1fr);grid-template-rows:auto auto auto minmax(90px,1fr) auto;gap:9px 14px;box-sizing:border-box}.lqa-backdrop.recurrent .lqa-card{border-color:#a93442;box-shadow:0 42px 130px rgba(116,0,19,.38)}.lqa-backdrop.critical .lqa-card{border-color:#ff4c5f;box-shadow:0 0 0 1px rgba(255,76,95,.25),0 48px 150px rgba(126,0,18,.5)}.lqa-warning{grid-column:1;grid-row:1;width:60px;height:60px;border-radius:15px;display:grid;place-items:center;background:#ff4c5f;color:#1b0307;font-size:44px;line-height:1;font-weight:1000;box-shadow:0 0 0 8px rgba(255,76,95,.1)}.lqa-heading{grid-column:2;grid-row:1;min-width:0}.lqa-heading span{display:block;color:#ff8995;font-size:10px;font-weight:900;letter-spacing:.12em}.lqa-heading h2{font-family:'Inter Tight',Inter,sans-serif;font-size:clamp(30px,4vw,46px);line-height:.98;letter-spacing:-.045em;margin:5px 0 7px}.lqa-heading p{margin:0;color:#ccd3dd;line-height:1.38;max-width:820px;font-size:14px}.lqa-heading p strong{color:#fff}.lqa-meta{grid-column:1/-1;grid-row:2;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;min-height:0}.lqa-meta div{border:1px solid #342027;border-radius:11px;background:rgba(7,8,12,.72);padding:8px 10px;min-width:0}.lqa-meta span,.lqa-meta b{display:block}.lqa-meta span{font-size:9px;color:#8f9bab;text-transform:uppercase;letter-spacing:.09em}.lqa-meta b{margin-top:3px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lqa-missing{grid-column:1/-1;grid-row:3;border:1px solid #5b2931;background:rgba(72,14,25,.23);border-radius:12px;padding:9px 11px;min-height:0}.lqa-missing h3{margin:0 0 6px;font-size:12px}.lqa-chips{display:flex;flex-wrap:wrap;gap:6px}.lqa-chips span{border:1px solid #8a3542;background:#3a1118;color:#ffd8dc;border-radius:999px;padding:5px 8px;font-size:10px;font-weight:800}.lqa-content{grid-column:1/-1;grid-row:4;border:1px solid #2d333d;border-radius:12px;background:#070a0f;overflow:hidden;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.lqa-content-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 11px;border-bottom:1px solid #252a32}.lqa-content-head b{font-size:11px}.lqa-content-head small{font-size:9px;color:#7d8998}.lqa-content pre{margin:0;padding:11px;min-height:0;height:100%;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d7dde6;box-sizing:border-box}.lqa-footer{grid-column:1/-1;grid-row:5;display:flex;justify-content:space-between;align-items:center;gap:14px;min-height:0}.lqa-footer>div{min-width:0}.lqa-footer>div b,.lqa-footer>div span{display:block}.lqa-footer>div b{font-size:11px}.lqa-footer>div span{color:#8995a4;font-size:10px;margin-top:3px;line-height:1.3}.lqa-footer button{border:1px solid #ff7180;background:#ff4c5f;color:#190307;border-radius:11px;padding:10px 15px;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap;flex:0 0 auto}.lqa-footer button:disabled{opacity:.55;cursor:wait}@media(max-height:760px) and (min-width:761px){.lqa-card{height:calc(100dvh - 12px);padding:15px;grid-template-columns:54px minmax(0,1fr);gap:6px 10px;border-radius:18px}.lqa-warning{width:48px;height:48px;border-radius:12px;font-size:35px;box-shadow:0 0 0 6px rgba(255,76,95,.1)}.lqa-heading span{font-size:9px}.lqa-heading h2{font-size:34px;margin:2px 0 4px}.lqa-heading p{font-size:12px;line-height:1.25}.lqa-meta{gap:6px}.lqa-meta div{padding:6px 8px}.lqa-meta span{font-size:8px}.lqa-meta b{font-size:11px;margin-top:2px}.lqa-missing{padding:7px 9px}.lqa-missing h3{font-size:11px;margin-bottom:4px}.lqa-chips span{padding:4px 7px;font-size:9px}.lqa-content-head{padding:6px 9px}.lqa-content pre{padding:8px;font-size:10px;line-height:1.35}.lqa-footer>div b{font-size:10px}.lqa-footer>div span{font-size:9px}.lqa-footer button{padding:8px 12px;font-size:11px}}@media(max-width:760px){.lqa-backdrop{padding:6px;overflow:auto;place-items:start center}.lqa-card{height:auto;max-height:none;min-height:calc(100dvh - 12px);padding:14px;grid-template-columns:46px minmax(0,1fr);grid-template-rows:auto auto auto minmax(160px,38vh) auto;gap:8px 10px;border-radius:16px;overflow:visible}.lqa-warning{width:42px;height:42px;border-radius:11px;font-size:31px;box-shadow:0 0 0 5px rgba(255,76,95,.1)}.lqa-heading h2{font-size:28px;margin:3px 0 5px}.lqa-heading p{font-size:12px;line-height:1.3}.lqa-meta{grid-template-columns:1fr 1fr}.lqa-footer{align-items:stretch;flex-direction:column}.lqa-footer button{width:100%}}`;
