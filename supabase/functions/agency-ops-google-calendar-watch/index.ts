import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type ZapiCandidate = { label: string; instance: string; token: string; clientToken: string };
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
const ZAPI_BASE = "https://api.z-api.io";
const TIMEZONE = "America/Sao_Paulo";
const OWNER_PERSON = "Adler Furtado";
const OWNER_EMAIL = "adlerfurtadomkt01@gmail.com";

const ops = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "agency_ops" },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function clean(value: unknown, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}
function cleanPhone(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}
function lower(value: unknown) {
  return clean(value, 500).toLowerCase();
}
function randomToken(size = 40) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function serviceAuthorized(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const supplied = auth.replace(/^Bearer\s+/i, "");
  if (!SERVICE_ROLE || supplied.length !== SERVICE_ROLE.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ SERVICE_ROLE.charCodeAt(i);
  return diff === 0;
}
async function secret(id: string | null | undefined) {
  if (!id) return "";
  const { data, error } = await ops.rpc("get_meeting_integration_secret", { p_secret_id: id });
  if (error) throw error;
  return clean(data, 10000);
}
async function setSecret(accountId: string, kind: string, value: string) {
  const { data, error } = await ops.rpc("set_meeting_integration_secret", {
    p_account_id: accountId,
    p_kind: kind,
    p_value: value,
  });
  if (error) throw error;
  return String(data);
}
async function accessTokenFor(account: Row) {
  const expires = account.token_expires_at ? Date.parse(String(account.token_expires_at)) : 0;
  if (account.access_secret_id && expires > Date.now() + 60_000) return await secret(account.access_secret_id);

  const refresh = await secret(account.refresh_secret_id);
  if (!refresh) throw new Error("google_reconnect_required");

  const form = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    await ops.from("meeting_integration_accounts").update({
      last_error: clean(payload?.error_description || payload?.error || "google_refresh_failed", 800),
      updated_at: new Date().toISOString(),
    }).eq("id", account.id);
    throw new Error("google_refresh_failed");
  }

  const accessSecretId = await setSecret(String(account.id), "access", String(payload.access_token));
  await ops.from("meeting_integration_accounts").update({
    access_secret_id: accessSecretId,
    token_expires_at: new Date(Date.now() + Number(payload.expires_in || 3600) * 1000).toISOString(),
    status: "ACTIVE",
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  return String(payload.access_token);
}
async function accountByOwner(ownerRaw: unknown) {
  const owner = clean(ownerRaw || OWNER_PERSON, 160);
  const { data, error } = await ops.from("meeting_integration_accounts")
    .select("*")
    .eq("owner_person", owner)
    .eq("provider_key", "GOOGLE_WORKSPACE")
    .eq("account_slot", "primary")
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("google_not_connected");
  return data as Row;
}
async function accountById(accountId: string) {
  const { data, error } = await ops.from("meeting_integration_accounts")
    .select("*")
    .eq("id", accountId)
    .eq("provider_key", "GOOGLE_WORKSPACE")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("google_account_not_found");
  return data as Row;
}

function formatDateTime(value: unknown) {
  const raw = clean(value, 100);
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
function formatMeetingWindow(startRaw: unknown, endRaw: unknown) {
  const start = new Date(clean(startRaw, 100));
  const end = new Date(clean(endRaw, 100));
  if (Number.isNaN(start.getTime())) return "horário não informado";
  const datePart = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(start);
  const startPart = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(start);
  const endPart = Number.isNaN(end.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(end);
  return datePart + " · " + startPart + (endPart ? "–" + endPart : "");
}
function sameInstant(a: unknown, b: unknown) {
  const aa = Date.parse(clean(a, 100));
  const bb = Date.parse(clean(b, 100));
  if (Number.isNaN(aa) || Number.isNaN(bb)) return clean(a, 100) === clean(b, 100);
  return aa === bb;
}
function attendeesFrom(event: Row, previous: Row | null) {
  const raw = Array.isArray(event?.attendees) ? event.attendees : (Array.isArray(previous?.attendees) ? previous?.attendees : []);
  return raw.slice(0, 50).map((item: Row) => ({
    email: clean(item?.email, 320),
    display_name: clean(item?.displayName || item?.display_name, 200) || null,
    response_status: clean(item?.responseStatus || item?.response_status, 80) || null,
    self: Boolean(item?.self),
  })).filter((item: Row) => item.email || item.display_name);
}
function participantLabel(attendees: Row[]) {
  const labels = attendees.map((item) => clean(item.display_name || item.email, 200)).filter(Boolean);
  return labels.length ? labels.slice(0, 12).join(", ") + (labels.length > 12 ? " +" + String(labels.length - 12) : "") : "não informado";
}
async function creatorName(email: string, fallback: string) {
  if (fallback) return fallback;
  if (!email) return "Outro usuário";
  const { data } = await ops.from("team_identity_map")
    .select("person,email")
    .ilike("email", email)
    .limit(1);
  return clean(data?.[0]?.person || email, 200);
}
function eventSnapshot(event: Row, previous: Row | null) {
  const previousRaw = (previous?.raw_event || {}) as Row;
  const creator = (event?.creator || previousRaw?.creator || {}) as Row;
  const organizer = (event?.organizer || previousRaw?.organizer || {}) as Row;
  const start = event?.start?.dateTime || event?.start?.date || previous?.start_time || null;
  const end = event?.end?.dateTime || event?.end?.date || previous?.end_time || null;
  const allDay = Boolean((event?.start?.date && !event?.start?.dateTime) || previous?.all_day);
  const attendees = attendeesFrom(event, previous);
  return {
    eventId: clean(event?.id || previous?.event_id, 500),
    title: clean(event?.summary || previous?.title || "Reunião", 300),
    status: clean(event?.status || previous?.status || "confirmed", 50),
    eventType: clean(event?.eventType || previous?.event_type || "default", 80),
    creatorEmail: lower(creator?.email || previous?.creator_email),
    creatorDisplayName: clean(creator?.displayName || previous?.creator_name, 200),
    organizerEmail: lower(organizer?.email || previous?.organizer_email),
    startTime: start ? String(start) : null,
    endTime: end ? String(end) : null,
    allDay,
    createdAt: clean(event?.created || previous?.created_at_google, 100) || null,
    updatedAt: clean(event?.updated || previous?.updated_at_google, 100) || new Date().toISOString(),
    attendees,
    meetUrl: clean(event?.hangoutLink || event?.conferenceData?.entryPoints?.find((p: Row) => p?.entryPointType === "video")?.uri || previous?.meet_url, 1000) || null,
    htmlLink: clean(event?.htmlLink || previous?.html_link, 1500) || null,
    rawEvent: event,
  };
}
async function saveEventState(accountId: string, snapshot: ReturnType<typeof eventSnapshot>) {
  if (!snapshot.eventId) return;
  const { error } = await ops.from("google_calendar_event_state").upsert({
    account_id: accountId,
    event_id: snapshot.eventId,
    title: snapshot.title,
    status: snapshot.status,
    event_type: snapshot.eventType,
    creator_email: snapshot.creatorEmail || null,
    creator_name: snapshot.creatorDisplayName || null,
    organizer_email: snapshot.organizerEmail || null,
    start_time: snapshot.startTime,
    end_time: snapshot.endTime,
    all_day: snapshot.allDay,
    created_at_google: snapshot.createdAt,
    updated_at_google: snapshot.updatedAt,
    attendees: snapshot.attendees,
    meet_url: snapshot.meetUrl,
    html_link: snapshot.htmlLink,
    raw_event: snapshot.rawEvent,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "account_id,event_id" });
  if (error) throw error;
}

function zapiCandidates(expectedInstance: string): ZapiCandidate[] {
  const raw: ZapiCandidate[] = [
    {
      label: "RELATO",
      instance: Deno.env.get("RELATO_ZAPI_INSTANCE_ID") || "",
      token: Deno.env.get("RELATO_ZAPI_TOKEN") || "",
      clientToken: Deno.env.get("RELATO_ZAPI_CLIENT_TOKEN") || Deno.env.get("ZAPI_CLIENT_TOKEN") || "",
    },
    {
      label: "ZAPI",
      instance: Deno.env.get("ZAPI_INSTANCIA") || Deno.env.get("ZAPI_INSTANCE_ID") || "",
      token: Deno.env.get("ZAPI_TOKEN") || "",
      clientToken: Deno.env.get("ZAPI_CLIENT_TOKEN") || "",
    },
  ];
  const seen = new Set<string>();
  return raw.filter((item) => {
    if (!item.instance || item.instance !== expectedInstance || !item.token || !item.clientToken) return false;
    const key = item.instance + ":" + item.token.length + ":" + item.clientToken.length;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function sendRawWhatsApp(phoneRaw: string, message: string) {
  const phone = cleanPhone(phoneRaw);
  if (!phone) throw new Error("whatsapp_recipient_missing");

  const { data: cfgRow, error: cfgError } = await ops.from("worker_runtime_config")
    .select("value")
    .eq("key", "meeting_notifications")
    .maybeSingle();
  if (cfgError) throw cfgError;
  const cfg = (cfgRow?.value || {}) as Row;
  if (String(cfg.mode || "off") !== "execute") throw new Error("whatsapp_notifications_off");

  const expectedInstance = clean(cfg.instance_id, 200);
  const candidates = zapiCandidates(expectedInstance);
  if (!expectedInstance || !candidates.length) throw new Error("zapi_sender_1685_not_configured");

  const failures: Row[] = [];
  for (const candidate of candidates) {
    const response = await fetch(
      ZAPI_BASE + "/instances/" + candidate.instance + "/token/" + candidate.token + "/send-text",
      {
        method: "POST",
        headers: { "content-type": "application/json", "Client-Token": candidate.clientToken },
        body: JSON.stringify({ phone, message }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const raw = await response.text();
    let body: Row = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!response.ok || body?.error) {
      failures.push({
        credential: candidate.label,
        status: response.status,
        error: clean(body?.error || body?.message || "send_failed", 300),
      });
      continue;
    }
    const messageId = clean(body?.messageId || body?.message_id || body?.zaapId || body?.id, 500);
    if (!messageId) {
      failures.push({ credential: candidate.label, status: response.status, error: "missing_message_id" });
      continue;
    }
    return { messageId, credential: candidate.label, instance: candidate.instance, phone };
  }
  throw new Error("zapi_send_failed:" + JSON.stringify(failures).slice(0, 1200));
}
async function adlerPhone() {
  const { data, error } = await ops.from("team_identity_map")
    .select("whatsapp_phone")
    .eq("person", OWNER_PERSON)
    .maybeSingle();
  if (error) throw error;
  return cleanPhone(data?.whatsapp_phone);
}

function alertType(kind: string) {
  if (kind === "CREATED") return "GOOGLE_CALENDAR_MEETING_CREATED";
  if (kind === "RESCHEDULED") return "GOOGLE_CALENDAR_MEETING_RESCHEDULED";
  return "GOOGLE_CALENDAR_MEETING_CANCELLED";
}
function alertTitle(kind: string) {
  if (kind === "CREATED") return "📅 Nova reunião marcada para você";
  if (kind === "RESCHEDULED") return "🕒 Reunião remarcada na sua agenda";
  return "❌ Reunião cancelada na sua agenda";
}
function whatsappHeader(kind: string) {
  if (kind === "CREATED") return "📅 NOVA REUNIÃO AGENDADA";
  if (kind === "RESCHEDULED") return "🕒 REUNIÃO REMARCADA";
  return "❌ REUNIÃO CANCELADA";
}
async function emitAlert(account: Row, kind: "CREATED" | "RESCHEDULED" | "CANCELLED", snapshot: ReturnType<typeof eventSnapshot>) {
  const creator = await creatorName(snapshot.creatorEmail, snapshot.creatorDisplayName);
  const participants = participantLabel(snapshot.attendees);
  const dedupeKey = [
    "gcal",
    String(account.id),
    snapshot.eventId,
    kind,
    snapshot.updatedAt || snapshot.startTime || "change",
  ].join(":");

  const { data: existing } = await ops.from("google_calendar_alerts")
    .select("*")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  let alertRow = existing as Row | null;
  if (!alertRow) {
    const { data, error } = await ops.from("google_calendar_alerts").insert({
      dedupe_key: dedupeKey,
      account_id: account.id,
      event_id: snapshot.eventId,
      change_type: kind,
      google_updated_at: snapshot.updatedAt,
      whatsapp_status: "PENDING",
    }).select("*").single();
    if (error) {
      if (String((error as Row)?.code || "") === "23505") return;
      throw error;
    }
    alertRow = data as Row;
  }

  const scheduledLabel = formatMeetingWindow(snapshot.startTime, snapshot.endTime);
  const description = [
    "Marcada por: " + creator,
    "Agendada em: " + formatDateTime(snapshot.createdAt || snapshot.updatedAt),
    "Reunião: " + scheduledLabel,
    "Participantes: " + participants,
  ].join("\n");

  const metadata = {
    private_to_person: true,
    target_person: OWNER_PERSON,
    target_role: "MGMT",
    google_calendar_alert: true,
    google_calendar_event_id: snapshot.eventId,
    google_calendar_change_type: kind,
    google_calendar_creator_email: snapshot.creatorEmail || null,
    google_calendar_creator_name: creator,
    google_calendar_organizer_email: snapshot.organizerEmail || null,
    google_calendar_created_at: snapshot.createdAt,
    google_calendar_updated_at: snapshot.updatedAt,
    start_time: snapshot.startTime,
    end_time: snapshot.endTime,
    attendees: snapshot.attendees,
    meet_url: snapshot.meetUrl,
    html_link: snapshot.htmlLink,
    button_label: snapshot.meetUrl ? "Abrir reunião" : "Abrir no Google Agenda",
  };
  const { data: notification, error: notificationError } = await ops.from("platform_notifications").upsert({
    event_key: dedupeKey,
    type: alertType(kind),
    level: kind === "CANCELLED" ? "WARNING" : "INFO",
    title: alertTitle(kind),
    description,
    source: "google_calendar_watch",
    actor: creator,
    occurred_at: new Date().toISOString(),
    metadata,
  }, { onConflict: "event_key" }).select("id").single();
  if (notificationError) throw notificationError;

  const phone = cleanPhone(alertRow?.recipient_phone) || await adlerPhone();
  const message = [
    whatsappHeader(kind),
    "",
    "*" + snapshot.title + "*",
    "Marcada por: " + creator,
    "Agendada em: " + formatDateTime(snapshot.createdAt || snapshot.updatedAt),
    "Reunião: " + scheduledLabel,
    "Participantes: " + participants,
    snapshot.meetUrl ? "Google Meet: " + snapshot.meetUrl : (snapshot.htmlLink ? "Agenda: " + snapshot.htmlLink : ""),
  ].filter(Boolean).join("\n");

  await ops.from("google_calendar_alerts").update({
    platform_notification_id: notification.id,
    recipient_phone: phone || null,
    whatsapp_message_text: message,
    updated_at: new Date().toISOString(),
  }).eq("dedupe_key", dedupeKey);

  if (String(alertRow?.whatsapp_status || "") === "SENT") return;

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sent = await sendRawWhatsApp(phone, message);
      await ops.from("google_calendar_alerts").update({
        whatsapp_status: "SENT",
        whatsapp_message_id: sent.messageId,
        whatsapp_error: null,
        attempts: Number(alertRow?.attempts || 0) + attempt,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("dedupe_key", dedupeKey);
      return;
    } catch (error) {
      lastError = clean(error instanceof Error ? error.message : error, 1500);
      if (attempt < 3) await sleep(attempt * 800);
    }
  }
  await ops.from("google_calendar_alerts").update({
    whatsapp_status: "FAILED",
    whatsapp_error: lastError,
    attempts: Number(alertRow?.attempts || 0) + 3,
    updated_at: new Date().toISOString(),
  }).eq("dedupe_key", dedupeKey);
}

async function processEvent(account: Row, watch: Row, event: Row, since: Date) {
  if (!event?.id) return;
  const { data: previousData, error: previousError } = await ops.from("google_calendar_event_state")
    .select("*")
    .eq("account_id", account.id)
    .eq("event_id", String(event.id))
    .maybeSingle();
  if (previousError) throw previousError;
  const previous = (previousData || null) as Row | null;
  const snapshot = eventSnapshot(event, previous);

  const creatorEmail = snapshot.creatorEmail || lower(previous?.creator_email);
  const ownerEmail = lower(account?.account_email || OWNER_EMAIL);
  const createdMs = snapshot.createdAt ? Date.parse(snapshot.createdAt) : NaN;
  const externalCreator = Boolean(creatorEmail) && creatorEmail !== ownerEmail;
  const isMeetingLike = !snapshot.allDay && (!snapshot.eventType || ["default", "fromGmail"].includes(snapshot.eventType));

  let kind: "CREATED" | "RESCHEDULED" | "CANCELLED" | null = null;
  if (externalCreator && isMeetingLike) {
    if (previous) {
      if (snapshot.status === "cancelled" && String(previous.status || "") !== "cancelled") {
        kind = "CANCELLED";
      } else if (snapshot.status !== "cancelled" && (!sameInstant(previous.start_time, snapshot.startTime) || !sameInstant(previous.end_time, snapshot.endTime))) {
        kind = "RESCHEDULED";
      }
    } else if (snapshot.status !== "cancelled" && !Number.isNaN(createdMs) && createdMs >= since.getTime() - 60_000) {
      kind = "CREATED";
    }
  }

  await saveEventState(String(account.id), snapshot);
  if (kind) await emitAlert(account, kind, snapshot);
}
async function scanCalendarChanges(accountId: string, reason: string) {
  const account = await accountById(accountId);
  const access = await accessTokenFor(account);
  const { data: watch, error: watchError } = await ops.from("google_calendar_watches")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (watchError) throw watchError;
  if (!watch) throw new Error("calendar_watch_not_found");

  const scanStarted = new Date();
  const cursor = watch.last_change_scan_at ? new Date(String(watch.last_change_scan_at)) : new Date(scanStarted.getTime() - 5 * 60_000);
  const since = new Date(Math.min(scanStarted.getTime(), cursor.getTime()) - 5 * 60_000);

  let pageToken = "";
  let processed = 0;
  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("updatedMin", since.toISOString());
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("conferenceDataVersion", "1");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { headers: { authorization: "Bearer " + access } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("google_events_scan_" + response.status + ":" + clean(body?.error?.message || body, 700));

    const items = Array.isArray(body?.items) ? body.items : [];
    for (const event of items) {
      await processEvent(account, watch as Row, event as Row, since);
      processed++;
    }
    pageToken = clean(body?.nextPageToken, 1000);
  } while (pageToken);

  await ops.from("google_calendar_watches").update({
    last_change_scan_at: scanStarted.toISOString(),
    last_scan_reason: reason,
    last_scan_count: processed,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("account_id", accountId);

  await ops.from("meeting_integration_accounts").update({
    last_sync_at: scanStarted.toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", accountId);

  return { ok: true, processed, since: since.toISOString(), scanned_at: scanStarted.toISOString() };
}

async function recordWatchError(owner: string, error: unknown) {
  const message = clean(error instanceof Error ? error.message : error, 900) || "calendar_watch_failed";
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  await ops.from("platform_notifications").upsert({
    event_key: "gcal-watch-error:" + owner + ":" + day,
    type: "GOOGLE_CALENDAR_WATCH_ERROR",
    level: "WARNING",
    title: "⚠️ Monitor da Agenda Google precisa de atenção",
    description: message.includes("reconnect") || message.includes("refresh")
      ? "A autorização do Google foi revogada ou invalidada. O sistema tentou renovar automaticamente, mas agora precisa de uma nova autorização."
      : "A renovação automática do monitor da Agenda Google falhou. O sistema tentará novamente sozinho no próximo ciclo.",
    source: "google_calendar_watch",
    actor: "Sistema",
    occurred_at: now.toISOString(),
    metadata: {
      private_to_person: true,
      target_person: OWNER_PERSON,
      target_role: "MGMT",
      google_calendar_watch_error: true,
      error: message,
    },
  }, { onConflict: "event_key" });
}
async function stopOldChannel(access: string, channelId: string, resourceId: string) {
  if (!channelId || !resourceId) return;
  try {
    await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // O novo canal já está ativo; falha ao encerrar o antigo não interrompe a proteção.
  }
}
async function ensureWatch(ownerRaw: unknown, force = false) {
  const owner = clean(ownerRaw || OWNER_PERSON, 160);
  try {
    const account = await accountByOwner(owner);
    const { data: existing, error: existingError } = await ops.from("google_calendar_watches")
      .select("*")
      .eq("account_id", account.id)
      .maybeSingle();
    if (existingError) throw existingError;

    const expiresMs = existing?.expires_at ? Date.parse(String(existing.expires_at)) : 0;
    const healthy = existing?.status === "ACTIVE" && expiresMs > Date.now() + 36 * 60 * 60_000;
    if (healthy && !force) {
      return {
        ok: true,
        renewed: false,
        owner,
        account_email: account.account_email,
        expires_at: existing.expires_at,
        last_change_scan_at: existing.last_change_scan_at,
      };
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("google_oauth_not_configured");
    const access = await accessTokenFor(account);
    const channelId = crypto.randomUUID();
    const channelToken = randomToken(48);
    const tokenHash = await sha256(channelToken);
    const address = SUPABASE_URL + "/functions/v1/agency-ops-google-calendar-watch?google_calendar_webhook=1";

    const watchResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events/watch", {
      method: "POST",
      headers: {
        authorization: "Bearer " + access,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address,
        token: channelToken,
        params: { ttl: "604800" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await watchResponse.json().catch(() => ({}));
    if (!watchResponse.ok || !body?.resourceId) {
      throw new Error("google_watch_" + watchResponse.status + ":" + clean(body?.error?.message || body, 800));
    }

    const expirationMs = Number(body?.expiration || 0);
    const expiresAt = Number.isFinite(expirationMs) && expirationMs > Date.now()
      ? new Date(expirationMs).toISOString()
      : new Date(Date.now() + 6 * 86400000).toISOString();
    const now = new Date().toISOString();

    const { error: upsertError } = await ops.from("google_calendar_watches").upsert({
      account_id: account.id,
      owner_person: owner,
      calendar_id: "primary",
      channel_id: channelId,
      resource_id: clean(body.resourceId, 1000),
      resource_uri: clean(body.resourceUri, 2000) || null,
      channel_token_hash: tokenHash,
      status: "ACTIVE",
      expires_at: expiresAt,
      first_started_at: existing?.first_started_at || now,
      last_renewed_at: now,
      last_change_scan_at: existing?.last_change_scan_at || now,
      last_message_number: 0,
      last_error: null,
      updated_at: now,
    }, { onConflict: "account_id" });
    if (upsertError) throw upsertError;

    if (existing?.channel_id && existing?.resource_id) {
      try { await scanCalendarChanges(String(account.id), "watch_renewal"); } catch { /* overlap será coberto pelo próximo webhook */ }
      await stopOldChannel(access, String(existing.channel_id), String(existing.resource_id));
    }

    return {
      ok: true,
      renewed: true,
      owner,
      account_email: account.account_email,
      channel_id: channelId,
      expires_at: expiresAt,
    };
  } catch (error) {
    await recordWatchError(owner, error).catch(() => {});
    throw error;
  }
}

async function handleWebhook(req: Request) {
  const channelId = clean(req.headers.get("x-goog-channel-id"), 500);
  const resourceId = clean(req.headers.get("x-goog-resource-id"), 1000);
  const resourceState = lower(req.headers.get("x-goog-resource-state"));
  const token = clean(req.headers.get("x-goog-channel-token"), 4000);
  const messageNumberRaw = clean(req.headers.get("x-goog-message-number"), 100);
  const messageNumber = Number(messageNumberRaw || 0);

  if (!channelId || !token) return;
  const { data: watch, error } = await ops.from("google_calendar_watches")
    .select("*")
    .eq("channel_id", channelId)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (error || !watch) return;
  if (resourceId && watch.resource_id && resourceId !== String(watch.resource_id)) return;
  if (await sha256(token) !== String(watch.channel_token_hash || "")) return;
  if (Number.isFinite(messageNumber) && messageNumber > 0 && Number(watch.last_message_number || 0) >= messageNumber) return;

  if (Number.isFinite(messageNumber) && messageNumber > 0) {
    await ops.from("google_calendar_watches").update({
      last_message_number: messageNumber,
      last_resource_state: resourceState || null,
      last_webhook_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("account_id", watch.account_id);
  }

  if (resourceState === "sync") return;
  await scanCalendarChanges(String(watch.account_id), "google_webhook");
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    return json({
      ok: true,
      service: "agency-ops-google-calendar-watch",
      webhook: url.searchParams.has("google_calendar_webhook"),
    });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (url.searchParams.has("google_calendar_webhook") || req.headers.has("x-goog-channel-id")) {
    const work = handleWebhook(req).catch(async (error) => {
      await recordWatchError(OWNER_PERSON, error).catch(() => {});
      console.error("google-calendar-webhook", error);
    });
    EdgeRuntime.waitUntil(work);
    return new Response(null, { status: 204 });
  }

  if (!serviceAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const action = lower(body?.action);

  try {
    if (action === "ensure_watch") {
      return json(await ensureWatch(body?.owner_person || OWNER_PERSON, Boolean(body?.force)));
    }
    if (action === "scan_now") {
      const account = await accountByOwner(body?.owner_person || OWNER_PERSON);
      return json(await scanCalendarChanges(String(account.id), "manual_service_scan"));
    }
    if (action === "status") {
      const account = await accountByOwner(body?.owner_person || OWNER_PERSON);
      const { data: watch } = await ops.from("google_calendar_watches").select("*").eq("account_id", account.id).maybeSingle();
      return json({ ok: true, account_email: account.account_email, watch: watch || null });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    console.error("google-calendar-watch", error);
    return json({ error: clean(error instanceof Error ? error.message : error, 1200) || "internal_error" }, 500);
  }
});
