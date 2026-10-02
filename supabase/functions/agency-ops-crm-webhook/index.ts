import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

function clean(value: unknown, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}
function nullable(value: unknown, max = 500) {
  const s = clean(value, max);
  return s ? s : null;
}
function norm(value: unknown) {
  return clean(value, 500)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}
function canonicalStage(status: unknown) {
  const s = norm(status);
  if (!s) return "UNKNOWN";
  if (/(venda ganha|ganho|vendid|negocio fechado|venda fechada)/.test(s)) return "WON";
  if (/(perdid|descartad|sem interesse|cancelad|desist)/.test(s)) return "LOST";
  if (/(proposta|negociacao|oferta)/.test(s)) return "PROPOSAL";
  if (/(visita realizada|visita concluida|fez a visita|visitou)/.test(s)) return "VISIT_COMPLETED";
  if (/(visita agendada|visita marcada|agendamento.*visita|agendad)/.test(s)) return "VISIT_SCHEDULED";
  if (/(qualificad|mql|lead quente)/.test(s)) return "QUALIFIED";
  if (/(em atendimento|contatad|contato realizado|respondeu|respondido|atendeu)/.test(s)) return "CONTACTED";
  if (/(novo|novo lead|entrada)/.test(s)) return "NEW";
  return "UNKNOWN";
}
function isoOrNull(value: unknown) {
  const s = clean(value, 100);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function phone(value: unknown) {
  const s = clean(value, 80);
  if (!s) return null;
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/\D/g, "");
  return digits ? plus + digits : null;
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseImobilead(body: Row) {
  const user = body.user && typeof body.user === "object" ? body.user : {};
  const externalStatus = nullable(body.status ?? body.pipelineStatus, 200);
  const leadId = nullable(body.leadId ?? body.id, 200);
  const occurredAt = isoOrNull(body.nova_data ?? body.updated_at ?? body.created_at);
  return {
    external_event_id: nullable(body.eventId ?? body.statusId ?? body.pipelineStatusId, 240),
    external_lead_id: leadId,
    event_type: externalStatus ? "STATUS_CHANGED" : "LEAD_EVENT",
    external_status: externalStatus,
    canonical_stage: canonicalStage(externalStatus),
    lead_name: nullable(body.nome ?? body.name, 300),
    lead_email: nullable(body.email, 320),
    lead_phone: phone(body.telefone ?? body.phone),
    product: nullable(body.produto ?? body.product, 500),
    broker_name: nullable(user.nome ?? user.name, 300),
    broker_email: nullable(user.email, 320),
    broker_phone: phone(user.whatsapp ?? user.phone),
    occurred_at: occurredAt,
  };
}

function parseGeneric(body: Row) {
  const user = body.user ?? body.corretor ?? body.broker ?? body.responsavel ?? {};
  const lead = body.lead ?? body.contato ?? body.contact ?? body;
  const externalStatus = nullable(body.status ?? body.stage ?? body.etapa ?? lead.status ?? lead.stage, 200);
  return {
    external_event_id: nullable(body.event_id ?? body.eventId ?? body.id_evento ?? body.status_id, 240),
    external_lead_id: nullable(body.lead_id ?? body.leadId ?? lead.id ?? lead.uuid ?? body.id, 240),
    event_type: externalStatus ? "STATUS_CHANGED" : "LEAD_EVENT",
    external_status: externalStatus,
    canonical_stage: canonicalStage(externalStatus),
    lead_name: nullable(lead.nome ?? lead.name, 300),
    lead_email: nullable(lead.email, 320),
    lead_phone: phone(lead.telefone ?? lead.phone ?? lead.whatsapp),
    product: nullable(body.produto ?? body.product ?? body.imovel ?? lead.produto, 500),
    broker_name: nullable(user.nome ?? user.name, 300),
    broker_email: nullable(user.email, 320),
    broker_phone: phone(user.whatsapp ?? user.phone ?? user.telefone),
    occurred_at: isoOrNull(body.occurred_at ?? body.updated_at ?? body.created_at ?? body.data),
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return json({ ok: true, service: "agency-ops-crm-webhook", v: 1 });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: "server_configuration_missing" }, 503);

  const parts = url.pathname.split("/").filter(Boolean);
  const slugAt = parts.lastIndexOf("agency-ops-crm-webhook");
  const connectionId = clean(slugAt >= 0 ? parts[slugAt + 1] : "", 80);
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return json({ ok: false, error: "invalid_connection_id" }, 400);

  const token = clean(
    req.headers.get("x-crm-webhook-token")
      || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
      || url.searchParams.get("token"),
    500,
  );
  if (!token) return json({ ok: false, error: "missing_token" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: connection, error: connectionError } = await db.schema("agency_ops")
    .from("external_crm_connections")
    .select("id,client_id,provider,status,webhook_token_hash")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError || !connection) return json({ ok: false, error: "connection_not_found" }, 404);
  if (!["READY", "ACTIVE"].includes(String(connection.status))) return json({ ok: false, error: "connection_not_ready" }, 409);
  const givenHash = await sha256(token);
  if (!connection.webhook_token_hash || !safeEqual(givenHash, String(connection.webhook_token_hash))) {
    return json({ ok: false, error: "invalid_token" }, 401);
  }

  let body: Row;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const provider = String(connection.provider || "").toUpperCase();
  const parsed = provider === "IMOBILEAD" ? parseImobilead(body) : parseGeneric(body);
  if (url.searchParams.get("dry_run") === "1") {
    return json({
      ok: true,
      dry_run: true,
      provider,
      external_lead_id: parsed.external_lead_id,
      external_status: parsed.external_status,
      stage: parsed.canonical_stage,
    });
  }
  const fingerprint = [
    connection.id, provider, parsed.external_lead_id || "",
    parsed.external_status || "", parsed.occurred_at || "",
    parsed.external_event_id || "", parsed.event_type,
  ].join("|");
  const dedupKey = await sha256(fingerprint);

  const payload = {
    connection_id: connection.id,
    client_id: connection.client_id,
    provider,
    ...parsed,
    source: "CRM_WEBHOOK",
    dedup_key: dedupKey,
    payload: body,
  };
  const { error: eventError } = await db.schema("agency_ops")
    .from("external_crm_events")
    .upsert(payload, { onConflict: "dedup_key", ignoreDuplicates: true });
  if (eventError) {
    await db.schema("agency_ops").from("external_crm_connections")
      .update({ status: "ERROR", last_error: eventError.message.slice(0, 900), updated_at: new Date().toISOString() })
      .eq("id", connection.id);
    return json({ ok: false, error: "event_persist_failed" }, 500);
  }

  const now = new Date().toISOString();
  await db.schema("agency_ops").from("external_crm_connections")
    .update({ status: "ACTIVE", last_event_at: now, last_sync_at: now, last_error: null, updated_at: now })
    .eq("id", connection.id);

  return json({
    ok: true,
    duplicate_safe: true,
    provider,
    external_lead_id: parsed.external_lead_id,
    stage: parsed.canonical_stage,
  });
});
