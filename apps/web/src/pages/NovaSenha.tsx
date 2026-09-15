import { useEffect, useState } from "react";
import { supabase, mensagemDeErro } from "../lib/supabase";
import { Alerta, Ico } from "../ui";
import { ImobiBoardMark } from "../Marca";

/**
 * Definir senha nova, depois de clicar no link de recuperação.
 *
 * O link do Supabase abre o app já com uma sessão de recuperação ativa — é por
 * isso que `updateUser` funciona aqui sem pedir a senha antiga. Se a pessoa
 * abrir esta rota sem vir do e-mail, não há sessão e a tela diz isso em vez de
 * falhar no envio.
 */
export default function NovaSenha() {
  const [temSessao, setTemSessao] = useState<boolean | null>(null);
  const [senha, setSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setTemSessao(Boolean(data.session)));
  }, []);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (senha !== repetida) {
      setErro("As duas senhas precisam ser iguais.");
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: senha });
      if (error) throw error;
      setPronto(true);
      setTimeout(() => { location.hash = "/"; location.reload(); }, 1600);
    } catch (err) {
      setErro(mensagemDeErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="login-shell">
      <aside className="login-marca">
        <div className="login-simbolo"><ImobiBoardMark size={96} mono="#fff" /></div>
        <div className="login-nome">IMOBI-BOARD</div>
        <div className="login-tagline">CRM Imobiliario</div>
        <div className="login-regua" />
        <p className="login-frase">Escolha uma senha nova e volte para a operacao.</p>
      </aside>

      <main className="login-form-lado">
        <div className="login-card">
          {pronto ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ color: "var(--success)", marginBottom: 12 }}>
                {Ico.check({ size: 30 })}
              </div>
              <h1 style={{ fontSize: 22 }}>Senha alterada</h1>
              <p style={{ color: "var(--muted)", marginTop: 6 }}>Abrindo o CRM...</p>
            </div>
          ) : temSessao === false ? (
            <>
              <div className="login-head">
                <span className="eyebrow">Recuperacao</span>
                <h1>Link expirado</h1>
                <p>
                  Este link ja foi usado ou passou da validade. Peca outro na tela
                  de entrada.
                </p>
              </div>
              <button className="btn primary wide" onClick={() => { location.hash = "/"; location.reload(); }}>
                Voltar para a entrada
              </button>
            </>
          ) : (
            <>
              <div className="login-head">
                <span className="eyebrow">Recuperacao</span>
                <h1>Nova senha</h1>
                <p>Escolha a senha que voce vai usar daqui para frente.</p>
              </div>
              <form className="login-form" onSubmit={salvar}>
                <div className="field">
                  <label className="label" htmlFor="s1">Nova senha</label>
                  <input id="s1" className="input" type="password" required minLength={6}
                         autoComplete="new-password" autoFocus value={senha}
                         onChange={(e) => setSenha(e.target.value)}
                         placeholder="Minimo de 6 caracteres" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="s2">Repita a senha</label>
                  <input id="s2" className="input" type="password" required minLength={6}
                         autoComplete="new-password" value={repetida}
                         onChange={(e) => setRepetida(e.target.value)} />
                </div>
                {erro && <Alerta>{erro}</Alerta>}
                <button className="btn primary wide" type="submit" disabled={salvando}>
                  {salvando ? "Salvando..." : "Salvar senha"}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
