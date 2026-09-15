import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);

const CORS_BASE = {
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};

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
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

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
  const person = String(pref?.collaborator_person || "").trim();
  if (!person) return respond({ ok: true, enabled: false, alert: null });

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,is_former")
    .eq("person", person)
    .maybeSingle();
  if (!roster || roster.is_former || roster.role !== "CS") {
    return respond({ ok: true, enabled: false, alert: null });
  }

  if (req.method === "GET") {
    const { data: alert, error } = await ops.from("churned_client_message_warnings")
      .select("id,client_id,client_name,chat_name,target_person,actor_name,message_type,message_text,message_at,churned_at,is_good_morning,created_at")
      .eq("target_person", person)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return respond({ error: "query_failed" }, 500);
    return respond({ ok: true, enabled: true, alert: alert || null });
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "").toUpperCase();
  const id = String(body.id || "");
  if (action !== "ACK" || !id) return respond({ error: "missing_or_invalid_fields" }, 400);

  const { data: current, error: currentError } = await ops.from("churned_client_message_warnings")
    .select("id,target_person,acknowledged_at")
    .eq("id", id)
    .maybeSingle();
  if (currentError) return respond({ error: "query_failed" }, 500);
  if (!current) return respond({ error: "not_found" }, 404);
  if (current.target_person !== person) return respond({ error: "forbidden" }, 403);

  if (!current.acknowledged_at) {
    const { error: updateError } = await ops.from("churned_client_message_warnings")
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: person })
      .eq("id", id)
      .eq("target_person", person);
    if (updateError) return respond({ error: "query_failed" }, 500);
  }

  return respond({ ok: true });
});
