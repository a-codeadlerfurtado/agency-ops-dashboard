import { useState } from "react";
import { ranking } from "../lib/queries";
import { Alerta, Avatar, Card, TabelaCarregando, useAsync, Vazio } from "../ui";
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

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  return (
    <>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          Desempenho por corretor. Visivel apenas para a administracao.
        </div>
        <span className="spacer" />
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

      <Card>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={4} colunas={7} />
          ) : (lista.dado?.length ?? 0) === 0 ? (
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
                    <th className="num">Contatados</th>
                    <th className="num">Qualif.</th>
                    <th className="num">Vendas</th>
                    <th className="num">Conv.</th>
                    <th className="num">Ate aceite</th>
                    <th className="num">Ate contato</th>
                    <th className="num">Parados</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.dado?.map((r, i) => (
                    <tr key={r.user_id}>
                      <td>
                        <div className="row" style={{ gap: 9 }}>
                          <span className="num" style={{
                            width: 16, color: i === 0 ? "var(--accent)" : "var(--text-subtle)",
                            fontWeight: 600, fontSize: 12,
                          }}>{i + 1}</span>
                          <Avatar nome={r.nome} />
                          <span style={{ fontWeight: 550 }}>{r.nome}</span>
                        </div>
                      </td>
                      <td className="num">{r.leads}</td>
                      <td className="num">{r.aceitos}</td>
                      <td className="num">{r.contatados}</td>
                      <td className="num">{r.qualificados}</td>
                      <td className="num" style={{ fontWeight: 600, color: "var(--success)" }}>
                        {r.vendas}
                      </td>
                      <td className="num">{r.conversao == null ? "--" : `${r.conversao}%`}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{minutos(r.min_ate_aceite)}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{minutos(r.min_ate_contato)}</td>
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

      <div className="hint">
        SLA perdido e VGV entram nesta tabela quando os modulos de distribuicao e
        vendas forem ligados.
      </div>
    </>
  );
}
