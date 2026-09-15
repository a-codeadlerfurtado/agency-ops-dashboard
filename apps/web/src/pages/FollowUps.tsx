import { irPara } from "../App";
import { dataHora, relativo } from "../lib/format";
import { concluirTarefa, tarefas } from "../lib/queries";
import { mensagemDeErro } from "../lib/supabase";
import {
  Alerta, CabecalhoDaPagina, Card, Ico, TabelaCarregando, useAsync, useToast,
  Vazio,
} from "../ui";
import type { Sessao, Task } from "../lib/types";

export default function FollowUps({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const lista = useAsync(() => tarefas(sessao.userId), [sessao.userId]);

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  async function concluir(id: string) {
    try {
      await concluirTarefa(id);
      avisar("ok", "Follow-up concluido.");
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  if (lista.carregando && !lista.dado) {
    return (
      <>
      <CabecalhoDaPagina
        contexto="Sua agenda"
        titulo="Follow-ups"
        descricao="O que voce prometeu retornar. Atrasado primeiro, porque e o que custa lead."
      />
      <Card><div className="card-body flush"><TabelaCarregando linhas={5} colunas={3} /></div></Card>
      </>
    );
  }

  const itens = lista.dado ?? [];
  const inicioDeHoje = new Date(); inicioDeHoje.setHours(0, 0, 0, 0);
  const fimDeHoje = new Date(inicioDeHoje.getTime() + 86_400_000);

  const atrasados = itens.filter((t) => new Date(t.due_at) < inicioDeHoje);
  const hoje = itens.filter((t) => {
    const d = new Date(t.due_at);
    return d >= inicioDeHoje && d < fimDeHoje;
  });
  const futuros = itens.filter((t) => new Date(t.due_at) >= fimDeHoje);

  if (itens.length === 0) {
    return (
      <>
      <CabecalhoDaPagina
        contexto="Sua agenda"
        titulo="Follow-ups"
        descricao="O que voce prometeu retornar. Atrasado primeiro, porque e o que custa lead."
      />
      <Card>
        <Vazio
          icone={Ico.check({ size: 20 })}
          titulo="Nenhum follow-up aberto"
          texto="Agende o proximo passo direto na ficha do lead para nao perder o timing."
          acao={<button className="btn" onClick={() => irPara("/leads")}>Ir para os leads</button>}
        />
      </Card>
      </>
    );
  }

  return (
    <>
      <CabecalhoDaPagina
        contexto="Sua agenda"
        titulo="Follow-ups"
        descricao="O que voce prometeu retornar. Atrasado primeiro, porque e o que custa lead."
      />
      <Grupo titulo="Atrasados" itens={atrasados} tom="err" aoConcluir={concluir} />
      <Grupo titulo="Hoje" itens={hoje} tom="warn" aoConcluir={concluir} />
      <Grupo titulo="Proximos" itens={futuros} aoConcluir={concluir} />
    </>
  );
}

function Grupo({ titulo, itens, tom, aoConcluir }: {
  titulo: string; itens: Task[]; tom?: "err" | "warn";
  aoConcluir: (id: string) => Promise<void>;
}) {
  if (itens.length === 0) return null;

  return (
    <Card>
      <div className="card-head">
        <h2>{titulo}</h2>
        <span className={`badge ${tom === "err" ? "lost" : tom === "warn" ? "qualified" : ""}`.trim()}>
          {itens.length}
        </span>
      </div>
      <div className="card-body flush">
        <div className="table-wrap">
          <table className="tbl">
            <tbody>
              {itens.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{t.title}</div>
                    {t.description && (
                      <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>{t.description}</div>
                    )}
                  </td>
                  <td className="nowrap" style={{
                    color: tom === "err" ? "var(--danger)" : "var(--muted)", fontSize: 13,
                  }}>
                    {relativo(t.due_at)}
                    <div style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
                      {dataHora(t.due_at)}
                    </div>
                  </td>
                  <td className="nowrap" style={{ width: 1 }}>
                    <div className="row" style={{ gap: 6 }}>
                      {t.opportunity_id && (
                        <button
                          className="btn ghost sm"
                          onClick={() => irPara(`/leads/${t.opportunity_id}`)}
                        >
                          Ver lead
                        </button>
                      )}
                      <button className="btn sm" onClick={() => aoConcluir(t.id)}>
                        {Ico.check({ size: 14 })} Concluir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
