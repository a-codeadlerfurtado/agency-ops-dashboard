import { useState } from "react";
import { ranking } from "../lib/queries";
import {
  definirStatusCorretor, convites, convidarMembro, revogarConvite,
  type Convite,
} from "../lib/notificacoes";
import { mensagemDeErro, supabase } from "../lib/supabase";
import { dataHora } from "../lib/format";
import Dialogo from "../Dialogo";
import {
  Alerta, Avatar, CabecalhoDaPagina, Card, Ico, TabelaCarregando, useAsync,
  useToast, Vazio,
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

const linkDoConvite = (token: string) =>
  `${location.origin}${location.pathname}#/convite/${token}`;

/**
 * Convite.
 *
 * O token so aparece uma vez: ele nao e legivel depois de criado, nem para o
 * admin que convidou. Se a pessoa perder o link, revoga e convida de novo.
 * Nao mandamos o e-mail daqui de proposito -- exigiria a service_role no
 * frontend, e ela nunca entra no bundle.
 */
function FormularioDeConvite({
  aberto, aoFechar, aoCriar,
}: { aberto: boolean; aoFechar: () => void; aoCriar: () => void }) {
  const avisar = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "BROKER">("BROKER");
  const [enviando, setEnviando] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  function fechar() {
    setEmail("");
    setRole("BROKER");
    setLink(null);
    setErro(null);
    aoFechar();
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await convidarMembro(email.trim().toLowerCase(), role);
      setLink(linkDoConvite(r.token));
      aoCriar();
    } catch (err) {
      setErro(mensagemDeErro(err));
    } finally {
      setEnviando(false);
    }
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      avisar("ok", "Link copiado.");
    } catch {
      avisar("err", "Copie o link manualmente: o navegador bloqueou a area de transferencia.");
    }
  }

  const zap = link
    ? "https://wa.me/?text=" +
      encodeURIComponent("Voce foi convidado para o Imobi-Board: " + link)
    : "";

  return (
    <Dialogo aberto={aberto} titulo="Convidar para a equipe" aoFechar={fechar}>
      {link ? (
        <div className="col" style={{ gap: 12 }}>
          <Alerta tipo="warn">
            Este link aparece uma unica vez. Envie para {email} agora: depois de
            fechar, nem voce consegue ve-lo de novo.
          </Alerta>
          <div className="field">
            <label className="label">Link do convite</label>
            <input
              className="input" readOnly value={link}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" onClick={() => copiar(link)}>
              Copiar link
            </button>
            <a className="btn" href={zap} target="_blank" rel="noreferrer">
              {Ico.whats({ size: 15 })} WhatsApp
            </a>
            <span className="spacer" />
            <button className="btn ghost" onClick={fechar}>Fechar</button>
          </div>
          <span className="hint">O convite expira em 7 dias.</span>
        </div>
      ) : (
        <form className="col" style={{ gap: 12 }} onSubmit={enviar}>
          <div className="field">
            <label className="label" htmlFor="ci-email">E-mail</label>
            <input
              id="ci-email" className="input" type="email" required autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="corretor@imobiliaria.com.br"
            />
            <span className="hint">
              O convite so vale para este e-mail: entrar com outro nao funciona.
            </span>
          </div>
          <div className="field">
            <label className="label" htmlFor="ci-role">Papel</label>
            <select
              id="ci-role" className="input" value={role}
              onChange={(e) => setRole(e.target.value as "ADMIN" | "BROKER")}
            >
              <option value="BROKER">Corretor</option>
              <option value="ADMIN">Administrador</option>
            </select>
            <span className="hint">
              {role === "ADMIN"
                ? "Ve todos os leads, edita filas e regras de distribuicao."
                : "Ve apenas os proprios leads e entra no rodizio de distribuicao."}
            </span>
          </div>

          {erro && <Alerta>{erro}</Alerta>}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={enviando}>
              {enviando ? "Gerando..." : "Gerar convite"}
            </button>
            <button className="btn ghost" type="button" onClick={fechar}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </Dialogo>
  );
}

function Pendentes({ lista, aoMudar }: { lista: Convite[]; aoMudar: () => void }) {
  const avisar = useToast();
  if (lista.length === 0) return null;

  async function revogar(c: Convite) {
    try {
      await revogarConvite(c.id);
      avisar("ok", `Convite de ${c.email} revogado.`);
      aoMudar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  const agora = Date.now();

  return (
    <Card>
      <div className="card-head">
        <h2>Convites pendentes</h2>
        <span className="badge">{lista.length}</span>
      </div>
      <div className="card-body flush">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>E-mail</th>
                <th>Papel</th>
                <th>Enviado</th>
                <th>Expira</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => {
                const expirado = new Date(c.expires_at).getTime() < agora;
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        {Ico.mail({ size: 15 })}
                        <span className="truncate">{c.email}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${c.role === "ADMIN" ? "visit" : ""}`.trim()}>
                        {c.role === "ADMIN" ? "Administrador" : "Corretor"}
                      </span>
                    </td>
                    <td className="nowrap">{dataHora(c.created_at)}</td>
                    <td className="nowrap">
                      <span className={`badge ${expirado ? "lost" : ""}`.trim()}>
                        {expirado ? "Expirado" : dataHora(c.expires_at)}
                      </span>
                    </td>
                    <td className="nowrap" style={{ width: 1 }}>
                      <button className="btn ghost sm" onClick={() => revogar(c)}>
                        Revogar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

export default function Corretores({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [convidando, setConvidando] = useState(false);
  const dados = useAsync(
    async () => ({
      membros: await membros(sessao.tenant.id),
      desempenho: await ranking(sessao.tenant.id, 30),
      pendentes: await convites(sessao.tenant.id),
    }),
    [sessao.tenant.id]
  );

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;

  if (!dados.dado) {
    return (
      <Card>
        <div className="card-body flush"><TabelaCarregando linhas={4} colunas={5} /></div>
      </Card>
    );
  }

  const { membros: lista, desempenho, pendentes } = dados.dado;

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
      <CabecalhoDaPagina
        contexto="Gestao de pessoas"
        titulo="Corretores"
        descricao="Quem esta no time, quanto cada um produz e quem entra no rodizio de leads."
      />
      <Card>
        <div className="card-head">
          <h2>Equipe</h2>
          <span className="badge">{lista.length} pessoa{lista.length === 1 ? "" : "s"}</span>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setConvidando(true)}>
            {Ico.plus({ size: 14 })} Convidar
          </button>
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

      <Pendentes lista={pendentes} aoMudar={() => dados.recarregar()} />

      <FormularioDeConvite
        aberto={convidando}
        aoFechar={() => setConvidando(false)}
        aoCriar={() => dados.recarregar()}
      />
    </>
  );
}
