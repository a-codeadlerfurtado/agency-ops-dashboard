import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);

const CORS_BASE = {
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const WAITING_REASONS = new Set([
  "CLIENT",
  "GT",
  "CS",
  "DESIGN",
  "APPROVAL",
  "TECHNICAL",
  "OTHER",
]);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed
    ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" }
    : CORS_BASE;
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return respond({ error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userData.user.id)
    .maybeSingle();
  const person = pref?.collaborator_person ?? null;
  if (!person) return respond({ error: "collaborator_required" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return respond({ error: "collaborator_not_active" }, 403);

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const waitingReason = String(body.waiting_reason ?? "").toUpperCase();
  if (!id || !WAITING_REASONS.has(waitingReason)) {
    return respond({ error: "missing_or_invalid_fields", required: ["id", "waiting_reason"] }, 400);
  }

  const { data: current, error: currentError } = await ops.from("work_items").select("*").eq("id", id).maybeSingle();
  if (currentError) return respond({ error: "query_failed" }, 500);
  if (!current) return respond({ error: "not_found" }, 404);

  const canAct = person === "Adler Furtado"
    || current.created_by_person === person
    || current.target_person === person
    || (!current.target_person && current.target_role === roster.role);
  if (!canAct) return respond({ error: "forbidden" }, 403);

  const now = new Date().toISOString();
  const { data: item, error: updateError } = await ops.from("work_items")
    .update({
      status: "WAITING",
      waiting_reason: waitingReason,
      waiting_since: now,
      snoozed_until: null,
    })
    .eq("id", id)
    .select()
    .single();
  if (updateError) return respond({ error: "query_failed" }, 500);

  return respond({ ok: true, item });
});
