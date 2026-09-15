import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;

const VERSION = "meeting-capture-v1";
const DASHBOARD_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function corsHeaders(origin: string | null) {
  const allowed = !origin || DASHBOARD_ORIGINS.has(origin) || origin.startsWith("chrome-extension://");
  return {
    allowed,
    headers: {
      "access-control-allow-origin": allowed && origin ? origin : "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
      "access-control-allow-headers": "authorization,apikey,content-type,x-meeting-device-token",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  };
}

function clean(value: unknown, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function randomCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeSegments(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.map((raw: Row, index) => ({
    sequence_no: Number.isFinite(Number(raw?.sequence_no)) ? Number(raw.sequence_no) : index,
    started_ms: Number.isFinite(Number(raw?.started_ms)) ? Math.max(0, Math.round(Number(raw.started_ms))) : null,
    ended_ms: Number.isFinite(Number(raw?.ended_ms)) ? Math.max(0, Math.round(Number(raw.ended_ms))) : null,
    speaker_key: clean(raw?.speaker_key, 180) || null,
    speaker_name: clean(raw?.speaker_name, 160) || "Participante",
    device_id: clean(raw?.device_id || raw?.deviceId, 300) || null,
    message_id: clean(raw?.message_id || raw?.messageId, 300) || null,
    message_version: Number.isFinite(Number(raw?.message_version ?? raw?.messageVersion)) ? Math.round(Number(raw?.message_version ?? raw?.messageVersion)) : null,
    text: clean(raw?.text, 8000),
    confidence: Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : null,
    source: clean(raw?.source, 40) || "MEET_RTC_CAPTIONS",
  })).filter((row) => row.text.length > 0).slice(0, 20000);
}

function buildTranscriptText(segments: ReturnType<typeof normalizeSegments>) {
  return segments.map((segment) => {
    const sec = Math.max(0, Math.floor(Number(segment.started_ms || 0) / 1000));
    const hh = String(Math.floor(sec / 3600)).padStart(2, "0");
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return `[${hh}:${mm}:${ss}] ${segment.speaker_name}: ${segment.text}`;
  }).join("\n\n");
}

async function resolveDashboardPerson(authHeader: string, supabaseUrl: string, anonKey: string, ops: any) {
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.getUser();
  if (error || !data?.user?.id) return null;
  const userKey = data.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED"),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name, 160);
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return null;
  const { data: roster } = await ops.from("team_roster").select("person,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  return roster ? { person, userKey } : null;
}

async function resolveDevice(req: Request, ops: any) {
  const token = clean(req.headers.get("x-meeting-device-token"), 256);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const { data } = await ops.from("meeting_capture_devices")
    .select("id,owner_person,status")
    .eq("token_hash", tokenHash)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (!data) return null;
  await ops.from("meeting_capture_devices").update({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", data.id);
  return data as Row;
}

function normalizePhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function clientSummary(ops: any, clientId: string | null) {
  if (!clientId) return null;
  const { data } = await ops.from("clients")
    .select("id,display_name,lifecycle")
    .eq("id", clientId)
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .maybeSingle();
  return data || null;
}

async function bestWhatsappName(ops: any, phone: string) {
  const { data: identities } = await ops.from("whatsapp_participant_identity")
    .select("canonical_name,role_hint,confidence,last_seen_at")
    .eq("phone", phone)
    .not("canonical_name", "is", null)
    .order("confidence", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(1);
  const row = identities?.[0];
  if (row?.canonical_name) return { name: clean(row.canonical_name, 160), role: clean(row.role_hint, 80) || null };
  const { data: raw } = await ops.from("whatsapp_zapi_raw")
    .select("sender_name,event_at")
    .eq("sender_phone", phone)
    .not("sender_name", "is", null)
    .order("event_at", { ascending: false })
    .limit(1);
  return { name: clean(raw?.[0]?.sender_name, 160) || null, role: null };
}

async function resolveCallIdentity(ops: any, remotePhoneValue: unknown) {
  const phone = normalizePhone(remotePhoneValue);
  if (!phone) return { status: "UNRESOLVED", auto: false, phone: null, name: null, role: null, client_id: null, client_name: null, side: null, source: null };

  const { data: manual } = await ops.from("whatsapp_participant_identity")
    .select("canonical_name,client_id,side,role_hint,confidence,source,updated_at")
    .eq("chat_id", "relato-manual")
    .eq("identity_key", `phone:${phone}`)
    .maybeSingle();
  if (manual) {
    const client = await clientSummary(ops, manual.client_id || null);
    const resolvedName = clean(manual.canonical_name, 160) || (await bestWhatsappName(ops, phone)).name;
    return { status: manual.client_id ? "AUTO_CLIENT" : "AUTO_NON_CLIENT", auto: true, phone, name: resolvedName || null,
      role: clean(manual.role_hint, 80) || null, client_id: client?.id || null, client_name: client?.display_name || null,
      side: manual.side || (manual.client_id ? "CLIENT_SIDE" : "EXTERNAL"), source: "RELATO_MANUAL" };
  }
  const { data: team } = await ops.from("whatsapp_team_identities")
    .select("canonical_name,role")
    .eq("identity_type", "PHONE").eq("identity_value", phone).eq("active", true).maybeSingle();
  if (team) return { status: "AUTO_TEAM", auto: true, phone, name: clean(team.canonical_name, 160) || null,
    role: clean(team.role, 80) || null, client_id: null, client_name: null, side: "TEAM", source: "TEAM_REGISTRY" };

  const { data: teamObserved } = await ops.from("whatsapp_participant_identity")
    .select("canonical_name,role_hint,confidence")
    .eq("phone", phone).eq("side", "TEAM").gte("confidence", 0.9)
    .order("confidence", { ascending: false }).limit(1);
  if (teamObserved?.length) {
    const row = teamObserved[0];
    const fallback = await bestWhatsappName(ops, phone);
    return { status: "AUTO_TEAM", auto: true, phone, name: clean(row.canonical_name, 160) || fallback.name,
      role: clean(row.role_hint, 80) || fallback.role, client_id: null, client_name: null, side: "TEAM", source: "GROUP_TEAM_IDENTITY" };
  }

  const { data: rows } = await ops.from("whatsapp_participant_identity")
    .select("canonical_name,client_id,role_hint,confidence,last_seen_at")
    .eq("phone", phone).eq("side", "CLIENT_SIDE").not("client_id", "is", null).gte("confidence", 0.85)
    .order("confidence", { ascending: false }).order("last_seen_at", { ascending: false }).limit(100);
  const candidateIds = [...new Set((rows || []).map((r: Row) => String(r.client_id || "")).filter(Boolean))];
  const activeClients: Row[] = [];
  for (const id of candidateIds) { const c = await clientSummary(ops, id); if (c) activeClients.push(c); }
  if (activeClients.length === 1) {
    const client = activeClients[0];
    const best = (rows || []).find((r: Row) => String(r.client_id) === String(client.id)) || {};
    const fallback = await bestWhatsappName(ops, phone);
    return { status: "AUTO_CLIENT", auto: true, phone, name: clean(best.canonical_name, 160) || fallback.name,
      role: clean(best.role_hint, 80) || fallback.role || "CLIENT_CONTACT", client_id: client.id, client_name: client.display_name,
      side: "CLIENT_SIDE", source: "GROUP_PARTICIPANT_IDENTITY" };
  }
  if (activeClients.length > 1) {
    const fallback = await bestWhatsappName(ops, phone);
    return { status: "AMBIGUOUS", auto: false, phone, name: fallback.name, role: fallback.role,
      client_id: null, client_name: null, side: "CLIENT_SIDE", source: "MULTIPLE_CLIENTS" };
  }

  const { data: registry } = await ops.from("client_phone_registry")
    .select("client_id,evidence_count,last_seen_at")
    .eq("phone", phone).eq("active", true).order("evidence_count", { ascending: false }).limit(100);
  const registryIds = [...new Set((registry || []).map((r: Row) => String(r.client_id || "")).filter(Boolean))];
  const registryClients: Row[] = [];
  for (const id of registryIds) { const c = await clientSummary(ops, id); if (c) registryClients.push(c); }
  const fallback = await bestWhatsappName(ops, phone);
  if (registryClients.length === 1) return { status: "AUTO_CLIENT", auto: true, phone, name: fallback.name,
    role: fallback.role || "CLIENT_CONTACT", client_id: registryClients[0].id, client_name: registryClients[0].display_name,
    side: "CLIENT_SIDE", source: "CLIENT_PHONE_REGISTRY" };
  return { status: registryClients.length > 1 ? "AMBIGUOUS" : "UNRESOLVED", auto: false, phone,
    name: fallback.name, role: fallback.role, client_id: null, client_name: null, side: null,
    source: registryClients.length > 1 ? "MULTIPLE_CLIENTS" : null };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors.headers, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
  if (!cors.allowed) return respond({ error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  let body: Row;
  try { body = await req.json(); }
  catch { return respond({ error: "invalid_json" }, 400); }
  const action = clean(body?.action, 60).toLowerCase();

  if (action === "pair_create") {
    const identity = await resolveDashboardPerson(req.headers.get("authorization") || "", supabaseUrl, anonKey, ops);
    if (!identity) return respond({ error: "unauthorized" }, 401);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    let code = "";
    let created = false;
    for (let attempt = 0; attempt < 4 && !created; attempt++) {
      code = randomCode();
      const { error } = await ops.from("meeting_capture_pairings").insert({ code, owner_person: identity.person, expires_at: expiresAt });
      created = !error;
    }
    if (!created) return respond({ error: "pairing_create_failed" }, 500);
    return respond({ ok: true, code, expires_at: expiresAt, owner_person: identity.person, version: VERSION });
  }

  if (action === "pair_redeem") {
    const code = clean(body?.code, 16).toUpperCase();
    const deviceName = clean(body?.device_name, 120) || "Chrome";
    const extensionVersion = clean(body?.extension_version, 40) || null;
    if (code.length < 6) return respond({ error: "invalid_pairing_code" }, 400);
    const { data: pairing } = await ops.from("meeting_capture_pairings")
      .select("code,owner_person,expires_at,redeemed_at")
      .eq("code", code)
      .maybeSingle();
    if (!pairing || pairing.redeemed_at || new Date(pairing.expires_at).getTime() < Date.now()) return respond({ error: "pairing_expired_or_invalid" }, 404);
    const rawToken = randomToken();
    const tokenHash = await sha256(rawToken);
    const { data: device, error: deviceError } = await ops.from("meeting_capture_devices")
      .insert({ owner_person: pairing.owner_person, device_name: deviceName, token_hash: tokenHash, extension_version: extensionVersion, last_seen_at: new Date().toISOString() })
      .select("id,owner_person")
      .single();
    if (deviceError || !device) return respond({ error: "device_create_failed" }, 500);
    await ops.from("meeting_capture_pairings").update({ redeemed_at: new Date().toISOString(), device_id: device.id }).eq("code", code).is("redeemed_at", null);
    return respond({ ok: true, device_token: rawToken, device_id: device.id, owner_person: device.owner_person, version: VERSION });
  }

  if (action === "integrations_status") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const [{ data: providers, error: providersError }, { data: accounts, error: accountsError }] = await Promise.all([
      ops.from("meeting_integration_providers")
        .select("provider_key,label,category,auth_mode,capabilities,metadata")
        .eq("enabled", true)
        .order("category")
        .order("label"),
      ops.from("meeting_integration_accounts")
        .select("provider_key,account_slot,account_email,display_name,status,enabled_capabilities,last_sync_at,last_error,metadata")
        .eq("owner_person", device.owner_person),
    ]);
    if (providersError || accountsError) return respond({ error: "integrations_query_failed" }, 500);
    const byProvider = new Map((accounts || []).map((row: Row) => [String(row.provider_key), row]));
    return respond({
      ok: true,
      owner_person: device.owner_person,
      providers: (providers || []).map((provider: Row) => ({
        ...provider,
        connection: byProvider.get(String(provider.provider_key)) || null,
      })),
      version: VERSION,
    });
  }

  if (action === "session_heartbeat") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const raw = (body?.session || {}) as Row;
    const localSessionId = clean(raw.local_session_id || raw.id, 180);
    const startedAt = clean(raw.started_at, 80);
    if (!localSessionId || !Number.isFinite(Date.parse(startedAt))) return respond({ error: "invalid_session_heartbeat" }, 400);
    const requestedState = clean(raw.state, 40).toUpperCase();
    const allowedState = ["CAPTURING","NEEDS_REVIEW","FINISHING"].includes(requestedState) ? requestedState : "CAPTURING";
    const payload = {
      device_id: device.id, owner_person: device.owner_person, local_session_id: localSessionId,
      meeting_code: clean(raw.meeting_code, 80) || null, meeting_url: clean(raw.meeting_url, 1000) || null,
      title: clean(raw.title, 500) || "Reunião Google Meet", started_at: startedAt,
      ended_at: Number.isFinite(Date.parse(clean(raw.ended_at,80))) ? clean(raw.ended_at,80) : null,
      state: allowedState, capture_mode: clean(raw.capture_mode,40) || "MEET_RTC_CAPTIONS",
      native_transcript_available: false, captions_available: Boolean(raw.captions_available),
      metadata: { ...(raw.metadata || {}), extension_version: clean(raw.extension_version,40) || null, heartbeat_at: new Date().toISOString(), last_error: clean(raw.last_error,500) || null },
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await ops.from("meeting_capture_sessions").upsert(payload, { onConflict: "device_id,local_session_id" }).select("id,state,meeting_code,owner_person").single();
    if (error) return respond({ error: "session_heartbeat_failed", detail: error.message }, 500);
    return respond({ ok: true, session: data });
  }

  if (action === "call_prepare") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const call = (body?.call || {}) as Row;
    const localSessionId = clean(call.local_session_id, 180);
    const startedAt = clean(call.started_at, 80);
    const endedAt = clean(call.ended_at, 80);
    const contactName = clean(call.contact_name, 160) || "Contato WhatsApp";
    const localPhone = normalizePhone(call.local_phone);
    const remotePhoneCandidate = normalizePhone(call.remote_phone);
    const identitySource = clean(call.identity_source, 80) || null;
    const source = clean(call.source, 40).toUpperCase() === "WHATSAPP_DESKTOP" ? "WHATSAPP_DESKTOP" : "WHATSAPP_WEB";
    const trustedDesktopIdentity = ["WHATSAPP_LEVELDB_EXACT_CALL_WINDOW", "WHATSAPP_DESKTOP_UI", "RELATO_USER_CONFIRMED"].includes(identitySource || "");
    const remotePhone = source === "WHATSAPP_DESKTOP" && !trustedDesktopIdentity ? null : remotePhoneCandidate;
    const identity = await resolveCallIdentity(ops, remotePhone);
    const resolvedContactName = clean(identity.name, 160) || contactName;
    if (!localSessionId || !startedAt || !endedAt) return respond({ error: "missing_call_data" }, 400);
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) return respond({ error: "invalid_timestamps" }, 400);
    const roles = Array.isArray(body?.roles) ? body.roles.map((v: unknown) => clean(v, 20)).filter((v: string) => ["local", "remote"].includes(v)) : [];
    if (!roles.length) return respond({ error: "audio_roles_required" }, 400);
    const safeLocal = localSessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const ext = clean(call.audio_ext, 12).toLowerCase() === "wav" ? "wav" : "webm";
    const audioPaths: Row = {};
    for (const role of [...new Set(roles)]) audioPaths[role] = `calls/${device.id}/${safeLocal}/${role}.${ext}`;
    const sessionPayload = {
      device_id: device.id, owner_person: device.owner_person, local_session_id: localSessionId,
      meeting_code: null, meeting_url: source === "WHATSAPP_WEB" ? "https://web.whatsapp.com/" : null, title: `Ligação WhatsApp — ${resolvedContactName}`,
      started_at: startedAt, ended_at: endedAt, state: "CAPTURING", capture_mode: source === "WHATSAPP_DESKTOP" ? "WHATSAPP_DESKTOP_AUDIO" : "WHATSAPP_WEB_AUDIO",
      native_transcript_available: false, captions_available: false,
      metadata: { source, contact_name: resolvedContactName, local_phone: localPhone, remote_phone: remotePhone, identity_source: identitySource,
        identity_candidate_rejected: Boolean(remotePhoneCandidate && !remotePhone),
        remote_name: identity.name, remote_role: identity.role, resolved_client_id: identity.client_id, resolved_client_name: identity.client_name,
        identity_resolution: identity, audio_paths: audioPaths, finish_reason: clean(call.finish_reason, 80) || null, extension_version: clean(call.extension_version, 40) || null },
      updated_at: new Date().toISOString(),
    };
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions").upsert(sessionPayload, { onConflict: "device_id,local_session_id" }).select("id").single();
    if (sessionError || !session) return respond({ error: "call_session_upsert_failed", detail: sessionError?.message }, 500);
    const uploads: Row[] = [];
    for (const [role, path] of Object.entries(audioPaths)) {
      const { data, error } = await db.storage.from("relato-call-audio").createSignedUploadUrl(String(path), { upsert: true });
      if (error || !data?.signedUrl) return respond({ error: "call_upload_url_failed", role, detail: error?.message }, 500);
      uploads.push({ role, path, signed_url: data.signedUrl, token: data.token || null });
    }
    return respond({ ok: true, session_id: session.id, owner_person: device.owner_person, uploads });
  }

  if (action === "call_feedback_context") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const localSessionId = clean(body?.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .select("id,metadata").eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError) return respond({ error: "feedback_context_failed", detail: sessionError.message }, 500);
    if (!session) return respond({ ok: true, pending: true });
    const remotePhone = normalizePhone(session.metadata?.remote_phone);
    const identity = session.metadata?.identity_resolution?.auto === true
      ? session.metadata.identity_resolution
      : await resolveCallIdentity(ops, remotePhone);
    const requiresSelection = !Boolean(identity?.auto);
    let clients: Row[] = [];
    if (requiresSelection) {
      const { data, error } = await ops.from("clients").select("id,display_name,lifecycle")
        .in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name");
      if (error) return respond({ error: "feedback_clients_failed", detail: error.message }, 500);
      clients = data || [];
    }
    return respond({ ok: true, pending: false, requires_selection: requiresSelection,
      remote_phone: remotePhone, remote_name: clean(identity?.name || session.metadata?.remote_name, 160) || null,
      remote_role: clean(identity?.role || session.metadata?.remote_role, 80) || null,
      client_id: identity?.client_id || null, client_name: identity?.client_name || null,
      resolution_status: identity?.status || "UNRESOLVED",
      clients: clients.map((c: Row) => ({ id: c.id, name: c.display_name })) });
  }

  if (action === "call_finalize") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const localSessionId = clean(body?.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions").select("id,state,metadata").eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError || !session) return respond({ error: "call_session_not_found" }, 404);
    await ops.from("meeting_capture_sessions").update({ state: "PROCESSING", updated_at: new Date().toISOString() }).eq("id", session.id);
    const { data: jobId, error: jobError } = await ops.rpc("enqueue_heavy_job", {
      p_job_type: "CALL_TRANSCRIBE", p_payload: { session_id: session.id }, p_dedupe_key: `call:${session.id}`, p_max_attempts: 5, p_available_at: new Date().toISOString(),
    });
    if (jobError) return respond({ error: "call_enqueue_failed", detail: jobError.message }, 500);
    return respond({ ok: true, session_id: session.id, job_id: jobId || null, state: "PROCESSING" });
  }

  if (action === "human_feedback_save") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const feedback = (body?.feedback || {}) as Row;
    const localSessionId = clean(feedback.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const { data: session } = await ops.from("meeting_capture_sessions")
      .select("id,transcript_id,owner_person,metadata")
      .eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (!session || String(session.owner_person || "") !== String(device.owner_person || "")) return respond({ error: "feedback_session_not_found" }, 404);
    const dismissed = Boolean(feedback.dismissed);
    const currentIdentity = session.metadata?.identity_resolution?.auto === true
      ? session.metadata.identity_resolution
      : await resolveCallIdentity(ops, session.metadata?.remote_phone);
    let selectedClientId: string | null = null;
    let selectedClientName: string | null = null;
    let bindingSource = "AUTO";
    let noClient = false;

    if (!dismissed && currentIdentity?.auto) {
      selectedClientId = currentIdentity.client_id || null;
      selectedClientName = currentIdentity.client_name || null;
      noClient = !selectedClientId;
    } else if (!dismissed) {
      bindingSource = "MANUAL";
      const requestedClientId = clean(feedback.client_id, 80) || null;
      noClient = Boolean(feedback.no_client);
      if (!requestedClientId && !noClient) return respond({ error: "client_binding_required" }, 400);
      if (requestedClientId) {
        const client = await clientSummary(ops, requestedClientId);
        if (!client) return respond({ error: "invalid_client_binding" }, 400);
        selectedClientId = String(client.id);
        selectedClientName = clean(client.display_name, 160) || null;
        noClient = false;
      }
    }
    const remotePhone = normalizePhone(session.metadata?.remote_phone);
    const remoteName = clean(session.metadata?.remote_name || currentIdentity?.name, 160) || null;
    const remoteRole = clean(session.metadata?.remote_role || currentIdentity?.role, 80) || null;
    if (!dismissed && bindingSource === "MANUAL" && remotePhone) {
      const now = new Date().toISOString();
      const manualIdentity = {
        chat_id: "relato-manual", identity_key: `phone:${remotePhone}`, phone: remotePhone,
        sender_lid: null, canonical_name: remoteName, client_id: selectedClientId,
        side: selectedClientId ? "CLIENT_SIDE" : "EXTERNAL",
        role_hint: selectedClientId ? (remoteRole || "CLIENT_CONTACT") : remoteRole,
        confidence: 1, source: "RELATO_MANUAL_FEEDBACK", first_seen_at: now, last_seen_at: now,
        last_message_id: null,
        metadata: { confirmed_by: device.owner_person, confirmed_at: now, selected_client_name: selectedClientName },
        updated_at: now,
      };
      const { error: identityError } = await ops.from("whatsapp_participant_identity")
        .upsert(manualIdentity, { onConflict: "chat_id,identity_key" });
      if (identityError) return respond({ error: "identity_learning_failed", detail: identityError.message }, 500);
    }

    const resolvedIdentity = dismissed ? currentIdentity : {
      ...(currentIdentity || {}), status: selectedClientId ? "AUTO_CLIENT" : "AUTO_NON_CLIENT", auto: true,
      phone: remotePhone, name: remoteName, role: remoteRole, client_id: selectedClientId,
      client_name: selectedClientName, side: selectedClientId ? "CLIENT_SIDE" : (currentIdentity?.side || "EXTERNAL"),
      source: bindingSource === "MANUAL" ? "RELATO_MANUAL" : (currentIdentity?.source || "AUTO"),
    };
    if (!dismissed) {
      const nextMetadata = { ...(session.metadata || {}),
        remote_name: remoteName, remote_role: remoteRole,
        resolved_client_id: selectedClientId, resolved_client_name: selectedClientName,
        identity_resolution: resolvedIdentity,
        feedback_binding: { source: bindingSource, confirmed_by: device.owner_person, confirmed_at: new Date().toISOString() },
      };
      await ops.from("meeting_capture_sessions").update({ metadata: nextMetadata, updated_at: new Date().toISOString() }).eq("id", session.id);
      session.metadata = nextMetadata;
      if (session.transcript_id) {
        await ops.from("meeting_transcripts").update({
          client_id: selectedClientId, client_name_raw: selectedClientName,
          metadata: { ...(session.metadata || {}), identity_resolution: resolvedIdentity },
          updated_at: new Date().toISOString(),
        }).eq("id", session.transcript_id);
      }
    }

    const asScore = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(5, Math.round(Number(value)))) : null;
    const tags = Array.isArray(feedback.tags) ? feedback.tags.map((v: unknown) => clean(v, 80)).filter(Boolean).slice(0, 12) : [];
    const payload = {
      transcript_id: Number(feedback.transcript_id || session.transcript_id || 0) || null,
      capture_session_id: session.id, local_session_id: localSessionId, owner_person: device.owner_person,
      client_id: selectedClientId,
      channel: clean(feedback.channel, 40) || "MEET", mood: clean(feedback.mood, 60) || null, tone: clean(feedback.tone, 60) || null,
      receptivity: asScore(feedback.receptivity), trust_level: asScore(feedback.trust_level), perceived_risk: asScore(feedback.perceived_risk),
      relationship_direction: ["IMPROVING","STABLE","WORSENING","UNKNOWN"].includes(clean(feedback.relationship_direction, 20).toUpperCase()) ? clean(feedback.relationship_direction, 20).toUpperCase() : "UNKNOWN",
      tags, note: clean(feedback.note, 2000) || null, dismissed,
      submitted_at: dismissed ? null : new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { data, error } = await ops.from("meeting_human_feedback").upsert(payload, { onConflict: "owner_person,local_session_id" }).select("id,transcript_id,client_id,submitted_at,dismissed").single();
    if (error) return respond({ error: "feedback_save_failed", detail: error.message }, 500);
    return respond({ ok: true, feedback: data, binding: { source: bindingSource, client_id: selectedClientId, client_name: selectedClientName, no_client: noClient } });
  }

  if (action === "finalize") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const meeting = (body?.meeting || {}) as Row;
    const localSessionId = clean(meeting?.local_session_id, 180);
    const meetingCode = clean(meeting?.meeting_code, 80) || null;
    const meetingUrl = clean(meeting?.meeting_url, 1000) || null;
    const title = clean(meeting?.title, 500) || "Reunião";
    const startedAt = clean(meeting?.started_at, 80);
    const endedAt = clean(meeting?.ended_at, 80);
    const segments = normalizeSegments(body?.segments);
    if (!localSessionId || !startedAt || !endedAt || segments.length === 0) return respond({ error: "missing_capture_data" }, 400);
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) return respond({ error: "invalid_timestamps" }, 400);

    const transcriptText = buildTranscriptText(segments);
    const contentHash = await sha256(transcriptText);
    const durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
    const sessionPayload = {
      device_id: device.id,
      owner_person: device.owner_person,
      local_session_id: localSessionId,
      meeting_code: meetingCode,
      meeting_url: meetingUrl,
      title,
      calendar_event_id: clean(meeting?.calendar_event_id, 180) || null,
      started_at: startedAt,
      ended_at: endedAt,
      state: "CAPTURED",
      capture_mode: clean(meeting?.capture_mode, 40) || "MEET_CAPTIONS",
      native_transcript_available: Boolean(meeting?.native_transcript_available),
      captions_available: true,
      metadata: { ...(meeting?.metadata || {}), extension_version: clean(meeting?.extension_version, 40) || null, captured_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    };
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .upsert(sessionPayload, { onConflict: "device_id,local_session_id" })
      .select("id,transcript_id")
      .single();
    if (sessionError || !session) return respond({ error: "session_upsert_failed", detail: sessionError?.message }, 500);

    const participantInput = Array.isArray(body?.participants) ? body.participants : [];
    const participantMap = new Map<string, Row>();
    for (const raw of participantInput) {
      const displayName = clean(raw?.display_name || raw?.name, 160);
      const key = clean(raw?.participant_key, 180) || displayName.toLocaleLowerCase("pt-BR");
      if (displayName && key) participantMap.set(key, { ...raw, display_name: displayName, participant_key: key });
    }
    for (const segment of segments) {
      const key = segment.speaker_key || segment.speaker_name.toLocaleLowerCase("pt-BR");
      if (!participantMap.has(key)) participantMap.set(key, { participant_key: key, display_name: segment.speaker_name, source: "CAPTIONS" });
    }
    const participantNames = Array.from(participantMap.values()).map((p) => clean(p.display_name, 160)).filter(Boolean);

    let transcript: Row | null = null;
    const { data: existing } = await ops.from("meeting_transcripts").select("id").eq("capture_session_id", session.id).maybeSingle();
    const transcriptPayload = {
      source_system: "LEONARDO_MEET",
      source_file_id: localSessionId,
      source_file_name: `${meetingCode || "meet"} - ${startedAt.replace(/[:.]/g, "-")}.txt`,
      source_url: meetingUrl,
      meeting_key: `leonardo:${device.owner_person}:${meetingCode || localSessionId}:${startedAt}`,
      meeting_code: meetingCode,
      meeting_started_at: startedAt,
      meeting_ended_at: endedAt,
      duration_seconds: durationSeconds,
      transcript_text: transcriptText,
      transcript_chars: transcriptText.length,
      content_sha256: contentHash,
      source_file_ids: [localSessionId],
      copies_seen: 1,
      participants: participantNames,
      owner_person: device.owner_person,
      processing_status: "CAPTURED",
      transcript_source: sessionPayload.capture_mode === "MEET_RTC_CAPTIONS" ? "MEET_RTC_CAPTIONS" : "MEET_CAPTIONS",
      capture_session_id: session.id,
      metadata: { capture_mode: sessionPayload.capture_mode, local_session_id: localSessionId, captured_by: VERSION },
      updated_at: new Date().toISOString(),
    };
    if (existing?.id) {
      const { data, error } = await ops.from("meeting_transcripts").update(transcriptPayload).eq("id", existing.id).select("id").single();
      if (error) return respond({ error: "transcript_update_failed", detail: error.message }, 500);
      transcript = data;
    } else {
      const { data, error } = await ops.from("meeting_transcripts").insert(transcriptPayload).select("id").single();
      if (error) return respond({ error: "transcript_insert_failed", detail: error.message }, 500);
      transcript = data;
    }
    if (!transcript?.id) return respond({ error: "transcript_missing" }, 500);

    const participantRows = Array.from(participantMap.values()).map((raw) => ({
      session_id: session.id,
      participant_key: clean(raw.participant_key, 180),
      google_user_id: clean(raw.google_user_id, 180) || null,
      display_name: clean(raw.display_name, 160),
      email: clean(raw.email, 240) || null,
      joined_at: clean(raw.joined_at, 80) || null,
      left_at: clean(raw.left_at, 80) || null,
      source: clean(raw.source, 40) || "CAPTIONS",
      identity_confidence: Number.isFinite(Number(raw.identity_confidence)) ? Math.max(0, Math.min(1, Number(raw.identity_confidence))) : null,
      metadata: raw.metadata || {},
      updated_at: new Date().toISOString(),
    }));
    if (participantRows.length) {
      const { error } = await ops.from("meeting_capture_participants").upsert(participantRows, { onConflict: "session_id,participant_key" });
      if (error) return respond({ error: "participants_upsert_failed", detail: error.message }, 500);
    }

    const segmentRows = segments.map((segment) => ({
      transcript_id: transcript!.id,
      session_id: session.id,
      sequence_no: segment.sequence_no,
      started_ms: segment.started_ms,
      ended_ms: segment.ended_ms,
      speaker_key: segment.speaker_key,
      speaker_name: segment.speaker_name,
      device_id: segment.device_id,
      message_id: segment.message_id,
      message_version: segment.message_version,
      text: segment.text,
      confidence: segment.confidence,
      source: segment.source,
    }));
    const { error: segmentError } = await ops.from("meeting_transcript_segments").upsert(segmentRows, { onConflict: "session_id,sequence_no" });
    if (segmentError) return respond({ error: "segments_upsert_failed", detail: segmentError.message }, 500);

    await ops.from("meeting_capture_sessions").update({ transcript_id: transcript.id, state: "CAPTURED", updated_at: new Date().toISOString() }).eq("id", session.id);
    const { data: runtime } = await ops.from("worker_runtime_config").select("value").eq("key", "meeting_postprocess").maybeSingle();
    const mode = clean(runtime?.value?.mode, 20).toLowerCase() || "off";
    let jobId: string | null = null;
    if (mode === "execute" || mode === "shadow") {
      const { data } = await ops.rpc("enqueue_heavy_job", {
        p_job_type: "MEETING_POSTPROCESS",
        p_payload: { transcript_id: transcript.id, session_id: session.id, mode },
        p_dedupe_key: `meeting:${transcript.id}`,
        p_max_attempts: 5,
        p_available_at: new Date().toISOString(),
      });
      jobId = data || null;
      if (jobId) await ops.from("meeting_capture_sessions").update({ state: "QUEUED", updated_at: new Date().toISOString() }).eq("id", session.id);
    }
    return respond({ ok: true, session_id: session.id, transcript_id: transcript.id, segments: segments.length, participants: participantNames.length, processing_mode: mode, job_id: jobId, version: VERSION });
  }

  if (action === "device_status") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    return respond({ ok: true, device_id: device.id, owner_person: device.owner_person, version: VERSION });
  }

  return respond({ error: "unknown_action" }, 400);
});
