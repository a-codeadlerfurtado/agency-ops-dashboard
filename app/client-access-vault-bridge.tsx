"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

type VaultItem = {
  id: string;
  client_id: string;
  category: string;
  system_name: string;
  login_url?: string | null;
  created_at?: string | null;
  created_by_person?: string | null;
  updated_at?: string | null;
  updated_by_person?: string | null;
};

type VaultPayload = {
  ok: boolean;
  client?: { client_id: string; display_name: string };
  permissions?: { role: string; can_manage: boolean; can_reveal: boolean };
  items?: VaultItem[];
  audit?: Row[];
  error?: string;
};

type RevealedCredential = {
  id: string;
  category: string;
  system_name: string;
  login_url?: string | null;
  login?: string | null;
  password?: string | null;
  notes?: string | null;
  revealed_at?: string;
  expires_in_seconds?: number;
};

type Target = { name: string; mount: HTMLElement; root: HTMLElement; kind: string };

type EditorState = {
  itemId?: string;
  category: string;
  system_name: string;
  login_url: string;
  login: string;
  password: string;
  notes: string;
  clear_login: boolean;
  clear_notes: boolean;
  dashboard_password: string;
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-access-vault-api`;
const SLOT_CLASS = "client-access-vault-action-slot";

const CATEGORY_LABEL: Record<string, string> = {
  CRM: "CRM",
  SITE: "Site / WordPress",
  GOOGLE_BUSINESS: "Google Business",
  PORTAL: "Portal imobiliário",
  OTHER: "Outro sistema",
};

const ACTION_LABEL: Record<string, string> = {
  LIST: "abriu Acessos",
  REVEAL: "visualizou credencial",
  COPY_LOGIN: "copiou login",
  COPY_PASSWORD: "copiou senha",
  CREATE: "cadastrou acesso",
  UPDATE: "alterou acesso",
  DELETE: "removeu acesso",
  REAUTH_FAILED: "falhou na confirmação de identidade",
  REAUTH_LOCKED: "teve o cofre bloqueado temporariamente",
  ACCESS_DENIED: "teve acesso negado",
};

function formatDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function errorMessage(code: unknown) {
  const value = String(code || "");
  const map: Record<string, string> = {
    unauthorized: "Sua sessão expirou. Entre novamente no Dashboard.",
    forbidden: "Seu perfil não tem acesso às credenciais deste cliente.",
    management_only: "Somente a gestão pode cadastrar, editar ou remover credenciais.",
    invalid_reauthentication: "A senha do seu perfil do Dashboard está incorreta.",
    reauth_locked: "Muitas tentativas incorretas. O cofre foi bloqueado temporariamente por segurança.",
    client_not_found: "Não consegui identificar este cliente no banco.",
    ambiguous_client: "Há mais de um cliente com esse nome. O acesso foi bloqueado para evitar revelar a credencial errada.",
    credential_not_found: "Essa credencial não existe mais ou foi removida.",
    vault_key_missing: "O cofre ainda não foi ativado pelo administrador.",
    vault_key_invalid_length: "A chave criptográfica do cofre está inválida.",
    credential_decryption_failed: "Não foi possível descriptografar essa credencial.",
    credential_encryption_failed: "Não foi possível criptografar a credencial.",
    invalid_login_url: "A URL precisa começar com http:// ou https://.",
    system_name_required: "Informe o nome do CRM ou sistema.",
    password_required: "Informe a senha que será guardada no cofre.",
    origin_not_allowed: "Este endereço do Dashboard não está autorizado a acessar o cofre.",
  };
  return map[value] || "Não foi possível concluir essa ação agora.";
}

function blankEditor(item?: VaultItem): EditorState {
  return {
    itemId: item?.id,
    category: item?.category || "CRM",
    system_name: item?.system_name || "",
    login_url: item?.login_url || "",
    login: "",
    password: "",
    notes: "",
    clear_login: false,
    clear_notes: false,
    dashboard_password: "",
  };
}

function detectTarget(): Target | null {
  const candidates = [
    { kind: "drawer", root: ".drawer.open", head: ".drawer-head", heading: ".drawer-head h2" },
    { kind: "360", root: ".ops-360", head: ".ops-360-head", heading: ".ops-360-head h2" },
    { kind: "leonardo", root: ".leo-client-dossier", head: ".workspace-head", heading: ".workspace-head h2" },
  ];
  for (const candidate of candidates) {
    const root = document.querySelector(candidate.root) as HTMLElement | null;
    const head = root?.querySelector(candidate.head) as HTMLElement | null;
    const heading = root?.querySelector(candidate.heading) as HTMLElement | null;
    const name = (heading?.textContent || "").trim();
    if (!root || !head || !heading || !name || /carregando|buscando/i.test(name)) continue;
    let mount = head.querySelector(`:scope > .${SLOT_CLASS}`) as HTMLElement | null;
    if (!mount) {
      mount = document.createElement("div");
      mount.className = SLOT_CLASS;
      const close = head.querySelector(".close");
      if (close) head.insertBefore(mount, close);
      else head.appendChild(mount);
    }
    return { name, mount, root, kind: candidate.kind };
  }
  return null;
}

export default function ClientAccessVaultBridge() {
  const [target, setTarget] = useState<Target | null>(null);
  const [payload, setPayload] = useState<VaultPayload | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reauthItem, setReauthItem] = useState<VaultItem | null>(null);
  const [reauthPassword, setReauthPassword] = useState("");
  const [revealed, setRevealed] = useState<RevealedCredential | null>(null);
  const [revealUntil, setRevealUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [showSecret, setShowSecret] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteItem, setDeleteItem] = useState<VaultItem | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [toast, setToast] = useState("");
  const targetKeyRef = useRef("");
  const revealTimerRef = useRef<number | null>(null);

  const clearReveal = useCallback(() => {
    setRevealed(null);
    setRevealUntil(0);
    setSecondsLeft(0);
    setShowSecret(false);
    setReauthPassword("");
    setReauthItem(null);
    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = null;
  }, []);

  const api = useCallback(async (action: string, extra: Row = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("unauthorized");
    const clientId = payload?.client?.client_id;
    const body: Row = {
      action,
      ...(clientId ? { client_id: clientId } : { client_name: target?.name }),
      ...extra,
    };
    const response = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));
    if (!response.ok || !json?.ok) throw new Error(String(json?.error || `http_${response.status}`));
    return json as Row;
  }, [payload?.client?.client_id, target?.name]);

  const refresh = useCallback(async (silent = false) => {
    if (!target?.name) return;
    if (!silent) setChecking(true);
    setMessage("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setPayload(null);
        return;
      }
      const response = await fetch(API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ action: "LIST", client_name: target.name }),
      });
      const json = await response.json().catch(() => null);
      if (response.status === 403 || response.status === 404 || !json) {
        setPayload(null);
        setOpen(false);
        return;
      }
      if (!response.ok || !json.ok) throw new Error(String(json?.error || `http_${response.status}`));
      setPayload(json as VaultPayload);
    } catch (error) {
      setPayload(null);
      if (open) setMessage(errorMessage(error instanceof Error ? error.message : error));
    } finally {
      if (!silent) setChecking(false);
    }
  }, [open, target?.name]);

  useEffect(() => {
    let active = true;
    const scan = () => {
      if (!active) return;
      const next = detectTarget();
      const key = next ? `${next.kind}:${next.name}` : "";
      if (key === targetKeyRef.current) return;
      targetKeyRef.current = key;
      setTarget(next);
      setPayload(null);
      setOpen(false);
      setEditor(null);
      setDeleteItem(null);
      clearReveal();
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(scan, 1200);
    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.querySelectorAll(`.${SLOT_CLASS}`).forEach((node) => node.remove());
    };
  }, [clearReveal]);

  useEffect(() => {
    if (!target?.name) return;
    void refresh();
  }, [target?.name, refresh]);

  useEffect(() => {
    if (!revealUntil) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((revealUntil - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) clearReveal();
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [clearReveal, revealUntil]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) clearReveal();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearReveal]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const items = payload?.items || [];
  const canManage = Boolean(payload?.permissions?.can_manage);
  const role = payload?.permissions?.role || "";

  const revealedItem = useMemo(() => {
    if (!revealed) return null;
    return items.find((item) => item.id === revealed.id) || null;
  }, [items, revealed]);

  async function revealCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reauthItem || !reauthPassword) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api("REVEAL", { item_id: reauthItem.id, dashboard_password: reauthPassword });
      const credential = result.credential as RevealedCredential;
      setRevealed(credential);
      const ttl = Math.max(15, Math.min(120, Number(credential.expires_in_seconds || 60)));
      const until = Date.now() + ttl * 1000;
      setRevealUntil(until);
      setSecondsLeft(ttl);
      setReauthItem(null);
      setReauthPassword("");
      setShowSecret(false);
      if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = window.setTimeout(clearReveal, ttl * 1000);
      await refresh(true);
    } catch (error) {
      setMessage(errorMessage(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  async function copyValue(field: "LOGIN" | "PASSWORD", value: string | null | undefined) {
    if (!value || !revealed) return;
    try {
      await navigator.clipboard.writeText(value);
      setToast(field === "LOGIN" ? "Login copiado" : "Senha copiada");
      void api("COPY", { item_id: revealed.id, field }).then(() => refresh(true)).catch(() => undefined);
    } catch {
      setToast("Não foi possível copiar");
    }
  }

  async function saveEditor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true);
    setMessage("");
    try {
      const extra: Row = {
        category: editor.category,
        system_name: editor.system_name,
        login_url: editor.login_url,
        dashboard_password: editor.dashboard_password,
      };
      if (editor.itemId) {
        extra.item_id = editor.itemId;
        if (editor.login) extra.login = editor.login;
        if (editor.password) extra.password = editor.password;
        if (editor.notes) extra.notes = editor.notes;
        if (editor.clear_login) extra.clear_login = true;
        if (editor.clear_notes) extra.clear_notes = true;
        await api("UPDATE", extra);
        setToast("Acesso atualizado");
      } else {
        extra.login = editor.login;
        extra.password = editor.password;
        extra.notes = editor.notes;
        await api("CREATE", extra);
        setToast("Acesso cadastrado");
      }
      setEditor(null);
      clearReveal();
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteItem || !deletePassword) return;
    setBusy(true);
    setMessage("");
    try {
      await api("DELETE", { item_id: deleteItem.id, dashboard_password: deletePassword });
      if (revealed?.id === deleteItem.id) clearReveal();
      setDeleteItem(null);
      setDeletePassword("");
      setToast("Acesso removido");
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  function closePanel() {
    setOpen(false);
    setEditor(null);
    setDeleteItem(null);
    setDeletePassword("");
    setMessage("");
    clearReveal();
  }

  const trigger = target?.mount && payload?.ok ? createPortal(
    <button
      type="button"
      className="client-access-vault-trigger"
      onClick={() => { setOpen(true); void refresh(true); }}
      aria-label={`Abrir acessos de ${payload.client?.display_name || target.name}`}
    >
      Acessos{items.length ? ` · ${items.length}` : ""}
    </button>,
    target.mount,
  ) : null;

  const panel = open && payload?.ok && typeof document !== "undefined" ? createPortal(
    <div className="client-access-vault-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
      <section className="client-access-vault-panel" role="dialog" aria-modal="true" aria-label={`Acessos de ${payload.client?.display_name || target?.name || "cliente"}`}>
        <header className="client-access-vault-head">
          <div>
            <span className="client-access-vault-eyebrow">Cofre de acessos</span>
            <h2>{payload.client?.display_name || target?.name}</h2>
            <p className="client-access-vault-sub">Credenciais criptografadas. Login e senha só são liberados após confirmar a senha do seu próprio perfil do Dashboard.</p>
          </div>
          <button type="button" className="client-access-vault-close" onClick={closePanel} aria-label="Fechar">×</button>
        </header>

        <div className="client-access-vault-body">
          <div className="client-access-vault-toolbar">
            <div className="client-access-vault-scope">
              <span className="client-access-vault-pill secure">CRIPTOGRAFADO</span>
              <span className="client-access-vault-pill">Perfil: {role || "—"}</span>
              <span className="client-access-vault-pill">Auditoria ativa</span>
            </div>
            {canManage && !editor && <button type="button" className="client-access-vault-primary" onClick={() => { setEditor(blankEditor()); setMessage(""); }}>+ Adicionar acesso</button>}
          </div>

          {message && <div className="client-access-vault-error" role="alert">{message}</div>}

          {editor && canManage && (
            <form className="client-access-vault-form" onSubmit={saveEditor}>
              <div className="client-access-vault-section-title">
                <h3>{editor.itemId ? "Editar acesso" : "Cadastrar novo acesso"}</h3>
                <small>Somente MGMT</small>
              </div>
              <div className="client-access-vault-form-grid">
                <label>Categoria
                  <select value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })}>
                    {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>CRM / sistema
                  <input required maxLength={120} value={editor.system_name} onChange={(event) => setEditor({ ...editor, system_name: event.target.value })} placeholder="Ex.: Kommo" />
                </label>
                <label className="full">URL de acesso
                  <input type="url" value={editor.login_url} onChange={(event) => setEditor({ ...editor, login_url: event.target.value })} placeholder="https://..." />
                </label>
                <label>Login {editor.itemId && <small>(em branco mantém o atual)</small>}
                  <input autoComplete="off" value={editor.login} onChange={(event) => setEditor({ ...editor, login: event.target.value, clear_login: false })} placeholder="E-mail, usuário ou telefone" />
                </label>
                <label>Senha do cliente {editor.itemId && <small>(em branco mantém a atual)</small>}
                  <input type="password" autoComplete="new-password" required={!editor.itemId} value={editor.password} onChange={(event) => setEditor({ ...editor, password: event.target.value })} placeholder={editor.itemId ? "Não alterada" : "Senha do CRM/sistema"} />
                </label>
                <label className="full">Observação protegida {editor.itemId && <small>(em branco mantém a atual)</small>}
                  <textarea value={editor.notes} onChange={(event) => setEditor({ ...editor, notes: event.target.value, clear_notes: false })} placeholder="Ex.: conta principal, código da imobiliária..." />
                </label>
                {editor.itemId && (
                  <div className="client-access-vault-form-note">
                    <label style={{ display: "inline-flex", flexDirection: "row", alignItems: "center", marginRight: 16 }}><input type="checkbox" checked={editor.clear_login} onChange={(event) => setEditor({ ...editor, clear_login: event.target.checked, login: event.target.checked ? "" : editor.login })} /> Remover login atual</label>
                    <label style={{ display: "inline-flex", flexDirection: "row", alignItems: "center" }}><input type="checkbox" checked={editor.clear_notes} onChange={(event) => setEditor({ ...editor, clear_notes: event.target.checked, notes: event.target.checked ? "" : editor.notes })} /> Remover observação atual</label>
                  </div>
                )}
                <label className="full">Confirme a senha do seu Dashboard
                  <input type="password" autoComplete="current-password" required value={editor.dashboard_password} onChange={(event) => setEditor({ ...editor, dashboard_password: event.target.value })} placeholder="Sua senha, não a senha do cliente" />
                </label>
                <div className="client-access-vault-form-note">Sua senha do Dashboard é enviada apenas para reautenticação no Supabase Auth. Ela não é gravada no cofre nem na auditoria.</div>
              </div>
              <div className="client-access-vault-form-actions">
                <button type="button" className="client-access-vault-secondary" onClick={() => setEditor(null)}>Cancelar</button>
                <button type="submit" className="client-access-vault-primary" disabled={busy}>{busy ? "Salvando…" : editor.itemId ? "Salvar alterações" : "Cadastrar no cofre"}</button>
              </div>
            </form>
          )}

          {checking && !items.length ? <div className="client-access-vault-loading">Carregando acessos…</div> : items.length ? (
            <div className="client-access-vault-grid">
              {items.map((item) => (
                <article className="client-access-vault-card" key={item.id}>
                  <div className="client-access-vault-card-head">
                    <div>
                      <span className="client-access-vault-category">{CATEGORY_LABEL[item.category] || item.category}</span>
                      <h3>{item.system_name}</h3>
                    </div>
                    <span className="client-access-vault-pill secure">PROTEGIDO</span>
                  </div>
                  {item.login_url && <a className="client-access-vault-url" href={item.login_url} target="_blank" rel="noreferrer">{item.login_url}</a>}
                  <div className="client-access-vault-protected"><span>Login</span><span className="client-access-vault-dots">••••••••••</span></div>
                  <div className="client-access-vault-protected"><span>Senha</span><span className="client-access-vault-dots">••••••••••</span></div>

                  {revealed?.id === item.id && (
                    <div className="client-access-vault-revealed">
                      <div className="client-access-vault-revealed-head">
                        <b>Credencial liberada</b><span className="client-access-vault-countdown">fecha em {secondsLeft}s</span>
                      </div>
                      <div className="client-access-vault-secret-row">
                        <span className="client-access-vault-secret-label">Login</span>
                        <span className="client-access-vault-secret-value">{revealed.login || "—"}</span>
                        <button type="button" className="client-access-vault-copy" disabled={!revealed.login} onClick={() => copyValue("LOGIN", revealed.login)}>Copiar</button>
                      </div>
                      <div className="client-access-vault-secret-row">
                        <span className="client-access-vault-secret-label">Senha</span>
                        <span className="client-access-vault-secret-value">{showSecret ? (revealed.password || "—") : "••••••••••"}</span>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button type="button" className="client-access-vault-copy" onClick={() => setShowSecret((value) => !value)}>{showSecret ? "Ocultar" : "Mostrar"}</button>
                          <button type="button" className="client-access-vault-copy" disabled={!revealed.password} onClick={() => copyValue("PASSWORD", revealed.password)}>Copiar</button>
                        </div>
                      </div>
                      {revealed.notes && <div className="client-access-vault-notes"><b>Observação:</b> {revealed.notes}</div>}
                    </div>
                  )}

                  <div className="client-access-vault-card-actions">
                    <button type="button" className="client-access-vault-primary" onClick={() => { clearReveal(); setReauthItem(item); setReauthPassword(""); setMessage(""); }}>Ver credenciais</button>
                    {canManage && <button type="button" className="client-access-vault-secondary" onClick={() => { clearReveal(); setEditor(blankEditor(item)); setMessage(""); }}>Editar</button>}
                    {canManage && <button type="button" className="client-access-vault-danger" onClick={() => { clearReveal(); setDeleteItem(item); setDeletePassword(""); setMessage(""); }}>Remover</button>}
                  </div>
                  <small className="client-access-vault-meta">Atualizado {formatDateTime(item.updated_at)}{item.updated_by_person ? ` por ${item.updated_by_person}` : ""}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className="client-access-vault-empty">Nenhum acesso cadastrado para este cliente ainda.{canManage ? " Use “Adicionar acesso” para cadastrar o CRM ou outro sistema." : ""}</div>
          )}

          {canManage && (payload.audit?.length || 0) > 0 && (
            <section className="client-access-vault-section">
              <div className="client-access-vault-section-title"><h3>Histórico de acesso</h3><small>Visível somente para MGMT · sem senhas</small></div>
              <div className="client-access-vault-audit">
                {(payload.audit || []).slice(0, 20).map((event) => (
                  <div className="client-access-vault-audit-row" key={String(event.id)}>
                    <span>{String(event.actor_person || "—")}</span>
                    <span>{ACTION_LABEL[String(event.action || "")] || String(event.action || "ação")}{event.detail?.system_name ? ` · ${String(event.detail.system_name)}` : ""}</span>
                    <time>{formatDateTime(event.created_at)}</time>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>

      {reauthItem && (
        <div className="client-access-vault-reauth" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setReauthItem(null); setReauthPassword(""); } }}>
          <form className="client-access-vault-reauth-card" onSubmit={revealCredential}>
            <h3>Confirme sua identidade</h3>
            <p>Para visualizar o acesso de <b>{reauthItem.system_name}</b>, digite a senha que você usa para entrar no Dashboard. A senha do seu perfil não é armazenada.</p>
            <input autoFocus type="password" autoComplete="current-password" required value={reauthPassword} onChange={(event) => setReauthPassword(event.target.value)} placeholder="Senha do seu Dashboard" />
            <div className="client-access-vault-reauth-actions">
              <button type="button" className="client-access-vault-secondary" disabled={busy} onClick={() => { setReauthItem(null); setReauthPassword(""); }}>Cancelar</button>
              <button type="submit" className="client-access-vault-primary" disabled={busy || !reauthPassword}>{busy ? "Confirmando…" : "Liberar por 60 segundos"}</button>
            </div>
          </form>
        </div>
      )}

      {deleteItem && canManage && (
        <div className="client-access-vault-reauth" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setDeleteItem(null); setDeletePassword(""); } }}>
          <form className="client-access-vault-reauth-card" onSubmit={removeCredential}>
            <h3>Remover acesso de {deleteItem.system_name}?</h3>
            <p>A credencial criptografada será apagada. O histórico de auditoria sem senha será preservado. Confirme com a senha do seu Dashboard.</p>
            <input autoFocus type="password" autoComplete="current-password" required value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} placeholder="Senha do seu Dashboard" />
            <div className="client-access-vault-reauth-actions">
              <button type="button" className="client-access-vault-secondary" disabled={busy} onClick={() => { setDeleteItem(null); setDeletePassword(""); }}>Cancelar</button>
              <button type="submit" className="client-access-vault-danger" disabled={busy || !deletePassword}>{busy ? "Removendo…" : "Remover definitivamente"}</button>
            </div>
          </form>
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  const toastPortal = toast && typeof document !== "undefined" ? createPortal(<div className="client-access-vault-toast" role="status">{toast}</div>, document.body) : null;

  return <>{trigger}{panel}{toastPortal}</>;
}
