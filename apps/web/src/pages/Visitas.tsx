import { useState } from "react";
import { irPara } from "../App";
import { dataHora, relativo } from "../lib/format";
import { atualizarVisita, visitas } from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import {
  Alerta, Card, Ico, TabelaCarregando, useAsync, useToast, Vazio,
} from "../ui";
import type { Sessao, VisitStatus } from "../lib/types";

const ROTULO: Record<VisitStatus, string> = {
  SCHEDULED: "Agendada", COMPLETED: "Realizada",
  CANCELLED: "Cancelada", NO_SHOW: "Nao compareceu",
};
const CLASSE: Record<VisitStatus, string> = {
  SCHEDULED: "visit", COMPLETED: "won", CANCELLED: "", NO_SHOW: "lost",
};

export default function Visitas({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [filtro, setFiltro] = useState<VisitStatus | "">("SCHEDULED");
  const [soMinhas, setSoMinhas] = useState(!sessao.isAdmin);

  const lista = useAsync(
    () => visitas(sessao.tenant.id, soMinhas ? sessao.userId : undefined, filtro || undefined),
    [sessao.tenant.id, filtro, soMinhas]
  );

  async function marcar(id: string, status: VisitStatus) {
    try {
      await atualizarVisita(id, status);
      avisar("ok", `Visita ${ROTULO[status].toLowerCase()}.`);
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  const agora = Date.now();

  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {(["SCHEDULED", "COMPLETED", "NO_SHOW", ""] as const).map((s) => (
          <button key={s || "todas"}
                  className={`btn sm ${filtro === s ? "" : "ghost"}`.trim()}
                  onClick={() => setFiltro(s)}>
            {s ? ROTULO[s] : "Todas"}
          </button>
        ))}
        <span className="spacer" />
        {sessao.isAdmin && (
          <label className="row" style={{ gap: 7, fontSize: 13, color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={soMinhas} onChange={(e) => setSoMinhas(e.target.checked)} />
            Somente as minhas
          </label>
        )}
      </div>

      <Card>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={5} colunas={4} />
          ) : (lista.dado?.length ?? 0) === 0 ? (
            <Vazio
              icone={Ico.building({ size: 20 })}
              titulo="Nenhuma visita"
              texto="Agende a partir da ficha do lead, escolhendo o imovel."
              acao={<button className="btn" onClick={() => irPara("/leads")}>Ir para os leads</button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Quando</th><th>Cliente</th><th>Imovel</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {lista.dado?.map((v) => {
                    const atrasada = v.status === "SCHEDULED" && new Date(v.scheduled_at).getTime() < agora;
                    return (
                      <tr key={v.id}>
                        <td className="nowrap">
                          <div style={{ fontWeight: 550, color: atrasada ? "var(--warning)" : undefined }}>
                            {dataHora(v.scheduled_at)}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                            {relativo(v.scheduled_at)}
                          </div>
                        </td>
                        <td>{v.contact?.full_name ?? "--"}</td>
                        <td className="truncate">{v.property?.title ?? "A definir"}</td>
                        <td className="nowrap">
                          <span className={`badge ${CLASSE[v.status]}`.trim()}>
                            <span className="dot" />{ROTULO[v.status]}
                          </span>
                        </td>
                        <td className="nowrap" style={{ width: 1 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn ghost sm"
                                    onClick={() => irPara(`/leads/${v.opportunity_id}`)}>
                              Lead
                            </button>
                            {v.status === "SCHEDULED" && (
                              <>
                                <button className="btn sm" onClick={() => marcar(v.id, "COMPLETED")}>
                                  {Ico.check({ size: 14 })} Realizada
                                </button>
                                <button className="btn ghost sm" onClick={() => marcar(v.id, "NO_SHOW")}>
                                  Nao veio
                                </button>
                                <button className="btn ghost sm" onClick={() => marcar(v.id, "CANCELLED")}>
                                  Cancelar
                                </button>
                              </>
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
