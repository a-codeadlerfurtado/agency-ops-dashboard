"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../shared";
import type { Row } from "../shared";

type Standard = "BAIXO" | "MEDIO" | "ALTO";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-video-scripts-api`;
const STANDARD_LABEL: Record<string, string> = { BAIXO: "Baixo padrão", MEDIO: "Médio padrão", ALTO: "Alto padrão" };
const STATUS: Record<string, { label: string; tone: string }> = {
  WAITING_PERSONA: { label: "Aguardando Persona", tone: "waiting" },
  WAITING_STANDARD: { label: "Aguardando padrão", tone: "waiting" },
  WAITING_QUALIFICATION: { label: "Falta preço/condição", tone: "blocked" },
  READY: { label: "Na fila", tone: "queue" },
  GENERATING: { label: "Gerando", tone: "queue" },
  GENERATED: { label: "Pronto", tone: "ready" },
  ERROR: { label: "Tentando novamente", tone: "error" },
};

function clean(value: unknown) { return String(value ?? "").trim(); }
function norm(value: unknown) { return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function fmt(value: unknown) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(String(value))); }
  catch { return clean(value); }
}
function answer(job: Row, key: string) { return clean(job?.product_answers?.[key]); }
function scriptType(value: unknown) {
  const key = clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (key.includes("APRESENTACAO")) return "Apresentação direta";
  if (key.includes("TOUR")) return "Tour silencioso";
  if (key.includes("OPORTUNIDADE")) return "Gancho de oportunidade";
  if (key.includes("CONDICAO")) return "Condição comercial";
  return clean(value) || "Roteiro";
}

export function VideoScriptsCenter({ token }: { token: string }) {
  const [records, setRecords] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [standard, setStandard] = useState("ALL");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }), [token]);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) }, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
    return body;
  }, [headers]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const body = await request(API);
      setRecords(Array.isArray(body.records) ? body.records : []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar a produção de roteiros."); }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => records.filter((row) => {
    if (query.trim() && !norm(`${row.client_name || ""} ${row.product_name || ""}`).includes(norm(query))) return false;
    if (status !== "ALL" && row.status !== status) return false;
    if (standard === "MISSING" && row.product_standard) return false;
    if (!["ALL", "MISSING"].includes(standard) && row.product_standard !== standard) return false;
    return true;
  }), [records, query, status, standard]);

  const counts = useMemo(() => ({
    total: records.length,
    ready: records.filter((row) => row.status === "GENERATED").length,
    standard: records.filter((row) => row.status === "WAITING_STANDARD").length,
    persona: records.filter((row) => row.status === "WAITING_PERSONA").length,
    queue: records.filter((row) => ["READY", "GENERATING", "ERROR"].includes(row.status)).length,
  }), [records]);

  async function setProductStandard(row: Row, value: Standard) {
    setBusy(String(row.id)); setError("");
    try {
      const body = await request(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set_standard", id: row.id, standard: value }) });
      setRecords((current) => current.map((item) => String(item.id) === String(row.id) ? { ...item, product_standard: value, standard_source: "MANUAL", status: body?.job?.status || item.status, updated_at: new Date().toISOString() } : item));
      setDetail((current) => current && String(current.id) === String(row.id) ? { ...current, product_standard: value, standard_source: "MANUAL", status: body?.job?.status || current.status } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao definir padrão."); }
    finally { setBusy(""); }
  }

  async function openDetail(row: Row) {
    setDetailLoading(true); setError("");
    try {
      const body = await request(`${API}?id=${encodeURIComponent(String(row.id))}`);
      setDetail({ ...(body.job || row), client_name: body?.client?.display_name || row.client_name });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao abrir roteiro."); }
    finally { setDetailLoading(false); }
  }

  async function regenerate(row: Row) {
    setBusy(String(row.id)); setError("");
    try {
      await request(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "regenerate", id: row.id }) });
      setRecords((current) => current.map((item) => String(item.id) === String(row.id) ? { ...item, status: "READY", last_error: null, updated_at: new Date().toISOString() } : item));
      setDetail((current) => current && String(current.id) === String(row.id) ? { ...current, status: "READY", last_error: null } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao enfileirar regeneração."); }
    finally { setBusy(""); }
  }

  async function downloadPdf(row: Row) {
    const popup = window.open("about:blank", "_blank");
    setBusy(String(row.id)); setError("");
    try {
      const body = await request(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signed_pdf", id: row.id }) });
      if (!body?.signed_url) throw new Error("PDF ainda não disponível.");
      if (popup) popup.location.href = body.signed_url; else window.location.assign(body.signed_url);
    } catch (caught) { popup?.close(); setError(caught instanceof Error ? caught.message : "Falha ao abrir PDF."); }
    finally { setBusy(""); }
  }

  async function copyScript(row: Row) {
    try {
      let source = row;
      if (!clean(source.generated_markdown)) {
        const body = await request(`${API}?id=${encodeURIComponent(String(row.id))}`);
        source = body?.job || row;
      }
      if (!clean(source.generated_markdown)) throw new Error("O texto do roteiro ainda não está pronto.");
      await navigator.clipboard.writeText(source.generated_markdown);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao copiar roteiro."); }
  }

  const renderedScripts = Array.isArray(detail?.generated_content?.scripts) ? detail.generated_content.scripts : [];
  const recording = clean(detail?.generated_content?.recording_instructions);

  return <section className="workspace vs-native">
    <div className="workspace-head">
      <div><span className="eyebrow">Produção de Roteiros</span><h2>Roteiros automáticos para vídeo</h2><p>Produto + Persona alimentam a fila automaticamente. O padrão do imóvel nunca é inferido: quando o briefing não informa, a confirmação é manual.</p></div>
      <button className="btn" onClick={() => void load()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
    </div>

    {error && <div className="error-box">{error}</div>}

    <div className="grid kpis vs-native-kpis">
      <article className="metric"><span>Produtos no pipeline</span><strong>{counts.total}</strong></article>
      <article className="metric green"><span>Roteiros prontos</span><strong>{counts.ready}</strong></article>
      <article className="metric yellow"><span>Aguardando padrão</span><strong>{counts.standard}</strong></article>
      <article className="metric"><span>Aguardando Persona</span><strong>{counts.persona}</strong></article>
      <article className="metric blue"><span>Fila / geração</span><strong>{counts.queue}</strong></article>
    </div>

    <div className="toolbar vs-native-toolbar">
      <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou produto" />
      <select className="control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">Todos os status</option>{Object.entries(STATUS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>
      <select className="control" value={standard} onChange={(event) => setStandard(event.target.value)}><option value="ALL">Todos os padrões</option><option value="MISSING">Sem padrão</option><option value="BAIXO">Baixo padrão</option><option value="MEDIO">Médio padrão</option><option value="ALTO">Alto padrão</option></select>
    </div>

    {loading && !records.length ? <div className="empty">Carregando produção…</div> : <div className="vs-native-grid">{filtered.map((row) => {
      const info = STATUS[row.status] || { label: clean(row.status), tone: "" };
      return <article className="card vs-native-card" key={row.id}>
        <div className="vs-native-card-head"><div><span className="eyebrow">{row.client_name || "Cliente"}</span><h3>{row.product_name}</h3></div><small>{fmt(row.updated_at)}</small></div>
        <div className="vs-native-chips"><span className={`vs-native-chip ${info.tone}`}>{info.label}</span>{row.product_standard && <span className="vs-native-chip">{STANDARD_LABEL[row.product_standard]}</span>}</div>
        {row.status === "WAITING_STANDARD" && <p className="small">O briefing não informa o padrão com segurança. Confirme manualmente; preço não é usado para inferir padrão.</p>}
        {row.status === "WAITING_PERSONA" && <p className="small">O Produto já está salvo; a geração começa quando uma Persona desse cliente entrar.</p>}
        {row.status === "WAITING_QUALIFICATION" && <p className="small">Falta preço ou condição real para a abertura prevista no playbook.</p>}
        {row.status === "WAITING_STANDARD" && <div className="vs-native-standard">{(["BAIXO", "MEDIO", "ALTO"] as Standard[]).map((value) => <button key={value} disabled={busy === String(row.id)} onClick={() => void setProductStandard(row, value)}>{STANDARD_LABEL[value]}</button>)}</div>}
        <div className="vs-native-actions"><button className="btn" onClick={() => void openDetail(row)}>Abrir</button>{row.status === "GENERATED" && <><button className="btn" disabled={busy === String(row.id)} onClick={() => void downloadPdf(row)}>PDF</button><button className="btn" onClick={() => void copyScript(row)}>Copiar</button><button className="btn" disabled={busy === String(row.id)} onClick={() => void regenerate(row)}>Regenerar</button></>}</div>
      </article>;
    })}{!loading && !filtered.length && <div className="empty">Nenhum produto neste filtro.</div>}</div>}

    {(detail || detailLoading) && <><div className="overlay open" onClick={() => setDetail(null)} /><aside className="drawer open vs-native-drawer" role="dialog" aria-modal="true" aria-label="Detalhes do roteiro">
      <div className="drawer-head"><div><span className="eyebrow">{detail?.client_name || "Produção de Roteiros"}</span><h2>{detail?.product_name || "Abrindo produto…"}</h2></div><button className="close" onClick={() => setDetail(null)}>×</button></div>
      <div className="drawer-body">{detailLoading && !detail ? <div className="empty">Abrindo produto…</div> : detail && <>
        {detail.last_error && <div className="error-box">Última tentativa: {clean(detail.last_error)}</div>}
        <section className="detail-card"><h3>Qualificação de abertura</h3><div className="vs-native-facts">{[["Valor", answer(detail, "valor_total")], ["Entrada", answer(detail, "valor_entrada")], ["Facilidade de entrada", answer(detail, "facilidade_entrada")], ["Facilidade de pagamento", answer(detail, "facilidade_pagamento")], ["Formas de pagamento", answer(detail, "formas_pagamento")], ["Financiamento", answer(detail, "financiamento_meses")]].filter(([, value]) => value).map(([label, value]) => <p key={label}><small>{label}</small><b>{value}</b></p>)}</div></section>
        {!detail.product_standard && <section className="detail-card"><h3>Definir padrão</h3><div className="vs-native-standard">{(["BAIXO", "MEDIO", "ALTO"] as Standard[]).map((value) => <button key={value} disabled={busy === String(detail.id)} onClick={() => void setProductStandard(detail, value)}>{STANDARD_LABEL[value]}</button>)}</div></section>}
        {recording && <section className="detail-card"><h3>Antes de gravar</h3><p className="vs-native-recording">{recording}</p></section>}
        <section className="detail-card full"><h3>Roteiros</h3>{renderedScripts.length ? renderedScripts.map((script: Row, index: number) => <article className="vs-native-script" key={`${script.type}-${index}`}><h4>{index + 1}. {clean(script.title) || scriptType(script.type)}</h4><small>{scriptType(script.type)}{script.angle ? ` · ${script.angle}` : ""}</small>{(Array.isArray(script.segments) ? script.segments : []).map((segment: Row, segmentIndex: number) => <div className="vs-native-segment" key={segmentIndex}><b>{segment.time || "Trecho"}</b>{segment.location && <p><strong>Onde:</strong> {segment.location}</p>}{segment.show && <p><strong>Mostrar:</strong> {segment.show}</p>}{segment.speech && <p><strong>Fala:</strong> “{segment.speech}”</p>}{segment.on_screen && <p><strong>Na tela:</strong> “{segment.on_screen}”</p>}</div>)}</article>) : <p className="small">Ainda não há material gerado para este produto.</p>}</section>
        {detail.status === "GENERATED" && <div className="vs-native-actions"><button className="btn" onClick={() => void downloadPdf(detail)}>Abrir PDF</button><button className="btn" onClick={() => void copyScript(detail)}>Copiar texto</button><button className="btn" onClick={() => void regenerate(detail)}>Regenerar</button></div>}
      </>}</div>
    </aside></>}

    <style>{`
      .vs-native{display:grid;gap:14px}.vs-native-kpis{grid-template-columns:repeat(5,minmax(130px,1fr))}.vs-native-kpis .metric{min-height:92px}.vs-native-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 210px 210px;gap:8px}.vs-native-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.vs-native-card{padding:15px;display:flex;flex-direction:column;gap:11px;min-height:220px}.vs-native-card-head{display:flex;justify-content:space-between;gap:12px}.vs-native-card-head h3{margin:5px 0 0}.vs-native-card-head small{color:var(--muted);white-space:nowrap}.vs-native-chips,.vs-native-actions{display:flex;gap:7px;flex-wrap:wrap}.vs-native-actions{margin-top:auto}.vs-native-chip{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:4px 8px;font-size:10px;font-weight:800}.vs-native-chip.ready{color:#80e7aa;border-color:#2f704d;background:rgba(34,197,94,.08)}.vs-native-chip.waiting{color:#ffc07b;border-color:#73502f;background:rgba(245,158,11,.08)}.vs-native-chip.blocked,.vs-native-chip.error{color:#ffaaa2;border-color:#77413c;background:rgba(239,68,68,.08)}.vs-native-chip.queue{color:#8bcdf5;border-color:#345d78;background:rgba(59,130,246,.08)}.vs-native-standard{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.vs-native-standard button{border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--text);padding:9px 6px;cursor:pointer;font-weight:750}.vs-native-standard button:hover{border-color:var(--accent,#ff7a2f)}.vs-native-drawer{z-index:160}.vs-native-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.vs-native-facts p{margin:0;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--panel2)}.vs-native-facts small,.vs-native-facts b{display:block}.vs-native-facts small{color:var(--muted);margin-bottom:4px}.vs-native-recording{white-space:pre-wrap;line-height:1.55}.vs-native-script{padding:12px 0;border-top:1px solid var(--line)}.vs-native-script:first-of-type{border-top:0}.vs-native-script h4{margin:0 0 4px}.vs-native-script>small{color:var(--muted)}.vs-native-segment{padding:9px 0;border-top:1px solid var(--line)}.vs-native-segment p{margin:4px 0;line-height:1.45}.vs-native-segment>b{color:var(--blue)}
      @media(max-width:1000px){.vs-native-kpis{grid-template-columns:repeat(2,minmax(130px,1fr))}.vs-native-toolbar{grid-template-columns:1fr}.vs-native-grid{grid-template-columns:1fr}}@media(max-width:620px){.vs-native-facts{grid-template-columns:1fr}}
    `}</style>
  </section>;
}
