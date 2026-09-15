"use client";

import { useEffect, useMemo, useState } from "react";
import { authenticatedFetch, formatDay, formatNumber, SUPABASE_URL, text } from "../shared";
import type { Row } from "../shared";
import { BAND_LABEL, PortfolioChart, SECTOR_LABEL, TENURE_LABEL } from "./portfolio";

const WALLET_API = `${SUPABASE_URL}/functions/v1/agency-ops-wallet-performance-api`;

function delta(current: unknown, previous: unknown) {
  const now = Number(current ?? 0), before = Number(previous ?? 0);
  if (!before) return null;
  return Number((((now - before) / before) * 100).toFixed(1));
}

function Kpi({ label, value, hint, suffix, change, inverse = false }: { label: string; value: string; hint: string; suffix?: string; change?: number | null; inverse?: boolean }) {
  const good = change == null ? null : inverse ? change <= 0 : change >= 0;
  return <article className="card metric">
    <div className="label">{label}</div>
    <div className="value">{value}{suffix && <span className="pf-unit">{suffix}</span>}</div>
    <div className="hint">{hint}</div>
    {change != null && <small className={`pf-delta ${good ? "up" : "down"}`}>{change >= 0 ? "▲" : "▼"} {Math.abs(change)}% vs mês anterior</small>}
  </article>;
}

export function WalletPerformanceCenter() {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [walletName, setWalletName] = useState("");
  const [sector, setSector] = useState("marketing");
  const [monthKey, setMonthKey] = useState("");

  useEffect(() => {
    let active = true;
    authenticatedFetch(WALLET_API, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || body.error || `Falha ao carregar carteiras (${response.status})`);
        if (!active) return;
        setData(body);
        const first = (body.wallets || []).find((w: Row) => Number(w.portfolio?.total_active || 0) > 0) || body.wallets?.[0];
        if (first) setWalletName(String(first.carteira));
      })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Falha ao carregar carteiras"); });
    return () => { active = false; };
  }, []);

  if (error) return <section className="card section"><div className="error-box">{error}</div></section>;
  if (!data) return <section className="card section"><div className="auth-loading"><span className="dot loading" /> Carregando carteiras...</div></section>;

  const wallets: Row[] = data.wallets || [];
  const wallet = wallets.find((w) => String(w.carteira) === walletName) || wallets[0] || null;
  if (!wallet) return <section className="card section"><div className="empty">Nenhuma carteira cadastrada.</div></section>;
  const portfolio: Row = wallet.portfolio || {};
  const timeline: Row[] = portfolio.timeline || [];
  const months = [...new Set(timeline.map((r) => String(r.month_key)))].sort().reverse();
  const activeMonth = monthKey && months.includes(monthKey) ? monthKey : months[0] || "";
  const row: Row = timeline.find((r) => r.month_key === activeMonth && r.sector === sector) || {};
  const monthIndex = months.indexOf(activeMonth);
  const previousKey = monthIndex >= 0 ? months[monthIndex + 1] : null;
  const previous: Row | null = previousKey ? timeline.find((r) => r.month_key === previousKey && r.sector === sector) || null : null;
  const asc = months.slice().reverse();
  const series = (field: string, wantedSector = sector) => asc.map((m) => Number(timeline.find((r) => r.month_key === m && r.sector === wantedSector)?.[field] ?? 0));
  const total = Number(row.active_clients || 0);
  const pct = (v: unknown) => total ? `${((Number(v || 0) / total) * 100).toFixed(1)}% da carteira` : "0% da carteira";
  const status: Row = portfolio.status_summary || {};
  const transitions: Row[] = portfolio.transitions || [];
  const clients: Row[] = (portfolio.clients || []).filter((c: Row) => c.sector === sector);
  const tenure: Row[] = portfolio.tenure_distribution || [];
  const maxTenure = Math.max(1, ...tenure.map((t: Row) => Number(t.clientes || 0)));
  const survival: Row[] = portfolio.survival || [];
  const signals: Row[] = (portfolio.operational_signal || []).filter((s: Row) => ["ACTIVE", "ONBOARDING"].includes(String(s.lifecycle)));
  const churns: Row[] = (portfolio.churns || []).filter((c: Row) => String(c.sector || "marketing") === sector);

  const readings: Array<{ title: string; body: string; tone: string }> = [];
  if (previous) {
    const dTpc = delta(row.tpc_months, previous.tpc_months), dLtv = delta(row.ltv_months, previous.ltv_months), dChurn = delta(row.churn_rate, previous.churn_rate), dEntries = delta(row.entries, previous.entries);
    if (dTpc != null && dLtv != null) {
      if (dTpc < -5 && dLtv > 5) readings.push({ title: "Cliente novo saindo cedo.", tone: "alerta", body: `TPC caiu ${Math.abs(dTpc).toFixed(0)}% e LTV subiu ${dLtv.toFixed(0)}%. A base antiga está segurando, mas a largada piorou.` });
      else if (dTpc > 5 && dLtv > 5) readings.push({ title: "Retenção melhorando.", tone: "bom", body: `TPC e LTV subiram juntos (${dTpc.toFixed(0)}% e ${dLtv.toFixed(0)}%).` });
      else if (dTpc < -5 && dLtv < -5) readings.push({ title: "Carteira rejuvenescendo por perda.", tone: "alerta", body: "TPC e LTV caíram juntos; a base está sendo reposta mais rápido do que amadurece." });
    }
    if (dChurn != null && Math.abs(dChurn) > 5) readings.push({ title: dChurn > 0 ? "Churn acelerando." : "Churn desacelerando.", tone: dChurn > 0 ? "alerta" : "bom", body: `${formatNumber(row.churn_rate, 1)}% agora contra ${formatNumber(previous.churn_rate, 1)}% no mês anterior.` });
    if (dEntries != null && Math.abs(dEntries) > 10) readings.push({ title: dEntries > 0 ? "Entradas em alta." : "Entradas em queda.", tone: dEntries > 0 ? "bom" : "alerta", body: `${formatNumber(row.entries, 0)} entradas contra ${formatNumber(previous.entries, 0)} no mês anterior.` });
    if (Number(row.balance) < 0) readings.push({ title: "Carteira encolhendo.", tone: "alerta", body: `Saldo líquido de ${formatNumber(row.balance, 0)} no mês.` });
  }
  if (Number(row.vendas_caidas) > 0) readings.push({ title: "Venda caída no mês.", tone: "neutro", body: `${formatNumber(row.vendas_caidas, 0)} cliente(s) saíram em até 10 dias e não entram no churn.` });
  if (Number(status.churn_previsto) > 0) readings.push({ title: "Churn previsto em aberto.", tone: "alerta", body: `${formatNumber(status.churn_previsto, 0)} cliente(s) da carteira já estão sinalizados para saída.` });

  const currentMarketing = (w: Row) => w.current?.marketing || {};

  return <section className="wallet-performance">
    <div className="workspace-head">
      <div><span className="eyebrow">Retenção por carteira</span><h2>Carteiras de GT</h2><p>A mesma lógica da Carteira de Clientes, agora quebrada por carteira e gestor.</p></div>
    </div>

    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginBottom: 14 }}>
      {wallets.map((w) => { const m = currentMarketing(w); const active = Number(w.portfolio?.total_active || 0); return <button type="button" key={w.carteira} className={`card section${walletName === w.carteira ? " active" : ""}`} style={{ textAlign: "left", cursor: "pointer", opacity: active ? 1 : .62 }} onClick={() => { setWalletName(String(w.carteira)); setMonthKey(""); }}>
        <small className="eyebrow">Carteira {text(w.carteira)}</small><div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{text(w.gt_owner)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 12 }}>
          <span><b style={{ display: "block", fontSize: 20 }}>{formatNumber(active, 0)}</b><small>ativos</small></span>
          <span><b style={{ display: "block", fontSize: 20 }}>{formatNumber(m.churn_rate, 1)}%</b><small>churn</small></span>
          <span><b style={{ display: "block", fontSize: 20 }}>{Number(m.balance) > 0 ? "+" : ""}{formatNumber(m.balance, 0)}</b><small>saldo</small></span>
        </div>
      </button>; })}
    </div>

    <div className="connection-note" style={{ marginBottom: 14 }}><b>Carteira {text(wallet.carteira)} · {text(wallet.gt_owner)}</b><p style={{ marginBottom: 0 }}>{text(data.attribution)}</p></div>

    <div className="pf-hero card">
      <div className="pf-hero-main"><b>{formatNumber(portfolio.total_active, 0)}</b><span>clientes ativos</span></div>
      <div className="pf-hero-split">{(portfolio.sectors || []).map((s: Row) => <div key={s.sector}><b>{formatNumber(s.active_clients, 0)}</b><small>{SECTOR_LABEL[s.sector] || s.sector}</small></div>)}</div>
      <div className="pf-hero-status"><div className="pf-status-title">Status operacionais</div><div className="pf-status-row">
        <span className={Number(status.inadimplentes) ? "red" : ""}><b>{formatNumber(status.inadimplentes, 0)}</b> inadimplentes</span>
        <span className={Number(status.juridico) ? "yellow" : ""}><b>{formatNumber(status.juridico, 0)}</b> em jurídico</span>
        <span className={Number(status.churn_previsto) ? "red" : ""}><b>{formatNumber(status.churn_previsto, 0)}</b> churn previsto</span>
      </div></div>
    </div>

    <section className="card pf-block">
      <div className="pf-block-head"><div><b>Indicadores Gerais</b><small>Carteira {text(wallet.carteira)} · {text(wallet.gt_owner)}</small></div><div className="pf-controls">
        <select className="control" value={activeMonth} onChange={(e) => setMonthKey(e.target.value)}>{months.map((m) => { const r = timeline.find((x) => x.month_key === m); return <option key={m} value={m}>{r?.label || m}{r?.origem === "ao_vivo" ? " — atual" : " — reconstruído"}</option>; })}</select>
        <div className="pf-tabs">{["marketing", "ia"].map((s) => <button type="button" key={s} className={sector === s ? "active" : ""} onClick={() => setSector(s)}>{SECTOR_LABEL[s]}</button>)}</div>
      </div></div>
      <p className={`pf-quality q-${row.quality || "high"}`}>{text(row.quality_label)} · {text(row.quality_detail)}</p>
      <div className="grid pf-kpis">
        <Kpi label="Clientes ativos" value={formatNumber(row.active_clients, 0)} hint={`clientes de ${SECTOR_LABEL[sector]}`} change={previous ? delta(row.active_clients, previous.active_clients) : null} />
        <Kpi label="Clientes < 3 meses" value={formatNumber(row.clients_less_3m, 0)} hint={pct(row.clients_less_3m)} />
        <Kpi label="Clientes 3–6 meses" value={formatNumber(row.clients_3_6m, 0)} hint={pct(row.clients_3_6m)} />
        <Kpi label="Clientes > 6 meses" value={formatNumber(row.clients_over_6m, 0)} hint={pct(row.clients_over_6m)} />
        <Kpi label="LTV médio" value={row.ltv_months == null ? "—" : formatNumber(row.ltv_months, 2)} suffix={row.ltv_months == null ? undefined : "m"} hint="tempo médio da carteira ativa" change={previous ? delta(row.ltv_months, previous.ltv_months) : null} />
        <Kpi label="Entradas no mês" value={formatNumber(row.entries, 0)} hint="novos clientes" change={previous ? delta(row.entries, previous.entries) : null} />
        <Kpi label="Churns no mês" value={formatNumber(row.churns, 0)} hint="cancelamentos registrados" change={previous ? delta(row.churns, previous.churns) : null} inverse />
        <Kpi label="Vendas caídas" value={formatNumber(row.vendas_caidas, 0)} hint="saíram em até 10 dias" />
        <Kpi label="Taxa de churn" value={formatNumber(row.churn_rate, 1)} suffix="%" hint={`${formatNumber(row.churns, 0)} churns / base ${formatNumber(row.churn_base, 0)}`} change={previous ? delta(row.churn_rate, previous.churn_rate) : null} inverse />
        <Kpi label="TPC" value={row.tpc_months == null ? "—" : formatNumber(row.tpc_months, 2)} suffix={row.tpc_months == null ? undefined : "m"} hint="permanência média dos churns" />
        <Kpi label="Saldo líquido" value={`${Number(row.balance) > 0 ? "+" : ""}${formatNumber(row.balance, 0)}`} hint="entradas − churns − vendas caídas" change={previous ? delta(row.balance, previous.balance) : null} />
      </div>
    </section>

    <section className="card pf-block pf-reading"><div className="pf-block-head"><div><b>Leitura operacional</b><small>Interpretação automática do movimento da carteira.</small></div></div><div className="pf-reading-list">
      {readings.map((r, i) => <p key={i} className={`pf-read ${r.tone}`}><b>{r.title} </b>{r.body}</p>)}
      {!readings.length && <p className="pf-read neutro"><b>Sem alerta relevante.</b> O período não trouxe movimento suficiente para uma leitura forte.</p>}
    </div></section>

    <section className="card pf-block"><div className="pf-block-head"><div><b>Evolução mensal</b><small>Comparação da carteira selecionada desde janeiro de 2026.</small></div></div><div className="pf-charts">
      <div><h4>Base ativa</h4><PortfolioChart kind="line" unit="clientes" series={[{ label: "Marketing", values: series("active_clients", "marketing") }, { label: "IA", values: series("active_clients", "ia") }]} /></div>
      <div><h4>Entradas × churns</h4><PortfolioChart kind="bar" unit="clientes" series={[{ label: "Entradas", values: series("entries") }, { label: "Churns", values: series("churns") }]} /></div>
      <div><h4>Taxa de churn</h4><PortfolioChart kind="line" unit="%" series={[{ label: "Churn rate", values: series("churn_rate") }]} /></div>
      <div><h4>LTV × TPC</h4><PortfolioChart kind="line" unit="meses" series={[{ label: "LTV", values: series("ltv_months") }, { label: "TPC", values: series("tpc_months") }]} /></div>
    </div></section>

    <section className="card pf-block"><div className="pf-block-head"><div><b>Resumo histórico</b><small>Mesmo conjunto de métricas, mês a mês.</small></div></div><div className="table-wrap"><table className="pf-history"><thead><tr><th>Mês</th><th>Ativos</th><th>Entradas</th><th>Churns</th><th>Taxa</th><th>LTV</th><th>TPC</th><th>Saldo</th></tr></thead><tbody>
      {timeline.filter((r) => r.sector === sector).map((r) => <tr key={`${r.month_key}-${r.sector}`} className={r.month_key === activeMonth ? "active" : ""} onClick={() => setMonthKey(String(r.month_key))}><td><b>{text(r.label)}</b></td><td>{formatNumber(r.active_clients, 0)}</td><td>{formatNumber(r.entries, 0)}</td><td>{formatNumber(r.churns, 0)}</td><td>{formatNumber(r.churn_rate, 1)}%</td><td>{r.ltv_months == null ? "—" : formatNumber(r.ltv_months, 2)}</td><td>{r.tpc_months == null ? "—" : formatNumber(r.tpc_months, 2)}</td><td>{Number(r.balance) > 0 ? "+" : ""}{formatNumber(r.balance, 0)}</td></tr>)}
    </tbody></table></div></section>

    <section className="card pf-block"><div className="pf-block-head"><div><b>Distribuição por Tempo de Casa</b><small>Ativos de {SECTOR_LABEL[sector]}</small></div></div><div className="pf-tenure">{["ate_1m","m1_2","m2_3","m3_4","m4_5","m5_6","mais_6m"].map((f) => { const v = Number(tenure.find((t: Row) => t.faixa === f)?.clientes ?? 0); return <div key={f}><span>{TENURE_LABEL[f]}</span><div><i style={{ width: `${(v / maxTenure) * 100}%` }} /></div><b>{v}</b></div>; })}</div></section>

    <section className="card pf-block"><div className="pf-block-head"><div><b>Clientes por Tempo de Operação</b><small>Distribuição atual da carteira.</small></div></div><div className="pf-segments">{["LESS_3M","M3_6","OVER_6M"].map((band) => { const list = clients.filter((c: Row) => c.banda === band); return <article className="pf-segment" key={band}><header><b>{BAND_LABEL[band]}</b><span>{list.length}</span></header><div className="pf-segment-list">{list.slice(0, 30).map((c: Row) => <div key={c.client_id} style={{ padding: "8px 10px", display: "flex", justifyContent: "space-between", gap: 8 }}><span><b>{text(c.display_name)}</b><small style={{ display: "block" }}>Entrada {formatDay(c.entrada)}</small></span><span className={`pf-badge ${c.urgencia}`}>{c.dias_para_proxima == null ? "veterano" : `${c.dias_para_proxima}d`}</span></div>)}{!list.length && <div className="empty">Nenhum cliente nesta faixa.</div>}</div></article>; })}</div></section>

    <section className="card pf-block pf-survival"><div className="pf-block-head"><div><b>Curva de sobrevivência</b><small>Risco histórico dentro desta carteira.</small></div></div><div className="pf-survival-list">{survival.map((f: Row) => { const risk = Number(f.expostos) ? (Number(f.churns) / Number(f.expostos)) * 100 : 0; const level = risk >= 40 ? "alto" : risk >= 15 ? "medio" : "baixo"; return <div key={f.ordem} className={`pf-surv-row ${level}`}><span className="pf-surv-label">{text(f.rotulo)}</span><div className="pf-surv-bar"><i style={{ width: `${Math.min(100, risk)}%` }} /></div><span className="pf-surv-risk">{risk.toFixed(1)}%</span><small className="pf-surv-detail">{f.churns} de {f.expostos} expostos · {f.ativos_na_faixa} ativos hoje</small></div>; })}</div></section>

    <section className="card pf-block"><div className="pf-block-head"><div><b>Sinal operacional do ClickUp</b><small>Clientes ativos sem geração recente de pedidos.</small></div></div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
      {[['nunca_atendido','Nunca atendido'],['silencio_critico','Silêncio crítico'],['silencio_atencao','Silêncio 21–44d'],['aguardando_primeira_task','Aguardando 1ª task']].map(([key,label]) => <article className="card metric" key={key}><div className="label">{label}</div><div className="value">{signals.filter((s: Row) => s.sinal === key).length}</div><div className="hint">clientes nesta condição</div></article>)}
    </div></section>

    <details className="card pf-block"><summary><b>Próximas transições</b><span>{transitions.length}</span><em>até 10 dias</em></summary><div className="pf-transitions">{transitions.map((t: Row) => <div key={t.client_id} style={{ padding: "10px 12px", display: "flex", gap: 12, alignItems: "center" }}><span className="pf-days"><b>{t.dias_para_proxima}</b><small>dias</small></span><span className="pf-transition-info"><b>{text(t.display_name)}</b><small>passa para {text(t.proxima_faixa)} em {formatDay(t.data_transicao)}</small></span></div>)}{!transitions.length && <div className="empty">Nenhuma transição nos próximos 10 dias.</div>}</div></details>

    <details className="card pf-block"><summary><b>Churns registrados na carteira</b><span>{churns.length}</span></summary><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Entrada</th><th>Saída</th><th>Permanência</th><th>Tipo</th></tr></thead><tbody>{churns.map((c: Row) => <tr key={c.id}><td><b>{text(c.client_name)}</b></td><td>{formatDay(c.entrada)}</td><td>{formatDay(c.saida)}</td><td>{formatNumber(c.permanencia_dias, 0)} dias</td><td>{c.tipo === "venda_caida" ? "Venda caída" : "Churn"}</td></tr>)}</tbody></table></div></details>
  </section>;
}
