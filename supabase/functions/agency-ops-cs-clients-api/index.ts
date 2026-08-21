import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const { data: preference } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userData.user.id)
    .maybeSingle();
  const person = preference?.collaborator_person ?? null;
  if (!person) return respond({ error: "collaborator_required" }, 403);

  const [{ data: roster }, { data: signupApproval }] = await Promise.all([
    ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userData.user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1).maybeSingle(),
  ]);

  if (!roster || roster.is_former || roster.role !== "CS" || !signupApproval) return respond({ error: "forbidden" }, 403);

  const { data: clients, error } = await ops.from("dashboard_client_overview")
    .select("*")
    .order("display_name", { ascending: true })
    .limit(400);
  if (error) return respond({ error: "query_failed", detail: error.message }, 500);

  return respond({ clients: clients ?? [], generated_at: new Date().toISOString() });
});
