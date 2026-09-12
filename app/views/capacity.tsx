"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiPost, formatDay, formatMoney, formatNumber, Metric } from "../shared";
import { resolverConfig, type ConfigCapacidade, type MetricaKey } from "../../shared/capacity/config";
import { calcularScores, type EntradaCliente, type ScoreCliente } from "../../shared/capacity/workload";
import { agregarPorResponsavel, resumirOperacao, type CapacidadeResponsavel, type CargaResponsavel } from "../../shared/capacity/capacity";
import { preverSaturacao, type HistoricoCrescimento } from "../../shared/capacity/forecast";
import { simularContratacao, simularCrescimento } from "../../shared/capacity/simulate";
import { recomendarProximoCliente, RuleBasedInsightsProvider } from "../../shared/capacity/insights";

type MetricRow = {
  client_id: string; display_name: string; lifecycle: string; gt_owner: string | null; entrada: string | null;
  whatsapp_7d: number | string; whatsapp_30d: number | string; tasks_7d: number | string; tasks_30d: number | string;
  criativos_7d: number | string; criativos_30d: number | string; reunioes_7d: number | string; reunioes_30d: number | string;
  alertas_7d: number | string; alertas_30d: number | string; risco_7d: number | string; risco_30d: number | string;
};
type Setting = { scope_type: string; scope_id: string; capacity_points: number | string | null; monthly_cost: number | string | null; hiring_lead_time_days: number; active: boolean };
type Override = { client_id: string; score_override: number | string; reason: string; valid_until: string | null; created_by: string; created_at: string };
type HistoryRow = { snapshot_date: string; scope_id: string; metadata: any };
type Payload = { metrics: MetricRow[]; settings: Setting[]; overrides: Override[]; weights: any[]; growth: any; history: HistoryRow[]; roster: any[]; commercial_terms: any[]; calibration: any; generated_at: string };

const KEYS: MetricaKey[] = ["whatsapp", "tasks", "criativos", "reunioes", "alertas", "risco"];
const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
function corFaixa(faixa: string) {
  if (faixa === "SAUDAVEL") return "#22c55e";
  if (faixa === "ATENCAO") return "#eab308";
  if (faixa === "LIMITE") return "#f97316";
  if (faixa === "CRITICO" || faixa === "SOBRECARGA") return "#ef4444";
  return "#64748b";
}
function labelFaixa(faixa: string) {
  return ({ SAUDAVEL:"Saudável", ATENCAO:"Atenção", LIMITE:"Próximo do limite", CRITICO:"Crítico", SOBRECARGA:"Sobrecarga", NAO_CALIBRADO:"Não calibrado" } as Record<string,string>)[faixa] || faixa;
}
function Barra({ valor, cor }: { valor: number | null; cor: string }) {
  return <div style={{ height: 7, borderRadius: 999, background: "rgba(148,163,184,.16)", overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, valor ?? 0))}%`, height: "100%", background: cor, transition: "width .25s ease" }} />
  </div>;
}
function metricas(row: MetricRow, janela: "7d" | "30d") {
  return {
    whatsapp: num(row[`whatsapp_${janela}`]), tasks: num(row[`tasks_${janela}`]), criativos: num(row[`criativos_${janela}`]),
    reunioes: num(row[`reunioes_${janela}`]), alertas: num(row[`alertas_${janela}`]), risco: num(row[`risco_${janela}`]),
  };
}
function configFrom(payload: Payload | null): ConfigCapacidade {
  if (!payload) return resolverConfig();
  const pesos: any = {};
  for (const row of payload.weights || []) if (row.enabled !== false && KEYS.includes(row.metric_key)) pesos[row.metric_key] = num(row.weight);
  const area = (payload.settings || []).find((s) => s.scope_type === "AREA" && s.scope_id === "GT");
  return resolverConfig({ pesos, leadTimeContratacaoDias: Number(area?.hiring_lead_time_days || 14) });
}
function entradasFrom(payload: Payload): EntradaCliente[] {
  const overrides = new Map((payload.overrides || []).map((o) => [String(o.client_id), o]));
  return (payload.metrics || []).map((row) => {
    const ov = overrides.get(String(row.client_id));
    return {
      clientId: String(row.client_id), nome: String(row.display_name || "Sem nome"), lifecycle: row.lifecycle as EntradaCliente["lifecycle"], gtOwner: row.gt_owner || null,
      metricas7d: metricas(row, "7d"), metricas30d: metricas(row, "30d"),
      override: ov ? { valor: num(ov.score_override), motivo: ov.reason, autor: ov.created_by, criadoEm: ov.created_at, validoAte: ov.valid_until } : null,
    };
  });
}
function historySeries(history: HistoryRow[], config: ConfigCapacidade) {
  const byDay = new Map<string, EntradaCliente[]>();
  for (const row of history || []) {
    const m = row.metadata || {};
    const list = byDay.get(row.snapshot_date) || [];
    list.push({ clientId: row.scope_id, nome: m.display_name || row.scope_id, lifecycle: m.lifecycle, gtOwner: m.gt_owner || null, metricas7d: m.metricas7d || {}, metricas30d: m.metricas30d || {} });
    byDay.set(row.snapshot_date, list);
  }
  return [...byDay.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([day, clients]) => ({ day, load: calcularScores(clients, config).reduce((s,c) => s + c.score, 0) }));
}
function HistoryChart({ points }: { points: { day: string; load: number }[] }) {
  if (points.length < 2) return <div className="empty compact">Histórico iniciado hoje. A tendência aparecerá a partir do segundo snapshot diário.</div>;
  const max = Math.max(...points.map((p) => p.load), 1), min = Math.min(...points.map((p) => p.load), max);
  const span = Math.max(1, max - min), coords = points.map((p,i) => `${(i/(points.length-1))*100},${90-((p.load-min)/span)*70}`).join(" ");
  return <div><svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width:"100%", height:150 }}><polyline points={coords} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><div className="small">{formatDay(points[0].day)} → {formatDay(points.at(-1)?.day)} · carga {formatNumber(points.at(-1)?.load || 0,1)} pts</div></div>;
}
export function CapacityCenter({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [capacityDraft, setCapacityDraft] = useState<Record<string,string>>({});
  const [newClients, setNewClients] = useState(20);
  const [expectedChurn, setExpectedChurn] = useState(3);
  const [periodDays, setPeriodDays] = useState<7|15|30|60|90>(60);
  const [hireQty, setHireQty] = useState(1);
  const [hireCapacity, setHireCapacity] = useState("");
  const [hireCost, setHireCost] = useState("");
  const [marginPerClient, setMarginPerClient] = useState("");
  const [operationCost, setOperationCost] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await api("capacity", token) as Payload;
      setPayload(data);
      const next: Record<string,string> = {};
      for (const gt of data.roster || []) {
        const setting = (data.settings || []).find((s) => s.scope_type === "PERSON" && s.scope_id === gt.person);
        next[gt.person] = setting?.capacity_points ? String(setting.capacity_points) : "";
      }
      setCapacityDraft(next);
      const op = (data.settings || []).find((s) => s.scope_type === "AREA" && s.scope_id === "OPERATION");
      setOperationCost(op?.monthly_cost ? String(op.monthly_cost) : "");
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar capacidade"); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  const config = useMemo(() => configFrom(payload), [payload]);
  const entradas = useMemo(() => payload ? entradasFrom(payload) : [], [payload]);
  const scores = useMemo(() => calcularScores(entradas, config), [entradas, config]);
  const responsaveis = useMemo<CapacidadeResponsavel[]>(() => (payload?.roster || []).map((gt) => {
    const setting = (payload?.settings || []).find((s) => s.scope_type === "PERSON" && s.scope_id === gt.person);
    return { pessoa: gt.person, papel: "GT", capacidadePontos: num(setting?.capacity_points), ativo: true };
  }), [payload]);
  const agregado = useMemo(() => agregarPorResponsavel(scores, responsaveis, config), [scores, responsaveis, config]);
  const resumo = useMemo(() => resumirOperacao(agregado.cargas, agregado.semResponsavel, config), [agregado, config]);
  const recentIds = useMemo(() => new Set((payload?.metrics || []).filter((r) => r.entrada && Date.now()-new Date(`${r.entrada}T12:00:00`).getTime() <= 90*86400000).map((r) => r.client_id)), [payload]);
  const avgNewLoad = useMemo(() => {
    const recent = scores.filter((s) => recentIds.has(s.clientId));
    const base = recent.length ? recent : scores;
    return base.length ? base.reduce((sum,s) => sum+s.score,0)/base.length : 1;
  }, [scores, recentIds]);
  const growth = payload?.growth || {};
  const hist: HistoricoCrescimento = { liquido30d:num(growth.net_30d), liquido60d:num(growth.net_60d), liquido90d:num(growth.net_90d), cargaMediaNovoCliente:avgNewLoad };
  const forecast = useMemo(() => preverSaturacao(resumo.cargaPontos, resumo.capacidadePontos, hist, config), [resumo, hist.liquido30d, hist.liquido60d, hist.liquido90d, hist.cargaMediaNovoCliente, config]);
  const state = useMemo(() => ({ resumo, cargas:agregado.cargas, previsao:forecast, semResponsavel:agregado.semResponsavel }), [resumo, agregado, forecast]);
  const provider = useMemo(() => new RuleBasedInsightsProvider(), []);
  const recommendations = useMemo(() => provider.recomendar(state, config), [provider, state, config]);
  const executive = useMemo(() => provider.resumoExecutivo(state, config), [provider, state, config]);
  const nextGt = useMemo(() => recomendarProximoCliente(agregado.cargas), [agregado.cargas]);
  const heavy = useMemo(() => [...scores].sort((a,b) => b.score-a.score).slice(0,15), [scores]);
  const history = useMemo(() => historySeries(payload?.history || [], config), [payload, config]);
  const growthSim = useMemo(() => simularCrescimento(agregado.cargas, { novosClientes:newClients, churnPrevisto:expectedChurn, periodoDias:periodDays, cargaMediaNovoCliente:avgNewLoad }, config), [agregado.cargas,newClients,expectedChurn,periodDays,avgNewLoad,config]);
  const calibratedCaps = agregado.cargas.filter((c) => c.capacidadePontos>0).map((c) => c.capacidadePontos);
  const suggestedHireCap = calibratedCaps.length ? calibratedCaps.reduce((a,b)=>a+b,0)/calibratedCaps.length : 0;
  const hireCapValue = num(hireCapacity) || suggestedHireCap;
  const hireSim = useMemo(() => simularContratacao(resumo.cargaPontos,resumo.capacidadePontos,resumo.cargaMediaPorCliente,{ quantidade:hireQty,papel:"GT",capacidadePontosPorPessoa:hireCapValue,custoMensalPorPessoa:hireCost ? num(hireCost) : null,margemEstimadaPorCliente:marginPerClient ? num(marginPerClient) : null }), [resumo,hireQty,hireCapValue,hireCost,marginPerClient]);
  const termByClient = useMemo(() => new Map((payload?.commercial_terms || []).map((t) => [String(t.client_id),t])), [payload]);
  const scoreById = useMemo(() => new Map(scores.map((s) => [s.clientId,s])), [scores]);
  const opCost = num(operationCost);
  const costPerPoint = opCost>0 && resumo.cargaPontos>0 ? opCost/resumo.cargaPontos : null;
  const financialRows = useMemo(() => heavy.map((s) => {
    const term = termByClient.get(s.clientId) as any;
    const revenue = num(term?.monthly_value || term?.service_fee_amount) || null;
    const estimatedCost = costPerPoint ? s.score*costPerPoint : null;
    return { ...s,revenue,estimatedCost,margin: revenue && estimatedCost ? revenue-estimatedCost : null };
  }), [heavy,termByClient,costPerPoint]);

  async function saveCapacity(person: string) {
    setSaving(person);
    try { await apiPost("capacity-setting-upsert", token, { scope_type:"PERSON",scope_id:person,capacity_points:capacityDraft[person] || null }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar capacidade"); }
    finally { setSaving(""); }
  }
  async function saveOperationCost() {
    setSaving("OPERATION");
    try { await apiPost("capacity-setting-upsert", token, { scope_type:"AREA",scope_id:"OPERATION",capacity_points:null,monthly_cost:operationCost || null }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar custo operacional"); }
    finally { setSaving(""); }
  }
  return <section className="workspace">
    <div className="workspace-head"><div><h2>Capacidade Operacional</h2><p>Motor de decisão por carga real. Cliente não vale “1”: WhatsApp, tasks, criativos, reuniões, alertas e risco formam o workload.</p></div><span className="counter">{payload ? `Atualizado ${new Intl.DateTimeFormat("pt-BR",{hour:"2-digit",minute:"2-digit"}).format(new Date(payload.generated_at))}` : "carregando"}</span></div>
    {error && <div className="error-box">{error}</div>}

    <div className="grid clickup-kpis">
      <Metric label="Capacidade utilizada" value={resumo.utilizacaoPct==null ? "Não calibrada" : `${formatNumber(resumo.utilizacaoPct,1)}%`} tone={resumo.utilizacaoPct!=null && resumo.utilizacaoPct>=90 ? "red" : resumo.utilizacaoPct!=null && resumo.utilizacaoPct>=70 ? "yellow" : "blue"} hint={resumo.utilizacaoPct==null ? "configure pontos por GT abaixo" : `${formatNumber(resumo.cargaPontos,1)} / ${formatNumber(resumo.capacidadePontos,1)} pontos`} loading={loading}/>
      <Metric label="Folga operacional" value={resumo.folgaPct==null ? "—" : `${formatNumber(resumo.folgaPct,1)}%`} tone="blue" hint={resumo.folgaPontos==null ? "aguardando calibração" : `${formatNumber(resumo.folgaPontos,1)} pontos livres`} loading={loading}/>
      <Metric label="Clientes operacionais" value={formatNumber(resumo.clientesReais,0)} tone="blue" hint={`${resumo.clientesOnboarding} em onboarding · ${agregado.semResponsavel.clientes} sem GT`} loading={loading}/>
      <Metric label="Clientes equivalentes" value={formatNumber(resumo.clientesEquivalentes,1)} tone="blue" hint={`média ${formatNumber(resumo.cargaMediaPorCliente||0,2)} ponto/cliente`} loading={loading}/>
      <Metric label="Até 90%" value={forecast.ate90.dataEstimada ? formatDay(forecast.ate90.dataEstimada) : "—"} tone="yellow" hint={forecast.ate90.diasUteis!=null ? `${forecast.ate90.diasUteis} dias úteis` : forecast.ate90.motivo || "sem estimativa"} loading={loading}/>
      <Metric label="Próximo cliente" value={nextGt.recomendado?.pessoa?.split(" ")[0] || "—"} tone="blue" hint={nextGt.recomendado ? `${formatNumber(nextGt.recomendado.folgaPontos,1)} pts livres` : "capacidade ainda não calibrada"} loading={loading}/>
    </div>
    <section className="card section" style={{ marginBottom:14 }}>
      <div className="section-head"><div><div className="section-title">Leitura executiva</div><div className="small">Determinística: mesma situação produz a mesma recomendação, sem custo de LLM.</div></div></div>
      <p style={{ margin:"4px 0 12px", lineHeight:1.55 }}>{executive}</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:9 }}>
        {recommendations.slice(0,6).map((r) => <div key={`${r.codigo}-${r.titulo}`} style={{ border:`1px solid ${r.severidade==="CRITICO"?"rgba(239,68,68,.28)":"rgba(148,163,184,.14)"}`, borderRadius:10,padding:11,background:"rgba(15,23,42,.28)" }}><b>{r.titulo}</b><div className="small" style={{ marginTop:5,lineHeight:1.45 }}>{r.detalhe}</div></div>)}
      </div>
    </section>

    <section className="card section" style={{ marginBottom:14 }}>
      <div className="section-head"><div><div className="section-title">Capacidade por GT</div><div className="small">Capacidade não é inventada. Configure o limite de cada profissional; novos GTs aparecem mesmo com carteira vazia.</div></div></div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(270px,1fr))", gap:10 }}>
        {agregado.cargas.map((c) => <GtCard key={c.pessoa} carga={c} draft={capacityDraft[c.pessoa]||""} setDraft={(v)=>setCapacityDraft((prev)=>({...prev,[c.pessoa]:v}))} save={()=>saveCapacity(c.pessoa)} saving={saving===c.pessoa}/>) }
      </div>
    </section>
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(330px,1fr))", gap:14, marginBottom:14 }}>
      <section className="card section">
        <div className="section-title">Simular crescimento</div><div className="small">E se o comercial trouxer mais clientes?</div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginTop:12 }}>
          <label className="small">Entradas<input type="number" min={0} max={100} value={newClients} onChange={(e)=>setNewClients(num(e.target.value))}/></label>
          <label className="small">Churn<input type="number" min={0} max={100} value={expectedChurn} onChange={(e)=>setExpectedChurn(num(e.target.value))}/></label>
          <label className="small">Período<select value={periodDays} onChange={(e)=>setPeriodDays(Number(e.target.value) as any)}><option value={7}>7 dias</option><option value={15}>15 dias</option><option value={30}>30 dias</option><option value={60}>60 dias</option><option value={90}>90 dias</option></select></label>
        </div>
        <div style={{ marginTop:14,display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8 }}><div><div className="label">Hoje</div><b>{growthSim.utilizacaoAntesPct==null?"—":`${formatNumber(growthSim.utilizacaoAntesPct,1)}%`}</b></div><div><div className="label">Depois</div><b style={{ color:corFaixa(growthSim.faixaDepois) }}>{growthSim.utilizacaoDepoisPct==null?"—":`${formatNumber(growthSim.utilizacaoDepoisPct,1)}%`}</b></div></div>
        <p className="small">Carga adicional: <b>{formatNumber(growthSim.cargaAdicionalPontos,1)} pts</b> · GTs ≥90%: <b>{growthSim.responsaveisAcimaDoLimite}</b></p>
        <div className="table-wrap"><table><thead><tr><th>GT</th><th>Hoje</th><th>Projetado</th></tr></thead><tbody>{growthSim.impactos.map((i)=><tr key={i.pessoa}><td>{i.pessoa}</td><td>{i.utilizacaoAntesPct==null?"—":`${i.utilizacaoAntesPct}%`}</td><td style={{color:corFaixa(i.faixaDepois),fontWeight:700}}>{i.utilizacaoDepoisPct==null?"—":`${i.utilizacaoDepoisPct}%`}</td></tr>)}</tbody></table></div>
      </section>

      <section className="card section">
        <div className="section-title">Simular contratação</div><div className="small">Impacto de +GT sem inventar custo ou margem.</div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginTop:12 }}>
          <label className="small">Quantidade<input type="number" min={0} max={10} value={hireQty} onChange={(e)=>setHireQty(num(e.target.value))}/></label>
          <label className="small">Capacidade/GT<input type="number" min={0} value={hireCapacity} placeholder={suggestedHireCap?formatNumber(suggestedHireCap,1):"informe"} onChange={(e)=>setHireCapacity(e.target.value)}/></label>
          <label className="small">Custo mensal/GT<input type="number" min={0} value={hireCost} placeholder="R$" onChange={(e)=>setHireCost(e.target.value)}/></label>
          <label className="small">Margem/cliente<input type="number" min={0} value={marginPerClient} placeholder="R$" onChange={(e)=>setMarginPerClient(e.target.value)}/></label>
        </div>
        <p style={{ marginTop:14 }}><b>{hireSim.utilizacaoAntesPct==null?"—":`${hireSim.utilizacaoAntesPct}%`}</b> → <b>{hireSim.utilizacaoDepoisPct==null?"—":`${hireSim.utilizacaoDepoisPct}%`}</b> de utilização</p>
        <p className="small">+{formatNumber(hireSim.capacidadeAdicionalPontos,1)} pts · +{hireSim.clientesEquivalentesAdicionais ?? "—"} clientes equivalentes · custo {hireSim.custoMensalTotal==null?"não informado":formatMoney(hireSim.custoMensalTotal)}</p>
        <p className="small">Clientes para pagar a contratação: <b>{hireSim.clientesParaPagarContratacao ?? "—"}</b>{hireSim.faltando.length ? ` · falta: ${hireSim.faltando.join(", ")}` : ""}</p>
      </section>
    </div>
    <div style={{ display:"grid",gridTemplateColumns:"minmax(0,1.35fr) minmax(300px,.65fr)",gap:14,marginBottom:14 }}>
      <section className="card section">
        <div className="section-head"><div><div className="section-title">Clientes que mais consomem operação</div><div className="small">Ranking pelo workload combinado de 7 e 30 dias.</div></div></div>
        <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>GT</th><th>Score</th><th>Maior componente</th><th>Origem</th></tr></thead><tbody>{heavy.map((s)=>{
          const top=[...s.componentes].sort((a,b)=>b.contribuicao-a.contribuicao)[0];
          return <tr key={s.clientId}><td><b>{s.nome}</b><div className="small">{s.lifecycle==="ONBOARDING"?"Onboarding":"Ativo"}</div></td><td>{s.gtOwner||"Sem GT"}</td><td><b>{formatNumber(s.score,2)}</b></td><td>{top?.metrica||"—"}<div className="small">{top?`${formatNumber(top.contribuicao*100,1)}% da intensidade`:""}</div></td><td>{s.origem==="OVERRIDE"?"Manual":"Automático"}</td></tr>;
        })}</tbody></table></div>
      </section>

      <section className="card section">
        <div className="section-title">Histórico de carga</div><div className="small">Snapshot diário com a mesma fórmula do score atual.</div>
        <div style={{ marginTop:12,color:"#60a5fa" }}><HistoryChart points={history}/></div>
        <div style={{ borderTop:"1px solid rgba(148,163,184,.14)",marginTop:14,paddingTop:12 }}><div className="section-title">Custo operacional</div><div className="small">Opcional. Informe o custo mensal real da operação para estimar custo por cliente ponderado pela carga.</div><div style={{display:"flex",gap:8,marginTop:8}}><input type="number" min={0} value={operationCost} onChange={(e)=>setOperationCost(e.target.value)} placeholder="Custo mensal total (R$)"/><button onClick={saveOperationCost} disabled={saving==="OPERATION"}>{saving==="OPERATION"?"Salvando…":"Salvar"}</button></div>{costPerPoint && <div className="small" style={{marginTop:7}}>Custo estimado por ponto: <b>{formatMoney(costPerPoint)}</b></div>}</div>
      </section>
    </div>
    {costPerPoint && <section className="card section" style={{marginBottom:14}}>
      <div className="section-head"><div><div className="section-title">Margem operacional estimada por cliente pesado</div><div className="small">Não é lucro contábil. Rateia o custo informado pelos pontos de workload e cruza com mensalidade quando ela existe.</div></div></div>
      <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Score</th><th>Receita contratual</th><th>Custo estimado</th><th>Margem estimada</th></tr></thead><tbody>{financialRows.map((r)=><tr key={r.clientId}><td>{r.nome}</td><td>{formatNumber(r.score,2)}</td><td>{r.revenue?formatMoney(r.revenue):"Sem dado"}</td><td>{r.estimatedCost?formatMoney(r.estimatedCost):"—"}</td><td style={{fontWeight:700,color:r.margin!=null&&r.margin<0?"#ef4444":undefined}}>{r.margin!=null?formatMoney(r.margin):"—"}</td></tr>)}</tbody></table></div>
    </section>}

    <section className="card section">
      <div className="section-head"><div><div className="section-title">Premissas e cobertura</div><div className="small">Previsão é estimativa, nunca promessa.</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:9}}>
        {forecast.premissas.map((p)=><div key={p.rotulo} style={{padding:10,border:"1px solid rgba(148,163,184,.13)",borderRadius:9}}><div className="label">{p.rotulo}</div><b>{p.valor}</b></div>)}
        <div style={{padding:10,border:"1px solid rgba(148,163,184,.13)",borderRadius:9}}><div className="label">Cobertura comercial</div><b>{payload ? `${payload.commercial_terms.length}/${payload.metrics.length} clientes` : "—"}</b></div>
        <div style={{padding:10,border:"1px solid rgba(148,163,184,.13)",borderRadius:9}}><div className="label">Calibração</div><b>{payload ? `${payload.calibration?.configured_people||0}/${payload.calibration?.active_gts||0} GTs` : "—"}</b></div>
      </div>
    </section>
  </section>;
}
function GtCard({ carga, draft, setDraft, save, saving }: { carga:CargaResponsavel; draft:string; setDraft:(v:string)=>void; save:()=>void; saving:boolean }) {
  const color=corFaixa(carga.faixa);
  return <article style={{border:"1px solid rgba(148,163,184,.14)",borderRadius:11,padding:12,background:"rgba(15,23,42,.28)"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center"}}><div><b>{carga.pessoa}</b><div className="small">{carga.clientes} clientes · {carga.clientesOnboarding} onboarding</div></div><span style={{color,fontWeight:800,fontSize:10}}>{labelFaixa(carga.faixa)}</span></div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"end",margin:"12px 0 7px"}}><div><div className="label">Carga</div><b>{formatNumber(carga.cargaPontos,1)} pts</b></div><div style={{textAlign:"right"}}><div className="label">Utilização</div><b style={{color}}>{carga.utilizacaoPct==null?"—":`${formatNumber(carga.utilizacaoPct,1)}%`}</b></div></div>
    <Barra valor={carga.utilizacaoPct} cor={color}/>
    <div style={{display:"flex",gap:7,marginTop:10,alignItems:"end"}}><label className="small" style={{flex:1}}>Capacidade em pontos<input type="number" min={0.1} step={0.5} value={draft} onChange={(e)=>setDraft(e.target.value)} placeholder="Não calibrado"/></label><button onClick={save} disabled={saving}>{saving?"…":"Salvar"}</button></div>
    <div className="small" style={{marginTop:6}}>{carga.folgaPontos==null?"Defina a capacidade para habilitar previsão e roteamento.":`Folga: ${formatNumber(carga.folgaPontos,1)} pontos.`}</div>
  </article>;
}
