"use client";

import { useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, text } from "./shared";
import type { Row } from "./shared";

const API = SUPABASE_URL + "/functions/v1/agency-ops-wallet-management-api";

const STYLE = `
.cwt-backdrop{position:fixed;inset:0;z-index:2147483200;background:rgba(3,7,12,.78);backdrop-filter:blur(8px);display:grid;place-items:center;padding:20px}
.cwt-modal{width:min(620px,96vw);background:#0a1418;border:1px solid #29413f;border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden;color:#e8f1ee}
.cwt-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:20px 22px;border-bottom:1px solid #1e3134}.cwt-head span{font-size:8px;color:#62cca0;font-weight:900;letter-spacing:.13em}.cwt-head h2{margin:5px 0 3px;font-size:22px}.cwt-head p{margin:0;color:#77908a;font-size:10px}.cwt-close{width:34px;height:34px;border:1px solid #2c4144;background:#0d1c20;color:#cfe0dc;border-radius:9px;font-size:19px;cursor:pointer}
.cwt-body{padding:18px 22px 22px;display:grid;gap:14px}.cwt-current{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:stretch}.cwt-side{border:1px solid #203438;background:#081317;border-radius:12px;padding:13px}.cwt-side small{display:block;color:#718984;font-size:8px;text-transform:uppercase;letter-spacing:.08em}.cwt-side b{display:block;margin-top:6px;font-size:13px}.cwt-side em{display:block;margin-top:3px;color:#8aa19c;font-size:9px;font-style:normal}.cwt-arrow{align-self:center;color:#5f7f76;font-weight:900}
.cwt-field{display:grid;gap:6px}.cwt-field span{font-size:8px;color:#8aa19c;text-transform:uppercase;letter-spacing:.08em}.cwt-field select{width:100%;border:1px solid #2a4245;background:#081317;color:#dce9e5;border-radius:10px;padding:11px;font:700 11px Inter}.cwt-field small{color:#657e78;font-size:9px}
.cwt-review{border:1px solid #6b5227;background:#1d170d;border-radius:12px;padding:13px;display:grid;gap:8px}.cwt-review>span{font-size:8px;color:#f3b35f;font-weight:900;letter-spacing:.1em}.cwt-review p{margin:0;color:#d9d0bd;font-size:10px;line-height:1.55}.cwt-review strong{color:#fff2d1}
.cwt-actions{display:flex;justify-content:flex-end;gap:8px}.cwt-actions button{border:1px solid #33494c;background:#102025;color:#d9e7e3;border-radius:9px;padding:9px 12px;font:800 10px Inter;cursor:pointer}.cwt-actions button.primary{border-color:#3d765f;background:#15362a;color:#bff2d8}.cwt-actions button.danger{border-color:#8a672a;background:#38290f;color:#ffe0a6}.cwt-actions button:disabled{opacity:.45;cursor:not-allowed}
.cwt-error{border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:9px;padding:9px 11px;font-size:9px}.cwt-loading{padding:22px;text-align:center;color:#79918c;font-size:10px}
.cwt-inline{border:1px solid #29423d;background:#0d1f1b;color:#bfead5;border-radius:999px;padding:5px 8px;font:800 9px Inter;cursor:pointer;display:inline-flex;align-items:center;gap:5px}.cwt-inline:hover{border-color:#4d7e68;background:#123025}.cwt-inline.empty{border-color:#6f5428;background:#231a0d;color:#f3c679}.cwt-inline[disabled]{opacity:.55;cursor:not-allowed}
@media(max-width:640px){.cwt-current{grid-template-columns:1fr}.cwt-arrow{transform:rotate(90deg);justify-self:center}.cwt-actions{display:grid;grid-template-columns:1fr}.cwt-actions button{width:100%}}
`;

function managerWallet(manager: Row | undefined) {
  if (!manager) return "";
  return manager.carteira ? "Carteira " + String(manager.carteira) : "Carteira sem codinome";
}

export function WalletInlineStyles() {
  return <style>{STYLE}</style>;
}

export function WalletInlineButton({ client, allowed, onClick }: { client: Row; allowed: boolean; onClick: () => void }) {
  const owner = String(client.gt_owner || "").trim();
  const blocked = client.gt_assignment_blocked === true;
  const label = blocked ? "IA · sem GT" : owner || "Sem carteira";
  if (!allowed || blocked || !["ACTIVE", "ONBOARDING"].includes(String(client.lifecycle || ""))) {
    return <span title={blocked ? "Cliente exclusivo de IA: não exige gestor de tráfego." : undefined}>{label}</span>;
  }
  return <button
    type="button"
    className={"cwt-inline " + (!owner ? "empty" : "")}
    onClick={(event) => { event.stopPropagation(); onClick(); }}
    title={owner ? "Trocar carteira deste cliente" : "Atribuir carteira a este cliente"}
  >
    {owner ? label : "+ Atribuir carteira"}
  </button>;
}

export default function ClientWalletTransfer({
  token, client, close, refresh,
}: { token: string; client: Row; close: () => void; refresh?: (result?: Row) => Promise<void> | void }) {
  const [payload, setPayload] = useState<Row>({ clients: [], managers: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [targetGt, setTargetGt] = useState("");
  const [review, setReview] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetch(API, {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || ("API " + response.status));
        if (active) setPayload(body);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Falha ao carregar carteiras.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [token]);

  const managers: Row[] = payload.managers || [];
  const freshClient: Row = useMemo(
    () => (payload.clients || []).find((row: Row) => String(row.client_id) === String(client.client_id)) || client,
    [payload.clients, client],
  );
  const currentGt = String(freshClient.gt_owner || "").trim();
  const currentManager = managers.find((row) => String(row.person || "") === currentGt);
  const targetManager = managers.find((row) => String(row.person || "") === targetGt);
  const targetOptions = managers.filter((row) => String(row.person || "") !== currentGt);

  async function confirmMove() {
    if (!targetGt || targetGt === currentGt || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ client_id: freshClient.client_id, gt_owner: targetGt }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || ("API " + response.status));
      if (refresh) { try { await refresh(body); } catch { /* a troca já foi confirmada pelo backend; refresh não pode transformar sucesso em erro */ } }
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível alterar a carteira.");
    } finally {
      setSaving(false);
    }
  }

  const assigning = !currentGt;

  return <div className="cwt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close(); }}>
    <style>{STYLE}</style>
    <section className="cwt-modal" role="dialog" aria-modal="true" aria-label="Alterar carteira do cliente">
      <header className="cwt-head">
        <div>
          <span>CARTEIRA · GESTOR DE TRÁFEGO</span>
          <h2>{assigning ? "Atribuir carteira" : "Migrar cliente de carteira"}</h2>
          <p>{text(freshClient.display_name)} · a mudança só acontece depois da confirmação final.</p>
        </div>
        <button className="cwt-close" onClick={close} disabled={saving} aria-label="Fechar">×</button>
      </header>

      {loading ? <div className="cwt-loading">Carregando gestores e carteira atual…</div> : <div className="cwt-body">
        {error && <div className="cwt-error">{error}</div>}

        <div className="cwt-current">
          <div className="cwt-side">
            <small>Carteira atual</small>
            <b>{currentGt || "Sem carteira"}</b>
            <em>{currentGt ? managerWallet(currentManager) : "Cliente aguardando atribuição"}</em>
          </div>
          <div className="cwt-arrow">→</div>
          <div className="cwt-side">
            <small>Nova carteira</small>
            <b>{targetGt || "Selecione um GT"}</b>
            <em>{targetGt ? managerWallet(targetManager) : "Nenhuma alteração selecionada"}</em>
          </div>
        </div>

        <label className="cwt-field">
          <span>Gestor de Tráfego de destino</span>
          <select value={targetGt} onChange={(event) => { setTargetGt(event.target.value); setReview(false); }} disabled={saving}>
            <option value="">Selecione o GT…</option>
            {targetOptions.map((manager) => <option key={manager.person} value={manager.person}>
              {manager.person}{manager.carteira ? " · Carteira " + manager.carteira : ""}
            </option>)}
          </select>
          <small>Somente gestores ativos aparecem nesta lista.</small>
        </label>

        {review && targetGt && <div className="cwt-review">
          <span>CONFIRMAÇÃO OBRIGATÓRIA</span>
          <p>
            Você está prestes a {assigning ? "atribuir" : "migrar"} <strong>{text(freshClient.display_name)}</strong>{" "}
            {currentGt ? <>da carteira de <strong>{currentGt}</strong>{" "}</> : <>que está <strong>sem carteira</strong>{" "}</>}
            para <strong>{targetGt}</strong>
            {targetManager?.carteira ? <> · Carteira <strong>{String(targetManager.carteira)}</strong></> : null}.
            {" "}Essa troca altera o GT oficial do cliente no Dashboard.
          </p>
        </div>}

        <div className="cwt-actions">
          <button onClick={close} disabled={saving}>Cancelar</button>
          {!review
            ? <button className="primary" onClick={() => setReview(true)} disabled={!targetGt || targetGt === currentGt}>Revisar alteração</button>
            : <button className="danger" onClick={() => void confirmMove()} disabled={saving}>
                {saving ? "Alterando…" : assigning ? "Confirmar atribuição" : "Confirmar migração"}
              </button>}
        </div>
      </div>}
    </section>
  </div>;
}
