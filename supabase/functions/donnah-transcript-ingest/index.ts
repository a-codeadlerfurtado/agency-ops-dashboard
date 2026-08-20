import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// A funcao e' um involucro fino: autentica, normaliza o payload e delega a
// deduplicacao para agency_ops.ingest_meeting_transcript. A logica vive no banco
// para que o backfill e o fluxo continuo usem exatamente as mesmas regras - duas
// implementacoes divergiriam na primeira mudanca.

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-donnah-secret", "access-control-allow-methods": "POST,OPTIONS" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return reply({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const { data: secret, error: secretError } = await ops.rpc("get_donnah_ingest_secret");
  if (secretError || !secret) return reply({ error: "ingest_secret_unavailable" }, 500);
  const supplied = req.headers.get("x-donnah-secret") ?? "";
  if (!supplied || !safeEqual(String(secret), supplied)) return reply({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return reply({ error: "invalid_json" }, 400);

  // Aceita tanto um objeto quanto um array, para o backfill poder mandar em lote.
  const lote = Array.isArray(body) ? body : [body];
  if (lote.length > 50) return reply({ error: "batch_too_large", max: 50 }, 400);

  const resultados = [];
  for (const item of lote) {
    const { data, error } = await ops.rpc("ingest_meeting_transcript", { p: item });
    if (error) return reply({ error: "database_ingest_failed", detail: error.message }, 500);
    if (data && data.ok === false) return reply({ ...data, status: 400 }, 400);
    resultados.push(data);
  }

  const ultimo = resultados[resultados.length - 1] ?? {};
  const { data: setting } = await ops.from("automation_settings").select("value").eq("key", "donnah_transcript_source").maybeSingle();
  const value = {
    ...(setting?.value ?? {}),
    backend_status: "READY",
    drive_raw_auto_ingest: true,
    make_bridge_connected: true,
    last_ingest_at: new Date().toISOString(),
    last_file_name: lote[lote.length - 1]?.file_name ?? null,
    last_meeting_key: ultimo.meeting_key ?? null,
  };
  await ops.from("automation_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", "donnah_transcript_source");

  return Array.isArray(body)
    ? reply({ ok: true, processados: resultados.length, resultados })
    : reply({ ok: true, transcript: ultimo, dedupe_key: ultimo.meeting_key, acao: ultimo.acao });
});
