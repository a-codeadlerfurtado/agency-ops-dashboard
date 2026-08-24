"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const ADMIN_AUTH_URL = `${SUPABASE_URL}/functions/v1/agency-ops-admin-auth`;
const ADLER_EMAIL = "adlerfurtadomkt01@gmail.com";

export default function TeamAccessAdmin() {
  const [session, setSession] = useState<Session | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [targetEmail, setTargetEmail] = useState("lakassessoriadigital@gmail.com");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const isAdler = session?.user?.email?.toLowerCase() === ADLER_EMAIL;

  useEffect(() => {
    if (!isAdler) {
      document.getElementById("ops-team-access-admin-slot")?.remove();
      setSlot(null);
      return;
    }

    let active = true;
    const mount = () => {
      if (!active) return;
      const team = document.querySelector(".team-center");
      if (!team) {
        document.getElementById("ops-team-access-admin-slot")?.remove();
        setSlot(null);
        return;
      }

      const existing = document.getElementById("ops-team-access-admin-slot") as HTMLElement | null;
      if (existing) {
        setSlot(existing);
        return;
      }

      const head = team.querySelector(":scope > .workspace-head");
      const node = document.createElement("div");
      node.id = "ops-team-access-admin-slot";
      if (head?.parentElement) head.parentElement.insertBefore(node, head.nextSibling);
      else team.prepend(node);
      setSlot(node);
    };

    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(mount, 800);

    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.getElementById("ops-team-access-admin-slot")?.remove();
      setSlot(null);
    };
  }, [isAdler]);

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.access_token || busy) return;

    setBusy(true);
    setMessage("");
    setSuccess(false);
    try {
      const response = await fetch(ADMIN_AUTH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "RESET_PASSWORD",
          target_email: targetEmail.trim(),
          password,
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) {
        const labels: Record<string, string> = {
          unauthorized: "Sua sessão expirou. Entre novamente no dashboard.",
          forbidden: "Este controle é exclusivo do Adler.",
          invalid_target_email: "Informe um e-mail válido.",
          invalid_password_length: "A senha precisa ter entre 10 e 128 caracteres.",
          target_not_in_team: "Esse e-mail não pertence a um colaborador ativo da equipe.",
          auth_user_not_found: "O colaborador não possui usuário correspondente no Auth.",
          password_update_failed: "O Supabase recusou a troca da senha.",
        };
        throw new Error(labels[String(body?.error)] || body?.detail || "Não foi possível redefinir a senha.");
      }

      setSuccess(true);
      setPassword("");
      setMessage(`Senha de ${body.target_person || targetEmail} redefinida com sucesso.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível redefinir a senha.");
    } finally {
      setBusy(false);
    }
  }

  if (!isAdler || !slot) return null;

  return createPortal(
    <section
      className="card section"
      aria-label="Administração de acessos da equipe"
      style={{ marginBottom: 18, borderColor: "color-mix(in srgb, var(--blue) 34%, var(--line))" }}
    >
      <div className="section-head">
        <div>
          <div className="section-title">Acessos da equipe</div>
          <div className="subtitle">Reset administrativo de senha · somente Adler · ação registrada em auditoria</div>
        </div>
        <span className="chip">ADMIN</span>
      </div>

      <form onSubmit={resetPassword} style={{ display: "grid", gridTemplateColumns: "minmax(240px,1fr) minmax(220px,1fr) auto", gap: 10, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 6 }}>
          <small>Login do colaborador</small>
          <input
            className="control"
            type="email"
            autoComplete="off"
            value={targetEmail}
            onChange={(event) => setTargetEmail(event.target.value)}
            required
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <small>Nova senha</small>
          <input
            className="control"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Digite a nova senha"
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy || password.length < 10} style={{ minHeight: 42 }}>
          {busy ? "Redefinindo…" : "Redefinir senha"}
        </button>
      </form>

      {message && (
        <div className={success ? "action-message" : "error-box"} role="status" style={{ marginTop: 10 }}>
          {message}
        </div>
      )}
      <div className="small" style={{ marginTop: 8 }}>
        A senha nunca é exibida nem salva no dashboard. Ela segue diretamente para o Supabase Auth e o log registra somente quem fez o reset e para qual usuário.
      </div>
    </section>,
    slot,
  );
}
