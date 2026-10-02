"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch, SUPABASE_URL } from "./shared";
import { RelatoPairingCard } from "./relato-pairing-card";

type Row = Record<string, any>;

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meetings-api`;
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

function fmtTimestamp(value: unknown) {
  const total = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0
    ? [hh, mm, ss].map((part) => String(part).padStart(2, "0")).join(":")
    : [mm, ss].map((part) => String(part).padStart(2, "0")).join(":");
}

const STYLE = `
  .meetings-nav-button::before{display:none!important;content:none!important;}
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
  .meetings-toolbar{max-width:1440px;margin:0 auto 10px;display:grid;grid-template-columns:minmax(240px,1fr) auto auto;gap:8px;}
  .meetings-toolbar input{min-width:0;border:1px solid #33414b;background:#10161b;color:#eef5f8;border-radius:10px;padding:10px 12px;outline:none;}
  .meetings-toolbar input:focus{border-color:#76c6ff;box-shadow:0 0 0 2px rgba(118,198,255,.08);}
  .relato-filterbar{max-width:1440px;margin:0 auto 12px;display:grid;grid-template-columns:minmax(210px,1fr) repeat(2,minmax(145px,.45fr)) auto auto;gap:8px;align-items:end;}
  .relato-filterbar label{display:grid;gap:5px;color:#8698a5;font-size:9px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;}
  .relato-filterbar select,.relato-filterbar input{height:38px;border:1px solid #33414b;background:#10161b;color:#e8f0f5;border-radius:10px;padding:0 10px;outline:none;}
  .relato-filterbar .audio-toggle{height:38px;display:flex;align-items:center;gap:8px;border:1px solid #33414b;background:#10161b;border-radius:10px;padding:0 11px;color:#aebbc4;font-size:11px;font-weight:800;white-space:nowrap;text-transform:none;letter-spacing:0;}
  .relato-filterbar .audio-toggle input{width:15px;height:15px;padding:0;}
  .relato-filterbar .clear-filters{height:38px;}
  .relato-self-tabs{max-width:1440px;margin:0 auto 12px;display:flex;gap:7px;flex-wrap:wrap;}
  .relato-self-tabs button{border:1px solid #33414b;background:#10161b;color:#9eacb7;border-radius:999px;padding:7px 11px;font:800 10px Inter,sans-serif;cursor:pointer;}
  .relato-self-tabs button.active{border-color:#ff934f;background:#2b1a11;color:#ffc19a;}
  .relato-pair-wrap{max-width:1440px;margin:0 auto 14px;}
  .relato-record-kind{font-size:9px;font-weight:900;letter-spacing:.09em;text-transform:uppercase;color:#ff9a61;}
  .relato-call-meta{display:flex;gap:7px;flex-wrap:wrap;color:#8f9da8;font-size:10px;}
  .meeting-audio-files{display:grid;gap:8px;margin-top:8px;}
  .meeting-audio-file{border:1px solid #26363f;background:#0a1014;border-radius:10px;padding:9px;display:grid;gap:7px;}
  .meeting-audio-file-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:#9fb0ba;}
  .meeting-audio-file audio{width:100%;height:34px;}
  .meetings-meta{max-width:1440px;margin:0 auto 10px;color:#8f9da8;font-size:11px;display:flex;gap:12px;flex-wrap:wrap;}
  .meetings-grid{max-width:1440px;margin:0 auto;display:grid;gap:8px;}
  .meeting-card{border:1px solid #2b3740;background:linear-gradient(180deg,#12191e,#0f1519);border-radius:14px;padding:14px 16px;text-align:left;color:inherit;cursor:pointer;display:grid;grid-template-columns:minmax(220px,.8fr) minmax(320px,1.7fr) auto;gap:18px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.1);}
  .meeting-card:hover{border-color:#536b7a;background:#151e24;transform:translateY(-1px);}
  .meeting-card-main{min-width:0;display:grid;gap:6px;}
  .meeting-card-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
  .meeting-client{font-size:10px;font-weight:900;letter-spacing:.07em;color:#8fd2ff;text-transform:uppercase;}
  .meeting-date{font-size:10px;color:#82909a;white-space:nowrap;}
  .meeting-title{font:760 15px/1.25 Inter,sans-serif;color:#f1f6f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .meeting-summary{font-size:12px;line-height:1.5;color:#b4c0c8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .meeting-card-side{display:grid;gap:8px;justify-items:end;min-width:150px;}
  .meeting-card-footer{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
  .meeting-pill{font-size:10px;font-weight:800;border:1px solid #33414b;background:#0e1418;border-radius:999px;padding:4px 7px;color:#a9b6bf;}
  .meeting-empty{max-width:1440px;margin:28px auto;border:1px dashed #35434d;border-radius:14px;padding:28px;color:#9baab4;text-align:center;}
  .meeting-more{display:flex;justify-content:center;max-width:1440px;margin:16px auto 0;}
  .meeting-drawer-backdrop{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147482500;background:rgba(0,0,0,.46);display:flex;justify-content:flex-end;}
  .meeting-drawer{width:min(980px,calc(100vw - var(--sidenav-width,224px) - 24px));height:100%;background:#0d1317;border-left:1px solid #33414b;overflow:auto;padding:22px 26px 32px;box-shadow:-18px 0 50px rgba(0,0,0,.35);}
  .meeting-drawer-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;position:sticky;top:-22px;background:#0d1317;padding:22px 0 14px;z-index:4;border-bottom:1px solid #28333a;}
  .meeting-drawer h2{margin:4px 0 4px;font:800 24px/1.15 Inter Tight,Inter,sans-serif;}
  .meeting-detail-tabs{position:sticky;top:73px;z-index:3;display:flex;gap:7px;flex-wrap:wrap;padding:12px 0;background:#0d1317;border-bottom:1px solid #202c33;}
  .meeting-detail-tabs button{border:1px solid #2e3b44;background:#11181d;color:#94a4ae;border-radius:999px;padding:8px 12px;font:800 10px Inter,sans-serif;cursor:pointer;}
  .meeting-detail-tabs button.active{background:#2b1a11;border-color:#ff934f;color:#ffc19a;}
  .meeting-overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px;}
  .meeting-overview-card{border:1px solid #26343c;background:#10171b;border-radius:12px;padding:13px;}
  .meeting-overview-card h3{margin:0 0 8px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#ff9a61;}
  .meeting-overview-card p{margin:0;color:#c4ced4;font-size:12px;line-height:1.6;white-space:pre-wrap;}
  .meeting-participant-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;}
  .meeting-participant-card{border:1px solid #293840;background:#10171b;border-radius:10px;padding:10px 12px;display:grid;gap:3px;}
  .meeting-participant-card b{font-size:12px;color:#eaf2f6}.meeting-participant-card span{font-size:10px;color:#83939e;}
  .meeting-section{margin-top:18px;}
  .meeting-section h3{margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#ff9a61;}
  .meeting-section p,.meeting-section li{color:#bec9d0;font-size:12px;line-height:1.6;}
  .meeting-section ul{margin:0;padding-left:18px;display:grid;gap:5px;}
  .meeting-transcript{white-space:pre-wrap;background:#090d10;border:1px solid #273139;border-radius:11px;padding:14px;max-height:48vh;overflow:auto;color:#aebbc4;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;}
  .meeting-participants{display:flex;gap:6px;flex-wrap:wrap;}
  .meeting-participant{padding:5px 7px;border-radius:8px;background:#141c21;border:1px solid #2b3942;font-size:10px;color:#b9c6ce;}
  .meeting-audio-card{border:1px solid #30414d;background:linear-gradient(180deg,#121b21,#0d1419);border-radius:12px;padding:12px;display:grid;gap:10px;}
  .meeting-audio-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .meeting-audio-status{font-size:10px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#8fd2ff;}
  .meeting-audio-card audio{width:100%;height:40px;}
  .meeting-audio-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
  .meeting-audio-note{font-size:11px;color:#8e9ca6;line-height:1.45;}
  .meeting-transcript-rows{display:grid;gap:7px;max-height:48vh;overflow:auto;background:#090d10;border:1px solid #273139;border-radius:11px;padding:10px;}
  .meeting-transcript-row{display:grid;grid-template-columns:54px minmax(0,1fr);gap:9px;align-items:start;padding:8px;border-radius:8px;background:#0d1418;border:1px solid #1d2930;}
  .meeting-transcript-time{border:0;background:#17232b;color:#8fd2ff;border-radius:7px;padding:5px 6px;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;}
  .meeting-transcript-time:hover{background:#203441;color:#c7eaff;}
  .meeting-transcript-speaker{font-size:10px;font-weight:900;color:#ff9a61;margin-bottom:3px;}
  .meeting-transcript-text{font-size:11px;line-height:1.5;color:#b8c4cb;white-space:pre-wrap;}
  @media(max-width:900px){.relato-filterbar{grid-template-columns:1fr 1fr}.relato-filterbar label:first-child{grid-column:1/-1}.meeting-card{grid-template-columns:1fr;gap:10px}.meeting-card-side{justify-items:start;min-width:0}.meeting-card-footer{justify-content:flex-start}.meeting-overview-grid{grid-template-columns:1fr}}
  @media(max-width:720px){.meetings-shell{left:58px;padding:18px 14px 34px}.meetings-head{flex-direction:column}.meetings-toolbar{grid-template-columns:1fr 1fr}.meetings-toolbar input{grid-column:1/-1}.meeting-drawer-backdrop{left:58px}.meeting-drawer{width:100%;padding:18px 14px 28px}.meeting-detail-tabs{top:66px;overflow-x:auto;flex-wrap:nowrap}.meeting-detail-tabs button{white-space:nowrap}.meeting-transcript-row{grid-template-columns:48px minmax(0,1fr)}}
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
  const [owners, setOwners] = useState<string[]>([]);
  const [canViewTeam, setCanViewTeam] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [audioOnly, setAudioOnly] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "transcript" | "participants" | "actions">("overview");
  const [recordType, setRecordType] = useState<"ALL" | "CALL" | "MEETING">("ALL");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async (reset = true, q = activeQuery) => {
    setLoading(true);
    setError("");
    try {
      const url = new URL(API);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(reset ? 0 : records.length));
      url.searchParams.set("scope", ownerFilter ? "team" : "self");
      if (ownerFilter) url.searchParams.set("owner", ownerFilter);
      if (dateFrom) url.searchParams.set("from", new Date(dateFrom + "T00:00:00").toISOString());
      if (dateTo) url.searchParams.set("to", new Date(dateTo + "T23:59:59").toISOString());
      if (q.trim()) url.searchParams.set("q", q.trim());
      const response = await authenticatedFetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const body = await response.json();
      const next = Array.isArray(body.records) ? body.records : [];
      setRecords((current) => reset ? next : [...current, ...next]);
      setCount(Number(body.count || 0));
      setHasMore(Boolean(body.has_more));
      if (Array.isArray(body.owners)) setOwners(body.owners.map((value: unknown) => String(value)).filter(Boolean));
      setCanViewTeam(Boolean(body.policy?.can_view_team));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar as reuniões.");
    } finally {
      setLoading(false);
    }
  }, [activeQuery, records.length, ownerFilter, dateFrom, dateTo]);

  useEffect(() => {
    if (!open || records.length || loading) return;
    load(true, activeQuery);
  }, [open, records.length, loading, load, activeQuery]);

  useEffect(() => {
    let observer: MutationObserver | null = null;
    let cleanupButton: (() => void) | null = null;

    const ensureButton = () => {
      const container = document.querySelector<HTMLElement>(".side-nav-items, .lc-sidebar nav, .sdr-sidebar nav");
      if (!container) return;
      let button = container.querySelector<HTMLButtonElement>("[data-meetings-nav]");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.meetingsNav = "true";
        button.className = "meetings-nav-button";
        button.title = "Relato AI";
        button.setAttribute("aria-label", "Relato AI");
        button.textContent = "Relato AI";
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
      const target = event.target instanceof Element ? event.target.closest(".side-nav-items > button,.side-nav-items > a,.lc-sidebar nav > button,.sdr-sidebar nav > button") : null;
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
    setDetailTab("overview");
    setDetailLoading(true);
    setDetail(null);
    try {
      const url = new URL(API);
      url.searchParams.set("transcript_id", String(row.id));
      url.searchParams.set("scope", ownerFilter ? "team" : "self");
      const response = await authenticatedFetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const body = await response.json();
      setDetail({ ...(body.transcript || row), _segments: Array.isArray(body.segments) ? body.segments : [], _audio: body.audio || null, _audio_files: Array.isArray(body.audio_files) ? body.audio_files : [] });
    } catch {
      setDetail(row);
    } finally {
      setDetailLoading(false);
    }
  };

  const seekAudio = (startedMs: unknown) => {
    const audio = audioRef.current;
    if (!audio || !detail?._audio?.signed_url) return;
    audio.currentTime = Math.max(0, Number(startedMs || 0) / 1000);
    void audio.play().catch(() => {});
  };

  const visibleRecords = useMemo(() => records.filter((row) =>
    (recordType === "ALL" || String(row.record_type || "MEETING").toUpperCase() === recordType)
    && (!audioOnly || Boolean(row.has_audio))
  ), [records, recordType, audioOnly]);
  const totalChars = useMemo(() => visibleRecords.reduce((sum, row) => sum + Number(row.transcript_chars || 0), 0), [visibleRecords]);
  const callCount = useMemo(() => records.filter((row) => String(row.record_type || "").toUpperCase() === "CALL").length, [records]);
  const meetingCount = useMemo(() => records.filter((row) => String(row.record_type || "MEETING").toUpperCase() === "MEETING").length, [records]);

  if (typeof document === "undefined") return <style dangerouslySetInnerHTML={{ __html: STYLE }} />;

  return <>
    <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    {open && createPortal(<section className="meetings-shell" aria-label="Relato AI">
      <div className="meetings-head">
        <div>
          <div className="meetings-kicker">Relato AI · Meu histórico</div>
          <h1>Minhas calls e reuniões</h1>
          <div className="meetings-sub">Somente registros gravados no seu próprio perfil. Consulte transcrição, gravação, download, decisões e participantes sem acessar o histórico de outros colaboradores.</div>
        </div>
        <div className="meetings-actions">
          <button className="meetings-btn" onClick={() => load(true, activeQuery)} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
          <button className="meetings-btn" onClick={() => setOpen(false)}>Fechar</button>
        </div>
      </div>

      <div className="relato-pair-wrap"><RelatoPairingCard /></div>
      <div className="relato-self-tabs">
        <button type="button" className={recordType === "ALL" ? "active" : ""} onClick={() => setRecordType("ALL")}>Tudo · {records.length}</button>
        <button type="button" className={recordType === "CALL" ? "active" : ""} onClick={() => setRecordType("CALL")}>Ligações · {callCount}</button>
        <button type="button" className={recordType === "MEETING" ? "active" : ""} onClick={() => setRecordType("MEETING")}>Reuniões · {meetingCount}</button>
      </div>

      <form className="meetings-toolbar" onSubmit={submitSearch}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar contato, cliente, título ou resumo" />
        <button className="meetings-btn primary" type="submit">Buscar</button>
        {(activeQuery || query) && <button className="meetings-btn" type="button" onClick={() => { setQuery(""); setActiveQuery(""); setRecords([]); load(true, ""); }}>Limpar</button>}
      </form>

      {canViewTeam && <div className="relato-filterbar">
        <label>Colaborador
          <select value={ownerFilter} onChange={(event) => { setOwnerFilter(event.target.value); setRecords([]); }}>
            <option value="">Meu histórico</option>
            {owners.filter((name) => name !== "Adler Furtado").map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>De
          <input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setRecords([]); }} />
        </label>
        <label>Até
          <input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setRecords([]); }} />
        </label>
        <label className="audio-toggle"><input type="checkbox" checked={audioOnly} onChange={(event) => setAudioOnly(event.target.checked)} />Só com áudio</label>
        <button className="meetings-btn clear-filters" type="button" onClick={() => { setOwnerFilter(""); setDateFrom(""); setDateTo(""); setAudioOnly(false); setRecordType("ALL"); setQuery(""); setActiveQuery(""); setRecords([]); }}>Limpar filtros</button>
      </div>}

      <div className="meetings-meta">
        <span>{count} registros pessoais encontrados</span>
        <span>{visibleRecords.length} exibidos · {records.length} carregados</span>
        <span>{Math.round(totalChars / 1000)} mil caracteres referenciados sem carregar transcript</span>
        <span>Sem polling automático</span>
      </div>

      {error && <div className="meeting-empty">{error}</div>}
      {!error && !loading && !records.length && <div className="meeting-empty">Nenhuma call ou reunião encontrada no seu perfil.</div>}
      {!error && !loading && records.length > 0 && !visibleRecords.length && <div className="meeting-empty">Nenhum registro desse tipo foi encontrado.</div>}

      <div className="meetings-grid">
        {visibleRecords.map((row) => {
          const decisions = asItems(row.decisions);
          const commitments = asItems(row.commitments);
          const people = participants(row.participants);
          const isCall = String(row.record_type || "").toUpperCase() === "CALL";
          const callLabel = String(row.contact_name || row.remote_phone || row.client_name_raw || "Contato não identificado");
          return <button className="meeting-card" key={String(row.id)} onClick={() => openDetail(row)}>
            <div className="meeting-card-main">
              <div className="meeting-card-top">
                <span className="relato-record-kind">{isCall ? "Ligação" : "Reunião"}</span>
                <span className="meeting-date">{fmtDate(row.meeting_started_at || row.created_at)}</span>
              </div>
              <div className="meeting-client">{isCall ? callLabel : String(row.client_name_raw || "Cliente não vinculado")}</div>
              <div className="meeting-title">{isCall ? callLabel : cleanTitle(row)}</div>
              {isCall && <div className="relato-call-meta"><span>{Number(row.duration_seconds || 0) ? fmtTimestamp(Number(row.duration_seconds || 0) * 1000) : "Duração não informada"}</span><span>{row.has_audio ? "Gravação disponível" : "Sem áudio"}</span></div>}
            </div>
            <div className="meeting-summary">{String(row.summary || (isCall ? "Abra a ligação para consultar o resumo, transcrição e gravação completa." : "Abra a reunião para consultar resumo, participantes, decisões e transcrição completa."))}</div>
            <div className="meeting-card-side">
              <div className="meeting-card-footer">
                {people.length > 0 && <span className="meeting-pill">{people.length} participantes</span>}
                {decisions.length > 0 && <span className="meeting-pill">{decisions.length} decisões</span>}
                {commitments.length > 0 && <span className="meeting-pill">{commitments.length} ações</span>}
                <span className="meeting-pill">{Math.max(0, Math.round(Number(row.transcript_chars || 0) / 1000))}k chars</span>
              </div>
              <span className="meetings-btn">Abrir completo →</span>
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
                <div className="meeting-client">{String(detail.record_type || "").toUpperCase() === "CALL" ? String(detail.contact_name || detail.remote_phone || "Ligação") : String(detail.client_name_raw || "Cliente")}</div>
                <h2>{String(detail.record_type || "").toUpperCase() === "CALL" ? String(detail.contact_name || detail.remote_phone || cleanTitle(detail)) : cleanTitle(detail)}</h2>
                <div className="meeting-date">{fmtDate(detail.meeting_started_at || detail.created_at)}</div>
              </div>
              <button className="meetings-btn" onClick={() => setDetail(null)}>Fechar</button>
            </div>

            <div className="meeting-detail-tabs">
              <button type="button" className={detailTab === "overview" ? "active" : ""} onClick={() => setDetailTab("overview")}>Resumo</button>
              <button type="button" className={detailTab === "transcript" ? "active" : ""} onClick={() => setDetailTab("transcript")}>Transcrição completa</button>
              <button type="button" className={detailTab === "participants" ? "active" : ""} onClick={() => setDetailTab("participants")}>Participantes · {participants(detail.participants).length}</button>
              <button type="button" className={detailTab === "actions" ? "active" : ""} onClick={() => setDetailTab("actions")}>Decisões & ações</button>
            </div>

            {detailTab === "overview" && <>
              <div className="meeting-overview-grid">
                <div className="meeting-overview-card"><h3>Resumo da conversa</h3><p>{String(detail.summary || "Sem resumo processado.")}</p></div>
                <div className="meeting-overview-card"><h3>Quem participou</h3><p>{participants(detail.participants).length ? participants(detail.participants).join(" · ") : "Participantes não identificados."}</p></div>
                <div className="meeting-overview-card"><h3>Decisões</h3><p>{asItems(detail.decisions).length ? asItems(detail.decisions).join("\n• ") : "Nenhuma decisão registrada."}</p></div>
                <div className="meeting-overview-card"><h3>Próximas ações</h3><p>{asItems(detail.commitments).length ? asItems(detail.commitments).join("\n• ") : "Nenhuma ação registrada."}</p></div>
              </div>

              <div className="meeting-section">
                <h3>Gravação</h3>
                <div className="meeting-audio-card">
                  <div className="meeting-audio-head">
                    <span className="meeting-audio-status">
                      {detail._audio?.audio_status === "READY" ? "Áudio pronto" : detail._audio?.audio_status ? `Áudio · ${detail._audio.audio_status}` : "Sem gravação"}
                    </span>
                    {detail._audio?.audio_source && <span className="meeting-pill">{String(detail._audio.audio_source)}</span>}
                  </div>
                  {detail._audio?.signed_url ? <>
                    <audio ref={audioRef} controls preload="metadata" src={String(detail._audio.signed_url)} />
                    <div className="meeting-audio-actions">
                      <a className="meetings-btn" href={String(detail._audio.download_url || detail._audio.signed_url)} download={String(detail._audio.download_name || "relato-audio")}>Baixar áudio</a>
                      {Number(detail._audio.audio_duration_ms || 0) > 0 && <span className="meeting-audio-note">Duração {fmtTimestamp(detail._audio.audio_duration_ms)}</span>}
                    </div>
                    {Array.isArray(detail._audio_files) && detail._audio_files.length > 1 && <div className="meeting-audio-files">{detail._audio_files.map((file: Row) => <div className="meeting-audio-file" key={String(file.role)}>
                      <div className="meeting-audio-file-head"><b>{file.role === "mixed" ? "Gravação completa" : file.role === "remote" ? "Outro lado" : "Minha voz"}</b><a className="meetings-btn" href={String(file.download_url || file.signed_url)} download={String(file.download_name || "relato-audio")}>Baixar</a></div>
                      <audio controls preload="metadata" src={String(file.play_url || file.signed_url || "")} />
                    </div>)}</div>}
                  </> : <div className="meeting-audio-note">
                    {detail._audio?.audio_status === "PROCESSING" || detail._audio?.audio_status === "STORED" || detail._audio?.audio_status === "UPLOADING"
                      ? "A gravação foi preservada e ainda está sendo preparada para reprodução."
                      : detail._audio?.audio_last_error
                        ? `Gravação preservada, mas o processamento precisa de retry: ${String(detail._audio.audio_last_error)}`
                        : "Este registro ainda não possui um arquivo de áudio reproduzível."}
                  </div>}
                </div>
              </div>
            </>}

            {detailTab === "transcript" && <div className="meeting-section"><h3>Conversa por inteiro</h3>
              {Array.isArray(detail._segments) && detail._segments.length > 0
                ? <div className="meeting-transcript-rows">{detail._segments.map((segment: Row, index: number) => <div className="meeting-transcript-row" key={String(segment.sequence_no ?? index)}>
                    <button className="meeting-transcript-time" type="button" title={detail._audio?.signed_url ? "Ouvir deste ponto" : "Timestamp"} onClick={() => seekAudio(segment.started_ms)}>{fmtTimestamp(segment.started_ms)}</button>
                    <div>
                      <div className="meeting-transcript-speaker">{String(segment.speaker_name || "Participante")}</div>
                      <div className="meeting-transcript-text">{String(segment.text || "")}</div>
                    </div>
                  </div>)}</div>
                : <div className="meeting-transcript">{String(detail.transcript_text || "Transcrição completa indisponível para este registro.")}</div>}
            </div>}

            {detailTab === "participants" && <div className="meeting-section"><h3>Participantes</h3>
              {participants(detail.participants).length
                ? <div className="meeting-participant-list">{participants(detail.participants).map((name, index) => <div className="meeting-participant-card" key={`${name}-${index}`}><b>{name}</b><span>Participante da conversa</span></div>)}</div>
                : <div className="meeting-empty">Nenhum participante identificado neste registro.</div>}
            </div>}

            {detailTab === "actions" && <>
              <div className="meeting-section"><h3>Decisões</h3>{asItems(detail.decisions).length ? <ul>{asItems(detail.decisions).map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Nenhuma decisão registrada.</p>}</div>
              <div className="meeting-section"><h3>Próximas ações / compromissos</h3>{asItems(detail.commitments).length ? <ul>{asItems(detail.commitments).map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>Nenhuma ação registrada.</p>}</div>
            </>}

            {detail.source_url && <div className="meeting-section"><a className="meetings-btn" href={String(detail.source_url)} target="_blank" rel="noreferrer">Abrir origem ↗</a></div>}
          </>}
        </aside>
      </div>}
    </section>, document.body)}
  </>;
}
