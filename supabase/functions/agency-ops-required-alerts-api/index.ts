import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await auth.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(pref?.collaborator_person ?? "").trim();
  if (!person || !(approvals ?? []).length) return respond({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id ?? "");
    const action = String(body.action ?? "ACK").toUpperCase();
    const scheduledDate = body.scheduled_date ? String(body.scheduled_date) : null;
    const scheduledTime = body.scheduled_time ? String(body.scheduled_time) : null;
    const meetUrl = body.meet_url ? String(body.meet_url).trim() : null;
    if (!id) return respond({ error: "missing_fields", required: ["id"] }, 400);
    if (!["ACK", "MEETING_SCHEDULED"].includes(action)) return respond({ error: "invalid_action" }, 400);

    const { data: alert, error: alertError } = await ops.from("onboarding_required_alerts")
      .select("id,target_person,alert_type,acknowledged_at,metadata").eq("id", id).maybeSingle();
    if (alertError) return respond({ error: "query_failed", detail: alertError.message }, 500);
    if (!alert || alert.target_person !== person) return respond({ error: "not_found_or_forbidden" }, 404);

    if (action === "MEETING_SCHEDULED") {
      if (alert.alert_type !== "ONBOARDING_MEETING_HANDOFF" || alert.metadata?.action_type !== "SCHEDULE_MEETING") return respond({ error: "meeting_action_not_allowed" }, 400);
      if (!scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) return respond({ error: "invalid_scheduled_date" }, 400);
      if (!scheduledTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime)) return respond({ error: "invalid_scheduled_time" }, 400);
      if (meetUrl && !/^https:\/\/meet\.google\.com\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(meetUrl)) return respond({ error: "invalid_google_meet_url" }, 400);
    }

    const { data, error } = await ops.rpc("resolve_onboarding_required_alert", {
      p_alert_id: id,
      p_person: person,
      p_user_key: user.id,
      p_action: action,
      p_scheduled_date: scheduledDate,
      p_scheduled_time: scheduledTime,
      p_meet_url: meetUrl,
    });
    if (error) {
      const detail = String(error.message ?? "");
      const status = detail.includes("NOT_FOUND_OR_FORBIDDEN") ? 404 : detail.includes("INVALID_") || detail.includes("DOES_NOT_SUPPORT") || detail.includes("STAGE_NOT_FOUND") ? 400 : 500;
      return respond({ error: "action_failed", detail }, status);
    }
    return respond(data ?? { ok: true, id, action });
  }

  const { data: rows, error } = await ops.from("onboarding_required_alerts")
    .select("id,event_key,alert_type,client_id,onboarding_case_id,target_person,target_role,title,description,actor,occurred_at,ack_required,ack_label,acknowledged_at,metadata")
    .eq("target_person", person)
    .order("occurred_at", { ascending: false })
    .limit(100);
  if (error) return respond({ error: "query_failed", detail: error.message }, 500);

  const history = rows ?? [];
  const now = Date.now();
  const pending = history.filter((row: any) => {
    if (row.ack_required === false || row.acknowledged_at) return false;
    const nextPresentAt = row.metadata?.next_present_at;
    if (!nextPresentAt) return true;
    const next = new Date(String(nextPresentAt)).getTime();
    return Number.isNaN(next) || next <= now;
  }).sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

  return respond({ ok: true, profile: { person, role: roster.role }, pending, history, generated_at: new Date().toISOString() });
});
