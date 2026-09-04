import { useState } from "react";
import { Alerta } from "../ui";
import { supabase } from "../lib/supabase";
import { ImobiBoardMark } from "../Marca";

/**
 * Entrada de demonstração, em link próprio.
 *
 * Antes isso ficava na tela de login: três contas com e-mail visível para
 * qualquer pessoa que abrisse o CRM, inclusive o cliente real. Funcionava para
 * apresentar e atrapalhava todo o resto do tempo — quem entra para trabalhar
 * não precisa ver conta de mentira, e quem vê pensa que o sistema é um
 * protótipo.
 *
 * Agora o endereço é separado e é ele que se compartilha numa apresentação.
 * A senha destas contas fica aqui no código de propósito: são fictícias, em
 * imobiliárias de demonstração com dados gerados, e a RLS impede que elas
 * enxerguem qualquer tenant de cliente real. O que se protege é o cliente, não
 * a conta de mentira.
 */

const SENHA = "ImobiBoard#Demo2026";

const PERFIS = [
  {
    email: "carlos@terraconcreta.demo",
    nome: "Carlos Menezes",
    papel: "Administrador",
    imobiliaria: "Terra Concreta",
    conta: "Vê a operação inteira: funil, corretores, distribuição, ranking e integrações.",
  },
  {
    email: "joao@terraconcreta.demo",
    nome: "João Silva",
    papel: "Corretor",
    imobiliaria: "Terra Concreta",
    conta: "Vê só os próprios leads. Serve para mostrar o que o corretor enxerga — e o que não enxerga.",
  },
  {
    email: "beatriz@horizonte.demo",
    nome: "Beatriz Rocha",
    papel: "Administrador",
    imobiliaria: "Imobiliária Horizonte",
    conta: "Segunda imobiliária, para mostrar que uma não enxerga a outra.",
  },
];

export default function Demo({
  entrar,
}: { entrar: (email: string, senha: string) => Promise<void> }) {
  const [entrando, setEntrando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function abrir(email: string) {
    setErro(null);
    setEntrando(email);
    try {
      // quem abre este link para apresentar costuma estar logado na propria
      // conta; sem derrubar a sessao, o "entrar" cairia no CRM dele
      await supabase.auth.signOut();
      await entrar(email, SENHA);
      // a rota /demo vale com sessao aberta, entao sem sair dela a tela
      // continuaria mostrando a escolha de perfil depois de entrar
      location.hash = "/";
    } catch (e) {
      setErro((e as Error).message);
      setEntrando(null);
    }
  }

  return (
    <div className="login-shell">
      <aside className="login-marca">
        <div className="login-simbolo"><ImobiBoardMark size={96} mono="#fff" /></div>
        <div className="login-nome">IMOBI-BOARD</div>
        <div className="login-tagline">CRM Imobiliario</div>
        <div className="login-regua" />
        <p className="login-frase">
          Ambiente de demonstracao. Imobiliarias ficticias, dados gerados.
          Nada aqui pertence a cliente nenhum.
        </p>
      </aside>

      <main className="login-form-lado">
        <div className="login-card" style={{ maxWidth: 520 }}>
          <div className="login-head">
            <span className="eyebrow">Demonstracao</span>
            <h1>Escolha por qual perfil entrar</h1>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 6 }}>
              Cada perfil enxerga uma parte diferente do sistema. Da para trocar
              a qualquer momento saindo e voltando a este endereco.
            </p>
          </div>

          {erro && <Alerta>{erro}</Alerta>}

          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {PERFIS.map((p) => (
              <button
                key={p.email}
                type="button"
                onClick={() => void abrir(p.email)}
                disabled={entrando !== null}
                style={{
                  textAlign: "left", padding: "13px 15px", borderRadius: 12,
                  border: "1px solid var(--line)", background: "var(--panel)",
                  color: "var(--text)", cursor: entrando ? "wait" : "pointer",
                  opacity: entrando && entrando !== p.email ? 0.5 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{p.nome}</strong>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>
                    {p.papel} · {p.imobiliaria}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: "var(--accent, #60a5fa)" }}>
                    {entrando === p.email ? "Entrando..." : "Entrar"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 5 }}>
                  {p.conta}
                </div>
              </button>
            ))}
          </div>

          <p style={{ fontSize: 11, color: "var(--text-subtle, var(--muted))", marginTop: 16 }}>
            Para entrar com a sua conta, use{" "}
            <a href="#/" style={{ color: "inherit" }}>a tela de login</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
