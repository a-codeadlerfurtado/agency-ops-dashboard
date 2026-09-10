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
