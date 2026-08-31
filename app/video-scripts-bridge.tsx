"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch, loadProfileLite, SUPABASE_URL } from "./shared";

type Row = Record<string, any>;
type Standard = "BAIXO" | "MEDIO" | "ALTO";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-video-scripts-api`;
const ALLOWED = new Set(["Adler Furtado", "Leonardo Augusto", "Joel Antoniete", "Gustavo Lima"]);
const STATUS: Record<string, { label: string; className: string }> = {
  WAITING_PERSONA: { label: "Aguardando Persona", className: "waiting" },
  WAITING_STANDARD: { label: "Aguardando padrão", className: "waiting" },
  WAITING_QUALIFICATION: { label: "Falta preço/condição", className: "blocked" },
  READY: { label: "Na fila", className: "queue" },
  GENERATING: { label: "Gerando", className: "generating" },
  GENERATED: { label: "Pronto", className: "ready" },
  ERROR: { label: "Tentando novamente", className: "error" },
};
const STANDARD_LABEL: Record<string, string> = { BAIXO: "Baixo padrão", MEDIO: "Médio padrão", ALTO: "Alto padrão" };

function clean(value: unknown) { return String(value ?? "").trim(); }
function norm(value: unknown) { return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function fmt(value: unknown) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(String(value))); }
  catch { return clean(value); }
}
function scriptType(value: unknown) {
  const key = clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (key.includes("APRESENTACAO")) return "Apresentação direta";
  if (key.includes("TOUR")) return "Tour silencioso";
  if (key.includes("OPORTUNIDADE")) return "Gancho de oportunidade";
  if (key.includes("CONDICAO")) return "Condição comercial";
  return clean(value) || "Roteiro";
}
function answer(job: Row, key: string) { return clean(job?.product_answers?.[key]); }

const STYLE = `
.video-scripts-nav-button{display:flex!important;align-items:center!important;gap:12px!important}
.video-scripts-nav-button::before{content:""!important;width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;background-color:currentColor!important;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 3.5h9l3 3V20.5H6zM15 3.5v4h3M9 11h6M9 14.5h6M9 18h4' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='m4 9-2 1.4v3.2L4 15z' fill='none' stroke='black' stroke-width='1.55'/%3E%3C/svg%3E") center/contain no-repeat!important;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 3.5h9l3 3V20.5H6zM15 3.5v4h3M9 11h6M9 14.5h6M9 18h4' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='m4 9-2 1.4v3.2L4 15z' fill='none' stroke='black' stroke-width='1.55'/%3E%3C/svg%3E") center/contain no-repeat!important}
.vs-shell{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147481400;background:#091015;color:#eaf1f5;overflow:auto;padding:24px 28px 46px;font-family:Inter,sans-serif}
.vs-wrap{max-width:1460px;margin:0 auto}.vs-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}.vs-kicker{font-size:10px;font-weight:900;letter-spacing:.14em;color:#ff9252;text-transform:uppercase}.vs-head h1{font:800 30px/1.05 'Inter Tight',Inter,sans-serif;letter-spacing:-.035em;margin:5px 0 6px}.vs-head p{margin:0;color:#94a3ad;font-size:12px;max-width:760px;line-height:1.55}.vs-actions{display:flex;gap:8px}.vs-btn{border:1px solid #32404a;border-radius:10px;background:#131b21;color:#e6eef2;padding:9px 12px;font-size:11px;font-weight:800;cursor:pointer}.vs-btn:hover{border-color:#6c8595;background:#172128}.vs-btn:disabled{opacity:.5;cursor:wait}.vs-btn.primary{background:#ff7428;border-color:#ff8d4d;color:#fff}.vs-btn.green{background:#123425;border-color:#286645;color:#9af2bf}.vs-btn.danger{color:#ffaaa1}
.vs-kpis{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:9px;margin-bottom:15px}.vs-kpi{border:1px solid #26343d;background:#10171c;border-radius:12px;padding:12px 13px}.vs-kpi strong{display:block;font:800 22px/1 'Inter Tight',Inter,sans-serif}.vs-kpi span{display:block;margin-top:5px;color:#8b9aa4;font-size:10px;font-weight:700}.vs-kpi.attention strong{color:#ffae67}.vs-kpi.ready strong{color:#67d79b}
.vs-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 190px 190px;gap:8px;margin-bottom:13px}.vs-input,.vs-select{width:100%;box-sizing:border-box;border:1px solid #2c3a43;background:#10171c;color:#e7eef2;border-radius:10px;padding:10px 11px;outline:none;font-size:11px}.vs-input:focus,.vs-select:focus{border-color:#6798b5}.vs-meta{font-size:10px;color:#778994;margin:0 0 10px}
.vs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:11px}.vs-card{border:1px solid #293740;background:linear-gradient(180deg,#121a20,#0e151a);border-radius:14px;padding:14px;min-height:205px;display:flex;flex-direction:column;gap:9px}.vs-card:hover{border-color:#415866}.vs-card-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.vs-client{font-size:10px;font-weight:900;letter-spacing:.08em;color:#7bc9f5;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vs-date{font-size:9px;color:#6f808a;white-space:nowrap}.vs-product{font:800 16px/1.2 'Inter Tight',Inter,sans-serif}.vs-line{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.vs-chip{display:inline-flex;align-items:center;border:1px solid #31414b;border-radius:999px;padding:4px 7px;font-size:9px;font-weight:850;color:#a9b8c1;background:#0b1115}.vs-chip.ready{color:#86edb1;border-color:#24583b;background:#0d2318}.vs-chip.waiting{color:#ffc183;border-color:#674528;background:#28190e}.vs-chip.blocked,.vs-chip.error{color:#ffa49b;border-color:#6a342f;background:#27100f}.vs-chip.queue,.vs-chip.generating{color:#8dcdf7;border-color:#2d536c;background:#0d1d27}.vs-card-note{font-size:10px;color:#8998a2;line-height:1.45}.vs-card-spacer{flex:1}.vs-card-actions{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #233039;padding-top:10px}.vs-standard{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;width:100%}.vs-standard button{border:1px solid #33434d;background:#11191e;color:#b9c5cb;border-radius:8px;padding:8px 5px;font-size:9px;font-weight:850;cursor:pointer}.vs-standard button:hover{border-color:#ff9252;color:#fff}.vs-standard button.active{border-color:#ff9252;background:#2b190f;color:#ffbd94}
.vs-empty{border:1px dashed #31414b;border-radius:14px;padding:30px;text-align:center;color:#83939d;font-size:12px}
.vs-overlay{position:fixed;inset:0 0 0 var(--sidenav-width,224px);z-index:2147482400;background:rgba(0,0,0,.52);display:flex;justify-content:flex-end}.vs-drawer{width:min(760px,94vw);height:100%;box-sizing:border-box;background:#0b1217;border-left:1px solid #2e3d46;overflow:auto;padding:22px}.vs-drawer-head{position:sticky;top:-22px;z-index:2;background:#0b1217;border-bottom:1px solid #26343c;padding:22px 0 14px;display:flex;justify-content:space-between;gap:14px}.vs-drawer-head h2{font:800 22px/1.12 'Inter Tight',Inter,sans-serif;margin:5px 0 5px}.vs-drawer-sub{font-size:10px;color:#81929d}.vs-section{margin-top:18px}.vs-section>h3{font-size:10px;font-weight:900;letter-spacing:.1em;color:#ff9252;text-transform:uppercase;margin:0 0 9px}.vs-facts{display:grid;grid-template-columns:1fr 1fr;gap:7px}.vs-fact{border:1px solid #26343c;background:#0f171c;border-radius:9px;padding:9px}.vs-fact span{display:block;color:#74858f;font-size:8px;text-transform:uppercase;font-weight:900;letter-spacing:.07em}.vs-fact b{display:block;margin-top:4px;font-size:11px;color:#d7e1e6}.vs-recording{white-space:pre-wrap;border:1px solid #2a3841;background:#0e161b;border-radius:11px;padding:12px;color:#acbbc3;font-size:10.5px;line-height:1.55}.vs-script{border:1px solid #2b3942;background:#0f171c;border-radius:12px;padding:13px;margin-bottom:9px}.vs-script h4{margin:0 0 3px;font-size:14px}.vs-script-angle{font-size:10px;color:#8799a4;margin-bottom:9px}.vs-segment{border-top:1px solid #25323a;padding:9px 0}.vs-segment:first-of-type{border-top:0}.vs-segment-time{font-size:9px;font-weight:900;color:#79c8f4}.vs-segment p{margin:4px 0 0;color:#b7c3ca;font-size:10.5px;line-height:1.5}.vs-segment b{color:#e5edf1}.vs-drawer-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:15px}.vs-error{margin-bottom:12px;padding:10px;border:1px solid #66362e;background:#251311;color:#ffb0a7;border-radius:10px;font-size:10px}
@media(max-width:800px){.vs-shell{left:58px;padding:18px 14px 38px}.vs-kpis{grid-template-columns:repeat(2,1fr)}.vs-toolbar{grid-template-columns:1fr}.vs-grid{grid-template-columns:1fr}.vs-overlay{left:58px}.vs-drawer{width:100%}.vs-facts{grid-template-columns:1fr}}
`;

export default function VideoScriptsBridge() {
  const [enabled, setEnabled] = useState(false);
  const [person, setPerson] = useState("");
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [standard, setStandard] = useState("ALL");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    loadProfileLite().then((body) => {
      if (!alive) return;
      const current = clean(body?.profile?.person);
      setPerson(current);
      setEnabled(ALLOWED.has(current));
    }).catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setRecords(Array.isArray(body.records) ? body.records : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar a produção de roteiros.");
    } finally { setLoading(false); }
  }, [enabled]);

  useEffect(() => { if (open && !records.length && !loading) void load(); }, [open, records.length, loading, load]);

  useEffect(() => {
    if (!enabled || window.location.pathname !== "/") return;
    let observer: MutationObserver | null = null;
    let currentButton: HTMLButtonElement | null = null;
    const ensure = () => {
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!container) return;
      let button = container.querySelector<HTMLButtonElement>("[data-video-scripts-nav]");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.videoScriptsNav = "true";
        button.className = "video-scripts-nav-button";
        button.title = "Produção de Roteiros";
        button.textContent = "Produção de Roteiros";
        container.appendChild(button);
      }
      if (currentButton !== button) {
        if (currentButton) currentButton.onclick = null;
        currentButton = button;
        button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); };
      }
      button.classList.toggle("active", open);
      if (!observer) {
        observer = new MutationObserver(() => { if (!document.querySelector("[data-video-scripts-nav]")) ensure(); });
        observer.observe(container, { childList: true });
      }
    };
    ensure();
    const startup = window.setInterval(ensure, 500);
    const end = window.setTimeout(() => window.clearInterval(startup), 5000);
    return () => {
      observer?.disconnect(); window.clearInterval(startup); window.clearTimeout(end);
      if (currentButton) currentButton.onclick = null;
      document.querySelector("[data-video-scripts-nav]")?.remove();
    };
  }, [enabled, open]);

  useEffect(() => {
    if (!open) return;
    const click = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest(".side-nav-items > button,.side-nav-items > a") : null;
      if (!target || target.hasAttribute("data-video-scripts-nav") || target.classList.contains("sidebar-ia-group-title")) return;
      setOpen(false); setDetail(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detail) setDetail(null); else setOpen(false);
    };
    document.addEventListener("click", click, true); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("click", click, true); document.removeEventListener("keydown", key); };
  }, [open, detail]);

  const filtered = useMemo(() => records.filter((row) => {
    const haystack = norm(`${row.client_name || ""} ${row.product_name || ""}`);
    if (query.trim() && !haystack.includes(norm(query))) return false;
    if (status !== "ALL" && row.status !== status) return false;
    if (standard === "MISSING" && row.product_standard) return false;
    if (!["ALL", "MISSING"].includes(standard) && row.product_standard !== standard) return false;
    return true;
  }), [records, query, status, standard]);

  const counts = useMemo(() => {
    const result: Row = { total: records.length, ready: 0, standard: 0, persona: 0, blocked: 0, generating: 0 };
    for (const row of records) {
      if (row.status === "GENERATED") result.ready++;
      if (row.status === "WAITING_STANDARD") result.standard++;
      if (row.status === "WAITING_PERSONA") result.persona++;
      if (row.status === "WAITING_QUALIFICATION") result.blocked++;
      if (["READY", "GENERATING", "ERROR"].includes(row.status)) result.generating++;
    }
    return result;
  }, [records]);

  async function setProductStandard(row: Row, value: Standard) {
    setBusy(String(row.id)); setError("");
    try {
      const response = await authenticatedFetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set_standard", id: row.id, standard: value }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setRecords((current) => current.map((item) => String(item.id) === String(row.id) ? { ...item, product_standard: value, standard_source: "MANUAL", standard_set_by: person, status: body?.job?.status || item.status, updated_at: new Date().toISOString() } : item));
      if (detail && String(detail.id) === String(row.id)) setDetail((current) => current ? { ...current, product_standard: value, standard_source: "MANUAL", standard_set_by: person, status: body?.job?.status || current.status } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao definir padrão."); }
    finally { setBusy(""); }
  }

  async function openDetail(row: Row) {
    setDetailLoading(true); setError("");
    try {
      const response = await authenticatedFetch(`${API}?id=${encodeURIComponent(String(row.id))}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setDetail({ ...(body.job || row), client_name: body?.client?.display_name || row.client_name });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao abrir roteiro."); }
    finally { setDetailLoading(false); }
  }

  async function regenerate(row: Row) {
    setBusy(String(row.id)); setError("");
    try {
      const response = await authenticatedFetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "regenerate", id: row.id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setRecords((current) => current.map((item) => String(item.id) === String(row.id) ? { ...item, status: "READY", last_error: null, updated_at: new Date().toISOString() } : item));
      setDetail((current) => current && String(current.id) === String(row.id) ? { ...current, status: "READY", last_error: null } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao enfileirar regeneração."); }
    finally { setBusy(""); }
  }

  async function downloadPdf(row: Row) {
    const popup = window.open("about:blank", "_blank");
    setBusy(String(row.id)); setError("");
    try {
      const response = await authenticatedFetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signed_pdf", id: row.id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.signed_url) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      if (popup) popup.location.href = body.signed_url; else window.location.assign(body.signed_url);
    } catch (caught) { popup?.close(); setError(caught instanceof Error ? caught.message : "Falha ao abrir PDF."); }
    finally { setBusy(""); }
  }

  async function copyScript(row: Row) {
    let source = row;
    if (!row.generated_markdown) {
      try {
        const response = await authenticatedFetch(`${API}?id=${encodeURIComponent(String(row.id))}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body?.job) source = body.job;
      } catch { /* mantém o que já está carregado */ }
    }
    if (!clean(source.generated_markdown)) { setError("O texto do roteiro ainda não está pronto."); return; }
    await navigator.clipboard.writeText(source.generated_markdown);
  }

  if (!enabled) return null;
  const renderedScripts = Array.isArray(detail?.generated_content?.scripts) ? detail.generated_content.scripts : [];
  const recording = clean(detail?.generated_content?.recording_instructions);
  const statusInfo = detail ? STATUS[detail.status] || { label: detail.status, className: "" } : null;

  return <><style dangerouslySetInnerHTML={{ __html: STYLE }} />{open && createPortal(<section className="vs-shell" aria-label="Produção de roteiros">
    <div className="vs-wrap">
      <div className="vs-head"><div><div className="vs-kicker">Produção de Roteiros</div><h1>Roteiros automáticos para vídeo</h1><p>Produto + Persona entram do formulário e alimentam a fila automaticamente. O padrão do imóvel nunca é inferido: quando não estiver escrito no briefing, precisa ser confirmado aqui antes da geração.</p></div><div className="vs-actions"><button className="vs-btn" onClick={() => void load()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button><button className="vs-btn" onClick={() => { setOpen(false); setDetail(null); }}>Fechar</button></div></div>
      {error && <div className="vs-error">{error}</div>}
      <div className="vs-kpis"><div className="vs-kpi"><strong>{counts.total}</strong><span>produtos ativos no pipeline</span></div><div className="vs-kpi ready"><strong>{counts.ready}</strong><span>roteiros prontos</span></div><div className="vs-kpi attention"><strong>{counts.standard}</strong><span>aguardando padrão</span></div><div className="vs-kpi"><strong>{counts.persona}</strong><span>aguardando Persona</span></div><div className="vs-kpi"><strong>{counts.generating}</strong><span>fila / geração / retry</span></div></div>
      <div className="vs-toolbar"><input className="vs-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou produto"/><select className="vs-select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ALL">Todos os status</option>{Object.entries(STATUS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select><select className="vs-select" value={standard} onChange={(e) => setStandard(e.target.value)}><option value="ALL">Todos os padrões</option><option value="MISSING">Sem padrão</option><option value="BAIXO">Baixo padrão</option><option value="MEDIO">Médio padrão</option><option value="ALTO">Alto padrão</option></select></div>
      <div className="vs-meta">{filtered.length} exibidos · acesso restrito a Leonardo, Adler, Joel e Gustavo · geração automática server-side · sem polling desta tela</div>
      {loading && !records.length ? <div className="vs-empty">Carregando produção…</div> : !filtered.length ? <div className="vs-empty">Nenhum produto neste filtro.</div> : <div className="vs-grid">{filtered.map((row) => {
        const info = STATUS[row.status] || { label: row.status, className: "" };
        return <article className="vs-card" key={row.id}><div className="vs-card-top"><span className="vs-client">{row.client_name || "Cliente"}</span><span className="vs-date">{fmt(row.updated_at)}</span></div><div className="vs-product">{row.product_name}</div><div className="vs-line"><span className={`vs-chip ${info.className}`}>{info.label}</span>{row.product_standard && <span className="vs-chip">{STANDARD_LABEL[row.product_standard]}</span>}{row.standard_source === "MANUAL" && <span className="vs-chip">confirmado por {row.standard_set_by || "time"}</span>}</div>{row.status === "WAITING_STANDARD" && <div className="vs-card-note">O briefing não informa o padrão com segurança. Selecione manualmente — preço não é usado para inferir padrão.</div>}{row.status === "WAITING_PERSONA" && <div className="vs-card-note">O Produto já está salvo; a geração começa quando uma Persona desse cliente entrar.</div>}{row.status === "WAITING_QUALIFICATION" && <div className="vs-card-note">O playbook exige preço ou condição real nos primeiros 3–5s. Este formulário não traz informação suficiente.</div>}{row.status === "ERROR" && <div className="vs-card-note">Falha transitória no gerador. O worker tenta novamente automaticamente.</div>}<div className="vs-card-spacer"/>{row.status === "WAITING_STANDARD" && <div className="vs-standard">{(["BAIXO","MEDIO","ALTO"] as Standard[]).map((value) => <button key={value} disabled={busy === String(row.id)} onClick={() => void setProductStandard(row, value)}>{STANDARD_LABEL[value]}</button>)}</div>}<div className="vs-card-actions"><button className="vs-btn" onClick={() => void openDetail(row)}>Abrir</button>{row.status === "GENERATED" && <><button className="vs-btn green" disabled={busy === String(row.id)} onClick={() => void downloadPdf(row)}>PDF</button><button className="vs-btn" onClick={() => void copyScript(row)}>Copiar</button><button className="vs-btn" disabled={busy === String(row.id)} onClick={() => void regenerate(row)}>Regenerar</button></>}</div></article>;
      })}</div>}
    </div>
    {(detail || detailLoading) && <div className="vs-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetail(null); }}><aside className="vs-drawer">{detailLoading && !detail ? <div className="vs-empty">Abrindo produto…</div> : detail && <><div className="vs-drawer-head"><div><div className="vs-client">{detail.client_name || "Cliente"}</div><h2>{detail.product_name}</h2><div className="vs-line">{statusInfo && <span className={`vs-chip ${statusInfo.className}`}>{statusInfo.label}</span>}{detail.product_standard && <span className="vs-chip">{STANDARD_LABEL[detail.product_standard]}</span>}<span className="vs-drawer-sub">Atualizado {fmt(detail.updated_at)}</span></div></div><button className="vs-btn" onClick={() => setDetail(null)}>Fechar</button></div>{detail.last_error && <div className="vs-error">Última tentativa: {clean(detail.last_error)}</div>}<div className="vs-section"><h3>Qualificação de abertura</h3><div className="vs-facts">{[["Valor", answer(detail,"valor_total")],["Entrada",answer(detail,"valor_entrada")],["Facilidade de entrada",answer(detail,"facilidade_entrada")],["Facilidade de pagamento",answer(detail,"facilidade_pagamento")],["Formas de pagamento",answer(detail,"formas_pagamento")],["Financiamento",answer(detail,"financiamento_meses")]].filter(([,v]) => v).map(([label,value]) => <div className="vs-fact" key={label}><span>{label}</span><b>{value}</b></div>)}</div></div>{!detail.product_standard && <div className="vs-section"><h3>Definir padrão</h3><div className="vs-standard">{(["BAIXO","MEDIO","ALTO"] as Standard[]).map((value) => <button key={value} disabled={busy === String(detail.id)} onClick={() => void setProductStandard(detail, value)}>{STANDARD_LABEL[value]}</button>)}</div></div>}{recording && <div className="vs-section"><h3>Antes de gravar</h3><div className="vs-recording">{recording}</div></div>}{renderedScripts.length > 0 ? <div className="vs-section"><h3>4 roteiros</h3>{renderedScripts.map((script: Row, index: number) => <article className="vs-script" key={`${script.type}-${index}`}><h4>{index + 1}. {clean(script.title) || scriptType(script.type)}</h4><div className="vs-script-angle">{scriptType(script.type)}{script.angle ? ` · ${script.angle}` : ""}</div>{(Array.isArray(script.segments) ? script.segments : []).map((segment: Row, segmentIndex: number) => <div className="vs-segment" key={segmentIndex}><div className="vs-segment-time">{segment.time || "Trecho"}</div>{segment.location && <p><b>Onde:</b> {segment.location}</p>}{segment.tone && <p><b>Tom:</b> {segment.tone}</p>}{segment.show && <p><b>Mostrar:</b> {segment.show}</p>}{segment.speech && <p><b>Fala:</b> “{segment.speech}”</p>}{segment.on_screen && <p><b>Na tela:</b> “{segment.on_screen}”</p>}</div>)}</article>)}</div> : <div className="vs-section"><h3>Roteiros</h3><div className="vs-recording">Ainda não há material gerado para este produto.</div></div>}<div className="vs-drawer-actions">{detail.status === "GENERATED" && <><button className="vs-btn green" onClick={() => void downloadPdf(detail)}>Abrir PDF</button><button className="vs-btn" onClick={() => void copyScript(detail)}>Copiar texto</button><button className="vs-btn" onClick={() => void regenerate(detail)}>Regenerar</button></>}</div></>}</aside></div>}
  </section>, document.body)}</>;
}
