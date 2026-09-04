import { useState, type FormEvent } from "react";
import { Alerta } from "../ui";
import { supabase } from "../lib/supabase";
import { ImobiBoardMark } from "../Marca";

/**
 * Login com a mesma arquitetura visual do Agency Ops: painel de marca à
 * esquerda em gradiente da marca, formulário à direita sobre superfície
 * escura. O conteúdo é outro — o produto é outro — mas a composição, o
 * eyebrow laranja, o peso do título e o botão primário são da mesma família.
 */
export default function Login({
  entrar,
}: { entrar: (email: string, senha: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [recuperando, setRecuperando] = useState(false);

  /**
   * Recuperação de senha.
   *
   * A resposta é sempre a mesma, tenha o e-mail conta ou não: dizer "esse
   * e-mail não existe" entregaria a lista de quem usa o sistema para quem
   * ficasse testando endereços.
   */
  async function recuperar() {
    const alvo = email.trim();
    if (!alvo) {
      setErro("Escreva seu e-mail no campo acima e clique de novo.");
      return;
    }
    setErro(null);
    setRecuperando(true);
    try {
      await supabase.auth.resetPasswordForEmail(alvo, {
        redirectTo: `${location.origin}${location.pathname}#/nova-senha`,
      });
    } catch {
      /* mesma resposta em qualquer caso */
    } finally {
      setRecuperando(false);
      setAviso(
        `Se ${alvo} tiver conta, o link para criar senha nova chega em instantes. ` +
        "Confira tambem o spam."
      );
    }
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await entrar(email.trim(), senha);
    } catch (err) {
      setErro((err as Error).message);
      setEnviando(false);
    }
  }

  return (
    <div className="login-shell">
      <aside className="login-marca">
        <div className="login-simbolo">
          <ImobiBoardMark size={96} mono="#fff" />
        </div>
        <div className="login-nome">IMOBI-BOARD</div>
        <div className="login-tagline">CRM Imobiliario</div>
        <div className="login-regua" />
        <p className="login-frase">
          Do anuncio ao contrato: lead, corretor, imovel e venda
          em um so lugar.
        </p>
      </aside>

      <main className="login-form-lado">
        <div className="login-card">
          <div className="login-head">
            <span className="eyebrow">Central comercial</span>
            <h1>Entre na operacao</h1>
            <p>Acesse sua carteira para continuar.</p>
          </div>

          <form className="login-form" onSubmit={enviar}>
            <div className="field">
              <label className="label" htmlFor="email">E-mail</label>
              <input
                id="email" className="input" type="email" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@imobiliaria.com.br" required autoFocus
              />
            </div>

            <div className="field">
              <div className="row" style={{ gap: 8 }}>
                <label className="label" htmlFor="senha" style={{ margin: 0 }}>Senha</label>
                <span className="spacer" />
                <button
                  type="button"
                  onClick={recuperar}
                  disabled={recuperando}
                  style={{
                    background: "none", border: 0, padding: 0, cursor: "pointer",
                    color: "var(--blue)", font: "inherit", fontSize: 12,
                  }}
                >
                  {recuperando ? "Enviando..." : "Esqueci minha senha"}
                </button>
              </div>
              <input
                id="senha" className="input" type="password" autoComplete="current-password"
                value={senha} onChange={(e) => setSenha(e.target.value)}
                placeholder="Minimo de 6 caracteres" required
              />
            </div>

            {erro && <Alerta>{erro}</Alerta>}
            {aviso && <Alerta tipo="warn">{aviso}</Alerta>}

            <button className="btn primary wide" type="submit" disabled={enviando}>
              {enviando ? "Entrando..." : "Entrar no CRM"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
