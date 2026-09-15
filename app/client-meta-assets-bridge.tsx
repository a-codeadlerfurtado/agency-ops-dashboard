"use client";

import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-meta-assets-api`;
const SLOT = "client-meta-assets-slot";
const FIELDS = [
  ["meta_ad_account_id", "Conta de anúncios", "act_"],
  ["meta_business_portfolio_id", "Portfólio empresarial", ""],
  ["meta_pixel_dataset_id", "Pixel / Dataset", ""],
  ["meta_page_id", "Página do Facebook", ""],
  ["meta_instagram_id", "Instagram", ""],
] as const;

async function request(body: Row) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sessão expirada");
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.error || `API ${res.status}`);
  return data;
}

function cleanId(value: unknown, prefix = "") {
  const raw = String(value || "").trim().replace(/^act_/i, "");
  return raw ? `${prefix}${raw}` : "";
}

function MetaAssetsCard({ clientName }: { clientName: string }) {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Row>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  async function load() {
    setError("");
    try {
      const payload = await request({ action: "GET", client_name: clientName });
      setData(payload);
      setForm(payload.assets || {});
    } catch (e: any) {
      setError(e?.message || "Não foi possível carregar os IDs.");
    }
  }

  useEffect(() => { void load(); }, [clientName]);

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1300);
    } catch { /* clipboard unavailable */ }
  }

  async function save() {
    setBusy(true); setError("");
    try {
      const body: Row = { action: "UPDATE", client_name: clientName };
      for (const [key] of FIELDS) body[key] = String(form[key] || "").trim();
      const result = await request(body);
      setData((prev) => ({ ...(prev || {}), assets: result.assets }));
      setForm(result.assets || {});
      setEditing(false);
    } catch (e: any) {
      setError(e?.message || "Não foi possível salvar os IDs.");
    } finally { setBusy(false); }
  }

  if (error && !data) return <section className="cma-card"><div className="cma-error">IDs & Infraestrutura indisponíveis: {error}</div></section>;
  if (!data) return <section className="cma-card"><div className="cma-loading">Carregando IDs & Infraestrutura…</div></section>;

  const assets = data.assets || {};
  const canManage = Boolean(data.permissions?.can_manage);
  const hasAccount = Boolean(assets.meta_ad_account_id);

  return <section className="cma-card">
    <div className="cma-head">
      <div>
        <span>INFRAESTRUTURA META</span>
        <h3>IDs & Ativos</h3>
        <p>Identificadores operacionais do cliente. Senhas e tokens continuam fora desta área.</p>
      </div>
      <div className={`cma-health ${hasAccount ? "ok" : "warn"}`}>{hasAccount ? "● Conta vinculada" : "○ Conta não identificada"}</div>
    </div>

    {editing ? <>
      <div className="cma-form">
        {FIELDS.map(([key, label, prefix]) => <label key={key}>
          <span>{label}</span>
          <input
            value={key === "meta_ad_account_id" ? cleanId(form[key], prefix) : String(form[key] || "")}
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            placeholder={key === "meta_ad_account_id" ? "act_123456789" : "ID"}
          />
        </label>)}
      </div>
      {error ? <div className="cma-error compact">{error}</div> : null}
      <div className="cma-actions">
        <button disabled={busy} onClick={() => { setEditing(false); setForm(assets); setError(""); }}>Cancelar</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar IDs"}</button>
      </div>
    </> : <>
      <div className="cma-grid">
        {FIELDS.map(([key, label, prefix]) => {
          const value = cleanId(assets[key], prefix);
          return <article key={key} className={value ? "filled" : "empty"}>
            <div><small>{label}</small><b title={value || "Não cadastrado"}>{value || "Não cadastrado"}</b></div>
            {value ? <button onClick={() => copy(key, value)}>{copied === key ? "Copiado" : "Copiar"}</button> : <span>—</span>}
          </article>;
        })}
      </div>
      <div className="cma-foot">
        <small>{assets.updated_at ? `Atualizado ${new Date(assets.updated_at).toLocaleString("pt-BR")}${assets.updated_by_person ? ` por ${assets.updated_by_person}` : ""}` : "O ID da conta Meta é descoberto automaticamente quando já existe integração vinculada."}</small>
        {canManage ? <button className="edit" onClick={() => { setForm(assets); setEditing(true); setError(""); }}>Editar IDs</button> : null}
      </div>
    </>}
  </section>;
}

export default function ClientMetaAssetsBridge() {
  useEffect(() => {
    let active = true;
    const roots = new Map<HTMLElement, { key: string; root: Root }>();

    function bind(container: HTMLElement, headingSelector: string, anchorSelector: string) {
      const heading = container.querySelector(headingSelector) as HTMLElement | null;
      const name = (heading?.textContent || "").trim();
      if (!name || /carregando|buscando/i.test(name)) return;
      let slot = container.querySelector(`:scope > .${SLOT}`) as HTMLElement | null;
      if (!slot) {
        slot = document.createElement("div");
        slot.className = SLOT;
        const anchor = container.querySelector(anchorSelector) as HTMLElement | null;
        if (anchor?.parentElement === container) anchor.insertAdjacentElement("afterend", slot);
        else container.insertBefore(slot, container.firstChild);
      }
      const existing = roots.get(slot);
      if (existing?.key === name) return;
      if (existing) existing.root.unmount();
      const root = createRoot(slot);
      root.render(<MetaAssetsCard clientName={name} />);
      roots.set(slot, { key: name, root });
    }

    function scan() {
      if (!active) return;
      document.querySelectorAll<HTMLElement>(".ops-360").forEach((el) => bind(el, ".ops-360-head h2", ".ops-360-kpis"));
      document.querySelectorAll<HTMLElement>(".drawer.open").forEach((el) => bind(el, ".drawer-head h2", ".drawer-head"));
    }

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(scan, 1200);
    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      roots.forEach((item) => item.root.unmount());
      roots.clear();
      document.querySelectorAll(`.${SLOT}`).forEach((el) => el.remove());
    };
  }, []);
  return null;
}
