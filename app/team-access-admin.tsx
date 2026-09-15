"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const PROFILE_ADMIN_URL = `${SUPABASE_URL}/functions/v1/agency-ops-profile-admin`;
const ADMIN_AUTH_URL = `${SUPABASE_URL}/functions/v1/agency-ops-admin-auth`;
const ADLER_EMAIL = "adlerfurtadomkt01@gmail.com";

type ViewPermission = {
  key: string;
  label: string;
  allowed: boolean;
  source: "SYSTEM" | "PERSON" | "ROLE";
  role_allowed: boolean;
  person_override: boolean | null;
};

type ManagedProfile = {
  person: string;
  role: string;
  access_level: string;
  email: string | null;
  clickup_user: string | null;
  is_former: boolean;
  user_key: string | null;
  account_approved: boolean;
  elevated: boolean;
  system_locked: boolean;
  auth: {
    exists: boolean;
    user_id: string | null;
    last_sign_in_at: string | null;
    email_confirmed_at: string | null;
  };
  views: ViewPermission[];
};

const ROLE_LABEL: Record<string, string> = {
  GT: "Gestor de Tráfego",
  CS: "Customer Success",
  DESIGN: "Design",
  AI: "Inteligência Artificial",
  MGMT: "Gestão",
  COMMERCIAL: "Comercial",
};

const ACCESS_LABEL: Record<string, string> = {
  FULL: "Full",
  WALLET_ONLY: "Carteira / escopo",
  RESTRICTED: "Restrito",
};

function formatWhen(value?: string | null) {
  if (!value) return "Nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export default function TeamAccessAdmin() {
  const [session, setSession] = useState<Session | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [accessLevels, setAccessLevels] = useState<string[]>([]);
  const [selectedPerson, setSelectedPerson] = useState("Adler Furtado");
  const [search, setSearch] = useState("");
  const [showFormer, setShowFormer] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [draftRole, setDraftRole] = useState("MGMT");
  const [draftAccess, setDraftAccess] = useState("FULL");
  const [draftFormer, setDraftFormer] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const isAdlerEmail = session?.user?.email?.toLowerCase() === ADLER_EMAIL;

  const request = useCallback(async (method: "GET" | "POST", payload?: Record<string, unknown>) => {
    if (!session?.access_token) throw new Error("Sua sessão expirou. Entre novamente no dashboard.");
    const response = await fetch(PROFILE_ADMIN_URL, {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      cache: "no-store",
      body: method === "POST" ? JSON.stringify(payload || {}) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) {
      const labels: Record<string, string> = {
        unauthorized: "Sua sessão expirou. Entre novamente.",
        forbidden: "A Central de Perfis é exclusiva do Adler.",
        central_brain_locked: "O perfil do Adler é protegido e não pode ser rebaixado.",
        invalid_role: "Cargo inválido.",
        invalid_access_level: "Nível de acesso inválido.",
        invalid_view: "Permissão de aba inválida.",
        profile_not_found: "Perfil não encontrado.",
        profile_has_no_login: "Esse colaborador ainda não possui login vinculado ao perfil.",
        update_failed: "Não foi possível atualizar o perfil.",
        permission_update_failed: "Não foi possível atualizar a permissão.",
        permissions_reset_failed: "Não foi possível restaurar as permissões do cargo.",
        access_grant_failed: "Não foi possível conceder o acesso.",
        access_revoke_failed: "Não foi possível revogar o acesso.",
      };
      throw new Error(labels[String(body?.error)] || body?.detail || "A operação administrativa falhou.");
    }
    return body;
  }, [session?.access_token]);

  const loadProfiles = useCallback(async (quiet = false) => {
    if (!isAdlerEmail || !session?.access_token) {
      setAuthorized(false);
      setProfiles([]);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const body = await request("GET");
      setAuthorized(true);
      setProfiles(body.profiles || []);
      setRoles(body.roles || []);
      setAccessLevels(body.access_levels || []);
      if (!(body.profiles || []).some((item: ManagedProfile) => item.person === selectedPerson)) {
        setSelectedPerson("Adler Furtado");
      }
    } catch {
      setAuthorized(false);
      setProfiles([]);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [isAdlerEmail, request, selectedPerson, session?.access_token]);

  useEffect(() => { loadProfiles(true); }, [loadProfiles]);

  const selected = useMemo(
    () => profiles.find((item) => item.person === selectedPerson) || profiles[0] || null,
    [profiles, selectedPerson],
  );

  useEffect(() => {
    if (!selected) return;
    setDraftRole(selected.role);
    setDraftAccess(selected.access_level);
    setDraftFormer(selected.is_former);
    setPassword("");
    setMessage("");
  }, [selected?.person, selected?.role, selected?.access_level, selected?.is_former]);

  const visibleProfiles = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("pt-BR");
    return profiles
      .filter((item) => showFormer || !item.is_former)
      .filter((item) => !needle || [item.person, item.email, item.role, ROLE_LABEL[item.role]]
        .filter(Boolean).join(" ").toLocaleLowerCase("pt-BR").includes(needle));
  }, [profiles, search, showFormer]);

  useEffect(() => {
    if (!authorized) {
      document.getElementById("ops-profile-admin-slot")?.remove();
      setSlot(null);
      return;
    }
    let active = true;
    const mount = () => {
      if (!active) return;
      const menu = document.querySelector(".profile-menu") as HTMLElement | null;
      if (!menu) {
        document.getElementById("ops-profile-admin-slot")?.remove();
        setSlot(null);
        return;
      }
      const existing = document.getElementById("ops-profile-admin-slot") as HTMLElement | null;
      if (existing) { setSlot(existing); return; }
      const node = document.createElement("div");
      node.id = "ops-profile-admin-slot";
      const exit = menu.querySelector("button.muted");
      if (exit?.parentElement) exit.parentElement.insertBefore(node, exit);
      else menu.appendChild(node);
      setSlot(node);
    };
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      active = false;
      observer.disconnect();
      document.getElementById("ops-profile-admin-slot")?.remove();
      setSlot(null);
    };
  }, [authorized]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);

  async function mutate(key: string, payload: Record<string, unknown>, okMessage: string) {
    if (busy) return;
    setBusy(key);
    setMessage("");
    setSuccess(false);
    try {
      await request("POST", payload);
      await loadProfiles(true);
      setSuccess(true);
      setMessage(okMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "A operação falhou.");
    } finally {
      setBusy("");
    }
  }

  async function saveProfile() {
    if (!selected) return;
    await mutate(
      `profile:${selected.person}`,
      { action:"UPDATE_PROFILE", person:selected.person, role:draftRole, access_level:draftAccess, is_former:draftFormer },
      `Perfil de ${selected.person} atualizado.`,
    );
  }

  async function setView(view: ViewPermission, allowed: boolean) {
    if (!selected) return;
    await mutate(
      `view:${selected.person}:${view.key}`,
      { action:"SET_VIEW", person:selected.person, view_key:view.key, allowed },
      `${view.label}: ${allowed ? "liberada" : "bloqueada"} para ${selected.person}.`,
    );
  }

  async function clearView(view: ViewPermission) {
    if (!selected) return;
    await mutate(
      `clear:${selected.person}:${view.key}`,
      { action:"CLEAR_VIEW_OVERRIDE", person:selected.person, view_key:view.key },
      `${view.label} voltou a seguir o padrão do cargo.`,
    );
  }

  async function resetPassword() {
    if (!selected?.email || password.length < 10 || busy) return;
    setBusy(`password:${selected.person}`);
    setMessage("");
    setSuccess(false);
    try {
      if (!session?.access_token) throw new Error("Sua sessão expirou.");
      const response = await fetch(ADMIN_AUTH_URL, {
        method:"POST",
        headers:{ Authorization:`Bearer ${session.access_token}`, apikey:SUPABASE_ANON_KEY, "content-type":"application/json" },
        body:JSON.stringify({ action:"RESET_PASSWORD", target_email:selected.email, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) {
        const labels: Record<string,string> = {
          target_not_in_team:"Esse e-mail não pertence a um colaborador ativo.",
          auth_user_not_found:"Esse perfil ainda não possui usuário no Auth.",
          invalid_password_length:"A senha precisa ter entre 10 e 128 caracteres.",
          password_update_failed:"O Supabase recusou a troca da senha.",
        };
        throw new Error(labels[String(body?.error)] || body?.detail || "Não foi possível redefinir a senha.");
      }
      setPassword("");
      setSuccess(true);
      setMessage(`Senha de ${selected.person} redefinida com sucesso.`);
      await loadProfiles(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível redefinir a senha.");
    } finally {
      setBusy("");
    }
  }

  const trigger = slot ? createPortal(
    <button
      type="button"
      onClick={() => { setOpen(true); loadProfiles(); }}
      style={{ width:"100%", textAlign:"left", fontWeight:700 }}
    >
      Gerenciar perfis
    </button>,
    slot,
  ) : null;

  if (!authorized) return null;

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Central de Perfis"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      style={{
        position:"fixed", inset:0, zIndex:2147483600, background:"rgba(4,8,18,.76)", backdropFilter:"blur(10px)",
        display:"grid", placeItems:"center", padding:24,
      }}
    >
      <section className="card" style={{
        width:"min(1240px,96vw)", height:"min(860px,90vh)", overflow:"hidden", display:"grid",
        gridTemplateRows:"auto minmax(0,1fr)", boxShadow:"0 28px 90px rgba(0,0,0,.5)",
      }}>
        <header style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:20, padding:"20px 22px", borderBottom:"1px solid var(--line)" }}>
          <div>
            <div className="eyebrow">CÉREBRO CENTRAL · ADLER ONLY</div>
            <h2 style={{ margin:"4px 0 3px" }}>Central de Perfis</h2>
            <div className="subtitle">Gerencie cargos, escopos, abas, aprovação, elevação e credenciais de toda a equipe.</div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <span className="chip">ACESSO TOTAL</span>
            <button className="btn" type="button" onClick={() => loadProfiles()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
            <button className="btn" type="button" onClick={() => setOpen(false)} aria-label="Fechar Central de Perfis">Fechar</button>
          </div>
        </header>

        <div style={{ minHeight:0, display:"grid", gridTemplateColumns:"330px minmax(0,1fr)" }}>
          <aside style={{ minHeight:0, borderRight:"1px solid var(--line)", padding:16, display:"grid", gridTemplateRows:"auto auto minmax(0,1fr)", gap:10 }}>
            <input className="control" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar colaborador…" />
            <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, opacity:.82 }}>
              <input type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} />
              Mostrar desligados
              <span style={{ marginLeft:"auto" }}>{visibleProfiles.length}/{profiles.length}</span>
            </label>
            <div style={{ minHeight:0, overflowY:"auto", display:"grid", alignContent:"start", gap:7, paddingRight:3 }}>
              {visibleProfiles.map((item) => {
                const active = item.person === selected?.person;
                return <button key={item.person} type="button" onClick={() => setSelectedPerson(item.person)} style={{
                  textAlign:"left", border:"1px solid var(--line)", borderRadius:12, padding:"11px 12px", cursor:"pointer",
                  background:active ? "color-mix(in srgb, var(--blue) 14%, var(--card))" : "var(--card)",
                  outline:active ? "1px solid color-mix(in srgb, var(--blue) 55%, transparent)" : "none",
                }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <b style={{ flex:1 }}>{item.person}</b>
                    {item.system_locked && <span className="chip">MASTER</span>}
                    {item.is_former && <span className="chip">OFF</span>}
                  </div>
                  <small style={{ display:"block", marginTop:4, opacity:.7 }}>{ROLE_LABEL[item.role] || item.role} · {ACCESS_LABEL[item.access_level] || item.access_level}</small>
                  <small style={{ display:"block", marginTop:2, opacity:.58 }}>{item.email || "sem login cadastrado"}</small>
                </button>;
              })}
            </div>
          </aside>

          <main style={{ minHeight:0, overflowY:"auto", padding:20 }}>
            {!selected && <div className="empty">Nenhum perfil selecionado.</div>}
            {selected && <>
              <div style={{ display:"flex", justifyContent:"space-between", gap:16, alignItems:"flex-start", marginBottom:16 }}>
                <div>
                  <div style={{ display:"flex", alignItems:"center", gap:9, flexWrap:"wrap" }}>
                    <h2 style={{ margin:0 }}>{selected.person}</h2>
                    {selected.system_locked && <span className="chip">CÉREBRO CENTRAL</span>}
                    {selected.elevated && <span className="chip">ELEVADO</span>}
                    {selected.auth.exists ? <span className="chip">LOGIN ATIVO</span> : <span className="chip">SEM AUTH</span>}
                  </div>
                  <div className="subtitle" style={{ marginTop:5 }}>{selected.email || "Sem e-mail cadastrado"}{selected.clickup_user ? ` · ClickUp: ${selected.clickup_user}` : ""}</div>
                </div>
                <div style={{ textAlign:"right", fontSize:12, opacity:.72 }}>
                  <div>Último login</div>
                  <b>{formatWhen(selected.auth.last_sign_in_at)}</b>
                </div>
              </div>

              {selected.system_locked && <div className="action-message" style={{ marginBottom:14 }}>
                Este é o perfil mestre. MGMT + FULL + acesso elevado + todas as abas são impostos pelo backend e não podem ser removidos pelo painel.
              </div>}

              <section className="card section" style={{ marginBottom:14 }}>
                <div className="section-head"><div><div className="section-title">Identidade e nível</div><div className="subtitle">Cargo define o padrão; nível e elevação definem a amplitude real do acesso.</div></div></div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,minmax(160px,1fr))", gap:10 }}>
                  <label style={{ display:"grid", gap:6 }}><small>Cargo</small><select className="control" disabled={selected.system_locked} value={draftRole} onChange={(e) => setDraftRole(e.target.value)}>{roles.map((role) => <option key={role} value={role}>{ROLE_LABEL[role] || role}</option>)}</select></label>
                  <label style={{ display:"grid", gap:6 }}><small>Nível base</small><select className="control" disabled={selected.system_locked} value={draftAccess} onChange={(e) => setDraftAccess(e.target.value)}>{accessLevels.map((level) => <option key={level} value={level}>{ACCESS_LABEL[level] || level}</option>)}</select></label>
                  <label style={{ display:"grid", gap:6 }}><small>Status operacional</small><select className="control" disabled={selected.system_locked} value={draftFormer ? "FORMER" : "ACTIVE"} onChange={(e) => setDraftFormer(e.target.value === "FORMER")}><option value="ACTIVE">Ativo</option><option value="FORMER">Desligado / bloquear perfil</option></select></label>
                </div>
                {!selected.system_locked && <button className="primary" type="button" style={{ marginTop:10 }} disabled={Boolean(busy)} onClick={saveProfile}>{busy === `profile:${selected.person}` ? "Salvando…" : "Salvar perfil"}</button>}
              </section>

              <section className="card section" style={{ marginBottom:14 }}>
                <div className="section-head"><div><div className="section-title">Chaves de acesso</div><div className="subtitle">Aprovação libera o login. Elevação ignora escopos como carteira própria e transforma o acesso em global.</div></div></div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <label style={{ border:"1px solid var(--line)", borderRadius:12, padding:12, display:"flex", alignItems:"center", gap:10 }}>
                    <input type="checkbox" disabled={selected.system_locked || !selected.user_key || Boolean(busy)} checked={selected.account_approved} onChange={(e) => mutate(`approval:${selected.person}`, { action:"SET_ACCOUNT_APPROVED", person:selected.person, enabled:e.target.checked }, e.target.checked ? "Conta aprovada." : "Aprovação da conta revogada.")} />
                    <span><b style={{ display:"block" }}>Conta aprovada</b><small style={{ opacity:.7 }}>Permite que o usuário autenticado entre no dashboard.</small></span>
                  </label>
                  <label style={{ border:"1px solid var(--line)", borderRadius:12, padding:12, display:"flex", alignItems:"center", gap:10 }}>
                    <input type="checkbox" disabled={selected.system_locked || !selected.user_key || Boolean(busy)} checked={selected.elevated} onChange={(e) => mutate(`elevated:${selected.person}`, { action:"SET_ELEVATED", person:selected.person, enabled:e.target.checked }, e.target.checked ? "Acesso elevado concedido." : "Acesso elevado revogado.")} />
                    <span><b style={{ display:"block" }}>Acesso elevado</b><small style={{ opacity:.7 }}>Ignora escopo de carteira e amplia a visão para dados globais.</small></span>
                  </label>
                </div>
                {!selected.user_key && <div className="small" style={{ marginTop:8 }}>Esse colaborador ainda não vinculou um usuário do Auth ao perfil. As chaves acima ficam indisponíveis até o primeiro cadastro/vínculo.</div>}
              </section>

              <section className="card section" style={{ marginBottom:14 }}>
                <div className="section-head">
                  <div><div className="section-title">Permissões de abas</div><div className="subtitle">Cada alteração vira uma exceção individual. “Cargo” indica que a permissão está sendo herdada.</div></div>
                  {!selected.system_locked && <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => mutate(`resetviews:${selected.person}`, { action:"RESET_VIEWS_TO_ROLE", person:selected.person }, "Permissões individuais removidas. O perfil voltou ao padrão do cargo.")}>Restaurar padrão do cargo</button>}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(260px,1fr))", gap:8 }}>
                  {selected.views.map((view) => <div key={view.key} style={{ border:"1px solid var(--line)", borderRadius:11, padding:"10px 11px", display:"flex", alignItems:"center", gap:9 }}>
                    <input type="checkbox" disabled={selected.system_locked || Boolean(busy)} checked={view.allowed} onChange={(e) => setView(view, e.target.checked)} />
                    <span style={{ flex:1 }}><b style={{ display:"block" }}>{view.label}</b><small style={{ opacity:.65 }}>{view.source === "SYSTEM" ? "Sistema · sempre liberada" : view.source === "PERSON" ? `Exceção individual · ${view.allowed ? "liberada" : "bloqueada"}` : `Cargo ${ROLE_LABEL[selected.role] || selected.role} · ${view.role_allowed ? "liberada" : "bloqueada"}`}</small></span>
                    {view.source === "PERSON" && !selected.system_locked && <button type="button" className="btn" style={{ padding:"5px 8px", fontSize:11 }} disabled={Boolean(busy)} onClick={() => clearView(view)}>Herdar</button>}
                  </div>)}
                </div>
              </section>

              <section className="card section">
                <div className="section-head"><div><div className="section-title">Credencial</div><div className="subtitle">Reset administrativo de senha. A senha não é registrada no banco nem na auditoria.</div></div><span className="chip">SENSÍVEL</span></div>
                <div style={{ display:"grid", gridTemplateColumns:"minmax(220px,1fr) auto", gap:10, alignItems:"end" }}>
                  <label style={{ display:"grid", gap:6 }}><small>Nova senha</small><input className="control" type="password" autoComplete="new-password" minLength={10} maxLength={128} disabled={!selected.email || !selected.auth.exists || selected.is_former} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={selected.auth.exists ? "Mínimo de 10 caracteres" : "Perfil sem usuário no Auth"} /></label>
                  <button className="primary" type="button" disabled={!selected.email || !selected.auth.exists || selected.is_former || password.length < 10 || Boolean(busy)} onClick={resetPassword}>{busy === `password:${selected.person}` ? "Redefinindo…" : "Redefinir senha"}</button>
                </div>
              </section>

              {message && <div className={success ? "action-message" : "error-box"} role="status" style={{ marginTop:12 }}>{message}</div>}
            </>}
          </main>
        </div>
      </section>
    </div>,
    document.body,
  ) : null;

  return <>{trigger}{modal}</>;
}
