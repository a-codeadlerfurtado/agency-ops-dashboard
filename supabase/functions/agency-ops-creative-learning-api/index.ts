import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: decisions }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userData.user.id).eq("status", "APPROVED"),
  ]);
  if (!(decisions ?? []).some((row: any) => row.kind === "SIGNUP")) return respond({ error: "forbidden" }, 403);

  const person = pref?.collaborator_person ?? null;
  if (!person) return respond({ error: "collaborator_required" }, 403);
  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level,is_former")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);

  const { data: allowedViews, error: allowedError } = await ops.rpc("dashboard_allowed_views", {
    p_person: roster.person,
    p_role: roster.role,
  });
  if (allowedError || !Array.isArray(allowedViews) || !allowedViews.includes("creative")) {
    return respond({ error: "forbidden" }, 403);
  }

  const { data: profiles, error: profileError } = await ops.from("creative_learning_client_summary")
    .select("client_id,coverage_pct,conflict_count,learned_count,weak_signal_count,last_signal_at,evidence_count,evidence_sources,learned_items,questions,profile_status");
  if (profileError) return respond({ error: "query_failed", detail: profileError.message }, 500);

  const rows = profiles ?? [];
  return respond({
    profiles: rows,
    summary: {
      total: rows.length,
      with_evidence: rows.filter((row: any) => Number(row.evidence_count || 0) > 0).length,
      complete: rows.filter((row: any) => row.profile_status === "COMPLETE").length,
      learning: rows.filter((row: any) => row.profile_status === "LEARNING").length,
      conflict: rows.filter((row: any) => row.profile_status === "CONFLICT").length,
      needs_confirmation: rows.filter((row: any) => row.profile_status === "NEEDS_CONFIRMATION").length,
    },
    generated_at: new Date().toISOString(),
  });
});
