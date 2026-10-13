// Preferencias da camada Motion Live (movimento + fundo animado).
//
// "Animacoes" ja e uma preferencia do perfil (user_preferences.animations_enabled),
// salva pelo backend. O espelho em localStorage existe porque so a home carrega as
// preferencias: as outras paginas (Campanhas, Onboarding, Financeiro...) precisam
// saber o valor sem refazer a consulta.
//
// A intensidade do fundo fica so neste navegador por enquanto. Levar para o perfil
// exige coluna nova em user_preferences e ajuste nas duas edge functions.

export type MotionBackground = "off" | "leve" | "medio" | "forte";

export const MOTION_EVENT = "agency-ops:motion-change";
const BACKGROUND_KEY = "agency-ops:motion-background";
const ANIMATIONS_KEY = "agency-ops:animations-enabled";
const DEFAULT_BACKGROUND: MotionBackground = "leve";

export const MOTION_BACKGROUNDS: { value: MotionBackground; label: string }[] = [
  { value: "off", label: "Desligado" },
  { value: "leve", label: "Leve" },
  { value: "medio", label: "Médio" },
  { value: "forte", label: "Forte" },
];

// Navegador sem storage (modo restrito): a escolha vale ate recarregar.
let memoryBackground: MotionBackground | null = null;
let memoryAnimations: boolean | null = null;

function isBackground(value: unknown): value is MotionBackground {
  return value === "off" || value === "leve" || value === "medio" || value === "forte";
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MOTION_EVENT));
}

export function readMotionBackground(): MotionBackground {
  try {
    const saved = window.localStorage.getItem(BACKGROUND_KEY);
    return isBackground(saved) ? saved : memoryBackground ?? DEFAULT_BACKGROUND;
  } catch {
    return memoryBackground ?? DEFAULT_BACKGROUND;
  }
}

export function writeMotionBackground(value: MotionBackground) {
  memoryBackground = value;
  try {
    window.localStorage.setItem(BACKGROUND_KEY, value);
  } catch {
    // Sem storage fica so em memoria; a tela continua funcionando.
  }
  notify();
}

export function readAnimationsEnabled(): boolean {
  try {
    const saved = window.localStorage.getItem(ANIMATIONS_KEY);
    if (saved === "0" || saved === "1") return saved === "1";
    return memoryAnimations ?? true;
  } catch {
    return memoryAnimations ?? true;
  }
}

// Chamado quando as preferencias do perfil chegam do backend ou sao salvas.
export function syncAnimationsEnabled(enabled: boolean) {
  const changed = memoryAnimations !== enabled;
  memoryAnimations = enabled;
  try {
    if (window.localStorage.getItem(ANIMATIONS_KEY) === (enabled ? "1" : "0")) return;
    window.localStorage.setItem(ANIMATIONS_KEY, enabled ? "1" : "0");
  } catch {
    // Sem storage: so avisa quando o valor em memoria mudou de fato.
    if (!changed) return;
  }
  notify();
}
