import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const currentLifecycle = new Set(["ACTIVE", "ONBOARDING"]);

function canSeeClient(me: any, person: string, client: any) {
  if (!me || !client) return false;
  if (me.role === "GT") return client.gt_owner === person && currentLifecycle.has(String(client.lifecycle));
  if (me.role === "DESIGN") return client.designer_owner === person && currentLifecycle.has(String(client.lifecycle));
  return ["MGMT", "CS", "AI"].includes(String(me.role));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500);
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user) return json({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const url = new URL(req.url);
  const requestedId = url.searchParams.get("client_id")?.trim() || "";
  const requestedName = url.searchParams.get("client_name")?.trim() || "";
  if (!requestedId && !requestedName) return json({ ok: false, error: "client_required" }, 400);

  const [{ data: pref }, { data: roster }, { data: client }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,access_level,is_former").eq("is_former", false),
    requestedId
      ? ops.from("clients").select("id,display_name,lifecycle,cs_owner,gt_owner,designer_owner").eq("id", requestedId).maybeSingle()
      : ops.from("clients").select("id,display_name,lifecycle,cs_owner,gt_owner,designer_owner").ilike("display_name", requestedName).maybeSingle(),
  ]);

  const person = pref?.collaborator_person ?? null;
  const me = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !me) return json({ ok: false, error: "collaborator_required" }, 403);
  if (!client) return json({ ok: false, error: "client_not_found" }, 404);
  if (!canSeeClient(me, person, client)) return json({ ok: false, error: "forbidden" }, 403);

  const [{ data: platform }, { data: reads }, { data: alerts }] = await Promise.all([
    ops.from("platform_notifications")
      .select("id,event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata")
      .eq("client_id", client.id)
      .order("occurred_at", { ascending: false })
      .limit(120),
    ops.from("platform_notification_reads")
      .select("notification_id,read_at")
      .eq("user_key", userData.user.id)
      .order("read_at", { ascending: false })
      .limit(500),
    ops.from("operational_alerts")
      .select("id,alert_key,type,severity,source,source_id,owner,title,description,next_action,first_detected_at,last_detected_at,status,resolved_at,metadata")
      .eq("client_id", client.id)
      .order("last_detected_at", { ascending: false })
      .limit(120),
  ]);

  const readMap = new Map((reads ?? []).map((row: any) => [String(row.notification_id), row.read_at]));
  const platformItems = (platform ?? []).map((row: any) => ({
    kind: "NOTIFICATION",
    id: String(row.id),
    key: row.event_key,
    type: row.type,
    level: row.level || "INFO",
    title: row.title,
    description: row.description,
    source: row.source,
    actor: row.actor,
    occurred_at: row.occurred_at,
    read_at: readMap.get(String(row.id)) || row.read_at || null,
    status: readMap.get(String(row.id)) || row.read_at ? "READ" : "UNREAD",
    task_id: row.task_id,
    next_action: row.metadata?.next_action || null,
    metadata: row.metadata || {},
  }));

  const alertItems = (alerts ?? []).map((row: any) => ({
    kind: "ALERT",
    id: `alert:${row.id}`,
    alert_id: row.id,
    key: row.alert_key,
    type: row.type,
    level: row.severity || "MEDIUM",
    title: row.title,
    description: row.description,
    source: row.source,
    actor: row.owner,
    occurred_at: row.last_detected_at || row.first_detected_at,
    first_detected_at: row.first_detected_at,
    resolved_at: row.resolved_at,
    read_at: null,
    status: row.status || "OPEN",
    next_action: row.next_action,
    metadata: row.metadata || {},
  }));

  const items = [...platformItems, ...alertItems].sort((a: any, b: any) =>
    new Date(b.occurred_at || 0).getTime() - new Date(a.occurred_at || 0).getTime()
  );
  const openAlerts = alertItems.filter((row: any) => String(row.status).toUpperCase() !== "RESOLVED");
  const criticalOpen = openAlerts.filter((row: any) => ["CRITICAL", "HIGH"].includes(String(row.level).toUpperCase()));
  const unread = platformItems.filter((row: any) => !row.read_at);

  return json({
    ok: true,
    client: {
      id: client.id,
      display_name: client.display_name,
      lifecycle: client.lifecycle,
      cs_owner: client.cs_owner,
      gt_owner: client.gt_owner,
      designer_owner: client.designer_owner,
    },
    summary: {
      unread: unread.length,
      open_alerts: openAlerts.length,
      critical_open: criticalOpen.length,
      resolved_alerts: alertItems.length - openAlerts.length,
      total: items.length,
    },
    items,
    generated_at: new Date().toISOString(),
  });
});
