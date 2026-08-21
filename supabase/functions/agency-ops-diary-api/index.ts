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

  // O ator nunca vem do body/querystring. Login: UUID extraido do JWT verificado.
  // Chave legada: resolve exclusivamente o UUID previamente cadastrado como admin do Diario.
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

  // Um JWT valido sozinho nao basta: colaborador comum precisa estar ativo, aprovado
  // e possuir a aba Diario nas permissoes atuais. Adler continua identificado pelo UUID
  // administrativo estavel de diary_admin_users.
  if (viaLogin && !isDiaryAdmin) {
    const [{ data: pref }, { data: approvals }] = await Promise.all([
      ops.from("user_preferences").select("collaborator_person,name").eq("user_key", actorUserId).maybeSingle(),
      ops.from("access_requests").select("kind,status").eq("user_key", actorUserId).eq("kind", "SIGNUP").eq("status", "APPROVED"),
    ]);
    const person = pref?.collaborator_person ?? pref?.name ?? null;
    if (!person || !(approvals ?? []).length) return reply({ error: "forbidden" }, 403);
    const { data: roster } = await ops.from("team_roster").select("person,role").eq("person", person).eq("is_former", false).maybeSingle();
    if (!roster) return reply({ error: "forbidden" }, 403);
    const { data: allowedViews, error: viewsError } = await ops.rpc("dashboard_allowed_views", { p_person: roster.person, p_role: roster.role });
    if (viewsError || !Array.isArray(allowedViews) || !allowedViews.includes("diary")) return reply({ error: "forbidden" }, 403);
  }

  if (req.method === "GET") {
    if (view === "self-performance") {
      // Nao aceitamos nome de colaborador na URL: a pessoa vem exclusivamente da sessao autenticada.
      const { data: pref } = await ops.from("user_preferences")
        .select("collaborator_person,name")
        .eq("user_key", actorUserId)
        .maybeSingle();
      const person = pref?.collaborator_person ?? pref?.name ?? null;
      if (!person) return reply({ error: "profile_required" }, 403);

      const currentYear = Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
      }).format(new Date()));
      const sinceYear = currentYear - 1;
      const { data: rows, error } = await ops.from("op_perf_daily_activity")
        .select("activity_date,source,events")
        .eq("person", person)
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
        person,
        activity,
        by_source: bySource,
        years: [...years].sort((a, b) => b - a),
        generated_at: new Date().toISOString(),
      });
    }

    if (view !== "data") return reply({ error: "unknown_view" }, 404);
    const scope = url.searchParams.get("scope") === "all" ? "all" : "mine";
    if (scope === "all" && !isDiaryAdmin) return reply({ error: "forbidden" }, 403);
    const filterKeys = ["author_user_id", "client_id", "category_code", "subcategory_code", "responsible_area", "status", "since", "until"];
    const filters: Record<string, string> = {};
    for (const key of filterKeys) {
      const value = url.searchParams.get(key);
      if (value) filters[key] = value;
    }
    const { data, error } = await ops.rpc("diary_get", { p_actor: actorUserId, p_scope: scope, p_filters: filters });
    if (error) return reply({ error: "diary_query_failed", detail: error.message }, errorStatus(error.message));
    return reply(data ?? { adjustments: [], task_log: [], counts: { adjustments: 0, tasks: 0 } });
  }

  const body = await req.json().catch(() => ({}));
  if (view === "adjustment-create") {
    const { data, error } = await ops.rpc("diary_create_adjustment", { p_actor: actorUserId, p_payload: body });
    if (error) return reply({ error: "adjustment_create_failed", detail: error.message }, errorStatus(error.message));
    return reply({ ok: true, adjustment: data });
  }
  if (view === "adjustment-update") {
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
  return reply({ error: "unknown_action" }, 404);
});