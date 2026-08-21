"use client";

// Aba "Saúde" — o quadro que hoje vive no Notion, dentro da Central.
//
// O Notion mostra satisfação, risco de churn, sentimento e sinais por cliente.
// Aqui isso aparece ao lado do score interno da própria operação, que o Notion
// não tem. Onde as duas leituras discordam, a linha marca a divergência em vez
// de escolher uma — quem atende decide com as duas à vista.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Chip, Metric, SUPABASE_ANON_KEY, SUPABASE_URL, formatNumber, text } from "../shared";

const HEALTH_URL = `${SUPABASE_URL}/functions/v1/agency-ops-client-health`;

type Linha = {
  client_id: string;
  display_name: string | null;
  lifecycle: string | null;
  gt_owner: string | null;
  cs_owner: string | null;
  internal_score: number | string | null;
  internal_band: string | null;
  external_satisfaction_avg: number | string | null;
  external_risk_avg: number | string | null;
  external_health_status: string | null;
  external_risk_level: string | null;
  external_summary: string | null;
  external_recommended_action: string | null;
  external_source_url: string | null;
  external_source_updated_at: string | null;
  sentimento: string | null;
  sinais_alerta: string | null;
  sinais_positivos: string | null;
  reclamacoes: string | null;
  responsavel_acao: string | null;
  analises: number | null;
  crosscheck_status: string | null;
  prioridade: number | string | null;
};

type Resumo = {
  total: number; ativos: number; risco_alto: number; insatisfeitos: number;
  sentimento_negativo: number; divergentes: number; sem_dado_externo: number;
  satisfacao_media: number | null; risco_medio: number | null;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

// Faixas iguais às do Notion, para quem migrar de uma tela para a outra não ter
// que reaprender o significado das cores.
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
const SENTIMENTO: Record<string, string> = {
  "Positivo": "#22c55e", "Neutro": "#94a3b8", "Negativo": "#f97316", "Crítico": "#ef4444",
};

function Barra({ valor, cor }: { valor: number | null; cor: string }) {
  return (
    <div style={{ height: 5, borderRadius: 999, background: "rgba(148,163,184,.18)", overflow: "hidden", minWidth: 54 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, valor ?? 0))}%`, height: "100%", background: cor }} />
    </div>
  );
}

export function HealthCenter({ token }: { token: string }) {
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "risco" | "insatisfeitos" | "divergentes">("todos");
  const [aberto, setAberto] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const resposta = await fetch(HEALTH_URL, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      if (resposta.status === 403) throw new Error("Seu perfil não tem acesso a esta aba.");
      if (!resposta.ok) throw new Error(`Falha ao carregar (HTTP ${resposta.status})`);
      const corpo = await resposta.json();
      setLinhas(corpo.clients || []);
      setResumo(corpo.resumo || null);
    } catch (caught) {
      setErro(caught instanceof Error ? caught.message : "Falha ao carregar a saúde dos clientes");
    } finally {
      setCarregando(false);
    }
  }, [token]);

  useEffect(() => { carregar(); }, [carregar]);

  const visiveis = useMemo(() => {
    const agulha = busca.trim().toLocaleLowerCase("pt-BR");
    return linhas
      .filter((l) => (l.lifecycle === "ACTIVE" || l.lifecycle === "ONBOARDING"))
      .filter((l) => !agulha || [l.display_name, l.cs_owner, l.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(agulha))
      .filter((l) => {
        if (filtro === "risco") return (num(l.external_risk_avg) ?? 0) >= 50;
        if (filtro === "insatisfeitos") return (num(l.external_satisfaction_avg) ?? 100) < 50;
        if (filtro === "divergentes") return l.crosscheck_status === "CONFLICT" || l.crosscheck_status === "PARTIAL";
        return true;
      });
  }, [linhas, busca, filtro]);

  return (
    <section className="workspace">
      <div className="workspace-head">
        <div>
          <h2>Saúde dos clientes</h2>
          <p>Satisfação e risco de churn ao lado do score interno da operação. Onde as duas leituras discordam, a linha avisa.</p>
        </div>
        <span className="counter">{visiveis.length} de {resumo?.ativos ?? 0} ativos</span>
      </div>

      <div className="grid clickup-kpis">
        <Metric label="Risco alto" value={formatNumber(resumo?.risco_alto ?? 0, 0)} tone="red" hint="churn ≥ 50" loading={carregando} />
        <Metric label="Insatisfeitos" value={formatNumber(resumo?.insatisfeitos ?? 0, 0)} tone="yellow" hint="satisfação < 50" loading={carregando} />
        <Metric label="Sentimento negativo" value={formatNumber(resumo?.sentimento_negativo ?? 0, 0)} tone="yellow" hint="negativo ou crítico" loading={carregando} />
        <Metric label="Divergências" value={formatNumber(resumo?.divergentes ?? 0, 0)} tone="red" hint="fontes discordam" loading={carregando} />
        <Metric label="Satisfação média" value={resumo?.satisfacao_media != null ? formatNumber(resumo.satisfacao_media, 1) : "—"} tone="blue" hint="clientes ativos" loading={carregando} />
        <Metric label="Risco médio" value={resumo?.risco_medio != null ? formatNumber(resumo.risco_medio, 1) : "—"} tone="blue" hint="clientes ativos" loading={carregando} />
      </div>

      <section className="card section">
        <div className="section-head">
          <div className="client-pills">
            {([["todos", "Todos"], ["risco", "Risco alto"], ["insatisfeitos", "Insatisfeitos"], ["divergentes", "Divergentes"]] as const).map(([chave, rotulo]) => (
              <button key={chave} className={filtro === chave ? "active" : ""} onClick={() => setFiltro(chave)}>{rotulo}</button>
            ))}
          </div>
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar cliente, CS ou GT" style={{ maxWidth: 260 }} />
        </div>

        {erro && <div className="error-box">{erro}</div>}
        {carregando && !linhas.length && <div className="empty compact">Carregando…</div>}
        {!carregando && !visiveis.length && !erro && <div className="empty compact">Nenhum cliente neste filtro.</div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cliente</th><th>Satisfação</th><th>Risco de churn</th>
                <th>Sentimento</th><th>Interno</th><th>Responsável</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => {
                const satisf = num(l.external_satisfaction_avg);
                const risco = num(l.external_risk_avg);
                const interno = num(l.internal_score);
                const fs = faixaSatisfacao(satisf);
                const fr = faixaRisco(risco);
                const divergente = l.crosscheck_status === "CONFLICT" || l.crosscheck_status === "PARTIAL";
                const expandido = aberto === l.client_id;
                return (
                  <Fragment key={l.client_id}>
                    <tr onClick={() => setAberto(expandido ? null : l.client_id)} style={{ cursor: "pointer" }}>
                      <td>
                        <b>{text(l.display_name)}</b>
                        <div className="small">
                          {l.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}
                          {divergente && <> · <span style={{ color: "#ef4444", fontWeight: 700 }}>
                            {l.crosscheck_status === "CONFLICT" ? "fontes discordam" : "confere em parte"}
                          </span></>}
                        </div>
                      </td>
                      <td>
                        <div style={{ color: fs.cor, fontWeight: 700 }}>{satisf != null ? formatNumber(satisf, 0) : "—"}</div>
                        <Barra valor={satisf} cor={fs.cor} />
                        <div className="small">{fs.rotulo}</div>
                      </td>
                      <td>
                        <div style={{ color: fr.cor, fontWeight: 700 }}>{risco != null ? formatNumber(risco, 0) : "—"}</div>
                        <Barra valor={risco} cor={fr.cor} />
                        <div className="small">{fr.rotulo}</div>
                      </td>
                      <td>
                        {l.sentimento
                          ? <span style={{ color: SENTIMENTO[l.sentimento] || "#94a3b8", fontWeight: 700, fontSize: 12 }}>{l.sentimento}</span>
                          : <span className="small">—</span>}
                        {!!l.analises && <div className="small">{l.analises} análise(s)</div>}
                      </td>
                      <td>
                        {interno != null ? <><b>{formatNumber(interno, 0)}</b> <Chip value={l.internal_band} /></> : <span className="small">—</span>}
                      </td>
                      <td>
                        <div className="small">CS {text(l.cs_owner)}</div>
                        <div className="small">GT {text(l.gt_owner)}</div>
                      </td>
                      <td style={{ color: "#94a3b8" }}>{expandido ? "▲" : "▼"}</td>
                    </tr>
                    {expandido && (
                      <tr>
                        <td colSpan={7} style={{ background: "rgba(148,163,184,.05)" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, padding: "4px 2px" }}>
                            <div><div className="section-title">Sinais de alerta</div><p className="small">{text(l.sinais_alerta)}</p></div>
                            <div><div className="section-title">Sinais positivos</div><p className="small">{text(l.sinais_positivos)}</p></div>
                            <div><div className="section-title">Principais reclamações</div><p className="small">{text(l.reclamacoes)}</p></div>
                            <div>
                              <div className="section-title">Ação recomendada</div>
                              <p className="small">{text(l.external_recommended_action || l.external_summary)}</p>
                              {l.responsavel_acao && <p className="small">Responsável: <b>{l.responsavel_acao}</b></p>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
