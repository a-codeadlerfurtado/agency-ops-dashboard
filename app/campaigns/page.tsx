"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaigns-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type Payload = { clients: Row[]; campaigns: Row[]; summary: Row; profile?: Row };
type LifeFilter = "ACTIVE" | "CHURNED" | "ALL";
type DeliveryFilter = "ALL" | "ACTIVE_DELIVERY" | "NO_META_ACCOUNT" | "NO_DELIVERY" | "NO_ACTIVE_CAMPAIGN" | "NO_CAMPAIGNS" | "CHURNED_WITH_DELIVERY";
type PeriodKey = "TODAY" | "YESTERDAY" | "LAST_7D" | "LAST_14D" | "LAST_28D" | "LAST_30D" | "THIS_MONTH" | "LAST_MONTH" | "LAST_90D" | "CUSTOM";
type DateRange = { since: string; until: string; label: string };

const statusLabel: Record<string, string> = {
  ACTIVE_DELIVERY: "Com entrega",
  NO_META_ACCOUNT: "Sem conta Meta",
  NO_DELIVERY: "Campanha ativa sem entrega",
  NO_ACTIVE_CAMPAIGN: "Sem campanha ativa",
  NO_CAMPAIGNS: "Nenhuma campanha encontrada",
  CHURNED_WITH_DELIVERY: "Churned com entrega",
  ACTIVE: "Ativa",
  PAUSED: "Pausada",
  ARCHIVED: "Arquivada",
  CHURNED: "Churned",
  ONBOARDING: "Onboarding",
};
const statusTone: Record<string, string> = {
  ACTIVE_DELIVERY: "ok", NO_META_ACCOUNT: "bad", NO_DELIVERY: "warn", NO_ACTIVE_CAMPAIGN: "muted",
  NO_CAMPAIGNS: "muted", CHURNED_WITH_DELIVERY: "bad", ACTIVE: "ok", PAUSED: "muted",
  ARCHIVED: "muted", CHURNED: "bad", ONBOARDING: "warn",
};
const periodOptions: { key: PeriodKey; label: string }[] = [
  { key: "TODAY", label: "Hoje" },
  { key: "YESTERDAY", label: "Ontem" },
  { key: "LAST_7D", label: "Últimos 7 dias" },
  { key: "LAST_14D", label: "Últimos 14 dias" },
  { key: "LAST_28D", label: "Últimos 28 dias" },
  { key: "LAST_30D", label: "Últimos 30 dias" },
  { key: "THIS_MONTH", label: "Este mês" },
  { key: "LAST_MONTH", label: "Mês passado" },
  { key: "LAST_90D", label: "Últimos 90 dias" },
  { key: "CUSTOM", label: "Personalizado" },
];

function isoDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function shiftDays(date: Date, days: number) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}
function rangeFor(key: Exclude<PeriodKey, "CUSTOM">): DateRange {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "TODAY") return { since: isoDate(today), until: isoDate(today), label: "Hoje" };
  if (key === "YESTERDAY") { const d = shiftDays(today, -1); return { since: isoDate(d), until: isoDate(d), label: "Ontem" }; }
  if (key === "LAST_7D") return { since: isoDate(shiftDays(today, -6)), until: isoDate(today), label: "Últimos 7 dias" };
  if (key === "LAST_14D") return { since: isoDate(shiftDays(today, -13)), until: isoDate(today), label: "Últimos 14 dias" };
  if (key === "LAST_28D") return { since: isoDate(shiftDays(today, -27)), until: isoDate(today), label: "Últimos 28 dias" };
  if (key === "LAST_30D") return { since: isoDate(shiftDays(today, -29)), until: isoDate(today), label: "Últimos 30 dias" };
  if (key === "LAST_90D") return { since: isoDate(shiftDays(today, -89)), until: isoDate(today), label: "Últimos 90 dias" };
  if (key === "THIS_MONTH") return { since: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), until: isoDate(today), label: "Este mês" };
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const last = new Date(today.getFullYear(), today.getMonth(), 0);
  return { since: isoDate(first), until: isoDate(last), label: "Mês passado" };
}
function money(v: unknown, precise = false) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: precise ? 2 : 0, maximumFractionDigits: precise ? 2 : 0 }).format(Number(v || 0));
}
function num(v: unknown, digits = 0) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(v || 0)); }
function day(v: unknown) {
  if (!v) return "—";
  const raw = String(v).slice(0, 10), [y, m, d] = raw.split("-").map(Number);
  return y && m && d ? new Intl.DateTimeFormat("pt-BR").format(new Date(y, m - 1, d)) : raw;
}
function dateTime(v: unknown) { return v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(v))) : "—"; }
function Pill({ value }: { value: unknown }) {
  const raw = String(value || "—");
  return <span className={`mc-pill ${statusTone[raw] || "muted"}`}>{statusLabel[raw] || raw.replaceAll("_", " ")}</span>;
}

export default function CampaignsPage() {
  const initial = rangeFor("YESTERDAY");
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [life, setLife] = useState<LifeFilter>("ACTIVE");
  const [delivery, setDelivery] = useState<DeliveryFilter>("ALL");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("YESTERDAY");
  const [appliedRange, setAppliedRange] = useState<DateRange>(initial);
  const [customSince, setCustomSince] = useState(initial.since);
  const [customUntil, setCustomUntil] = useState(initial.until);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const url = new URL(API_URL);
      url.searchParams.set("lifecycle", life);
      url.searchParams.set("details", "1");
      url.searchParams.set("since", appliedRange.since);
      url.searchParams.set("until", appliedRange.until);
      url.searchParams.set("period_label", appliedRange.label);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar campanhas");
    } finally { setLoading(false); }
  }, [session?.access_token, life, appliedRange.since, appliedRange.until, appliedRange.label]);

  useEffect(() => { load(); }, [load]);

  function changePeriod(next: PeriodKey) {
    setPeriod(next);
    setExpanded(null);
    if (next !== "CUSTOM") setAppliedRange(rangeFor(next));
  }
  function applyCustom() {
    if (!customSince || !customUntil || customSince > customUntil) { setError("Confira as datas do período personalizado."); return; }
    setError("");
    setAppliedRange({ since: customSince, until: customUntil, label: "Personalizado" });
    setExpanded(null);
  }

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    const rank: Record<string, number> = { CHURNED_WITH_DELIVERY: 0, NO_META_ACCOUNT: 1, NO_DELIVERY: 2, NO_CAMPAIGNS: 3, NO_ACTIVE_CAMPAIGN: 4, ACTIVE_DELIVERY: 5 };
    return (payload?.clients || [])
      .filter((row) => (delivery === "ALL" || row.delivery_status === delivery) && (!needle || [row.display_name, row.gt_owner, row.configured_account_names].join(" ").toLocaleLowerCase("pt-BR").includes(needle)))
      .sort((a, b) => (rank[a.delivery_status] ?? 9) - (rank[b.delivery_status] ?? 9) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR"));
  }, [payload, delivery, query]);
  const campaignByClient = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of payload?.campaigns || []) map.set(row.client_id, [...(map.get(row.client_id) || []), row]);
    return map;
  }, [payload]);
  const s = payload?.summary || {};
  const rangeText = `${day(s.since || appliedRange.since)} → ${day(s.until || appliedRange.until)}`;

  if (!ready) return <main className="mc-loading">Validando sessão…</main>;
  return <main className="mc-shell"><style>{styles}</style>
    <header className="mc-top">
      <div>
        <button className="mc-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
        <span className="mc-kicker">META ADS · CONSULTA DIRETA</span>
        <h1>Campanhas</h1>
        <p>Performance por período consultada diretamente na Meta Marketing API, com resultado canônico sem duplicar conversões.</p>
      </div>
      <div className="mc-top-actions">
        <span className={`mc-live ${loading ? "loading" : ""}`}>{loading ? "Consultando Meta…" : `Consultado · ${dateTime(s.fetched_at || s.checked_at)}`}</span>
        <button onClick={load} disabled={loading}>Atualizar</button>
      </div>
    </header>

    <section className="mc-toolbar">
      <div className="mc-period-main">
        <label>Período</label>
        <select value={period} onChange={(e) => changePeriod(e.target.value as PeriodKey)} disabled={loading}>
          {periodOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
        {period === "CUSTOM" && <div className="mc-custom-range">
          <input type="date" value={customSince} onChange={(e) => setCustomSince(e.target.value)} />
          <span>até</span>
          <input type="date" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)} />
          <button onClick={applyCustom} disabled={loading}>Aplicar</button>
        </div>}
      </div>
      <div className="mc-range-badge"><small>INTERVALO APLICADO</small><b>{rangeText}</b><span>{appliedRange.label}</span></div>
    </section>

    <section className="mc-source-strip">
      <div><small>FONTE</small><b>Meta Marketing API</b><span>Graph API {s.graph_api_version || "v21.0"} · nível campanha</span></div>
      <div><small>PERÍODO CONSULTADO</small><b>{rangeText}</b><span>{Number(s.day_count || 1)} dia(s)</span></div>
      <div><small>CONSULTA</small><b>{loading ? "Em andamento" : "Ao vivo"}</b><span>{num(s.accounts_succeeded)} de {num(s.accounts_queried)} contas respondendo</span></div>
      <div><small>ORIGEM DO STATUS</small><b>Meta + inventário</b><span>Campanhas ativas/pausadas permanecem visíveis com R$ 0</span></div>
    </section>

    <section className="mc-tabs">
      {([['ACTIVE', 'Ativos'], ['CHURNED', 'Churned'], ['ALL', 'Todos']] as [LifeFilter, string][]).map(([key, label]) => <button key={key} className={life === key ? "active" : ""} onClick={() => { setLife(key); setDelivery("ALL"); setExpanded(null); }}>{label}</button>)}
    </section>

    {error && <div className="mc-error"><b>Falha na leitura</b><span>{error}</span></div>}
    {Number(s.accounts_failed) > 0 && <div className="mc-warning"><b>Consulta parcial:</b><span>{num(s.accounts_failed)} conta(s) Meta não responderam nesta leitura. Os demais números foram calculados normalmente.</span></div>}

    <section className="mc-metrics">
      <Metric title="Investimento" value={money(s.spend, true)} hint={rangeText} />
      <Metric title="Resultados" value={num(s.results)} hint="lead ou conversa conforme a campanha" />
      <Metric title="Custo por resultado" value={s.cost_per_result == null ? "—" : money(s.cost_per_result, true)} hint="investimento ÷ resultado canônico" />
      <Metric title="CTR" value={s.ctr == null ? "—" : `${num(s.ctr, 2)}%`} hint="cliques ÷ impressões no período" />
    </section>

    <section className="mc-coverage">
      <Coverage filter="ACTIVE_DELIVERY" current={delivery} set={setDelivery} count={s.active_delivery} text="com entrega" tone="ok" />
      <Coverage filter="NO_DELIVERY" current={delivery} set={setDelivery} count={s.no_delivery} text="campanha ativa sem entrega" tone="warn" />
      <Coverage filter="NO_ACTIVE_CAMPAIGN" current={delivery} set={setDelivery} count={s.no_active_campaign} text="sem campanha ativa" tone="muted" />
      <Coverage filter="NO_CAMPAIGNS" current={delivery} set={setDelivery} count={s.no_campaigns} text="sem campanhas encontradas" tone="muted" />
      <Coverage filter="NO_META_ACCOUNT" current={delivery} set={setDelivery} count={s.no_meta_account} text="sem conta Meta" tone="bad" />
      {Number(s.churned_with_delivery) > 0 && <Coverage filter="CHURNED_WITH_DELIVERY" current={delivery} set={setDelivery} count={s.churned_with_delivery} text="churned com entrega" tone="bad" />}
    </section>

    <section className="mc-panel">
      <div className="mc-panel-head">
        <div><h2>Diagnóstico por cliente</h2><p>{rows.length} de {num(s.clients_total)} clientes · métricas referentes a {rangeText}</p></div>
        <div className="mc-search"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, GT ou conta Meta" />{delivery !== "ALL" && <button onClick={() => setDelivery("ALL")}>Limpar status</button>}</div>
      </div>
      <div className="mc-table-wrap"><table><thead><tr><th>Cliente / conta</th><th>Situação no período</th><th>Campanhas</th><th>Investimento</th><th>Resultados</th><th>Custo/result.</th><th>CTR</th><th>Leitura</th></tr></thead><tbody>
        {rows.map((row) => { const details = campaignByClient.get(row.client_id) || []; const open = expanded === row.client_id; return <ClientRows key={row.client_id} row={row} details={details} open={open} toggle={() => setExpanded(open ? null : row.client_id)} rangeText={rangeText} />; })}
        {!rows.length && !loading && <tr><td colSpan={8} className="mc-empty">Nenhum cliente nesse filtro.</td></tr>}
      </tbody></table></div>
    </section>

    <footer className="mc-note"><b>Como os dados são obtidos:</b> ao trocar o período, o dashboard envia as datas para a Meta Marketing API e consulta os insights no nível de campanha. O banco local continua guardando snapshots e o inventário, mas os cards desta tela usam o intervalo escolhido. “Resultados” usa uma única conversão canônica por campanha; formulários priorizam lead e campanhas de mensagem priorizam conversa iniciada/conexão.</footer>
  </main>;
}

function Metric({ title, value, hint }: { title: string; value: string; hint: string }) { return <article><small>{title}</small><strong>{value}</strong><span>{hint}</span></article>; }
function Coverage({ filter, current, set, count, text, tone }: { filter: DeliveryFilter; current: DeliveryFilter; set: (v: DeliveryFilter) => void; count: unknown; text: string; tone: string }) {
  return <button className={current === filter ? "active" : ""} onClick={() => set(current === filter ? "ALL" : filter)}><i className={tone} /><span><b>{num(count)}</b> {text}</span></button>;
}
function ClientRows({ row, details, open, toggle, rangeText }: { row: Row; details: Row[]; open: boolean; toggle: () => void; rangeText: string }) {
  const hasDetails = details.length > 0;
  return <>
    <tr className={`mc-client-row ${row.delivery_status === 'CHURNED_WITH_DELIVERY' ? 'danger' : ''}`} onClick={hasDetails ? toggle : undefined}>
      <td><div className="mc-client"><span className="mc-chevron">{hasDetails ? (open ? '−' : '+') : '·'}</span><span><b>{row.display_name}</b><small>{row.configured_account_names || "Conta Meta não configurada"}{row.gt_owner ? ` · GT ${row.gt_owner}` : ""}</small></span></div></td>
      <td><Pill value={row.delivery_status} />{row.partial_data && <small className="mc-partial">leitura parcial</small>}</td>
      <td><b>{num(row.active_campaigns)}</b><small> ativas / {num(row.campaign_count)} total</small></td>
      <td>{money(row.spend, true)}</td><td>{num(row.results)}</td><td>{Number(row.results) > 0 ? money(row.cost_per_result, true) : "—"}</td><td>{row.ctr == null ? "—" : `${num(row.ctr, 2)}%`}</td><td><b>Ao vivo</b><small className="mc-block">{row.checked_at ? dateTime(row.checked_at) : "sem conta vinculada"}</small></td>
    </tr>
    {open && <tr className="mc-detail-row"><td colSpan={8}><div className="mc-detail"><div className="mc-detail-title">Campanhas · {rangeText}</div>{details.map((c) => <div className={`mc-campaign ${c.has_delivery ? '' : 'no-delivery'}`} key={`${c.meta_ad_account_id}-${c.campaign_id}`}><div className="mc-campaign-name"><Pill value={c.campaign_status} /><span><b>{c.campaign_name || c.campaign_id}</b><small>{c.objective || "objetivo não informado"} · {c.account_key || c.meta_ad_account_id}</small></span></div><Stat t="Invest." v={money(c.spend, true)} /><Stat t="Resultado" v={c.result_count == null ? "—" : num(c.result_count)} sub={c.result_type || (!c.has_delivery ? "SEM ENTREGA" : "—")} /><Stat t="Custo/result." v={c.cost_per_result == null ? "—" : money(c.cost_per_result, true)} /><Stat t="CTR" v={c.ctr == null ? "—" : `${num(c.ctr, 2)}%`} /><Stat t="CPM" v={c.cpm == null ? "—" : money(c.cpm, true)} /></div>)}</div></td></tr>}
  </>;
}
function Stat({ t, v, sub }: { t: string; v: string; sub?: string }) { return <span><small>{t}</small><b>{v}</b>{sub && <em>{sub}</em>}</span>; }

const styles = `
:root{--mc-bg:#06111f;--mc-panel:#0a1727;--mc-panel2:#0e1e31;--mc-line:rgba(149,176,210,.14);--mc-text:#edf5ff;--mc-muted:#8094ad;--mc-blue:#73a7ff;--mc-green:#31d49b;--mc-yellow:#f7c95c;--mc-red:#ff6b75}[data-theme="light"]{--mc-bg:#f5f8fc;--mc-panel:#fff;--mc-panel2:#f7f9fc;--mc-line:#dce5ef;--mc-text:#142033;--mc-muted:#617085}body{background:var(--mc-bg)}.mc-shell{min-height:100vh;padding:34px 38px 90px;color:var(--mc-text);background:radial-gradient(circle at 75% -20%,rgba(46,108,190,.16),transparent 38%),var(--mc-bg);font-family:Inter,system-ui,sans-serif}.mc-loading{min-height:100vh;display:grid;place-items:center;background:#06111f;color:#fff}.mc-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;max-width:1500px;margin:auto}.mc-back{border:0;background:transparent;color:var(--mc-muted);padding:0;margin:0 0 28px;cursor:pointer;font-size:12px}.mc-kicker{display:block;font-size:10px;letter-spacing:.16em;color:#58b8ff;font-weight:800}.mc-top h1{font:800 clamp(36px,5vw,58px)/1 Inter Tight,Inter,sans-serif;margin:8px 0}.mc-top p{max-width:790px;color:var(--mc-muted);font-size:13px;line-height:1.6}.mc-top-actions{display:flex;align-items:center;gap:10px;margin-top:8px}.mc-top-actions button,.mc-search button,.mc-custom-range button{background:var(--mc-panel2);color:var(--mc-text);border:1px solid var(--mc-line);border-radius:9px;padding:9px 13px;cursor:pointer}.mc-top-actions button:disabled,.mc-custom-range button:disabled{opacity:.55;cursor:wait}.mc-live{font-size:10px;color:var(--mc-green)}.mc-live.loading{color:var(--mc-yellow)}
.mc-toolbar{max-width:1500px;margin:28px auto 12px;padding:13px 14px;border:1px solid var(--mc-line);border-radius:13px;background:rgba(10,23,39,.72);display:flex;justify-content:space-between;align-items:center;gap:14px}.mc-period-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mc-period-main>label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--mc-muted);font-weight:800}.mc-period-main select,.mc-custom-range input{background:var(--mc-panel2);border:1px solid var(--mc-line);color:var(--mc-text);border-radius:9px;padding:10px 12px;font:600 12px Inter,system-ui}.mc-custom-range{display:flex;align-items:center;gap:8px}.mc-custom-range span{font-size:11px;color:var(--mc-muted)}.mc-range-badge{text-align:right}.mc-range-badge small,.mc-source-strip small{display:block;font-size:9px;letter-spacing:.1em;color:var(--mc-muted);font-weight:800}.mc-range-badge b{display:block;font-size:13px;margin-top:3px}.mc-range-badge span{font-size:10px;color:var(--mc-muted)}
.mc-source-strip{max-width:1500px;margin:10px auto 4px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.mc-source-strip>div{border:1px solid var(--mc-line);background:rgba(8,20,34,.72);border-radius:11px;padding:11px 13px}.mc-source-strip b{display:block;font-size:12px;margin:4px 0 2px}.mc-source-strip span{display:block;font-size:10px;color:var(--mc-muted);line-height:1.4}
.mc-tabs{max-width:1500px;margin:18px auto 14px;display:flex;gap:6px;border-bottom:1px solid var(--mc-line)}.mc-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--mc-muted);padding:10px 15px;cursor:pointer;font-weight:700;font-size:12px}.mc-tabs button.active{color:var(--mc-text);border-color:var(--mc-blue)}.mc-error,.mc-warning{max-width:1500px;margin:10px auto;padding:12px 14px;border-radius:10px;display:flex;gap:12px;font-size:11px}.mc-error{border:1px solid rgba(255,107,117,.35);background:rgba(255,107,117,.08)}.mc-warning{border:1px solid rgba(247,201,92,.28);background:rgba(247,201,92,.07);color:#f3d98e}
.mc-metrics{max-width:1500px;margin:18px auto 10px;display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.mc-metrics article{background:var(--mc-panel);border:1px solid var(--mc-line);border-radius:13px;padding:17px}.mc-metrics small{display:block;color:var(--mc-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.mc-metrics strong{display:block;font-size:27px;margin:10px 0 8px;letter-spacing:-.03em}.mc-metrics span{font-size:10px;color:var(--mc-muted)}
.mc-coverage{max-width:1500px;margin:12px auto 20px;display:flex;gap:7px;flex-wrap:wrap}.mc-coverage button{display:flex;align-items:center;gap:7px;border:1px solid var(--mc-line);border-radius:999px;padding:8px 11px;background:transparent;color:var(--mc-text);font-size:10px;cursor:pointer}.mc-coverage button.active{background:var(--mc-panel2);border-color:rgba(115,167,255,.45)}.mc-coverage i{width:7px;height:7px;border-radius:50%;background:var(--mc-muted)}.mc-coverage i.ok{background:var(--mc-green)}.mc-coverage i.warn{background:#b18400}.mc-coverage i.bad{background:#c90014}
.mc-panel{max-width:1500px;margin:auto;border:1px solid var(--mc-line);border-radius:14px;background:var(--mc-panel);overflow:hidden}.mc-panel-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 20px;border-bottom:1px solid var(--mc-line)}.mc-panel-head h2{font-size:14px;margin:0 0 4px}.mc-panel-head p{font-size:10px;color:var(--mc-muted);margin:0}.mc-search{display:flex;gap:7px}.mc-search input{min-width:270px;border:1px solid var(--mc-line);border-radius:9px;background:var(--mc-panel2);color:var(--mc-text);padding:9px 12px;font-size:11px}.mc-table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1100px}th{text-align:left;color:var(--mc-muted);font-size:9px;text-transform:uppercase;letter-spacing:.07em;padding:10px 14px;border-bottom:1px solid var(--mc-line)}td{padding:11px 14px;border-bottom:1px solid var(--mc-line);font-size:11px;vertical-align:middle}.mc-client-row{cursor:pointer}.mc-client-row:hover{background:rgba(115,167,255,.035)}.mc-client-row.danger{background:rgba(255,107,117,.035)}.mc-client{display:flex;gap:9px;align-items:center}.mc-client b{display:block;font-size:11px}.mc-client small,td small{color:var(--mc-muted);font-size:9px}.mc-chevron{width:17px;height:17px;border:1px solid var(--mc-line);display:grid;place-items:center;border-radius:5px;color:var(--mc-muted)}.mc-block{display:block;margin-top:3px}.mc-partial{display:block;margin-top:4px;color:var(--mc-yellow)!important}.mc-pill{display:inline-flex;border-radius:999px;padding:4px 7px;font-size:8px;font-weight:800;letter-spacing:.04em;border:1px solid var(--mc-line)}.mc-pill.ok{color:var(--mc-green);background:rgba(49,212,155,.06)}.mc-pill.warn{color:var(--mc-yellow);background:rgba(247,201,92,.06)}.mc-pill.bad{color:var(--mc-red);background:rgba(255,107,117,.06)}.mc-pill.muted{color:var(--mc-muted)}
.mc-detail-row>td{padding:0}.mc-detail{background:rgba(3,11,20,.44);padding:13px 20px 18px}.mc-detail-title{font-size:9px;text-transform:uppercase;letter-spacing:.09em;color:var(--mc-muted);margin-bottom:9px}.mc-campaign{display:grid;grid-template-columns:minmax(300px,2.2fr) repeat(5,minmax(90px,.55fr));gap:12px;align-items:center;border-top:1px solid var(--mc-line);padding:10px 0}.mc-campaign.no-delivery{opacity:.58}.mc-campaign-name{display:flex;align-items:center;gap:9px;min-width:0}.mc-campaign-name span{min-width:0}.mc-campaign-name b{display:block;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mc-campaign-name small{display:block;margin-top:3px;color:var(--mc-muted);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mc-campaign>span small{display:block;color:var(--mc-muted);font-size:8px}.mc-campaign>span b{display:block;font-size:10px;margin-top:3px}.mc-campaign em{display:block;color:var(--mc-muted);font-style:normal;font-size:7px;margin-top:2px}.mc-empty{text-align:center;color:var(--mc-muted);padding:30px}.mc-note{max-width:1500px;margin:14px auto 0;color:var(--mc-muted);font-size:10px;line-height:1.6;padding:0 4px}.mc-note b{color:var(--mc-text)}
@media(max-width:1000px){.mc-shell{padding:22px 16px 70px}.mc-top{flex-direction:column}.mc-top-actions{align-self:stretch;justify-content:space-between}.mc-toolbar{align-items:flex-start;flex-direction:column}.mc-range-badge{text-align:left}.mc-source-strip{grid-template-columns:1fr 1fr}.mc-metrics{grid-template-columns:1fr 1fr}.mc-panel-head{align-items:stretch;flex-direction:column}.mc-search input{min-width:0;flex:1}.mc-campaign{grid-template-columns:minmax(240px,2fr) repeat(5,minmax(80px,.6fr))}}@media(max-width:620px){.mc-source-strip,.mc-metrics{grid-template-columns:1fr}.mc-custom-range{width:100%;flex-wrap:wrap}.mc-period-main select{width:100%}.mc-top h1{font-size:42px}}
`;
