import { useState } from "react";
import { irPara } from "../App";
import { dinheiroCurto, numero, primeiroNome, rotuloOrigem } from "../lib/format";
import { leadsParados, painelAdmin, painelBroker } from "../lib/queries";
import {
  Alerta, Card, CardsCarregando, FaixaItem, Ico, Numero, Skeleton, useAsync, Vazio,
} from "../ui";
import type { Sessao } from "../lib/types";

const PERIODOS = [
  { dias: 1,  rotulo: "Hoje" },
  { dias: 7,  rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
];

export default function VisaoGeral({ sessao }: { sessao: Sessao }) {
  return sessao.isAdmin ? <PainelAdmin sessao={sessao} /> : <PainelCorretor sessao={sessao} />;
}

/** Zero recua sem sumir: "nao aconteceu" continua legivel, so para de gritar. */
const zerado = (v: number | null | undefined) => (v ? "" : " zerado");

/* ================================================================ ADMIN === */

function PainelAdmin({ sessao }: { sessao: Sessao }) {
  const [dias, setDias] = useState(30);
  const painel = useAsync(() => painelAdmin(sessao.tenant.id, dias), [sessao.tenant.id, dias]);
  const parados = useAsync(() => leadsParados(sessao.tenant.id), [sessao.tenant.id]);

  if (painel.erro) return <Alerta>{painel.erro}</Alerta>;

  const c = painel.dado?.cards;
  const carregando = painel.carregando;

  return (
    <>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div className="page-head">
          <span className="eyebrow">{"Operacao comercial · " + dias + " dias"}</span>
          <h1>Bom trabalho, {primeiroNome(sessao.nome)}.</h1>
          <p>Acompanhe leads, atendimento e vendas da operacao.</p>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          {PERIODOS.map((p) => (
            <button
              key={p.dias}
              className={`btn sm ${dias === p.dias ? "" : "ghost"}`.trim()}
              onClick={() => setDias(p.dias)}
            >
              {p.rotulo}
            </button>
          ))}
        </div>
      </div>

      {/* Resultado e saúde da operação.
          Volume (leads, qualificados, visitas, propostas) NÃO entra aqui: já
          está no funil logo abaixo, e mostrar o mesmo número duas vezes gasta
          a tela sem informar. Antes eram oito caixas de peso idêntico — o VGV
          do mês tinha o mesmo destaque de "Visitas: 0". */}
      <div className="kpis">
        {carregando ? <CardsCarregando n={6} /> : (
          <>
            <Card className="stat metric acento destaque">
              <div className="stat-label">VGV no periodo</div>
              <div className={`stat-value${zerado(c?.vgv)}`}>
                <Numero valor={c?.vgv ?? 0} formatar={dinheiroCurto} />
              </div>
              <div className="stat-foot">
                {c?.vendas
                  ? `ticket medio ${dinheiroCurto((c.vgv ?? 0) / c.vendas)}`
                  : "nenhuma venda fechada no periodo"}
              </div>
            </Card>

            <Card className="stat metric">
              <div className="stat-label">Vendas</div>
              <div className={`stat-value${zerado(c?.vendas)}`}>
                <Numero valor={c?.vendas ?? 0} formatar={numero} />
              </div>
              <div className="stat-foot">
                {c && c.leads > 0
                  ? `${((c.vendas / c.leads) * 100).toFixed(1)}% dos leads do periodo`
                  : "sem base de comparacao"}
              </div>
            </Card>

            <Card className="stat metric calmo">
              <div className="stat-label">SLA perdido</div>
              <div
                className={`stat-value${zerado(c?.sla_perdido)}`}
                style={{ color: c && (c.sla_perdido ?? 0) > 0 ? "var(--danger)" : undefined }}
              >
                <Numero valor={c?.sla_perdido ?? 0} formatar={numero} />
              </div>
              <div className="stat-foot">
                {c && (c.sla_perdido ?? 0) > 0
                  ? "leads nao aceitos no prazo"
                  : "todo lead aceito no prazo"}
              </div>
            </Card>

            <Card className="stat metric">
              <div className="stat-label">Leads</div>
              <div className={"stat-value" + zerado(c?.leads)}>
                <Numero valor={c?.leads ?? 0} formatar={numero} />
              </div>
              <div className="stat-foot">entraram no periodo</div>
            </Card>

            <Card className="stat metric acento">
              <div className="stat-label">Atendimento</div>
              <div className={"stat-value" + zerado(c?.atendidos)}>
                {c?.leads ? Math.round((c.atendidos / c.leads) * 100) + "%" : "--"}
              </div>
              <div className="stat-foot">
                {c ? numero(c.atendidos) + " de " + numero(c.leads) : "--"}
              </div>
            </Card>
          </>
        )}
      </div>

      <div className="grid cols-2">
        <Card>
          <div className="card-head">
            <h2>Funil</h2>
            <span className="spacer" />
            <span className="badge">leads que entraram no periodo</span>
          </div>
          <div className="card-body">
            {carregando ? (
              <div className="col" style={{ gap: 14 }}>
                {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={26} />)}
              </div>
            ) : (
              <Funil dados={painel.dado?.funil ?? []} />
            )}
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <h2>Origem</h2>
            <span className="spacer" />
            <span className="badge">conversao da coorte</span>
          </div>
          <div className="card-body flush">
            {carregando ? (
              <div style={{ padding: 16 }}><Skeleton h={80} /></div>
            ) : (painel.dado?.origens.length ?? 0) === 0 ? (
              <Vazio titulo="Sem leads no periodo" texto="Ajuste o filtro de datas." />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Origem</th><th className="num">Leads</th>
                      <th className="num">Qualif.</th><th className="num">Vendas</th>
                      <th className="num">VGV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {painel.dado?.origens.map((o) => (
                      <tr key={o.origem}>
                        <td>{rotuloOrigem(o.origem)}</td>
                        <td className="num">{o.leads}</td>
                        <td className="num" style={{ color: o.qualificados ? undefined : "var(--text-subtle)" }}>
                          {o.qualificados}
                        </td>
                        <td className="num" style={{ color: o.vendas ? undefined : "var(--text-subtle)" }}>
                          {o.vendas}
                        </td>
                        <td className="num nowrap" style={{
                          color: o.vgv ? "var(--success)" : "var(--text-subtle)",
                          fontWeight: o.vgv ? 600 : 400,
                        }}>
                          {o.vgv ? dinheiroCurto(o.vgv) : "--"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid cols-2">
        <CardCampanhas campanhas={painel.dado?.campanhas ?? []} carregando={carregando} />
        <CardParados parados={parados.dado} carregando={parados.carregando} />
      </div>
    </>
  );
}

/* Atribuicao de venda por campanha (spec 46/54): fecha o ciclo anuncio -> venda. */
function CardCampanhas({ campanhas, carregando }: {
  campanhas: { campanha: string; vendas: number; vgv: number }[]; carregando: boolean;
}) {
  return (
    <Card>
      <div className="card-head">
        <h2>VGV por campanha</h2>
        <span className="spacer" />
        <span className="badge">vendas fechadas no periodo</span>
      </div>
      <div className="card-body flush">
        {carregando ? (
          <div style={{ padding: 16 }}><Skeleton h={70} /></div>
        ) : campanhas.length === 0 ? (
          <Vazio titulo="Sem venda no periodo"
                 texto="Quando uma venda for registrada, a campanha que a originou aparece aqui." />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Campanha</th><th className="num">Vendas</th><th className="num">VGV</th></tr></thead>
              <tbody>
                {campanhas.map((c) => (
                  <tr key={c.campanha}>
                    <td className="truncate">{c.campanha}</td>
                    <td className="num">{c.vendas}</td>
                    <td className="num nowrap" style={{ fontWeight: 600, color: "var(--success)" }}>
                      {dinheiroCurto(c.vgv)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Funil. A versão anterior tinha barra de 7px com gradiente azul→laranja: o
 * gradiente não codificava nada (era decoração) e etapa pequena virava um
 * pontinho invisível. Agora o trilho é sempre visível, a barra é sólida, e a
 * queda entre etapas ganha destaque — é o número que o gestor procura.
 */
function Funil({ dados }: { dados: { ord: number; etapa: string; total: number }[] }) {
  const topo = dados[0]?.total ?? 0;
  if (topo === 0) return <Vazio titulo="Sem leads no periodo" texto="Ajuste o filtro de datas." />;

  return (
    <div>
      {dados.map((d, i) => {
        const pct = (d.total / topo) * 100;
        const anterior = dados[i - 1]?.total;
        const queda = anterior && anterior > 0 ? Math.round((d.total / anterior) * 100) : null;
        return (
          <div key={d.ord} className="funil-linha">
            <div className="funil-topo">
              <span className="funil-nome">{d.etapa}</span>
              <span className="funil-total" style={{ color: d.total ? undefined : "var(--text-subtle)" }}>
                {d.total}
              </span>
              {queda != null && i > 0 && (
                <span className={`funil-queda ${queda < 40 ? "ruim" : ""}`.trim()}>{queda}%</span>
              )}
            </div>
            <div className="funil-trilho">
              <div className="funil-barra" style={{ width: `${Math.max(pct, 0)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================== CORRETOR === */

function PainelCorretor({ sessao }: { sessao: Sessao }) {
  const p = useAsync(() => painelBroker(sessao.tenant.id), [sessao.tenant.id]);
  const parados = useAsync(() => leadsParados(sessao.tenant.id), [sessao.tenant.id]);

  if (p.erro) return <Alerta>{p.erro}</Alerta>;

  const d = p.dado;
  const hora = new Date().getHours();
  const saudacao = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
  const atrasados = d?.followups_atrasados ?? 0;

  return (
    <>
      <div>
        <h1>{saudacao}, {primeiroNome(sessao.nome)}.</h1>
        <div style={{ color: "var(--text-subtle)", fontSize: 13, marginTop: 2 }}>
          {p.carregando
            ? "Carregando seu dia..."
            : atrasados > 0
              ? `Voce tem ${atrasados} follow-up${atrasados > 1 ? "s" : ""} atrasado${atrasados > 1 ? "s" : ""}. Comece por eles.`
              : "Sem atrasos. Bom dia para avancar o funil."}
        </div>
      </div>

      {/* O corretor decide o dia por urgência, não por volume: o que está
          atrasado vem primeiro e maior. O resto é apoio. */}
      <div className="grid kpi">
        {p.carregando ? <CardsCarregando n={3} /> : (
          <>
            <Card className="stat stat-hero">
              <div className="stat-label">Atrasados</div>
              <div className={`stat-value${zerado(atrasados)}`}
                   style={{ color: atrasados > 0 ? "var(--danger)" : undefined }}>
                <Numero valor={atrasados} formatar={numero} />
              </div>
              <div className="stat-foot">
                {atrasados > 0 ? "resolva antes de tudo" : "nada atrasado"}
              </div>
            </Card>

            <Card className="stat stat-hero">
              <div className="stat-label">Para hoje</div>
              <div className={`stat-value${zerado((d?.followups_hoje ?? 0) + (d?.visitas_hoje ?? 0))}`}>
                <Numero valor={(d?.followups_hoje ?? 0) + (d?.visitas_hoje ?? 0)} formatar={numero} />
              </div>
              <div className="stat-foot">
                {`${d?.followups_hoje ?? 0} follow-up, ${d?.visitas_hoje ?? 0} visita`}
              </div>
            </Card>

            <Card className="stat stat-hero">
              <div className="stat-label">Leads novos</div>
              <div className={`stat-value${zerado(d?.novos)}`}
                   style={{ color: (d?.novos ?? 0) > 0 ? "var(--accent-light)" : undefined }}>
                <Numero valor={d?.novos ?? 0} formatar={numero} />
              </div>
              <div className="stat-foot">
                {d?.sem_aceite ? `${d.sem_aceite} sem aceite` : "tudo aceito"}
              </div>
            </Card>
          </>
        )}
      </div>

      <div className="faixa">
        <FaixaItem rotulo="Propostas abertas" valor={p.carregando ? "--" : numero(d?.em_proposta)}
                   vazio={!d?.em_proposta} />
        <FaixaItem rotulo="Minhas vendas" valor={p.carregando ? "--" : numero(d?.vendas)}
                   vazio={!d?.vendas} />
        <FaixaItem rotulo="Meu VGV" valor={p.carregando ? "--" : dinheiroCurto(d?.vgv ?? 0)}
                   vazio={!d?.vgv} />
        <FaixaItem rotulo="Parados 30+ dias" valor={p.carregando ? "--" : numero(d?.parados_30d)}
                   vazio={!d?.parados_30d} />
      </div>

      <div className="grid cols-2">
        <Card>
          <div className="card-head">
            <h2>Proximos passos</h2>
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => irPara("/followups")}>
              Ver todos {Ico.arrow({ size: 14 })}
            </button>
          </div>
          <div className="card-body">
            <div className="col" style={{ gap: 8 }}>
              <Acao
                icone={Ico.fire({ size: 15 })}
                titulo={`${d?.novos ?? 0} lead novo esperando contato`}
                urgente={(d?.novos ?? 0) > 0}
                aoClicar={() => irPara("/pipeline")}
              />
              <Acao
                icone={Ico.clock({ size: 15 })}
                titulo={`${d?.followups_hoje ?? 0} follow-up vencendo hoje`}
                aoClicar={() => irPara("/followups")}
              />
              <Acao
                icone={Ico.building({ size: 15 })}
                titulo={`${d?.visitas_hoje ?? 0} visita agendada para hoje`}
                aoClicar={() => irPara("/visitas")}
              />
              <Acao
                icone={Ico.alert({ size: 15 })}
                titulo={`${d?.parados_30d ?? 0} oportunidade sem interacao ha 30+ dias`}
                aoClicar={() => irPara("/leads")}
              />
            </div>
          </div>
        </Card>

        <CardParados parados={parados.dado} carregando={parados.carregando} />
      </div>
    </>
  );
}

function Acao({ icone, titulo, aoClicar, urgente }: {
  icone: React.ReactNode; titulo: string; aoClicar: () => void; urgente?: boolean;
}) {
  return (
    <button
      className="row"
      onClick={aoClicar}
      style={{
        width: "100%", textAlign: "left", cursor: "pointer",
        background: "var(--panel-2)",
        border: `1px solid ${urgente ? "var(--accent-soft)" : "var(--line-soft)"}`,
        borderRadius: "var(--r)", padding: "10px 13px", color: "var(--text)",
      }}
    >
      <span style={{ color: urgente ? "var(--accent-light)" : "var(--muted)", display: "flex" }}>
        {icone}
      </span>
      <span style={{ fontSize: 13.5 }}>{titulo}</span>
      <span className="spacer" />
      <span style={{ color: "var(--text-subtle)", display: "flex" }}>{Ico.arrow({ size: 15 })}</span>
    </button>
  );
}

const FAIXAS: Record<string, string> = {
  "7-15": "7 a 15 dias",
  "15-30": "15 a 30 dias",
  "30-60": "30 a 60 dias",
  "60+": "mais de 60 dias",
};

function CardParados({ parados, carregando }: {
  parados?: { faixa: string; total: number }[]; carregando: boolean;
}) {
  const total = parados?.reduce((s, p) => s + Number(p.total), 0) ?? 0;

  return (
    <Card>
      <div className="card-head">
        <h2>Leads esquecidos</h2>
        <span className="spacer" />
        <span className="badge">sem IA, sem disparo</span>
      </div>
      <div className="card-body">
        {carregando ? (
          <Skeleton h={70} />
        ) : total === 0 ? (
          <Vazio
            icone={Ico.check({ size: 20 })}
            titulo="Nada parado"
            texto="Toda oportunidade aberta teve interacao nos ultimos 7 dias."
          />
        ) : (
          <>
            <div style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 12 }}>
              <b style={{ color: "var(--text-heading)" }}>{total}</b> oportunidade{total > 1 ? "s" : ""} sem
              interacao ha mais de 7 dias.
            </div>
            <div className="col" style={{ gap: 7 }}>
              {parados?.map((p) => (
                <div key={p.faixa} className="row" style={{ fontSize: 13 }}>
                  <span style={{ color: "var(--muted)" }}>{FAIXAS[p.faixa] ?? p.faixa}</span>
                  <span className="spacer" />
                  <span className={`badge ${p.faixa === "60+" ? "lost" : p.faixa === "30-60" ? "qualified" : ""}`.trim()}>
                    {p.total}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
