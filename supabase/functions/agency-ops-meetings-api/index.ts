import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
type Row = Record<string, any>;

function sanitizeSearch(value: string) {
  return value.replace(/[,%()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200, cache = "private, max-age=60") => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403, "no-store");
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405, "no-store");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500, "no-store");
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401, "no-store");
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401, "no-store");

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403, "no-store");
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return reply({ error: "profile_not_found" }, 403, "no-store");
  const role = String(roster.role || "").toUpperCase();
  const isAdler = person === "Adler Furtado";
  const isLeonardo = person === "Leonardo Augusto" && role === "COMMERCIAL";
  if (!(isAdler || isLeonardo || ["GT", "CS", "MGMT"].includes(role))) return reply({ error: "forbidden" }, 403, "no-store");
  const elevated = (approvals || []).some((row: Row) => row.kind === "ELEVATION");

  const url = new URL(req.url);
  const transcriptId = Number(url.searchParams.get("transcript_id") || 0);
  const clientId = String(url.searchParams.get("client_id") || "").trim();

  if (transcriptId > 0) {
    let q = ops.from("meeting_transcripts").select("id,client_id,client_name_raw,source_system,source_file_name,source_url,meeting_code,meeting_started_at,meeting_ended_at,duration_seconds,transcript_text,transcript_chars,participants,summary,decisions,commitments,ai_signals,metadata,capture_session_id,created_at").eq("id", transcriptId);
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q.maybeSingle();
    if (error) return reply({ error: "query_failed" }, 500, "no-store");
    if (!data) return reply({ error: "not_found" }, 404, "no-store");
    if (role === "GT" && !elevated) {
      const { data: client } = await ops.from("clients").select("gt_owner").eq("id", data.client_id).maybeSingle();
      if (!client || String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403, "no-store");
    }
    const [{ data: segments, error: segmentsError }, { data: captureSession, error: sessionError }] = await Promise.all([
      ops.from("meeting_transcript_segments")
        .select("sequence_no,started_ms,ended_ms,speaker_key,speaker_name,text,confidence,source")
        .eq("transcript_id", data.id)
        .order("sequence_no", { ascending: true }),
      data.capture_session_id
        ? ops.from("meeting_capture_sessions")
            .select("id,audio_status,audio_source,audio_mixed_path,audio_duration_ms,audio_size_bytes,audio_mime_type,audio_last_error,audio_updated_at")
            .eq("id", data.capture_session_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (segmentsError || sessionError) return reply({ error: "detail_query_failed" }, 500, "no-store");

    let audio: Row | null = captureSession ? { ...captureSession, signed_url: null, download_url: null } : null;
    if (captureSession?.audio_status === "READY" && captureSession?.audio_mixed_path) {
      const storage = db.storage.from("relato-call-audio");
      const extension = String(captureSession.audio_mime_type || "").includes("mpeg") ? "mp3" : "webm";
      const [{ data: signed, error: signedError }, { data: downloadSigned, error: downloadError }] = await Promise.all([
        storage.createSignedUrl(String(captureSession.audio_mixed_path), 900, { download: false }),
        storage.createSignedUrl(String(captureSession.audio_mixed_path), 900, { download: "relato-reuniao." + extension }),
      ]);
      if (!signedError && signed?.signedUrl) {
        audio = {
          ...audio,
          signed_url: signed.signedUrl,
          download_url: !downloadError && downloadSigned?.signedUrl ? downloadSigned.signedUrl : signed.signedUrl,
          download_name: "relato-reuniao." + extension,
          expires_in: 900,
        };
      } else if (audio) {
        audio.signed_url_error = signedError?.message || "signed_url_failed";
      }
    }

    return reply({
      transcript: data,
      segments: segments || [],
      audio,
      generated_at: new Date().toISOString(),
    }, 200, "private, max-age=30");
  }

  const rawLimit = Number(url.searchParams.get("limit") || 30);
  const limit = Math.max(10, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 30));
  const offset = Math.max(0, Math.min(1000, Number(url.searchParams.get("offset") || 0) || 0));
  const search = sanitizeSearch(String(url.searchParams.get("q") || ""));
  const from = String(url.searchParams.get("from") || "").trim();
  const to = String(url.searchParams.get("to") || "").trim();

  let allowedClientIds: string[] | null = null;
  if (role === "GT" && !elevated) {
    const { data: owned, error } = await ops.from("clients").select("id").eq("gt_owner", person).in("lifecycle", ["ACTIVE", "ONBOARDING"]);
    if (error) return reply({ error: "query_failed" }, 500, "no-store");
    allowedClientIds = (owned || []).map((row: Row) => String(row.id));
    if (!allowedClientIds.length) return reply({ records: [], count: 0, has_more: false, generated_at: new Date().toISOString() });
  }

  let q = ops.from("meeting_transcripts")
    .select("id,client_id,client_name_raw,source_system,source_file_name,source_url,meeting_code,meeting_started_at,transcript_chars,participants,summary,decisions,commitments,ai_signals,metadata,created_at", { count: "exact" })
    .order("meeting_started_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (allowedClientIds) q = q.in("client_id", allowedClientIds);
  if (clientId) q = q.eq("client_id", clientId);
  if (from) q = q.gte("meeting_started_at", from);
  if (to) q = q.lte("meeting_started_at", to);
  if (search) q = q.or(`client_name_raw.ilike.%${search}%,source_file_name.ilike.%${search}%,summary.ilike.%${search}%`);
  const { data, error, count } = await q;
  if (error) return reply({ error: "query_failed", detail: error.message }, 500, "no-store");
  const records = data || [];
  return reply({
    records,
    count: count || 0,
    has_more: offset + records.length < (count || 0),
    limit,
    offset,
    generated_at: new Date().toISOString(),
    policy: { transcript_on_demand: true, polling: false, cache_seconds: 60 },
  });
});
