import { rpc, type Env } from "./db";

interface PushDevice {
  token: string;
  platform: "android" | "ios";
  user_id: string;
}

interface PushPayload {
  tenant_id: string;
  opportunity_id: string;
  title: string;
  body: string;
  url: string;
  devices: PushDevice[];
}

const enc = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemPkcs8(pem: string): ArrayBuffer {
  const normalizado = pem.replace(/\\n/g, "\n");
  const base64 = normalizado
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
let fcmCache: { token: string; ate: number } | null = null;

async function tokenFcm(env: Env): Promise<string | null> {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return null;
  }
  if (fcmCache && fcmCache.ate > Date.now() + 60_000) return fcmCache.token;

  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  }));
  const entrada = cab + "." + corpo;
  const chave = await crypto.subtle.importKey(
    "pkcs8", pemPkcs8(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const assinatura = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", chave, enc.encode(entrada)
  ));
  const assertion = entrada + "." + b64url(assinatura);

  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resposta.ok) {
    console.error(JSON.stringify({
      evento: "push.fcm_oauth_falhou", status: resposta.status,
    }));
    return null;
  }
  const j = await resposta.json() as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  fcmCache = {
    token: j.access_token,
    ate: Date.now() + Math.max((j.expires_in ?? 3600) - 120, 60) * 1000,
  };
  return fcmCache.token;
}

async function enviarAndroid(env: Env, d: PushDevice, p: PushPayload): Promise<boolean> {
  const acesso = await tokenFcm(env);
  if (!acesso || !env.FIREBASE_PROJECT_ID) return false;

  const resposta = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + acesso,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: d.token,
          notification: { title: p.title, body: p.body },
          data: {
            opportunity_id: p.opportunity_id,
            tenant_id: p.tenant_id,
            url: p.url,
          },
          android: { priority: "high" },
        },
      }),
    }
  );
  if (!resposta.ok) {
    const texto = await resposta.text();
    console.warn(JSON.stringify({
      evento: "push.android_falhou",
      status: resposta.status,
      reason: texto.includes("UNREGISTERED") ? "unregistered" : "provider_error",
    }));
    return false;
  }
  return true;
}

let apnsCache: { token: string; ate: number } | null = null;

async function tokenApns(env: Env): Promise<string | null> {
  if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY) return null;
  if (apnsCache && apnsCache.ate > Date.now() + 60_000) return apnsCache.token;

  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const corpo = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: agora }));
  const entrada = cab + "." + corpo;
  const chave = await crypto.subtle.importKey(
    "pkcs8", pemPkcs8(env.APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const assinatura = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, chave, enc.encode(entrada)
  ));
  apnsCache = { token: entrada + "." + b64url(assinatura), ate: Date.now() + 50 * 60_000 };
  return apnsCache.token;
}
async function enviarIos(env: Env, d: PushDevice, p: PushPayload): Promise<boolean> {
  const jwt = await tokenApns(env);
  const topic = env.APNS_BUNDLE_ID;
  if (!jwt || !topic) return false;

  const host = env.APNS_SANDBOX === "true"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const resposta = await fetch(host + "/3/device/" + encodeURIComponent(d.token), {
    method: "POST",
    headers: {
      authorization: "bearer " + jwt,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: p.title, body: p.body },
        sound: "default",
      },
      opportunity_id: p.opportunity_id,
      tenant_id: p.tenant_id,
      url: p.url,
    }),
  });
  if (!resposta.ok) {
    const detalhe = await resposta.text();
    console.warn(JSON.stringify({
      evento: "push.ios_falhou", status: resposta.status,
      reason: detalhe.slice(0, 120),
    }));
    return false;
  }
  return true;
}
export async function enviarPushNovoLead(env: Env, opportunityId: string): Promise<void> {
  let p: PushPayload;
  try {
    p = await rpc<PushPayload>(env, "push_payload_novo_lead", {
      p_opportunity_id: opportunityId,
    });
  } catch (e) {
    console.warn(JSON.stringify({
      evento: "push.payload_falhou",
      opportunity_id: opportunityId,
      erro: e instanceof Error ? e.message : String(e),
    }));
    return;
  }

  if (!Array.isArray(p.devices) || p.devices.length === 0) return;

  const resultados = await Promise.allSettled(p.devices.map((d) => {
    if (d.platform === "android") return enviarAndroid(env, d, p);
    if (d.platform === "ios") return enviarIos(env, d, p);
    return Promise.resolve(false);
  }));

  const enviados = resultados.filter((r) => r.status === "fulfilled" && r.value).length;
  console.log(JSON.stringify({
    evento: "push.novo_lead",
    opportunity_id: opportunityId,
    destinos: p.devices.length,
    enviados,
  }));
}
