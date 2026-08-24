import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "content-type": "application/json; charset=utf-8" },
});

function internalRole(value: unknown) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw.includes("GERENTE") || raw.includes("OPERA") || raw === "MGMT") return "MGMT";
  if (raw.includes("CUSTOMER") || raw === "CS") return "CS";
  if (raw.includes("TRÁFEGO") || raw.includes("TRAFEGO") || raw === "GT") return "GT";
  if (raw.includes("DESIGN")) return "DESIGN";
  return raw || "VIEWER";
}

function canSeePrivateNotification(row: any, person: string) {
  if (row?.metadata?.private_to_person !== true) return true;
  return String(row?.metadata?.target_person || "").trim() === person;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const admin = createClient(url, service);

  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData?.user) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

  const user = authData.user;
  const meta = user.user_metadata || {};

  const { data: preferenceRows } = await admin
    .schema("agency_ops")
    .from("user_preferences")
    .select("user_key,name,role,collaborator_person,metadata")
    .eq("user_key", user.id)
    .limit(1);
  const preferences = preferenceRows?.[0] || null;

  const person = String(preferences?.collaborator_person || preferences?.name || meta.collaborator_person || meta.full_name || meta.name || "").trim();
  const role = internalRole(preferences?.role || meta.role);
  const carteira = String(preferences?.metadata?.carteira || meta.carteira || "").trim();

  let allowedClientIds: string[] | null = null;
  if (["GT", "DESIGN"].includes(role)) {
    const field = role === "GT" ? "gt_owner" : "designer_owner";
    const { data: clientRows, error: clientScopeError } = await admin
      .schema("agency_ops")
      .from("clients")
      .select("id")
      .eq(field, person)
      .in("lifecycle", ["ACTIVE", "ONBOARDING"]);
    if (clientScopeError) return json({ ok: false, error: clientScopeError.message }, 500);
    allowedClientIds = (clientRows || []).map((row: any) => String(row.id));
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").toUpperCase();
    const notificationId = String(body?.notification_id || "").trim();
    if (action !== "RESOLVE" || !notificationId) return json({ ok: false, error: "INVALID_ACTION" }, 400);

    const { data: notification, error: notificationError } = await admin
      .schema("agency_ops")
      .from("platform_notifications")
      .select("id,client_id,metadata")
      .eq("id", notificationId)
      .maybeSingle();
    if (notificationError) return json({ ok: false, error: notificationError.message }, 500);
    if (!notification) return json({ ok: false, error: "NOT_FOUND" }, 404);
    if (!canSeePrivateNotification(notification, person)) return json({ ok: false, error: "FORBIDDEN" }, 403);
    if (allowedClientIds && (!notification.client_id || !allowedClientIds.includes(String(notification.client_id)))) {
      return json({ ok: false, error: "FORBIDDEN" }, 403);
    }

    const resolvedAt = new Date().toISOString();
    const [{ error: resolveError }, { error: readError }] = await Promise.all([
      admin.schema("agency_ops").from("platform_notification_resolutions").upsert({
        notification_id: notificationId,
        user_key: user.id,
        resolved_at: resolvedAt,
        resolved_by: person || user.email || user.id,
        resolution_note: body?.note ? String(body.note).slice(0, 1000) : null,
      }, { onConflict: "notification_id,user_key" }),
      admin.schema("agency_ops").from("platform_notification_reads").upsert({
        notification_id: notificationId,
        user_key: user.id,
        read_at: resolvedAt,
      }, { onConflict: "notification_id,user_key" }),
    ]);
    if (resolveError) return json({ ok: false, error: resolveError.message }, 500);
    if (readError) return json({ ok: false, error: readError.message }, 500);

    return json({ ok: true, notification_id: notificationId, status: "RESOLVED", resolved_at: resolvedAt, resolved_by: person || user.email || user.id });
  }

  const clientQuery = admin.schema("agency_ops").from("clients").select("id,display_name,cs_owner,gt_owner,designer_owner,lifecycle");
  const { data: clients = [], error: clientsError } = allowedClientIds ? await clientQuery.in("id", allowedClientIds) : await clientQuery;
  if (clientsError) return json({ ok: false, error: clientsError.message }, 500);
  const clientMap = new Map((clients || []).map((row: any) => [String(row.id), row]));

  let notifQuery = admin
    .schema("agency_ops")
    .from("platform_notifications")
    .select("id,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata")
    .order("occurred_at", { ascending: false })
    .limit(300);
  if (allowedClientIds) {
    if (!allowedClientIds.length) return json({ ok: true, role, person, carteira, items: [], generated_at: new Date().toISOString() });
    notifQuery = notifQuery.in("client_id", allowedClientIds);
  }

  let alertQuery = admin
    .schema("agency_ops")
    .from("operational_alerts")
    .select("id,client_id,type,severity,source,owner,title,description,next_action,status,first_detected_at,last_detected_at,resolved_at,metadata")
    .order("last_detected_at", { ascending: false })
    .limit(300);
  if (allowedClientIds) alertQuery = alertQuery.in("client_id", allowedClientIds);

  const [notifResult, alertResult, readsResult, resolutionsResult] = await Promise.all([
    notifQuery,
    alertQuery,
    admin.schema("agency_ops").from("platform_notification_reads").select("notification_id,read_at").eq("user_key", user.id),
    admin.schema("agency_ops").from("platform_notification_resolutions").select("notification_id,resolved_at,resolved_by,resolution_note").eq("user_key", user.id),
  ]);

  if (notifResult.error) return json({ ok: false, error: notifResult.error.message }, 500);
  if (alertResult.error) return json({ ok: false, error: alertResult.error.message }, 500);
  if (readsResult.error) return json({ ok: false, error: readsResult.error.message }, 500);
  if (resolutionsResult.error) return json({ ok: false, error: resolutionsResult.error.message }, 500);

  const readMap = new Map((readsResult.data || []).map((row: any) => [String(row.notification_id), row.read_at]));
  const resolutionMap = new Map((resolutionsResult.data || []).map((row: any) => [String(row.notification_id), row]));

  const visibleNotifRows = (notifResult.data || []).filter((row: any) => canSeePrivateNotification(row, person));
  const notifItems = visibleNotifRows.map((row: any) => {
    const personalReadAt = readMap.get(String(row.id)) || row.read_at || null;
    const resolution = resolutionMap.get(String(row.id)) as any;
    return {
      ...row,
      kind: "NOTIFICATION",
      read_at: personalReadAt,
      resolved_at: resolution?.resolved_at || null,
      resolved_by: resolution?.resolved_by || null,
      resolution_note: resolution?.resolution_note || null,
      status: resolution ? "RESOLVED" : (personalReadAt ? "READ" : "OPEN"),
      client_name: row.client_id ? clientMap.get(String(row.client_id))?.display_name || null : null,
      source_label: row.source || "Operação",
    };
  });

  const alertItems = (alertResult.data || []).map((row: any) => ({
    ...row,
    kind: "ALERT",
    id: String(row.id),
    level: row.severity,
    occurred_at: row.last_detected_at || row.first_detected_at,
    read_at: null,
    client_name: row.client_id ? clientMap.get(String(row.client_id))?.display_name || null : null,
    source_label: row.source || "Operação",
  }));

  const merged = [...notifItems, ...alertItems]
    .filter((row: any) => !allowedClientIds || (row.client_id && allowedClientIds.includes(String(row.client_id))))
    .sort((a: any, b: any) => new Date(b.occurred_at || 0).getTime() - new Date(a.occurred_at || 0).getTime())
    .slice(0, 400);

  return json({ ok: true, role, person, carteira, items: merged, generated_at: new Date().toISOString() });
});
