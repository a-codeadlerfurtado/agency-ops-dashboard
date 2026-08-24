"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, authenticatedFetch, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaign-notes-api`;
const PROFILE_API = `${SUPABASE_URL}/functions/v1/agency-ops-profile-lite`;

type Selection = { clientName: string; campaignName: string; accountKey: string };
type NoteRow = { id: string; note: string; author_person: string; created_at: string };
type CampaignInfo = { campaign_status?: string | null; objective?: string | null; campaign_id?: string | null };

function when(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export default function CampaignNotesBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setRole(null); return; }
    let active = true;
    authenticatedFetch(PROFILE_API)
      .then(async (response) => {
        if (!active || !response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (active) setRole(String(body?.profile?.role || "") || null);
      })
      .catch(() => { if (active) setRole(null); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => { if (role === "COMMERCIAL") setSelected(null); }, [role]);

  useEffect(() => {
    const markTables = () => {
      if (window.location.pathname !== "/campaigns") return;
      if (role === "COMMERCIAL") {
        document.querySelectorAll<HTMLTableElement>('table[data-campaign-notes="true"]').forEach((table) => delete table.dataset.campaignNotes);
        return;
      }
      document.querySelectorAll<HTMLElement>("section.tc-section").forEach((section) => {
        const heading = section.querySelector(".tc-section-head h3")?.textContent?.trim();
        if (heading !== "Campanhas do período") return;
        const table = section.querySelector<HTMLTableElement>("table");
        if (table) table.dataset.campaignNotes = "true";
      });
    };
    const click = (event: MouseEvent) => {
      if (role === "COMMERCIAL" || window.location.pathname !== "/campaigns") return;
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLTableRowElement>('table[data-campaign-notes="true"] tbody tr');
      if (!row || !row.querySelector("td")) return;
      const campaignName = row.querySelector("td b")?.textContent?.trim() || "";
      const accountKey = row.querySelector("td small")?.textContent?.trim() || "";
      const clientName = document.querySelector(".tc-client-title h2")?.textContent?.trim() || "";
      if (!campaignName || !clientName) return;
      setSelected({ clientName, campaignName, accountKey });
      setText("");
      setError("");
    };
    markTables();
    const observer = new MutationObserver(markTables);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", click, true);
    return () => { observer.disconnect(); document.removeEventListener("click", click, true); };
  }, [role]);

  const load = useCallback(async () => {
    if (!selected || !session?.access_token || role === "COMMERCIAL") return;
    setLoading(true); setError(""); setNotes([]); setCampaign(null);
    try {
      const url = new URL(API_URL);
      url.searchParams.set("client_name", selected.clientName);
      url.searchParams.set("campaign_name", selected.campaignName);
      if (selected.accountKey) url.searchParams.set("account_key", selected.accountKey);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403) throw new Error("As observações de campanha são exclusivas para gestores de tráfego e respeitam a carteira de cada GT.");
        if (response.status === 404) throw new Error("Não foi possível localizar esta campanha no inventário atual da Meta.");
        throw new Error(body.detail || body.error || `API ${response.status}`);
      }
      setCampaign(body.campaign || null);
      setNotes(Array.isArray(body.notes) ? body.notes : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar observações.");
    } finally { setLoading(false); }
  }, [selected, session?.access_token, role]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);

  const save = useCallback(async () => {
    const note = text.trim();
    if (!selected || !session?.access_token || !note || saving || role === "COMMERCIAL") return;
    setSaving(true); setError("");
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          client_name: selected.clientName,
          campaign_name: selected.campaignName,
          account_key: selected.accountKey,
          note,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      if (body.note) setNotes((current) => [body.note, ...current]);
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível salvar a observação.");
    } finally { setSaving(false); }
  }, [saving, selected, session?.access_token, text, role]);

  if (!selected || role === "COMMERCIAL") return <style>{baseStyles}</style>;

  return <>
    <style>{baseStyles}</style>
    <div className="cnb-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="cnb-modal" role="dialog" aria-modal="true" aria-label="Observações da campanha">
        <header>
          <div><span>OBSERVAÇÕES DA CAMPANHA</span><h2>{selected.campaignName}</h2><p>{selected.clientName}{selected.accountKey ? ` · ${selected.accountKey}` : ""}</p></div>
          <button className="cnb-close" onClick={() => setSelected(null)} aria-label="Fechar">×</button>
        </header>

        {campaign && <div className="cnb-meta"><span>Status: <b>{campaign.campaign_status || "não informado"}</b></span><span>Objetivo: <b>{campaign.objective || "não informado"}</b></span></div>}

        <div className="cnb-compose">
          <label htmlFor="campaign-note">Adicionar observação</label>
          <textarea id="campaign-note" maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} placeholder="Ex.: cliente pediu para manter orçamento até segunda; público X saturou; testar nova copy; campanha aguardando criativo..." />
          <div><small>{text.length}/4000</small><button disabled={saving || !text.trim()} onClick={save}>{saving ? "Salvando…" : "Salvar observação"}</button></div>
        </div>

        {error && <div className="cnb-error">{error}</div>}

        <div className="cnb-history-head"><div><span>HISTÓRICO</span><b>{notes.length} observação{notes.length === 1 ? "" : "ões"}</b></div><small>Fica salvo na campanha e identificado pelo GT</small></div>
        <div className="cnb-history">
          {loading ? <div className="cnb-empty">Carregando observações…</div> : notes.length ? notes.map((note) => <article key={note.id}><div><b>{note.author_person}</b><time>{when(note.created_at)}</time></div><p>{note.note}</p></article>) : <div className="cnb-empty">Ainda não existe nenhuma observação nesta campanha.</div>}
        </div>
      </section>
    </div>
  </>;
}

const baseStyles = `
table[data-campaign-notes="true"] tbody tr{cursor:pointer;transition:background .14s ease}table[data-campaign-notes="true"] tbody tr:hover{background:#142033!important}table[data-campaign-notes="true"] tbody tr td:first-child b{text-decoration:underline;text-decoration-color:transparent;text-underline-offset:4px;transition:text-decoration-color .14s ease}table[data-campaign-notes="true"] tbody tr:hover td:first-child b{text-decoration-color:#6f9dff}
.cnb-backdrop{position:fixed;inset:0;z-index:2147482900;background:rgba(3,7,13,.82);backdrop-filter:blur(7px);display:grid;place-items:center;padding:22px;font-family:Inter,system-ui,sans-serif;color:#f4f7fb}.cnb-modal{width:min(760px,100%);max-height:88vh;overflow:hidden;display:flex;flex-direction:column;border:1px solid #2b3c55;border-radius:20px;background:#0c131e;box-shadow:0 28px 90px rgba(0,0,0,.58)}.cnb-modal header{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 17px;border-bottom:1px solid #202d40}.cnb-modal header span,.cnb-history-head span{font-size:10px;letter-spacing:.13em;font-weight:800;color:#79a3ff}.cnb-modal header h2{font-family:'Inter Tight',Inter,sans-serif;font-size:24px;line-height:1.15;margin:5px 0 6px}.cnb-modal header p{margin:0;color:#8fa1b8;font-size:12px}.cnb-close{width:38px;height:38px;border-radius:10px;border:1px solid #2c3c52;background:#111a27;color:#b8c6d8;font-size:24px;cursor:pointer}.cnb-meta{display:flex;gap:8px;flex-wrap:wrap;padding:12px 24px 0}.cnb-meta span{font-size:11px;color:#95a7bd;border:1px solid #26354a;background:#101925;padding:6px 9px;border-radius:999px}.cnb-meta b{color:#e6edf7}.cnb-compose{margin:16px 24px 10px;padding:15px;border:1px solid #2a3e5a;border-radius:13px;background:#101927}.cnb-compose label{display:block;font-size:11px;font-weight:800;margin-bottom:8px}.cnb-compose textarea{display:block;width:100%;min-height:105px;resize:vertical;background:#070c13;color:#f5f7fb;border:1px solid #28384d;border-radius:10px;padding:11px 12px;font:inherit;font-size:13px;line-height:1.5;outline:none}.cnb-compose textarea:focus{border-color:#4b78c5;box-shadow:0 0 0 3px rgba(75,120,197,.13)}.cnb-compose>div{display:flex;justify-content:space-between;align-items:center;margin-top:9px}.cnb-compose small{color:#73859c;font-size:10px}.cnb-compose button{border:1px solid #397ef2;border-radius:9px;background:#1b62db;color:#fff;font-weight:800;padding:9px 13px;cursor:pointer}.cnb-compose button:disabled{opacity:.45;cursor:not-allowed}.cnb-error{margin:0 24px 10px;padding:10px 12px;border:1px solid #703541;background:#2a1219;color:#ffadb5;border-radius:10px;font-size:12px}.cnb-history-head{padding:8px 24px 10px;display:flex;align-items:flex-end;justify-content:space-between;gap:12px}.cnb-history-head b{display:block;margin-top:3px;font-size:13px}.cnb-history-head small{font-size:10px;color:#7689a1}.cnb-history{overflow:auto;padding:0 24px 24px;display:grid;gap:9px}.cnb-history article{border:1px solid #223047;border-radius:12px;background:#0a1019;padding:12px 14px}.cnb-history article>div{display:flex;align-items:center;justify-content:space-between;gap:10px}.cnb-history article b{font-size:11px;color:#8eb4ff}.cnb-history article time{font-size:10px;color:#687b94}.cnb-history article p{white-space:pre-wrap;margin:7px 0 0;font-size:13px;line-height:1.5;color:#dfe7f1}.cnb-empty{padding:18px;border:1px dashed #26364d;border-radius:11px;color:#7f91a8;text-align:center;font-size:12px}
@media(max-width:620px){.cnb-backdrop{padding:8px}.cnb-modal{max-height:94vh;border-radius:15px}.cnb-modal header{padding:17px}.cnb-compose{margin:14px 17px 8px}.cnb-meta{padding-left:17px;padding-right:17px}.cnb-history-head,.cnb-history{padding-left:17px;padding-right:17px}.cnb-history-head{align-items:flex-start;flex-direction:column}.cnb-modal header h2{font-size:20px}}
`;
