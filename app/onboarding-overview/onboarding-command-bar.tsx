"use client";

import { useCallback, useEffect, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";

const PROFILE_API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-overview-api`;
const COMMAND_API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-command-api`;

type Feedback = { tone: "ok" | "bad" | "info"; text: string } | null;

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
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.access_token) return;

    setBusy(true);
    setFeedback({ tone: "info", text: "Interpretando e atualizando o onboarding…" });
    try {
      const response = await fetch(COMMAND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: clean }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const options = Array.isArray(body.options) && body.options.length ? ` Opções: ${body.options.join(", ")}.` : "";
        throw new Error(`${body.detail || body.error || "Não foi possível aplicar a atualização."}${options}`);
      }
      setFeedback({ tone: "ok", text: String(body.message || "Onboarding atualizado.") });
      setCommand("");
      window.dispatchEvent(new CustomEvent("ops-onboarding-updated", { detail: body }));
      window.setTimeout(() => window.location.reload(), 850);
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
      <div><span>COMANDO OPERACIONAL · ADLER</span><b>Atualizar onboarding por texto</b></div>
      <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expandir comando" : "Recolher comando"}>{collapsed ? "↑" : "↓"}</button>
    </div>
    {!collapsed && <>
      <form onSubmit={submit}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Ex.: Estela Giraldi avançou a etapa atual"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !command.trim()}>{busy ? "Aplicando…" : "Aplicar atualização"}</button>
      </form>
      <p>Também entende frases como “Estela concluiu Produto + Persona” ou “Estela fez a integração com o GT”. Se cliente ou etapa ficarem ambíguos, nada é alterado.</p>
      {feedback && <div className={`ocb-feedback ${feedback.tone}`}>{feedback.text}</div>}
    </>}
  </aside>;
}

const styles = `
.ocb{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:90;width:min(920px,calc(100vw - 34px));background:linear-gradient(135deg,#071c30,#071522);border:1px solid #28618a;border-radius:16px;padding:13px 14px;box-shadow:0 18px 55px #0009;color:#edf6ff;font-family:Inter,system-ui,sans-serif}.ocb.collapsed{width:min(420px,calc(100vw - 34px))}.ocb-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.ocb-head span{display:block;color:#4aa8ec;font-size:9px;letter-spacing:.14em;font-weight:900}.ocb-head b{display:block;font-size:14px;margin-top:3px}.ocb-head>button{border:1px solid #234d6d;background:#09233a;color:#cfeaff;width:32px;height:32px;border-radius:9px;cursor:pointer}.ocb form{display:grid;grid-template-columns:1fr auto;gap:9px;margin-top:11px}.ocb input{min-width:0;border:1px solid #234d6d;background:#04111d;color:#edf6ff;border-radius:10px;padding:12px 13px;outline:none;font-size:13px}.ocb input:focus{border-color:#3c8fc4;box-shadow:0 0 0 2px #1d5d8633}.ocb form button{border:1px solid #267658;background:#0c3a30;color:#a7f3d0;border-radius:10px;padding:0 16px;font-weight:900;cursor:pointer}.ocb form button:disabled{opacity:.55;cursor:wait}.ocb>p{margin:8px 2px 0;color:#7897b0;font-size:10px;line-height:1.45}.ocb-feedback{margin-top:9px;border-radius:9px;padding:9px 11px;font-size:11px;font-weight:700}.ocb-feedback.ok{border:1px solid #246a56;background:#0a2b25;color:#8ce9c9}.ocb-feedback.bad{border:1px solid #773642;background:#2d141b;color:#ffadb8}.ocb-feedback.info{border:1px solid #2a5879;background:#0a2032;color:#a8d9fb}@media(max-width:680px){.ocb form{grid-template-columns:1fr}.ocb form button{padding:11px 14px}.ocb{bottom:10px}}
`;
