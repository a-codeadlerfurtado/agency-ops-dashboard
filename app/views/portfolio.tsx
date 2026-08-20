"use client";

// Aba Clientes: metricas vivas da carteira, serie mensal, sobrevivencia e auditoria.
// Sai do arquivo principal por ser o maior bloco autocontido do painel.

import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, formatDay, formatNumber, text } from "../shared";
import type { Row } from "../shared";

export const SINAL_META: Record<string, { rotulo: string; tom: string; nota: string }> = {
  nunca_atendido: { rotulo: "Nunca atendido", tom: "critico", nota: "mais de 30 dias de casa sem nenhuma task criada" },
  silencio_critico: { rotulo: "Silêncio crítico", tom: "critico", nota: "45 dias ou mais sem nenhum pedido novo" },
  silencio_atencao: { rotulo: "Silêncio", tom: "alerta", nota: "entre 21 e 44 dias sem pedido novo" },
  aguardando_primeira_task: { rotulo: "Aguardando 1ª task", tom: "neutro", nota: "entrou há pouco e ainda não gerou pedido" },
  ia_sem_sinal: { rotulo: "Apenas IA", tom: "neutro", nota: "não passa pelo ClickUp; ausência de task não diz nada" },
};

export const SECTOR_LABEL: Record<string, string> = { marketing: "Marketing", ia: "Apenas IA" };
export const URGENCY_LABEL: Record<string, string> = { urgente: "Até 10 dias", atencao: "11–30 dias", ok: "31–60 dias", confort: "61+ dias", veteran: "Veterano" };
export const BAND_LABEL: Record<string, string> = { LESS_3M: "Menos de 3 meses", M3_6: "3 a 6 meses", OVER_6M: "Mais de 6 meses" };
export const TENURE_LABEL: Record<string, string> = { ate_1m: "Até 1 mês", m1_2: "1 a 2 meses", m2_3: "2 a 3 meses", m3_4: "3 a 4 meses", m4_5: "4 a 5 meses", m5_6: "5 a 6 meses", mais_6m: "+ 6 meses" };
// Azul da marca primeiro; os demais sao os tons semanticos ja' usados no painel.
export const CHART_COLORS = ["#3e92dc", "#31d49b", "#f7c95c", "#a98bff"];

export function PortfolioChart({ series, kind, unit }: { series: Array<{ label: string; values: number[] }>; kind: "line" | "bar"; unit?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    const max = Math.max(1, ...all), min = Math.min(0, ...all);
    const padL = 34, padB = 18, padT = 10, padR = 8;
    const plotW = Math.max(1, w - padL - padR), plotH = Math.max(1, h - padT - padB);
    const px = (i: number, n: number) => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
    const py = (v: number) => padT + plotH - ((v - min) / (max - min || 1)) * plotH;
    ctx.strokeStyle = "rgba(140,165,195,.16)"; ctx.lineWidth = 1;
    for (let g = 0; g <= 3; g++) { const gy = padT + (plotH * g) / 3; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke(); }
    ctx.fillStyle = "rgba(140,165,195,.75)"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(String(Math.round(max)), 4, padT + 4);
    ctx.fillText(String(Math.round(min)), 4, padT + plotH + 4);
    series.forEach((serie, si) => {
      const n = serie.values.length; const color = CHART_COLORS[si % CHART_COLORS.length];
      if (kind === "bar") {
        const bw = Math.max(4, plotW / Math.max(n, 1) / (series.length + 1));
        serie.values.forEach((v, i) => {
          const bx = px(i, n) - (series.length * bw) / 2 + si * bw;
          ctx.fillStyle = color; ctx.globalAlpha = 0.85;
          ctx.fillRect(bx, py(v), bw - 1, padT + plotH - py(v)); ctx.globalAlpha = 1;
        });
      } else {
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
        serie.values.forEach((v, i) => { const a = px(i, n), b = py(v); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
        ctx.stroke(); ctx.fillStyle = color;
        serie.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(px(i, n), py(v), i === n - 1 ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill(); });
      }
    });
  }, [series, kind]);
  return <div className="pf-chart-wrap">
    <canvas ref={ref} className="pf-chart" />
    <div className="pf-chart-legend">
      {series.map((s, i) => <span key={s.label}><i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />{s.label}</span>)}
      {unit && <em>{unit}</em>}
    </div>
  </div>;
}

export function PortfolioCenter({ portfolio, openClient }: { portfolio: Row | null; openClient: (id: string) => void }) {
  const [sector, setSector] = useState("marketing");
  const [monthKey, setMonthKey] = useState("");
  const [urgency, setUrgency] = useState("todos");
  const [auditOpen, setAuditOpen] = useState(false);

  if (!portfolio) return <section className="workspace"><div className="card"><div className="empty">Carteira disponível apenas para perfis com acesso total.</div></div></section>;

  const timeline: Row[] = portfolio.timeline || [];
  const meses = [...new Set(timeline.map((r) => r.month_key))].sort().reverse();
  const mesAtivo = monthKey || meses[0] || "";
  const linha: Row = timeline.find((r) => r.month_key === mesAtivo && r.sector === sector) || {};
  const idx = meses.indexOf(mesAtivo);
  const anterior: Row | null = idx >= 0 && meses[idx + 1] ? (timeline.find((r) => r.month_key === meses[idx + 1] && r.sector === sector) || null) : null;
  const serieAsc = meses.slice().reverse();
  const serieDe = (campo: string, s = sector) => serieAsc.map((m) => Number(timeline.find((r) => r.month_key === m && r.sector === s)?.[campo] ?? 0));

  const clientes: Row[] = portfolio.clients || [];
  const doSetor = clientes.filter((c) => c.sector === sector);
  const transicoes: Row[] = portfolio.transitions || [];
  const status: Row = portfolio.status_summary || {};
  const tenure: Row[] = (portfolio.tenure_distribution || []).filter((t: Row) => t.sector === sector);
  const churns: Row[] = portfolio.churns || [];
  const audit: Row[] = portfolio.audit || [];
  const maxTenure = Math.max(1, ...tenure.map((t) => Number(t.clientes || 0)));
  const survival: Row[] = portfolio.survival || [];
  const sinais: Row[] = portfolio.operational_signal || [];
  const sinaisAtivos = sinais.filter((r) => ["ACTIVE","ONBOARDING"].includes(String(r.lifecycle)));
  const evolucao: Row[] = (portfolio.long_series || []).filter((r: Row) => r.sector === sector);
  const gtRet: Row[] = portfolio.gt_retention || [];
  // Projecao: cada faixa contribui com seus ativos vezes o risco historico da faixa.
  const previstos = survival.length
    ? survival.reduce((total, f: Row) => total + (Number(f.expostos) > 0
        ? Number(f.ativos_na_faixa) * (Number(f.churns) / Number(f.expostos)) : 0), 0)
    : null;
  const piorFaixa = survival.length
    ? (survival.map((f: Row) => ({ ...f, risco: Number(f.expostos) > 0 ? (Number(f.churns) / Number(f.expostos)) * 100 : 0 })) as Row[])
        .filter((f: Row) => Number(f.ativos_na_faixa) > 0)
        .sort((a, b) => Number(b.risco) - Number(a.risco))[0]
    : null;
  const pct = (parte: any) => Number(linha.active_clients) ? ((Number(parte) / Number(linha.active_clients)) * 100).toFixed(1) : "0";

  function Delta({ campo, inverso }: { campo: string; inverso?: boolean }) {
    if (!anterior) return null;
    const atual = Number(linha[campo] ?? 0), prev = Number(anterior[campo] ?? 0);
    if (!prev) return null;
    const d = Number((((atual - prev) / prev) * 100).toFixed(1));
    const bom = inverso ? d <= 0 : d >= 0;
    return <small className={`pf-delta ${bom ? "up" : "down"}`}>{d >= 0 ? "▲" : "▼"} {Math.abs(d)}% vs mês anterior</small>;
  }

  function Kpi({ label, valor, hint, unidade, campo, inverso }: { label: string; valor: any; hint: string; unidade?: string; campo?: string; inverso?: boolean }) {
    return <article className="card metric">
      <div className="label">{label}</div>
      <div className="value">{valor}{unidade && <span className="pf-unit">{unidade}</span>}</div>
      <div className="hint">{hint}</div>
      {campo && <Delta campo={campo} inverso={inverso} />}
    </article>;
  }

  // Leitura operacional: interpreta o movimento das metricas em vez de so exibi-las.
  // TPC e LTV apontam para lados diferentes por construcao - TPC mede quanto duram os
  // que saem, LTV quanto ja duram os que ficam -, entao a combinacao dos dois diz mais
  // do que cada um isolado.
  const varia = (campo: string) => {
    if (!anterior) return null;
    const atual = Number(linha[campo] ?? 0), prev = Number(anterior[campo] ?? 0);
    if (!prev) return null;
    return ((atual - prev) / prev) * 100;
  };
  const leituras: Array<{ titulo: string; texto: string; tom: string }> = [];
  if (anterior) {
    const dTpc = varia("tpc_months"), dLtv = varia("ltv_months"), dChurn = varia("churn_rate"), dEnt = varia("entries");
    const saldo = Number(linha.balance ?? 0);
    if (dTpc !== null && dLtv !== null) {
      if (dTpc < -5 && dLtv > 5) leituras.push({ titulo: "Perdendo cliente novo, segurando o antigo. ", tom: "alerta", texto: `O TPC caiu ${Math.abs(dTpc).toFixed(0)}% enquanto o LTV subiu ${dLtv.toFixed(0)}%: quem está saindo dura cada vez menos, mas a base que ficou está envelhecendo bem. O problema está na largada, não na retenção.` });
      else if (dTpc > 5 && dLtv > 5) leituras.push({ titulo: "Retenção melhorando na base inteira. ", tom: "bom", texto: `TPC e LTV subiram juntos (${dTpc.toFixed(0)}% e ${dLtv.toFixed(0)}%): quem sai está durando mais e quem fica também. É o cenário saudável.` });
      else if (dTpc < -5 && dLtv < -5) leituras.push({ titulo: "Carteira rejuvenescendo por perda. ", tom: "alerta", texto: `TPC e LTV caíram juntos: a base está sendo reposta por clientes novos mais rápido do que amadurece. Volume compensando retenção.` });
      else leituras.push({ titulo: "Sem movimento relevante. ", tom: "neutro", texto: `TPC e LTV estáveis em relação ao mês anterior.` });
    }
    if (dChurn !== null && Math.abs(dChurn) > 5) leituras.push({
      titulo: dChurn > 0 ? "Churn acelerando. " : "Churn desacelerando. ", tom: dChurn > 0 ? "alerta" : "bom",
      texto: `Taxa de ${formatNumber(linha.churn_rate, 1)}% contra ${formatNumber(anterior.churn_rate, 1)}% no mês anterior, sobre base potencial de ${formatNumber(linha.churn_base, 0)}.` });
    if (dEnt !== null && Math.abs(dEnt) > 10) leituras.push({
      titulo: dEnt > 0 ? "Entrada em alta. " : "Entrada em queda. ", tom: dEnt > 0 ? "bom" : "alerta",
      texto: `${formatNumber(linha.entries, 0)} entradas contra ${formatNumber(anterior.entries, 0)} no mês anterior.` });
    if (saldo < 0) leituras.push({ titulo: "Carteira encolhendo. ", tom: "alerta", texto: `Saldo de ${saldo}: saíram mais clientes do que entraram.` });
  }
  if (Number(linha.vendas_caidas) > 0) leituras.push({
    titulo: "Venda caída no mês. ", tom: "neutro",
    texto: `${formatNumber(linha.vendas_caidas, 0)} cliente(s) saíram em até 10 dias. Não entram em churn, taxa nem TPC — nunca chegaram à operação. Se o número crescer, o problema é de qualificação na venda, não de entrega.` });
  if (Number(status.churn_previsto) > 0) leituras.push({
    titulo: "Churn previsto em aberto. ", tom: "alerta",
    texto: `${formatNumber(status.churn_previsto, 0)} cliente(s) com saída sinalizada. Ainda contam como ativos, então a taxa do mês tende a subir quando confirmarem.` });

  if (auditOpen) return <section className="workspace">
    <div className="workspace-head">
      <div><span className="eyebrow">Carteira de Clientes</span><h2>Auditorias e commits</h2><p>Registro numerado, mais recente primeiro.</p></div>
      <button className="btn" onClick={() => setAuditOpen(false)}>← Voltar à carteira</button>
    </div>
    <section className="card"><div className="pf-audit">
      {audit.length ? audit.map((a, i) => <article key={a.id || i}>
        <header><b>{text(a.title || a.commit_code || `Registro ${audit.length - i}`)}</b><small>{formatDay(a.occurred_at)}</small></header>
        <p>{text(a.description || a.body)}</p>
        {a.source && <small className="pf-audit-src">{text(a.source)}</small>}
      </article>) : <div className="empty">Nenhum registro de auditoria ainda. Cada recálculo da carteira passa a ser gravado aqui.</div>}
    </div></section>
  </section>;

  return <section className="workspace portfolio-center">
    <div className="workspace-head">
      <div><span className="eyebrow">Relatório mensal · CSM</span><h2>Carteira de Clientes</h2>
        <p>Referência: {text(linha.label || mesAtivo)} · {formatDay(portfolio.reference)}</p></div>
      <button className="btn" onClick={() => setAuditOpen(true)}>Ver auditorias / commits</button>
    </div>

    <div className="pf-hero card">
      <div className="pf-hero-main"><b>{formatNumber(portfolio.total_active, 0)}</b><span>clientes ativos</span></div>
      <div className="pf-hero-split">{(portfolio.sectors || []).map((s: Row) =>
        <div key={s.sector}><b>{formatNumber(s.active_clients, 0)}</b><small>{SECTOR_LABEL[s.sector] || s.sector}</small></div>)}</div>
      <div className="pf-hero-status">
        <div className="pf-status-title">Resumo de status operacionais</div>
        <div className="pf-status-row">
          <span className={Number(status.inadimplentes) ? "red" : ""}><b>{formatNumber(status.inadimplentes, 0)}</b> inadimplentes</span>
          <span className={Number(status.juridico) ? "yellow" : ""}><b>{formatNumber(status.juridico, 0)}</b> em jurídico</span>
          <span className={Number(status.churn_previsto) ? "red" : ""}><b>{formatNumber(status.churn_previsto, 0)}</b> com churn previsto</span>
        </div>
      </div>
    </div>

    <details className="card pf-block" open>
      <summary><b>Próximas transições</b><span>{transicoes.length}</span><em>mudam de faixa em até 10 dias</em></summary>
      <div className="pf-transitions">
        {transicoes.map((t) => <button key={t.client_id} onClick={() => openClient(t.client_id)}>
          <span className="pf-days"><b>{t.dias_para_proxima}</b><small>dias</small></span>
          <span className="pf-transition-info"><b>{text(t.display_name)}</b>
            <small>{SECTOR_LABEL[t.sector] || t.sector} · passa para {text(t.proxima_faixa)} em {formatDay(t.data_transicao)}</small></span>
          <Chip value="ATTENTION" />
        </button>)}
        {!transicoes.length && <div className="empty">Nenhuma transição nos próximos 10 dias.</div>}
      </div>
    </details>

    <section className="card pf-block">
      <div className="pf-block-head">
        <div><b>Indicadores Gerais</b><small>Selecione o mês e o setor para comparar a evolução da carteira.</small></div>
        <div className="pf-controls">
          <select className="control" value={mesAtivo} onChange={(e) => setMonthKey(e.target.value)}>
            {meses.map((m) => { const r = timeline.find((x) => x.month_key === m);
              return <option key={m} value={m}>{r?.label || m}{r?.origem === "ao_vivo" ? " — atual" : r?.quality === "estimated" ? " — reconstruído" : ""}</option>; })}
          </select>
          <div className="pf-tabs">{["marketing", "ia"].map((s) =>
            <button key={s} className={sector === s ? "active" : ""} onClick={() => setSector(s)}>{SECTOR_LABEL[s]}</button>)}</div>
        </div>
      </div>
      <p className={`pf-quality q-${linha.quality || "high"}`}>{text(linha.quality_label)} · {text(linha.quality_detail)}</p>
      <div className="grid pf-kpis">
        <Kpi label="Clientes ativos" valor={formatNumber(linha.active_clients, 0)} hint={`clientes de ${SECTOR_LABEL[sector]}`} campo="active_clients" />
        <Kpi label="Clientes < 3 meses" valor={formatNumber(linha.clients_less_3m, 0)} hint={`${pct(linha.clients_less_3m)}% da carteira`} />
        <Kpi label="Clientes 3–6 meses" valor={formatNumber(linha.clients_3_6m, 0)} hint={`${pct(linha.clients_3_6m)}% da carteira`} />
        <Kpi label="Clientes > 6 meses" valor={formatNumber(linha.clients_over_6m, 0)} hint={`${pct(linha.clients_over_6m)}% da carteira`} />
        <Kpi label="LTV médio" valor={formatNumber(linha.ltv_months, 2)} unidade="m" hint="tempo médio da carteira ativa" campo="ltv_months" />
        <Kpi label="Entradas no mês" valor={formatNumber(linha.entries, 0)} hint={`novos clientes de ${SECTOR_LABEL[sector]}`} campo="entries" />
        <Kpi label="Churns no mês" valor={formatNumber(linha.churns, 0)} hint={Number(linha.churns) ? "cancelamentos registrados" : "nenhum cancelamento registrado"} campo="churns" inverso />
        <Kpi label="Vendas caídas" valor={formatNumber(linha.vendas_caidas, 0)} hint="saíram em até 10 dias; não contam como churn" />
        <Kpi label="Taxa de churn" valor={formatNumber(linha.churn_rate, 1)} unidade="%" hint={`${formatNumber(linha.churns, 0)} churns sobre base potencial de ${formatNumber(linha.churn_base, 0)}`} campo="churn_rate" inverso />
        <Kpi label="TPC" valor={linha.tpc_months == null ? "—" : formatNumber(linha.tpc_months, 2)} unidade={linha.tpc_months == null ? undefined : "m"} hint={linha.tpc_months == null ? "sem churns para calcular permanência" : "permanência média dos churns"} />
        <Kpi label="Saldo líquido" valor={`${Number(linha.balance) > 0 ? "+" : ""}${formatNumber(linha.balance, 0)}`} hint="entradas menos churns no mês" campo="balance" />
      </div>
    </section>

    <section className="card pf-block pf-reading">
      <div className="pf-block-head"><div><b>Leitura operacional</b><small>O que o movimento das métricas diz sobre a carteira.</small></div></div>
      <div className="pf-reading-list">{leituras.map((l, i) =>
        <p key={i} className={`pf-read ${l.tom}`}><b>{l.titulo}</b>{l.texto}</p>)}
        {!leituras.length && <p className="pf-read neutro"><b>Sem base de comparação.</b>Não há mês anterior para comparar as métricas.</p>}
      </div>
    </section>

    <section className="card pf-block">
      <div className="pf-block-head"><div><b>Evolução e comparação mensal</b><small>Séries de março a {text(linha.label)}.</small></div></div>
      <div className="pf-charts">
        <div><h4>Base ativa</h4><PortfolioChart kind="line" unit="clientes" series={[{ label: "Marketing", values: serieDe("active_clients", "marketing") }, { label: "IA", values: serieDe("active_clients", "ia") }]} /></div>
        <div><h4>Entradas × churns</h4><PortfolioChart kind="bar" unit="clientes" series={[{ label: "Entradas", values: serieDe("entries") }, { label: "Churns", values: serieDe("churns") }]} /></div>
        <div><h4>Taxa de churn</h4><PortfolioChart kind="line" unit="%" series={[{ label: "Churn rate", values: serieDe("churn_rate") }]} /></div>
        <div><h4>LTV × TPC</h4><PortfolioChart kind="line" unit="meses" series={[{ label: "LTV", values: serieDe("ltv_months") }, { label: "TPC", values: serieDe("tpc_months") }]} /></div>
      </div>
      <div className="pf-months">{serieAsc.map((m) => <span key={m}>{m.slice(5)}/{m.slice(2, 4)}</span>)}</div>
    </section>

    <section className="card pf-block">
      <div className="pf-block-head"><div><b>Resumo histórico</b><small>Clique em um mês para abrir seus indicadores.</small></div></div>
      <div className="table-wrap"><table className="pf-history"><thead><tr>
        <th>Mês</th><th>Ativos</th><th>Entradas</th><th>Churns</th><th>Churn rate</th><th>LTV</th><th>TPC</th><th>Saldo</th><th>Qualidade</th><th>Origem</th>
      </tr></thead><tbody>
        {timeline.filter((r) => r.sector === sector).map((r) => <tr key={r.month_key} className={r.month_key === mesAtivo ? "active" : ""} onClick={() => setMonthKey(r.month_key)}>
          <td><b>{text(r.label)}</b></td>
          <td>{formatNumber(r.active_clients, 0)}</td>
          <td>{formatNumber(r.entries, 0)}</td>
          <td>{formatNumber(r.churns, 0)}</td>
          <td>{formatNumber(r.churn_rate, 1)}%</td>
          <td>{formatNumber(r.ltv_months, 2)}</td>
          <td>{r.tpc_months == null ? "—" : formatNumber(r.tpc_months, 2)}</td>
          <td>{Number(r.balance) > 0 ? "+" : ""}{formatNumber(r.balance, 0)}</td>
          <td><span className={`pf-quality-tag q-${r.quality}`}>{text(r.quality_label)}</span></td>
          <td><span className={`pf-origin ${r.origem}`}>{r.origem === "ao_vivo" ? "ao vivo" : "congelado"}</span></td>
        </tr>)}
      </tbody></table></div>
    </section>

    <section className="card pf-block pf-since">
      <div className="pf-block-head"><div><b>Evolução desde janeiro de 2026</b>
        <small>Série reconstruída do dado bruto — alcança janeiro e fevereiro, que o relatório não cobre. É tendência, não fechamento oficial.</small></div></div>
      {evolucao.length > 1 && <>
        <div className="pf-since-cards">{[
          { k: "active_clients", l: "Base ativa", suf: "", casas: 0, melhorSubindo: true },
          { k: "churn_rate", l: "Taxa de churn", suf: "%", casas: 1, melhorSubindo: false },
          { k: "ltv_months", l: "LTV", suf: "m", casas: 2, melhorSubindo: true },
          { k: "tpc_months", l: "TPC", suf: "m", casas: 2, melhorSubindo: true },
        ].map((m) => {
          const ini = Number(evolucao[0][m.k] ?? 0), fim = Number(evolucao[evolucao.length - 1][m.k] ?? 0);
          const var_ = ini ? ((fim - ini) / ini) * 100 : null;
          const melhorou = var_ === null ? null : (m.melhorSubindo ? var_ > 0 : var_ < 0);
          return <article key={m.k} className={`pf-since-card ${melhorou === null ? "" : melhorou ? "bom" : "ruim"}`}>
            <div className="label">{m.l}</div>
            <div className="pf-since-nums"><span>{formatNumber(ini, m.casas)}{m.suf}</span><i>→</i><b>{formatNumber(fim, m.casas)}{m.suf}</b></div>
            {var_ !== null && <div className="pf-since-var">{var_ >= 0 ? "▲" : "▼"} {Math.abs(var_).toFixed(0)}% desde janeiro</div>}
          </article>;
        })}</div>
        <div className="pf-charts">
          <div><h4>Base ativa por mês</h4><PortfolioChart kind="line" unit="clientes" series={[{ label: "Ativos", values: evolucao.map((r: Row) => Number(r.active_clients || 0)) }]} /></div>
          <div><h4>Taxa de churn por mês</h4><PortfolioChart kind="line" unit="%" series={[{ label: "Churn rate", values: evolucao.map((r: Row) => Number(r.churn_base) > 0 ? Number(((Number(r.churns) / Number(r.churn_base)) * 100).toFixed(1)) : 0) }]} /></div>
        </div>
        <div className="pf-months">{evolucao.map((r: Row) => <span key={r.month_key}>{String(r.month_key).slice(5)}</span>)}</div>
        <div className="table-wrap"><table><thead><tr>
          <th>Mês</th><th>Ativos</th><th>Entradas</th><th>Churns</th><th>Vendas caídas</th><th>Taxa</th><th>LTV</th><th>TPC</th><th>Saldo</th>
        </tr></thead><tbody>
          {evolucao.map((r: Row) => { const taxa = Number(r.churn_base) > 0 ? (Number(r.churns) / Number(r.churn_base)) * 100 : 0;
            return <tr key={r.month_key}>
              <td><b>{String(r.month_key)}</b></td>
              <td>{formatNumber(r.active_clients, 0)}</td>
              <td>{formatNumber(r.entries, 0)}</td>
              <td>{formatNumber(r.churns, 0)}</td>
              <td>{formatNumber(r.vendas_caidas, 0)}</td>
              <td className={taxa >= 20 ? "red" : taxa >= 10 ? "yellow" : "green"}>{taxa.toFixed(1)}%</td>
              <td>{r.ltv_months == null ? "—" : formatNumber(r.ltv_months, 2)}</td>
              <td>{r.tpc_months == null ? "—" : formatNumber(r.tpc_months, 2)}</td>
              <td>{(() => { const sd = Number(r.entries) - Number(r.churns) - Number(r.vendas_caidas); return `${sd > 0 ? "+" : ""}${sd}`; })()}</td>
            </tr>; })}
        </tbody></table></div>
        <p className="pf-since-note">O mês corrente está em andamento — entradas e churns ainda podem subir até o fechamento.</p>
      </>}
      {evolucao.length <= 1 && <div className="empty">Série insuficiente para comparar.</div>}
    </section>

    <section className="card pf-block pf-signal">
      <div className="pf-block-head"><div><b>Sinal operacional do ClickUp</b>
        <small>Cliente que parou de gerar task parou de ser atendido. Usa a data de criação do pedido, não de fechamento — em 11–13/07 houve faxina com 232 tasks fechadas contra 21 criadas, e o fechamento marcaria trabalho que não existiu.</small></div></div>
      <div className="pf-signal-list">{["nunca_atendido","silencio_critico","silencio_atencao","aguardando_primeira_task","ia_sem_sinal"].map((k) => {
        const lista = sinaisAtivos.filter((r) => r.sinal === k);
        if (!lista.length) return null;
        const meta = SINAL_META[k];
        return <div key={k} className={`pf-signal-group ${meta.tom}`}>
          <header><b>{meta.rotulo}</b><span>{lista.length}</span><small>{meta.nota}</small></header>
          <div className="pf-signal-items">{lista
            .sort((a, b) => Number(b.dias_sem_pedido ?? 9999) - Number(a.dias_sem_pedido ?? 9999))
            .map((r) => <button key={r.client_id} onClick={() => openClient(r.client_id)}>
              <span><b>{text(r.display_name)}</b><small>{text(r.gt_owner) === "sem registro" ? "sem gestor" : text(r.gt_owner)} · {formatNumber(r.dias_casa, 0)} dias de casa · {formatNumber(r.tasks, 0)} tasks</small></span>
              <span className="pf-signal-days">{r.dias_sem_pedido == null ? "—" : `${r.dias_sem_pedido}d`}</span>
            </button>)}</div>
        </div>;
      })}
      {!sinaisAtivos.length && <div className="empty">Nenhum sinal de silêncio na carteira.</div>}</div>
    </section>

    <section className="card pf-block pf-survival">
      <div className="pf-block-head"><div><b>Curva de sobrevivência</b>
        <small>Risco por faixa de idade: de quem chegou aos X dias, quantos saíram antes da faixa seguinte. Não é a distribuição dos churns — as faixas têm populações diferentes.</small></div></div>
      {previstos !== null && <p className="pf-forecast">
        <b>{previstos.toFixed(1)} churns projetados</b> se a base atual envelhecer no risco histórico de cada faixa.
        {piorFaixa && <> A faixa mais perigosa é <b>{piorFaixa.rotulo}</b>, com {formatNumber(piorFaixa.risco, 1)}% de risco e {piorFaixa.ativos_na_faixa} cliente(s) ali agora.</>}
      </p>}
      <div className="pf-survival-list">{survival.map((f: Row) => {
        const risco = Number(f.expostos) > 0 ? (Number(f.churns) / Number(f.expostos)) * 100 : 0;
        const nivel = risco >= 40 ? "alto" : risco >= 15 ? "medio" : "baixo";
        return <div key={f.ordem} className={`pf-surv-row ${nivel}`}>
          <span className="pf-surv-label">{text(f.rotulo)}</span>
          <div className="pf-surv-bar"><i style={{ width: `${Math.min(100, risco)}%` }} /></div>
          <span className="pf-surv-risk">{risco.toFixed(1)}%</span>
          <small className="pf-surv-detail">{f.churns} de {f.expostos} que chegaram · {f.ativos_na_faixa} ativos hoje</small>
        </div>;
      })}</div>
    </section>

    <section className="card pf-block">
      <div className="pf-block-head"><div><b>Retenção por gestor</b>
        <small>A carteira foi dividida em agosto/2026 — churns anteriores não têm gestor e aparecem agrupados.</small></div></div>
      <div className="table-wrap"><table><thead><tr>
        <th>Gestor</th><th>Ativos</th><th>Churns</th><th>Vendas caídas</th><th>Permanência média</th><th>Idade média dos ativos</th><th>% churn</th>
      </tr></thead><tbody>
        {gtRet.map((g: Row) => <tr key={g.gestor} className={String(g.gestor).startsWith("(") ? "inactive-member" : ""}>
          <td><b>{text(g.gestor)}</b></td>
          <td>{formatNumber(g.ativos, 0)}</td>
          <td>{formatNumber(g.churns, 0)}</td>
          <td>{formatNumber(g.vendas_caidas, 0)}</td>
          <td>{g.permanencia_media_dias == null ? "—" : `${formatNumber(g.permanencia_media_dias, 0)} dias`}</td>
          <td>{g.idade_media_ativos == null ? "—" : `${formatNumber(g.idade_media_ativos, 0)} dias`}</td>
          <td>{g.churn_pct == null ? "—" : `${formatNumber(g.churn_pct, 1)}%`}</td>
        </tr>)}
        {!gtRet.length && <tr><td colSpan={7}><div className="empty">Sem dados de retenção por gestor.</div></td></tr>}
      </tbody></table></div>
    </section>

    <section className="card pf-block">
      <div className="pf-block-head"><div><b>Distribuição por Tempo de Casa</b><small>Ativos de {SECTOR_LABEL[sector]}</small></div></div>
      <div className="pf-tenure">{["ate_1m", "m1_2", "m2_3", "m3_4", "m4_5", "m5_6", "mais_6m"].map((f) => {
        const v = Number(tenure.find((t) => t.faixa === f)?.clientes ?? 0);
        return <div key={f}><span>{TENURE_LABEL[f]}</span><div><i style={{ width: `${(v / maxTenure) * 100}%` }} /></div><b>{v}</b></div>;
      })}</div>
    </section>

    <section className="card pf-block">
      <div className="pf-block-head">
        <div><b>Clientes por Tempo de Operação</b><small>Filtre pela urgência de avanço de faixa.</small></div>
        <div className="pf-tabs">{["todos", "urgente", "atencao", "ok", "confort"].map((u) =>
          <button key={u} className={urgency === u ? "active" : ""} onClick={() => setUrgency(u)}>{u === "todos" ? "Todos" : URGENCY_LABEL[u]}</button>)}</div>
      </div>
      <div className="pf-segments">{["LESS_3M", "M3_6", "OVER_6M"].map((banda) => {
        const lista = doSetor.filter((c) => c.banda === banda && (urgency === "todos" || c.urgencia === urgency));
        return <article className="pf-segment" key={banda}>
          <header><b>{BAND_LABEL[banda]}</b><span>{lista.length}</span></header>
          <div className="pf-segment-list">
            {lista.slice(0, 40).map((c) => <button key={c.client_id} onClick={() => openClient(c.client_id)}>
              <span><b>{text(c.display_name)}</b><small>Entrada {formatDay(c.entrada)}</small></span>
              <span className={`pf-badge ${c.urgencia}`}>{c.dias_para_proxima == null ? "veterano" : `${c.dias_para_proxima}d`}</span>
            </button>)}
            {!lista.length && <div className="empty">Nenhum cliente nesta faixa.</div>}
            {lista.length > 40 && <small className="pf-more">+{lista.length - 40} clientes</small>}
          </div>
        </article>;
      })}</div>
    </section>

    <details className="card pf-block">
      <summary><b>Churns registrados</b><span>{churns.length}</span></summary>
      <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Entrada</th><th>Saída</th><th>Permanência</th><th>Qualidade</th></tr></thead>
      <tbody>
        {churns.map((c) => <tr key={c.id}>
          <td><b>{text(c.client_name)}</b></td><td>{formatDay(c.entrada)}</td><td>{formatDay(c.saida)}</td>
          <td>{c.permanencia_dias ? `${c.permanencia_dias} dias · ${(Number(c.permanencia_dias) / 30).toFixed(1)} m` : "—"}</td>
          <td>{text(c.qualidade || (c.confirmed ? "Confirmada" : "Estimada"))}</td>
        </tr>)}
        {!churns.length && <tr><td colSpan={5}><div className="empty">Nenhum churn no log. Esta tabela alimenta o TPC e a taxa de churn.</div></td></tr>}
      </tbody></table></div>
    </details>
  </section>;
}


