import { useState, type FormEvent } from "react";
import { Alerta, Card, MarcaImobiBoard } from "../ui";

const DEMO = [
  { papel: "ADMIN",  email: "carlos@terraconcreta.demo", nome: "Carlos - Terra Concreta" },
  { papel: "BROKER", email: "joao@terraconcreta.demo",   nome: "Joao - Terra Concreta" },
  { papel: "ADMIN",  email: "beatriz@horizonte.demo",    nome: "Beatriz - Horizonte" },
];

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
      <div className="login-card">
        <div className="login-head">
          <div className="brand-mark"><MarcaImobiBoard size={22} /></div>
          <h1>Imobi-Board</h1>
          <p>Do anuncio a venda, em um lugar so.</p>
        </div>

        <Card>
          <div className="card-body">
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
                  placeholder="********" required
                />
              </div>

              {erro && <Alerta>{erro}</Alerta>}

              <button className="btn primary wide" type="submit" disabled={enviando}>
                {enviando ? "Entrando..." : "Entrar"}
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
        </Card>
      </div>
    </div>
  );
}
