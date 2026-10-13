"use client";

import { useState } from "react";
import {
  MOTION_BACKGROUNDS,
  readMotionBackground,
  writeMotionBackground,
  type MotionBackground,
} from "./motion-live-preferences";

// Controle "Fundo animado" das Configuracoes do perfil. A troca vale na hora,
// para a pessoa ver o resultado atras do modal antes de fechar.
export default function MotionBackgroundSetting() {
  const [value, setValue] = useState<MotionBackground>(() =>
    typeof window === "undefined" ? "leve" : readMotionBackground(),
  );

  const choose = (next: MotionBackground) => {
    setValue(next);
    writeMotionBackground(next);
  };

  return (
    <div className="motion-pref">
      <span>Fundo animado</span>
      <div className="motion-seg" role="group" aria-label="Intensidade do fundo animado">
        {MOTION_BACKGROUNDS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "on" : ""}
            aria-pressed={value === option.value}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <small>Vale para todas as abas, neste navegador. Desligar "Animações" desliga o fundo também.</small>
    </div>
  );
}
