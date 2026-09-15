"use client";

import { useCallback, useEffect, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";

const PROFILE_API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-overview-api`;
const COMMAND_API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-command-api`;

type Feedback = { tone: "ok" | "bad" | "info"; text: string } | null;

function plain(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeNaturalCommand(value: string) {
  let out = value.trim();

  // Horários escritos do jeito natural: "10 horas", "10 horas e 30", "10 h", "10hrs".
  out = out
    .replace(/\b(\d{1,2})\s*horas?\s+e\s+(\d{1,2})\b/gi, "$1h$2")
    .replace(/\b(\d{1,2})\s*(?:horas?|hrs?|hs)\b/gi, "$1h")
    .replace(/\b(\d{1,2})\s+h\b/gi, "$1h");

  const n = plain(out);
  const alreadyImperative = /\b(reagenda|reagendar|agenda|agendar|agendou|remarca|remarcar|marca reuniao|marcar reuniao)\b/.test(n);
  const declarativeSchedule = /\b(reuniao|encontro|meet)\b.*\b(marcada|marcado|agendada|agendado|ficou|sera|vai ser)\b/.test(n)
    || /\b(marcada|marcado|agendada|agendado)\b.*\bpara\b/.test(n)
    || /\btem reuniao\b/.test(n);
  const stageDeclaration = /\b(esta|ta|fica|ficou|segue|encontra se)\s+(?:agora\s+)?(?:em|na|no)\b/.test(n);
  const hasMeetingCue = /\b(reuniao|meet|encontro)\b/.test(n);
  const hasDate = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(value) || /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(n);
  const negativeCompletion = /\b(ainda nao|nao)\b.*\b(feita|feito|realizada|realizado|concluida|concluido|aconteceu|ocorreu)\b/.test(n);
  const waiting = /\b(aguardando|esperando|a espera|pendente)\b/.test(n);
  const happened = /\b(reuniao|integracao|apresentacao)\b.*\b(aconteceu|ocorreu|foi realizada|foi realizado)\b/.test(n)
    || /\b(fez|realizou)\b.*\b(reuniao|integracao|apresentacao)\b/.test(n);

  // O backend antigo entende muito bem ordens. Aqui transformamos frases de realidade em ordens equivalentes.
  if (!alreadyImperative && (declarativeSchedule || (stageDeclaration && hasMeetingCue && hasDate))) {
    out = `agendar ${out}; case.onboarding_risk=OK; case.blocked_by=null`;
  } else if (negativeCompletion || waiting) {
    out = `status pendente ${out}`;
  } else if (happened) {
    out = `concluiu ${out}`;
  } else if (stageDeclaration) {
    out = `status andamento ${out}; case.onboarding_risk=OK; case.blocked_by=null`;
  }

  return out;
}

export default function OnboardingCommandBar() {
  const [allowed, setAllowed] = useState(false);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [collapsed, setCollapsed] = useState(false);

  const detectProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.access_token) return;
    try {
      const response = await fetch(PROFILE_API, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      setAllowed(Boolean(body?.profile?.is_adler) || String(body?.profile?.person || "") === "Adler Furtado");
    } catch {
      setAllowed(false);
    }
  }, []);

  useEffect(() => { detectProfile(); }, [detectProfile]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = command.trim();
    if (!clean || busy) return;
    const interpretedCommand = normalizeNaturalCommand(clean);
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.access_token) return;

    setBusy(true);
    setFeedback({ tone: "info", text: "Interpretando a frase e aplicando a alteração…" });
    try {
      const response = await fetch(COMMAND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: interpretedCommand }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const options = Array.isArray(body.options) && body.options.length ? ` Opções: ${body.options.join(", ")}.` : "";
        throw new Error(`${body.detail || body.error || "Não foi possível aplicar a atualização."}${options}`);
      }
      setFeedback({ tone: "ok", text: String(body.message || "Onboarding atualizado e auditado.") });
      setCommand("");
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
      window.setTimeout(() => window.location.reload(), 700);
    } catch (caught) {
      setFeedback({ tone: "bad", text: caught instanceof Error ? caught.message : "Falha ao atualizar onboarding." });
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;

  return <aside className={`ocb ${collapsed ? "collapsed" : ""}`}>
    <style>{styles}</style>
    <div className="ocb-head">
      <div><span>COMANDO ADMINISTRATIVO · ADLER</span><b>Fale o estado real do onboarding</b></div>
      <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expandir comando" : "Recolher comando"}>{collapsed ? "↑" : "↓"}</button>
    </div>
    {!collapsed && <>
      <form onSubmit={submit}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Ex.: Trilar está em Produto + Persona, reunião marcada para 24/08 às 10 horas"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !command.trim()}>{busy ? "Aplicando…" : "Aplicar alteração"}</button>
      </form>
      <p>Escreva como você falaria: “está em Produto + Persona, reunião marcada para segunda às 10 horas”, “integração já foi feita”, “ainda não fez a apresentação”, “aguardando cliente”, “muda o GT para Yuri”. O campo traduz a frase para o comando seguro e toda mudança continua gravando antes/depois.</p>
      {feedback && <div className={`ocb-feedback ${feedback.tone}`}>{feedback.text}</div>}
    </>}
  </aside>;
}

const styles = `
.ocb{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:90;width:min(980px,calc(100vw - 34px));background:linear-gradient(135deg,#071c30,#071522);border:1px solid #28618a;border-radius:16px;padding:13px 14px;box-shadow:0 18px 55px #0009;color:#edf6ff;font-family:Inter,system-ui,sans-serif}.ocb.collapsed{width:min(440px,calc(100vw - 34px))}.ocb-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.ocb-head span{display:block;color:#4aa8ec;font-size:9px;letter-spacing:.14em;font-weight:900}.ocb-head b{display:block;font-size:14px;margin-top:3px}.ocb-head>button{border:1px solid #234d6d;background:#09233a;color:#cfeaff;width:32px;height:32px;border-radius:9px;cursor:pointer}.ocb form{display:grid;grid-template-columns:1fr auto;gap:9px;margin-top:11px}.ocb input{min-width:0;border:1px solid #234d6d;background:#04111d;color:#edf6ff;border-radius:10px;padding:12px 13px;outline:none;font-size:13px}.ocb input:focus{border-color:#3c8fc4;box-shadow:0 0 0 2px #1d5d8633}.ocb form button{border:1px solid #267658;background:#0c3a30;color:#a7f3d0;border-radius:10px;padding:0 16px;font-weight:900;cursor:pointer}.ocb form button:disabled{opacity:.55;cursor:wait}.ocb>p{margin:8px 2px 0;color:#7897b0;font-size:10px;line-height:1.5}.ocb-feedback{margin-top:9px;border-radius:9px;padding:9px 11px;font-size:11px;font-weight:700}.ocb-feedback.ok{border:1px solid #246a56;background:#0a2b25;color:#8ce9c9}.ocb-feedback.bad{border:1px solid #773642;background:#2d141b;color:#ffadb8}.ocb-feedback.info{border:1px solid #2a5879;background:#0a2032;color:#a8d9fb}@media(max-width:680px){.ocb form{grid-template-columns:1fr}.ocb form button{padding:11px 14px}.ocb{bottom:10px}}
`;
