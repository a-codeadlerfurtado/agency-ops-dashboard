import { useEffect, useRef, useState } from "react";
import { App as NativeApp } from "@capacitor/app";
import { autenticarBiometria, biometriaAtiva, ehNativo } from "./lib/native";

export default function MobileAppLock({ children }: { children: React.ReactNode }) {
  const [bloqueado, setBloqueado] = useState(() => ehNativo());
  const [erro, setErro] = useState("");
  const precisaDesbloquear = useRef(false);
  const autenticando = useRef(false);

  async function desbloquear() {
    if (!ehNativo() || autenticando.current) return;
    autenticando.current = true;
    setErro("");
    try {
      const ativa = await biometriaAtiva();
      if (!ativa) {
        setBloqueado(false);
        precisaDesbloquear.current = false;
        return;
      }
      setBloqueado(true);
      await autenticarBiometria();
      setBloqueado(false);
      precisaDesbloquear.current = false;
    } catch (e) {
      setBloqueado(true);
      setErro(e instanceof Error ? e.message : "Nao foi possivel confirmar sua identidade.");
    } finally {
      autenticando.current = false;
    }
  }
  useEffect(() => {
    if (!ehNativo()) return;
    let vivo = true;
    let remove: (() => Promise<void>) | null = null;

    void biometriaAtiva().then((ativa) => {
      if (!vivo) return;
      if (!ativa) {
        setBloqueado(false);
        return;
      }
      precisaDesbloquear.current = true;
      void desbloquear();
    });

    void NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        precisaDesbloquear.current = true;
        return;
      }
      if (precisaDesbloquear.current) void desbloquear();
    }).then((h) => {
      remove = () => h.remove();
    });

    return () => {
      vivo = false;
      if (remove) void remove();
    };
  }, []);

  if (!ehNativo() || !bloqueado) return <>{children}</>;

  return (
    <div className="native-lock" role="dialog" aria-modal="true" aria-label="ImobiBoard bloqueado">
      <div className="native-lock-card">
        <div className="eyebrow">ImobiBoard protegido</div>
        <h2>Confirme sua identidade</h2>
        <p>Use a biometria ou a credencial segura do aparelho para continuar.</p>
        <button className="btn wide" type="button" onClick={() => void desbloquear()}>
          Desbloquear
        </button>
        {erro && <div className="hint" style={{ color: "var(--danger)" }}>{erro}</div>}
      </div>
    </div>
  );
}
