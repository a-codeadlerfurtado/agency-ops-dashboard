"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const PROFILE_URL = `${SUPABASE_URL}/functions/v1/agency-ops-profile-lite`;
const SAFE_URL = `${SUPABASE_URL}/functions/v1/agency-ops-safe-actions-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type Campaign = {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string | null;
  objective?: string | null;
  account_key?: string | null;
  meta_ad_account_id?: string | null;
  checked_at?: string | null;
};
type ClientInfo = { id: string; display_name: string; gt_owner?: string | null; lifecycle?: string | null };
type Preview = { id: string; action_type: string; preview_state: Row[]; expires_at: string; status: string };
type Step = "LIST" | "PREVIEW" | "RESULT";

function humanError(code: unknown) {
  const raw = String(code || "");
  const map: Record<string, string> = {
    forbidden: "Seu perfil não tem permissão para alterar campanhas deste cliente.",
    client_not_found: "Não foi possível localizar este cliente.",
    client_ambiguous: "Há mais de um cliente com esse nome. A ação foi bloqueada para evitar alterar a conta errada.",
    campaign_not_owned_or_missing: "A campanha não pertence ao cliente selecionado ou saiu do inventário atual.",
    no_eligible_targets: "O estado da campanha mudou e ela não está mais elegível para esta ação.",
    mixed_or_ineligible_targets: "A campanha mudou de estado depois da seleção. Gere uma nova prévia.",
    meta_write_permission_missing: "O token Meta atual não possui permissão de gerenciamento de anúncios.",
    meta_capability_check_failed: "Não foi possível validar a permissão de escrita na Meta agora.",
    meta_preview_failed: "Não foi possível consultar o estado atual da campanha na Meta.",
    preview_expired: "A prévia expirou. Gere uma nova antes de executar.",
    preview_stale: "A campanha mudou depois da prévia. Nenhuma alteração foi executada.",
    preview_integrity_failed: "A prévia não passou na validação de integridade. Gere outra.",
    reauth_failed: "A senha informada não confirmou sua identidade.",
    confirmation_required: "Confirme a operação e informe sua senha do Dashboard.",
    rate_limited: "Muitas prévias foram geradas em pouco tempo. Tente novamente mais tarde.",
    execution_failed: "A Meta recusou a alteração. O sistema tentou preservar o estado anterior.",
    verification_failed: "A ação foi enviada, mas a confirmação final da Meta falhou. Confira o estado antes de tentar novamente.",
  };
  return map[raw] || "Não foi possível concluir a ação agora. Atualize as campanhas e tente novamente.";
}

function when(value: unknown) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(String(value)));
}

export default function CampaignSafeActionsBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<Step>("LIST");
  const [password, setPassword] = useState("");
  const [capable, setCapable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Row | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setRole(null); return; }
    let active = true;
    fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("profile");
      if (active) setRole(String(body?.profile?.role || body?.role || "").toUpperCase() || null);
    }).catch(() => { if (active) setRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  const canWrite = role === "GT" || role === "MGMT";

  const openCurrent = useCallback(() => {
    if (!canWrite) return;
    const name = document.querySelector(".tc-client-title h2")?.textContent?.trim() || "";
    if (!name) return;
    setClientName(name);
    setClient(null);
    setCampaigns([]);
    setSelected(null);
    setPreview(null);
    setPassword("");
    setResult(null);
    setCapable(null);
    setError("");
    setStep("LIST");
    setOpen(true);
  }, [canWrite]);

  useEffect(() => {
    const sync = () => {
      if (window.location.pathname !== "/campaigns") return;
      document.querySelectorAll<HTMLElement>(".csa-launch-host").forEach((host) => {
        if (!canWrite) host.remove();
      });
      if (!canWrite) return;
      document.querySelectorAll<HTMLElement>("section.tc-section").forEach((section) => {
        const heading = section.querySelector(".tc-section-head h3")?.textContent?.trim();
        if (heading !== "Campanhas do período") return;
        const head = section.querySelector<HTMLElement>(".tc-section-head");
        if (!head || head.querySelector(".csa-launch-host")) return;
        const host = document.createElement("span");
        host.className = "csa-launch-host";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "csa-launch";
        button.innerHTML = '<span>◆</span> Ações seguras Meta';
        button.addEventListener("click", openCurrent);
        host.appendChild(button);
        head.appendChild(host);
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [canWrite, openCurrent]);

  const postSafe = useCallback(async (body: Row) => {
    if (!session?.access_token) throw new Error("unauthorized");
    const response = await fetch(SAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const caught = new Error(humanError(data?.error));
      (caught as any).code = data?.error;
      throw caught;
    }
    return data;
  }, [session?.access_token]);

  const discover = useCallback(async () => {
    if (!open || !clientName || !canWrite || !session?.access_token) return;
    setBusy(true); setError("");
    try {
      const data = await postSafe({ action: "DISCOVER", client_name: clientName, source: "CAMPAIGNS" });
      setClient(data.client || null);
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
      if (data?.client?.lifecycle === "CHURNED") {
        setCapable(false);
        setError("Cliente churned: alterações de mídia ficam bloqueadas por segurança.");
        return;
      }
      const capability = await postSafe({ action: "CAPABILITIES", client_id: data.client.id, source: "CAMPAIGNS" });
      setCapable(Boolean(capability.meta_write));
      if (!capability.meta_write) setError("A Meta está conectada para leitura, mas a permissão de escrita não está disponível neste momento.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar as ações seguras.");
    } finally { setBusy(false); }
  }, [open, clientName, canWrite, session?.access_token, postSafe]);

  useEffect(() => { discover(); }, [discover]);

  const actionable = useMemo(() => campaigns.filter((row) => ["ACTIVE", "PAUSED"].includes(String(row.campaign_status || "").toUpperCase())), [campaigns]);

  const generatePreview = useCallback(async (campaign: Campaign) => {
    if (!client?.id || busy || !capable) return;
    const status = String(campaign.campaign_status || "").toUpperCase();
    const actionType = status === "ACTIVE" ? "PAUSE" : status === "PAUSED" ? "RESUME" : "";
    if (!actionType) return;
    setSelected(campaign); setBusy(true); setError(""); setPreview(null); setPassword(""); setResult(null);
    try {
      const data = await postSafe({
        action: "PREVIEW",
        client_id: client.id,
        action_type: actionType,
        campaign_ids: [campaign.campaign_id],
        source: "CAMPAIGNS",
      });
      setPreview(data.preview || null);
      setStep("PREVIEW");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível gerar a prévia.");
    } finally { setBusy(false); }
  }, [client?.id, busy, capable, postSafe]);

  const execute = useCallback(async () => {
    if (!client?.id || !preview?.id || !password || busy) return;
    setBusy(true); setError("");
    try {
      const data = await postSafe({
        action: "EXECUTE",
        client_id: client.id,
        preview_id: preview.id,
        confirmation: "CONFIRMAR",
        password,
        source: "CAMPAIGNS",
      });
      setPassword("");
      setResult(data);
      setStep("RESULT");
      if (data?.ok && data?.status === "VERIFIED") {
        const refreshed = await postSafe({ action: "DISCOVER", client_name: clientName, source: "CAMPAIGNS" });
        setCampaigns(Array.isArray(refreshed.campaigns) ? refreshed.campaigns : []);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível executar a alteração.");
    } finally { setBusy(false); }
  }, [client?.id, preview?.id, password, busy, postSafe, clientName]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, busy]);

  if (!open || !canWrite) return <style>{styles}</style>;

  return <>
    <style>{styles}</style>
    <div className="csa-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <section className="csa-modal" role="dialog" aria-modal="true" aria-label="Ações seguras Meta">
        <header className="csa-head">
          <div><span>AÇÕES SEGURAS META</span><h2>{clientName}</h2><p>Prévia obrigatória · reautenticação · execução na Meta · verificação final</p></div>
          <button className="csa-close" onClick={() => !busy && setOpen(false)} disabled={busy} aria-label="Fechar">×</button>
        </header>

        {error && <div className="csa-error">{error}</div>}

        {step === "LIST" && <div className="csa-body">
          <div className="csa-summary">
            <div><span>PERMISSÃO</span><b>{capable === true ? "ads_management confirmado" : capable === false ? "Escrita indisponível" : "Validando…"}</b></div>
            <div><span>ESCOPO</span><b>{client?.gt_owner ? `GT: ${client.gt_owner}` : role === "MGMT" ? "Gestão" : "Carteira do GT"}</b></div>
          </div>
          <div className="csa-section-title"><div><span>CAMPANHAS</span><h3>Escolha o que deseja alterar</h3></div><small>{actionable.length} elegível(is)</small></div>
          <div className="csa-list">
            {busy && !campaigns.length ? <div className="csa-empty">Consultando inventário e permissões…</div> : campaigns.length ? campaigns.map((campaign) => {
              const status = String(campaign.campaign_status || "").toUpperCase();
              const eligible = ["ACTIVE", "PAUSED"].includes(status) && capable === true && client?.lifecycle !== "CHURNED";
              return <article key={campaign.campaign_id}>
                <div className="csa-campaign-main"><span className={`csa-status ${status === "ACTIVE" ? "active" : "paused"}`}>{status === "ACTIVE" ? "ATIVA" : status === "PAUSED" ? "PAUSADA" : status || "SEM STATUS"}</span><b>{campaign.campaign_name || campaign.campaign_id}</b><small>{campaign.objective || "Objetivo não informado"} · {campaign.account_key || campaign.meta_ad_account_id || "Conta Meta"}</small></div>
                <button disabled={!eligible || busy} className={status === "ACTIVE" ? "danger" : "resume"} onClick={() => generatePreview(campaign)}>{status === "ACTIVE" ? "Pausar" : status === "PAUSED" ? "Retomar" : "Indisponível"}</button>
              </article>;
            }) : !busy && <div className="csa-empty">Nenhuma campanha encontrada no inventário deste cliente.</div>}
          </div>
        </div>}

        {step === "PREVIEW" && preview && <div className="csa-body">
          <button className="csa-back" onClick={() => { setStep("LIST"); setPreview(null); setSelected(null); setPassword(""); setError(""); }} disabled={busy}>← Voltar às campanhas</button>
          <div className="csa-preview-card">
            <span>PRÉVIA GERADA · NADA FOI ALTERADO AINDA</span>
            <h3>{selected?.campaign_name}</h3>
            {(preview.preview_state || []).map((item) => <div className="csa-transition" key={String(item.id)}><b>{String(item.status || "—")}</b><i>→</i><b>{String(item.new_status || "—")}</b></div>)}
            <small>Expira em {when(preview.expires_at)}. Antes de executar, o sistema consulta a Meta novamente e bloqueia se o estado tiver mudado.</small>
          </div>
          <div className="csa-confirm">
            <label htmlFor="csa-password">Confirme sua identidade com a senha do Dashboard</label>
            <input id="csa-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" disabled={busy} />
            <button onClick={execute} disabled={!password || busy}>{busy ? "Executando e verificando…" : "Confirmar e executar"}</button>
            <small>A senha é usada apenas para reautenticação e não é salva na auditoria.</small>
          </div>
        </div>}

        {step === "RESULT" && <div className="csa-body">
          <div className={`csa-result ${result?.ok && result?.status === "VERIFIED" ? "ok" : "bad"}`}>
            <span>{result?.ok && result?.status === "VERIFIED" ? "✓ ALTERAÇÃO CONFIRMADA PELA META" : "ALTERAÇÃO NÃO CONFIRMADA"}</span>
            <h3>{selected?.campaign_name}</h3>
            <p>{result?.ok && result?.status === "VERIFIED" ? `Estado final verificado: ${String(result?.desired_status || result?.after?.[0]?.status || "confirmado")}.` : "O sistema não considera a ação concluída sem confirmação do estado final pela Meta."}</p>
          </div>
          <div className="csa-result-actions"><button onClick={() => { setStep("LIST"); setSelected(null); setPreview(null); setResult(null); setError(""); }}>Voltar às campanhas</button><button className="primary" onClick={() => window.location.reload()}>Atualizar tela</button></div>
        </div>}
      </section>
    </div>
  </>;
}

const styles = `
.csa-launch-host{display:inline-flex;margin-left:auto;align-self:center}.tc-section-head>.csa-launch-host{flex:0 0 auto}.csa-launch{display:inline-flex;align-items:center;gap:7px;border:1px solid #315f9f!important;background:linear-gradient(135deg,#15345e,#10243e)!important;color:#eaf3ff!important;border-radius:9px!important;padding:8px 11px!important;font-size:10px!important;font-weight:800!important;letter-spacing:.02em;cursor:pointer!important;white-space:nowrap}.csa-launch:hover{border-color:#5b8cff!important;background:linear-gradient(135deg,#1b4277,#143052)!important}.csa-launch span{font-size:8px;color:#79a3ff}
.csa-backdrop{position:fixed;inset:0;z-index:2147483200;background:rgba(2,6,12,.84);backdrop-filter:blur(8px);display:grid;place-items:center;padding:22px;font-family:Inter,system-ui,sans-serif;color:#f4f7fb}.csa-modal{width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid #2b4160;border-radius:20px;background:#0b121d;box-shadow:0 32px 100px rgba(0,0,0,.62)}.csa-head{display:flex;justify-content:space-between;gap:18px;padding:22px 24px 18px;border-bottom:1px solid #203149}.csa-head>div>span,.csa-section-title span,.csa-preview-card>span,.csa-result>span,.csa-summary span{font-size:10px;letter-spacing:.13em;font-weight:850;color:#79a3ff}.csa-head h2{font-family:'Inter Tight',Inter,sans-serif;font-size:27px;letter-spacing:-.03em;margin:5px 0}.csa-head p{margin:0;color:#879bb5;font-size:11px}.csa-close{width:38px;height:38px;border:1px solid #2b3c54;border-radius:10px;background:#111b29;color:#b9c7d8;font-size:23px;cursor:pointer}.csa-close:disabled{opacity:.5}.csa-error{margin:14px 24px 0;padding:11px 13px;border:1px solid #753441;border-radius:10px;background:#2b1219;color:#ffb1ba;font-size:12px}.csa-body{padding:20px 24px 24px;overflow:auto}.csa-summary{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:18px}.csa-summary>div{border:1px solid #22344d;border-radius:11px;background:#0e1825;padding:11px 13px}.csa-summary b{display:block;margin-top:5px;font-size:12px}.csa-section-title{display:flex;justify-content:space-between;align-items:flex-end;gap:15px;margin-bottom:10px}.csa-section-title h3{margin:4px 0 0;font-size:16px}.csa-section-title small{color:#7890aa;font-size:10px}.csa-list{display:grid;gap:8px}.csa-list article{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px 13px;border:1px solid #22334a;border-radius:12px;background:#0d1622}.csa-campaign-main{min-width:0}.csa-campaign-main>b,.csa-campaign-main>small{display:block}.csa-campaign-main>b{font-size:12px;margin-top:7px;overflow:hidden;text-overflow:ellipsis}.csa-campaign-main>small{color:#7e92aa;font-size:10px;margin-top:4px}.csa-status{display:inline-flex;border-radius:999px;padding:4px 7px;font-size:8px;font-weight:900;letter-spacing:.05em;background:#202b3b;color:#b4c0d1}.csa-status.active{background:#10382a;color:#78e7b5}.csa-status.paused{background:#232b37;color:#a8b6c8}.csa-list article>button{flex:0 0 auto;border-radius:9px;padding:8px 12px;font-size:10px;font-weight:850;cursor:pointer}.csa-list article>button.danger{border:1px solid #713541;background:#35151d;color:#ffadb8}.csa-list article>button.resume{border:1px solid #246046;background:#103426;color:#83e6b8}.csa-list article>button:disabled{opacity:.35;cursor:not-allowed}.csa-empty{padding:22px;border:1px dashed #293a51;border-radius:12px;text-align:center;color:#7e91a8;font-size:12px}.csa-back{border:0;background:transparent;color:#8ca2ba;padding:0;margin-bottom:14px;cursor:pointer;font-size:11px}.csa-preview-card{border:1px solid #35547d;border-radius:14px;background:linear-gradient(135deg,#112440,#0b141f);padding:18px}.csa-preview-card h3{font-size:17px;margin:6px 0 15px}.csa-transition{display:flex;align-items:center;gap:12px;padding:13px;border:1px solid #2a405e;border-radius:10px;background:#0a121d}.csa-transition b{font-size:14px}.csa-transition i{font-style:normal;color:#7593b8}.csa-preview-card>small{display:block;color:#8297b0;font-size:10px;line-height:1.5;margin-top:12px}.csa-confirm{margin-top:14px;border:1px solid #283b55;border-radius:14px;background:#0d1723;padding:16px}.csa-confirm label{display:block;font-size:11px;font-weight:800;margin-bottom:8px}.csa-confirm input{width:100%;border:1px solid #31455f;border-radius:10px;background:#070d15;color:#fff;padding:11px 12px;outline:none}.csa-confirm input:focus{border-color:#598ee4;box-shadow:0 0 0 3px rgba(89,142,228,.13)}.csa-confirm button{width:100%;margin-top:10px;border:1px solid #3b80ef;border-radius:10px;background:#1b62db;color:#fff;padding:11px 13px;font-weight:850;cursor:pointer}.csa-confirm button:disabled{opacity:.45;cursor:not-allowed}.csa-confirm small{display:block;text-align:center;color:#70859e;font-size:9px;margin-top:8px}.csa-result{border:1px solid #315071;border-radius:15px;padding:22px;background:#0d1927}.csa-result.ok{border-color:#276148;background:#0c2119}.csa-result.bad{border-color:#743643;background:#281219}.csa-result.ok>span{color:#76dfb0}.csa-result.bad>span{color:#ff9eaa}.csa-result h3{margin:8px 0;font-size:18px}.csa-result p{margin:0;color:#a2b1c2;font-size:12px;line-height:1.5}.csa-result-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.csa-result-actions button{border:1px solid #30435c;border-radius:9px;background:#111c2a;color:#dce6f2;padding:9px 12px;font-weight:800;cursor:pointer}.csa-result-actions button.primary{background:#1b62db;border-color:#3b80ef;color:#fff}
@media(max-width:680px){.csa-backdrop{padding:8px}.csa-modal{max-height:95vh;border-radius:15px}.csa-head,.csa-body{padding-left:17px;padding-right:17px}.csa-summary{grid-template-columns:1fr}.csa-list article{align-items:flex-start;flex-direction:column}.csa-list article>button{width:100%}.csa-launch{padding:7px 9px!important;font-size:9px!important}}
`;
