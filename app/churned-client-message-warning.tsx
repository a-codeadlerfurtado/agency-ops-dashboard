"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Warning = {
  id: string;
  client_name: string;
  chat_name?: string | null;
  target_person: string;
  actor_name: string;
  message_type?: string | null;
  message_text?: string | null;
  message_at: string;
  churned_at?: string | null;
  is_good_morning: boolean;
};

const ENDPOINT = `${SUPABASE_URL}/functions/v1/agency-ops-churned-client-message-warning`;

function when(value: string | null | undefined) {
  if (!value) return "agora";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function ChurnedClientMessageWarning() {
  const [warning, setWarning] = useState<Warning | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);

  const claim = useCallback(async () => {
    if (loadingRef.current || enabled === false) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setWarning(null);
      setEnabled(null);
      return;
    }
    loadingRef.current = true;
    try {
      const response = await fetch(ENDPOINT, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) return;
      setEnabled(body.enabled !== false);
      if (body.alert) setWarning(body.alert as Warning);
    } catch {
      // O aviso não deve derrubar o dashboard em caso de indisponibilidade momentânea.
    } finally {
      loadingRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    void claim();
    if (enabled === false) return;
    const timer = window.setInterval(() => void claim(), 5000);
    const onFocus = () => void claim();
    const onVisible = () => { if (document.visibilityState === "visible") void claim(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [claim, enabled]);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setWarning(null);
        setEnabled(null);
      } else {
        setEnabled(null);
        window.setTimeout(() => void claim(), 250);
      }
    });
    return () => subscription.unsubscribe();
  }, [claim]);

  useEffect(() => {
    if (!warning) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", blockEscape, true);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", blockEscape, true);
    };
  }, [warning]);

  async function acknowledge() {
    if (!warning || busy) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "ACK", id: warning.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setWarning(null);
      window.setTimeout(() => void claim(), 180);
    } catch {
      setError("Não consegui registrar sua confirmação. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  if (!warning) return null;

  const goodMorning = Boolean(warning.is_good_morning);
  return (
    <div className="churn-msg-shield" role="alertdialog" aria-modal="true" aria-labelledby="churn-msg-title">
      <style>{styles}</style>
      <div className="churn-msg-noise" />
      <section className={`churn-msg-card${goodMorning ? " morning" : ""}`}>
        <div className="churn-msg-kicker"><span>⚠</span> ERRO OPERACIONAL DETECTADO</div>
        <div className="churn-msg-status">CLIENTE CHURNED</div>
        <h1 id="churn-msg-title">
          {goodMorning
            ? "VOCÊ ACABOU DE DAR BOM DIA PARA UM CLIENTE QUE JÁ DEU CHURN."
            : "VOCÊ ACABOU DE ENVIAR UMA MENSAGEM PARA UM CLIENTE QUE JÁ DEU CHURN."}
        </h1>
        <p className="churn-msg-bronca">
          {goodMorning
            ? "Pare de operar no automático. Esse grupo já não pertence à carteira ativa. Antes de mandar bom dia, cobrar retorno ou continuar qualquer conversa, confira o status do cliente no dashboard."
            : "Esse cliente já saiu da operação. Continuar movimentando o grupo como se ele estivesse ativo passa falta de controle e pode gerar ruído desnecessário. Confira o status antes de qualquer novo contato."}
        </p>

        <div className="churn-msg-client">
          <small>CLIENTE ENCERRADO</small>
          <strong>{warning.client_name}</strong>
          {warning.chat_name && <span>{warning.chat_name}</span>}
        </div>

        <div className="churn-msg-grid">
          <div><small>MENSAGEM DETECTADA</small><p>“{warning.message_text || `[${warning.message_type || "mensagem"}]`}”</p></div>
          <div><small>ENVIADA EM</small><p>{when(warning.message_at)}</p></div>
        </div>

        <div className="churn-msg-rule">
          <b>REGRA:</b> cliente em <strong>CHURNED</strong> não deve receber mensagem de rotina. Se existir algum motivo excepcional para contato, confirme antes com Operações.
        </div>

        {error && <div className="churn-msg-error">{error}</div>}
        <button type="button" onClick={acknowledge} disabled={busy}>
          {busy ? "REGISTRANDO…" : "ENTENDI — VOU CONFERIR ANTES DE ENVIAR"}
        </button>
        <small className="churn-msg-foot">O aviso fica registrado no histórico operacional.</small>
      </section>
    </div>
  );
}

const styles = `
.churn-msg-shield{position:fixed;inset:0;z-index:50000;display:grid;place-items:center;padding:24px;background:rgba(22,2,4,.96);backdrop-filter:blur(14px);color:#fff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;overflow:auto}
.churn-msg-noise{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 18%,rgba(255,70,70,.22),transparent 32rem),linear-gradient(rgba(255,255,255,.016) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px);background-size:auto,28px 28px,28px 28px;opacity:.9}
.churn-msg-card{position:relative;width:min(820px,100%);border:2px solid rgba(255,83,83,.72);border-radius:20px;padding:30px 34px;background:linear-gradient(180deg,rgba(49,6,9,.98),rgba(22,3,5,.99));box-shadow:0 30px 110px rgba(0,0,0,.72),0 0 80px rgba(255,50,50,.12)}
.churn-msg-card:before{content:"";position:absolute;inset:0;border-radius:18px;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.04)}
.churn-msg-kicker{display:flex;align-items:center;gap:9px;color:#ffb0b0;font:800 11px/1 Inter,sans-serif;letter-spacing:.14em}.churn-msg-kicker span{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#ff4545;color:#230000;font-size:15px}
.churn-msg-status{display:inline-flex;margin-top:22px;padding:7px 10px;border-radius:7px;background:#ff3f3f;color:#250000;font-size:12px;font-weight:900;letter-spacing:.12em}
.churn-msg-card h1{margin:18px 0 12px;font-family:"Inter Tight",Inter,sans-serif;font-size:clamp(34px,5.1vw,58px);line-height:.98;letter-spacing:-.045em;max-width:760px}.churn-msg-card.morning h1{color:#fff0f0}
.churn-msg-bronca{margin:0;max-width:720px;color:#efc7c7;font-size:16px;line-height:1.58}
.churn-msg-client{margin-top:24px;padding:17px 18px;border:1px solid rgba(255,92,92,.28);border-radius:12px;background:rgba(255,72,72,.08)}.churn-msg-client small,.churn-msg-grid small{display:block;color:#d98f8f;font-size:9px;font-weight:800;letter-spacing:.13em}.churn-msg-client strong{display:block;margin-top:6px;font-size:22px}.churn-msg-client span{display:block;margin-top:3px;color:#bb8b8b;font-size:12px}
.churn-msg-grid{display:grid;grid-template-columns:1.5fr .5fr;gap:10px;margin-top:10px}.churn-msg-grid>div{padding:14px 16px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:rgba(0,0,0,.18)}.churn-msg-grid p{margin:7px 0 0;color:#f4dddd;line-height:1.45;font-size:13px;word-break:break-word}
.churn-msg-rule{margin-top:14px;padding:13px 15px;border-left:4px solid #ff4d4d;background:rgba(255,255,255,.04);color:#efcaca;font-size:13px;line-height:1.5}.churn-msg-rule strong{color:#ff6d6d}.churn-msg-rule b{color:#fff}
.churn-msg-error{margin-top:12px;padding:10px 12px;border-radius:9px;background:rgba(255,180,70,.12);color:#ffd397;font-size:12px}
.churn-msg-card>button{width:100%;margin-top:20px;border:0;border-radius:11px;padding:15px 18px;background:#ff4949;color:#210000;font-weight:900;letter-spacing:.035em;cursor:pointer}.churn-msg-card>button:hover{filter:brightness(1.08)}.churn-msg-card>button:disabled{opacity:.6;cursor:wait}
.churn-msg-foot{display:block;text-align:center;margin-top:10px;color:#9e6f73;font-size:10px}
@media(max-width:650px){.churn-msg-shield{padding:12px}.churn-msg-card{padding:24px 20px}.churn-msg-grid{grid-template-columns:1fr}.churn-msg-card h1{font-size:36px}}
`;
