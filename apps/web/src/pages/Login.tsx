import { useState, type FormEvent } from "react";
import { Alerta, MarcaImobiBoard } from "../ui";

const DEMO = [
  { papel: "ADMIN",  email: "carlos@terraconcreta.demo" },
  { papel: "BROKER", email: "joao@terraconcreta.demo" },
  { papel: "ADMIN",  email: "beatriz@horizonte.demo" },
];

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
  const [enviando, setEnviando] = useState(false);

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

  function preencher(mail: string) {
    setEmail(mail);
    setSenha("ImobiBoard#Demo2026");
    setErro(null);
  }

  return (
    <div className="login-shell">
      <aside className="login-marca">
        <div className="login-simbolo">
          <MarcaImobiBoard size={44} />
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
              <label className="label" htmlFor="senha">Senha</label>
              <input
                id="senha" className="input" type="password" autoComplete="current-password"
                value={senha} onChange={(e) => setSenha(e.target.value)}
                placeholder="Minimo de 6 caracteres" required
              />
            </div>

            {erro && <Alerta>{erro}</Alerta>}

            <button className="btn primary wide" type="submit" disabled={enviando}>
              {enviando ? "Entrando..." : "Entrar no CRM"}
            </button>
          </form>

          <div className="login-demo">
            <b>Ambiente de demonstracao.</b> Contas ficticias, dados gerados:
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {DEMO.map((d) => (
                <button key={d.email} type="button" onClick={() => preencher(d.email)}>
                  {d.email} <span style={{ opacity: 0.65 }}>({d.papel})</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
