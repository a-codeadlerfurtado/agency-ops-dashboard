import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { Browser } from "@capacitor/browser";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Network } from "@capacitor/network";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import { PushNotifications, type Token } from "@capacitor/push-notifications";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { supabase } from "./supabase";
import type { Sessao } from "./types";

const BIOMETRIA_KEY = "imobiboard:biometria";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ehNativo = () => Capacitor.isNativePlatform();

function oportunidadeDaUrl(url: string): string | null {
  try {
    const normalizada = url.replace(/^imobiboard:\/\//i, "https://imobiboard.local/");
    const u = new URL(normalizada);
    const partes = u.pathname.split("/").filter(Boolean);
    const candidato = partes[0] === "lead" || partes[0] === "leads" ? partes[1] : null;
    return candidato && UUID_RE.test(candidato) ? candidato : null;
  } catch {
    return null;
  }
}
export function navegarUrlExterna(url: string) {
  const opportunityId = oportunidadeDaUrl(url);
  if (!opportunityId) return false;
  // O hash so escolhe a tela. A leitura real ainda passa pela RLS do Supabase,
  // portanto um ID forjado de outro tenant nunca entrega dados.
  location.hash = "/leads/" + opportunityId;
  return true;
}

export async function iniciarCamadaNativa() {
  if (!ehNativo()) return;

  document.documentElement.dataset.native = Capacitor.getPlatform();

  try {
    await StatusBar.setStyle({ style: Style.Light });
    if (Capacitor.getPlatform() === "android") {
      await StatusBar.setBackgroundColor({ color: "#030b14" });
    } else if (Capacitor.getPlatform() === "ios") {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
    }
  } catch {
    // Alguns previews web nao implementam plugins nativos.
  }

  await NativeApp.addListener("appUrlOpen", ({ url }) => {
    navegarUrlExterna(url);
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
    const data = notification.data as Record<string, unknown> | undefined;
    const id = typeof data?.opportunity_id === "string" ? data.opportunity_id : "";
    if (UUID_RE.test(id)) location.hash = "/leads/" + id;
    else if (typeof data?.url === "string") navegarUrlExterna(data.url);
  });
}

export async function abrirWhatsapp(url: string) {
  if (!ehNativo()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  try {
    const u = new URL(url);
    const telefone = u.pathname.replace(/\D/g, "");
    const texto = u.searchParams.get("text");
    const esquema = `whatsapp://send?phone=${telefone}${texto ? `&text=${encodeURIComponent(texto)}` : ""}`;
    const abriu = await AppLauncher.openUrl({ url: esquema });
    if (abriu.completed) return;
  } catch {
    // Se o WhatsApp nao estiver instalado, cai no link web oficial abaixo.
  }
  await Browser.open({ url });
}

export async function compartilharLead(nome: string, url?: string) {
  if (!ehNativo()) {
    if (navigator.share) await navigator.share({ title: nome, text: nome, url });
    return;
  }
  await Share.share({ title: nome, text: nome, url, dialogTitle: "Compartilhar" });
}
export async function escolherImagemDaCamera() {
  if (!ehNativo()) return null;
  const foto = await Camera.getPhoto({
    quality: 88,
    allowEditing: false,
    resultType: CameraResultType.Uri,
    source: CameraSource.Prompt,
    correctOrientation: true,
  });
  return foto.webPath ?? foto.path ?? null;
}

export async function impactoLeve() {
  if (!ehNativo()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Feedback tatil e melhoria, nunca bloqueia a acao principal.
  }
}

export async function biometriaDisponivel() {
  if (!ehNativo()) return false;
  try {
    const r = await BiometricAuth.checkBiometry();
    return r.isAvailable && r.deviceIsSecure;
  } catch {
    return false;
  }
}

export async function biometriaAtiva() {
  if (!ehNativo()) return false;
  return (await Preferences.get({ key: BIOMETRIA_KEY })).value === "1";
}

export async function definirBiometria(ativa: boolean) {
  if (!ehNativo()) return;
  if (ativa) {
    const disponivel = await biometriaDisponivel();
    if (!disponivel) throw new Error("Biometria nao esta configurada neste aparelho.");
    await autenticarBiometria();
  }
  await Preferences.set({ key: BIOMETRIA_KEY, value: ativa ? "1" : "0" });
}

export async function autenticarBiometria() {
  if (!ehNativo()) return;
  await BiometricAuth.authenticate({
    reason: "Desbloquear o ImobiBoard",
    cancelTitle: "Cancelar",
    allowDeviceCredential: true,
    androidTitle: "ImobiBoard",
    androidSubtitle: "Confirme sua identidade para continuar",
  });
}
export async function statusDaRede() {
  if (!ehNativo()) return { connected: navigator.onLine };
  return Network.getStatus();
}

export async function observarRede(cb: (conectado: boolean) => void) {
  if (!ehNativo()) {
    const online = () => cb(true);
    const offline = () => cb(false);
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
    };
  }
  const handle = await Network.addListener("networkStatusChange", (s) => cb(s.connected));
  return () => { void handle.remove(); };
}

let pushInicializadoPara: string | null = null;

async function salvarPushToken(token: Token, sessao: Sessao) {
  const info = await NativeApp.getInfo().catch(() => null);
  const { error } = await supabase.rpc("registrar_dispositivo_mobile", {
    p_token: token.value,
    p_plataforma: Capacitor.getPlatform(),
    p_tenant: sessao.tenant.id,
    p_app_version: info?.version ?? null,
    p_device_label: null,
  });
  if (error) {
    console.warn("push.registration_failed", { code: error.code });
  }
}

async function iniciarRegistroPush(sessao: Sessao, solicitarPermissao: boolean) {
  // A conta Master recebe memberships internas em todos os tenants. Ela nao
  // deve virar assinante de push de clientes so por entrar em modo suporte.
  if (!ehNativo() || sessao.modoMestre) return false;

  const permissao = solicitarPermissao
    ? await PushNotifications.requestPermissions()
    : await PushNotifications.checkPermissions();
  if (permissao.receive !== "granted") return false;

  const chave = sessao.userId + ":" + sessao.tenant.id;
  if (pushInicializadoPara === chave) return true;

  await PushNotifications.addListener("registration", (token) => {
    void salvarPushToken(token, sessao);
  });
  await PushNotifications.addListener("registrationError", (erro) => {
    console.warn("push.registration_error", { message: String(erro.error ?? "unknown") });
  });
  await PushNotifications.register();
  pushInicializadoPara = chave;
  return true;
}

/** Restaura push ja autorizado sem abrir prompt durante o login. */
export async function registrarPush(sessao: Sessao) {
  return iniciarRegistroPush(sessao, false);
}

/** Deve ser chamado somente apos acao explicita do usuario. */
export async function ativarPush(sessao: Sessao) {
  return iniciarRegistroPush(sessao, true);
}
