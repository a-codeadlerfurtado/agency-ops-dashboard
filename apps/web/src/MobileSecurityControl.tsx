import { useEffect, useState } from "react";
import {
  ativarPush, biometriaAtiva, biometriaDisponivel, definirBiometria, ehNativo, impactoLeve,
} from "./lib/native";
import type { Sessao } from "./lib/types";

export default function MobileSecurityControl({ sessao }: { sessao: Sessao }) {
  const [visivel, setVisivel] = useState(false);
  const [ativa, setAtiva] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [pushAtivando, setPushAtivando] = useState(false);
  const [pushOk, setPushOk] = useState(false);

  useEffect(() => {
    if (!ehNativo()) return;
    void Promise.all([biometriaDisponivel(), biometriaAtiva()]).then(([disponivel, habilitada]) => {
      setVisivel(disponivel);
      setAtiva(habilitada);
    });
  }, []);

  if (!ehNativo()) return null;

  async function alternar() {
    setOcupado(true);
    setErro("");
    try {
      const proxima = !ativa;
      await definirBiometria(proxima);
      await impactoLeve();
      setAtiva(proxima);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Nao foi possivel alterar a biometria.");
    } finally {
      setOcupado(false);
    }
  }
  return (
    <div className="native-security-control">
      {visivel && (
        <button
          type="button"
          className="btn ghost sm wide"
          disabled={ocupado}
          onClick={() => void alternar()}
          aria-pressed={ativa}
        >
          {ativa ? "Biometria ativada" : "Ativar biometria"}
        </button>
      )}
      {!sessao.modoMestre && (
        <button
          type="button"
          className="btn ghost sm wide"
          disabled={pushAtivando || pushOk}
          onClick={() => {
            setPushAtivando(true);
            setErro("");
            void ativarPush(sessao)
              .then((ok) => setPushOk(ok))
              .catch((e) => setErro(e instanceof Error ? e.message : "Nao foi possivel ativar notificacoes."))
              .finally(() => setPushAtivando(false));
          }}
        >
          {pushOk ? "Notificacoes ativadas" : pushAtivando ? "Ativando..." : "Ativar notificacoes"}
        </button>
      )}
      {erro && <div className="hint" style={{ color: "var(--danger)" }}>{erro}</div>}
    </div>
  );
}
