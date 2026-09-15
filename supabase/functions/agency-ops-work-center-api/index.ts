import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "cache-control": "no-store",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return reply({ error: "unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } });
  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = admin.schema("agency_ops");

  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return reply({ error: "unauthorized" }, 401);

  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", user.id)
    .maybeSingle();
  const person = String(pref?.collaborator_person || "").trim();
  if (!person) return reply({ error: "profile_not_found" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,is_former")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return reply({ error: "profile_not_found" }, 403);
  const role = String(roster.role || "").trim();
  const isAdler = person === "Adler Furtado";

  if (person === "Gabriel Castro") {
    const scopeUrl = `${supabaseUrl}/functions/v1/agency-ops-dashboard-scope?view=${req.method === "GET" ? "work" : "work-item-update"}&client=hotfix-20260824`;
    const bodyText = req.method === "POST" ? await req.text() : undefined;
    const response = await fetch(scopeUrl, {
      method: req.method,
      headers: { Authorization: auth, apikey: anonKey, ...(bodyText ? { "content-type": "application/json" } : {}) },
      body: bodyText,
    });
    return new Response(response.body, { status: response.status, headers: { ...CORS, "content-type": response.headers.get("content-type") || "application/json" } });
  }

  if (!isAdler) {
    const { data: allowedViews, error: viewError } = await ops.rpc("dashboard_allowed_views", { p_person: person, p_role: role });
    if (viewError || !Array.isArray(allowedViews) || !allowedViews.includes("work")) {
      return reply({ error: "forbidden" }, 403);
    }
  }

  const canAccess = (row: any) => {
    if (isAdler) return true;
    const targetPerson = String(row?.target_person || "").trim();
    if (targetPerson) return targetPerson === person;
    const targetRole = String(row?.target_role || "").trim();
    return Boolean(targetRole) && targetRole === role;
  };

  if (req.method === "GET") {
    const { data, error } = await ops.from("work_items")
      .select("*,clients(display_name,gt_owner,cs_owner,designer_owner)")
      .order("created_at", { ascending: false })
      .limit(800);
    if (error) return reply({ error: "query_failed" }, 500);

    const rows = (data || []).filter(canAccess);
    const open = rows.filter((row: any) => !["COMPLETED", "DISMISSED"].includes(String(row.status)));
    const { data: rosterRows } = await ops.from("team_roster").select("person,role").eq("is_former", false).order("person");

    return reply({
      items: rows,
      summary: {
        open: open.length,
        critical: open.filter((row: any) => row.priority === "CRITICAL").length,
        overdue: open.filter((row: any) => row.due_at && new Date(row.due_at).getTime() < Date.now()).length,
        waiting: open.filter((row: any) => ["WAITING", "SNOOZED"].includes(String(row.status))).length,
        completed_30d: rows.filter((row: any) => row.status === "COMPLETED" && row.completed_at && new Date(row.completed_at).getTime() >= Date.now() - 30 * 86400000).length,
      },
      roster: rosterRows || [],
      scope: { person, role, model: isAdler ? "ALL" : "ASSIGNEE_ONLY" },
      generated_at: new Date().toISOString(),
    });
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "work-item-update");
  if (action !== "work-item-update") return reply({ error: "unknown_action" }, 404);

  const id = String(body?.id || "").trim();
  if (!id) return reply({ error: "missing_fields", required: ["id"] }, 400);
  const { data: current, error: currentError } = await ops.from("work_items").select("*").eq("id", id).maybeSingle();
  if (currentError) return reply({ error: "query_failed" }, 500);
  if (!current) return reply({ error: "not_found" }, 404);
  if (!canAccess(current)) return reply({ error: "forbidden" }, 403);

  const coreUrl = `${supabaseUrl}/functions/v1/agency-ops-dashboard-api?view=work-item-update&client=hotfix-20260824`;
  const response = await fetch(coreUrl, {
    method: "POST",
    headers: { Authorization: auth, apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { ...CORS, "content-type": response.headers.get("content-type") || "application/json" },
  });
});
