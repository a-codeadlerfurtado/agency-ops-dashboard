import { irPara } from "../App";
import { data, dinheiro, dinheiroCurto, rotuloOrigem } from "../lib/format";
import { cancelarVenda, vendas } from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import {
  Alerta, Card, Ico, Stat, TabelaCarregando, useAsync, useToast, Vazio,
} from "../ui";
import type { Sessao } from "../lib/types";

export default function Vendas({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const lista = useAsync(
    () => vendas(sessao.tenant.id, sessao.isAdmin ? undefined : sessao.userId),
    [sessao.tenant.id]
  );

  async function cancelar(id: string) {
    const motivo = prompt("Motivo do cancelamento:");
    if (!motivo?.trim()) return;
    try {
      await cancelarVenda(id, motivo.trim());
      avisar("ok", "Venda cancelada. Imovel liberado.");
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  const ativas = (lista.dado ?? []).filter((v) => !v.cancelled_at);
  const vgv = ativas.reduce((s, v) => s + Number(v.sale_value), 0);
  const ticket = ativas.length ? vgv / ativas.length : 0;

  return (
    <>
      <div className="grid cols-3">
        <Stat rotulo={sessao.isAdmin ? "VGV" : "Meu VGV"} valor={dinheiroCurto(vgv)} tom="up"
              rodape={`${ativas.length} venda${ativas.length === 1 ? "" : "s"}`} />
        <Stat rotulo="Ticket medio" valor={ticket ? dinheiroCurto(ticket) : "--"} />
        <Stat rotulo="Vindas de anuncio"
              valor={`${ativas.filter((v) => v.campaign_name).length}`}
              rodape="com campanha identificada" />
      </div>

      <Card>
        <div className="card-head">
          <h2>{sessao.isAdmin ? "Vendas da imobiliaria" : "Minhas vendas"}</h2>
        </div>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={4} colunas={5} />
          ) : (lista.dado?.length ?? 0) === 0 ? (
            <Vazio
              icone={Ico.trophy({ size: 20 })}
              titulo="Nenhuma venda registrada"
              texto="A venda entra pela proposta aceita ou pelo botao Registrar venda na ficha do lead."
              acao={<button className="btn" onClick={() => irPara("/propostas")}>Ver propostas</button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Cliente</th><th>Imovel</th><th className="num">Valor</th>
                    <th>Atribuicao</th><th>Data</th>{sessao.isAdmin && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {lista.dado?.map((v) => (
                    <tr key={v.id} style={{ opacity: v.cancelled_at ? 0.5 : 1 }}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{v.contact?.full_name ?? "--"}</div>
                        {v.cancelled_at && (
                          <div style={{ fontSize: 12, color: "var(--danger)" }}>
                            cancelada: {v.cancel_reason}
                          </div>
                        )}
                      </td>
                      <td className="truncate">{v.property?.title ?? "--"}</td>
                      <td className="num nowrap" style={{ fontWeight: 600, color: "var(--success)" }}>
                        {dinheiro(v.sale_value)}
                      </td>
                      <td>
                        {/* o que a spec 54 pede: da venda de volta ate o anuncio */}
                        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                          <span className="badge">{rotuloOrigem(v.source ?? "--")}</span>
                          {v.campaign_name && (
                            <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                              {v.campaign_name}{v.ad_name ? ` · ${v.ad_name}` : ""}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="nowrap num" style={{ color: "var(--muted)" }}>{data(v.sold_at)}</td>
                      {sessao.isAdmin && (
                        <td className="nowrap" style={{ width: 1 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn ghost sm" onClick={() => irPara(`/leads/${v.opportunity_id}`)}>
                              Lead
                            </button>
                            {!v.cancelled_at && (
                              <button className="btn danger sm" onClick={() => cancelar(v.id)}>
                                Cancelar
                              </button>
                            )}
                          </div>
                        </td>
                      )}
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
