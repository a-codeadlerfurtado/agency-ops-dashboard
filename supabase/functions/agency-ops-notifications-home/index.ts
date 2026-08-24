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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

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
  const person = String(meta.collaborator_person || meta.full_name || meta.name || "").trim();

  let role = String(meta.role || "").toUpperCase();
  let carteira = String(meta.carteira || "").trim();

  const { data: profileRows } = await admin
    .schema("agency_ops")
    .from("dashboard_user_profiles")
    .select("person,role,carteira")
    .or(`auth_user_id.eq.${user.id},person.eq.${person.replace(/,/g, "")}`)
    .limit(1);
  const profile = profileRows?.[0] || null;
  if (profile?.role) role = String(profile.role).toUpperCase();
  if (profile?.carteira) carteira = String(profile.carteira);

  let allowedClientIds: string[] | null = null;
  if (["GT", "DESIGN"].includes(role)) {
    const field = role === "GT" ? "gt_owner" : "designer_owner";
    const { data: clientRows } = await admin
      .schema("agency_ops")
      .from("clients")
      .select("client_id")
      .eq(field, person)
      .in("lifecycle", ["ACTIVE", "ONBOARDING"]);
    allowedClientIds = (clientRows || []).map((row: any) => String(row.client_id));
  }

  const clientQuery = admin.schema("agency_ops").from("clients").select("client_id,display_name,cs_owner,gt_owner,designer_owner,lifecycle");
  const { data: clients = [] } = allowedClientIds ? await clientQuery.in("client_id", allowedClientIds) : await clientQuery;
  const clientMap = new Map((clients || []).map((row: any) => [String(row.client_id), row]));

  let notifQuery = admin
    .schema("agency_ops")
    .from("platform_notifications")
    .select("id,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata")
    .order("occurred_at", { ascending: false })
    .limit(300);
  if (allowedClientIds) {
    if (!allowedClientIds.length) return json({ ok: true, items: [], generated_at: new Date().toISOString() });
    notifQuery = notifQuery.in("client_id", allowedClientIds);
  }

  let alertQuery = admin
    .schema("agency_ops")
    .from("operational_alerts")
    .select("id,client_id,type,severity,source,owner,title,description,next_action,status,first_detected_at,last_detected_at,resolved_at,metadata")
    .order("last_detected_at", { ascending: false })
    .limit(300);
  if (allowedClientIds) alertQuery = alertQuery.in("client_id", allowedClientIds);

  const [{ data: notifications = [], error: notifError }, { data: alerts = [], error: alertError }] = await Promise.all([notifQuery, alertQuery]);
  if (notifError) return json({ ok: false, error: notifError.message }, 500);
  if (alertError) return json({ ok: false, error: alertError.message }, 500);

  const notifItems = (notifications || []).map((row: any) => ({
    ...row,
    kind: "NOTIFICATION",
    status: row.read_at ? "READ" : "OPEN",
    client_name: row.client_id ? clientMap.get(String(row.client_id))?.display_name || null : null,
    source_label: row.source || "Operação",
  }));

  const alertItems = (alerts || []).map((row: any) => ({
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
