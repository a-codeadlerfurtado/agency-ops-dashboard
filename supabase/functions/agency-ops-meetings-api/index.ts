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
  const ownerPerson = String(url.searchParams.get("owner_person") || "").trim().slice(0, 160);

  if (transcriptId > 0) {
    let q = ops.from("meeting_transcripts").select("id,client_id,client_name_raw,source_system,source_file_name,source_url,meeting_code,meeting_started_at,meeting_ended_at,duration_seconds,transcript_text,transcript_chars,participants,summary,decisions,commitments,ai_signals,metadata,created_at,owner_person,processing_status,transcript_source,capture_session_id,match_status,match_confidence").eq("id", transcriptId);
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q.maybeSingle();
    if (error) return reply({ error: "query_failed" }, 500, "no-store");
    if (!data) return reply({ error: "not_found" }, 404, "no-store");
    if (role === "GT" && !elevated) {
      const { data: client } = await ops.from("clients").select("gt_owner").eq("id", data.client_id).maybeSingle();
      if (!client || String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403, "no-store");
    }
    const { data: segments } = await ops.from("meeting_transcript_segments")
      .select("sequence_no,started_ms,ended_ms,speaker_key,speaker_name,device_id,message_id,message_version,text,confidence,source")
      .eq("transcript_id", transcriptId)
      .order("sequence_no", { ascending: true })
      .limit(20000);
    let clientContext: Row | null = null;
    if (data.client_id) {
      const [{ data: dossier }, { data: notes }, { data: briefings }] = await Promise.all([
        ops.from("client_dossier").select("client_id,display_name,lifecycle,service,cs_owner,gt_owner,designer_owner,onboarding_stage,onboarding_risk,onboarding_blocked_by,health_score,health_band,complaints_total,commitments_open,alerts_open,waiting_for_agency,waiting_for_client,whatsapp_sla,conversation_status,last_actor").eq("client_id", data.client_id).maybeSingle(),
        ops.from("client_notes").select("id,title,body,note_type,importance,is_pinned,created_by_person,updated_at").eq("client_id", data.client_id).is("archived_at", null).eq("use_as_ai_context", true).order("is_pinned", { ascending: false }).order("updated_at", { ascending: false }).limit(8),
        ops.from("notion_briefing_pages").select("title,page_url,extracted_profile,notion_last_edited_at").eq("client_id", data.client_id).order("notion_last_edited_at", { ascending: false }).limit(3),
      ]);
      clientContext = { dossier: dossier || null, notes: notes || [], briefings: briefings || [] };
    }
    return reply({ transcript: { ...data, segments: segments || [], client_context: clientContext }, generated_at: new Date().toISOString() }, 200, "private, max-age=300");
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
    .select("id,client_id,client_name_raw,source_system,source_file_name,source_url,meeting_code,meeting_started_at,meeting_ended_at,duration_seconds,transcript_chars,participants,summary,decisions,commitments,ai_signals,metadata,created_at,owner_person,processing_status,transcript_source,match_status,match_confidence", { count: "exact" })
    .order("meeting_started_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (allowedClientIds) q = q.in("client_id", allowedClientIds);
  if (clientId) q = q.eq("client_id", clientId);
  if (ownerPerson) q = q.eq("owner_person", ownerPerson);
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
