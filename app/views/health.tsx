"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Chip, Metric, SUPABASE_ANON_KEY, SUPABASE_URL, formatNumber, text } from "../shared";

const HEALTH_URL = `${SUPABASE_URL}/functions/v1/agency-ops-client-health`;

type Linha = {
  client_id: string; display_name: string | null; lifecycle: string | null; gt_owner: string | null; cs_owner: string | null;
  internal_score: number | string | null; internal_band: string | null;
  external_satisfaction_avg: number | string | null; external_risk_avg: number | string | null;
  external_health_status: string | null; external_risk_level: string | null; external_summary: string | null;
  external_recommended_action: string | null; external_source_url: string | null; external_source_updated_at: string | null;
  sentimento: string | null; sinais_alerta: string | null; sinais_positivos: string | null; reclamacoes: string | null;
  responsavel_acao: string | null; analises: number | null; crosscheck_status: string | null; prioridade: number | string | null;
  operational_score: number | null; result_score: number | null; health_score: number | null; risk_score: number | null;
  health_band: "SAUDÁVEL" | "ATENÇÃO" | "CRÍTICO" | string;
  operational_factors: string[]; result_factors: string[]; overdue_slas?: Record<string, unknown>[];
  operational_snapshot?: Record<string, unknown> | null; campaign_snapshot?: Record<string, unknown> | null;
  latest_weekly_report?: Record<string, unknown> | null;
};
type Perfil = { person: string | null; role: string | null; scoped: boolean; carteira: string | null };
type Resumo = {
  total: number; ativos: number; saudaveis: number; atencao: number; criticos: number;
  risco_alto: number; insatisfeitos: number; sentimento_negativo: number; divergentes: number; sem_dado_externo: number;
  satisfacao_media: number | null; risco_medio: number | null; saude_media: number | null; operacional_media: number | null; resultado_media: number | null;
};
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const SENTIMENTO: Record<string, string> = { Positivo: "#22c55e", Neutro: "#94a3b8", Negativo: "#f97316", Crítico: "#ef4444" };
function faixaSaude(v: number | null) {
  if (v === null) return { cor: "#64748b", rotulo: "sem dado" };
  if (v < 50) return { cor: "#ef4444", rotulo: "crítico" };
  if (v < 70) return { cor: "#eab308", rotulo: "atenção" };
  return { cor: "#22c55e", rotulo: "saudável" };
}
function faixaRisco(v: number | null) {
  if (v === null) return { cor: "#64748b", rotulo: "sem dado" };
  if (v >= 70) return { cor: "#ef4444", rotulo: "crítico" };
  if (v >= 50) return { cor: "#f97316", rotulo: "alto" };
  if (v >= 30) return { cor: "#eab308", rotulo: "atenção" };
  return { cor: "#22c55e", rotulo: "baixo" };
}
function faixaSatisfacao(v: number | null) {
  if (v === null) return { cor: "#64748b", rotulo: "sem dado" };
  if (v >= 70) return { cor: "#22c55e", rotulo: "saudável" };
  if (v >= 50) return { cor: "#eab308", rotulo: "morno" };
  if (v >= 30) return { cor: "#f97316", rotulo: "insatisfeito" };
  return { cor: "#ef4444", rotulo: "crítico" };
}
function Barra({ valor, cor }: { valor: number | null; cor: string }) {
  return <div style={{ height: 5, borderRadius: 999, background: "rgba(148,163,184,.18)", overflow: "hidden", minWidth: 54 }}><div style={{ width: `${Math.max(0, Math.min(100, valor ?? 0))}%`, height: "100%", background: cor }} /></div>;
}
function mainReason(l: Linha) {
  const factors = [...(l.operational_factors || []), ...(l.result_factors || [])].filter(Boolean);
  if (factors.length) return factors[0];
  if (l.sinais_alerta) return text(l.sinais_alerta);
  if (l.reclamacoes) return `Reclamações: ${text(l.reclamacoes)}`;
  return "Sem sinal crítico identificado.";
}
function bandStyle(band: string) {
  return band === "CRÍTICO" ? { background: "rgba(239,68,68,.12)", color: "#f87171", border: "1px solid rgba(239,68,68,.22)" }
    : band === "ATENÇÃO" ? { background: "rgba(234,179,8,.11)", color: "#eab308", border: "1px solid rgba(234,179,8,.2)" }
    : { background: "rgba(34,197,94,.10)", color: "#4ade80", border: "1px solid rgba(34,197,94,.19)" };
}

export function HealthCenter({ token }: { token: string }) {
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "criticos" | "atencao" | "externo" | "divergentes">("todos");
  const [aberto, setAberto] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    try {
      const resposta = await fetch(HEALTH_URL, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" });
      if (resposta.status === 403) throw new Error("Seu perfil não tem acesso a esta aba.");
      if (!resposta.ok) throw new Error(`Falha ao carregar (HTTP ${resposta.status})`);
      const corpo = await resposta.json();
      setLinhas(corpo.clients || []); setResumo(corpo.resumo || null); setPerfil(corpo.profile || null);
    } catch (caught) { setErro(caught instanceof Error ? caught.message : "Falha ao carregar a saúde dos clientes"); }
    finally { setCarregando(false); }
  }, [token]);
  useEffect(() => { carregar(); }, [carregar]);

  const ativos = useMemo(() => linhas.filter((l) => l.lifecycle === "ACTIVE" || l.lifecycle === "ONBOARDING"), [linhas]);
  const urgentes = useMemo(() => ativos.filter((l) => l.health_band === "CRÍTICO" || l.health_band === "ATENÇÃO").slice(0, 8), [ativos]);
  const visiveis = useMemo(() => {
    const agulha = busca.trim().toLocaleLowerCase("pt-BR");
    return ativos
      .filter((l) => !agulha || [l.display_name, l.cs_owner, l.gt_owner, ...(l.operational_factors || []), ...(l.result_factors || []), l.sinais_alerta, l.reclamacoes].join(" ").toLocaleLowerCase("pt-BR").includes(agulha))
      .filter((l) => {
        if (filtro === "criticos") return l.health_band === "CRÍTICO";
        if (filtro === "atencao") return l.health_band === "ATENÇÃO";
        if (filtro === "externo") return (num(l.external_risk_avg) ?? 0) >= 50;
        if (filtro === "divergentes") return l.crosscheck_status === "CONFLICT" || l.crosscheck_status === "PARTIAL";
        return true;
      });
  }, [ativos, busca, filtro]);

  return <section className="workspace">
    <div className="workspace-head"><div><h2>Saúde dos clientes</h2><p>Separada em saúde operacional e saúde de resultado. A classificação geral respeita a dimensão mais fraca e sempre explica o motivo.</p></div><span className="counter">{visiveis.length} de {resumo?.ativos ?? 0} ativos{perfil?.carteira ? ` · carteira ${perfil.carteira}` : ""}</span></div>

    <div className="grid clickup-kpis">
      <Metric label="Críticos" value={formatNumber(resumo?.criticos ?? 0, 0)} tone="red" hint="saúde geral < 50" loading={carregando} />
      <Metric label="Atenção" value={formatNumber(resumo?.atencao ?? 0, 0)} tone="yellow" hint="saúde geral 50–69" loading={carregando} />
      <Metric label="Saudáveis" value={formatNumber(resumo?.saudaveis ?? 0, 0)} tone="blue" hint="saúde geral ≥ 70" loading={carregando} />
      <Metric label="Saúde operacional" value={resumo?.operacional_media != null ? formatNumber(resumo.operacional_media, 1) : "—"} tone="blue" hint="média da operação" loading={carregando} />
      <Metric label="Saúde de resultado" value={resumo?.resultado_media != null ? formatNumber(resumo.resultado_media, 1) : "—"} tone="blue" hint="mídia + comercial" loading={carregando} />
      <Metric label="Risco externo alto" value={formatNumber(resumo?.risco_alto ?? 0, 0)} tone="red" hint="fonte externa ≥ 50" loading={carregando} />
    </div>

    {!!urgentes.length && <section className="card section" style={{ marginBottom: 14 }}>
      <div className="section-head"><div><div className="section-title">Clientes que precisam de atenção agora</div><div className="small">Ordenados pelo maior risco calculado. O motivo principal aparece no próprio card.</div></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(245px,1fr))", gap: 9 }}>{urgentes.map((l) => {
        const score = num(l.health_score); const op = num(l.operational_score); const result = num(l.result_score);
        return <button key={l.client_id} onClick={() => { setFiltro("todos"); setBusca(String(l.display_name || "")); setAberto(l.client_id); }} style={{ textAlign: "left", border: "1px solid rgba(148,163,184,.14)", background: "rgba(15,23,42,.35)", borderRadius: 11, padding: 12, color: "inherit", cursor: "pointer" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><b>{text(l.display_name)}</b><span style={{ ...bandStyle(l.health_band), padding: "4px 7px", borderRadius: 999, fontSize: 9, fontWeight: 800 }}>{l.health_band}</span></div>
          <div className="small" style={{ marginTop: 7 }}>Geral <b>{score ?? "—"}</b> · Operação <b>{op ?? "—"}</b> · Resultado <b>{result ?? "—"}</b></div>
          <p className="small" style={{ margin: "7px 0 0", lineHeight: 1.45 }}>{mainReason(l)}</p>
        </button>;
      })}</div>
    </section>}

    <section className="card section">
      <div className="section-head"><div className="client-pills">{([["todos", "Todos"], ["criticos", "Críticos"], ["atencao", "Atenção"], ["externo", "Risco externo"], ["divergentes", "Fontes divergentes"]] as const).map(([chave, rotulo]) => <button key={chave} className={filtro === chave ? "active" : ""} onClick={() => setFiltro(chave)}>{rotulo}</button>)}</div><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar cliente, responsável ou motivo" style={{ maxWidth: 290 }} /></div>
      {erro && <div className="error-box">{erro}</div>}
      {carregando && !linhas.length && <div className="empty compact">Carregando…</div>}
      {!carregando && !visiveis.length && !erro && <div className="empty compact">Nenhum cliente neste filtro.</div>}

      <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Saúde geral</th><th>Operacional</th><th>Resultado</th><th>Por que está assim</th><th>Risco externo</th><th>Próxima ação</th><th></th></tr></thead><tbody>{visiveis.map((l) => {
        const geral=num(l.health_score), op=num(l.operational_score), resultado=num(l.result_score), risco=num(l.external_risk_avg), interno=num(l.internal_score);
        const fg=faixaSaude(geral), fo=faixaSaude(op), frs=faixaSaude(resultado), fr=faixaRisco(risco); const expandido=aberto===l.client_id;
        return <Fragment key={l.client_id}><tr onClick={() => setAberto(expandido ? null : l.client_id)} style={{ cursor: "pointer" }}>
          <td><b>{text(l.display_name)}</b><div className="small">{l.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"} · CS {text(l.cs_owner)} · GT {text(l.gt_owner)}</div></td>
          <td><div style={{ color: fg.cor, fontWeight: 800 }}>{geral != null ? formatNumber(geral,0) : "—"}</div><Barra valor={geral} cor={fg.cor}/><div className="small">{l.health_band || fg.rotulo}</div></td>
          <td><div style={{ color: fo.cor, fontWeight: 700 }}>{op != null ? formatNumber(op,0) : "—"}</div><Barra valor={op} cor={fo.cor}/><div className="small">processo</div></td>
          <td><div style={{ color: frs.cor, fontWeight: 700 }}>{resultado != null ? formatNumber(resultado,0) : "—"}</div><Barra valor={resultado} cor={frs.cor}/><div className="small">mídia + comercial</div></td>
          <td style={{ minWidth: 250 }}><div style={{ fontSize: 11, lineHeight: 1.4 }}>{mainReason(l)}</div><div className="small">Clique para ver todos os fatores</div></td>
          <td><div style={{ color: fr.cor, fontWeight: 700 }}>{risco != null ? formatNumber(risco,0) : "—"}</div><Barra valor={risco} cor={fr.cor}/><div className="small">{fr.rotulo}</div></td>
          <td style={{ minWidth: 210 }}><b style={{ fontSize: 11 }}>{text(l.external_recommended_action || l.operational_snapshot?.next_step || "Revisar fatores abaixo")}</b><div className="small">{l.responsavel_acao ? `Responsável: ${l.responsavel_acao}` : `CS ${text(l.cs_owner)} · GT ${text(l.gt_owner)}`}</div></td>
          <td style={{ color: "#94a3b8" }}>{expandido ? "▲" : "▼"}</td>
        </tr>{expandido && <tr><td colSpan={8} style={{ background: "rgba(148,163,184,.05)" }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12, padding: "8px 2px" }}>
          <div style={{ padding: 12, border: "1px solid rgba(148,163,184,.15)", borderRadius: 10 }}><div className="section-title">Saúde operacional · {op ?? "—"}</div>{(l.operational_factors || []).map((factor,index)=><p className="small" key={index} style={{ margin:"7px 0 0" }}>• {factor}</p>)}{!!l.overdue_slas?.length && <p className="small" style={{ color:"#f97316" }}>{l.overdue_slas.length} SLA(s) vencido(s) no onboarding.</p>}</div>
          <div style={{ padding: 12, border: "1px solid rgba(148,163,184,.15)", borderRadius: 10 }}><div className="section-title">Saúde de resultado · {resultado ?? "—"}</div>{(l.result_factors || []).map((factor,index)=><p className="small" key={index} style={{ margin:"7px 0 0" }}>• {factor}</p>)}</div>
          <div><div className="section-title">Sinais / sentimento</div><p className="small">{l.sentimento ? <span style={{ color:SENTIMENTO[l.sentimento] || "#94a3b8", fontWeight:700 }}>{l.sentimento}</span> : "Sem sentimento classificado"}</p><p className="small">{text(l.sinais_alerta)}</p></div>
          <div><div className="section-title">Reclamações</div><p className="small">{text(l.reclamacoes)}</p></div>
          <div><div className="section-title">Leitura externa</div><p className="small">Satisfação: <b>{num(l.external_satisfaction_avg) ?? "—"}</b> · Risco: <b>{risco ?? "—"}</b></p><p className="small">{text(l.external_summary)}</p></div>
          <div><div className="section-title">Leitura interna anterior</div><p className="small">{interno != null ? <><b>{formatNumber(interno,0)}</b> <Chip value={l.internal_band}/></> : "Sem nota anterior"}</p><p className="small">A nota anterior continua visível como referência; a nova saúde geral é calculada pelas duas dimensões acima.</p></div>
        </div></td></tr>}</Fragment>;
      })}</tbody></table></div>
    </section>
  </section>;
}