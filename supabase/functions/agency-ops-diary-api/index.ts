import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-dashboard-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function errorStatus(message: string) {
  if (message.includes("forbidden") || message.includes("profile_required")) return 403;
  if (message.includes("unauthorized")) return 401;
  if (message.includes("not_found")) return 404;
  if (message.includes("required") || message.includes("invalid") || message.includes("client_")) return 400;
  return 500;
}
function validDate(value: unknown) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return reply({ error: "server_configuration" }, 500);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "data";

  let actorUserId: string | null = null;
  let viaLogin = false;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data, error } = await authClient.auth.getUser();
    if (!error && data?.user?.id) {
      actorUserId = data.user.id;
      viaLogin = true;
    }
  }

  if (!actorUserId) {
    const suppliedKey = req.headers.get("x-dashboard-key") ?? "";
    if (suppliedKey.length >= 40) {
      const keyHash = await sha256(suppliedKey);
      const { data: keyRow } = await ops.from("dashboard_api_keys").select("active,expires_at").eq("key_hash", keyHash).maybeSingle();
      if (keyRow?.active && !(keyRow.expires_at && new Date(keyRow.expires_at) <= new Date())) {
        const { data: adminRow } = await ops.from("diary_admin_users").select("user_id").limit(1).maybeSingle();
        actorUserId = adminRow?.user_id ?? null;
      }
    }
  }
  if (!actorUserId) return reply({ error: "unauthorized" }, 401);

  const { data: adminRow } = await ops.from("diary_admin_users").select("user_id").eq("user_id", actorUserId).maybeSingle();
  const isDiaryAdmin = Boolean(adminRow?.user_id);

  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person,name")
    .eq("user_key", actorUserId)
    .maybeSingle();
  const actorPerson = pref?.collaborator_person ?? pref?.name ?? null;
  const { data: roster } = actorPerson
    ? await ops.from("team_roster").select("person,role").eq("person", actorPerson).eq("is_former", false).maybeSingle()
    : { data: null } as any;
  const actorRole = String(roster?.role ?? "").toUpperCase() || null;
  const gabrielTasklogOnly = actorPerson === "Gabriel Castro" && actorRole === "AI";

  if (viaLogin && !isDiaryAdmin) {
    const { data: approvals } = await ops.from("access_requests")
      .select("kind,status")
      .eq("user_key", actorUserId)
      .eq("kind", "SIGNUP")
      .eq("status", "APPROVED");
    if (!actorPerson || !(approvals ?? []).length || !roster) return reply({ error: "forbidden" }, 403);
    const { data: allowedViews, error: viewsError } = await ops.rpc("dashboard_allowed_views", { p_person: roster.person, p_role: roster.role });
    if (viewsError || !Array.isArray(allowedViews) || !allowedViews.includes("diary")) return reply({ error: "forbidden" }, 403);
  }

  if (req.method === "GET") {
    if (view === "self-performance") {
      if (!actorPerson) return reply({ error: "profile_required" }, 403);

      const currentYear = Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
      }).format(new Date()));
      const sinceYear = currentYear - 1;
      const { data: rows, error } = await ops.from("op_perf_daily_activity")
        .select("activity_date,source,events")
        .eq("person", actorPerson)
        .gte("activity_date", `${sinceYear}-01-01`)
        .lte("activity_date", `${currentYear}-12-31`)
        .order("activity_date", { ascending: true });
      if (error) return reply({ error: "performance_query_failed", detail: error.message }, 500);

      const activity: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const years = new Set<number>([currentYear]);
      for (const row of rows ?? []) {
        const day = String(row.activity_date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const events = Number(row.events ?? 0);
        activity[day] = (activity[day] ?? 0) + events;
        const source = String(row.source ?? "other");
        bySource[source] = (bySource[source] ?? 0) + events;
        const year = Number(day.slice(0, 4));
        if (Number.isFinite(year)) years.add(year);
      }

      return reply({
        person: actorPerson,
        activity,
        by_source: bySource,
        years: [...years].sort((a, b) => b - a),
        generated_at: new Date().toISOString(),
      });
    }

    if (view !== "data") return reply({ error: "unknown_view" }, 404);
    const requestedScope = url.searchParams.get("scope") === "all" ? "all" : "mine";
    const scope = gabrielTasklogOnly ? "mine" : requestedScope;
    if (scope === "all" && !isDiaryAdmin) return reply({ error: "forbidden" }, 403);
    const filterKeys = ["author_user_id", "client_id", "category_code", "subcategory_code", "responsible_area", "status", "since", "until"];
    const filters: Record<string, string> = {};
    for (const key of filterKeys) {
      const value = url.searchParams.get(key);
      if (value) filters[key] = value;
    }
    const { data, error } = await ops.rpc("diary_get", { p_actor: actorUserId, p_scope: scope, p_filters: filters });
    if (error) return reply({ error: "diary_query_failed", detail: error.message }, errorStatus(error.message));

    const base = data && typeof data === "object"
      ? data as Record<string, any>
      : { adjustments: [], task_log: [], counts: { adjustments: 0, tasks: 0 } };

    if (gabrielTasklogOnly) {
      const taskLog = Array.isArray(base.task_log) ? base.task_log : [];
      return reply({
        tasklog_only: true,
        actor_role: actorRole,
        adjustments: [],
        task_log: taskLog,
        daily_reports: [],
        clients: [],
        categories: [],
        subcategories: [],
        staff: [],
        can_view_all: false,
        counts: { adjustments: 0, tasks: Number(base.counts?.tasks ?? taskLog.length), reports: 0 },
      });
    }

    let dailyReports: any[] = [];
    if (actorRole === "DESIGN" || isDiaryAdmin) {
      if (!(scope === "all" && filters.author_user_id === "UNKNOWN")) {
        let reportsQuery = ops.from("designer_daily_reports")
          .select("id,author_user_id,author_name,report_date,report_text,created_at,updated_at")
          .order("report_date", { ascending: false })
          .order("updated_at", { ascending: false });
        if (scope === "mine") reportsQuery = reportsQuery.eq("author_user_id", actorUserId);
        else if (filters.author_user_id) reportsQuery = reportsQuery.eq("author_user_id", filters.author_user_id);
        if (filters.since) reportsQuery = reportsQuery.gte("report_date", filters.since);
        if (filters.until) reportsQuery = reportsQuery.lte("report_date", filters.until);
        const { data: reportRows, error: reportError } = await reportsQuery.limit(250);
        if (reportError) return reply({ error: "daily_report_query_failed", detail: reportError.message }, 500);
        dailyReports = reportRows ?? [];
      }
    }

    return reply({
      ...base,
      daily_reports: dailyReports,
      counts: { ...(base.counts ?? {}), reports: dailyReports.length },
      actor_role: actorRole,
    });
  }

  const body = await req.json().catch(() => ({}));
  if (view === "adjustment-create") {
    if (gabrielTasklogOnly) return reply({ error: "forbidden_tasklog_only" }, 403);
    const { data, error } = await ops.rpc("diary_create_adjustment", { p_actor: actorUserId, p_payload: body });
    if (error) return reply({ error: "adjustment_create_failed", detail: error.message }, errorStatus(error.message));
    return reply({ ok: true, adjustment: data });
  }
  if (view === "adjustment-update") {
    if (gabrielTasklogOnly) return reply({ error: "forbidden_tasklog_only" }, 403);
    const id = Number(body.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) return reply({ error: "missing_fields", required: ["id"] }, 400);
    const patch = { ...body };
    delete patch.id;
    const { data, error } = await ops.rpc("diary_update_adjustment", { p_actor: actorUserId, p_id: id, p_patch: patch });
    if (error) return reply({ error: "adjustment_update_failed", detail: error.message }, errorStatus(error.message));
    return reply({ ok: true, adjustment: data });
  }
  if (view === "tasklog-create") {
    const { data, error } = await ops.rpc("diary_create_tasklog", { p_actor: actorUserId, p_payload: body });
    if (error) return reply({ error: "tasklog_create_failed", detail: error.message }, errorStatus(error.message));
    return reply({ ok: true, entry: data });
  }
  if (view === "daily-report-save") {
    if (gabrielTasklogOnly) return reply({ error: "forbidden_tasklog_only" }, 403);
    if (actorRole !== "DESIGN" || !actorPerson) return reply({ error: "forbidden_designer_only" }, 403);
    const reportDate = String(body.report_date ?? "").trim();
    const reportText = String(body.report_text ?? "").trim();
    if (!validDate(reportDate)) return reply({ error: "invalid_report_date" }, 400);
    if (!reportText) return reply({ error: "report_text_required" }, 400);
    if (reportText.length > 20000) return reply({ error: "report_text_too_long", max: 20000 }, 400);

    const { data: report, error } = await ops.from("designer_daily_reports").upsert({
      author_user_id: actorUserId,
      author_name: actorPerson,
      report_date: reportDate,
      report_text: reportText,
      updated_at: new Date().toISOString(),
    }, { onConflict: "author_user_id,report_date" })
      .select("id,author_user_id,author_name,report_date,report_text,created_at,updated_at")
      .maybeSingle();
    if (error) return reply({ error: "daily_report_save_failed", detail: error.message }, 500);
    return reply({ ok: true, report });
  }
  return reply({ error: "unknown_action" }, 404);
});
