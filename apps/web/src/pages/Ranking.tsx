import { useEffect, useState } from "react";
import { dinheiroCurto } from "../lib/format";
import { ranking, type LinhaRanking } from "../lib/queries";
import { useFlip } from "../lib/flip";
import {
  Alerta, Avatar, CabecalhoDaPagina, Card, TabelaCarregando, useAsync, Vazio,
} from "../ui";
import type { Sessao } from "../lib/types";

const PERIODOS = [
  { dias: 7,  rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
];

const minutos = (v: number | null) =>
  v == null ? "--" : v < 60 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`;

export default function Ranking({ sessao }: { sessao: Sessao }) {
  const [dias, setDias] = useState(30);
  const lista = useAsync(() => ranking(sessao.tenant.id, dias), [sessao.tenant.id, dias]);

  /* Trocar o periodo reordena a tabela. Sem animacao, os corretores trocam
     de lugar num piscar e o olho perde quem subiu e quem caiu -- que e
     exatamente a informacao do ranking. O FLIP e o mesmo do Kanban.

     A lista fica em estado local para haver um momento em que a ordem
     ANTIGA ainda esta no DOM: e nele que capturar() mede. Renderizar
     lista.dado direto nao daria essa brecha. */
  const { container: corpo, capturar } = useFlip<HTMLTableSectionElement>();
  const [linhas, setLinhas] = useState<LinhaRanking[]>([]);
  useEffect(() => {
    if (!lista.dado) return;
    capturar();
    setLinhas(lista.dado);
  }, [lista.dado, capturar]);

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  const total = linhas.reduce((s, r) => s + Number(r.vgv ?? 0), 0);

  return (
    <>
      <CabecalhoDaPagina
        contexto={total > 0 ? "VGV do periodo " + dinheiroCurto(total) : "Administracao"}
        titulo="Ranking"
        descricao="Desempenho por corretor. Visivel apenas para a administracao."
        acoes={PERIODOS.map((p) => (
          <button
            key={p.dias}
            className={`btn sm ${dias === p.dias ? "" : "ghost"}`.trim()}
            onClick={() => setDias(p.dias)}
          >
            {p.rotulo}
          </button>
        ))}
      />

      <Card>
        <div className="card-body flush">
          {lista.carregando && linhas.length === 0 ? (
            <TabelaCarregando linhas={4} colunas={8} />
          ) : linhas.length === 0 ? (
            <Vazio
              titulo="Nenhum corretor ativo"
              texto="Cadastre corretores para acompanhar o desempenho da equipe."
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Corretor</th>
                    <th className="num">Leads</th>
                    <th className="num">Aceitos</th>
                    <th className="num">SLA perd.</th>
                    <th className="num">Contatados</th>
                    <th className="num">Qualif.</th>
                    <th className="num">Visitas</th>
                    <th className="num">Propostas</th>
                    <th className="num">Vendas</th>
                    <th className="num">VGV</th>
                    <th className="num">Conv.</th>
                    <th className="num">Ate aceite</th>
                    <th className="num">Ate contato</th>
                    <th className="num">Parados</th>
                  </tr>
                </thead>
                <tbody ref={corpo}>
                  {linhas.map((r, i) => (
                    <tr key={r.user_id} data-flip-id={r.user_id}>
                      <td>
                        <div className="row" style={{ gap: 9 }}>
                          <span className="num" style={{
                            width: 16, color: i === 0 ? "var(--accent)" : "var(--text-subtle)",
                            fontWeight: 600, fontSize: 12,
                          }}>{i + 1}</span>
                          <Avatar nome={r.nome} />
                          <span style={{ fontWeight: 550 }} className="nowrap">{r.nome}</span>
                        </div>
                      </td>
                      <td className="num">{r.leads}</td>
                      <td className="num">{r.aceitos}</td>
                      <td className="num" style={{ color: r.sla_perdido > 0 ? "var(--danger)" : undefined }}>
                        {r.sla_perdido}
                      </td>
                      <td className="num">{r.contatados}</td>
                      <td className="num">{r.qualificados}</td>
                      <td className="num">{r.visitas}</td>
                      <td className="num">{r.propostas}</td>
                      <td className="num" style={{ fontWeight: 600, color: "var(--success)" }}>
                        {r.vendas}
                      </td>
                      <td className="num nowrap" style={{ fontWeight: 600, color: Number(r.vgv) > 0 ? "var(--success)" : undefined }}>
                        {Number(r.vgv) > 0 ? dinheiroCurto(Number(r.vgv)) : "--"}
                      </td>
                      <td className="num">{r.conversao == null ? "--" : `${r.conversao}%`}</td>
                      <td className="num nowrap" style={{ color: "var(--muted)" }}>{minutos(r.min_ate_aceite)}</td>
                      <td className="num nowrap" style={{ color: "var(--muted)" }}>{minutos(r.min_ate_contato)}</td>
                      <td className="num" style={{ color: r.parados > 0 ? "var(--warning)" : undefined }}>
                        {r.parados}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
