import { useState } from "react";
import { dataHora } from "../lib/format";
import { criarImobiliaria, imobiliarias, type Imobiliaria } from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, CabecalhoDaPagina, Card, Ico, TabelaCarregando, useAsync, useToast, Vazio,
} from "../ui";

const linkDoConvite = (token: string) =>
  `${location.origin}${location.pathname}#/convite/${token}`;

/**
 * Console da operação — quem cria imobiliária.
 *
 * Fica fora do CRM do cliente de propósito: não é uma tela de ADMIN com mais
 * permissão, é outro nível. Quem entra aqui é conferido por lista de e-mail no
 * banco, e a RPC recusa quem não está nela — então a rota não vaza por acaso.
 *
 * O convite do primeiro ADMIN sai daqui e é entregue por você. Não há envio de
 * e-mail: no volume de uma agência, mandar o link no WhatsApp onde a conversa
 * já está acontecendo chega melhor do que e-mail de sistema, que cai em spam.
 */
export default function Operacao({
  aoAcessar,
}: {
  aoAcessar?: (imobiliaria: Imobiliaria) => void | Promise<void>;
}) {
  const avisar = useToast();
  const [criando, setCriando] = useState(false);
  const [convite, setConvite] = useState<{
    nome: string; email: string; token: string;
  } | null>(null);

  const lista = useAsync(() => imobiliarias(), []);

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  const itens = lista.dado ?? [];

  return (
    <>
      <CabecalhoDaPagina
        contexto="Operacao"
        titulo="Imobiliarias"
        descricao="Cada uma entra com funil, fila de atendimento e um convite de administrador."
        acoes={
          <button className="btn primary" onClick={() => setCriando(true)}>
            {Ico.plus({ size: 15 })} Nova imobiliaria
          </button>
        }
      />

      <Card>
        <div className="card-body flush">
          {lista.carregando && itens.length === 0 ? (
            <TabelaCarregando linhas={3} colunas={5} />
          ) : itens.length === 0 ? (
            <Vazio
              icone={Ico.building({ size: 20 })}
              titulo="Nenhuma imobiliaria ainda"
              texto="Cadastre a primeira e mande o convite para o administrador dela."
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Imobiliaria</th>
                    <th className="num">Pessoas</th>
                    <th className="num">Leads</th>
                    <th>Situacao</th>
                    <th>Criada</th>
                    {aoAcessar && <th aria-label="Acoes" />}
                  </tr>
                </thead>
                <tbody>
                  {itens.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{t.nome}</div>
                        <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>{t.slug}</div>
                      </td>
                      <td className="num">{t.membros}</td>
                      <td className="num">{t.leads}</td>
                      <td className="nowrap">
                        {t.filas === 0 ? (
                          <span className="badge lost" title="Lead que chegar nao tem para onde ir">
                            <span className="dot" />sem fila
                          </span>
                        ) : t.membros === 0 && t.convites_pendentes > 0 ? (
                          <span className="badge"><span className="dot" />convite pendente</span>
                        ) : t.membros === 0 ? (
                          <span className="badge lost"><span className="dot" />sem ninguem</span>
                        ) : (
                          <span className="badge won"><span className="dot" />ativa</span>
                        )}
                      </td>
                      <td className="nowrap" style={{ color: "var(--muted)" }}>
                        {dataHora(t.criada_em)}
                      </td>
                      {aoAcessar && (
                        <td className="nowrap" style={{ textAlign: "right" }}>
                          <button
                            className="btn primary sm"
                            onClick={() => void aoAcessar(t)}
                            title={`Administrar ${t.nome}`}
                          >
                            Acessar conta
                          </button>
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

      <NovaImobiliaria
        aberto={criando}
        aoFechar={() => setCriando(false)}
        aoCriar={(r) => {
          setCriando(false);
          setConvite({ nome: r.nome, email: r.email, token: r.token });
          lista.recarregar();
        }}
      />

      <Dialogo
        aberto={convite !== null}
        titulo="Imobiliaria criada"
        aoFechar={() => setConvite(null)}
        largura={560}
      >
        {convite && (
          <div className="col" style={{ gap: 13 }}>
            <Alerta tipo="warn">
              Este link aparece uma unica vez. Mande para {convite.email} agora.
              Depois de fechar, so gerando outro convite.
            </Alerta>
            <div style={{ color: "var(--muted)", fontSize: 13.5 }}>
              <b style={{ color: "var(--text-heading)" }}>{convite.nome}</b> ja tem
              funil, fila de atendimento e etapas. Falta so o administrador entrar.
            </div>
            <div className="field">
              <label className="label">Link do convite</label>
              <input
                className="input" readOnly value={linkDoConvite(convite.token)}
                onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
              />
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkDoConvite(convite.token));
                    avisar("ok", "Link copiado.");
                  } catch {
                    avisar("err", "Copie o link manualmente.");
                  }
                }}
              >
                Copiar link
              </button>
              <a
                className="btn"
                target="_blank" rel="noreferrer"
                href={"https://wa.me/?text=" + encodeURIComponent(
                  `Seu acesso ao Imobi-Board (${convite.nome}): ${linkDoConvite(convite.token)}`
                )}
              >
                {Ico.whats({ size: 15 })} WhatsApp
              </a>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setConvite(null)}>Fechar</button>
            </div>
            <span className="hint">O convite expira em 7 dias e so vale para esse e-mail.</span>
          </div>
        )}
      </Dialogo>
    </>
  );
}

function NovaImobiliaria({
  aberto, aoFechar, aoCriar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  aoCriar: (r: { nome: string; email: string; token: string; slug: string }) => void;
}) {
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function fechar() { setNome(""); setEmail(""); setErro(null); aoFechar(); }

  return (
    <Dialogo aberto={aberto} titulo="Nova imobiliaria" aoFechar={fechar} largura={520}>
      <form
        className="col" style={{ gap: 13 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setSalvando(true); setErro(null);
          try {
            const r = await criarImobiliaria(nome.trim(), email.trim());
            aoCriar({ ...r, nome: nome.trim() });
            setNome(""); setEmail("");
          } catch (err) {
            setErro(mensagemDeErro(err));
          } finally {
            setSalvando(false);
          }
        }}
      >
        <div className="field">
          <label className="label" htmlFor="im-nome">Nome da imobiliaria</label>
          <input
            id="im-nome" className="input" required autoFocus value={nome}
            onChange={(e) => setNome(e.target.value)} placeholder="Terra Concreta"
          />
          <span className="hint">O endereco interno sai do nome, sem acento nem simbolo.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="im-email">E-mail do administrador</label>
          <input
            id="im-email" className="input" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="dono@imobiliaria.com.br"
          />
          <span className="hint">
            Ele recebe o convite, cria a propria senha e vira ADMIN. O convite so
            funciona nesse e-mail.
          </span>
        </div>

        {erro && <Alerta>{erro}</Alerta>}

        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" type="submit"
                  disabled={salvando || !nome.trim() || !email.trim()}>
            {salvando ? "Criando..." : "Criar e gerar convite"}
          </button>
          <button className="btn ghost" type="button" onClick={fechar}>Cancelar</button>
        </div>
      </form>
    </Dialogo>
  );
}
