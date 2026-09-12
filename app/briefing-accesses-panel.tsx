"use client";

import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;
type Credential = { login?: string | null; password?: string | null; login_url?: string | null; expires_in_seconds?: number };
type Props = { clientId: string; clientName: string; drive?: Row | null };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-briefing-access-api`;

const CSS = `
.bha-wrap{display:grid;gap:12px}.bha-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.bha-card{border:1px solid #2b3942;background:#0e151a;border-radius:13px;padding:14px}.bha-card small{display:block;color:#82919c;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.bha-card b{display:block;margin-top:7px;font-size:13px}.bha-ready{color:#63d6a4}.bha-warn{color:#ffad73}.bha-box{border:1px solid #2d3c46;background:#0f161b;border-radius:14px;padding:15px}.bha-box h3{margin:0 0 6px;font-size:15px}.bha-box p{margin:0;color:#91a1ab;font-size:11px;line-height:1.5}.bha-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.bha-btn{border:1px solid #3a4a55;background:#151e24;color:#eef5f8;border-radius:9px;padding:8px 11px;font:750 11px Inter,sans-serif;cursor:pointer}.bha-btn.primary{border-color:#ff7a2f;background:#ff7a2f;color:#fff}.bha-btn.danger{border-color:#7b3b2e;background:#2a1713;color:#ffb29d}.bha-btn:disabled{opacity:.45;cursor:not-allowed}.bha-secret{display:grid;gap:8px;margin-top:12px}.bha-row{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid #273740;background:#0a1014;border-radius:10px;padding:9px 10px}.bha-row span{font-size:11px}.bha-row code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfeaf0}.bha-form{display:grid;gap:8px;margin-top:12px}.bha-form input{border:1px solid #34434d;background:#0a1014;color:#eef5f8;border-radius:9px;padding:10px 11px;outline:none}.bha-check{display:flex;gap:8px;align-items:flex-start;color:#a8b5bd;font-size:10px;line-height:1.4}.bha-error{border:1px solid #6d3030;background:rgba(125,35,35,.12);border-radius:10px;padding:10px;color:#ffaaaa;font-size:11px}@media(max-width:760px){.bha-status{grid-template-columns:1fr}.bha-row{grid-template-columns:1fr}.bha-row code{white-space:normal;word-break:break-all}}
`;

function humanStatus(value: string) {
  if (value === "READY") return "Pronto";
  if (value === "LEGACY_RESET_REQUIRED") return "Senha antiga não recuperável";
  return "Provisionando";
}
export default function BriefingAccessesPanel({ clientId, clientName, drive }: Props) {
  const [row, setRow] = useState<Row | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  const call = useCallback(async (action: string, extra: Row = {}) => {
    const response = await authenticatedFetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ action, client_id: clientId, ...extra }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) throw new Error(body?.error || `API ${response.status}`);
    return body as Row;
  }, [clientId]);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const body = await call("LIST");
      setRow((body.rows || []).find((x: Row) => String(x.client_id) === String(clientId)) || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar acesso.");
    }
  }, [call, clientId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!credential) return;
    const ttl = Math.max(15, Math.min(120, Number(credential.expires_in_seconds || 60)));
    const timer = window.setTimeout(() => setCredential(null), ttl * 1000);
    const hide = () => { if (document.hidden) setCredential(null); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [credential]);

  async function reveal() {
    if (!password) return;
    setBusy("reveal"); setError("");
    try {
      const body = await call("REVEAL", { dashboard_password: password });
      setCredential(body.credential || null); setPassword("");
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível revelar o acesso."); }
    finally { setBusy(""); }
  }

  async function resetLegacy() {
    if (!password || !confirmReset) return;
    setBusy("reset"); setError("");
    try {
      const body = await call("RESET", { dashboard_password: password, confirm_reset: true });
      setCredential(body.credential || null); setPassword(""); setConfirmReset(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível redefinir a senha."); }
    finally { setBusy(""); }
  }

  async function copy(field: "LOGIN" | "PASSWORD", value?: string | null) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    void call("COPY", { field, item_id: row?.credential_id || null }).catch(() => undefined);
  }

  const status = String(row?.status || "PROVISIONING");
  const driveId = row?.drive_folder_id || drive?.external_id || null;
  const driveName = row?.drive_folder_name || drive?.external_name || clientName;

  return <section className="bha-wrap">
    <style>{CSS}</style>
    {error && <div className="bha-error">{error}</div>}
    <div className="bha-status">
      <div className="bha-card"><small>Acesso BHub</small><b className={status === "READY" ? "bha-ready" : "bha-warn"}>{humanStatus(status)}</b></div>
      <div className="bha-card"><small>Login</small><b>{row?.provisioned ? "Provisionado" : "Criando…"}</b></div>
      <div className="bha-card"><small>Drive</small><b className={driveId ? "bha-ready" : "bha-warn"}>{driveId ? "Conectado" : "Aguardando pasta"}</b></div>
    </div>

    <div className="bha-box">
      <h3>Acesso do cliente ao Briefing Hub</h3>
      <p>Login e senha ficam criptografados. Para visualizar, confirme a senha que você usa no próprio Dashboard.</p>
      {status === "LEGACY_RESET_REQUIRED" && <p style={{ marginTop: 8 }}><b>Acesso antigo:</b> a senha atual não é recuperável. O reset abaixo altera a senha do cliente e passa a guardá-la corretamente no cofre.</p>}
      <div className="bha-form">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Senha do seu Dashboard" />
        {status === "LEGACY_RESET_REQUIRED" && <label className="bha-check"><input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} /> Confirmo que quero trocar a senha atual deste cliente no Briefing Hub.</label>}
      </div>
      <div className="bha-actions">
        {status === "READY" && <button className="bha-btn primary" disabled={!password || !!busy} onClick={reveal}>{busy === "reveal" ? "Validando…" : "Ver login e senha"}</button>}
        {status === "LEGACY_RESET_REQUIRED" && <button className="bha-btn danger" disabled={!password || !confirmReset || !!busy} onClick={resetLegacy}>{busy === "reset" ? "Redefinindo…" : "Gerar nova senha segura"}</button>}
        {row?.login_url && <a className="bha-btn" href={row.login_url} target="_blank" rel="noreferrer">Abrir BHub</a>}
        {driveId && <a className="bha-btn" href={`https://drive.google.com/drive/folders/${driveId}`} target="_blank" rel="noreferrer">Abrir Drive</a>}
      </div>

      {credential && <div className="bha-secret">
        <div className="bha-row"><span>Login</span><code>{credential.login || "—"}</code><button className="bha-btn" onClick={() => void copy("LOGIN", credential.login)}>Copiar</button></div>
        <div className="bha-row"><span>Senha</span><code>{credential.password || "—"}</code><button className="bha-btn" onClick={() => void copy("PASSWORD", credential.password)}>Copiar</button></div>
        <div className="bha-row"><span>Cliente</span><code>{clientName}</code><button className="bha-btn" onClick={() => setCredential(null)}>Ocultar</button></div>
      </div>}
    </div>

    <div className="bha-box">
      <h3>Pasta conectada</h3>
      <p>{driveId ? `${driveName} · ${driveId}` : "A pasta será criada/conectada automaticamente pelo provisionamento do cliente."}</p>
    </div>
  </section>;
}
