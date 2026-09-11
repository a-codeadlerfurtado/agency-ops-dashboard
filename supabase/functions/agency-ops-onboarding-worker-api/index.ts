import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN_SHA256 = "856985480bfa2b9125b7fa82b92602295920f76cc1b595e51a441dbbb16a13ad";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const token = req.headers.get("x-agency-worker-token") ?? "";
  if (!token || token.length < 32) return false;
  return (await sha256Hex(token)) === TOKEN_SHA256;
}

function client(schema: string) {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    db: { schema },
  });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": SERVICE_ROLE_KEY,
      "authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "accept-profile": "agency_ops",
      "content-profile": "agency_ops",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`rpc_${name}_${res.status}:${typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function getControl() {
  const sb = client("agency_ops");
  const { data, error } = await sb.from("worker_runtime_config").select("value").eq("key", "onboarding_consolidated").single();
  if (error) throw error;
  const value = (data?.value ?? {}) as Record<string, unknown>;
  const mode = ["off", "shadow", "execute"].includes(String(value.mode)) ? String(value.mode) : "off";
  const interval_ms = Math.max(300000, Math.min(Number(value.interval_ms ?? 900000), 3600000));
  return { mode, interval_ms };
}

async function buildSnapshot() {
  const control = await getControl();
  const ops = client("agency_ops");
  const [{ data: registry, error: regErr }, { data: cases, error: caseErr }, { data: identities, error: identErr }] = await Promise.all([
    ops.from("whatsapp_chat_registry").select("chat_id,chat_name,first_seen_at,last_seen_at,scope,reason,client_id").is("client_id", null).not("scope", "in", "(INTERNAL,TEST)"),
    ops.from("onboarding_cases").select("*").eq("status", "OPEN"),
    ops.from("whatsapp_team_identities").select("identity_type,identity_value").eq("active", true),
  ]);
  if (regErr) throw regErr;
  if (caseErr) throw caseErr;
  if (identErr) throw identErr;

  const unassignedChatIds = (registry ?? []).map((r: any) => String(r.chat_id)).filter(Boolean);
  const clientIds = [...new Set((cases ?? []).map((c: any) => String(c.client_id)).filter(Boolean))];
  const caseIds = (cases ?? []).map((c: any) => Number(c.id)).filter(Number.isFinite);

  const unassignedMessagesPromise = unassignedChatIds.length
    ? ops.from("whatsapp_messages").select("id,message_id,chat_id,event_at,received_at,text_body,caption,raw_json,sender_phone,sender_name,from_me").in("chat_id", unassignedChatIds)
    : Promise.resolve({ data: [], error: null } as any);
  const clientsPromise = clientIds.length
    ? ops.from("clients").select("id,display_name,lifecycle").in("id", clientIds)
    : Promise.resolve({ data: [], error: null } as any);
  const integrationsPromise = clientIds.length
    ? ops.from("client_integrations").select("client_id,system,external_id,external_name,metadata").eq("system", "WHATSAPP_GROUP").in("client_id", clientIds)
    : Promise.resolve({ data: [], error: null } as any);
  const stagesPromise = caseIds.length
    ? ops.from("onboarding_stages").select("*").in("case_id", caseIds)
    : Promise.resolve({ data: [], error: null } as any);
  const meetLinksPromise = caseIds.length
    ? ops.from("onboarding_stage_meet_links").select("case_id,stage_code,url,source,source_id,is_current,occurred_at,scheduled_for").in("case_id", caseIds)
    : Promise.resolve({ data: [], error: null } as any);
  const notionPromise = clientIds.length
    ? ops.from("notion_briefing_pages").select("client_id,notion_page_id,content_markdown,extracted_profile,notion_last_edited_at,updated_at").in("client_id", clientIds)
    : Promise.resolve({ data: [], error: null } as any);

  const [unassignedMessagesRes, clientsRes, integrationsRes, stagesRes, meetLinksRes, notionRes] = await Promise.all([
    unassignedMessagesPromise, clientsPromise, integrationsPromise, stagesPromise, meetLinksPromise, notionPromise,
  ]);
  for (const x of [unassignedMessagesRes, clientsRes, integrationsRes, stagesRes, meetLinksRes, notionRes]) if (x.error) throw x.error;

  const caseChatIds = [...new Set((integrationsRes.data ?? []).map((r: any) => String(r.external_id)).filter(Boolean))];
  const caseMessagesRes = caseChatIds.length
    ? await ops.from("whatsapp_messages").select("id,message_id,chat_id,event_at,received_at,text_body,caption,sender_phone,sender_name,from_me").in("chat_id", caseChatIds)
    : { data: [], error: null } as any;
  if (caseMessagesRes.error) throw caseMessagesRes.error;

  const cleanUnassignedMessages = (unassignedMessagesRes.data ?? []).map((m: any) => ({
    id: m.id, message_id: m.message_id, chat_id: m.chat_id, event_at: m.event_at, received_at: m.received_at,
    text_body: m.text_body, caption: m.caption, sender_phone: m.sender_phone, sender_name: m.sender_name, from_me: m.from_me,
    origin: m.raw_json?.origem ?? null,
  }));

  return {
    ok: true,
    snapshot_at: new Date().toISOString(),
    control,
    unassigned_chats: registry ?? [],
    unassigned_messages: cleanUnassignedMessages,
    open_cases: cases ?? [],
    clients: clientsRes.data ?? [],
    integrations: integrationsRes.data ?? [],
    stages: stagesRes.data ?? [],
    meet_links: meetLinksRes.data ?? [],
    notion_pages: notionRes.data ?? [],
    case_messages: caseMessagesRes.data ?? [],
    team_identities: identities ?? [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "agency-ops-onboarding-worker-api", version: 1 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: "server_not_configured" }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "").toLowerCase();
    const worker = String(body.worker ?? "").trim().slice(0, 120);
    if (!worker) return json({ error: "worker_required" }, 400);

    if (action === "snapshot") return json(await buildSnapshot());

    if (action === "apply_sync") {
      const control = await getControl();
      if (control.mode !== "execute") return json({ error: "onboarding_not_in_execute_mode", mode: control.mode }, 409);
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      return json({ ok: true, result: await rpc("apply_onboarding_worker_sync", { p_items: items }) });
    }

    if (action === "apply_evidence") {
      const control = await getControl();
      if (control.mode !== "execute") return json({ error: "onboarding_not_in_execute_mode", mode: control.mode }, 409);
      const snapshotAt = new Date(String(body.snapshot_at ?? ""));
      if (Number.isNaN(snapshotAt.getTime()) || Date.now() - snapshotAt.getTime() > 180000) return json({ error: "stale_snapshot" }, 409);
      const actions = Array.isArray(body.actions) ? body.actions.slice(0, 1000) : [];
      const meetLinks = Array.isArray(body.meet_links) ? body.meet_links.slice(0, 300) : [];
      const forms = Array.isArray(body.forms) ? body.forms.slice(0, 100) : [];
      const caseIds = Array.isArray(body.case_ids) ? body.case_ids.slice(0, 200) : [];
      return json({ ok: true, result: await rpc("apply_onboarding_worker_evidence", {
        p_actions: actions, p_meet_links: meetLinks, p_forms: forms, p_case_ids: caseIds,
      }) });
    }

    if (action === "report") {
      const ops = client("agency_ops");
      const { error } = await ops.from("worker_runs").insert({
        worker,
        task: "consolidated_whatsapp_onboarding",
        mode: String(body.mode ?? "unknown").slice(0, 20),
        status: String(body.status ?? "ok").slice(0, 20),
        started_at: body.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        result: body.result ?? {},
        error: body.error ? String(body.error).slice(0, 4000) : null,
      });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "invalid_action" }, 400);
  } catch (error) {
    console.error("onboarding_worker_api_error", error);
    return json({ error: "worker_api_failed", detail: String((error as Error)?.message ?? error).slice(0, 900) }, 500);
  }
});
