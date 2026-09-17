import { useEffect, useState } from "react";
import { supabase, mensagemDeErro } from "../lib/supabase";
import { Alerta, Ico } from "../ui";
import { ImobiBoardMark } from "../Marca";

type Estado =
  | { fase: "entrar" }
  | { fase: "processando" }
  | { fase: "ok"; tenant: string; role: string }
  | { fase: "erro"; mensagem: string };

/**
 * Tela do convite.
 *
 * A pessoa entra (ou cria a conta) e só então o convite é resolvido. O nome da
 * imobiliária não aparece antes do login de propósito: mostrá-lo exigiria dar
 * `USAGE` no schema ao papel `anon`, e a garantia de que sem sessão a
 * superfície é zero vale mais do que esse detalhe de tela.
 *
 * O convite guarda o e-mail: entrar com outro e-mail não aceita o convite,
 * mesmo com o token na mão.
 */
export default function Convite({ token }: { token: string }) {
  const [estado, setEstado] = useState<Estado>({ fase: "entrar" });
  const [modo, setModo] = useState<"entrar" | "criar">("criar");
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [enviando, setEnviando] = useState(false);

  // se já houver sessão, tenta aceitar direto
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void aceitar();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function aceitar() {
    setEstado({ fase: "processando" });
    const { data, error } = await supabase.rpc("aceitar_convite", { p_token: token });
    if (error) {
      setEstado({ fase: "erro", mensagem: mensagemDeErro(error) });
      return;
    }
    const r = data as { tenant: string; role: string };
    setEstado({ fase: "ok", tenant: r.tenant, role: r.role });
    setTimeout(() => { location.hash = "/"; location.reload(); }, 1400);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      if (modo === "criar") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password: senha,
          options: { data: { full_name: nome.trim() } },
        });
        if (error) {
          if (error.message === "User already registered" || error.message.toLowerCase().includes("already registered")) {
            setModo("entrar");
            setEstado({
              fase: "erro",
              mensagem: "Este e-mail ja tem conta no Imobi-Board. Entre com a senha da conta para concluir o convite.",
            });
            return;
          }
          throw error;
        }
        // projeto com confirmação de e-mail não devolve sessão na hora
        if (!data.session) {
          setEstado({
            fase: "erro",
            mensagem: "Conta criada. Confirme o e-mail que enviamos e abra este link de novo.",
          });
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password: senha,
        });
        if (error) {
          throw new Error(
            error.message === "Invalid login credentials"
              ? "E-mail ou senha incorretos."
              : mensagemDeErro(error)
          );
        }
      }
      await aceitar();
    } catch (err) {
      setEstado({ fase: "erro", mensagem: (err as Error).message });
    } finally {
      setEnviando(false);
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
          Voce foi convidado para uma equipe comercial. Entre para comecar.
        </p>
      </aside>

      <main className="login-form-lado">
        <div className="login-card">
          {estado.fase === "ok" ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ color: "var(--success)", marginBottom: 12 }}>
                {Ico.check({ size: 30 })}
              </div>
              <h1 style={{ fontSize: 22 }}>Bem-vindo a {estado.tenant}</h1>
              <p style={{ color: "var(--muted)", marginTop: 6 }}>
                Voce entrou como {estado.role === "ADMIN" ? "administrador" : "corretor"}.
                Abrindo o CRM...
              </p>
            </div>
          ) : (
            <>
              <div className="login-head">
                <span className="eyebrow">Convite de equipe</span>
                <h1>{modo === "criar" ? "Crie sua conta" : "Entre na sua conta"}</h1>
                <p>Use o e-mail em que voce recebeu o convite.</p>
              </div>

              <form className="login-form" onSubmit={enviar}>
                {modo === "criar" && (
                  <div className="field">
                    <label className="label" htmlFor="n">Seu nome</label>
                    <input id="n" className="input" required autoFocus value={nome}
                           onChange={(e) => setNome(e.target.value)} placeholder="Joao Silva" />
                  </div>
                )}
                <div className="field">
                  <label className="label" htmlFor="e">E-mail</label>
                  <input id="e" className="input" type="email" required
                         autoComplete="username" value={email}
                         onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="s">Senha</label>
                  <input id="s" className="input" type="password" required minLength={6}
                         autoComplete={modo === "criar" ? "new-password" : "current-password"}
                         value={senha} onChange={(e) => setSenha(e.target.value)}
                         placeholder="Minimo de 6 caracteres" />
                </div>

                {estado.fase === "erro" && <Alerta>{estado.mensagem}</Alerta>}

                <button className="btn primary wide" type="submit"
                        disabled={enviando || estado.fase === "processando"}>
                  {enviando || estado.fase === "processando"
                    ? "Aguarde..."
                    : modo === "criar" ? "Criar conta e entrar" : "Entrar"}
                </button>
              </form>

              <div className="login-demo">
                {modo === "criar" ? "Ja tem conta no Imobi-Board? " : "Ainda nao tem conta? "}
                <button type="button"
                        onClick={() => setModo(modo === "criar" ? "entrar" : "criar")}>
                  {modo === "criar" ? "Entrar" : "Criar conta"}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
