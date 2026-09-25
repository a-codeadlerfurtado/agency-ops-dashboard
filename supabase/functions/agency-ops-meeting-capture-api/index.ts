import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;

const VERSION = "meeting-capture-v1.1-audio";
const REQUIRED_SDR_DESKTOP_VERSION = "desktop-0.5.0";
const SDR_DESKTOP_DOWNLOAD_URL = "https://github.com/a-codeadlerfurtado/agency-ops-dashboard/releases/download/relato-package-v2026.09.25.5/RelatoAI-Desktop-SDR.exe";
const SDR_DESKTOP_SHA256 = "fe9a80d4820a59e14c2c7b9b9ea48ac3675efff81fcda4d7a829cce546634b38";
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

function safeObjectPart(value: unknown) {
  return clean(value, 180).replace(/[^a-zA-Z0-9._-]/g, "_") || "session";
}

function normalizedAudioFile(raw: Row) {
  const role = clean(raw?.role, 20).toLowerCase();
  const extRaw = clean(raw?.ext, 12).toLowerCase();
  const mimeRaw = clean(raw?.mime_type, 120).toLowerCase();
  if (!["local", "remote", "mixed"].includes(role)) return null;
  const ext = ["wav", "webm", "ogg", "mp3"].includes(extRaw)
    ? extRaw
    : mimeRaw.includes("wav") ? "wav"
      : mimeRaw.includes("ogg") ? "ogg"
        : mimeRaw.includes("mpeg") || mimeRaw.includes("mp3") ? "mp3"
          : "webm";
  const mime = ext === "wav" ? "audio/wav" : ext === "ogg" ? "audio/ogg" : ext === "mp3" ? "audio/mpeg" : "audio/webm";
  return { role, ext, mime };
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

const GENERIC_CONTACT_NAMES = new Set(["contato","contato whatsapp","contato whatsapp desktop","whatsapp","participante","prospect"]);
function safeContactName(value: unknown) {
  const name = clean(value, 160);
  if (!name || GENERIC_CONTACT_NAMES.has(name.toLowerCase()) || /@(?:lid|c\.us)$/i.test(name)) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  const letters = name.match(/\p{L}/gu)?.length || 0;
  if (letters < 2) return null;
  return name;
}
function isWhatsappIdentitySource(value: unknown) {
  const source = clean(value, 120).toUpperCase();
  return source.startsWith("WHATSAPP_")
    || source.includes("PARTICIPANT_IDENTITY")
    || ["GROUP_PARTICIPANT_IDENTITY","CLIENT_PHONE_REGISTRY","CONTACT_SYNC","WHATSAPP_MESSAGES","ZAPI_HISTORY"].includes(source);
}
function personNameKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function bestWhatsappName(ops: any, phoneValue: string) {
  const phone = normalizePhone(phoneValue);
  if (!phone) return { name: null, role: null, source: null };

  const { data: identities } = await ops.from("whatsapp_participant_identity")
    .select("canonical_name,role_hint,confidence,last_seen_at,source")
    .eq("phone", phone)
    .not("canonical_name", "is", null)
    .order("confidence", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(8);
  for (const row of identities || []) {
    const source = clean(row?.source, 120).toUpperCase();
    if (source.startsWith("RELATO_")) continue;
    const name = safeContactName(row?.canonical_name);
    if (name) return { name, role: clean(row.role_hint, 80) || null, source: source || "PARTICIPANT_IDENTITY" };
  }

  const { data: synced } = await ops.from("whatsapp_contact_identity_sync_state")
    .select("whatsapp_name,last_synced_at")
    .eq("phone", phone)
    .order("last_synced_at", { ascending: false })
    .limit(3);
  for (const row of synced || []) {
    const name = safeContactName(row?.whatsapp_name);
    if (name) return { name, role: null, source: "CONTACT_SYNC" };
  }

  const phoneOr = [
    `sender_phone.eq.${phone}`, `participant_phone.eq.${phone}`,
    `chat_id.eq.${phone}`, `chat_id.eq.${phone}@c.us`
  ].join(",");
  const { data: messages } = await ops.from("whatsapp_messages")
    .select("chat_name,sender_name,from_me,is_group,event_at")
    .or(phoneOr).eq("is_group", false)
    .order("event_at", { ascending: false }).limit(20);
  for (const row of messages || []) {
    const name = safeContactName(row?.chat_name) || (!row?.from_me ? safeContactName(row?.sender_name) : null);
    if (name) return { name, role: null, source: "WHATSAPP_MESSAGES" };
  }

  const { data: raw } = await ops.from("whatsapp_zapi_raw")
    .select("chat_name,sender_name,from_me,is_group,event_at")
    .or(phoneOr).eq("is_group", false)
    .order("event_at", { ascending: false }).limit(20);
  for (const row of raw || []) {
    const name = safeContactName(row?.chat_name) || (!row?.from_me ? safeContactName(row?.sender_name) : null);
    if (name) return { name, role: null, source: "ZAPI_HISTORY" };
  }
  return { name: null, role: null, source: null };
}

async function inferDirectChatIdentityByWindow(ops: any, startedAt: string, endedAt: string) {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const from = new Date(startMs - 45_000).toISOString();
  const to = new Date(endMs + 45_000).toISOString();
  const { data } = await ops.from("whatsapp_messages")
    .select("chat_id,chat_name,sender_name,sender_phone,participant_phone,from_me,event_at")
    .eq("is_group", false).gte("event_at", from).lte("event_at", to)
    .order("event_at", { ascending: false }).limit(80);
  const candidates = new Map<string, { name: string; phone: string | null; at: string }>();
  for (const row of data || []) {
    const name = safeContactName(row?.chat_name) || (!row?.from_me ? safeContactName(row?.sender_name) : null);
    if (!name) continue;
    const key = clean(row?.chat_id, 220) || name.toLowerCase();
    const phone = normalizePhone(row?.participant_phone || (!row?.from_me ? row?.sender_phone : null) || row?.chat_id);
    if (!candidates.has(key)) candidates.set(key, { name, phone, at: row?.event_at || "" });
  }
  if (candidates.size !== 1) return null;
  const only = [...candidates.values()][0];
  return { name: only.name, phone: only.phone, source: "WHATSAPP_DIRECT_CHAT_WINDOW" };
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

  if (action === "device_probe") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    return respond({ ok: true, device_id: device.id, owner_person: device.owner_person, version: VERSION });
  }

  if (action === "agent_update_check") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const currentVersion = clean(body?.current_version, 40) || "";
    return respond({
      ok: true,
      current_version: currentVersion,
      required_version: REQUIRED_SDR_DESKTOP_VERSION,
      update_required: currentVersion !== REQUIRED_SDR_DESKTOP_VERSION,
      download_url: SDR_DESKTOP_DOWNLOAD_URL,
      sha256: SDR_DESKTOP_SHA256,
    });
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
    const requestedAudioStatus = clean(raw.audio_status,40).toUpperCase();
    const requestedAudioSource = clean(raw.audio_source,40).toUpperCase();
    const inferredAudioStatus = (clean(raw.metadata?.recorder,40).toUpperCase() === "DESKTOP_AGENT" || clean(raw.capture_mode,40).toUpperCase() === "MEET_RTC_AUDIO") ? "RECORDING" : null;
    const inferredAudioSource = clean(raw.metadata?.recorder,40).toUpperCase() === "DESKTOP_AGENT" ? "DESKTOP_AGENT" : clean(raw.capture_mode,40).toUpperCase() === "MEET_RTC_AUDIO" ? "EXTENSION_WEBRTC" : null;
    const payload: Row = {
      device_id: device.id, owner_person: device.owner_person, local_session_id: localSessionId,
      meeting_code: clean(raw.meeting_code, 80) || null, meeting_url: clean(raw.meeting_url, 1000) || null,
      title: clean(raw.title, 500) || "Reunião Google Meet", started_at: startedAt,
      ended_at: Number.isFinite(Date.parse(clean(raw.ended_at,80))) ? clean(raw.ended_at,80) : null,
      state: allowedState, capture_mode: clean(raw.capture_mode,40) || "MEET_RTC_CAPTIONS",
      native_transcript_available: false, captions_available: Boolean(raw.captions_available),
      metadata: { ...(raw.metadata || {}), extension_version: clean(raw.extension_version,40) || null, heartbeat_at: new Date().toISOString(), last_error: clean(raw.last_error,500) || null },
      updated_at: new Date().toISOString(),
    };
    const { data: existingSession, error: existingError } = await ops.from("meeting_capture_sessions")
      .select("id,metadata").eq("owner_person", device.owner_person).eq("local_session_id", localSessionId).maybeSingle();
    if (existingError) return respond({ error: "session_heartbeat_lookup_failed", detail: existingError.message }, 500);
    const validAudioStatuses = ["RECORDING","RECORDED_LOCAL","UPLOADING","STORED","PROCESSING","READY","UPLOAD_FAILED"];
    const validAudioSources = ["DESKTOP_AGENT","EXTENSION_WEBRTC","FALLBACK_EXTENSION"];
    const nextAudioStatus = validAudioStatuses.includes(requestedAudioStatus) ? requestedAudioStatus : (!existingSession && inferredAudioStatus ? inferredAudioStatus : null);    const nextAudioSource = validAudioSources.includes(requestedAudioSource) ? requestedAudioSource : (!existingSession && inferredAudioSource ? inferredAudioSource : null);
    if (nextAudioStatus) payload.audio_status = nextAudioStatus;
    if (nextAudioSource) payload.audio_source = nextAudioSource;
    if (nextAudioStatus || nextAudioSource) payload.audio_updated_at = new Date().toISOString();
    let saved: Row | null = null;
    let saveError: any = null;
    if (existingSession?.id) {
      const updatePayload: Row = { ...payload };
      delete updatePayload.device_id;
      delete updatePayload.owner_person;
      delete updatePayload.local_session_id;
      updatePayload.metadata = { ...(existingSession.metadata || {}), ...(payload.metadata || {}) };
      const result = await ops.from("meeting_capture_sessions").update(updatePayload).eq("id", existingSession.id).select("id,state,meeting_code,owner_person").single();
      saved = result.data; saveError = result.error;
    } else {
      const result = await ops.from("meeting_capture_sessions").insert(payload).select("id,state,meeting_code,owner_person").single();
      saved = result.data; saveError = result.error;
    }
    if (saveError) return respond({ error: "session_heartbeat_failed", detail: saveError.message }, 500);
    return respond({ ok: true, session: saved });
  }

  if (action === "meeting_audio_prepare") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const audio = (body?.audio || {}) as Row;
    const localSessionId = clean(audio.local_session_id || body?.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const requestedSource = clean(audio.audio_source || body?.audio_source, 40).toUpperCase();
    const audioSource = ["DESKTOP_AGENT","EXTENSION_WEBRTC","FALLBACK_EXTENSION"].includes(requestedSource)
      ? requestedSource : "DESKTOP_AGENT";
    const files = (Array.isArray(body?.files) ? body.files : []).map((row: Row) => normalizedAudioFile(row)).filter(Boolean) as Array<{role:string;ext:string;mime:string}>;
    if (!files.length) return respond({ error: "audio_files_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .select("id,device_id,started_at,ended_at,audio_status,audio_local_path,audio_remote_path,audio_mixed_path,metadata")
      .eq("owner_person", device.owner_person).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError || !session) return respond({ error: "meeting_session_not_found", detail: sessionError?.message }, 404);
    if (session.audio_status === "READY" && session.audio_mixed_path) {
      return respond({ ok: true, session_id: session.id, state: "READY", uploads: [], audio_source: audioSource, idempotent: true });
    }
    const safeLocal = safeObjectPart(localSessionId);
    const paths: Row = {};
    for (const file of files) paths[file.role] = "meetings/" + session.device_id + "/" + safeLocal + "/" + file.role + "." + file.ext;
    const durationMs = Number.isFinite(Number(audio.duration_ms))
      ? Math.max(0, Math.round(Number(audio.duration_ms)))
      : (session.ended_at && session.started_at ? Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at)) : null);
    const patch: Row = {
      audio_status: "UPLOADING", audio_source: audioSource, audio_duration_ms: durationMs,
      audio_last_error: null, audio_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      metadata: { ...(session.metadata || {}), audio_recorded: true, audio_source: audioSource },
    };
    if (paths.local) patch.audio_local_path = paths.local;
    if (paths.remote) patch.audio_remote_path = paths.remote;
    if (paths.mixed) {
      patch.audio_mixed_path = paths.mixed;
      patch.audio_mime_type = files.find((file) => file.role === "mixed")?.mime || "audio/mpeg";
    }
    const { error: updateError } = await ops.from("meeting_capture_sessions").update(patch).eq("id", session.id);
    if (updateError) return respond({ error: "meeting_audio_prepare_state_failed", detail: updateError.message }, 500);
    const uploads: Row[] = [];
    for (const file of files) {
      const path = paths[file.role];
      const { data, error } = await db.storage.from("relato-call-audio").createSignedUploadUrl(String(path), { upsert: true });
      if (error || !data?.signedUrl) {
        await ops.from("meeting_capture_sessions").update({
          audio_status: "UPLOAD_FAILED", audio_last_error: error?.message || "signed_upload_url_failed",
          audio_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        return respond({ error: "meeting_audio_upload_url_failed", role: file.role, detail: error?.message }, 500);
      }
      uploads.push({ role: file.role, path, mime_type: file.mime, signed_url: data.signedUrl, token: data.token || null });
    }
    return respond({ ok: true, session_id: session.id, owner_person: device.owner_person, uploads, audio_source: audioSource, state: "UPLOADING" });
  }

  if (action === "meeting_audio_finalize") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const localSessionId = clean(body?.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .select("id,device_id,started_at,ended_at,audio_status,audio_source,audio_local_path,audio_remote_path,audio_mixed_path,metadata")
      .eq("owner_person", device.owner_person).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError || !session) return respond({ error: "meeting_session_not_found", detail: sessionError?.message }, 404);
    if (session.audio_status === "READY" && session.audio_mixed_path) {
      return respond({ ok: true, session_id: session.id, state: "READY", idempotent: true });
    }
    const uploaded = Array.isArray(body?.uploaded) ? body.uploaded : [];
    let totalBytes = 0;
    let mixedBytes = 0;
    let mixedMime = "audio/mpeg";
    const verified: Row[] = [];
    for (const raw of uploaded) {
      const role = clean(raw?.role,20).toLowerCase();
      if (!["local","remote","mixed"].includes(role)) continue;
      const expected = role === "local"
        ? session.audio_local_path
        : role === "remote" ? session.audio_remote_path : session.audio_mixed_path;
      const path = clean(raw?.path,1000);
      if (!expected || path !== expected) return respond({ error: "meeting_audio_path_mismatch", role }, 400);
      const bytes = Math.max(0, Math.round(Number(raw?.bytes || 0)));
      if (!bytes) return respond({ error: "meeting_audio_empty_upload", role }, 400);
      const mimeType = clean(raw?.mime_type,120) || (role === "mixed" ? "audio/mpeg" : null);
      totalBytes += bytes;
      if (role === "mixed") {
        mixedBytes = bytes;
        mixedMime = mimeType || "audio/mpeg";
      }
      verified.push({ role, path, bytes, mime_type: mimeType });
    }
    if (!verified.length) {
      await ops.from("meeting_capture_sessions").update({
        audio_status: "UPLOAD_FAILED", audio_last_error: "no_verified_uploads",
        audio_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", session.id);
      return respond({ error: "meeting_audio_uploads_required" }, 400);
    }
    const durationMs = Number.isFinite(Number(body?.duration_ms))
      ? Math.max(0, Math.round(Number(body.duration_ms)))
      : (session.ended_at && session.started_at ? Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at)) : null);
    const directMixed = mixedBytes > 0 && Boolean(session.audio_mixed_path);
    const mixedPath = directMixed
      ? session.audio_mixed_path
      : "meetings/" + session.device_id + "/" + safeObjectPart(localSessionId) + "/meeting.webm";
    const nextMetadata = {
      ...(session.metadata || {}),
      audio_recorded: true,
      audio_uploads: verified,
      audio_source: session.audio_source || "DESKTOP_AGENT",
      player_ready_direct: directMixed,
    };
    const { error: storedError } = await ops.from("meeting_capture_sessions").update({
      audio_status: directMixed ? "READY" : "STORED",
      audio_size_bytes: directMixed ? mixedBytes : totalBytes,
      audio_duration_ms: durationMs,
      audio_mixed_path: mixedPath,
      audio_mime_type: directMixed ? mixedMime : "audio/webm",
      audio_last_error: null,
      audio_updated_at: new Date().toISOString(),
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    }).eq("id", session.id);
    if (storedError) return respond({ error: "meeting_audio_finalize_state_failed", detail: storedError.message }, 500);
    if (directMixed) {
      return respond({ ok: true, session_id: session.id, state: "READY", direct_mixed: true, job_id: null });
    }
    const { data: jobId, error: jobError } = await ops.rpc("enqueue_heavy_job", {
      p_job_type: "MEETING_AUDIO_PROCESS",
      p_payload: { session_id: session.id },
      p_dedupe_key: "meeting-audio:" + session.id,
      p_max_attempts: 8,
      p_available_at: new Date().toISOString(),
    });
    if (!jobError) {
      await ops.from("meeting_capture_sessions").update({
        audio_status: "PROCESSING", audio_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", session.id);
    }
    return respond({ ok: true, session_id: session.id, state: jobError ? "STORED" : "PROCESSING", job_id: jobId || null, processing_error: jobError?.message || null });
  }

  if (action === "call_prepare") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const call = (body?.call || {}) as Row;
    const extensionVersion = clean(call.extension_version, 40) || "";
    const { data: roster } = await ops.from("team_roster")
      .select("role").eq("person", device.owner_person).eq("is_former", false).maybeSingle();
    if (String(roster?.role || "").toUpperCase() === "SDR" && extensionVersion !== REQUIRED_SDR_DESKTOP_VERSION) {
      return respond({
        error: "desktop_agent_upgrade_required",
        message: "Atualize o Relato AI Desktop antes de gravar novas ligações.",
        current_version: extensionVersion || null,
        required_version: REQUIRED_SDR_DESKTOP_VERSION,
        download_url: SDR_DESKTOP_DOWNLOAD_URL,
        sha256: SDR_DESKTOP_SHA256,
      }, 426);
    }
    const localSessionId = clean(call.local_session_id, 180);
    const startedAt = clean(call.started_at, 80);
    const endedAt = clean(call.ended_at, 80);
    const rawContactName = safeContactName(call.contact_name);
    const localPhone = normalizePhone(call.local_phone);
    const remotePhoneCandidate = normalizePhone(call.remote_phone);
    const identitySource = clean(call.identity_source, 80) || null;
    const source = clean(call.source, 40).toUpperCase() === "WHATSAPP_DESKTOP" ? "WHATSAPP_DESKTOP" : "WHATSAPP_WEB";
    const trustedDesktopIdentity = ["WHATSAPP_LEVELDB_EXACT_CALL_WINDOW", "WHATSAPP_LEVELDB_CONTACT_WINDOW", "WHATSAPP_DESKTOP_UI", "RELATO_USER_CONFIRMED"].includes(identitySource || "");
    if (!localSessionId || !startedAt || !endedAt) return respond({ error: "missing_call_data" }, 400);
    const directHint = source === "WHATSAPP_DESKTOP"
      ? await inferDirectChatIdentityByWindow(ops, startedAt, endedAt)
      : null;
    const remotePhone = source === "WHATSAPP_DESKTOP" && !trustedDesktopIdentity
      ? (directHint?.phone || null)
      : (remotePhoneCandidate || directHint?.phone || null);
    const identity = await resolveCallIdentity(ops, remotePhone);
    const phoneName = remotePhone ? await bestWhatsappName(ops, remotePhone) : { name: null, role: null, source: null };
    const identityWhatsappName = isWhatsappIdentitySource(identity?.source) ? safeContactName(identity?.name) : null;
    const uiWhatsappName = ["WHATSAPP_DESKTOP_UI","WHATSAPP_LEVELDB_EXACT_CALL_WINDOW","WHATSAPP_LEVELDB_CONTACT_WINDOW","RELATO_USER_CONFIRMED"].includes(identitySource || "")
      ? rawContactName
      : null;
    const whatsappName = uiWhatsappName
      || safeContactName(directHint?.name)
      || safeContactName(phoneName.name)
      || identityWhatsappName;
    const whatsappNameSource = uiWhatsappName
      ? identitySource
      : safeContactName(directHint?.name)
        ? directHint?.source
        : safeContactName(phoneName.name)
          ? phoneName.source
          : identityWhatsappName
            ? identity?.source
            : null;
    const resolvedName = whatsappName || safeContactName(identity.name) || rawContactName;
    const resolvedContactName = resolvedName || (remotePhone ? `WhatsApp +${remotePhone}` : "Contato WhatsApp");
    const resolvedIdentity = {
      ...identity,
      phone: remotePhone || identity.phone || null,
      name: resolvedName || identity.name || null,
      role: identity.role || phoneName.role || null,
      source: identity.source || whatsappNameSource || identitySource || null,
    };
    const observedAt = new Date().toISOString();
    const existingNameEvidence = {};
    const nameEvidence = {
      ...existingNameEvidence,
      ...(whatsappName ? { whatsapp: {
        name: whatsappName,
        source: whatsappNameSource || "WHATSAPP",
        observed_at: observedAt,
        phone: remotePhone,
      }} : {}),
    };
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) return respond({ error: "invalid_timestamps" }, 400);
    const roles = Array.isArray(body?.roles) ? body.roles.map((v: unknown) => clean(v, 20)).filter((v: string) => ["local", "remote", "mixed"].includes(v)) : [];
    if (!roles.length) return respond({ error: "audio_roles_required" }, 400);
    const safeLocal = localSessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const ext = clean(call.audio_ext, 12).toLowerCase() === "wav" ? "wav" : "webm";
    const durationMs = Number.isFinite(Number(call.duration_ms)) ? Math.max(0, Math.round(Number(call.duration_ms))) : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const audioPaths: Row = {};
    for (const role of [...new Set(roles)]) {
      const roleExt = role === "mixed" ? "mp3" : ext;
      audioPaths[role] = `calls/${device.id}/${safeLocal}/${role}.${roleExt}`;
    }
    const sessionPayload = {
      device_id: device.id, owner_person: device.owner_person, local_session_id: localSessionId,
      meeting_code: null, meeting_url: source === "WHATSAPP_WEB" ? "https://web.whatsapp.com/" : null, title: `Ligação WhatsApp — ${resolvedContactName}`,
      started_at: startedAt, ended_at: endedAt, state: "CAPTURING", capture_mode: source === "WHATSAPP_DESKTOP" ? "WHATSAPP_DESKTOP_AUDIO" : "WHATSAPP_WEB_AUDIO",
      native_transcript_available: false, captions_available: false,
      audio_status: audioPaths.mixed ? "UPLOADING" : "STORED",
      audio_source: "DESKTOP_AGENT",
      audio_local_path: audioPaths.local || null,
      audio_remote_path: audioPaths.remote || null,
      audio_mixed_path: audioPaths.mixed || null,
      audio_duration_ms: durationMs,
      audio_mime_type: audioPaths.mixed ? "audio/mpeg" : "audio/wav",
      audio_updated_at: new Date().toISOString(),
      metadata: { source, contact_name: resolvedContactName, local_phone: localPhone, remote_phone: remotePhone, identity_source: resolvedIdentity.source,
        identity_candidate_rejected: Boolean(remotePhoneCandidate && !remotePhone),
        whatsapp_name: whatsappName,
        name_evidence: nameEvidence,
        remote_name: resolvedIdentity.name, remote_role: resolvedIdentity.role, resolved_client_id: resolvedIdentity.client_id, resolved_client_name: resolvedIdentity.client_name,
        identity_resolution: resolvedIdentity, audio_paths: audioPaths, finish_reason: clean(call.finish_reason, 80) || null, extension_version: clean(call.extension_version, 40) || null },
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
      .select("id,transcript_id,owner_person,metadata").eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError) return respond({ error: "feedback_context_failed", detail: sessionError.message }, 500);
    if (!session) return respond({ ok: true, pending: true });

    const remotePhone = normalizePhone(session.metadata?.remote_phone);
    const identity = session.metadata?.identity_resolution?.auto === true
      ? session.metadata.identity_resolution
      : await resolveCallIdentity(ops, remotePhone);
    const genericNames = new Set(["contato","contato whatsapp","contato whatsapp desktop","whatsapp"]);
    const rawName = clean(identity?.name || session.metadata?.remote_name || session.metadata?.contact_name, 160);
    const remoteName = rawName && !genericNames.has(rawName.toLowerCase()) ? rawName : null;

    const { data: roster } = await ops.from("team_roster")
      .select("role").eq("person", device.owner_person).eq("is_former", false).maybeSingle();
    const isSdr = String(roster?.role || "").toUpperCase() === "SDR";
    let prospectPrefill: Row | null = null;
    let transcriptReady = Boolean(session.transcript_id);

    if (isSdr) {
      const crm = db.schema("crm");
      let leadId = clean(session.metadata?.commercial_prospect?.lead_id, 80) || null;
      let profile: Row | null = null;

      if (!leadId) {
        const { data: callRow } = await ops.from("commercial_call_records")
          .select("lead_id").eq("capture_session_id", session.id).maybeSingle();
        leadId = clean(callRow?.lead_id, 80) || null;
      }
      if (!leadId) {
        const { data: profiles } = await ops.from("commercial_prospect_profiles")
          .select("lead_id,city,website,decision_role,broker_count,current_structure,marketing_investment,primary_pain,secondary_pains,pain_points,goals,services_interest,objections,urgency,qualification_summary,closer_briefing,buying_signals,closing_risks,next_step,next_step_at,metadata,updated_at")
          .contains("metadata", { capture_session_id: session.id })
          .order("updated_at", { ascending: false }).limit(1);
        profile = profiles?.[0] || null;
        leadId = clean(profile?.lead_id, 80) || null;
      }

      let lead: Row | null = null;
      if (leadId) {
        const { data } = await crm.from("leads")
          .select("id,name,company,email,phone,instagram,orcamento_mkt,atuacao,notes")
          .eq("id", leadId).maybeSingle();
        lead = data || null;
      }
      if (!lead && remotePhone) {
        const variants = [remotePhone, "+" + remotePhone];
        const { data } = await crm.from("leads")
          .select("id,name,company,email,phone,instagram,orcamento_mkt,atuacao,notes")
          .in("phone", variants).is("archived_at", null)
          .order("updated_at", { ascending: false }).limit(1).maybeSingle();
        lead = data || null;
      }
      if (lead?.id && !profile) {
        const { data } = await ops.from("commercial_prospect_profiles")
          .select("lead_id,city,website,decision_role,broker_count,current_structure,marketing_investment,primary_pain,secondary_pains,pain_points,goals,services_interest,objections,urgency,qualification_summary,closer_briefing,buying_signals,closing_risks,next_step,next_step_at,metadata,updated_at")
          .eq("lead_id", lead.id).maybeSingle();
        profile = data || null;
      }

      let transcriptText = "";
      let aiSignals: Row = {};
      let transcriptStatus = "";
      if (session.transcript_id) {
        const { data: transcript } = await ops.from("meeting_transcripts")
          .select("transcript_text,processing_status,ai_signals,summary,metadata").eq("id", session.transcript_id).maybeSingle();
        transcriptText = clean(transcript?.transcript_text, 30000);
        transcriptStatus = clean(transcript?.processing_status, 40).toUpperCase();
        aiSignals = transcript?.ai_signals && typeof transcript.ai_signals === "object" ? transcript.ai_signals : {};
        if ((!aiSignals || !Object.keys(aiSignals).length) && transcript?.metadata?.commercial_analysis)
          aiSignals = transcript.metadata.commercial_analysis;
      }
      transcriptReady = ["READY","REJECTED"].includes(transcriptStatus);
      const commercialAnalysisReady = Boolean(
        aiSignals && (
          clean(aiSignals.summary, 1000)
          || clean(aiSignals.primary_pain, 1000)
          || clean(aiSignals.closer_briefing, 1000)
          || (Array.isArray(aiSignals.pain_points) && aiSignals.pain_points.length)
        )
      );
      const emailMatch = transcriptText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      const instagramMatch = transcriptText.match(/(?:instagram(?:\.com\/)?|@)([A-Z0-9._]{3,40})/i);
      const brokersMatch = transcriptText.match(/\b(\d{1,4})\s+(?:corretores?|vendedores?)\b/i);
      const investmentMatch = transcriptText.match(/(?:investe|investimento|verba)[^\n]{0,40}?(R\$\s*[\d.,]+|\d[\d.,]*\s*(?:mil|k))/i);

      const aiArray = (value: unknown) => Array.isArray(value)
        ? value.map((v: unknown) => clean(v, 500)).filter(Boolean).slice(0, 30)
        : [];
      const aiPain = [
        clean(aiSignals.primary_pain, 500),
        ...aiArray(aiSignals.secondary_pains),
        ...aiArray(aiSignals.pain_points),
      ].filter(Boolean);
      prospectPrefill = {
        name: clean(lead?.name || remoteName, 200) || null,
        company: clean(lead?.company, 240) || null,
        email: clean(lead?.email || emailMatch?.[0], 240).toLowerCase() || null,
        phone: normalizePhone(lead?.phone || remotePhone) || null,
        city: clean(profile?.city || lead?.atuacao, 200) || null,
        instagram: clean(lead?.instagram || profile?.website || (instagramMatch ? "@" + instagramMatch[1] : null), 500) || null,
        marketing_investment: clean(aiSignals.marketing_investment || profile?.marketing_investment || lead?.orcamento_mkt || investmentMatch?.[1], 240) || null,
        broker_count: Number(aiSignals.broker_count || profile?.broker_count || brokersMatch?.[1] || 0) || null,
        pain_points: aiPain.length ? [...new Set(aiPain)] : (Array.isArray(profile?.pain_points) ? profile.pain_points : []),
        goals: aiArray(aiSignals.goals).length ? aiArray(aiSignals.goals) : (Array.isArray(profile?.goals) ? profile.goals : []),
        services_interest: aiArray(aiSignals.services_interest).length ? aiArray(aiSignals.services_interest) : (Array.isArray(profile?.services_interest) ? profile.services_interest : []),
        objections: aiArray(aiSignals.objections).length ? aiArray(aiSignals.objections) : (Array.isArray(profile?.objections) ? profile.objections : []),
        urgency: clean(aiSignals.urgency || profile?.urgency, 1000) || null,
        decision_role: clean(aiSignals.decision_role || profile?.decision_role, 1000) || null,
        current_structure: clean(aiSignals.current_structure || profile?.current_structure, 2000) || null,
        buying_signals: aiArray(aiSignals.buying_signals).length ? aiArray(aiSignals.buying_signals) : (Array.isArray(profile?.buying_signals) ? profile.buying_signals : []),
        closing_risks: aiArray(aiSignals.closing_risks).length ? aiArray(aiSignals.closing_risks) : (Array.isArray(profile?.closing_risks) ? profile.closing_risks : []),
        closer_briefing: clean(aiSignals.closer_briefing || profile?.closer_briefing, 6000) || null,
        ai_summary: clean(aiSignals.summary || profile?.qualification_summary, 6000) || null,
        next_step: clean(aiSignals.follow_up || profile?.next_step, 2000) || null,
        next_step_at: profile?.next_step_at || null,
      };
      return respond({
        ok: true, pending: false, workflow: "SDR_PROSPECT", transcript_ready: transcriptReady,
        commercial_analysis_ready: commercialAnalysisReady,
        requires_selection: false, remote_phone: remotePhone, remote_name: remoteName,
        remote_role: "PROSPECT", client_id: null, client_name: null,
        resolution_status: identity?.status || "UNRESOLVED", clients: [], prospect_prefill: prospectPrefill
      });
    }

    const requiresSelection = !Boolean(identity?.auto) || (!identity?.client_id && String(identity?.side || "").toUpperCase() !== "TEAM");
    let clients: Row[] = [];
    if (requiresSelection) {
      const { data, error } = await ops.from("clients").select("id,display_name,lifecycle")
        .in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name");
      if (error) return respond({ error: "feedback_clients_failed", detail: error.message }, 500);
      clients = data || [];
    }
    return respond({ ok: true, pending: false, workflow: "CLIENT_REVIEW", transcript_ready: transcriptReady,
      requires_selection: requiresSelection, remote_phone: remotePhone, remote_name: remoteName,
      remote_role: clean(identity?.role || session.metadata?.remote_role, 80) || null,
      client_id: identity?.client_id || null, client_name: identity?.client_name || null,
      resolution_status: identity?.status || "UNRESOLVED", prospect_prefill: null,
      clients: clients.map((c: Row) => ({ id: c.id, name: c.display_name })) });
  }

  if (action === "call_mixed_ready") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const localSessionId = clean(body?.local_session_id, 180);
    const path = clean(body?.path, 1000);
    const bytes = Math.max(0, Math.round(Number(body?.bytes || 0)));
    if (!localSessionId || !path || bytes < 1000) return respond({ error: "mixed_audio_data_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .select("id,audio_mixed_path,audio_duration_ms,metadata")
      .eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError || !session) return respond({ error: "call_session_not_found" }, 404);
    if (!session.audio_mixed_path || path !== session.audio_mixed_path) return respond({ error: "call_audio_path_mismatch", role: "mixed" }, 400);
    const durationMs = Number.isFinite(Number(body?.duration_ms))
      ? Math.max(0, Math.round(Number(body.duration_ms)))
      : Math.max(0, Math.round(Number(session.audio_duration_ms || 0)));
    const now = new Date().toISOString();
    const metadata = {
      ...(session.metadata || {}),
      audio_player: { path, bytes, mime_type: "audio/mpeg", codec: "mp3", ready_at: now, source: "DESKTOP_AGENT" }
    };
    const { error: updateError } = await ops.from("meeting_capture_sessions").update({
      audio_status: "READY",
      audio_mixed_path: path,
      audio_size_bytes: bytes,
      audio_duration_ms: durationMs || null,
      audio_mime_type: "audio/mpeg",
      audio_last_error: null,
      audio_updated_at: now,
      metadata,
      updated_at: now,
    }).eq("id", session.id);
    if (updateError) return respond({ error: "mixed_audio_commit_failed", detail: updateError.message }, 500);
    return respond({ ok: true, session_id: session.id, audio_status: "READY" });
  }

  if (action === "call_finalize") {
    const device = await resolveDevice(req, ops);
    if (!device) return respond({ error: "invalid_device" }, 401);
    const localSessionId = clean(body?.local_session_id, 180);
    if (!localSessionId) return respond({ error: "local_session_id_required" }, 400);
    const { data: session, error: sessionError } = await ops.from("meeting_capture_sessions")
      .select("id,state,metadata,audio_local_path,audio_remote_path,audio_mixed_path,audio_duration_ms,audio_status")
      .eq("device_id", device.id).eq("local_session_id", localSessionId).maybeSingle();
    if (sessionError || !session) return respond({ error: "call_session_not_found" }, 404);
    const uploaded = Array.isArray(body?.uploaded) ? body.uploaded : [];
    let totalBytes = 0;
    let mixedBytes = 0;
    for (const raw of uploaded) {
      const role = clean(raw?.role,20).toLowerCase();
      if (!["local","remote","mixed"].includes(role)) continue;
      const expected = role === "local" ? session.audio_local_path : role === "remote" ? session.audio_remote_path : session.audio_mixed_path;
      const path = clean(raw?.path,1000);
      if (!expected || path !== expected) return respond({ error: "call_audio_path_mismatch", role }, 400);
      const bytes = Math.max(0, Math.round(Number(raw?.bytes || 0)));
      if (!bytes) return respond({ error: "call_audio_empty_upload", role }, 400);
      totalBytes += bytes;
      if (role === "mixed") mixedBytes = bytes;
    }
    const durationMs = Number.isFinite(Number(body?.duration_ms))
      ? Math.max(0, Math.round(Number(body.duration_ms)))
      : Math.max(0, Math.round(Number(session.audio_duration_ms || 0)));
    const expectedMixedBytes = durationMs > 0 ? Math.round((durationMs / 1000) * 16000) : 0;
    const partialMixedAudio = mixedBytes > 0 && durationMs >= 15000 && expectedMixedBytes > 0 && mixedBytes < expectedMixedBytes * 0.50;
    const now = new Date().toISOString();
    await ops.from("meeting_capture_sessions").update({
      state: "PROCESSING",
      audio_status: mixedBytes > 0 ? (partialMixedAudio ? "PARTIAL" : "READY") : "STORED",
      audio_size_bytes: mixedBytes > 0 ? mixedBytes : totalBytes || null,
      audio_duration_ms: durationMs || null,
      audio_mime_type: mixedBytes > 0 ? "audio/mpeg" : "audio/wav",
      audio_last_error: partialMixedAudio ? "audio_capture_shorter_than_call" : null,
      metadata: {
        ...(session.metadata || {}),
        audio_integrity: mixedBytes > 0 ? {
          status: partialMixedAudio ? "PARTIAL" : "OK",
          expected_min_bytes: expectedMixedBytes,
          mixed_bytes: mixedBytes,
          duration_ms: durationMs,
          checked_at: now
        } : null
      },
      audio_updated_at: now,
      updated_at: now
    }).eq("id", session.id);
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
      .select("id,transcript_id,owner_person,metadata,capture_mode")
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
    let commercialLead: Row | null = null;
    const prospectInput = (feedback.prospect || {}) as Row;
    const isProspect = !dismissed && Boolean(feedback.is_prospect);
    const feedbackProspectName = clean(prospectInput.name, 200) || null;
    const feedbackProspectPhone = normalizePhone(prospectInput.phone) || null;
    const requestedBindingSource = clean(feedback.binding_source, 40).toUpperCase();

    if (isProspect) {
      bindingSource = "RELATO_COMMERCIAL";
      noClient = false;
    } else if (!dismissed && currentIdentity?.auto && requestedBindingSource === "AUTO") {
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
    const remoteName = safeContactName(session.metadata?.remote_name || currentIdentity?.name);
    const whatsappName = safeContactName(
      session.metadata?.name_evidence?.whatsapp?.name
      || session.metadata?.whatsapp_name
      || (isWhatsappIdentitySource(currentIdentity?.source) ? currentIdentity?.name : null)
    );
    const postCallName = safeContactName(feedbackProspectName || feedback.prospect_name);
    const remoteRole = clean(session.metadata?.remote_role || currentIdentity?.role, 80) || null;
    const interactionChannel = clean(session.capture_mode, 60).toUpperCase().includes("MEET")
      ? "MEET"
      : (clean(feedback.channel, 40) || "WHATSAPP_DESKTOP");

    if (isProspect) {
      const crm = db.schema("crm");
      const prospectName = clean(feedbackProspectName || remoteName, 200);
      if (!prospectName) return respond({ error: "prospect_name_required" }, 400);
      const prospectCompany = clean(prospectInput.company, 240) || null;
      const prospectEmail = clean(prospectInput.email, 240).toLowerCase() || null;
      const prospectPhone = normalizePhone(feedbackProspectPhone || remotePhone) || null;
      const prospectCity = clean(prospectInput.city, 200) || null;
      const prospectInstagram = clean(prospectInput.instagram, 500) || null;
      let aiSignals: Row = {};
      let aiSummary: string | null = null;
      if (session.transcript_id) {
        const { data: transcriptRow } = await ops.from("meeting_transcripts")
          .select("summary,ai_signals,metadata").eq("id", session.transcript_id).maybeSingle();
        aiSignals = transcriptRow?.ai_signals && typeof transcriptRow.ai_signals === "object" ? transcriptRow.ai_signals : {};
        if ((!aiSignals || !Object.keys(aiSignals).length) && transcriptRow?.metadata?.commercial_analysis)
          aiSignals = transcriptRow.metadata.commercial_analysis;
        aiSummary = clean(transcriptRow?.summary, 6000) || null;
      }
      const arr = (value: unknown, max = 30) => Array.isArray(value)
        ? value.map((v: unknown) => clean(v, 500)).filter(Boolean).slice(0, max)
        : [];
      const inputPainPoints = arr(prospectInput.pain_points);
      const aiPainPoints = [
        clean(aiSignals.primary_pain, 500),
        ...arr(aiSignals.secondary_pains),
        ...arr(aiSignals.pain_points),
      ].filter(Boolean);
      const painPoints = inputPainPoints.length ? inputPainPoints : [...new Set(aiPainPoints)];
      const goals = arr(prospectInput.goals).length ? arr(prospectInput.goals) : arr(aiSignals.goals);
      const servicesInterest = arr(prospectInput.services_interest).length ? arr(prospectInput.services_interest) : arr(aiSignals.services_interest);
      const objections = arr(prospectInput.objections).length ? arr(prospectInput.objections) : arr(aiSignals.objections);
      const urgency = clean(prospectInput.urgency || aiSignals.urgency, 1000) || null;
      const decisionRole = clean(prospectInput.decision_role || aiSignals.decision_role, 1000) || null;
      const currentStructure = clean(prospectInput.current_structure || aiSignals.current_structure, 2000) || null;
      const buyingSignals = arr(prospectInput.buying_signals).length ? arr(prospectInput.buying_signals) : arr(aiSignals.buying_signals);
      const closingRisks = arr(prospectInput.closing_risks).length ? arr(prospectInput.closing_risks) : arr(aiSignals.closing_risks);
      const marketingInvestment = clean(prospectInput.marketing_investment || aiSignals.marketing_investment, 240) || null;
      const brokerCountRaw = Number(prospectInput.broker_count || aiSignals.broker_count || 0);
      const brokerCount = Number.isFinite(brokerCountRaw) && brokerCountRaw > 0 ? Math.round(brokerCountRaw) : null;
      const primaryPain = painPoints[0] || clean(aiSignals.primary_pain, 500) || null;
      const secondaryPains = painPoints.slice(1);
      const requestedCloserBriefing = clean(prospectInput.closer_briefing || aiSignals.closer_briefing, 6000) || null;
      const nextStep = clean(prospectInput.next_step || aiSignals.follow_up, 2000) || null;
      const nextStepRaw = clean(prospectInput.next_step_at, 100);
      const nextStepAt = nextStepRaw && Number.isFinite(Date.parse(nextStepRaw)) ? new Date(nextStepRaw).toISOString() : null;
      const now = new Date().toISOString();
      const { data: closerProfile, error: closerError } = await db.from("profiles")
        .select("id,email").eq("email", "feitozaluizvitor@gmail.com").maybeSingle();
      if (closerError || !closerProfile?.id) return respond({ error: "commercial_closer_not_configured", detail: closerError?.message }, 500);

      let existingLead: Row | null = null;
      const relatoExternalId = `relato-call:${session.id}`;

      const { data: sessionLead } = await crm.from("leads")
        .select("id,owner_id,stage").eq("source", "RELATO_AI_SDR").eq("external_id", relatoExternalId).maybeSingle();
      existingLead = sessionLead || null;

      if (!existingLead) {
        const { data: callRows } = await ops.from("commercial_call_records")
          .select("lead_id").eq("capture_session_id", session.id).limit(1);
        const priorLeadId = clean(callRows?.[0]?.lead_id, 80);
        if (priorLeadId) {
          const { data } = await crm.from("leads").select("id,owner_id,stage").eq("id", priorLeadId).maybeSingle();
          existingLead = data || null;
        }
      }
      if (!existingLead) {
        const { data: priorProfiles } = await ops.from("commercial_prospect_profiles")
          .select("lead_id,updated_at").contains("metadata", { capture_session_id: session.id })
          .order("updated_at", { ascending: false }).limit(1);
        const priorLeadId = clean(priorProfiles?.[0]?.lead_id, 80);
        if (priorLeadId) {
          const { data } = await crm.from("leads").select("id,owner_id,stage").eq("id", priorLeadId).maybeSingle();
          existingLead = data || null;
        }
      }
      if (!existingLead && prospectEmail) {
        const { data } = await crm.from("leads").select("id,owner_id,stage").eq("owner_id", closerProfile.id).eq("email", prospectEmail).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
        existingLead = data || null;
      }
      if (!existingLead && prospectPhone) {
        const variants = [prospectPhone, "+" + prospectPhone];
        const { data } = await crm.from("leads").select("id,owner_id,stage").eq("owner_id", closerProfile.id).in("phone", variants).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
        existingLead = data || null;
      }
      if (!existingLead && prospectName) {
        const { data } = await crm.from("leads")
          .select("id,owner_id,stage,name,company")
          .eq("owner_id", closerProfile.id)
          .ilike("name", prospectName)
          .is("archived_at", null)
          .order("updated_at", { ascending: false })
          .limit(2);
        if ((data || []).length === 1) existingLead = data?.[0] || null;
      }

      const leadPatch: Row = {
        owner_id: closerProfile.id, name: prospectName, company: prospectCompany,
        email: prospectEmail, phone: prospectPhone, instagram: prospectInstagram,
        orcamento_mkt: marketingInvestment, updated_at: now,
      };
      let leadError: any = null;
      if (existingLead?.id) {
        const result = await crm.from("leads").update(leadPatch).eq("id", existingLead.id).select("id,owner_id,name,company,stage,email,phone").single();
        commercialLead = result.data || null; leadError = result.error;
      } else {
        const result = await crm.from("leads").insert({ ...leadPatch, source: "RELATO_AI_SDR", external_id: relatoExternalId, stage: "qualificacao", created_at: now }).select("id,owner_id,name,company,stage,email,phone").single();
        commercialLead = result.data || null; leadError = result.error;
        if (leadError?.code === "23505") {
          const retry = await crm.from("leads").select("id,owner_id,name,company,stage,email,phone")
            .eq("source", "RELATO_AI_SDR").eq("external_id", relatoExternalId).maybeSingle();
          commercialLead = retry.data || null;
          leadError = retry.error;
        }
      }
      if (leadError || !commercialLead?.id) return respond({ error: "commercial_lead_save_failed", detail: leadError?.message }, 500);

      const generatedCloserBriefing = [
        prospectCompany ? `Empresa: ${prospectCompany}` : null,
        prospectCity ? `Região: ${prospectCity}` : null,
        marketingInvestment ? `Investimento atual: ${marketingInvestment}` : null,
        brokerCount ? `Corretores: ${brokerCount}` : null,
        primaryPain ? `Dor principal: ${primaryPain}` : null,
        secondaryPains.length ? `Dores secundárias: ${secondaryPains.join(" · ")}` : null,
        goals.length ? `Objetivos: ${goals.join(" · ")}` : null,
        urgency ? `Urgência: ${urgency}` : null,
        decisionRole ? `Decisão: ${decisionRole}` : null,
        currentStructure ? `Estrutura atual: ${currentStructure}` : null,
        servicesInterest.length ? `Interesses: ${servicesInterest.join(" · ")}` : null,
        objections.length ? `Objeções: ${objections.join(" · ")}` : null,
        buyingSignals.length ? `Sinais de compra: ${buyingSignals.join(" · ")}` : null,
        closingRisks.length ? `Riscos de fechamento: ${closingRisks.join(" · ")}` : null,
        nextStep ? `Próximo passo: ${nextStep}` : null,
        clean(feedback.note, 2000) ? `Nota do SDR: ${clean(feedback.note, 2000)}` : null,
      ].filter(Boolean).join("\n");
      const closerBriefing = requestedCloserBriefing || generatedCloserBriefing || aiSummary || null;

      const { data: existingProspectProfile } = await ops.from("commercial_prospect_profiles")
        .select("*").eq("lead_id", commercialLead.id).maybeSingle();
      const mergeArray = (...values: unknown[]) => [...new Set(values.flatMap(v => Array.isArray(v) ? v : [])
        .map(v => clean(v, 500)).filter(Boolean))].slice(0, 50);

      const { error: prospectProfileError } = await ops.from("commercial_prospect_profiles").upsert({
        lead_id: commercialLead.id,
        city: prospectCity || existingProspectProfile?.city || null,
        website: prospectInstagram?.startsWith("http") ? prospectInstagram : existingProspectProfile?.website || null,
        decision_role: decisionRole || existingProspectProfile?.decision_role || null,
        broker_count: brokerCount || existingProspectProfile?.broker_count || null,
        current_structure: currentStructure || existingProspectProfile?.current_structure || null,
        marketing_investment: marketingInvestment || existingProspectProfile?.marketing_investment || null,
        primary_pain: primaryPain || existingProspectProfile?.primary_pain || null,
        secondary_pains: mergeArray(existingProspectProfile?.secondary_pains, secondaryPains),
        pain_points: mergeArray(existingProspectProfile?.pain_points, painPoints),
        goals: mergeArray(existingProspectProfile?.goals, goals),
        services_interest: mergeArray(existingProspectProfile?.services_interest, servicesInterest),
        objections: mergeArray(existingProspectProfile?.objections, objections),
        urgency: urgency || existingProspectProfile?.urgency || null,
        buying_signals: mergeArray(existingProspectProfile?.buying_signals, buyingSignals),
        closing_risks: mergeArray(existingProspectProfile?.closing_risks, closingRisks),
        qualification_summary: clean(feedback.note, 6000) || aiSummary || existingProspectProfile?.qualification_summary || closerBriefing,
        closer_briefing: closerBriefing || existingProspectProfile?.closer_briefing || null,
        next_step: nextStep || existingProspectProfile?.next_step || null,
        next_step_at: nextStepAt || existingProspectProfile?.next_step_at || null,
        sdr_person: device.owner_person, closer_person: "Vitor Feitoza", last_call_at: now,
        last_transcript_id: session.transcript_id || existingProspectProfile?.last_transcript_id || null,
        metadata: {
          ...(existingProspectProfile?.metadata || {}),
          source: "RELATO_AI",
          remote_phone: prospectPhone, remote_name: remoteName, capture_session_id: session.id,
          human_confirmed: true, human_confirmed_at: now, confirmed_by: device.owner_person,
          last_ai_analysis: aiSignals,
        },
        updated_at: now,
      }, { onConflict: "lead_id" });
      if (prospectProfileError) return respond({ error: "commercial_prospect_profile_failed", detail: prospectProfileError.message }, 500);

      const { error: callRecordError } = await ops.from("commercial_call_records").upsert({
        lead_id: commercialLead.id, capture_session_id: session.id, transcript_id: session.transcript_id || null,
        sdr_person: device.owner_person, closer_person: "Vitor Feitoza", channel: interactionChannel,
        remote_phone: prospectPhone, remote_name: prospectName, outcome: clean(feedback.relationship_direction, 80) || null,
        notes: clean(feedback.note, 3000) || null, ai_summary: aiSummary,
        primary_pain: primaryPain, secondary_pains: secondaryPains, pain_points: painPoints, goals,
        urgency, decision_role: decisionRole, current_structure: currentStructure,
        services_interest: servicesInterest, objections, buying_signals: buyingSignals, closing_risks: closingRisks,
        closer_briefing: closerBriefing, next_step: nextStep, next_step_at: nextStepAt,
        metadata: {
          source: "RELATO_AI", tags: Array.isArray(feedback.tags) ? feedback.tags : [],
          prospect_company: prospectCompany, human_confirmed: true, human_confirmed_at: now,
          ai_analysis: aiSignals,
        },
        updated_at: now,
      }, { onConflict: "capture_session_id" });
      if (callRecordError) return respond({ error: "commercial_call_record_failed", detail: callRecordError.message }, 500);

      const crmActivityExternalId = session.transcript_id ? `relato-transcript:${session.transcript_id}` : `relato-session:${session.id}`;
      const crmActivityContent = [
        aiSummary ? `[RELATO AI] ${aiSummary}` : `[RELATO AI] Interação comercial de ${prospectName}`,
        primaryPain ? `Dor principal: ${primaryPain}` : null,
        secondaryPains.length ? `Dores secundárias: ${secondaryPains.join(" · ")}` : null,
        goals.length ? `Objetivos: ${goals.join(" · ")}` : null,
        urgency ? `Urgência: ${urgency}` : null,
        decisionRole ? `Decisão: ${decisionRole}` : null,
        objections.length ? `Objeções: ${objections.join(" · ")}` : null,
        buyingSignals.length ? `Sinais de compra: ${buyingSignals.join(" · ")}` : null,
        closingRisks.length ? `Riscos: ${closingRisks.join(" · ")}` : null,
        nextStep ? `Próximo passo: ${nextStep}` : null,
        closerBriefing ? `Briefing para closer: ${closerBriefing}` : null,
        clean(feedback.note, 2000) ? `Nota confirmada pelo SDR: ${clean(feedback.note, 2000)}` : null,
      ].filter(Boolean).join("\n");
      const { data: existingCrmActivity } = await crm.from("lead_activities")
        .select("id").eq("external_id", crmActivityExternalId).maybeSingle();
      const crmActivityPatch = {
        lead_id: commercialLead.id,
        type: interactionChannel.toUpperCase().includes("MEET") ? "reuniao" : "ligacao",
        content: crmActivityContent.slice(0, 20000),
        done: true,
        external_id: crmActivityExternalId,
        metadata: {
          source: "RELATO_AI", capture_session_id: session.id, transcript_id: session.transcript_id || null,
          sdr_person: device.owner_person, closer_person: "Vitor Feitoza", human_confirmed: true,
          confirmed_at: now,
        },
      };
      const crmActivityResult = existingCrmActivity?.id
        ? await crm.from("lead_activities").update(crmActivityPatch).eq("id", existingCrmActivity.id)
        : await crm.from("lead_activities").insert(crmActivityPatch);
      if (crmActivityResult.error) return respond({ error: "crm_lead_activity_failed", detail: crmActivityResult.error.message }, 500);

      if (nextStep) {
        const { data: existingActivity } = await ops.from("commercial_activities").select("id")
          .eq("lead_id", commercialLead.id).contains("metadata", { capture_session_id: session.id }).limit(1).maybeSingle();
        if (!existingActivity?.id) {
          const { error: activityError } = await ops.from("commercial_activities").insert({
            lead_id: commercialLead.id, activity_type: "FOLLOW_UP", title: nextStep.slice(0, 500),
            description: closerBriefing || null, owner_person: "Vitor Feitoza", due_at: nextStepAt,
            source: "RELATO_AI", metadata: { capture_session_id: session.id, sdr_person: device.owner_person },
          });
          if (activityError) return respond({ error: "commercial_activity_failed", detail: activityError.message }, 500);
        }
      }
    }

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

    const confirmedAt = new Date().toISOString();
    const resolvedIdentity = dismissed ? currentIdentity : isProspect ? {
      ...(currentIdentity || {}), status: "COMMERCIAL_PROSPECT", auto: false,
      phone: remotePhone, name: postCallName || whatsappName || remoteName, role: "PROSPECT",
      client_id: null, client_name: null, side: "EXTERNAL", source: postCallName ? "RELATO_COMMERCIAL" : (currentIdentity?.source || "RELATO_COMMERCIAL"),
      commercial_lead_id: commercialLead?.id || null,
    } : {
      ...(currentIdentity || {}), status: selectedClientId ? "AUTO_CLIENT" : "AUTO_NON_CLIENT", auto: Boolean(currentIdentity?.auto),
      phone: remotePhone, name: remoteName, role: remoteRole, client_id: selectedClientId,
      client_name: selectedClientName, side: selectedClientId ? "CLIENT_SIDE" : (currentIdentity?.side || "EXTERNAL"),
      source: bindingSource === "MANUAL" ? "RELATO_MANUAL" : (currentIdentity?.source || "AUTO"),
    };
    if (!dismissed) {
      const previousEvidence = session.metadata?.name_evidence || {};
      const nextEvidence = {
        ...previousEvidence,
        ...(whatsappName ? { whatsapp: {
          ...(previousEvidence?.whatsapp || {}),
          name: whatsappName,
          source: previousEvidence?.whatsapp?.source || currentIdentity?.source || "WHATSAPP",
        }} : {}),
        ...(postCallName ? { post_call: {
          name: postCallName,
          source: "SDR_POST_CALL",
          confirmed_by: device.owner_person,
          confirmed_at: confirmedAt,
        }} : {}),
        ...(commercialLead?.name ? { crm: {
          name: commercialLead.name,
          lead_id: commercialLead.id,
          source: "CRM",
          observed_at: confirmedAt,
        }} : {}),
      };
      const nextMetadata = { ...(session.metadata || {}),
        remote_name: remoteName,
        whatsapp_name: whatsappName || session.metadata?.whatsapp_name || null,
        post_call_name: postCallName || session.metadata?.post_call_name || null,
        crm_name: commercialLead?.name || session.metadata?.crm_name || null,
        name_evidence: nextEvidence,
        remote_phone: isProspect ? (feedbackProspectPhone || remotePhone) : remotePhone,
        remote_role: isProspect ? "PROSPECT" : remoteRole,
        resolved_client_id: selectedClientId, resolved_client_name: selectedClientName,
        identity_resolution: resolvedIdentity,
        ...(isProspect && commercialLead ? { commercial_prospect: {
          lead_id: commercialLead.id, name: commercialLead.name, company: commercialLead.company,
          name_source: postCallName ? "POST_CALL" : (whatsappName ? "WHATSAPP" : "CRM"),
          closer_person: "Vitor Feitoza", sdr_person: device.owner_person,
        }} : {}),
        feedback_binding: { source: bindingSource, prospect_name: postCallName, confirmed_by: device.owner_person, confirmed_at: confirmedAt },
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
      channel: interactionChannel, mood: clean(feedback.mood, 60) || null, tone: clean(feedback.tone, 60) || null,
      receptivity: asScore(feedback.receptivity), trust_level: asScore(feedback.trust_level), perceived_risk: asScore(feedback.perceived_risk),
      relationship_direction: ["IMPROVING","STABLE","WORSENING","UNKNOWN"].includes(clean(feedback.relationship_direction, 20).toUpperCase()) ? clean(feedback.relationship_direction, 20).toUpperCase() : "UNKNOWN",
      tags, note: clean(feedback.note, 2000) || null, dismissed,
      submitted_at: dismissed ? null : new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { data, error } = await ops.from("meeting_human_feedback").upsert(payload, { onConflict: "owner_person,local_session_id" }).select("id,transcript_id,client_id,submitted_at,dismissed").single();
    if (error) return respond({ error: "feedback_save_failed", detail: error.message }, 500);
    return respond({ ok: true, feedback: data, binding: { source: bindingSource, client_id: selectedClientId, client_name: selectedClientName, prospect_name: postCallName, no_client: noClient, is_prospect: isProspect, commercial_lead_id: commercialLead?.id || null } });
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
    const captureMode = clean(meeting?.capture_mode, 40) || "MEET_CAPTIONS";
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
      capture_mode: captureMode,
      native_transcript_available: Boolean(meeting?.native_transcript_available),
      captions_available: Boolean(meeting?.captions_available) || captureMode === "MEET_RTC_CAPTIONS" || captureMode === "MEET_CAPTIONS",
      metadata: { ...(meeting?.metadata || {}), extension_version: clean(meeting?.extension_version, 40) || null, captured_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    };
    const { data: existingSession, error: existingSessionError } = await ops.from("meeting_capture_sessions")
      .select("id,transcript_id,metadata").eq("owner_person", device.owner_person).eq("local_session_id", localSessionId).maybeSingle();
    if (existingSessionError) return respond({ error: "session_lookup_failed", detail: existingSessionError.message }, 500);
    let session: Row | null = null;
    let sessionError: any = null;
    if (existingSession?.id) {
      const updatePayload: Row = { ...sessionPayload };
      delete updatePayload.device_id;
      delete updatePayload.owner_person;
      delete updatePayload.local_session_id;
      updatePayload.metadata = { ...(existingSession.metadata || {}), ...(sessionPayload.metadata || {}) };
      const result = await ops.from("meeting_capture_sessions").update(updatePayload).eq("id", existingSession.id).select("id,transcript_id").single();
      session = result.data; sessionError = result.error;
    } else {
      const result = await ops.from("meeting_capture_sessions").insert(sessionPayload).select("id,transcript_id").single();
      session = result.data; sessionError = result.error;
    }
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
    const { data: activeTeam } = await ops.from("team_roster")
      .select("person").eq("is_former", false);
    const teamNameKeys = new Set((activeTeam || []).map((row: Row) => personNameKey(row.person)).filter(Boolean));
    teamNameKeys.add(personNameKey(device.owner_person));
    const externalParticipants = participantNames
      .map((name) => safeContactName(name))
      .filter((name): name is string => Boolean(name) && !teamNameKeys.has(personNameKey(name)));
    const externalWeights = new Map<string, number>();
    for (const segment of segments) {
      const name = safeContactName(segment.speaker_name);
      if (!name || teamNameKeys.has(personNameKey(name))) continue;
      externalWeights.set(name, (externalWeights.get(name) || 0) + clean(segment.text, 8000).length);
    }
    const primaryProspectName = [...externalWeights.entries()]
      .sort((a,b) => b[1] - a[1])[0]?.[0]
      || externalParticipants[0]
      || null;
    const meetingIdentityMetadata = {
      remote_name: primaryProspectName,
      contact_name: primaryProspectName,
      remote_role: primaryProspectName ? "PROSPECT" : null,
      meeting_external_participants: [...new Set(externalParticipants)],
      identity_source: primaryProspectName ? "MEET_PARTICIPANTS" : null,
    };
    if (primaryProspectName) {
      await ops.from("meeting_capture_sessions").update({
        metadata: { ...(existingSession?.metadata || {}), ...(sessionPayload.metadata || {}), ...meetingIdentityMetadata },
        updated_at: new Date().toISOString(),
      }).eq("id", session.id);
    }

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
      content_sha256: contentHash,
      source_file_ids: [localSessionId],
      copies_seen: 1,
      participants: participantNames,
      owner_person: device.owner_person,
      processing_status: "CAPTURED",
      transcript_source: captureMode === "MEET_RTC_AUDIO" ? "MEET_RTC_WHISPER" : captureMode === "MEET_RTC_CAPTIONS" ? "MEET_RTC_CAPTIONS" : "MEET_CAPTIONS",
      capture_session_id: session.id,
      metadata: { capture_mode: sessionPayload.capture_mode, local_session_id: localSessionId, captured_by: VERSION, ...meetingIdentityMetadata },
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