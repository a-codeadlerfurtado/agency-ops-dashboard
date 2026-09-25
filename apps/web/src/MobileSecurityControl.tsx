import { useEffect, useState } from "react";
import {
  biometriaAtiva, biometriaDisponivel, definirBiometria, ehNativo, impactoLeve,
} from "./lib/native";

export default function MobileSecurityControl() {
  const [visivel, setVisivel] = useState(false);
  const [ativa, setAtiva] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (!ehNativo()) return;
    void Promise.all([biometriaDisponivel(), biometriaAtiva()]).then(([disponivel, habilitada]) => {
      setVisivel(disponivel);
      setAtiva(habilitada);
    });
  }, []);

  if (!visivel) return null;

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
      <button
        type="button"
        className="btn ghost sm wide"
        disabled={ocupado}
        onClick={() => void alternar()}
        aria-pressed={ativa}
      >
        {ativa ? "Biometria ativada" : "Ativar biometria"}
      </button>
      {erro && <div className="hint" style={{ color: "var(--danger)" }}>{erro}</div>}
    </div>
  );
}
