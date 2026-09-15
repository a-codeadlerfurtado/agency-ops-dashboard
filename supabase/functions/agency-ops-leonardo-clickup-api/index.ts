import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !anon || !service) return reply({ error: "server_configuration" }, 500);

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);

  const auth = createClient(url, anon, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: preference }, { data: signup }] = await Promise.all([
    ops.from("user_preferences").select("name,collaborator_person").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(preference?.collaborator_person || preference?.name || "").trim();
  if (person !== "Leonardo Augusto" || !(signup || []).length) return reply({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former || String(roster.role).toUpperCase() !== "COMMERCIAL") return reply({ error: "forbidden" }, 403);

  const { data, error } = await ops.rpc("get_clickup_executive_aggregate");
  if (error) return reply({ error: "clickup_aggregate_failed", detail: error.message }, 500);

  // Contract: aggregate-only. Never append task, assignee, actor or collaborator arrays here.
  return reply({ ok: true, clickup: data || {}, generated_at: new Date().toISOString() });
});
