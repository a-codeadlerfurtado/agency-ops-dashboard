import { useState } from "react";
import { irPara } from "../App";
import { data, dinheiro, dinheiroCurto } from "../lib/format";
import { atualizarProposta, propostas, registrarVenda } from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, CabecalhoDaPagina, Card, Ico, TabelaCarregando, useAsync, useToast,
  Vazio,
} from "../ui";
import type { Proposal, ProposalStatus, Sessao } from "../lib/types";

const ROTULO: Record<ProposalStatus, string> = {
  DRAFT: "Rascunho", SENT: "Enviada", NEGOTIATING: "Negociando",
  ACCEPTED: "Aceita", REJECTED: "Recusada", CANCELLED: "Cancelada",
};
const CLASSE: Record<ProposalStatus, string> = {
  DRAFT: "", SENT: "new", NEGOTIATING: "qualified",
  ACCEPTED: "won", REJECTED: "lost", CANCELLED: "",
};

const ABERTAS: ProposalStatus[] = ["DRAFT", "SENT", "NEGOTIATING"];

export default function Propostas({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [soAbertas, setSoAbertas] = useState(true);
  const [vendendo, setVendendo] = useState<Proposal | null>(null);

  const lista = useAsync(
    () => propostas(sessao.tenant.id, sessao.isAdmin ? undefined : sessao.userId),
    [sessao.tenant.id]
  );

  async function mudar(p: Proposal, status: ProposalStatus) {
    try {
      await atualizarProposta(p.id, status);
      avisar("ok", `Proposta ${ROTULO[status].toLowerCase()}.`);
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  const itens = (lista.dado ?? []).filter((p) => !soAbertas || ABERTAS.includes(p.status));

  return (
    <>
      <CabecalhoDaPagina
        contexto="Negociacao"
        titulo="Propostas"
        descricao="Proposta em aberto e dinheiro parado. Aceita vira venda; recusada, aprendizado."
      />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className={`btn sm ${soAbertas ? "" : "ghost"}`.trim()} onClick={() => setSoAbertas(true)}>
          Em aberto
        </button>
        <button className={`btn sm ${soAbertas ? "ghost" : ""}`.trim()} onClick={() => setSoAbertas(false)}>
          Todas
        </button>
        <span className="spacer" />
        <span className="hint">Proposta aceita nao vira venda sozinha: registre o valor final.</span>
      </div>

      {vendendo && (
        <RegistrarVenda
          proposta={vendendo}
          aoFechar={() => setVendendo(null)}
          aoRegistrar={() => { setVendendo(null); lista.recarregar(); }}
        />
      )}

      <Card>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={5} colunas={5} />
          ) : itens.length === 0 ? (
            <Vazio
              icone={Ico.note({ size: 20 })}
              titulo={soAbertas ? "Nenhuma proposta em aberto" : "Nenhuma proposta"}
              texto="Crie a partir da ficha do lead, com o imovel escolhido."
              acao={<button className="btn" onClick={() => irPara("/leads")}>Ir para os leads</button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Cliente</th><th>Imovel</th>
                    <th className="num">Tabela</th><th className="num">Ofertado</th>
                    <th className="num">Desconto</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((p) => {
                    const desconto = p.list_price && p.list_price > 0
                      ? Math.round((1 - p.offered_price / p.list_price) * 1000) / 10
                      : null;
                    return (
                      <tr key={p.id}>
                        <td>
                          <div style={{ fontWeight: 550 }}>{p.contact?.full_name ?? "--"}</div>
                          <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                            {data(p.created_at)}
                            {p.valid_until ? ` · vale ate ${data(p.valid_until)}` : ""}
                          </div>
                        </td>
                        <td className="truncate">{p.property?.title ?? "--"}</td>
                        <td className="num nowrap" style={{ color: "var(--muted)" }}>
                          {p.list_price ? dinheiroCurto(p.list_price) : "--"}
                        </td>
                        <td className="num nowrap" style={{ fontWeight: 600 }}>
                          {dinheiroCurto(p.offered_price)}
                        </td>
                        <td className="num nowrap"
                            style={{ color: desconto && desconto > 8 ? "var(--warning)" : "var(--muted)" }}>
                          {desconto == null ? "--" : `${desconto}%`}
                        </td>
                        <td className="nowrap">
                          <span className={`badge ${CLASSE[p.status]}`.trim()}>
                            <span className="dot" />{ROTULO[p.status]}
                          </span>
                        </td>
                        <td className="nowrap" style={{ width: 1 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn ghost sm" onClick={() => irPara(`/leads/${p.opportunity_id}`)}>
                              Lead
                            </button>
                            {p.status === "DRAFT" && (
                              <button className="btn sm" onClick={() => mudar(p, "SENT")}>Enviar</button>
                            )}
                            {(p.status === "SENT" || p.status === "NEGOTIATING") && (
                              <>
                                <button className="btn primary sm" onClick={() => setVendendo(p)}>
                                  Fechar venda
                                </button>
                                <button className="btn ghost sm" onClick={() => mudar(p, "REJECTED")}>
                                  Recusada
                                </button>
                              </>
                            )}
                            {p.status === "ACCEPTED" && (
                              <button className="btn primary sm" onClick={() => setVendendo(p)}>
                                Registrar venda
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

function RegistrarVenda({
  proposta, aoFechar, aoRegistrar,
}: { proposta: Proposal; aoFechar: () => void; aoRegistrar: () => void }) {
  const avisar = useToast();
  const [valor, setValor] = useState(String(proposta.offered_price));
  const [salvando, setSalvando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      await registrarVenda({
        oppId: proposta.opportunity_id,
        valor: Number(valor),
        propertyId: proposta.property_id,
        proposalId: proposta.id,
      });
      avisar("ok", "Venda registrada. VGV atualizado.");
      aoRegistrar();
    } catch (err) {
      avisar("err", mensagemDeErro(err));
      setSalvando(false);
    }
  }

  return (
    <Dialogo aberto titulo="Registrar venda" aoFechar={aoFechar} largura={520}>
      <form onSubmit={enviar} className="col" style={{ gap: 12 }}>
          <div style={{ fontSize: 13.5, color: "var(--muted)" }}>
            <b style={{ color: "var(--text-heading)" }}>{proposta.contact?.full_name}</b>
            {proposta.property?.title ? ` · ${proposta.property.title}` : ""}
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label className="label">Valor final da venda (R$)</label>
            <input className="input" type="number" required autoFocus value={valor}
                   onChange={(e) => setValor(e.target.value)} />
            <span className="hint">
              Proposta era {dinheiro(proposta.offered_price)}. O valor que entra no VGV e este.
            </span>
          </div>
          <div className="row">
            <span className="hint">
              O imovel passa para Vendido e a oportunidade vai para a etapa Venda.
            </span>
            <span className="spacer" />
            <button className="btn primary" type="submit" disabled={salvando || !Number(valor)}>
              {salvando ? "Registrando..." : "Confirmar venda"}
            </button>
          </div>
      </form>
    </Dialogo>
  );
}
