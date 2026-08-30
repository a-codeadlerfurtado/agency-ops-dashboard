import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")), minute: Number(get("minute")), weekday: get("weekday"),
  };
}

const dateKey = (p: { year: number; month: number; day: number }) =>
  `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

function previousBusinessDate(current: { year: number; month: number; day: number }) {
  const cursor = new Date(Date.UTC(current.year, current.month - 1, current.day, 12));
  do cursor.setUTCDate(cursor.getUTCDate() - 1);
  while ([0, 6].includes(cursor.getUTCDay()));
  return `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
}

function cutoffIso(day: string) { return new Date(`${day}T08:30:00-03:00`).toISOString(); }
function currentEdition(now = new Date()) {
  const p = localParts(now);
  const isWeekend = p.weekday === "Sat" || p.weekday === "Sun";
  const afterCutoff = p.hour > 8 || (p.hour === 8 && p.minute >= 30);
  const editionDate = dateKey(p);
  return { editionDate, isWeekend, afterCutoff, start: cutoffIso(previousBusinessDate(p)), end: cutoffIso(editionDate) };
}
function visibleForRole(row: any, role: string) {
  if (role === "MGMT") return true;
  const roles = Array.isArray(row?.target_roles) ? row.target_roles : [];
  return roles.includes("ALL") || roles.includes(role);
}

const UPDATE_FIELDS = "sha,committed_at,title,added,fixed,removed,explanation,target_roles,subject,summary_source,release_status,reverts_sha,reverted_by_sha";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ ok: false, error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle();
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person) return reply({ ok: false, error: "profile_not_configured" }, 403);
  if (person === "Leonardo Augusto") return reply({ ok: true, allowed: false, excluded: true, reason: "profile_excluded" });

  const { data: roster } = await ops.from("team_roster").select("role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ ok: false, error: "inactive_profile" }, 403);
  const role = String(roster.role || "").toUpperCase();
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "CHECK").toUpperCase();
  const edition = currentEdition();

  if (action === "HISTORY") {
    const limit = Math.max(10, Math.min(200, Number(body?.limit || 120)));
    const { data: rows, error } = await ops.from("system_update_commits")
      .select(UPDATE_FIELDS)
      .order("committed_at", { ascending: false })
      .limit(limit);
    if (error) return reply({ ok: false, error: "history_query_failed", detail: error.message }, 500);
    const updates = (rows || []).filter((row: any) => visibleForRole(row, role));
    return reply({ ok: true, allowed: true, mode: "HISTORY", person, role, updates });
  }

  if (action === "ACK_PREVIEW") {
    await ops.from("system_update_preview_queue").update({ dismissed_at: new Date().toISOString() }).eq("user_key", user.id);
    return reply({ ok: true });
  }

  if (action === "MARK_SHOWN" || action === "DISMISS_DAILY") {
    const requestedDate = String(body?.edition_date || "");
    if (requestedDate !== edition.editionDate) return reply({ ok: false, error: "invalid_edition" }, 400);
    const shas = Array.isArray(body?.commit_shas)
      ? body.commit_shas.map(String).filter((sha: string) => /^[0-9a-f]{40}$/i.test(sha)).slice(0, 100)
      : [];
    const payload: any = { user_key: user.id, edition_date: requestedDate, commit_shas: shas, shown_at: new Date().toISOString() };
    if (action === "DISMISS_DAILY") payload.dismissed_at = new Date().toISOString();
    const { error } = await ops.from("system_update_receipts").upsert(payload, { onConflict: "user_key,edition_date" });
    if (error) return reply({ ok: false, error: "receipt_write_failed" }, 500);
    return reply({ ok: true });
  }

  if (action !== "CHECK") return reply({ ok: false, error: "unknown_action" }, 400);

  const { data: preview } = await ops.from("system_update_preview_queue")
    .select("enabled,commit_limit,dismissed_at").eq("user_key", user.id).maybeSingle();
  if (preview?.enabled && !preview?.dismissed_at && person === "Adler Furtado") {
    const limit = Math.max(1, Math.min(12, Number(preview.commit_limit || 6)));
    const { data: commits, error } = await ops.from("system_update_commits")
      .select(UPDATE_FIELDS).order("committed_at", { ascending: false }).limit(limit);
    if (error) return reply({ ok: false, error: "preview_query_failed" }, 500);
    if ((commits || []).length) return reply({ ok: true, allowed: true, mode: "PREVIEW_STACK", preview: true, person, role, edition_date: edition.editionDate, updates: commits });
  }

  if (edition.isWeekend || !edition.afterCutoff) {
    return reply({ ok: true, allowed: true, mode: "NONE", reason: edition.isWeekend ? "weekend" : "before_0830", person, role });
  }

  const { data: receipt } = await ops.from("system_update_receipts")
    .select("shown_at,dismissed_at").eq("user_key", user.id).eq("edition_date", edition.editionDate).maybeSingle();
  if (receipt?.shown_at) return reply({ ok: true, allowed: true, mode: "NONE", reason: "already_shown", person, role });

  const { data: rows, error } = await ops.from("system_update_commits")
    .select(UPDATE_FIELDS)
    .gt("committed_at", edition.start).lte("committed_at", edition.end)
    .order("committed_at", { ascending: true }).limit(100);
  if (error) return reply({ ok: false, error: "updates_query_failed" }, 500);
  const updates = (rows || []).filter((row: any) => visibleForRole(row, role));
  if (!updates.length) return reply({ ok: true, allowed: true, mode: "NONE", reason: "no_relevant_updates", person, role, edition_date: edition.editionDate });

  return reply({ ok: true, allowed: true, mode: "DAILY", person, role, edition_date: edition.editionDate, window_start: edition.start, window_end: edition.end, updates });
});
