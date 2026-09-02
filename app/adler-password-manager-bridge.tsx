"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type VaultItem = {
  id: string;
  client_id: string;
  client_name: string;
  client_lifecycle?: string | null;
  category: string;
  system_name: string;
  login_url?: string | null;
  has_login?: boolean;
  has_password?: boolean;
  has_notes?: boolean;
  created_at?: string | null;
  created_by_person?: string | null;
  updated_at?: string | null;
  updated_by_person?: string | null;
};

type Credential = VaultItem & {
  login?: string | null;
  password?: string | null;
  notes?: string | null;
  revealed_at?: string | null;
};

const ACCESS_API = `${SUPABASE_URL}/functions/v1/agency-ops-client-access-vault-api`;
const UNLOCK_SECONDS = 180;
const PROFILE_BUTTON_CLASS = "adler-global-vault-trigger";

const CATEGORY_LABEL: Record<string, string> = {
  CRM: "CRM",
  SITE: "Site",
  GOOGLE_BUSINESS: "Google",
  PORTAL: "Portal",
  OTHER: "Outro",
};

function host(value?: string | null) {
  if (!value) return "Sem site cadastrado";
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}

function fmt(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function errLabel(code: unknown) {
  const value = String(code || "");
  const labels: Record<string, string> = {
    invalid_reauthentication: "A senha do seu perfil está incorreta.",
    reauth_locked: "Muitas tentativas incorretas. O cofre foi bloqueado temporariamente.",
    unauthorized: "Sua sessão expirou.",
    forbidden: "Seu perfil não tem permissão para esse acesso.",
    credential_not_found: "Esse acesso não existe mais.",
    credential_decryption_failed: "Não foi possível abrir essa credencial.",
    vault_key_missing: "A chave criptográfica do cofre não está disponível.",
  };
  return labels[value] || "Não foi possível concluir essa ação agora.";
}

export default function AdlerPasswordManagerBridge() {
  const [allowed, setAllowed] = useState(false);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Record<string, Credential>>({});
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlockUntil, setUnlockUntil] = useState(0);
  const [pendingReveal, setPendingReveal] = useState<VaultItem | null>(null);
  const [toast, setToast] = useState("");
  const passwordRef = useRef("");
  const unlockTimerRef = useRef<number | null>(null);

  const lock = useCallback(() => {
    passwordRef.current = "";
    setUnlockUntil(0);
    setUnlockPassword("");
    setUnlockOpen(false);
    setPendingReveal(null);
    setRevealed({});
    setVisiblePasswords(new Set());
    if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = null;
  }, []);

  const loadItems = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setAllowed(false);
      setReady(true);
      setItems([]);
      return;
    }
    const { data, error } = await supabase.schema("agency_ops").rpc("adler_list_client_access_vault");
    if (error) {
      setAllowed(false);
      setReady(true);
      setItems([]);
      setOpen(false);
      return;
    }
    setAllowed(true);
    setItems((data || []) as VaultItem[]);
    setReady(true);
  }, []);

  useEffect(() => {
    void loadItems();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      lock();
      void loadItems();
    });
    return () => subscription.unsubscribe();
  }, [loadItems, lock]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("adler-vault-favorites") || "[]");
      setFavorites(new Set(Array.isArray(stored) ? stored.map(String) : []));
    } catch { setFavorites(new Set()); }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const attach = () => {
      const menu = document.querySelector(".profile-menu") as HTMLElement | null;
      if (!menu || menu.querySelector(`.${PROFILE_BUTTON_CLASS}`)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = PROFILE_BUTTON_CLASS;
      button.textContent = "Cofre de acessos";
      button.title = "Gerenciador de senhas e acessos da operação";
      button.addEventListener("click", () => {
        setOpen(true);
        void loadItems();
      });
      const logout = Array.from(menu.querySelectorAll("button")).find((node) => /sair/i.test(node.textContent || ""));
      if (logout) menu.insertBefore(button, logout);
      else menu.appendChild(button);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelectorAll(`.${PROFILE_BUTTON_CLASS}`).forEach((node) => node.remove());
    };
  }, [allowed, loadItems]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) lock(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [lock]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== "ALL" && item.category !== category) return false;
      if (favoriteOnly && !favorites.has(item.id)) return false;
      if (!needle) return true;
      return [item.client_name, item.system_name, item.category, item.login_url, host(item.login_url)]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [category, favoriteOnly, favorites, items, query]);

  const clientCount = useMemo(() => new Set(items.map((item) => item.client_id)).size, [items]);
  const briefingCount = useMemo(() => items.filter((item) => /briefing hub/i.test(item.system_name)).length, [items]);
  const secondsLeft = unlockUntil ? Math.max(0, Math.ceil((unlockUntil - Date.now()) / 1000)) : 0;
  const unlocked = Boolean(passwordRef.current && unlockUntil > Date.now());

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { window.localStorage.setItem("adler-vault-favorites", JSON.stringify([...next])); } catch { /* no-op */ }
      return next;
    });
  }

  async function vaultApi(action: string, item: VaultItem, extra: Record<string, unknown> = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("unauthorized");
    const response = await fetch(ACCESS_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ action, client_id: item.client_id, item_id: item.id, ...extra }),
    });
    const payload = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));
    if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || `http_${response.status}`));
    return payload;
  }

  async function revealWithPassword(item: VaultItem, dashboardPassword: string) {
    setLoading(true);
    try {
      const payload = await vaultApi("REVEAL", item, { dashboard_password: dashboardPassword });
      setRevealed((current) => ({ ...current, [item.id]: { ...item, ...(payload.credential || {}) } }));
      setToast("Acesso liberado");
    } catch (error) {
      const message = errLabel(error instanceof Error ? error.message : error);
      setToast(message);
      if (/senha|bloqueado/i.test(message)) lock();
    } finally { setLoading(false); }
  }

  async function requestReveal(item: VaultItem) {
    if (revealed[item.id]) return;
    if (!unlocked) {
      setPendingReveal(item);
      setUnlockError("");
      setUnlockOpen(true);
      return;
    }
    await revealWithPassword(item, passwordRef.current);
  }

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!unlockPassword) return;
    setLoading(true);
    setUnlockError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.email) throw new Error("Sessão expirada.");
      const verifier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const result = await verifier.auth.signInWithPassword({ email: session.user.email, password: unlockPassword });
      try { await verifier.auth.signOut(); } catch { /* no-op */ }
      if (result.error || result.data.user?.id !== session.user.id) throw new Error("Senha incorreta.");
      const password = unlockPassword;
      passwordRef.current = password;
      const until = Date.now() + UNLOCK_SECONDS * 1000;
      setUnlockUntil(until);
      setUnlockPassword("");
      setUnlockOpen(false);
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = window.setTimeout(lock, UNLOCK_SECONDS * 1000);
      const pending = pendingReveal;
      setPendingReveal(null);
      if (pending) await revealWithPassword(pending, password);
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : "Não foi possível confirmar sua identidade.");
    } finally { setLoading(false); }
  }

  async function copy(item: VaultItem, field: "LOGIN" | "PASSWORD") {
    let credential = revealed[item.id];
    if (!credential) {
      await requestReveal(item);
      return;
    }
    const value = field === "LOGIN" ? credential.login : credential.password;
    if (!value) { setToast(field === "LOGIN" ? "Esse acesso não tem login salvo" : "Senha não encontrada"); return; }
    try {
      await navigator.clipboard.writeText(String(value));
      setToast(field === "LOGIN" ? "Login copiado" : "Senha copiada");
      void vaultApi("COPY", item, { field }).catch(() => undefined);
    } catch { setToast("Não foi possível copiar"); }
  }

  function togglePassword(id: string) {
    setVisiblePasswords((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!ready || !allowed || typeof document === "undefined") return null;

  return createPortal(<>
    <style>{`
      .${PROFILE_BUTTON_CLASS}{font-weight:650!important;color:#dbeafe!important}
      .adler-pm-backdrop{position:fixed;inset:0;z-index:2147482500;background:rgba(2,6,23,.72);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:24px}
      .adler-pm{width:min(1180px,96vw);height:min(820px,92vh);background:#0b1220;border:1px solid rgba(148,163,184,.2);border-radius:24px;box-shadow:0 30px 90px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column;color:#e5edf8}
      .adler-pm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:24px 28px 18px;border-bottom:1px solid rgba(148,163,184,.14)}
      .adler-pm-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#60a5fa;font-weight:800}
      .adler-pm h2{font-size:26px;margin:4px 0 5px;font-family:"Inter Tight",Inter,sans-serif}.adler-pm-head p{margin:0;color:#94a3b8;font-size:13px}
      .adler-pm-close,.adler-pm-icon{border:1px solid rgba(148,163,184,.16);background:#111827;color:#cbd5e1;border-radius:10px;cursor:pointer}.adler-pm-close{width:38px;height:38px;font-size:22px}
      .adler-pm-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:16px 28px 0}.adler-pm-stat{background:#0f172a;border:1px solid rgba(148,163,184,.12);border-radius:14px;padding:13px 15px}.adler-pm-stat b{display:block;font-size:21px}.adler-pm-stat span{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em}
      .adler-pm-tools{display:flex;gap:10px;align-items:center;padding:16px 28px}.adler-pm-search{flex:1;position:relative}.adler-pm-search input{width:100%;height:44px;border-radius:12px;border:1px solid rgba(148,163,184,.18);background:#0f172a;color:#f8fafc;padding:0 14px 0 40px;outline:none}.adler-pm-search:before{content:"⌕";position:absolute;left:14px;top:9px;color:#64748b;font-size:22px}.adler-pm-tools select,.adler-pm-filter{height:44px;border-radius:12px;border:1px solid rgba(148,163,184,.18);background:#0f172a;color:#dbeafe;padding:0 12px}.adler-pm-filter{cursor:pointer}.adler-pm-filter.active{border-color:#3b82f6;background:#172554}
      .adler-pm-lock{margin:0 28px 14px;padding:10px 12px;border-radius:12px;background:#111827;border:1px solid rgba(148,163,184,.12);display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:#94a3b8}.adler-pm-lock b{color:#cbd5e1}.adler-pm-lock button{border:0;background:transparent;color:#60a5fa;cursor:pointer;font-weight:700}
      .adler-pm-list{padding:0 28px 28px;overflow:auto;display:grid;gap:10px}.adler-pm-item{border:1px solid rgba(148,163,184,.13);background:#0f172a;border-radius:16px;overflow:hidden}.adler-pm-row{display:grid;grid-template-columns:44px minmax(180px,1fr) minmax(160px,.8fr) auto;gap:14px;align-items:center;padding:14px 16px}.adler-pm-badge{width:42px;height:42px;border-radius:12px;background:#172554;color:#93c5fd;display:grid;place-items:center;font-weight:900;font-size:17px}.adler-pm-main b{display:block;font-size:14px}.adler-pm-main small,.adler-pm-meta small{display:block;color:#94a3b8;font-size:11px;margin-top:3px}.adler-pm-meta{min-width:0}.adler-pm-meta b{font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.adler-pm-actions{display:flex;gap:7px}.adler-pm-actions button{height:34px;border-radius:9px;border:1px solid rgba(148,163,184,.16);background:#111827;color:#cbd5e1;padding:0 11px;cursor:pointer;font-size:12px;font-weight:650}.adler-pm-actions button.primary{background:#2563eb;border-color:#2563eb;color:white}.adler-pm-actions button.star{width:34px;padding:0;font-size:17px}.adler-pm-actions button.star.active{color:#fbbf24}
      .adler-pm-secret{border-top:1px solid rgba(148,163,184,.12);padding:14px 16px 16px;background:#0b1324;display:grid;grid-template-columns:1fr 1fr;gap:10px}.adler-pm-field{border:1px solid rgba(148,163,184,.12);border-radius:12px;padding:11px 12px;background:#0f172a}.adler-pm-field label{display:block;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}.adler-pm-field code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2e8f0;font-size:12px;word-break:break-all}.adler-pm-field .field-actions{display:flex;gap:6px;margin-top:8px}.adler-pm-field button{border:0;background:transparent;color:#60a5fa;padding:0;cursor:pointer;font-size:11px;font-weight:700}.adler-pm-notes{grid-column:1/-1}.adler-pm-empty{padding:44px;text-align:center;color:#64748b;border:1px dashed rgba(148,163,184,.16);border-radius:16px}
      .adler-pm-unlock-wrap{position:fixed;inset:0;z-index:2147482600;background:rgba(2,6,23,.78);display:grid;place-items:center;padding:20px}.adler-pm-unlock{width:min(430px,94vw);background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.5)}.adler-pm-unlock h3{margin:0 0 6px;font-size:20px}.adler-pm-unlock p{margin:0 0 16px;color:#94a3b8;font-size:12px}.adler-pm-unlock input{width:100%;height:44px;border-radius:11px;border:1px solid rgba(148,163,184,.2);background:#0b1220;color:white;padding:0 12px;outline:none}.adler-pm-unlock-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.adler-pm-unlock-actions button{height:38px;border-radius:10px;border:1px solid rgba(148,163,184,.16);background:#111827;color:#cbd5e1;padding:0 14px;cursor:pointer}.adler-pm-unlock-actions .primary{background:#2563eb;border-color:#2563eb;color:white}.adler-pm-error{color:#fca5a5!important;margin-top:9px!important}.adler-pm-toast{position:fixed;right:24px;bottom:24px;z-index:2147482700;background:#111827;border:1px solid rgba(148,163,184,.18);color:#e2e8f0;border-radius:12px;padding:11px 14px;box-shadow:0 18px 55px rgba(0,0,0,.45);font-size:12px}
      @media(max-width:760px){.adler-pm-backdrop{padding:0}.adler-pm{width:100vw;height:100vh;border-radius:0}.adler-pm-stats{grid-template-columns:1fr 1fr;padding-inline:16px}.adler-pm-stat:last-child{grid-column:1/-1}.adler-pm-head,.adler-pm-tools,.adler-pm-list{padding-left:16px;padding-right:16px}.adler-pm-tools{flex-wrap:wrap}.adler-pm-search{flex-basis:100%}.adler-pm-row{grid-template-columns:40px 1fr auto}.adler-pm-meta{grid-column:2}.adler-pm-actions{grid-column:1/-1;justify-content:flex-end}.adler-pm-secret{grid-template-columns:1fr}}
    `}</style>

    {open && <div className="adler-pm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="adler-pm" role="dialog" aria-modal="true" aria-label="Cofre de acessos do Adler">
        <header className="adler-pm-head">
          <div><span className="adler-pm-eyebrow">Perfil do Adler</span><h2>Cofre de acessos</h2><p>Gerenciador central de logins da operação. Senhas permanecem criptografadas e só são abertas após confirmar sua senha do Dashboard.</p></div>
          <button className="adler-pm-close" onClick={() => { setOpen(false); lock(); }} aria-label="Fechar">×</button>
        </header>

        <div className="adler-pm-stats">
          <div className="adler-pm-stat"><b>{items.length}</b><span>Acessos salvos</span></div>
          <div className="adler-pm-stat"><b>{clientCount}</b><span>Clientes com acesso</span></div>
          <div className="adler-pm-stat"><b>{briefingCount}</b><span>Briefing Hub</span></div>
        </div>

        <div className="adler-pm-tools">
          <div className="adler-pm-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, CRM, Briefing Hub, domínio..." autoFocus /></div>
          <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="ALL">Todos os tipos</option>{Object.entries(CATEGORY_LABEL).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button className={`adler-pm-filter${favoriteOnly ? " active" : ""}`} onClick={() => setFavoriteOnly((value) => !value)}>★ Favoritos</button>
        </div>

        <div className="adler-pm-lock">
          <span>{unlocked ? <><b>Desbloqueado</b> por até {secondsLeft || UNLOCK_SECONDS}s enquanto esta janela estiver aberta.</> : <><b>Bloqueado.</b> Confirme sua senha para visualizar uma credencial.</>}</span>
          {unlocked ? <button onClick={lock}>Bloquear agora</button> : <button onClick={() => { setUnlockError(""); setUnlockOpen(true); }}>Desbloquear</button>}
        </div>

        <div className="adler-pm-list">
          {filtered.map((item) => {
            const credential = revealed[item.id];
            const showPassword = visiblePasswords.has(item.id);
            return <article className="adler-pm-item" key={item.id}>
              <div className="adler-pm-row">
                <div className="adler-pm-badge">{(item.system_name || "A").slice(0,1).toUpperCase()}</div>
                <div className="adler-pm-main"><b>{item.system_name}</b><small>{item.client_name} · {CATEGORY_LABEL[item.category] || item.category}</small></div>
                <div className="adler-pm-meta"><b>{host(item.login_url)}</b><small>Atualizado {fmt(item.updated_at)}</small></div>
                <div className="adler-pm-actions">
                  <button className={`star${favorites.has(item.id) ? " active" : ""}`} onClick={() => toggleFavorite(item.id)} title="Favorito">★</button>
                  {item.login_url && <button onClick={() => window.open(String(item.login_url), "_blank", "noopener,noreferrer")}>Abrir site</button>}
                  <button className="primary" disabled={loading} onClick={() => void requestReveal(item)}>{credential ? "Aberto" : "Ver acesso"}</button>
                </div>
              </div>
              {credential && <div className="adler-pm-secret">
                <div className="adler-pm-field"><label>Login / usuário</label><code>{credential.login || "Não informado"}</code><div className="field-actions"><button onClick={() => void copy(item, "LOGIN")}>Copiar login</button></div></div>
                <div className="adler-pm-field"><label>Senha</label><code>{showPassword ? (credential.password || "Não encontrada") : "••••••••••••"}</code><div className="field-actions"><button onClick={() => togglePassword(item.id)}>{showPassword ? "Ocultar" : "Mostrar"}</button><button onClick={() => void copy(item, "PASSWORD")}>Copiar senha</button></div></div>
                {credential.notes && <div className="adler-pm-field adler-pm-notes"><label>Observações</label><code>{credential.notes}</code></div>}
              </div>}
            </article>;
          })}
          {!filtered.length && <div className="adler-pm-empty">{items.length ? "Nenhum acesso encontrado com esses filtros." : "O cofre ainda não tem acessos cadastrados."}</div>}
        </div>
      </section>
    </div>}

    {unlockOpen && <div className="adler-pm-unlock-wrap">
      <form className="adler-pm-unlock" onSubmit={unlock}>
        <h3>Confirmar identidade</h3>
        <p>Digite a senha do seu próprio perfil do Dashboard. Ela fica somente na memória desta aba e é apagada automaticamente em 3 minutos, ao fechar o cofre ou ao trocar de aba.</p>
        <input type="password" autoComplete="current-password" value={unlockPassword} onChange={(event) => setUnlockPassword(event.target.value)} placeholder="Senha do Dashboard" autoFocus />
        {unlockError && <p className="adler-pm-error">{unlockError}</p>}
        <div className="adler-pm-unlock-actions"><button type="button" onClick={() => { setUnlockOpen(false); setPendingReveal(null); setUnlockPassword(""); setUnlockError(""); }}>Cancelar</button><button className="primary" disabled={loading || !unlockPassword}>{loading ? "Confirmando..." : "Desbloquear"}</button></div>
      </form>
    </div>}

    {toast && <div className="adler-pm-toast">{toast}</div>}
  </>, document.body);
}
