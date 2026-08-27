import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const json = (body: unknown, status = 200, cors: Record<string,string> = CORS_BASE) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed
    ? { ...CORS_BASE, "access-control-allow-origin": origin, "vary": "Origin" }
    : CORS_BASE;

  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return json({ ok: false, error: "origin_not_allowed" }, 403, cors);
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const contentType = req.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) return json({ ok: false, error: "content_type_required" }, 415, cors);
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024) return json({ ok: false, error: "payload_too_large" }, 413, cors);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500, cors);

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = admin.schema("agency_ops");
  const userKey = userData.user.id;

  const [{ data: pref }, { data: approval }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(pref?.collaborator_person || "").trim();
  if (!person || !(approval || []).length) return json({ ok: false, error: "forbidden" }, 403, cors);

  const { data: actor } = await ops.from("team_roster")
    .select("person,role,access_level,is_former")
    .eq("person", person)
    .maybeSingle();
  if (!actor || actor.is_former) return json({ ok: false, error: "forbidden" }, 403, cors);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: "invalid_json" }, 400, cors);
  const workItemId = String(body.work_item_id || body.id || "").trim();
  const targetPerson = String(body.target_person || "").trim();
  const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 1000);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workItemId)) {
    return json({ ok: false, error: "invalid_work_item_id" }, 400, cors);
  }
  if (!targetPerson || targetPerson.length > 160) return json({ ok: false, error: "invalid_target_person" }, 400, cors);

  const { data: item, error: itemError } = await ops.from("work_items")
    .select("id,status,target_role,target_person,created_by_person,client_id,title")
    .eq("id", workItemId)
    .maybeSingle();
  if (itemError) return json({ ok: false, error: "query_failed" }, 500, cors);
  if (!item) return json({ ok: false, error: "not_found" }, 404, cors);

  const actorRole = String(actor.role || "").toUpperCase();
  const canReassign = actorRole === "MGMT"
    || String(item.target_person || "") === person
    || String(item.created_by_person || "") === person
    || (!item.target_person && String(item.target_role || "").toUpperCase() === actorRole);
  if (!canReassign) return json({ ok: false, error: "forbidden" }, 403, cors);
  if (["COMPLETED", "DISMISSED"].includes(String(item.status || "").toUpperCase())) {
    return json({ ok: false, error: "work_item_closed" }, 409, cors);
  }

  const { data: target, error: targetError } = await ops.from("team_roster")
    .select("person,role,is_former")
    .eq("person", targetPerson)
    .maybeSingle();
  if (targetError) return json({ ok: false, error: "query_failed" }, 500, cors);
  if (!target || target.is_former) return json({ ok: false, error: "target_not_active" }, 400, cors);
  if (!["GT", "CS", "DESIGN", "AI", "MGMT"].includes(String(target.role || "").toUpperCase())) {
    return json({ ok: false, error: "target_has_no_work_center" }, 400, cors);
  }

  const { data: result, error: rpcError } = await ops.rpc("reassign_work_item", {
    p_work_item_id: workItemId,
    p_new_target_person: targetPerson,
    p_actor_user_key: userKey,
    p_actor_person: person,
    p_reason: reason,
  });

  if (rpcError) {
    const detail = String(rpcError.message || "");
    const status = detail.includes("WORK_ITEM_NOT_FOUND") ? 404
      : detail.includes("WORK_ITEM_ALREADY_CLOSED") ? 409
      : detail.includes("WORK_ITEM_ALREADY_ASSIGNED_TO_TARGET") ? 409
      : detail.includes("WORK_ITEM_ASSIGNEE") ? 400
      : 500;
    const error = detail.includes("WORK_ITEM_ALREADY_ASSIGNED_TO_TARGET") ? "already_assigned"
      : detail.includes("WORK_ITEM_ALREADY_CLOSED") ? "work_item_closed"
      : detail.includes("WORK_ITEM_NOT_FOUND") ? "not_found"
      : detail.includes("WORK_ITEM_ASSIGNEE_HAS_NO_WORK_CENTER") ? "target_has_no_work_center"
      : detail.includes("WORK_ITEM_ASSIGNEE_NOT_ACTIVE") ? "target_not_active"
      : "reassign_failed";
    return json({ ok: false, error }, status, cors);
  }

  return json({
    ok: true,
    ...result,
    reassigned_by: person,
    target: { person: target.person, role: target.role },
  }, 200, cors);
});
