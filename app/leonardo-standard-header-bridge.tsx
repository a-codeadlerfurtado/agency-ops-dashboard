"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, initials, loadProfileLite, supabase, text, useDialogFocus } from "./shared";

type Row = Record<string, any>;

const SAFE_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-dashboard-safe`;
const PREF_KEYS = ["theme", "sounds_enabled", "win_sound_enabled", "win_celebration_enabled", "notifications_enabled", "animations_enabled", "interface_density"] as const;

function ProfileMenu({ preferences, openSettings, close }: { preferences: Row; openSettings: () => void; close: () => void }) {
  const dialogRef = useDialogFocus(close);
  const name = text(preferences.name || "Leonardo Augusto");
  return <div ref={dialogRef as React.RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label="Menu do perfil" className="profile-menu leo-profile-menu">
    <div className="leo-profile-card"><span className="avatar">{initials(name)}</span><div><b>{name}</b><small>{text(preferences.role || "Direção Comercial")}</small></div></div>
    <button onClick={openSettings}>Meu perfil</button>
    <button onClick={openSettings}>Configurações</button>
    <button onClick={openSettings}>Preferências</button>
    <button className="muted" onClick={() => supabase.auth.signOut({ scope: "local" })}>Sair</button>
  </div>;
}

function SettingsModal({ preferences, close, save }: { preferences: Row; close: () => void; save: (next: Row) => Promise<void> }) {
  const dialogRef = useDialogFocus(close);
  const [prefs, setPrefs] = useState<Row>(preferences);
  const [saving, setSaving] = useState(false);
  const toggle = (key: string) => setPrefs((current: Row) => ({ ...current, [key]: current[key] === false }));
  async function submit() {
    setSaving(true);
    try { await save(prefs); close(); } finally { setSaving(false); }
  }
  return <><div className="leo-settings-overlay" onClick={close}/><section ref={dialogRef as React.RefObject<HTMLElement>} role="dialog" aria-modal="true" aria-label="Configurações" className="leo-settings-modal">
    <div className="panel-heading"><div><span className="eyebrow">Configurações</span><h2>Conta e preferências</h2></div><button className="leo-close" onClick={close}>×</button></div>
    <div className="leo-settings-grid">
      <div><h3>Conta</h3><label>Nome<input value={preferences.name || "Leonardo Augusto"} disabled/></label><label>Cargo<input value={preferences.role || "Direção Comercial"} disabled/></label></div>
      <div><h3>Notificações e interface</h3>{[["sounds_enabled","Som das notificações"],["win_sound_enabled","Som de novo cliente"],["win_celebration_enabled","Celebração de novo cliente"],["notifications_enabled","Notificações"],["animations_enabled","Animações"]].map(([key,label]) => <button className="leo-setting-toggle" key={key} onClick={() => toggle(key)}><span>{label}</span><i className={prefs[key] === false ? "" : "on"}/></button>)}</div>
      <div><h3>Acesso</h3><p className="leo-small">Direção Comercial · perfil de gestão. As permissões continuam definidas pelo servidor.</p><p className="leo-small">Central Criativa com o mesmo escopo do Adler.</p></div>
    </div>
    <div className="leo-modal-actions"><button onClick={close}>Cancelar</button><button className="primary" onClick={submit} disabled={saving}>{saving ? "Salvando…" : "Salvar alterações"}</button></div>
  </section></>;
}

export default function LeonardoStandardHeaderBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [isLeonardo, setIsLeonardo] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [preferences, setPreferences] = useState<Row>({ name: "Leonardo Augusto", role: "Direção Comercial", theme: "dark" });
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setIsLeonardo(false); return; }
    let active = true;
    loadProfileLite().then((body) => {
      if (!active) return;
      setIsLeonardo(String(body?.profile?.person || "") === "Leonardo Augusto" && String(body?.profile?.role || "").toUpperCase() === "COMMERCIAL");
    }).catch(() => { if (active) setIsLeonardo(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  const loadPreferences = useCallback(async () => {
    if (!session?.access_token || !isLeonardo) return;
    const response = await authenticatedFetch(`${SAFE_API}?view=home`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    if (body?.preferences) setPreferences(body.preferences);
  }, [session?.access_token, isLeonardo]);

  useEffect(() => { loadPreferences(); }, [loadPreferences]);

  useEffect(() => {
    if (!isLeonardo || window.location.pathname !== "/") { setTarget(null); return; }
    let frame = 0;
    const locate = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setTarget(document.querySelector<HTMLElement>(".lc-top-actions"))); };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); setTarget(null); };
  }, [isLeonardo]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", preferences.theme === "light" ? "light" : "dark");
  }, [preferences.theme]);

  async function save(next: Row) {
    const nextPayload = Object.fromEntries(PREF_KEYS.filter((key) => next[key] !== undefined).map((key) => [key, next[key]]));
    const response = await authenticatedFetch(`${SAFE_API}?view=preferences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nextPayload) });
    if (!response.ok) throw new Error("Não foi possível salvar as preferências.");
    const body = await response.json().catch(() => ({}));
    setPreferences(body?.preferences ? { ...next, ...body.preferences, role: "Direção Comercial" } : next);
  }

  if (!isLeonardo || !target || !session) return null;

  const name = text(preferences.name || session.user.user_metadata?.name || session.user.email || "Leonardo Augusto");
  const role = text(preferences.role || "Direção Comercial");

  return <>
    <style>{styles}</style>
    {createPortal(<div className="leo-standard-profile-controls">
      <button className="theme-btn" aria-label="Alternar tema" onClick={() => setPreferences((current: Row) => ({ ...current, theme: current.theme === "light" ? "dark" : "light" }))}>{preferences.theme === "light" ? "☾" : "☀"}</button>
      <div className="leo-profile-wrap">
        <button className="profile-trigger" onClick={() => setProfileOpen((current) => !current)}><span className="avatar small-avatar">{initials(name)}</span><span><b>{name}</b><small>{role}</small></span></button>
        {profileOpen && <ProfileMenu preferences={preferences} close={() => setProfileOpen(false)} openSettings={() => { setProfileOpen(false); setSettingsOpen(true); }}/>} 
      </div>
    </div>, target)}
    {settingsOpen && createPortal(<SettingsModal preferences={preferences} close={() => setSettingsOpen(false)} save={save}/>, document.body)}
  </>;
}

const styles = `
html.leonardo-commercial-profile .lc-top-actions>button.ghost{display:none!important}
html.leonardo-commercial-profile .leo-standard-profile-controls{display:flex;align-items:center;gap:9px}
html.leonardo-commercial-profile .leo-profile-wrap{position:relative}
html.leonardo-commercial-profile .profile-trigger{display:flex;align-items:center;gap:9px;border:1px solid var(--line)!important;background:var(--panel)!important;color:var(--text)!important;border-radius:10px!important;padding:6px 10px!important;min-height:38px;cursor:pointer;text-align:left}
html.leonardo-commercial-profile .profile-trigger>span:last-child{display:flex;flex-direction:column;min-width:0}
html.leonardo-commercial-profile .profile-trigger b{font-size:12px;line-height:1.2;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
html.leonardo-commercial-profile .profile-trigger small{font-size:9px;color:var(--muted);margin-top:2px}
html.leonardo-commercial-profile .avatar.small-avatar{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--accent));color:#fff;font-size:9px;font-weight:800;flex:0 0 auto}
html.leonardo-commercial-profile .leo-profile-menu{position:absolute;right:0;top:calc(100% + 9px);width:250px;z-index:12050;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.45);padding:8px;display:grid;gap:3px}
html.leonardo-commercial-profile .leo-profile-card{display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--line);margin-bottom:4px}
html.leonardo-commercial-profile .leo-profile-card>.avatar{width:36px;height:36px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--accent));color:#fff;font-size:10px;font-weight:800}
html.leonardo-commercial-profile .leo-profile-card div{display:flex;flex-direction:column}.leo-profile-card b{font-size:12px}.leo-profile-card small{font-size:9px;color:var(--muted);margin-top:2px}
html.leonardo-commercial-profile .leo-profile-menu>button{width:100%;text-align:left!important;border:0!important;background:transparent!important;color:var(--text)!important;border-radius:8px!important;padding:9px 10px!important;font-size:11px!important}.leo-profile-menu>button:hover{background:var(--wash)!important}.leo-profile-menu>button.muted{color:var(--muted)!important}
.leo-settings-overlay{position:fixed;inset:0;z-index:12990;background:rgba(0,0,0,.64);backdrop-filter:blur(5px)}
.leo-settings-modal{position:fixed;z-index:13000;left:50%;top:50%;transform:translate(-50%,-50%);width:min(780px,calc(100vw - 28px));max-height:88vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:17px;box-shadow:0 30px 100px rgba(0,0,0,.52);padding:20px}
.leo-settings-modal .panel-heading h2{margin:4px 0 0}.leo-close{width:34px;height:34px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;cursor:pointer;font-size:18px}
.leo-settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.leo-settings-grid h3{font-size:12px;margin:0 0 10px}.leo-settings-grid label{display:grid;gap:5px;color:var(--muted);font-size:10px;margin:9px 0}.leo-settings-grid input{width:100%;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;padding:9px}.leo-setting-toggle{display:flex;justify-content:space-between;align-items:center;width:100%;border:0;background:transparent;color:var(--text);padding:9px 0;cursor:pointer;border-bottom:1px solid rgba(91,109,122,.24);font-size:11px}.leo-setting-toggle i{width:30px;height:17px;border-radius:20px;background:var(--line);position:relative}.leo-setting-toggle i:after{content:"";position:absolute;top:3px;left:3px;width:11px;height:11px;border-radius:50%;background:var(--muted);transition:.15s}.leo-setting-toggle i.on{background:rgba(49,212,155,.28)}.leo-setting-toggle i.on:after{left:16px;background:var(--green)}.leo-small{font-size:11px;line-height:1.5;color:var(--muted)}
.leo-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--line)}.leo-modal-actions button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:9px;padding:9px 12px;cursor:pointer}.leo-modal-actions button.primary{background:#132640;border-color:var(--blue)}
@media(max-width:720px){html.leonardo-commercial-profile .profile-trigger>span:last-child{display:none}.leo-settings-grid{grid-template-columns:1fr}}
`;
