import { json } from "./ingest";

const GRAPH = "https://graph.facebook.com/v26.0";

export interface EnvImobiaMetaBroker {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  IMOBIA_BROKER_TOKEN?: string;
}

function comparacaoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export async function trocarCodigoImobia(req: Request, env: EnvImobiaMetaBroker): Promise<Response> {
  if (req.method !== "POST") return json({ erro: "Metodo nao permitido." }, 405);
  if (!env.IMOBIA_BROKER_TOKEN) return json({ erro: "Broker nao configurado." }, 503);
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !comparacaoConstante(auth.slice(7), env.IMOBIA_BROKER_TOKEN)) {
    return json({ erro: "Nao autorizado." }, 401);
  }
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    return json({ erro: "Meta nao configurada no broker." }, 503);
  }

  let body: { code?: string };
  try { body = await req.json() as { code?: string }; }
  catch { return json({ erro: "JSON invalido." }, 400); }
  const code = String(body.code ?? "").trim();
  if (code.length < 8 || code.length > 4096) return json({ erro: "Codigo invalido." }, 400);

  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("client_secret", env.META_APP_SECRET);
  url.searchParams.set("code", code);
  const r = await fetch(url);
  const payload = await r.json() as Record<string, unknown>;
  if (!r.ok || typeof payload.access_token !== "string") {
    return json({ erro: "A Meta recusou o codigo de autorizacao.", status_meta: r.status }, 400);
  }

  return json({
    access_token: payload.access_token,
    token_type: payload.token_type,
    expires_in: payload.expires_in,
  });
}
