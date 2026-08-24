"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../../shared";

type Row = {
  person: string;
  enabled?: boolean;
  secret_configured?: boolean;
  last_probe_at?: string | null;
  last_probe_status?: string | null;
  last_probe_detail?: string | null;
  last_sync_at?: string | null;
  last_sync_status?: string | null;
  last_sync_detail?: string | null;
  transcripts_seen?: number | null;
  transcripts_ingested?: number | null;
};

const PEOPLE = ["Gustavo Lima", "Yuri Melo", "Rodrigo Cavalheiro"];
const API = `${SUPABASE_URL}/functions/v1/agency-ops-donnah-credentials-api`;

function when(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export default function DonnahIntegrationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setReady(true);
    });
  }, []);

  const headers = useMemo(() => session?.access_token ? {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
  } : null, [session?.access_token]);

  const load = useCallback(async () => {
    if (!headers) return;
    setError("");
    try {
      const response = await fetch(API, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setRows(body.items || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar integrações Donnah.");
    }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  async function save(person: string) {
    if (!headers) return;
    const token = String(tokens[person] || "").trim();
    if (!token) {
      setMessages((current) => ({ ...current, [person]: { ok: false, text: "Cole a chave MCP antes de salvar." } }));
      return;
    }
    setBusy((current) => ({ ...current, [person]: true }));
    setMessages((current) => ({ ...current, [person]: { ok: true, text: "Testando Donnah e sincronizando…" } }));
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ person, token }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `HTTP ${response.status}`);
      setTokens((current) => ({ ...current, [person]: "" }));
      const syncOk = body?.sync?.ok !== false;
      setMessages((current) => ({
        ...current,
        [person]: {
          ok: syncOk,
          text: syncOk ? "Conectado. Chave protegida no Vault e primeiro sync executado." : "Chave conectada e protegida. O primeiro sync retornou pendência e será tentado novamente pelo pipeline.",
        },
      }));
      await load();
    } catch (caught) {
      setMessages((current) => ({
        ...current,
        [person]: { ok: false, text: caught instanceof Error ? caught.message : "Falha ao salvar a integração." },
      }));
    } finally {
      setBusy((current) => ({ ...current, [person]: false }));
    }
  }

  if (!ready) return <main className="dn-page"><style>{styles}</style><div className="dn-empty">Validando sessão…</div></main>;
  if (!session) return <main className="dn-page"><style>{styles}</style><div className="dn-empty">Faça login no dashboard para continuar.</div></main>;

  const byPerson = new Map(rows.map((row) => [row.person, row]));
  return <main className="dn-page">
    <style>{styles}</style>
    <header className="dn-head">
      <div>
        <span>INTEGRAÇÕES · DONNAH</span>
        <h1>Reuniões da equipe</h1>
        <p>Cadastre as chaves MCP com segurança. Elas são testadas antes de serem gravadas e ficam somente no Supabase Vault.</p>
      </div>
      <a href="/">Voltar para a Home</a>
    </header>

    <div className="dn-note"><b>Segurança</b><span>A chave nunca aparece novamente depois de salva e não é armazenada no navegador, no código-fonte ou nas tabelas operacionais.</span></div>
    {error && <div className="dn-error">{error === "FORBIDDEN" ? "Esta tela é exclusiva do Adler." : error}</div>}

    <section className="dn-grid">
      {PEOPLE.map((person) => {
        const row = byPerson.get(person);
        const configured = Boolean(row?.secret_configured);
        const message = messages[person];
        return <article className="dn-card" key={person}>
          <div className="dn-card-head">
            <div><small>COLABORADOR</small><h2>{person}</h2></div>
            <span className={configured ? "dn-pill ok" : "dn-pill pending"}>{configured ? "Conectado" : "Aguardando chave"}</span>
          </div>

          <div className="dn-status-grid">
            <div><small>ÚLTIMO TESTE</small><b>{row?.last_probe_status || "—"}</b><span>{when(row?.last_probe_at)}</span></div>
            <div><small>ÚLTIMO SYNC</small><b>{row?.last_sync_status || "—"}</b><span>{when(row?.last_sync_at)}</span></div>
            <div><small>REUNIÕES VISTAS</small><b>{Number(row?.transcripts_seen || 0)}</b><span>feeds Donnah</span></div>
            <div><small>TRANSCRIÇÕES</small><b>{Number(row?.transcripts_ingested || 0)}</b><span>integradas</span></div>
          </div>

          {row?.last_sync_detail && <div className="dn-detail"><b>Último processamento</b><span>{row.last_sync_detail}</span></div>}

          <label className="dn-field">
            <span>{configured ? "Trocar chave MCP" : "Chave MCP"}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="dnh_mcp_••••••••••••••••"
              value={tokens[person] || ""}
              onChange={(event) => setTokens((current) => ({ ...current, [person]: event.target.value }))}
            />
          </label>
          <button disabled={Boolean(busy[person])} onClick={() => void save(person)}>{busy[person] ? "Testando e sincronizando…" : configured ? "Atualizar chave e testar" : "Salvar, testar e sincronizar"}</button>
          {message && <div className={message.ok ? "dn-message ok" : "dn-message error"}>{message.text}</div>}
        </article>;
      })}
    </section>
  </main>;
}

const styles = `
*{box-sizing:border-box}.dn-page{min-height:100vh;background:#07111d;color:#eaf2fa;padding:34px;max-width:1450px;margin:0 auto;font-family:Inter,system-ui,sans-serif}.dn-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:22px}.dn-head span{font-size:10px;letter-spacing:.13em;color:#7793ac}.dn-head h1{font-size:34px;margin:5px 0 7px}.dn-head p{max-width:720px;margin:0;color:#8ca2b6;line-height:1.5}.dn-head a{color:#d9ebf9;text-decoration:none;border:1px solid rgba(111,166,214,.25);border-radius:10px;padding:10px 14px;background:rgba(45,112,172,.1)}.dn-note{display:flex;gap:12px;align-items:center;padding:13px 15px;margin-bottom:18px;border:1px solid rgba(63,181,128,.18);background:rgba(43,146,101,.08);border-radius:12px;font-size:12px}.dn-note b{color:#95dfbb}.dn-note span{color:#89a598}.dn-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.dn-card{border:1px solid rgba(116,156,192,.18);border-radius:17px;background:#0d1a29;padding:19px}.dn-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:17px}.dn-card-head small,.dn-status-grid small{display:block;color:#718ba2;font-size:9px;letter-spacing:.09em}.dn-card h2{font-size:19px;margin:4px 0 0}.dn-pill{font-size:9px;font-weight:800;padding:6px 8px;border-radius:999px}.dn-pill.ok{color:#91e0b6;border:1px solid rgba(62,188,132,.24);background:rgba(62,188,132,.09)}.dn-pill.pending{color:#e7bd73;border:1px solid rgba(213,164,76,.24);background:rgba(213,164,76,.09)}.dn-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:13px}.dn-status-grid>div{padding:11px;border-radius:11px;background:rgba(14,31,48,.72);border:1px solid rgba(112,153,189,.1)}.dn-status-grid b{display:block;margin-top:4px;font-size:13px}.dn-status-grid span{display:block;margin-top:3px;color:#71889b;font-size:9px}.dn-detail{padding:10px 11px;margin-bottom:13px;border-radius:10px;background:rgba(47,105,157,.08);font-size:10px;line-height:1.45}.dn-detail b{display:block;color:#a9c8df;margin-bottom:3px}.dn-detail span{color:#849caf}.dn-field{display:block;margin-top:7px}.dn-field>span{display:block;color:#8ba2b6;font-size:10px;font-weight:700;margin-bottom:6px}.dn-field input{width:100%;border:1px solid rgba(118,158,193,.22);background:#081522;color:#e7f2fb;border-radius:10px;padding:11px 12px;outline:none;font:500 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}.dn-field input:focus{border-color:rgba(65,154,229,.55);box-shadow:0 0 0 3px rgba(65,154,229,.08)}.dn-card button{width:100%;margin-top:10px;border:1px solid rgba(61,154,230,.34);background:rgba(48,132,207,.17);color:#eaf6ff;border-radius:10px;padding:11px 13px;font-weight:800;font-size:11px;cursor:pointer}.dn-card button:hover{background:rgba(48,132,207,.25)}.dn-card button:disabled{opacity:.55;cursor:wait}.dn-message{margin-top:10px;border-radius:9px;padding:9px 10px;font-size:10px;line-height:1.4}.dn-message.ok{color:#9be2bd;background:rgba(52,171,118,.08)}.dn-message.error,.dn-error{color:#ffab9d;background:rgba(202,77,58,.1);border:1px solid rgba(218,92,72,.16)}.dn-error{padding:12px;border-radius:11px;margin-bottom:15px}.dn-empty{padding:40px;text-align:center;color:#819aad}@media(max-width:1000px){.dn-grid{grid-template-columns:1fr}.dn-head{flex-direction:column}}@media(max-width:600px){.dn-page{padding:18px}.dn-status-grid{grid-template-columns:1fr}}
`;
