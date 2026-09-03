import { ranking } from "../lib/queries";
import { definirStatusCorretor } from "../lib/notificacoes";
import { mensagemDeErro, supabase } from "../lib/supabase";
import {
  Alerta, Avatar, Card, Ico, TabelaCarregando, useAsync, useToast, Vazio,
} from "../ui";
import type { Role, Sessao } from "../lib/types";

interface Membro {
  id: string;
  user_id: string;
  role: Role;
  status: "ACTIVE" | "INACTIVE";
  profile: { full_name: string | null; phone: string | null } | null;
}

async function membros(tenantId: string): Promise<Membro[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, user_id, role, status, profile:profiles(full_name, phone)")
    .eq("tenant_id", tenantId)
    .order("role");
  if (error) throw error;
  return (data ?? []) as unknown as Membro[];
}

export default function Corretores({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const dados = useAsync(
    async () => ({
      membros: await membros(sessao.tenant.id),
      desempenho: await ranking(sessao.tenant.id, 30),
    }),
    [sessao.tenant.id]
  );

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;

  if (dados.carregando || !dados.dado) {
    return <Card><div className="card-body flush"><TabelaCarregando linhas={4} colunas={5} /></div></Card>;
  }

  const { membros: lista, desempenho } = dados.dado;

  async function alternar(id: string, ativo: boolean) {
    try {
      await definirStatusCorretor(id, ativo);
      avisar("ok", ativo ? "Corretor reativado." : "Corretor desativado e retirado das filas.");
      dados.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }
  const porUsuario = new Map(desempenho.map((d) => [d.user_id, d]));

  return (
    <>
      <Alerta tipo="warn">
        Convite por e-mail ainda passa pelo Supabase Auth na mao. Desativar aqui
        tira o corretor das filas na hora: ele para de receber lead novo.
      </Alerta>

      <Card>
        <div className="card-head">
          <h2>Equipe</h2>
          <span className="badge">{lista.length} pessoa{lista.length === 1 ? "" : "s"}</span>
        </div>
        <div className="card-body flush">
          {lista.length === 0 ? (
            <Vazio icone={Ico.users({ size: 20 })} titulo="Nenhum membro" />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Papel</th>
                    <th>Status</th>
                    <th className="num">Leads (30d)</th>
                    <th className="num">Vendas</th>
                    <th className="num">Parados</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((m) => {
                    const d = porUsuario.get(m.user_id);
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="row" style={{ gap: 9 }}>
                            <Avatar nome={m.profile?.full_name} />
                            <div>
                              <div style={{ fontWeight: 550 }}>
                                {m.profile?.full_name ?? "Sem nome"}
                              </div>
                              {m.user_id === sessao.userId && (
                                <div style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>voce</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${m.role === "ADMIN" ? "visit" : ""}`.trim()}>
                            {m.role === "ADMIN" ? "Administrador" : "Corretor"}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${m.status === "ACTIVE" ? "won" : "lost"}`}>
                            <span className="dot" />
                            {m.status === "ACTIVE" ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                        <td className="num">{d ? d.leads : "--"}</td>
                        <td className="num">{d ? d.vendas : "--"}</td>
                        <td className="num" style={{ color: d && d.parados > 0 ? "var(--warning)" : undefined }}>
                          {d ? d.parados : "--"}
                        </td>
                        <td className="nowrap" style={{ width: 1 }}>
                          {m.user_id !== sessao.userId && (
                            <button
                              className={m.status === "ACTIVE" ? "btn ghost sm" : "btn sm"}
                              onClick={() => alternar(m.id, m.status !== "ACTIVE")}
                            >
                              {m.status === "ACTIVE" ? "Desativar" : "Reativar"}
                            </button>
                          )}
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
