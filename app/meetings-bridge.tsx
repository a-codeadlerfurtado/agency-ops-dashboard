"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;
type FilterTab = "status" | "people" | "period";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meetings-api`;
const CAPTURE_API = `${SUPABASE_URL}/functions/v1/agency-ops-meeting-capture-api`;
const PAGE_SIZE = 30;

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

function participants(value: unknown) { return asItems(value).slice(0, 16); }
function cleanTitle(row: Row) {
  const fromMeta = String(row?.metadata?.subject || row?.metadata?.title || "").trim();
  if (fromMeta) return fromMeta;
  const raw = String(row?.source_file_name || row?.meeting_code || "Reunião").trim();
  return raw.replace(/\.(txt|md|json)$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Reunião";
}
function when(row: Row) { return new Date(String(row.meeting_started_at || row.created_at || 0)); }
function dayKey(row: Row) { const d = when(row); return Number.isNaN(d.getTime()) ? "Sem data" : d.toISOString().slice(0, 10); }
function dayLabel(row: Row) {
  const d = when(row); if (Number.isNaN(d.getTime())) return "SEM DATA";
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", month: "long", day: "numeric" }).format(d).toUpperCase();
}
function timeLabel(value: unknown) {
  const d = new Date(String(value || 0));
  return Number.isNaN(d.getTime()) ? "--:--" : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(d);
}
function shortDate(value: unknown) {
  const d = new Date(String(value || 0));
  return Number.isNaN(d.getTime()) ? "Sem data" : new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(d);
}
function durationLabel(row: Row) {
  let sec = Number(row.duration_seconds || 0);
  if (!sec && row.meeting_started_at && row.meeting_ended_at) sec = Math.max(0, Math.round((Date.parse(row.meeting_ended_at) - Date.parse(row.meeting_started_at)) / 1000));
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${m}min` : `${m}min ${s}s`;
}
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?"; }
function ready(row: Row) { return String(row.processing_status || "").toUpperCase() === "READY" || (!row.processing_status && Boolean(row.summary)); }
function parseLegacyTranscript(text: unknown): Row[] {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const blocks = raw.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  return blocks.map((block, index) => {
    const m = block.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*([^:]{1,120}):\s*([\s\S]*)$/);
    if (!m) return { sequence_no: index, speaker_name: "Transcrição", text: block, started_ms: 0 };
    const [h, min, sec] = m[1].split(":").map(Number);
    return { sequence_no: index, speaker_name: m[2].trim(), text: m[3].trim(), started_ms: ((h * 3600) + (min * 60) + sec) * 1000 };
  });
}
function stamp(ms: unknown) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0"), m = String(Math.floor((total % 3600) / 60)).padStart(2, "0"), s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function signalGroups(detail: Row) {
  const raw = detail?.ai_signals && typeof detail.ai_signals === "object" ? detail.ai_signals : {};
  const highlights = raw.highlights && typeof raw.highlights === "object" && !Array.isArray(raw.highlights) ? raw.highlights : raw;
  const defs = [["Oportunidades", "*", highlights.opportunities || raw.opportunities],["Insights", "!", highlights.insights || raw.insights],["Ideias", "+", highlights.ideas || raw.ideas],["Objetivos", "o", highlights.objectives || raw.objectives],["Problemas atuais", "!", highlights.problems || raw.problems],["Licoes aprendidas", "v", highlights.lessons || raw.lessons]];
  return defs.map(([name, icon, value]) => ({ name, icon, items: asItems(value) })).filter((group) => group.items.length);
}
function topicRows(detail: Row) {
  const raw = detail?.ai_signals?.summary_topics || detail?.metadata?.summary_topics || [];
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((item: any) => typeof item === "string" ? { title: item.split(/[.:\-]/)[0] || "Topico", body: item } : { title: String(item?.title || item?.name || "Topico"), body: String(item?.body || item?.text || item?.description || item?.title || "") }).filter((item: any) => item.body);
}
function actionRows(detail: Row) {
  const raw = Array.isArray(detail?.ai_signals?.action_items) ? detail.ai_signals.action_items : [];
  if (raw.length) return raw.map((item: any) => ({ title: String(item?.title || item?.text || item || ""), owner: String(item?.owner || ""), due_date: String(item?.due_date || ""), evidence: String(item?.evidence || "") })).filter((item: any) => item.title);
  return [...asItems(detail?.commitments), ...asItems(detail?.decisions).slice(0,3)].map((title) => ({ title, owner: "", due_date: "", evidence: "" }));
}
function rewrittenRows(detail: Row) {
  const raw = Array.isArray(detail?.ai_signals?.rewritten_notes) ? detail.ai_signals.rewritten_notes : [];
  return raw.map((item: any) => ({ speaker: String(item?.speaker || "Participante"), timestamp: String(item?.timestamp || "00:00:00"), original: String(item?.original || ""), rewritten: String(item?.rewritten || "") })).filter((item: any) => item.original || item.rewritten);
}


const STYLE = `
.meetings-nav-button::before{content:""!important;width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;background:currentColor!important;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2' fill='none' stroke='black' stroke-width='1.8'/%3E%3Cpath d='M7 3v4M17 3v4M3.5 9h17' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2' fill='none' stroke='black' stroke-width='1.8'/%3E%3Cpath d='M7 3v4M17 3v4M3.5 9h17' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") center/contain no-repeat!important}.meetings-nav-button{display:flex!important;align-items:center!important;gap:12px!important}
.meetings-app{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147481500;background:#050505;color:#f1f5f9;overflow:auto;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.meetings-inner{max-width:1440px;margin:0 auto;padding:24px 28px 54px}.meetings-top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:18px}.meetings-top h1{margin:0;font-size:20px;font-weight:500}.meetings-actions{display:flex;align-items:center;gap:8px}.m-btn{border:1px solid #3f3f46;background:#18181b;color:#e4e4e7;border-radius:8px;padding:8px 11px;font:600 12px/1 system-ui;cursor:pointer}.m-btn:hover{background:#27272a;border-color:#52525b}.m-btn.primary{background:#4f46e5;border-color:#4f46e5;color:white}.m-btn.icon{width:34px;height:34px;border-radius:999px;padding:0;font-size:17px}.m-searchrow{display:flex;gap:10px;align-items:center;margin-bottom:16px;position:relative}.m-search{height:38px;width:min(430px,60vw);border-radius:999px;border:1px solid #52525b;background:#09090b;color:#f1f5f9;padding:0 14px 0 39px;outline:none;font-size:12px}.m-search:focus{border-color:#6366f1}.m-searchwrap{position:relative}.m-searchwrap::before{content:"⌕";position:absolute;left:14px;top:8px;color:#94a3b8;font-size:18px;z-index:1}.m-filterbtn{height:38px;border:0;border-radius:999px;background:#27272a;color:#e4e4e7;padding:0 14px;font-weight:600;cursor:pointer}.m-filterpop{position:absolute;top:45px;left:440px;width:360px;background:#111113;border:1px solid #33333a;border-radius:12px;box-shadow:0 20px 55px rgba(0,0,0,.45);z-index:20;overflow:hidden}.m-filtertabs{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #29292e}.m-filtertabs button{border:0;background:transparent;color:#94a3b8;padding:11px 8px;cursor:pointer;font-size:11px}.m-filtertabs button.active{color:white;border-bottom:2px solid #6366f1}.m-filterbody{padding:13px;display:grid;gap:8px;max-height:270px;overflow:auto}.m-choice{display:flex;align-items:center;gap:9px;padding:8px;border-radius:8px;color:#cbd5e1;font-size:12px;cursor:pointer}.m-choice:hover{background:#1d1d20}.m-choice input{accent-color:#4f46e5}.m-pair{margin-bottom:16px;padding:12px 14px;border:1px solid #3730a3;background:#11102a;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:12px}.m-pair strong{font:800 18px ui-monospace,monospace;letter-spacing:.14em;color:#a5b4fc}.m-pair small{display:block;color:#94a3b8;margin-top:3px}.m-chiprow{display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 14px}.m-chip{border:1px solid #3f3f46;border-radius:999px;padding:4px 8px;color:#cbd5e1;font-size:10px;background:#111113}.m-timeline{position:relative;border-radius:8px;background:#171719;padding:0 18px 4px}.m-day{position:relative;padding:17px 0 3px 18px;border-left:2px solid #3f3f46}.m-day::before{content:"";position:absolute;left:-6px;top:21px;width:10px;height:10px;border-radius:50%;background:#64748b}.m-daytitle{color:#94a3b8;font-size:11px;letter-spacing:.04em;margin:0 0 8px}.m-feedcard{width:100%;border:0;border-bottom:1px solid #29292e;background:transparent;color:inherit;padding:10px 6px;text-align:left;display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px;cursor:pointer;border-radius:7px}.m-feedcard:hover{background:rgba(255,255,255,.03)}.m-feedicon{width:34px;height:34px;border-radius:50%;background:linear-gradient(145deg,#4c1d95,#6d28d9);display:grid;place-items:center;color:#d8b4fe;font-size:15px}.m-feedtitleline{display:flex;gap:8px;align-items:center;min-width:0}.m-feedtitle{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.m-summary{color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.m-meta{display:flex;gap:13px;align-items:center;color:#94a3b8;font-size:10.5px;margin-top:7px}.m-avatars{display:flex;margin-left:4px}.m-avatar{width:24px;height:24px;margin-left:-6px;border-radius:50%;display:grid;place-items:center;background:#1e3a5f;border:1px solid #171719;font-size:9px;font-weight:800}.m-status{align-self:center;display:flex;gap:8px;align-items:center;color:#94a3b8;font-size:15px}.m-status .ok{color:#4ade80}.m-status .wait{color:#eab308}.m-owner{font-size:9px;color:#818cf8;border:1px solid #3730a3;border-radius:999px;padding:2px 6px}.m-empty{padding:60px 20px;text-align:center;color:#94a3b8}.m-skeleton{height:76px;margin:4px 0;border-radius:8px;background:linear-gradient(90deg,#202024,#29292e,#202024);background-size:200% 100%;animation:mshimmer 1.2s linear infinite}@keyframes mshimmer{to{background-position:-200% 0}}
.m-detailhead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.m-breadcrumb{color:#94a3b8;cursor:pointer}.m-detailtitle{font-size:20px;font-weight:500;margin:0}.m-tag{display:inline-flex;align-items:center;gap:5px;background:#2e1065;color:#c4b5fd;border-radius:999px;padding:3px 7px;font-size:10px;margin-left:7px}.m-ready{color:#4ade80;margin-left:7px}.m-card{background:#18181b;border:1px solid #232329;border-radius:8px;padding:13px}.m-participantline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#cbd5e1;font-size:11px}.m-detailmeta{display:flex;gap:14px;color:#94a3b8;font-size:10.5px;margin-top:9px}.m-section{margin-top:22px}.m-sectiontitle{font-size:15px;font-weight:500;margin:0 0 9px;display:flex;align-items:center;gap:7px}.m-detailgrid{display:grid;grid-template-columns:minmax(0,60fr) minmax(300px,40fr);gap:18px}.m-action{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:center;border:1px solid #29292e;border-radius:8px;padding:11px;margin-top:7px;background:#18181b}.m-follow{border:1px dashed #52525b;border-radius:999px;background:#27272a;color:#e4e4e7;padding:8px;font-size:10px}.m-actiontext{font-size:12px;color:#f1f5f9}.m-context{color:#94a3b8;font-size:10.5px;margin-top:4px}.m-highlightgroup{margin-bottom:11px}.m-highlightgroup h4{margin:0 0 7px;font-size:11px;color:#e2e8f0}.m-highlight{background:#18181b;border:1px solid #29292e;border-radius:8px;padding:10px;margin-bottom:6px}.m-highlight strong{display:block;font-size:11px}.m-highlight p{margin:5px 0 0;color:#94a3b8;font-size:10.5px}.m-topic{padding:9px 0;border-bottom:1px solid #29292e}.m-topic strong{font-size:11px}.m-topic p{margin:3px 0;color:#94a3b8;font-size:10.5px}.m-mind{display:grid;grid-template-columns:90px 1fr;gap:10px;align-items:center;min-height:130px}.m-mindroot{background:#4f46e5;border-radius:8px;padding:12px;text-align:center;font-weight:700;font-size:11px}.m-mindnodes{display:grid;gap:6px}.m-mindnode{border-left:3px solid #6366f1;background:#18181b;border-radius:6px;padding:8px;font-size:10.5px}.m-accordion{border:1px solid #29292e;background:#18181b;border-radius:8px;overflow:hidden}.m-accrow{padding:14px;border-bottom:1px solid #29292e;color:#cbd5e1;font-size:12px}.m-transcriptbody{padding:12px 14px 18px}.m-transcripttoolbar{display:flex;justify-content:space-between;gap:10px;margin-bottom:14px}.m-transcriptsearch{width:min(400px,70%);border:1px solid #52525b;background:#09090b;color:white;border-radius:999px;padding:8px 12px}.m-keywords{color:#94a3b8;font-size:10.5px;margin-bottom:13px}.m-transcriptscroll{max-height:55vh;overflow:auto;border-top:1px solid #29292e;padding:6px 18px 18px}.m-transcriptblock{padding:12px 0}.m-transcriptwho{font-size:13.3px;font-weight:600}.m-transcripttime{font-size:10.5px;color:rgba(120,120,120,.8);margin-left:8px}.m-transcripttext{font-size:12.25px;line-height:1.55;color:#f1f5f9;white-space:pre-wrap;margin:4px 0 0}.m-more{display:flex;justify-content:center;padding:15px}
.m-contextbox{border:1px solid #29292e;background:#18181b;border-radius:8px;overflow:hidden}.m-contexthead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;border-bottom:1px solid #29292e}.m-contextclient{display:flex;align-items:center;gap:8px;font-size:12px}.m-contextbody{padding:12px 13px;display:grid;gap:12px}.m-contextlabel{font-size:9px;letter-spacing:.08em;color:#94a3b8;text-transform:uppercase}.m-briefing{font-size:11.5px;color:#e2e8f0;line-height:1.55}.m-attention{border-left:3px solid #8b5cf6;padding-left:10px;color:#cbd5e1;font-size:10.5px}.m-note{border-left:3px solid #eab308;padding:8px 10px;background:#151515;border-radius:0 6px 6px 0}.m-note strong{font-size:10.5px}.m-note p{margin:4px 0 0;color:#94a3b8;font-size:10.5px}.m-ctxactions{display:flex;gap:7px;flex-wrap:wrap}.m-mini{border:0;background:transparent;color:#94a3b8;font-size:10px;cursor:pointer;padding:2px}.m-mini:hover{color:#fff}.m-rewritecard{border:1px solid #29292e;border-radius:8px;padding:11px 12px;margin:8px 0;background:#151517}.m-rewritehead{display:flex;align-items:center;gap:8px;font-size:10.5px;color:#60a5fa}.m-rewriteorig{font-style:italic;color:#94a3b8;font-size:11px;line-height:1.55;margin:9px 0;padding-bottom:9px;border-bottom:1px solid #29292e}.m-rewritenew{color:#e2e8f0;font-size:11.5px;line-height:1.55}.m-feedback{font-size:9.5px;color:#71717a;margin-left:auto}.m-accbutton{width:100%;border:0;background:transparent;color:#cbd5e1;text-align:left;padding:14px;cursor:pointer;font:inherit}.m-accpanel{padding:0 14px 14px}.m-filterfooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid #29292e;padding:10px 12px}.m-filterfooter .clear{margin-right:auto}.m-clientstats{display:flex;gap:8px;flex-wrap:wrap}.m-clientstat{border:1px solid #29292e;border-radius:999px;padding:3px 7px;color:#94a3b8;font-size:9.5px}
@media(max-width:900px){.meetings-app{left:58px}.meetings-inner{padding:18px 14px 80px}.m-detailgrid{grid-template-columns:1fr}.m-filterpop{left:0;width:min(360px,90vw)}.m-feedcard{grid-template-columns:34px minmax(0,1fr)}.m-status{grid-column:2}.m-summary{white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.m-action{grid-template-columns:1fr}.m-follow{width:100%}.m-search{width:min(64vw,430px)}}
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
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>("status");
  const [statusFilter, setStatusFilter] = useState("all");
  const [peopleFilter, setPeopleFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(true);

  const load = useCallback(async (reset = true, q = activeQuery) => {
    setLoading(true); setError("");
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
      setCount(Number(body.count || 0)); setHasMore(Boolean(body.has_more));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível carregar as reuniões."); }
    finally { setLoading(false); }
  }, [activeQuery, records.length]);

  useEffect(() => { if (open && !records.length && !loading) load(true, activeQuery); }, [open, records.length, loading, load, activeQuery]);

  useEffect(() => {
    let observer: MutationObserver | null = null; let cleanupButton: (() => void) | null = null;
    const ensureButton = () => {
      const container = document.querySelector<HTMLElement>(".side-nav-items"); if (!container) return;
      let button = container.querySelector<HTMLButtonElement>("[data-meetings-nav]");
      if (!button) { button = document.createElement("button"); button.type = "button"; button.dataset.meetingsNav = "true"; button.className = "meetings-nav-button"; button.title = "Relato AI"; button.setAttribute("aria-label", "Relato AI"); button.textContent = "Relato AI"; container.appendChild(button); }
      button.classList.toggle("active", open);
      const onClick = (event: Event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); };
      button.addEventListener("click", onClick); cleanupButton?.(); cleanupButton = () => button?.removeEventListener("click", onClick);
      observer?.disconnect(); observer = new MutationObserver(() => { if (!document.querySelector("[data-meetings-nav]")) ensureButton(); }); observer.observe(container, { childList: true });
    };
    ensureButton(); const startup = window.setInterval(() => document.querySelector("[data-meetings-nav]") ? window.clearInterval(startup) : ensureButton(), 250); const stop = window.setTimeout(() => window.clearInterval(startup), 5000);
    const closeOnOtherNav = (event: Event) => { if (!open) return; const target = event.target instanceof Element ? event.target.closest(".side-nav-items > button,.side-nav-items > a") : null; if (target && !target.hasAttribute("data-meetings-nav") && !target.classList.contains("sidebar-ia-group-title")) setOpen(false); };
    document.addEventListener("click", closeOnOtherNav, true);
    return () => { cleanupButton?.(); observer?.disconnect(); clearInterval(startup); clearTimeout(stop); document.removeEventListener("click", closeOnOtherNav, true); document.querySelector("[data-meetings-nav]")?.remove(); };
  }, [open]);

  useEffect(() => {
    if (!open) return; const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") detail ? setDetail(null) : setOpen(false); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [open, detail]);

  const submitSearch = (event: FormEvent) => { event.preventDefault(); const next = query.trim(); setActiveQuery(next); setRecords([]); setDetail(null); load(true, next); };
  const openDetail = async (row: Row) => {
    setDetailLoading(true); setTranscriptQuery("");
    try { const url = new URL(API); url.searchParams.set("transcript_id", String(row.id)); const response = await authenticatedFetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`API ${response.status}`); const body = await response.json(); setDetail(body.transcript || row); }
    catch { setDetail(row); } finally { setDetailLoading(false); }
  };
  const createPairing = async () => {
    setPairingLoading(true); setError("");
    try { const response = await authenticatedFetch(CAPTURE_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pair_create" }), cache: "no-store" }); const body = await response.json(); if (!response.ok || !body?.code) throw new Error(body?.error || `API ${response.status}`); setPairingCode(String(body.code)); setPairingExpires(String(body.expires_at || "")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível gerar o código da extensão."); } finally { setPairingLoading(false); }
  };

  const people = useMemo(() => [...new Set(records.flatMap((row) => [...participants(row.participants), String(row.owner_person || "")]).filter(Boolean))].sort(), [records]);
  const filtered = useMemo(() => records.filter((row) => {
    if (statusFilter === "ready" && !ready(row)) return false;
    if (statusFilter === "waiting" && ready(row)) return false;
    if (statusFilter === "calendar" && !row?.metadata?.calendar_event_id) return false;
    if (statusFilter === "crm" && !row.client_id) return false;
    if (peopleFilter && ![...participants(row.participants), String(row.owner_person || "")].some((name) => name === peopleFilter)) return false;
    if (periodFilter !== "all") {
      const d = when(row); if (Number.isNaN(d.getTime())) return false; const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const age = start.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (periodFilter === "today" && age !== 0) return false;
      if (periodFilter === "yesterday" && age !== 86400000) return false;
      if (periodFilter === "7" && (age < 0 || age > 6 * 86400000)) return false;
      if (periodFilter === "30" && (age < 0 || age > 29 * 86400000)) return false;
    }
    return true;
  }), [records, statusFilter, peopleFilter, periodFilter]);
  const grouped = useMemo(() => { const map = new Map<string, Row[]>(); for (const row of filtered) { const key = dayKey(row); if (!map.has(key)) map.set(key, []); map.get(key)!.push(row); } return [...map.values()]; }, [filtered]);
  const activeFilterCount = Number(statusFilter !== "all") + Number(Boolean(peopleFilter)) + Number(periodFilter !== "all");

  const detailSegments = useMemo(() => detail ? (Array.isArray(detail.segments) && detail.segments.length ? detail.segments : parseLegacyTranscript(detail.transcript_text)) : [], [detail]);
  const shownSegments = useMemo(() => { const q = transcriptQuery.trim().toLocaleLowerCase("pt-BR"); return q ? detailSegments.filter((segment) => `${segment.speaker_name || ""} ${segment.text || ""}`.toLocaleLowerCase("pt-BR").includes(q)) : detailSegments; }, [detailSegments, transcriptQuery]);
  const detailActions = detail ? actionRows(detail) : [];
  const detailSignals = detail ? signalGroups(detail) : [];
  const topics = detail ? topicRows(detail).slice(0, 8) : [];
  const keywords = detail ? asItems(detail?.ai_signals?.keywords || detail?.metadata?.keywords).slice(0, 20) : [];
  const rewritten = detail ? rewrittenRows(detail) : [];
  const clientContext = detail?.client_context || null;
  const dossier = clientContext?.dossier || null;
  const clientNotes = Array.isArray(clientContext?.notes) ? clientContext.notes : [];
  const briefings = Array.isArray(clientContext?.briefings) ? clientContext.briefings : [];

  if (typeof document === "undefined") return <style dangerouslySetInnerHTML={{ __html: STYLE }} />;
  return <><style dangerouslySetInnerHTML={{ __html: STYLE }} />{open && createPortal(<section className="meetings-app" aria-label="Relato AI — Transcriber"><div className="meetings-inner">
    {!detail && <>
      <div className="meetings-top"><h1>Relato AI — Transcriber</h1><div className="meetings-actions"><button className="m-btn primary" onClick={createPairing} disabled={pairingLoading}>{pairingLoading ? "Gerando…" : "Conectar captura"}</button><button className="m-btn" onClick={() => load(true, activeQuery)} disabled={loading}>Atualizar</button><button className="m-btn icon" onClick={() => setOpen(false)}>×</button></div></div>
      {pairingCode && <div className="m-pair"><div><strong>{pairingCode}</strong><small>Digite este código no Relato AI — Transcriber. {pairingExpires ? `Expira ${new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" }).format(new Date(pairingExpires))}.` : "Expira em 15 minutos."}</small></div><button className="m-btn" onClick={() => navigator.clipboard?.writeText(pairingCode)}>Copiar</button></div>}
      <div className="m-searchrow"><form onSubmit={submitSearch} className="m-searchwrap"><input className="m-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Assunto, pessoa…" /></form><button className="m-filterbtn" onClick={() => setFilterOpen((value) => !value)}>☷ Filtros {activeFilterCount ? `(${activeFilterCount})` : ""}</button>{filterOpen && <div className="m-filterpop"><div className="m-filtertabs">{(["status","people","period"] as FilterTab[]).map((tab) => <button key={tab} className={filterTab === tab ? "active" : ""} onClick={() => setFilterTab(tab)}>{tab === "status" ? "Status" : tab === "people" ? "Pessoas" : "Período"}</button>)}</div><div className="m-filterbody">{filterTab === "status" && [["all","Todos"],["ready","Pronto"],["waiting","Aguardando"],["calendar","Reuniões do calendário"],["crm","Integrado ao cliente/CRM"]].map(([value,label]) => <label className="m-choice" key={value}><input type="radio" name="status" checked={statusFilter === value} onChange={() => setStatusFilter(value)} />{label}</label>)}{filterTab === "people" && <><label className="m-choice"><input type="radio" name="person" checked={!peopleFilter} onChange={() => setPeopleFilter("")} />Todas as pessoas</label>{people.map((name) => <label className="m-choice" key={name}><input type="radio" name="person" checked={peopleFilter === name} onChange={() => setPeopleFilter(name)} />{name}</label>)}</>}{filterTab === "period" && [["all","Qualquer período"],["today","Hoje"],["yesterday","Ontem"],["7","Últimos 7 dias"],["30","Últimos 30 dias"]].map(([value,label]) => <label className="m-choice" key={value}><input type="radio" name="period" checked={periodFilter === value} onChange={() => setPeriodFilter(value)} />{label}</label>)}</div></div>}</div>
      {(activeQuery || activeFilterCount > 0) && <div className="m-chiprow">{activeQuery && <button className="m-chip" onClick={() => { setQuery(""); setActiveQuery(""); setRecords([]); load(true, ""); }}>“{activeQuery}” ×</button>}{statusFilter !== "all" && <button className="m-chip" onClick={() => setStatusFilter("all")}>{statusFilter} ×</button>}{peopleFilter && <button className="m-chip" onClick={() => setPeopleFilter("")}>{peopleFilter} ×</button>}{periodFilter !== "all" && <button className="m-chip" onClick={() => setPeriodFilter("all")}>{periodFilter} ×</button>}</div>}
      {error && <div className="m-empty">{error}</div>}{loading && !records.length && <div className="m-timeline">{[1,2,3,4].map((n) => <div className="m-skeleton" key={n} />)}</div>}
      {!loading && !filtered.length && !error && <div className="m-empty"><div style={{fontSize:34}}>⌕</div><b>Ops, nada por aqui…</b><div>Nenhuma reunião foi encontrada com essa pesquisa ou filtro.</div></div>}
      {!!grouped.length && <div className="m-timeline">{grouped.map((rows) => <div className="m-day" key={dayKey(rows[0])}><div className="m-daytitle">{dayLabel(rows[0])}</div>{rows.map((row) => { const ps = participants(row.participants); const actions = asItems(row.commitments).length + asItems(row.decisions).length; return <button className="m-feedcard" key={String(row.id)} onClick={() => openDetail(row)}><span className="m-feedicon">▣</span><span><span className="m-feedtitleline"><span className="m-feedtitle">{cleanTitle(row)}</span>{ps.length > 0 && <span className="m-avatars">{ps.slice(0,4).map((name,index) => <span className="m-avatar" title={name} key={`${name}-${index}`}>{initials(name)}</span>)}</span>}{row.owner_person && <span className="m-owner">{String(row.owner_person)}</span>}</span><span className="m-summary">{String(row.summary || "Reunião capturada. Processamento e inteligência aparecerão aqui quando estiverem prontos.")}</span><span className="m-meta"><span>▣ {timeLabel(row.meeting_started_at)}</span><span>◷ {durationLabel(row)}</span><span>☷ {actions} Ações</span>{row.client_name_raw && <span>⌂ {String(row.client_name_raw)}</span>}</span></span><span className="m-status">{row?.metadata?.calendar_event_id && <span title="Google Calendar">▣</span>}<span title="Relato AI">»</span><span className={ready(row) ? "ok" : "wait"}>{ready(row) ? "✓" : "◴"}</span></span></button>})}</div>)}</div>}
      {hasMore && <div className="m-more"><button className="m-btn" onClick={() => load(false, activeQuery)} disabled={loading}>{loading ? "Carregando…" : `Carregar mais (${records.length}/${count})`}</button></div>}
    </>}
    {(detail || detailLoading) && <>{detailLoading && !detail ? <div className="m-empty">Carregando reunião…</div> : detail && <>
      <div className="m-detailhead"><div><div><span className="m-breadcrumb" onClick={() => setDetail(null)}>Feed / </span><span className="m-detailtitle">{cleanTitle(detail)}</span><span className="m-tag">▣ Reunião</span><span className="m-ready">{ready(detail) ? "✓" : "◴"}</span></div></div><div className="meetings-actions"><button className="m-btn icon" title="Copiar resumo" onClick={() => navigator.clipboard?.writeText(String(detail.summary || ""))}>⧉</button><button className="m-btn icon" onClick={() => setDetail(null)}>×</button></div></div>
      <div className="m-card"><div className="m-participantline"><div className="m-avatars">{participants(detail.participants).slice(0,6).map((name,index) => <span className="m-avatar" key={`${name}-${index}`}>{initials(name)}</span>)}</div>{participants(detail.participants).join(", ") || "Participantes não identificados"}</div><div className="m-detailmeta"><span>▣ {shortDate(detail.meeting_started_at)}</span><span>◷ {timeLabel(detail.meeting_started_at)} - {timeLabel(detail.meeting_ended_at)} ({durationLabel(detail)})</span><span>☷ {detailActions.length} Ações</span>{detail.owner_person && <span>Responsável: {String(detail.owner_person)}</span>}</div></div>
      <section className="m-section"><h2 className="m-sectiontitle">☰ Resumo</h2><div className="m-card" style={{fontSize:12,color:"#cbd5e1"}}>{String(detail.summary || "Resumo ainda não processado.")}</div></section>
      <div className="m-detailgrid"><div>
      <section className="m-section"><h2 className="m-sectiontitle">Acoes ({detailActions.length}) <span className="m-mini">?</span></h2>{detailActions.length ? detailActions.map((item: { title: string; owner: string; due_date: string; evidence: string }, index: number) => <div className="m-action" key={index}><button className="m-follow">Acompanhar?</button><div><div className="m-actiontext">{item.title}</div><div className="m-context">{item.owner ? `Responsavel: ${item.owner}` : "Responsavel nao definido"}{item.due_date ? ` - ${item.due_date}` : ""}</div>{item.evidence && <div className="m-context">Contexto: {item.evidence}</div>}</div></div>) : <div className="m-card m-empty" style={{padding:30}}><b>Nenhuma acao encontrada</b><br/>As acoes detectadas para esta reuniao aparecerao aqui. Voce tambem pode adicionar uma manualmente.</div>}<button className="m-btn" style={{marginTop:8}}>+ Nova acao...</button></section>
      {dossier && <section className="m-section"><h2 className="m-sectiontitle">Contexto do Cliente <span className="m-chip">Novo</span></h2><div className="m-contextbox"><div className="m-contexthead"><div className="m-contextclient"><b>{String(dossier.display_name || detail.client_name_raw || "Cliente")}</b>{dossier.lifecycle && <span className="m-chip">{String(dossier.lifecycle)}</span>}</div><button className="m-mini">Nao e esta empresa?</button></div><div className="m-contextbody"><div><div className="m-contextlabel">Briefing para o proximo contato</div><div className="m-briefing">{briefings[0]?.extracted_profile ? JSON.stringify(briefings[0].extracted_profile).slice(0,900) : briefings[0]?.title ? `Briefing disponivel: ${String(briefings[0].title)}` : `Cliente ${String(dossier.display_name || "")}. GT ${String(dossier.gt_owner || "nao definido")} - CS ${String(dossier.cs_owner || "nao definido")}.`}</div></div><div><div className="m-contextlabel">Pontos de atencao</div><div className="m-attention">{dossier.onboarding_risk ? `Risco de onboarding: ${String(dossier.onboarding_risk)}. ` : ""}{dossier.waiting_for_agency ? "Aguardando acao da agencia. " : ""}{dossier.waiting_for_client ? "Aguardando cliente. " : ""}{dossier.alerts_open ? `${String(dossier.alerts_open)} alerta(s) aberto(s). ` : ""}{dossier.health_band ? `Saude: ${String(dossier.health_band)}.` : "Sem alerta adicional consolidado."}</div></div>{clientNotes.length > 0 && <div><div className="m-contextlabel">Contextos ({clientNotes.length})</div>{clientNotes.slice(0,5).map((note:any,index:number)=><div className="m-note" key={note.id || index}><strong>{String(note.title || note.note_type || "Nota interna")}</strong><p>{String(note.body || "")}</p><div className="m-ctxactions"><button className="m-mini">Aceitar</button><button className="m-mini">Rejeitar</button><button className="m-mini">Editar</button><button className="m-mini">Trocar</button></div></div>)}</div>}<div className="m-clientstats">{dossier.health_score != null && <span className="m-clientstat">Health {String(dossier.health_score)}</span>}{dossier.complaints_total != null && <span className="m-clientstat">{String(dossier.complaints_total)} reclamacoes</span>}{dossier.commitments_open != null && <span className="m-clientstat">{String(dossier.commitments_open)} compromissos abertos</span>}{dossier.whatsapp_sla && <span className="m-clientstat">SLA {String(dossier.whatsapp_sla)}</span>}</div></div></div></section>}
      <section className="m-section"><h2 className="m-sectiontitle">Resumo em topicos <span className="m-feedback">Esse resumo foi util? 👍 👎</span></h2><div className="m-card">{topics.length ? topics.map((item: { title: string; body: string }, index: number) => <div className="m-topic" key={index}><strong>{item.title}</strong><p>{item.body}</p></div>) : <div style={{color:"#94a3b8",fontSize:11}}>Os topicos aparecerao depois do processamento.</div>}</div></section></div>
      <div><section className="m-section"><h2 className="m-sectiontitle">Highlights <span className="m-mini">?</span></h2>{detailSignals.length ? detailSignals.map((group) => <div className="m-highlightgroup" key={String(group.name)}><h4>{String(group.icon)} {String(group.name)} ({group.items.length})</h4>{group.items.map((item: string,index: number) => <div className="m-highlight" key={index}><strong>{item.slice(0,90)}</strong><p>{item}</p><div className="m-highlightfeedback">Isso foi util? 👍 👎</div></div>)}</div>) : <div className="m-card" style={{color:"#94a3b8",fontSize:11}}>Highlights ainda nao processados.</div>}</section><section className="m-section"><h2 className="m-sectiontitle">Mapa mental <span className="m-feedback">Esse mapa foi util? 👍 👎</span></h2><div className="m-card m-mind"><div className="m-mindroot">Reuniao</div><div className="m-mindnodes">{(topics.length ? topics.map((item: { title: string; body: string })=>item.title) : asItems(detail.decisions)).slice(0,5).map((item: string,index: number) => <div className="m-mindnode" key={index}>{String(item).slice(0,100)}</div>)}</div></div></section></div></div>
      <section className="m-section"><h2 className="m-sectiontitle">Transcricao da reuniao</h2><div className="m-accordion">
      <button className="m-accbutton" onClick={() => setNotesOpen((v)=>!v)}><b>Notas reescritas pelo Relato AI</b><span style={{float:"right"}}>{notesOpen ? "^" : "v"}</span></button>{notesOpen && <div className="m-accpanel">{rewritten.length ? rewritten.map((note: Row,index: number)=><div className="m-rewritecard" key={index}><div className="m-rewritehead">@{note.speaker} <span>[{note.timestamp}]</span></div><div className="m-rewriteorig">{note.original}</div><div className="m-rewritenew">{note.rewritten}</div><div className="m-feedback">Essa nota foi util? 👍 👎</div></div>) : <div className="m-empty" style={{padding:24}}>Nenhuma nota reescrita disponivel.</div>}</div>}
      <button className="m-accbutton" onClick={() => setTranscriptOpen((v)=>!v)}><b>Transcricao completa</b><span style={{float:"right"}}>{transcriptOpen ? "^" : "v"}</span></button>{transcriptOpen && <div className="m-transcriptbody"><div className="m-transcripttoolbar"><input className="m-transcriptsearch" value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder="Procurar em transcricao..." /><button className="m-btn" onClick={() => { const text = shownSegments.map((x) => `[${stamp(x.started_ms)}] ${x.speaker_name}: ${x.text}`).join("\n\n"); const blob = new Blob([text], {type:"text/plain;charset=utf-8"}); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${cleanTitle(detail).replace(/[^a-z0-9_-]+/gi,"-")}.txt`; link.click(); URL.revokeObjectURL(link.href); }}>Exportar</button></div>{keywords.length > 0 && <div className="m-keywords"><b style={{color:"#f1f5f9",fontSize:13}}>Palavras chave</b><br />{keywords.join(", ")}</div>}<div className="m-transcriptscroll">{shownSegments.length ? shownSegments.map((segment,index) => <article className="m-transcriptblock" key={`${segment.message_id || index}-${segment.sequence_no || index}`}><header><span className="m-transcriptwho">{String(segment.speaker_name || "Participante")}</span><span className="m-transcripttime">{stamp(segment.started_ms)}</span></header><p className="m-transcripttext">{String(segment.text || "")}</p></article>) : <div className="m-empty">Transcricao estruturada indisponivel.</div>}</div></div>}</div></section>
    </>}</>}
  </div></section>, document.body)}</>;
}
