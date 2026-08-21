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
type ClientTab = "summary" | "strategy" | "audience" | "campaigns" | "integrations" | "history";

const statusLabel: Record<string, string> = {
  ACTIVE_DELIVERY: "Com entrega",
  NO_META_ACCOUNT: "Sem conta Meta",
  NO_DELIVERY: "Ativa sem entrega",
  NO_ACTIVE_CAMPAIGN: "Sem campanha ativa",
  NO_CAMPAIGNS: "Sem campanhas",
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
  { key: "TODAY", label: "Hoje" }, { key: "YESTERDAY", label: "Ontem" }, { key: "LAST_7D", label: "Últimos 7 dias" },
  { key: "LAST_14D", label: "Últimos 14 dias" }, { key: "LAST_28D", label: "Últimos 28 dias" }, { key: "LAST_30D", label: "Últimos 30 dias" },
  { key: "THIS_MONTH", label: "Este mês" }, { key: "LAST_MONTH", label: "Mês passado" }, { key: "LAST_90D", label: "Últimos 90 dias" },
  { key: "CUSTOM", label: "Personalizado" },
];

function isoDate(date: Date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0"), d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function shiftDays(date: Date, days: number) { const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate()); copy.setDate(copy.getDate() + days); return copy; }
function rangeFor(key: Exclude<PeriodKey, "CUSTOM">): DateRange {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "TODAY") return { since: isoDate(today), until: isoDate(today), label: "Hoje" };
  if (key === "YESTERDAY") { const d = shiftDays(today, -1); return { since: isoDate(d), until: isoDate(d), label: "Ontem" }; }
  if (key === "LAST_7D") return { since: isoDate(shiftDays(today, -6)), until: isoDate(today), label: "Últimos 7 dias" };
  if (key === "LAST_14D") return { since: isoDate(shiftDays(today, -13)), until: isoDate(today), label: "Últimos 14 dias" };
  if (key === "LAST_28D") return { since: isoDate(shiftDays(today, -27)), until: isoDate(today), label: "Últimos 28 dias" };
  if (key === "LAST_30D") return { since: isoDate(shiftDays(today, -29)), until: isoDate(today), label: "Últimos 30 dias" };
  if (key === "LAST_90D") return { since: isoDate(shiftDays(today, -89)), until: isoDate(today), label: "Últimos 90 dias" };
  if (key === "THIS_MONTH") return { since: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), until: isoDate(today), label: "Este mês" };
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1), last = new Date(today.getFullYear(), today.getMonth(), 0);
  return { since: isoDate(first), until: isoDate(last), label: "Mês passado" };
}
function money(v: unknown, precise = false) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: precise ? 2 : 0, maximumFractionDigits: precise ? 2 : 0 }).format(Number(v || 0)); }
function num(v: unknown, digits = 0) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(v || 0)); }
function day(v: unknown) {
  if (!v) return "—";
  const raw = String(v).slice(0, 10), [y, m, d] = raw.split("-").map(Number);
  return y && m && d ? new Intl.DateTimeFormat("pt-BR").format(new Date(y, m - 1, d)) : raw;
}
function dateTime(v: unknown) { return v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(v))) : "—"; }
function Pill({ value }: { value: unknown }) { const raw = String(value || "—"); return <span className={`tc-pill ${statusTone[raw] || "muted"}`}>{statusLabel[raw] || raw.replaceAll("_", " ")}</span>; }
function isEmpty(value: unknown) { return value == null || value === "" || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as Row).length); }
function flatten(value: unknown): string[] {
  if (isEmpty(value)) return [];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === "object") return Object.entries(value as Row).flatMap(([key, item]) => {
    if (isEmpty(item)) return [];
    const label: Record<string, string> = { mensal_brl: "Mensal", recomendado_mensal_brl_min: "Mínimo recomendado", recomendado_mensal_brl_max: "Máximo recomendado", media_budget_monthly_brl: "Mensal" };
    const rendered = typeof item === "number" && /brl|mensal|budget|orcamento/.test(key) ? money(item) : String(item);
    return [`${label[key] || key.replaceAll("_", " ")}: ${rendered}`];
  });
  return [String(value)];
}
function fieldValue(field: Row | null | undefined) { return field?.value; }
function SourceLine({ field }: { field: Row | null | undefined }) {
  if (!field) return null;
  return <small className="tc-source">Fonte: {field.source_url ? <a href={field.source_url} target="_blank" rel="noreferrer">{field.source_title || "briefing"}</a> : (field.source_title || "briefing")} · {field.source_at ? dateTime(field.source_at) : "data não informada"}</small>;
}
function FixedField({ label, field, wide = false }: { label: string; field: Row | null | undefined; wide?: boolean }) {
  const values = flatten(fieldValue(field));
  return <article className={`tc-info${wide ? " wide" : ""}`}><span>{label}</span>{values.length ? <div className="tc-lines">{values.map((value, i) => <b key={`${value}-${i}`}>{value}</b>)}</div> : <b className="tc-missing">Não confirmado</b>}<SourceLine field={field} /></article>;
}
function Metric({ title, value, hint }: { title: string; value: string; hint: string }) { return <article className="tc-metric"><span>{title}</span><b>{value}</b><small>{hint}</small></article>; }
function eventDate(row: Row) { return row.last_detected_at || row.updated_at || row.date_updated || row.due_at || row.waiting_since || row.created_at || row.date_created || null; }

export default function CampaignsPage() {
  const initial = rangeFor("LAST_7D");
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [life, setLife] = useState<LifeFilter>("ACTIVE");
  const [delivery, setDelivery] = useState<DeliveryFilter>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clientTab, setClientTab] = useState<ClientTab>("summary");
  const [period, setPeriod] = useState<PeriodKey>("LAST_7D");
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
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar a Central de Tráfego"); }
    finally { setLoading(false); }
  }, [session?.access_token, life, appliedRange.since, appliedRange.until, appliedRange.label]);

  useEffect(() => { load(); }, [load]);

  function changePeriod(next: PeriodKey) {
    setPeriod(next);
    if (next !== "CUSTOM") setAppliedRange(rangeFor(next));
  }
  function applyCustom() {
    if (!customSince || !customUntil || customSince > customUntil) { setError("Confira as datas do período personalizado."); return; }
    setError(""); setAppliedRange({ since: customSince, until: customUntil, label: "Personalizado" });
  }

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    const rank: Record<string, number> = { CHURNED_WITH_DELIVERY: 0, NO_META_ACCOUNT: 1, NO_DELIVERY: 2, NO_CAMPAIGNS: 3, NO_ACTIVE_CAMPAIGN: 4, ACTIVE_DELIVERY: 5 };
    return (payload?.clients || [])
      .filter((row) => (delivery === "ALL" || row.delivery_status === delivery) && (!needle || [row.display_name, row.gt_owner, row.configured_account_names].join(" ").toLocaleLowerCase("pt-BR").includes(needle)))
      .sort((a, b) => (rank[a.delivery_status] ?? 9) - (rank[b.delivery_status] ?? 9) || String(a.display_name).localeCompare(String(b.display_name), "pt-BR"));
  }, [payload, delivery, query]);

  const contextEnabled = Boolean(payload?.profile?.traffic_context_enabled || payload?.summary?.traffic_context_enabled);
  useEffect(() => {
    if (!contextEnabled || !rows.length) return;
    if (!selectedId || !rows.some((row) => String(row.client_id) === selectedId)) {
      setSelectedId(String(rows[0].client_id)); setClientTab("summary");
    }
  }, [contextEnabled, rows, selectedId]);

  const selected = useMemo(() => (payload?.clients || []).find((row) => String(row.client_id) === selectedId) || null, [payload, selectedId]);
  const selectedCampaigns = useMemo(() => (payload?.campaigns || []).filter((row) => String(row.client_id) === selectedId), [payload, selectedId]);
  const s = payload?.summary || {};
  const rangeText = `${day(s.since || appliedRange.since)} → ${day(s.until || appliedRange.until)}`;

  if (!ready) return <main className="tc-loading">Validando sessão…</main>;
  return <main className="tc-shell"><style>{styles}</style>
    <header className="tc-top">
      <div>
        <button className="tc-back" onClick={() => window.location.assign("/")}>← Central de Operações</button>
        <span className="tc-kicker">TRÁFEGO PAGO · MEMÓRIA OPERACIONAL + META AO VIVO</span>
        <h1>{contextEnabled ? "Central de Tráfego" : "Campanhas"}</h1>
        <p>{contextEnabled ? "Consulte o que é fixo em cada cliente antes de operar e, no mesmo lugar, veja o estado atual das campanhas, pendências e integrações." : "Performance por período consultada diretamente na Meta Marketing API."}</p>
      </div>
      <div className="tc-top-actions">
        <span className={`tc-live ${loading ? "loading" : ""}`}>{loading ? "Atualizando…" : `Meta consultada · ${dateTime(s.fetched_at || s.checked_at)}`}</span>
        {payload?.profile?.scope === "WALLET" && <span className="tc-scope">Carteira protegida · {payload?.profile?.person || "GT"}</span>}
        <button onClick={load} disabled={loading}>Atualizar</button>
      </div>
    </header>

    <section className="tc-toolbar">
      <div className="tc-filter-group"><label>Clientes</label><div className="tc-tabs">{([['ACTIVE','Ativos'],['CHURNED','Churned'],['ALL','Todos']] as [LifeFilter,string][]).map(([key,label]) => <button key={key} className={life === key ? "active" : ""} onClick={() => { setLife(key); setDelivery("ALL"); setSelectedId(null); }}>{label}</button>)}</div></div>
      <div className="tc-filter-group"><label>Período de mídia</label><select value={period} onChange={(e) => changePeriod(e.target.value as PeriodKey)} disabled={loading}>{periodOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>{period === "CUSTOM" && <div className="tc-custom"><input type="date" value={customSince} onChange={(e) => setCustomSince(e.target.value)} /><span>até</span><input type="date" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)} /><button onClick={applyCustom}>Aplicar</button></div>}</div>
      <div className="tc-range"><small>INTERVALO APLICADO</small><b>{rangeText}</b><span>{appliedRange.label}</span></div>
    </section>

    {error && <div className="tc-error"><b>Falha na leitura</b><span>{error}</span></div>}
    {Number(s.accounts_failed) > 0 && <div className="tc-warning"><b>Consulta parcial:</b><span>{num(s.accounts_failed)} conta(s) Meta não responderam. O restante foi calculado normalmente.</span></div>}
    {(s.traffic_context_errors || []).length > 0 && <div className="tc-warning"><b>Contexto parcialmente indisponível:</b><span>As métricas continuam válidas; alguns dados auxiliares do cliente não puderam ser carregados nesta rodada.</span></div>}

    <section className="tc-metrics">
      <Metric title="Investimento" value={money(s.spend, true)} hint={rangeText} />
      <Metric title="Resultados" value={num(s.results)} hint="lead ou conversa conforme campanha" />
      <Metric title="Custo / resultado" value={s.cost_per_result == null ? "—" : money(s.cost_per_result, true)} hint="investimento ÷ resultado" />
      <Metric title="CTR" value={s.ctr == null ? "—" : `${num(s.ctr, 2)}%`} hint="cliques ÷ impressões" />
    </section>

    <section className="tc-coverage">
      <Coverage filter="ACTIVE_DELIVERY" current={delivery} set={setDelivery} count={s.active_delivery} text="com entrega" tone="ok" />
      <Coverage filter="NO_DELIVERY" current={delivery} set={setDelivery} count={s.no_delivery} text="ativa sem entrega" tone="warn" />
      <Coverage filter="NO_ACTIVE_CAMPAIGN" current={delivery} set={setDelivery} count={s.no_active_campaign} text="sem campanha ativa" tone="muted" />
      <Coverage filter="NO_CAMPAIGNS" current={delivery} set={setDelivery} count={s.no_campaigns} text="sem campanhas" tone="muted" />
      <Coverage filter="NO_META_ACCOUNT" current={delivery} set={setDelivery} count={s.no_meta_account} text="sem conta Meta" tone="bad" />
    </section>

    {contextEnabled ? <section className="tc-workspace">
      <aside className="tc-clients">
        <div className="tc-clients-head"><div><span>MINHA CARTEIRA</span><b>{rows.length} clientes</b></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente…" /></div>
        <div className="tc-client-list">{rows.map((row) => <button key={row.client_id} className={selectedId === String(row.client_id) ? "active" : ""} onClick={() => { setSelectedId(String(row.client_id)); setClientTab("summary"); }}><span><b>{row.display_name}</b><small>{row.lifecycle === "ONBOARDING" ? "Onboarding" : row.gt_owner || "Sem GT"}</small></span><Pill value={row.delivery_status} /></button>)}{!rows.length && <div className="tc-empty">Nenhum cliente nesse filtro.</div>}</div>
      </aside>
      <section className="tc-client-detail">
        {selected ? <TrafficClient client={selected} campaigns={selectedCampaigns} tab={clientTab} setTab={setClientTab} rangeText={rangeText} /> : <div className="tc-empty large">Selecione um cliente para consultar o manual de tráfego.</div>}
      </section>
    </section> : <CampaignPortfolio rows={rows} campaigns={payload?.campaigns || []} query={query} setQuery={setQuery} />}
  </main>;
}

function Coverage({ filter, current, set, count, text, tone }: { filter: DeliveryFilter; current: DeliveryFilter; set: (v: DeliveryFilter) => void; count: unknown; text: string; tone: string }) {
  return <button className={`${tone} ${current === filter ? "active" : ""}`} onClick={() => set(current === filter ? "ALL" : filter)}><b>{num(count)}</b><span>{text}</span></button>;
}

function TrafficClient({ client, campaigns, tab, setTab, rangeText }: { client: Row; campaigns: Row[]; tab: ClientTab; setTab: (v: ClientTab) => void; rangeText: string }) {
  const ctx = client.traffic_context || {};
  const fixed = ctx.fixed || {};
  const remember = [...flatten(fieldValue(fixed.bottlenecks)), ...flatten(fieldValue(fixed.pending_items))].slice(0, 10);
  const alerts: Row[] = ctx.alerts || [];
  const commitments: Row[] = ctx.commitments || [];
  const tasks: Row[] = ctx.traffic_tasks || [];
  const conversation: Row | null = ctx.conversation || null;
  const timeline = useMemo(() => [
    ...alerts.map((row) => ({ at: eventDate(row), type: "Alerta", title: row.title || row.description, detail: row.next_action, tone: row.severity })),
    ...commitments.map((row) => ({ at: eventDate(row), type: "Compromisso", title: row.descricao, detail: row.owner, tone: row.status })),
    ...tasks.map((row) => ({ at: eventDate(row), type: row.is_closed ? "Task concluída" : "Task de tráfego", title: row.name, detail: row.assignee_names || row.list_name, tone: row.status, url: row.url })),
    ...(conversation ? [{ at: eventDate(conversation), type: "Conversa", title: conversation.open_question || conversation.last_summary || conversation.last_intent, detail: conversation.waiting_for_agency ? "Cliente aguardando a agência" : conversation.waiting_for_client ? "Agência aguardando o cliente" : conversation.conversation_status, tone: conversation.conversation_status }] : []),
  ].filter((row) => row.at).sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime()).slice(0, 14), [alerts, commitments, tasks, conversation]);

  const tabs: [ClientTab, string][] = [["summary","Resumo para operar"],["strategy","Estratégia"],["audience","Público & conversão"],["campaigns","Campanhas"],["integrations","Integrações"],["history","Histórico"]];
  return <>
    <div className="tc-client-title"><div><span>CONSULTA PRÉ-OPERAÇÃO</span><h2>{client.display_name}</h2><p>GT: {client.gt_owner || "não definido"} · {client.lifecycle === "ONBOARDING" ? "Onboarding" : "Cliente ativo"}</p></div><div className="tc-status-stack"><Pill value={client.delivery_status} /><small>Meta: {client.configured_account_names || "conta não confirmada"}</small></div></div>
    <div className="tc-client-kpis"><Metric title="Investimento" value={money(client.spend, true)} hint={rangeText} /><Metric title="Resultados" value={num(client.results)} hint={client.result_types || "período"} /><Metric title="Custo / resultado" value={client.cost_per_result == null ? "—" : money(client.cost_per_result, true)} hint="período selecionado" /><Metric title="CTR" value={client.ctr == null ? "—" : `${num(client.ctr, 2)}%`} hint={`${num(client.active_campaigns)} campanha(s) ativa(s)`} /></div>
    <nav className="tc-client-tabs">{tabs.map(([key,label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>

    {tab === "summary" && <div className="tc-tab-body">
      <section className="tc-callout"><div><span>ANTES DE MEXER NAS CAMPANHAS</span><h3>Contexto que deve estar fresco na cabeça</h3></div><div className="tc-summary-grid"><FixedField label="Objetivo da mídia / negócio" field={fixed.objectives} /><FixedField label="Produtos em foco" field={fixed.product_focus} /><FixedField label="Público registrado" field={fixed.audience} /><FixedField label="Região" field={fixed.region} /><FixedField label="Orçamento de mídia" field={fixed.media_budget} /><FixedField label="CRM / operação comercial" field={fixed.crm} /></div></section>
      <section className="tc-section"><div className="tc-section-head"><div><span>VARIÁVEL · AGORA</span><h3>Estado atual</h3></div><small>Atualizado com Meta + sinais operacionais</small></div><div className="tc-current-grid"><CurrentCard label="Entrega" value={statusLabel[client.delivery_status] || client.delivery_status} note={`${num(client.active_campaigns)} ativa(s) · ${num(client.paused_campaigns)} pausada(s)`} tone={client.delivery_status === "ACTIVE_DELIVERY" ? "ok" : "warn"} /><CurrentCard label="Alertas abertos" value={String(alerts.length)} note={alerts[0]?.title || "Nenhum alerta aberto"} tone={alerts.length ? "warn" : "ok"} /><CurrentCard label="Compromissos" value={String(commitments.length)} note={commitments[0]?.descricao || "Nenhum compromisso em aberto"} tone={commitments.length ? "warn" : "ok"} /><CurrentCard label="Conversa" value={conversation?.waiting_for_agency ? "Responder" : conversation?.waiting_for_client ? "Aguardando cliente" : "Sem urgência"} note={conversation?.open_question || conversation?.last_summary || "Sem sinal recente"} tone={conversation?.waiting_for_agency ? "bad" : "ok"} /></div></section>
      <section className="tc-section remember"><div className="tc-section-head"><div><span>FIXO / SEMIFIXO · BRIEFING</span><h3>⚠ Não esquecer neste cliente</h3></div><small>Somente gargalos e pendências registrados; não são inferências do sistema</small></div>{remember.length ? <div className="tc-remember-list">{remember.map((item, i) => <div key={`${item}-${i}`}><i>{i + 1}</i><span>{item}</span></div>)}</div> : <div className="tc-empty">Nenhum ponto de atenção estruturado no briefing.</div>}</section>
    </div>}

    {tab === "strategy" && <div className="tc-tab-body"><section className="tc-section"><div className="tc-section-head"><div><span>BASE FIXA</span><h3>Estratégia registrada</h3></div><small>Informações vêm do briefing vinculado e carregam fonte/data</small></div><div className="tc-summary-grid"><FixedField label="Tipo de cliente" field={fixed.client_type} /><FixedField label="Objetivos" field={fixed.objectives} wide /><FixedField label="Foco de produto" field={fixed.product_focus} wide /><FixedField label="Região de atuação" field={fixed.region} /><FixedField label="Orçamento de mídia" field={fixed.media_budget} /><FixedField label="Gargalos conhecidos" field={fixed.bottlenecks} wide /><FixedField label="Pendências registradas" field={fixed.pending_items} wide /></div></section><BriefingLinks rows={ctx.briefings || []} /></div>}

    {tab === "audience" && <div className="tc-tab-body"><section className="tc-section"><div className="tc-section-head"><div><span>BASE FIXA</span><h3>Público e conversão</h3></div><small>Se não estiver confirmado, a tela deixa explícito</small></div><div className="tc-summary-grid"><FixedField label="Público-alvo registrado" field={fixed.audience} wide /><FixedField label="CRM / processo comercial" field={fixed.crm} wide /><FixedField label="Responsáveis citados no briefing" field={fixed.responsibles} wide /><FixedField label="Preferências de onboarding/operação" field={fixed.onboarding_preferences} wide /></div><div className="tc-safe-note"><b>Regra de leitura</b><span>Ausência de dado não vira suposição. Destino do lead, qualificação, formulário, WhatsApp ou automação só aparecem como regra quando houver fonte estruturada para isso.</span></div></section></div>}

    {tab === "campaigns" && <div className="tc-tab-body"><section className="tc-section"><div className="tc-section-head"><div><span>VARIÁVEL · META AO VIVO</span><h3>Campanhas do período</h3></div><small>{campaigns.length} campanha(s) no inventário</small></div><CampaignTable rows={campaigns} /></section></div>}

    {tab === "integrations" && <div className="tc-tab-body"><section className="tc-section"><div className="tc-section-head"><div><span>INFRAESTRUTURA</span><h3>Integrações conhecidas</h3></div><small>Somente vínculos existentes no banco</small></div><div className="tc-integration-grid">{(ctx.integrations || []).map((item: Row, i: number) => <article key={`${item.system}-${item.external_id}-${i}`}><span>{item.system || "Integração"}</span><b>{item.external_name || item.external_id || "Vínculo registrado"}</b><small>{item.meta_ad_account_id ? `Conta Meta ${item.meta_ad_account_id}` : "Sem ID Meta neste vínculo"}</small><em>{item.is_primary ? "Principal" : (item.confidence || "Registrada")}</em></article>)}{!(ctx.integrations || []).length && <div className="tc-empty">Nenhuma integração estruturada para este cliente.</div>}</div></section><BriefingLinks rows={ctx.briefings || []} /></div>}

    {tab === "history" && <div className="tc-tab-body"><section className="tc-section"><div className="tc-section-head"><div><span>VARIÁVEL</span><h3>O que mudou recentemente</h3></div><small>Alertas, compromissos, conversa e tarefas relacionadas a tráfego</small></div>{timeline.length ? <div className="tc-timeline">{timeline.map((event, i) => <article key={`${event.type}-${event.at}-${i}`}><time>{dateTime(event.at)}</time><i /><div><span>{event.type}</span><b>{event.url ? <a href={event.url} target="_blank" rel="noreferrer">{String(event.title || "Evento")}</a> : String(event.title || "Evento")}</b>{event.detail && <small>{String(event.detail)}</small>}</div><Pill value={event.tone} /></article>)}</div> : <div className="tc-empty">Nenhuma mudança recente estruturada para tráfego.</div>}</section></div>}
  </>;
}

function CurrentCard({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) { return <article className={`tc-current ${tone}`}><span>{label}</span><b>{value}</b><small>{note}</small></article>; }
function BriefingLinks({ rows }: { rows: Row[] }) { return <section className="tc-section"><div className="tc-section-head"><div><span>FONTES</span><h3>Briefings vinculados</h3></div></div>{rows.length ? <div className="tc-link-list">{rows.map((row, i) => <a key={`${row.page_url}-${i}`} href={row.page_url || undefined} target="_blank" rel="noreferrer"><span><b>{row.title || "Briefing"}</b><small>Atualizado {dateTime(row.last_fetched_at)} · {row.sync_status || "sem status"}</small></span><em>abrir ↗</em></a>)}</div> : <div className="tc-empty">Nenhum briefing estruturado vinculado.</div>}</section>; }
function CampaignTable({ rows }: { rows: Row[] }) { return <div className="tc-table-wrap"><table><thead><tr><th>Campanha</th><th>Status</th><th>Objetivo</th><th>Investimento</th><th>Resultados</th><th>Custo/resultado</th><th>CTR</th><th>Frequência</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.client_id}-${row.campaign_id}`}><td><b>{row.campaign_name || row.campaign_id}</b><small>{row.account_key || row.meta_ad_account_id || "Conta não identificada"}</small></td><td><Pill value={row.campaign_status || (row.has_delivery ? "ACTIVE" : "PAUSED")} /></td><td>{row.objective || "—"}</td><td>{money(row.spend, true)}</td><td>{num(row.result_count)}</td><td>{row.cost_per_result == null ? "—" : money(row.cost_per_result, true)}</td><td>{row.ctr == null ? "—" : `${num(row.ctr, 2)}%`}</td><td>{row.frequency == null ? "—" : num(row.frequency, 2)}</td></tr>)}{!rows.length && <tr><td colSpan={8}><div className="tc-empty">Nenhuma campanha encontrada para este cliente.</div></td></tr>}</tbody></table></div>; }

function CampaignPortfolio({ rows, campaigns, query, setQuery }: { rows: Row[]; campaigns: Row[]; query: string; setQuery: (v: string) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const byClient = useMemo(() => { const map = new Map<string, Row[]>(); campaigns.forEach((row) => map.set(String(row.client_id), [...(map.get(String(row.client_id)) || []), row])); return map; }, [campaigns]);
  return <section className="tc-section portfolio"><div className="tc-section-head"><div><span>CARTEIRA</span><h3>Diagnóstico por cliente</h3></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou conta…" /></div><div className="tc-table-wrap"><table><thead><tr><th>Cliente</th><th>Situação</th><th>Investimento</th><th>Resultados</th><th>Custo/resultado</th><th>CTR</th><th>Campanhas</th></tr></thead><tbody>{rows.map((row) => <><tr key={row.client_id} className="clickable" onClick={() => setExpanded(expanded === String(row.client_id) ? null : String(row.client_id))}><td><b>{row.display_name}</b><small>GT: {row.gt_owner || "—"}</small></td><td><Pill value={row.delivery_status} /></td><td>{money(row.spend, true)}</td><td>{num(row.results)}</td><td>{row.cost_per_result == null ? "—" : money(row.cost_per_result, true)}</td><td>{row.ctr == null ? "—" : `${num(row.ctr, 2)}%`}</td><td>{num(row.campaign_count)}</td></tr>{expanded === String(row.client_id) && <tr key={`${row.client_id}-detail`}><td colSpan={7}><CampaignTable rows={byClient.get(String(row.client_id)) || []} /></td></tr>}</>)}{!rows.length && <tr><td colSpan={7}><div className="tc-empty">Nenhum cliente nesse filtro.</div></td></tr>}</tbody></table></div></section>;
}

const styles = `
:root{--tc-bg:#070b12;--tc-panel:#0d131d;--tc-panel2:#111a27;--tc-border:#223044;--tc-text:#f4f7fb;--tc-muted:#8fa1b8;--tc-blue:#5b8cff;--tc-green:#4bd49b;--tc-yellow:#f6c85f;--tc-red:#ff6b78}
*{box-sizing:border-box}.tc-shell{min-height:100vh;background:radial-gradient(circle at 82% 0,#14223b 0,transparent 34%),var(--tc-bg);color:var(--tc-text);padding:34px max(24px,4vw) 70px;font-family:Inter,system-ui,sans-serif}.tc-loading{min-height:100vh;display:grid;place-items:center;background:#070b12;color:#fff;font-family:Inter,system-ui}
.tc-top{display:flex;justify-content:space-between;gap:30px;align-items:flex-start;margin-bottom:24px}.tc-top h1{font-family:'Inter Tight',Inter,sans-serif;font-size:clamp(34px,5vw,60px);letter-spacing:-.045em;margin:8px 0 8px}.tc-top p{color:var(--tc-muted);max-width:800px;line-height:1.55;margin:0}.tc-kicker,.tc-section-head span,.tc-client-title>div>span,.tc-callout>div>span{font-size:11px;letter-spacing:.13em;font-weight:800;color:#79a3ff}.tc-back{border:0;background:transparent;color:var(--tc-muted);padding:0;cursor:pointer;margin-bottom:8px}.tc-back:hover{color:#fff}.tc-top-actions{display:flex;gap:9px;align-items:flex-end;flex-direction:column}.tc-top-actions button,.tc-custom button{background:#1b62db;color:white;border:1px solid #377cf0;border-radius:10px;padding:10px 15px;font-weight:700;cursor:pointer}.tc-top-actions button:disabled{opacity:.55}.tc-live,.tc-scope{font-size:11px;color:var(--tc-muted);padding:7px 10px;border:1px solid var(--tc-border);border-radius:999px;background:#0a1019}.tc-live.loading{color:var(--tc-yellow)}.tc-scope{color:#83e0b7}
.tc-toolbar{display:grid;grid-template-columns:auto minmax(310px,1fr) auto;gap:18px;align-items:end;padding:16px 18px;border:1px solid var(--tc-border);background:rgba(13,19,29,.92);border-radius:16px;margin-bottom:14px}.tc-filter-group{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tc-filter-group>label{display:block;width:100%;font-size:10px;color:var(--tc-muted);text-transform:uppercase;letter-spacing:.1em;font-weight:800}.tc-filter-group select,.tc-filter-group input,.tc-clients input,.tc-section-head input{background:#080d15;color:#fff;border:1px solid var(--tc-border);border-radius:9px;padding:9px 11px}.tc-tabs{display:flex;gap:5px}.tc-tabs button{border:1px solid var(--tc-border);background:#090f18;color:var(--tc-muted);border-radius:8px;padding:8px 10px;cursor:pointer}.tc-tabs button.active{background:#18345f;color:#fff;border-color:#315f9f}.tc-custom{display:flex;align-items:center;gap:7px}.tc-range{text-align:right}.tc-range small{display:block;color:var(--tc-muted);font-size:9px;letter-spacing:.1em}.tc-range b{display:block;margin-top:4px}.tc-range span{color:var(--tc-muted);font-size:11px}
.tc-error,.tc-warning{display:flex;gap:12px;padding:12px 15px;border-radius:11px;margin:10px 0;font-size:13px}.tc-error{background:#35131a;border:1px solid #6d2632;color:#ffd7dc}.tc-warning{background:#2d250f;border:1px solid #5f4d1e;color:#ffe6a5}.tc-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.tc-metric{background:linear-gradient(145deg,#111927,#0b111a);border:1px solid var(--tc-border);border-radius:14px;padding:15px}.tc-metric span{display:block;color:var(--tc-muted);font-size:11px}.tc-metric b{display:block;font-family:'Inter Tight';font-size:25px;letter-spacing:-.03em;margin:5px 0}.tc-metric small{color:#71839a;font-size:10px}.tc-coverage{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:15px}.tc-coverage button{display:flex;align-items:center;gap:7px;background:#0b111a;border:1px solid var(--tc-border);color:var(--tc-muted);padding:8px 11px;border-radius:10px;cursor:pointer}.tc-coverage button b{color:#fff}.tc-coverage button.active{outline:2px solid #4b79c9}.tc-coverage .ok b{color:var(--tc-green)}.tc-coverage .warn b{color:var(--tc-yellow)}.tc-coverage .bad b{color:var(--tc-red)}
.tc-workspace{display:grid;grid-template-columns:300px minmax(0,1fr);gap:14px;align-items:start}.tc-clients{border:1px solid var(--tc-border);background:var(--tc-panel);border-radius:16px;overflow:hidden;position:sticky;top:14px;max-height:calc(100vh - 28px)}.tc-clients-head{padding:14px;border-bottom:1px solid var(--tc-border)}.tc-clients-head>div{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.tc-clients-head span{font-size:10px;color:var(--tc-muted);letter-spacing:.1em;font-weight:800}.tc-clients-head input{width:100%}.tc-client-list{overflow:auto;max-height:calc(100vh - 105px);padding:6px}.tc-client-list>button{width:100%;display:flex;justify-content:space-between;gap:8px;align-items:center;text-align:left;border:1px solid transparent;background:transparent;color:#fff;padding:10px;border-radius:10px;cursor:pointer}.tc-client-list>button:hover{background:#111b2a}.tc-client-list>button.active{background:#15233a;border-color:#31547e}.tc-client-list button span:first-child{min-width:0}.tc-client-list button b,.tc-client-list button small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tc-client-list button b{font-size:12px}.tc-client-list button small{font-size:10px;color:var(--tc-muted);margin-top:3px}.tc-pill{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:4px 7px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;font-weight:800;background:#1a2230;color:#aebbd0}.tc-pill.ok{background:#113326;color:#77e4b4}.tc-pill.warn{background:#342a12;color:#ffd36f}.tc-pill.bad{background:#35161d;color:#ff9aa4}
.tc-client-detail{min-width:0;border:1px solid var(--tc-border);background:rgba(13,19,29,.94);border-radius:16px;overflow:hidden}.tc-client-title{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:20px 22px 12px}.tc-client-title h2{font-family:'Inter Tight';font-size:30px;letter-spacing:-.035em;margin:4px 0}.tc-client-title p{margin:0;color:var(--tc-muted);font-size:12px}.tc-status-stack{text-align:right}.tc-status-stack small{display:block;color:var(--tc-muted);margin-top:7px;max-width:300px}.tc-client-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:0 22px 16px}.tc-client-kpis .tc-metric{padding:11px}.tc-client-kpis .tc-metric b{font-size:19px}.tc-client-tabs{display:flex;overflow:auto;padding:0 22px;border-bottom:1px solid var(--tc-border)}.tc-client-tabs button{white-space:nowrap;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--tc-muted);padding:11px 13px;cursor:pointer;font-size:11px;font-weight:700}.tc-client-tabs button.active{color:#fff;border-color:#6d9cff}.tc-tab-body{padding:18px 22px 24px;display:grid;gap:14px}
.tc-callout,.tc-section{border:1px solid var(--tc-border);background:#0a1018;border-radius:14px;padding:17px}.tc-callout{background:linear-gradient(135deg,#101d31,#0a1018 62%)}.tc-callout h3,.tc-section h3{margin:4px 0 0;font-size:17px}.tc-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:14px}.tc-info{border:1px solid #1d2a3c;background:#0c141f;border-radius:10px;padding:11px;min-width:0}.tc-info.wide{grid-column:1/-1}.tc-info>span{display:block;color:var(--tc-muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:7px}.tc-lines{display:grid;gap:4px}.tc-info b{font-size:12px;line-height:1.45}.tc-info b.tc-missing{color:#64758a;font-weight:600}.tc-source{display:block;color:#60738c;margin-top:7px;font-size:9px}.tc-source a{color:#7fa9ff;text-decoration:none}.tc-section-head{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}.tc-section-head small{color:var(--tc-muted);max-width:390px;text-align:right;font-size:10px}.tc-current-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:13px}.tc-current{padding:11px;border-radius:10px;border:1px solid #243044;background:#0d151f}.tc-current>span{font-size:9px;color:var(--tc-muted);text-transform:uppercase;font-weight:800}.tc-current>b{display:block;margin:6px 0;font-size:15px}.tc-current small{display:block;color:#8295ad;line-height:1.4}.tc-current.warn{border-color:#594719}.tc-current.bad{border-color:#642b35}.tc-current.ok{border-color:#1c4e3a}.remember{border-color:#51411c;background:#16130b}.tc-remember-list{display:grid;gap:7px;margin-top:13px}.tc-remember-list>div{display:flex;align-items:flex-start;gap:9px;background:#211b0c;border:1px solid #493a18;border-radius:9px;padding:9px}.tc-remember-list i{font-style:normal;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#4b3a13;color:#ffd86e;font-size:9px;font-weight:800;flex:0 0 auto}.tc-remember-list span{font-size:12px;line-height:1.45}.tc-safe-note{display:flex;gap:12px;margin-top:13px;padding:11px;border-left:3px solid #5b8cff;background:#101a29}.tc-safe-note b{font-size:11px}.tc-safe-note span{color:var(--tc-muted);font-size:11px;line-height:1.5}
.tc-integration-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-top:13px}.tc-integration-grid article{position:relative;padding:12px;border:1px solid #223047;border-radius:10px;background:#0c141f}.tc-integration-grid article span{display:block;color:#79a3ff;font-size:9px;font-weight:800}.tc-integration-grid article b{display:block;margin:5px 0;font-size:12px}.tc-integration-grid article small{color:var(--tc-muted)}.tc-integration-grid article em{position:absolute;right:10px;top:9px;font-size:8px;color:#83dab0;font-style:normal}.tc-link-list{display:grid;gap:7px;margin-top:12px}.tc-link-list a{display:flex;justify-content:space-between;align-items:center;gap:15px;text-decoration:none;color:#fff;border:1px solid #213047;background:#0c141f;border-radius:9px;padding:10px}.tc-link-list small{display:block;color:var(--tc-muted);margin-top:3px}.tc-link-list em{color:#78a3ff;font-style:normal;font-size:10px}
.tc-timeline{margin-top:14px}.tc-timeline article{display:grid;grid-template-columns:120px 14px minmax(0,1fr) auto;gap:9px;align-items:start;position:relative;padding:0 0 15px}.tc-timeline article:not(:last-child):after{content:'';position:absolute;left:126px;top:14px;bottom:0;width:1px;background:#26344a}.tc-timeline time{font-size:9px;color:var(--tc-muted);text-align:right;padding-top:3px}.tc-timeline>article>i{width:9px;height:9px;border-radius:50%;background:#5b8cff;margin-top:3px;z-index:1}.tc-timeline div span{display:block;color:#7fa7dd;font-size:9px;text-transform:uppercase;font-weight:800}.tc-timeline div b{display:block;font-size:12px;margin:3px 0}.tc-timeline div b a{color:#fff;text-decoration:none}.tc-timeline div small{color:var(--tc-muted)}
.tc-section.portfolio{margin-top:16px}.tc-table-wrap{overflow:auto;margin-top:12px;border:1px solid #1d2a3c;border-radius:10px}.tc-table-wrap table{width:100%;border-collapse:collapse;font-size:11px}.tc-table-wrap th{position:sticky;top:0;background:#101824;color:#7e91aa;text-align:left;text-transform:uppercase;font-size:8px;letter-spacing:.06em;padding:9px;white-space:nowrap}.tc-table-wrap td{padding:10px 9px;border-top:1px solid #182434;vertical-align:top}.tc-table-wrap td>b,.tc-table-wrap td>small{display:block}.tc-table-wrap td>small{color:var(--tc-muted);margin-top:3px}.tc-table-wrap tr.clickable{cursor:pointer}.tc-table-wrap tr.clickable:hover{background:#101b29}.tc-empty{padding:18px;color:#6f8198;font-size:11px;text-align:center}.tc-empty.large{min-height:350px;display:grid;place-items:center}
@media(max-width:1050px){.tc-workspace{grid-template-columns:240px minmax(0,1fr)}.tc-current-grid,.tc-client-kpis{grid-template-columns:repeat(2,1fr)}.tc-toolbar{grid-template-columns:1fr 1fr}.tc-range{grid-column:1/-1;text-align:left}.tc-metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){.tc-shell{padding:18px 12px 50px}.tc-top{flex-direction:column}.tc-top-actions{align-items:flex-start}.tc-toolbar{grid-template-columns:1fr}.tc-workspace{grid-template-columns:1fr}.tc-clients{position:relative;top:auto;max-height:none}.tc-client-list{max-height:300px}.tc-summary-grid,.tc-integration-grid,.tc-current-grid,.tc-client-kpis,.tc-metrics{grid-template-columns:1fr}.tc-client-title{flex-direction:column}.tc-status-stack{text-align:left}.tc-timeline article{grid-template-columns:80px 14px minmax(0,1fr)}.tc-timeline article>.tc-pill{display:none}.tc-timeline article:not(:last-child):after{left:86px}.tc-section-head{flex-direction:column}.tc-section-head small{text-align:left}.tc-custom{flex-wrap:wrap}}
`;
