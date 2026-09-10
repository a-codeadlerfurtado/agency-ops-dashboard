"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meetings-api`;
const CAPTURE_API = `${SUPABASE_URL}/functions/v1/agency-ops-meeting-capture-api`;
const PAGE_SIZE = 30;

function fmtDate(value: unknown) {
  if (!value) return "Sem data";
  try {
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
  } catch {
    return String(value);
  }
}

function cleanTitle(row: Row) {
  const fromMeta = String(row?.metadata?.subject || row?.metadata?.title || "").trim();
  if (fromMeta) return fromMeta;
  const raw = String(row?.source_file_name || row?.meeting_code || "Reunião").trim();
  return raw.replace(/\.(txt|md|json)$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Reunião";
}

function asItems(value: unknown): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const obj = item as Row;
      return String(obj.text || obj.title || obj.decision || obj.commitment || obj.action || obj.description || obj.name || "").trim();
    }
    return String(item || "").trim();
  }).filter(Boolean);
}

function participants(value: unknown) {
  return asItems(value).slice(0, 8);
}

const STYLE = `
  .meetings-nav-button::before{content:""!important;width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;margin:0!important;transform:none!important;background-color:currentColor!important;background-image:none!important;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2' fill='none' stroke='black' stroke-width='1.8'/%3E%3Cpath d='M7 3v4M17 3v4M3.5 9h17' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2' fill='none' stroke='black' stroke-width='1.8'/%3E%3Cpath d='M7 3v4M17 3v4M3.5 9h17' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important;}
  .meetings-nav-button{display:flex!important;align-items:center!important;gap:12px!important;}
  .meetings-shell{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147481500;background:#0b1014;color:var(--text,#edf4f8);overflow:auto;padding:24px 28px 42px;}
  .meetings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin:0 auto 18px;max-width:1440px;}
  .meetings-head h1{margin:4px 0 4px;font:800 30px/1.05 Inter Tight,Inter,sans-serif;letter-spacing:-.03em;}
  .meetings-kicker{font-size:11px;font-weight:900;letter-spacing:.12em;color:#ff9a61;text-transform:uppercase;}
  .meetings-sub{color:#9eacb7;font-size:13px;max-width:720px;}
  .meetings-actions{display:flex;gap:8px;align-items:center;}
  .meetings-btn{border:1px solid #34414b;background:#151c22;color:#e8f0f5;border-radius:10px;padding:9px 12px;font:700 12px Inter,sans-serif;cursor:pointer;}
  .meetings-btn:hover{border-color:#76c6ff;background:#18232a;}
  .meetings-btn.primary{border-color:#ff934f;background:#ff7a2f;color:white;}
  .meetings-toolbar{max-width:1440px;margin:0 auto 14px;display:grid;grid-template-columns:minmax(240px,1fr) auto auto;gap:8px;}
  .meetings-toolbar input{min-width:0;border:1px solid #33414b;background:#10161b;color:#eef5f8;border-radius:10px;padding:10px 12px;outline:none;}
  .meetings-toolbar input:focus{border-color:#76c6ff;box-shadow:0 0 0 2px rgba(118,198,255,.08);}
  .meetings-meta{max-width:1440px;margin:0 auto 10px;color:#8f9da8;font-size:11px;display:flex;gap:12px;flex-wrap:wrap;}
  .meetings-grid{max-width:1440px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;}
  .meeting-card{border:1px solid #2e3a43;background:linear-gradient(180deg,#151b20,#11171b);border-radius:14px;padding:15px;text-align:left;color:inherit;cursor:pointer;min-height:210px;display:flex;flex-direction:column;gap:9px;box-shadow:0 8px 20px rgba(0,0,0,.12);}
  .meeting-card:hover{border-color:#4d6576;transform:translateY(-1px);}
  .meeting-card-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
  .meeting-client{font-size:11px;font-weight:900;letter-spacing:.07em;color:#8fd2ff;text-transform:uppercase;}
  .meeting-date{font-size:10px;color:#82909a;white-space:nowrap;}
  .meeting-title{font:750 16px/1.2 Inter,sans-serif;color:#f1f6f8;}
  .meeting-summary{font-size:12px;line-height:1.5;color:#b4c0c8;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
  .meeting-card-footer{margin-top:auto;display:flex;gap:7px;flex-wrap:wrap;}
  .meeting-pill{font-size:10px;font-weight:800;border:1px solid #33414b;background:#0e1418;border-radius:999px;padding:4px 7px;color:#a9b6bf;}
  .meeting-empty{max-width:1440px;margin:28px auto;border:1px dashed #35434d;border-radius:14px;padding:28px;color:#9baab4;text-align:center;}
  .meeting-more{display:flex;justify-content:center;max-width:1440px;margin:16px auto 0;}
  .meeting-drawer-backdrop{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147482500;background:rgba(0,0,0,.46);display:flex;justify-content:flex-end;}
  .meeting-drawer{width:min(620px,92vw);height:100%;background:#0d1317;border-left:1px solid #33414b;overflow:auto;padding:22px;box-shadow:-18px 0 50px rgba(0,0,0,.35);}
  .meeting-drawer-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;position:sticky;top:-22px;background:#0d1317;padding:22px 0 14px;z-index:2;border-bottom:1px solid #28333a;}
  .meeting-drawer h2{margin:4px 0 4px;font:800 22px/1.15 Inter Tight,Inter,sans-serif;}
  .meeting-section{margin-top:18px;}
  .meeting-section h3{margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#ff9a61;}
  .meeting-section p,.meeting-section li{color:#bec9d0;font-size:12px;line-height:1.6;}
  .meeting-section ul{margin:0;padding-left:18px;display:grid;gap:5px;}
  .meeting-transcript{white-space:pre-wrap;background:#090d10;border:1px solid #273139;border-radius:11px;padding:14px;max-height:48vh;overflow:auto;color:#aebbc4;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;}
  .meeting-participants{display:flex;gap:6px;flex-wrap:wrap;}
  .meeting-participant{padding:5px 7px;border-radius:8px;background:#141c21;border:1px solid #2b3942;font-size:10px;color:#b9c6ce;}
  .meetings-pair{max-width:1440px;margin:0 auto 14px;padding:12px 14px;border:1px solid #3a4751;border-radius:12px;background:#10171c;display:flex;align-items:center;justify-content:space-between;gap:14px;}
  .meetings-pair-code{font:850 18px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;color:#8fd2ff;}
  .meetings-pair-note{font-size:11px;color:#94a4af;margin-top:5px;}
  @media(max-width:720px){.meetings-shell{left:58px;padding:18px 14px 34px}.meetings-head{flex-direction:column}.meetings-toolbar{grid-template-columns:1fr 1fr}.meetings-toolbar input{grid-column:1/-1}.meetings-grid{grid-template-columns:1fr}.meeting-drawer-backdrop{left:58px}.meeting-drawer{width:100%}}
`;

export default function MeetingsBridge() {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingExpires, setPairingExpires] = useState("");
  const [pairingLoading, setPairingLoading] = useState(false);

  const load = useCallback(async (reset = true, q = activeQuery) => {
    setLoading(true);
    setError("");
    try {
      const url = new URL(API);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(reset ? 0 : records.length));
      if (q.trim()) url.searchParams.set("q", q.trim());
      const response = await authenticatedFetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const body = await response.json();
      const next = Array.isArray(body.records) ? body.records : [];
      setRecords((current) => reset ? next : [...current, ...next]);
      setCount(Number(body.count || 0));
      setHasMore(Boolean(body.has_more));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar as reuniões.");
    } finally {
      setLoading(false);
    }
  }, [activeQuery, records.length]);

  useEffect(() => {
    if (!open || records.length || loading) return;
    load(true, activeQuery);
  }, [open, records.length, loading, load, activeQuery]);

  useEffect(() => {
    let observer: MutationObserver | null = null;
    let cleanupButton: (() => void) | null = null;

    const ensureButton = () => {
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!container) return;
      let button = container.querySelector<HTMLButtonElement>("[data-meetings-nav]");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.meetingsNav = "true";
        button.className = "meetings-nav-button";
        button.title = "Equipe";
        button.setAttribute("aria-label", "Reuniões");
        button.textContent = "Reuniões";
        container.appendChild(button);
      }
      button.classList.toggle("active", open);
      const onClick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      };
      button.addEventListener("click", onClick);
      cleanupButton?.();
      cleanupButton = () => button?.removeEventListener("click", onClick);

      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (!document.querySelector("[data-meetings-nav]")) ensureButton();
      });
      observer.observe(container, { childList: true });
    };

    ensureButton();
    const startup = window.setInterval(() => {
      if (document.querySelector("[data-meetings-nav]")) {
        window.clearInterval(startup);
        return;
      }
      ensureButton();
    }, 250);
    const stopStartup = window.setTimeout(() => window.clearInterval(startup), 5000);

    const closeOnOtherNav = (event: Event) => {
      if (!open) return;
      const target = event.target instanceof Element ? event.target.closest(".side-nav-items > button,.side-nav-items > a") : null;
      if (!target || target.hasAttribute("data-meetings-nav") || target.classList.contains("sidebar-ia-group-title")) return;
      setOpen(false);
    };
    document.addEventListener("click", closeOnOtherNav, true);
    return () => {
      cleanupButton?.();
      observer?.disconnect();
      window.clearInterval(startup);
      window.clearTimeout(stopStartup);
      document.removeEventListener("click", closeOnOtherNav, true);
      document.querySelector("[data-meetings-nav]")?.remove();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (detail) setDetail(null);
        else setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, detail]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    setActiveQuery(next);
    setRecords([]);
    setDetail(null);
    load(true, next);
  };

  const openDetail = async (row: Row) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const url = new URL(API);
      url.searchParams.set("transcript_id", String(row.id));
      const response = await authenticatedFetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const body = await response.json();
      setDetail(body.transcript || row);
    } catch {
      setDetail(row);
    } finally {
      setDetailLoading(false);
    }
  };

  const createPairing = async () => {
    setPairingLoading(true);
    setError("");
    try {
      const response = await authenticatedFetch(CAPTURE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pair_create" }),
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body?.code) throw new Error(body?.error || `API ${response.status}`);
      setPairingCode(String(body.code));
      setPairingExpires(String(body.expires_at || ""));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível gerar o código da extensão.");
    } finally {
      setPairingLoading(false);
    }
  };

  const totalChars = useMemo(() => records.reduce((sum, row) => sum + Number(row.transcript_chars || 0), 0), [records]);

  if (typeof document === "undefined") return <style dangerouslySetInnerHTML={{ __html: STYLE }} />;

  return <>
    <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    {open && createPortal(<section className="meetings-shell" aria-label="Reuniões">
      <div className="meetings-head">
        <div>
          <div className="meetings-kicker">Reuniões</div>
          <h1>Histórico de reuniões</h1>
          <div className="meetings-sub">Resumo, decisões, compromissos e participantes já processados. A transcrição completa só é buscada quando você abre uma reunião.</div>
        </div>
        <div className="meetings-actions">
          <button className="meetings-btn primary" onClick={createPairing} disabled={pairingLoading}>{pairingLoading ? "Gerando…" : "Conectar captura"}</button>
          <button className="meetings-btn" onClick={() => load(true, activeQuery)} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
          <button className="meetings-btn" onClick={() => setOpen(false)}>Fechar</button>
        </div>
      </div>

      {pairingCode && <div className="meetings-pair">
        <div>
          <div className="meetings-pair-code">{pairingCode}</div>
          <div className="meetings-pair-note">Abra a extensão Leonardo Meetings → Configurar conexão e digite este código. Ele expira {pairingExpires ? fmtDate(pairingExpires) : "em 15 minutos"}.</div>
        </div>
        <button className="meetings-btn" onClick={() => { navigator.clipboard?.writeText(pairingCode); }}>Copiar código</button>
      </div>}

      <form className="meetings-toolbar" onSubmit={submitSearch}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, título ou resumo" />
        <button className="meetings-btn primary" type="submit">Buscar</button>
        {(activeQuery || query) && <button className="meetings-btn" type="button" onClick={() => { setQuery(""); setActiveQuery(""); setRecords([]); load(true, ""); }}>Limpar</button>}
      </form>

      <div className="meetings-meta">
        <span>{count} reuniões encontradas</span>
        <span>{records.length} carregadas</span>
        <span>{Math.round(totalChars / 1000)} mil caracteres referenciados sem carregar transcript</span>
        <span>Sem polling automático</span>
      </div>

      {error && <div className="meeting-empty">{error}</div>}
      {!error && !loading && !records.length && <div className="meeting-empty">Nenhuma reunião encontrada.</div>}

      <div className="meetings-grid">
        {records.map((row) => {
          const decisions = asItems(row.decisions);
          const commitments = asItems(row.commitments);
          const people = participants(row.participants);
          return <button className="meeting-card" key={String(row.id)} onClick={() => openDetail(row)}>
            <div className="meeting-card-top">
              <span className="meeting-client">{String(row.client_name_raw || "Cliente não vinculado")}</span>
              <span className="meeting-date">{fmtDate(row.meeting_started_at || row.created_at)}</span>
            </div>
            <div className="meeting-title">{cleanTitle(row)}</div>
            <div className="meeting-summary">{String(row.summary || "Sem resumo processado. Abra a reunião para consultar o conteúdo disponível.")}</div>
            <div className="meeting-card-footer">
              {decisions.length > 0 && <span className="meeting-pill">{decisions.length} decisões</span>}
              {commitments.length > 0 && <span className="meeting-pill">{commitments.length} compromissos</span>}
              {people.length > 0 && <span className="meeting-pill">{people.length} participantes</span>}
              <span className="meeting-pill">{Math.round(Number(row.transcript_chars || 0) / 1000)}k chars</span>
            </div>
          </button>;
        })}
      </div>

      {hasMore && <div className="meeting-more"><button className="meetings-btn" disabled={loading} onClick={() => load(false, activeQuery)}>{loading ? "Carregando…" : "Carregar mais"}</button></div>}

      {(detail || detailLoading) && <div className="meeting-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}>
        <aside className="meeting-drawer">
          {detailLoading && !detail ? <div className="meeting-empty">Carregando reunião…</div> : detail && <>
            <div className="meeting-drawer-head">
              <div>
                <div className="meeting-client">{String(detail.client_name_raw || "Cliente")}</div>
                <h2>{cleanTitle(detail)}</h2>
                <div className="meeting-date">{fmtDate(detail.meeting_started_at || detail.created_at)}</div>
              </div>
              <button className="meetings-btn" onClick={() => setDetail(null)}>Fechar</button>
            </div>

            <div className="meeting-section"><h3>Resumo</h3><p>{String(detail.summary || "Sem resumo processado.")}</p></div>

            {participants(detail.participants).length > 0 && <div className="meeting-section"><h3>Participantes</h3><div className="meeting-participants">{participants(detail.participants).map((name, index) => <span className="meeting-participant" key={`${name}-${index}`}>{name}</span>)}</div></div>}

            {asItems(detail.decisions).length > 0 && <div className="meeting-section"><h3>Decisões</h3><ul>{asItems(detail.decisions).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            {asItems(detail.commitments).length > 0 && <div className="meeting-section"><h3>Compromissos</h3><ul>{asItems(detail.commitments).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}

            <div className="meeting-section"><h3>Transcrição</h3><div className="meeting-transcript">{String(detail.transcript_text || "Transcrição completa indisponível para este registro.")}</div></div>
            {detail.source_url && <div className="meeting-section"><a className="meetings-btn" href={String(detail.source_url)} target="_blank" rel="noreferrer">Abrir origem ↗</a></div>}
          </>}
        </aside>
      </div>}
    </section>, document.body)}
  </>;
}
