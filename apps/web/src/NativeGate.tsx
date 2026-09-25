import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { App as NativeApp } from "@capacitor/app";
import {
  autenticarBiometria, biometriaAtiva, ehNativo, observarRede, statusDaRede,
} from "./lib/native";
import { ImobiBoardMark } from "./Marca";

export default function NativeGate({ children }: { children: ReactNode }) {
  const [bloqueado, setBloqueado] = useState(false);
  const [autenticando, setAutenticando] = useState(false);
  const [erro, setErro] = useState("");
  const [online, setOnline] = useState(true);
  const saiuEm = useRef<number | null>(null);

  const desbloquear = useCallback(async () => {
    if (!ehNativo() || !(await biometriaAtiva())) {
      setBloqueado(false);
      return;
    }
    setAutenticando(true);
    setErro("");
    try {
      await autenticarBiometria();
      setBloqueado(false);
    } catch {
      setBloqueado(true);
      setErro("Nao foi possivel confirmar sua identidade.");
    } finally {
      setAutenticando(false);
    }
  }, []);
  useEffect(() => {
    let limparRede: (() => void) | undefined;
    let appHandle: { remove: () => Promise<void> } | undefined;
    let vivo = true;

    void statusDaRede().then((s) => { if (vivo) setOnline(s.connected); });
    void observarRede((conectado) => setOnline(conectado)).then((fn) => {
      limparRede = fn;
    });

    if (ehNativo()) {
      void biometriaAtiva().then((ativa) => {
        if (!vivo || !ativa) return;
        setBloqueado(true);
        void desbloquear();
      });
      void NativeApp.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) {
          saiuEm.current = Date.now();
          return;
        }
        const tempoFora = saiuEm.current ? Date.now() - saiuEm.current : 0;
        saiuEm.current = null;
        if (tempoFora >= 15_000) {
          void biometriaAtiva().then((ativa) => {
            if (!ativa) return;
            setBloqueado(true);
            void desbloquear();
          });
        }
      }).then((h) => { appHandle = h; });
    }

    return () => {
      vivo = false;
      limparRede?.();
      void appHandle?.remove();
    };
  }, [desbloquear]);

  return (
    <>
      {!online && (
        <div className="offline-banner" role="status">
          Sem internet. Algumas acoes ficam indisponiveis ate a conexao voltar.
        </div>
      )}
      {children}
      {bloqueado && (
        <div className="native-lock" role="dialog" aria-modal="true" aria-label="ImobiBoard bloqueado">
          <div className="native-lock-card">
            <ImobiBoardMark size={42} />
            <h1>ImobiBoard bloqueado</h1>
            <p>Use a biometria ou o bloqueio do aparelho para continuar.</p>
            {erro && <div className="alert err">{erro}</div>}
            <button
              className="btn primary wide"
              disabled={autenticando}
              onClick={() => void desbloquear()}
            >
              {autenticando ? "Verificando..." : "Desbloquear"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
