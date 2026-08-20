import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!['GET','POST'].includes(req.method)) return json({ error: "not_found" }, 404);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "not_found" }, 404);

  const auth = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ error: "not_found" }, 404);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person,name,role")
    .eq("user_key", user.id)
    .maybeSingle();
  const isAdler = pref?.collaborator_person === "Adler Furtado";
  if (!isAdler) {
    await ops.from("contract_access_audit").insert({ user_id: user.id, person: pref?.collaborator_person ?? pref?.name ?? null, action: "CONTRACTS_API_ACCESS", allowed: false, metadata: { method: req.method } });
    return json({ error: "not_found" }, 404);
  }

  await ops.from("contract_access_audit").insert({ user_id: user.id, person: "Adler Furtado", action: req.method === "GET" ? "VIEW_CONTRACTS_TAB" : "CONTRACT_NOTIFICATION_ACTION", allowed: true, metadata: { method: req.method } });

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "mark_notification_read" && body?.id) {
      const { error } = await ops.from("contract_private_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", String(body.id));
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    if (body?.action === "mark_all_notifications_read") {
      const { error } = await ops.from("contract_private_notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null);
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  const [summaryRes, rowsRes, notificationsRes, docsRes] = await Promise.all([
    ops.from("contract_portfolio_summary").select("*").maybeSingle(),
    ops.from("contract_private_dashboard").select("*").order("days_remaining", { ascending: true, nullsFirst: false }),
    ops.from("contract_private_notifications").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("client_contracts").select("id", { count: "exact", head: true }),
  ]);

  if (summaryRes.error || rowsRes.error || notificationsRes.error) return json({ error: "query_failed" }, 500);
  return json({
    ok: true,
    summary: summaryRes.data || {},
    contracts: rowsRes.data || [],
    notifications: notificationsRes.data || [],
    source: { provider: "Autentique", documents_ingested: docsRes.count || 0 },
    generated_at: new Date().toISOString(),
  });
});
