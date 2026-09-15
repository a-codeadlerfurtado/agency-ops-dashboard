import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle();
  const person = String(pref?.collaborator_person || "");
  if (!person) return reply({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("role").eq("person", person).eq("is_former", false).maybeSingle();
  const role = String(roster?.role || "");
  if (!['GT','MGMT'].includes(role)) return reply({ error: "forbidden" }, 403);
  const { data: approvals } = await ops.from("access_requests").select("kind,status").eq("user_key", userData.user.id).eq("status", "APPROVED");
  if (!(approvals ?? []).some((row: any) => row.kind === "SIGNUP")) return reply({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const reportId = String(body?.report_id || "");
  const reportText = String(body?.report_text || "");
  if (!reportId) return reply({ error: "report_id_required" }, 400);
  if (!reportText.trim()) return reply({ error: "report_text_required" }, 400);
  if (reportText.length > 50000) return reply({ error: "report_text_too_large" }, 400);

  let check = ops.from("weekly_traffic_reports").select("id,gt_owner,review_status").eq("id", reportId);
  if (role === "GT") check = check.eq("gt_owner", person);
  const { data: report } = await check.maybeSingle();
  if (!report) return reply({ error: "report_not_found" }, 404);

  const { data: updated, error } = await ops.from("weekly_traffic_reports").update({
    report_text: reportText,
    review_status: report.review_status === "SENT" ? "SENT" : "REVIEWED",
    reviewed_by: person,
    reviewed_at: new Date().toISOString(),
  }).eq("id", reportId).select("*").single();
  if (error) return reply({ error: "update_failed", detail: error.message }, 500);
  return reply({ ok: true, report: updated });
});
