"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";

type Row = Record<string, any>;
type Tab = "overview" | "weekly" | "history" | "coverage" | "exports";
type SortMode = "ATTENTION" | "SPEND" | "CPL" | "NAME";
const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-performance-api`;
const WINDOWS = [3, 7, 14, 30];

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function money(value: unknown) {
  const n = finite(value);
  return n === null ? "—" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(value: unknown, digits = 0) {
  const n = finite(value);
  return n === null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function date(value: unknown) {
  if (!value) return "—";
  const d = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("pt-BR").format(d);
}
const STATUS: Record<string, string> = {
  OK: "OK", PARTIAL_PERIOD: "Período parcial", NO_META_ACCOUNT: "Sem conta Meta", NO_CAMPAIGNS: "Sem campanha", NO_DELIVERY: "Sem entrega",
  API_ERROR: "Erro na API", API_PARTIAL: "API parcial", PENDING: "Pendente", RUNNING: "Processando",
  COMPLETED: "Concluído", COMPLETED_WITH_ERRORS: "Concluído com erros", ERROR: "Erro",
};
function statusLabel(value: unknown) { return STATUS[String(value || "")] || String(value || "—").replaceAll("_", " "); }
function statusTone(value: unknown) {
  const s = String(value || "");
  if (["API_ERROR", "ERROR", "NO_META_ACCOUNT"].includes(s)) return "bad";
  if (["PARTIAL_PERIOD", "API_PARTIAL", "NO_CAMPAIGNS", "NO_DELIVERY", "RUNNING", "COMPLETED_WITH_ERRORS"].includes(s)) return "warn";
  return "ok";
}
function statusHint(value: unknown) {
  const s = String(value || "");
  if (s === "NO_META_ACCOUNT") return "A conta Meta não está mapeada para este cliente.";
  if (s === "NO_CAMPAIGNS") return "Nenhuma campanha encontrada nesta janela.";
  if (s === "NO_DELIVERY") return "Há conta/campanha, mas não houve entrega nesta janela.";
  if (s === "API_ERROR") return "A Meta não devolveu os dados corretamente.";
  if (s === "API_PARTIAL") return "Parte dos dados foi coletada, mas a leitura está incompleta.";
  if (s === "PARTIAL_PERIOD") return "O cliente ainda não possui todos os dias da janela disponíveis.";
  return "Dados disponíveis para a janela de 7 dias.";
}
function delta(current: unknown, previous: unknown, inverse = false) {
  const a = finite(current), b = finite(previous);
  if (a === null || b === null || b === 0) return null;
  const pct = ((a - b) / Math.abs(b)) * 100;
  return { pct, good: inverse ? pct <= 0 : pct >= 0 };
}
function Mini({ row, previous }: { row?: Row; previous?: Row }) {
  if (!row) return <div className="mp-mini empty-mini">Sem snapshot</div>;
  const cplDelta = delta(row.cpl, previous?.cpl, true);
  return <div className={`mp-mini ${statusTone(row.data_status)}`}>
    <div><b>{row.period_days}d</b><span>{statusLabel(row.data_status)}</span></div>
    <strong>{money(row.spend)}</strong>
    <small>{num(row.results)} resultados · CPL {money(row.cpl)}</small>
    <small>CTR {num(row.ctr, 2)}% · CPM {money(row.cpm)} · Freq. {num(row.frequency, 2)}</small>
    {row.is_partial_period && <em>{row.available_period_days}/{row.requested_period_days} dias disponíveis</em>}
    {cplDelta && <i className={cplDelta.good ? "up" : "down"}>CPL vs semana anterior {cplDelta.pct > 0 ? "+" : ""}{num(cplDelta.pct, 1)}%</i>}
  </div>;
}
function ComparisonWindow({ row, days }: { row?: Row; days: number }) {
  if (!row) return <div className="mp-compare-window muted"><span>{days}d</span><b>—</b><small>sem snapshot</small></div>;
  return <div className={`mp-compare-window ${statusTone(row.data_status)}`}>
    <span>{days}d</span>
    <b>{money(row.spend)}</b>
    <small>{num(row.results)} res. · CPL {money(row.cpl)}</small>
  </div>;
}
function ClientPerformanceCard({ client, previous7, onOpen }: { client: Row; previous7?: Row; onOpen: () => void }) {
  const week = client.windows[7] as Row | undefined;
  const tone = statusTone(week?.data_status);
  const cplDelta = delta(week?.cpl, previous7?.cpl, true);
  return <article className={`mp-client-card ${tone}`}>
    <button className="mp-client-card-button" onClick={onOpen}>
      <div className="mp-client-identity">
        <div className="mp-client-status-line"><span className={`mp-status-dot ${tone}`}/><span>{statusLabel(week?.data_status)}</span></div>
        <h3>{client.client_name}</h3>
        <p>GT {client.gt_owner || "não definido"}</p>
        <small>{statusHint(week?.data_status)}</small>
      </div>

      <div className="mp-week-focus">
        <div className="mp-week-title"><span>ÚLTIMOS 7 DIAS</span>{week?.is_partial_period && <em>{week.available_period_days}/{week.requested_period_days} dias</em>}</div>
        <div className="mp-week-main">
          <div><small>Gasto</small><strong>{money(week?.spend)}</strong></div>
          <div><small>Resultados</small><strong>{num(week?.results)}</strong></div>
          <div><small>CPL / CPR</small><strong>{money(week?.cpl)}</strong></div>
        </div>
        <div className="mp-week-secondary">
          <span><small>CTR</small><b>{num(week?.ctr, 2)}%</b></span>
          <span><small>CPM</small><b>{money(week?.cpm)}</b></span>
          <span><small>Frequência</small><b>{num(week?.frequency, 2)}</b></span>
          {cplDelta ? <span className={cplDelta.good ? "good" : "bad-text"}><small>CPL vs semana anterior</small><b>{cplDelta.pct > 0 ? "+" : ""}{num(cplDelta.pct, 1)}%</b></span> : <span><small>CPL vs semana anterior</small><b>—</b></span>}
        </div>
      </div>

      <div className="mp-comparison-strip">
        <div className="mp-comparison-label"><span>CONTEXTO</span><small>Compare sem perder o foco dos 7d</small></div>
        <ComparisonWindow row={client.windows[3]} days={3}/>
        <ComparisonWindow row={client.windows[14]} days={14}/>
        <ComparisonWindow row={client.windows[30]} days={30}/>
      </div>

      <div className="mp-open-client"><span>Ver histórico</span><b>→</b></div>
    </button>
  </article>;
}

export default function MetaPerformancePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState<Row>({ runs: [], snapshots: [], previous_snapshots: [], coverage: {} });
  const [tab, setTab] = useState<Tab>("overview");
  const [query, setQuery] = useState("");
  const [gt, setGt] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [sort, setSort] = useState<SortMode>("ATTENTION");
  const [clientId, setClientId] = useState("");
  const [clientDetail, setClientDetail] = useState<Row | null>(null);
  const [clientLoading, setClientLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);
  const headers = useMemo(() => session?.access_token ? { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY } : null, [session?.access_token]);

  const load = useCallback(async (runId?: string) => {
    if (!headers) return;
    setLoading(true); setError("");
    try {
      const qs = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
      const response = await fetch(`${API}${qs}`, { headers, cache: "no-store" });
      if (response.status === 404) { window.location.replace("/"); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar Performance Meta."); }
    finally { setLoading(false); }
  }, [headers]);

  const openClient = useCallback(async (id: string, runId?: string) => {
    if (!headers) return;
    setClientId(id); setClientLoading(true); setClientDetail(null);
    const url = new URL(window.location.href); url.searchParams.set("client", id); if (runId) url.searchParams.set("run", runId); window.history.replaceState(null, "", url.toString());
    try {
      const params = new URLSearchParams({ client_id: id }); if (runId) params.set("run_id", runId);
      const response = await fetch(`${API}?${params}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setClientDetail(body);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao abrir histórico do cliente."); }
    finally { setClientLoading(false); }
  }, [headers]);

  useEffect(() => {
    if (!headers) return;
    const params = new URLSearchParams(window.location.search);
    const run = params.get("run") || undefined;
    void load(run).then(() => { const client = params.get("client"); if (client) void openClient(client, run); });
  }, [headers, load, openClient]);

  const snapshots: Row[] = payload.snapshots || [];
  const previous: Row[] = payload.previous_snapshots || [];
  const runs: Row[] = payload.runs || [];
  const coverage = payload.coverage || {};
  const prevMap = useMemo(() => new Map(previous.map((r: Row) => [`${r.client_id}:${r.period_days}`, r])), [previous]);
  const clients = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of snapshots) {
      const id = String(row.client_id); const current = map.get(id) || { client_id: id, client_name: row.client_name, gt_owner: row.gt_owner, windows: {} };
      current.windows[Number(row.period_days)] = row; map.set(id, current);
    }
    return [...map.values()];
  }, [snapshots]);
  const gtOptions = useMemo(() => [...new Set(clients.map((c) => String(c.gt_owner || "")).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR")), [clients]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    const filtered = clients.filter((c) => {
      const s7 = c.windows[7]?.data_status;
      return (!needle || [c.client_name,c.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle)) && (gt === "ALL" || c.gt_owner === gt) && (status === "ALL" || s7 === status);
    });
    const statusRank = (c: Row) => {
      const s = String(c.windows[7]?.data_status || "");
      if (["API_ERROR","NO_META_ACCOUNT"].includes(s)) return 0;
      if (["API_PARTIAL","NO_CAMPAIGNS","NO_DELIVERY","PARTIAL_PERIOD"].includes(s)) return 1;
      if (s === "OK") return 2;
      return 3;
    };
    return filtered.sort((a,b) => {
      if (sort === "ATTENTION") return statusRank(a)-statusRank(b) || String(a.client_name).localeCompare(String(b.client_name),"pt-BR");
      if (sort === "SPEND") return Number(b.windows[7]?.spend || 0)-Number(a.windows[7]?.spend || 0);
      if (sort === "CPL") {
        const ac=finite(a.windows[7]?.cpl), bc=finite(b.windows[7]?.cpl);
        return (ac ?? Number.POSITIVE_INFINITY)-(bc ?? Number.POSITIVE_INFINITY);
      }
      return String(a.client_name).localeCompare(String(b.client_name),"pt-BR");
    });
  }, [clients, query, gt, status, sort]);
  const focusSummary = useMemo(() => {
    const rows = visible.map(c=>c.windows[7]).filter(Boolean);
    const spend = rows.reduce((sum,row)=>sum+Number(row.spend||0),0);
    const withDelivery = rows.filter(row=>Number(row.spend||0)>0).length;
    const attention = visible.filter(c=>String(c.windows[7]?.data_status||"")!=="OK").length;
    const largest = visible.reduce<Row | null>((best,c)=>!best || Number(c.windows[7]?.spend||0)>Number(best.windows[7]?.spend||0)?c:best,null);
    return { spend, withDelivery, attention, largest };
  }, [visible]);

  function selectRun(id: string) {
    const url = new URL(window.location.href); url.searchParams.set("run", id); url.searchParams.delete("client"); window.history.replaceState(null, "", url.toString());
    setClientId(""); setClientDetail(null); void load(id);
  }
  async function download(mode: "summary" | "detailed", client?: string, runId?: string) {
    const effectiveRun = runId || String(payload.selected_run?.id || "");
    if (!headers || !effectiveRun) return;
    const params = new URLSearchParams({ export: mode, run_id: effectiveRun }); if (client) params.set("client_id", client);
    const response = await fetch(`${API}?${params}`, { headers, cache: "no-store" });
    if (!response.ok) { setError("Não foi possível gerar o CSV."); return; }
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "performance-meta.csv"; a.click(); URL.revokeObjectURL(url);
  }
  function closeClient() { setClientId(""); setClientDetail(null); const u = new URL(window.location.href); u.searchParams.delete("client"); window.history.replaceState(null,"",u.toString()); }

  if (!ready) return <main className="mp-loading">Validando sessão…</main>;
  const selectedRun = payload.selected_run;
  const completion = selectedRun?.total_clients ? Math.round(Number(selectedRun.processed_clients || 0) / Number(selectedRun.total_clients) * 100) : 0;
  const dataStatuses = ["OK","PARTIAL_PERIOD","NO_META_ACCOUNT","NO_CAMPAIGNS","NO_DELIVERY","API_PARTIAL","API_ERROR"];
  const status7Groups = dataStatuses.map(key => ({ key, label: statusLabel(key), rows: clients.filter(c => c.windows[7]?.data_status === key) })).filter(g => g.rows.length);
  const attentionAll = clients.filter(c=>String(c.windows[7]?.data_status||"")!=="OK").length;

  return <main className="mp-shell"><style>{styles}</style>
    <header className="mp-head"><div><button className="mp-back" onClick={()=>window.location.assign("/")}>← Central de Operações</button><span className="mp-kicker">ADLER · INTELIGÊNCIA DE TRÁFEGO</span><h1>Performance Meta</h1><p>Leia primeiro os últimos 7 dias e use 3, 14 e 30 dias apenas como contexto de tendência.</p></div><div className="mp-head-actions"><span>{loading ? "Sincronizando…" : selectedRun ? `Snapshot ${date(selectedRun.snapshot_date)}` : "Aguardando primeiro snapshot"}</span><button onClick={()=>load(selectedRun?.id)}>Atualizar</button></div></header>
    {error && <div className="mp-error">{error}</div>}

    <nav className="mp-tabs">{([["overview","Visão Geral"],["weekly","Relatório Semanal"],["history","Histórico"],["coverage","Cobertura / Integrações"],["exports","Exportações"]] as [Tab,string][]).map(([key,label])=><button key={key} className={tab===key?"active":""} onClick={()=>setTab(key)}>{label}</button>)}</nav>

    <section className="mp-kpis">
      <article><small>CLIENTES ATIVOS</small><b>{num(coverage.active_clients)}</b><span>base atual</span></article>
      <article><small>COM META</small><b>{num(coverage.integrated_clients)}</b><span>conta mapeada</span></article>
      <article><small>7D SAUDÁVEL</small><b>{num(coverage.ok)}</b><span>coleta íntegra</span></article>
      <article className={attentionAll?"warn":""}><small>PRECISAM ATENÇÃO</small><b>{num(attentionAll)}</b><span>status 7d diferente de OK</span></article>
      <article className={coverage.without_meta?"warn":""}><small>SEM META</small><b>{num(coverage.without_meta)}</b><span>integração ausente</span></article>
      <article className={coverage.api_issues?"bad":""}><small>PROBLEMAS API</small><b>{num(coverage.api_issues)}</b><span>na janela de 7 dias</span></article>
    </section>

    {selectedRun && ["RUNNING","PENDING"].includes(String(selectedRun.status)) && <section className="mp-progress"><div><b>Coleta em andamento</b><span>{selectedRun.processed_clients || 0} de {selectedRun.total_clients || 0} clientes</span></div><div><i style={{width:`${completion}%`}}/></div><strong>{completion}%</strong></section>}

    {(tab === "overview" || tab === "weekly") && <>
      <section className="mp-toolbar mp-toolbar-new">
        <div className="mp-toolbar-copy"><b>{tab === "overview" ? "Leitura rápida da carteira" : "Snapshot semanal"}</b><span>{selectedRun ? `Dados fechados até ${date(selectedRun.window_end)} · 7 dias é a referência principal` : "O primeiro snapshot aparecerá após a coleta."}</span></div>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente ou GT…"/>
        <select value={gt} onChange={e=>setGt(e.target.value)}><option value="ALL">Todos os GTs</option>{gtOptions.map(x=><option key={x}>{x}</option>)}</select>
        <select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">Todos os status</option><option value="OK">OK</option><option value="PARTIAL_PERIOD">Período parcial</option><option value="NO_META_ACCOUNT">Sem conta Meta</option><option value="NO_CAMPAIGNS">Sem campanha</option><option value="NO_DELIVERY">Sem entrega</option><option value="API_PARTIAL">API parcial</option><option value="API_ERROR">Erro API</option></select>
        <select value={sort} onChange={e=>setSort(e.target.value as SortMode)}><option value="ATTENTION">Problemas primeiro</option><option value="SPEND">Maior gasto 7d</option><option value="CPL">Menor CPL 7d</option><option value="NAME">A–Z</option></select>
      </section>

      <section className="mp-focus-summary">
        <article><small>GASTO 7D · FILTRO ATUAL</small><b>{money(focusSummary.spend)}</b><span>{visible.length} cliente(s) na leitura</span></article>
        <article><small>COM ENTREGA</small><b>{focusSummary.withDelivery}</b><span>gastaram na janela de 7 dias</span></article>
        <article className={focusSummary.attention?"warn":""}><small>ATENÇÃO</small><b>{focusSummary.attention}</b><span>precisam ser verificados</span></article>
        <article><small>MAIOR GASTO 7D</small><b className="client-name-kpi">{focusSummary.largest?.client_name || "—"}</b><span>{focusSummary.largest ? money(focusSummary.largest.windows[7]?.spend) : "sem dados"}</span></article>
      </section>

      <section className="mp-client-list">
        {visible.map(c=><ClientPerformanceCard key={c.client_id} client={c} previous7={prevMap.get(`${c.client_id}:7`)} onOpen={()=>openClient(c.client_id,selectedRun?.id)}/>) }
        {!visible.length&&<div className="mp-card mp-empty">Nenhum cliente nesse filtro.</div>}
      </section>
    </>}

    {tab === "history" && <section className="mp-card"><div className="mp-section-head"><div><h2>Histórico de snapshots</h2><p>Cada quinta-feira fica congelada. Abrir uma data não recalcula o passado.</p></div></div><div className="mp-run-list">{runs.map(run=><button key={run.id} className={String(run.id)===String(selectedRun?.id)?"active":""} onClick={()=>selectRun(String(run.id))}><span><b>{date(run.snapshot_date)}</b><small>dados até {date(run.window_end)}</small></span><span><b>{run.processed_clients}/{run.total_clients}</b><small>{statusLabel(run.status)}</small></span><span><b>{run.no_meta_clients || 0}</b><small>sem Meta</small></span><span><b>{run.error_clients || 0}</b><small>erros</small></span></button>)}{!runs.length&&<div className="mp-empty">Nenhum snapshot semanal ainda.</div>}</div></section>}

    {tab === "coverage" && <section className="mp-card"><div className="mp-section-head"><div><h2>Cobertura e integrações</h2><p>Todos os clientes ativos entram no relatório, inclusive quem não tem dado disponível.</p></div></div><div className="mp-status-grid">{status7Groups.map(group=><article key={group.key} className={statusTone(group.key)}><div><b>{group.label}</b><strong>{group.rows.length}</strong></div>{group.rows.slice(0,40).map(c=><button key={c.client_id} onClick={()=>openClient(c.client_id,selectedRun?.id)}>{c.client_name}<span>{c.gt_owner || "sem GT"}</span></button>)}</article>)}</div></section>}

    {tab === "exports" && <section className="mp-card"><div className="mp-section-head"><div><h2>Exportações CSV</h2><p>O CSV é gerado na hora a partir dos dados estruturados. O banco continua sendo a fonte histórica.</p></div></div><div className="mp-export-grid"><button onClick={()=>download("summary")}><b>CSV geral resumido</b><span>Cliente × janela 3/7/14/30 dias</span></button><button onClick={()=>download("detailed")}><b>CSV geral detalhado</b><span>Cliente × campanha × janela</span></button></div></section>}

    {(clientId || clientLoading) && <><div className="mp-overlay" onClick={closeClient}/><aside className="mp-drawer"><div className="mp-drawer-head"><button onClick={closeClient}>← Voltar</button><b>Histórico Meta do cliente</b></div>{clientLoading&&!clientDetail?<div className="mp-empty">Carregando histórico…</div>:clientDetail&&<ClientHistory detail={clientDetail} download={download} selectedRunId={String(selectedRun?.id||"")} openRun={(runId)=>{void load(runId);void openClient(clientId,runId);}}/>}</aside></>}
  </main>;
}

function ClientHistory({detail,download,selectedRunId,openRun}:{detail:Row;download:(mode:"summary"|"detailed",client?:string,runId?:string)=>Promise<void>;selectedRunId:string;openRun:(id:string)=>void}) {
  const client=detail.client||{}, snapshots:Row[]=detail.snapshots||[], campaigns:Row[]=detail.campaigns||[], runs:Row[]=detail.runs||[];
  const grouped=useMemo(()=>{const m=new Map<string,Row[]>();for(const s of snapshots)m.set(String(s.snapshot_date),[...(m.get(String(s.snapshot_date))||[]),s]);return [...m.entries()];},[snapshots]);
  const openRunId=String(detail.selected_run_id||selectedRunId||"");
  return <div className="mp-drawer-body"><section className="mp-client-hero"><span>CLIENTE</span><h2>{client.display_name||"Cliente"}</h2><p>GT {client.gt_owner||"não definido"} · entrada {date(client.entrada)}</p><div><button onClick={()=>download("summary",String(client.id),openRunId)}>CSV deste cliente</button><button onClick={()=>download("detailed",String(client.id),openRunId)}>CSV detalhado</button></div></section><section className="mp-client-runs"><label>Snapshot<select value={openRunId} onChange={e=>openRun(e.target.value)}>{runs.map(r=><option key={r.id} value={r.id}>{date(r.snapshot_date)} · {statusLabel(r.status)}</option>)}</select></label></section><section className="mp-client-history"><h3>Histórico de Performance</h3>{grouped.map(([day,rows])=><article key={day}><div><b>{date(day)}</b><small>{rows[0]?.run_id===openRunId?"snapshot aberto":"snapshot congelado"}</small></div><div>{WINDOWS.map(w=><Mini key={w} row={rows.find(x=>Number(x.period_days)===w)}/>)}</div></article>)}{!grouped.length&&<div className="mp-empty">Ainda não há snapshot deste cliente.</div>}</section><section className="mp-campaigns"><h3>Campanhas do snapshot selecionado</h3><p>Linhas do Meta que compõem as quatro janelas congeladas.</p><div className="mp-table"><table><thead><tr><th>Janela</th><th>Campanha</th><th>Gasto</th><th>Resultados</th><th>CPL/CPR</th><th>CTR</th></tr></thead><tbody>{campaigns.map((c:Row)=><tr key={`${c.period_days}-${c.meta_ad_account_id}-${c.campaign_id}`}><td>{c.period_days}d</td><td><b>{c.campaign_name||c.campaign_id}</b><small>{c.campaign_status||"—"} · {c.result_type||"resultado"}</small></td><td>{money(c.spend)}</td><td>{num(c.results)}</td><td>{money(c.cost_per_result ?? c.cpl)}</td><td>{num(c.ctr,2)}%</td></tr>)}{!campaigns.length&&<tr><td colSpan={6} className="mp-empty">Sem campanhas com entrega neste snapshot.</td></tr>}</tbody></table></div></section></div>;
}

const styles=`
*{box-sizing:border-box}.mp-shell{min-height:100vh;background:#07101b;color:#e8eef8;padding:28px max(16px,calc((100vw - 1580px)/2)) 70px;font-family:Inter,system-ui,sans-serif}.mp-loading{min-height:100vh;background:#07101b;color:#91a6bc;display:grid;place-items:center}.mp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:18px}.mp-head h1{font:800 36px/1 Inter Tight,Inter,sans-serif;letter-spacing:-1.2px;margin:8px 0}.mp-head p{margin:0;color:#8197ad;max-width:760px}.mp-kicker{font-size:9px;font-weight:900;letter-spacing:.14em;color:#68b7ff}.mp-back{border:0;background:none;color:#7d94aa;padding:0;cursor:pointer}.mp-head-actions{display:flex;align-items:center;gap:9px;color:#7790a8;font-size:10px}.mp-head-actions button,.mp-client-hero button{border:1px solid #285071;background:#10263a;color:#dcecff;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:800}.mp-error{padding:10px 12px;border:1px solid #713744;background:#311721;color:#ffabb4;border-radius:10px;margin-bottom:12px}.mp-tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:13px}.mp-tabs button{border:1px solid #1d354c;background:#0b1927;color:#859bb0;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700}.mp-tabs button.active{background:#173c5d;color:#dff1ff;border-color:#3476a9}.mp-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin-bottom:12px}.mp-kpis article,.mp-card,.mp-toolbar,.mp-table-card,.mp-focus-summary article{border:1px solid #183049;background:#0a1724;border-radius:13px}.mp-kpis article{padding:12px 13px}.mp-kpis small,.mp-focus-summary small{font-size:8px;font-weight:900;color:#68839c;letter-spacing:.07em}.mp-kpis b{display:block;font-size:24px;margin:4px 0}.mp-kpis span,.mp-focus-summary span{font-size:9px;color:#72889d}.mp-kpis article.warn,.mp-focus-summary article.warn{border-color:#6b4d28;background:#241d13}.mp-kpis article.bad{border-color:#6b303d;background:#2a161d}.mp-progress{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:13px;background:#0b1c2b;border:1px solid #285173;border-radius:11px;padding:10px 13px;margin-bottom:12px}.mp-progress b,.mp-progress span{display:block}.mp-progress span{font-size:9px;color:#7590a7}.mp-progress>div:nth-child(2){height:5px;background:#122b40;border-radius:999px;overflow:hidden}.mp-progress i{display:block;height:100%;background:#65b7ff}.mp-toolbar{display:grid;grid-template-columns:1.35fr 1fr .7fr .7fr .72fr;gap:8px;align-items:center;padding:11px;margin-bottom:9px}.mp-toolbar b,.mp-toolbar span{display:block}.mp-toolbar span{color:#728ba2;font-size:9px}.mp-toolbar input,.mp-toolbar select,.mp-client-runs select{border:1px solid #20415d;background:#071421;color:#cad8e6;border-radius:8px;padding:9px;min-width:0}.mp-focus-summary{display:grid;grid-template-columns:1.2fr .8fr .8fr 1.35fr;gap:9px;margin:0 0 10px}.mp-focus-summary article{padding:12px 14px;min-width:0}.mp-focus-summary b{display:block;font-size:21px;margin:4px 0;color:#f3f8fd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mp-focus-summary .client-name-kpi{font-size:15px;margin-top:8px}.mp-client-list{display:grid;gap:9px}.mp-client-card{border:1px solid #183249;border-radius:14px;background:#091724;overflow:hidden;transition:border-color .15s ease,transform .15s ease,background .15s ease}.mp-client-card:hover{border-color:#2d5777;background:#0b1b2a;transform:translateY(-1px)}.mp-client-card.warn{border-color:#5a4428}.mp-client-card.bad{border-color:#5b2d38}.mp-client-card-button{width:100%;display:grid;grid-template-columns:minmax(190px,.9fr) minmax(410px,1.8fr) minmax(330px,1.45fr) 90px;gap:12px;align-items:stretch;border:0;background:none;color:inherit;text-align:left;padding:0;cursor:pointer}.mp-client-identity{padding:16px 15px;border-right:1px solid #142d42;min-width:0}.mp-client-status-line{display:flex;align-items:center;gap:7px;color:#86a1b7;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}.mp-status-dot{width:7px;height:7px;border-radius:50%;background:#6ee7b7;box-shadow:0 0 0 3px rgba(110,231,183,.08)}.mp-status-dot.warn{background:#f0c36c;box-shadow:0 0 0 3px rgba(240,195,108,.08)}.mp-status-dot.bad{background:#ff8792;box-shadow:0 0 0 3px rgba(255,135,146,.08)}.mp-client-identity h3{font-size:15px;letter-spacing:-.01em;margin:9px 0 3px;color:#f1f6fb}.mp-client-identity p{margin:0;color:#7590a7;font-size:9px}.mp-client-identity>small{display:block;color:#647f95;font-size:8px;line-height:1.45;margin-top:10px}.mp-week-focus{padding:13px 5px 13px 2px;min-width:0}.mp-week-title{display:flex;justify-content:space-between;align-items:center;color:#66b9ff;font-size:8px;font-weight:900;letter-spacing:.08em;margin-bottom:9px}.mp-week-title em{font-style:normal;color:#dfb869;font-weight:700}.mp-week-main{display:grid;grid-template-columns:1.25fr .85fr 1fr;gap:7px}.mp-week-main>div{background:#0c1d2b;border:1px solid #19384f;border-radius:10px;padding:9px 10px}.mp-week-main small,.mp-week-secondary small{display:block;color:#718ca2;font-size:8px}.mp-week-main strong{display:block;font-size:17px;color:#f2f7fb;margin-top:4px}.mp-week-secondary{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:7px}.mp-week-secondary>span{padding:6px 8px;border-left:1px solid #18354b}.mp-week-secondary>span:first-child{border-left:0}.mp-week-secondary b{display:block;color:#cbdbe8;font-size:10px;margin-top:2px}.mp-week-secondary .good b{color:#75d5a0}.mp-week-secondary .bad-text b{color:#ff929a}.mp-comparison-strip{display:grid;grid-template-columns:.9fr repeat(3,1fr);gap:6px;align-items:center;padding:13px 5px;border-left:1px solid #142d42;min-width:0}.mp-comparison-label span,.mp-comparison-label small{display:block}.mp-comparison-label span{font-size:8px;font-weight:900;color:#6f8ba2;letter-spacing:.08em}.mp-comparison-label small{font-size:8px;color:#60798f;margin-top:4px}.mp-compare-window{border:1px solid #1b384e;background:#0a1926;border-radius:9px;padding:8px;min-width:0}.mp-compare-window>span{display:block;color:#7fa0b9;font-size:8px;font-weight:900}.mp-compare-window b{display:block;color:#d8e5ef;font-size:11px;margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mp-compare-window small{display:block;color:#6f889d;font-size:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mp-compare-window.warn{border-color:#5d472a}.mp-compare-window.bad{border-color:#5e303a}.mp-compare-window.muted{color:#60788d}.mp-open-client{display:flex;flex-direction:column;justify-content:center;align-items:center;border-left:1px solid #142d42;color:#74bfff;gap:8px;font-size:8px;font-weight:900;text-transform:uppercase}.mp-open-client b{font-size:20px}.mp-table-card{overflow:hidden}.mp-table{overflow:auto}.mp-table table{width:100%;border-collapse:collapse;min-width:900px}.mp-table th{text-align:left;color:#66829b;font-size:8px;letter-spacing:.07em;padding:9px 10px;border-bottom:1px solid #173047}.mp-table td{padding:9px 10px;border-bottom:1px solid #132a3e;vertical-align:top;font-size:10px}.mp-table td:first-child>button{border:0;background:none;color:#dfe9f3;text-align:left;cursor:pointer;min-width:180px}.mp-table td:first-child b,.mp-table td:first-child small,.mp-table td:first-child span{display:block}.mp-table td:first-child small{color:#70889f;margin:3px 0}.mp-table td:first-child span{font-size:8px;color:#8bb4d8}.mp-mini{min-width:205px;border:1px solid #23425a;border-radius:10px;padding:8px;background:#0b1926}.mp-mini>div{display:flex;justify-content:space-between;align-items:center;gap:7px}.mp-mini>div span{font-size:7px;font-weight:900;color:#81a0b9}.mp-mini strong,.mp-mini small,.mp-mini em,.mp-mini i{display:block}.mp-mini strong{margin:5px 0;font-size:13px}.mp-mini small{color:#899fb2;font-size:8px;margin-top:2px}.mp-mini em{color:#e1b96c;font-size:8px;margin-top:4px;font-style:normal}.mp-mini i{font-size:8px;margin-top:5px;font-style:normal}.mp-mini i.up{color:#79d6a3}.mp-mini i.down{color:#ff969e}.mp-mini.warn{border-color:#6a4c27}.mp-mini.bad{border-color:#6b303c}.empty-mini{color:#657f95;display:grid;place-items:center;min-height:90px}.mp-card{padding:15px}.mp-section-head h2{margin:0;font-size:18px}.mp-section-head p{margin:4px 0 13px;color:#748ba0;font-size:10px}.mp-run-list{display:grid;gap:7px}.mp-run-list>button{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:8px;text-align:left;border:1px solid #19364e;background:#091827;color:#d6e1eb;border-radius:9px;padding:10px;cursor:pointer}.mp-run-list>button.active{border-color:#4b8cbd;background:#10283b}.mp-run-list b,.mp-run-list small{display:block}.mp-run-list small{color:#6e879d;font-size:8px}.mp-status-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.mp-status-grid article{border:1px solid #24435a;border-radius:10px;padding:10px;background:#091725}.mp-status-grid article>div{display:flex;justify-content:space-between;margin-bottom:7px}.mp-status-grid article>button{width:100%;display:flex;justify-content:space-between;border:0;border-top:1px solid #183149;background:none;color:#c8d6e2;padding:7px 2px;cursor:pointer;text-align:left}.mp-status-grid article>button span{color:#6c879d;font-size:8px}.mp-status-grid article.warn{border-color:#684b27}.mp-status-grid article.bad{border-color:#6a303b}.mp-export-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mp-export-grid button{padding:20px;border:1px solid #275070;background:#0d2132;color:#dceaf6;border-radius:11px;text-align:left;cursor:pointer}.mp-export-grid b,.mp-export-grid span{display:block}.mp-export-grid span{color:#7891a8;margin-top:4px}.mp-empty{text-align:center;color:#688198;padding:26px}.mp-overlay{position:fixed;inset:0;z-index:300;background:rgba(1,6,12,.78);backdrop-filter:blur(5px)}.mp-drawer{position:fixed;z-index:301;right:0;top:0;height:100dvh;width:min(1050px,97vw);overflow:auto;background:#07111c;border-left:1px solid #26425b;box-shadow:-30px 0 90px rgba(0,0,0,.5)}.mp-drawer-head{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;padding:12px;background:#081522;border-bottom:1px solid #1c344a}.mp-drawer-head button{border:0;background:none;color:#90abc1;cursor:pointer}.mp-drawer-body{padding:15px}.mp-client-hero{border-bottom:1px solid #1a3349;padding-bottom:13px}.mp-client-hero>span{font-size:8px;font-weight:900;color:#68b7ff}.mp-client-hero h2{font:800 28px/1 Inter Tight,Inter,sans-serif;margin:5px 0}.mp-client-hero p{color:#7991a7;margin:0 0 10px}.mp-client-hero>div{display:flex;gap:7px}.mp-client-runs{padding:12px 0}.mp-client-runs label{font-size:9px;color:#7892aa;display:flex;gap:8px;align-items:center}.mp-client-history h3,.mp-campaigns h3{margin:10px 0}.mp-client-history>article{border:1px solid #193349;border-radius:11px;padding:10px;margin:8px 0}.mp-client-history>article>div:first-child{display:flex;justify-content:space-between}.mp-client-history>article>div:first-child small{color:#6f879c}.mp-client-history>article>div:last-child{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px}.mp-client-history .mp-mini{min-width:0}.mp-campaigns{margin-top:16px;border-top:1px solid #183249;padding-top:8px}.mp-campaigns>p{color:#71899e}.mp-campaigns td b,.mp-campaigns td small{display:block}.mp-campaigns td small{color:#71899e}.ok{}.warn{}.bad{}@media(max-width:1300px){.mp-client-card-button{grid-template-columns:minmax(180px,.8fr) minmax(390px,1.7fr) minmax(285px,1.25fr) 72px}.mp-comparison-strip{grid-template-columns:repeat(3,1fr)}.mp-comparison-label{grid-column:1/-1}}@media(max-width:1200px){.mp-kpis{grid-template-columns:repeat(3,1fr)}.mp-toolbar{grid-template-columns:1fr 1fr 1fr}.mp-toolbar-copy{grid-column:1/-1}.mp-focus-summary{grid-template-columns:1fr 1fr}.mp-client-card-button{grid-template-columns:210px 1fr 90px}.mp-comparison-strip{grid-column:2/3;border-left:0;border-top:1px solid #142d42;padding-top:9px}.mp-week-focus{grid-column:2/3}.mp-open-client{grid-column:3/4;grid-row:1/3}.mp-client-identity{grid-row:1/3}}@media(max-width:850px){.mp-client-card-button{display:block}.mp-client-identity,.mp-comparison-strip,.mp-open-client{border:0;border-top:1px solid #142d42}.mp-client-identity{border-top:0}.mp-week-focus{padding:13px 15px}.mp-comparison-strip{padding:13px 15px}.mp-open-client{flex-direction:row;padding:12px}.mp-week-secondary{grid-template-columns:1fr 1fr}.mp-status-grid{grid-template-columns:1fr 1fr}.mp-client-history>article>div:last-child{grid-template-columns:1fr 1fr}}@media(max-width:650px){.mp-shell{padding:18px 10px 60px}.mp-head{display:block}.mp-head-actions{margin-top:12px}.mp-kpis,.mp-status-grid,.mp-export-grid,.mp-toolbar,.mp-focus-summary{grid-template-columns:1fr}.mp-client-history>article>div:last-child{grid-template-columns:1fr}.mp-progress{grid-template-columns:1fr}.mp-run-list>button{grid-template-columns:1fr 1fr}.mp-week-main{grid-template-columns:1fr 1fr}.mp-week-main>div:first-child{grid-column:1/-1}.mp-comparison-strip{grid-template-columns:1fr 1fr}.mp-comparison-label{grid-column:1/-1}}
`;