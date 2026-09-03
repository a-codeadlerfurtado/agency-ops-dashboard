import { useState } from "react";
import { irPara } from "../App";
import { dinheiroCurto, numero, primeiroNome, rotuloOrigem } from "../lib/format";
import { leadsParados, painelAdmin, painelBroker } from "../lib/queries";
import { Alerta, Card, Ico, Skeleton, Stat, useAsync, Vazio } from "../ui";
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
        <div>
          <h1>Bom trabalho, {primeiroNome(sessao.nome)}.</h1>
          <div style={{ color: "var(--text-subtle)", fontSize: 13, marginTop: 2 }}>
            Desempenho comercial de {sessao.tenant.name}.
          </div>
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

      <div className="grid cols-4">
        <Stat rotulo="Leads"        valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.leads)} />
        <Stat rotulo="Atendidos"    valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.atendidos)}
              rodape={c && c.leads > 0 ? `${Math.round((c.atendidos / c.leads) * 100)}% dos leads` : undefined} />
        <Stat rotulo="Qualificados" valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.qualificados)} />
        <Stat rotulo="Visitas"      valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.visitas)} />
        <Stat rotulo="Propostas"    valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.propostas)} />
        <Stat rotulo="Vendas"       valor={carregando ? <Skeleton h={28} w={54} /> : numero(c?.vendas)}
              tom="up" />
        <Stat rotulo="VGV"          valor={c?.vgv == null ? "--" : dinheiroCurto(c.vgv)}
              rodape="Chega com o modulo de vendas" />
        <Stat rotulo="SLA perdido"  valor={c?.sla_perdido == null ? "--" : numero(c.sla_perdido)}
              rodape="Chega com a distribuicao" />
      </div>

      <div className="grid cols-2">
        <Card>
          <div className="card-head"><h2>Funil</h2></div>
          <div className="card-body">
            {carregando ? (
              <div className="col" style={{ gap: 12 }}>
                {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={22} />)}
              </div>
            ) : (
              <Funil dados={painel.dado?.funil ?? []} />
            )}
          </div>
        </Card>

        <Card>
          <div className="card-head"><h2>Origem</h2></div>
          <div className="card-body flush">
            {carregando ? (
              <div style={{ padding: 16 }}><Skeleton h={80} /></div>
            ) : (painel.dado?.origens.length ?? 0) === 0 ? (
              <Vazio titulo="Sem leads no periodo" texto="Ajuste o filtro de datas." />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>Origem</th><th className="num">Leads</th>
                        <th className="num">Qualif.</th><th className="num">Vendas</th></tr>
                  </thead>
                  <tbody>
                    {painel.dado?.origens.map((o) => (
                      <tr key={o.origem}>
                        <td>{rotuloOrigem(o.origem)}</td>
                        <td className="num">{o.leads}</td>
                        <td className="num">{o.qualificados}</td>
                        <td className="num">{o.vendas}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>

      <CardParados parados={parados.dado} carregando={parados.carregando} />
    </>
  );
}

function Funil({ dados }: { dados: { ord: number; etapa: string; total: number }[] }) {
  const topo = dados[0]?.total ?? 0;
  if (topo === 0) return <Vazio titulo="Sem leads no periodo" texto="Ajuste o filtro de datas." />;

  return (
    <div className="col" style={{ gap: 11 }}>
      {dados.map((d, i) => {
        const pct = Math.round((d.total / topo) * 100);
        const anterior = dados[i - 1]?.total;
        const queda = anterior && anterior > 0 ? Math.round((d.total / anterior) * 100) : null;
        return (
          <div key={d.ord}>
            <div className="row" style={{ marginBottom: 5, fontSize: 12.5 }}>
              <span style={{ color: "var(--muted)" }}>{d.etapa}</span>
              <span className="spacer" />
              <span className="num" style={{ fontWeight: 600, color: "var(--text-heading)" }}>
                {d.total}
              </span>
              {queda != null && i > 0 && (
                <span className="num" style={{ color: "var(--text-subtle)", fontSize: 11.5, minWidth: 38, textAlign: "right" }}>
                  {queda}%
                </span>
              )}
            </div>
            <div style={{ height: 7, borderRadius: 99, background: "var(--panel-2)", overflow: "hidden" }}>
              <div style={{
                width: `${Math.max(pct, 1.5)}%`, height: "100%", borderRadius: 99,
                background: "linear-gradient(90deg, var(--blue) 0%, var(--accent) 100%)",
                opacity: 0.55 + (0.45 * (dados.length - i)) / dados.length,
                transition: "width 400ms var(--ease)",
              }} />
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
  const sk = <Skeleton h={28} w={44} />;

  return (
    <>
      <div>
        <h1>{saudacao}, {primeiroNome(sessao.nome)}.</h1>
        <div style={{ color: "var(--text-subtle)", fontSize: 13, marginTop: 2 }}>
          {p.carregando
            ? "Carregando seu dia..."
            : d && d.followups_atrasados > 0
              ? `Voce tem ${d.followups_atrasados} follow-up${d.followups_atrasados > 1 ? "s" : ""} atrasado${d.followups_atrasados > 1 ? "s" : ""}. Comece por eles.`
              : "Sem atrasos. Bom dia para avancar o funil."}
        </div>
      </div>

      <div className="grid cols-4">
        <Stat rotulo="Novos leads"   valor={p.carregando ? sk : numero(d?.novos)}
              rodape={d?.sem_aceite ? `${d.sem_aceite} sem aceite` : "Tudo aceito"} />
        <Stat rotulo="Follow-ups hoje" valor={p.carregando ? sk : numero(d?.followups_hoje)} />
        <Stat rotulo="Atrasados"     valor={p.carregando ? sk : numero(d?.followups_atrasados)}
              tom={d && d.followups_atrasados > 0 ? "down" : undefined}
              rodape={d && d.followups_atrasados > 0 ? "Prioridade" : "Em dia"} />
        <Stat rotulo="Em proposta"   valor={p.carregando ? sk : numero(d?.em_proposta)} />
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
            <div className="col" style={{ gap: 10 }}>
              <Acao
                icone={Ico.fire({ size: 15 })}
                titulo={`${d?.novos ?? 0} lead${(d?.novos ?? 0) === 1 ? "" : "s"} novo${(d?.novos ?? 0) === 1 ? "" : "s"} esperando contato`}
                aoClicar={() => irPara("/pipeline")}
              />
              <Acao
                icone={Ico.clock({ size: 15 })}
                titulo={`${d?.followups_hoje ?? 0} follow-up${(d?.followups_hoje ?? 0) === 1 ? "" : "s"} vencendo hoje`}
                aoClicar={() => irPara("/followups")}
              />
              <Acao
                icone={Ico.alert({ size: 15 })}
                titulo={`${d?.parados_30d ?? 0} oportunidade${(d?.parados_30d ?? 0) === 1 ? "" : "s"} sem interacao ha 30+ dias`}
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

function Acao({ icone, titulo, aoClicar }: {
  icone: React.ReactNode; titulo: string; aoClicar: () => void;
}) {
  return (
    <button
      className="row"
      onClick={aoClicar}
      style={{
        width: "100%", textAlign: "left", cursor: "pointer",
        background: "var(--panel-2)", border: "1px solid var(--line-soft)",
        borderRadius: "var(--r)", padding: "11px 13px", color: "var(--text)",
      }}
    >
      <span style={{ color: "var(--accent-light)", display: "flex" }}>{icone}</span>
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
