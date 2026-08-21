import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function saoPauloDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function isFriday() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date()) === "Fri";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!['GET','POST'].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData } = await authClient.auth.getUser();
  if (!userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  if (!person) return respond({ eligible: false, alerts: [] });
  const { data: roster } = await ops.from("team_roster").select("role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former || roster.role !== "GT") return respond({ eligible: false, alerts: [] });

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const slotKey = String(body?.slot_key ?? "").trim();
    if (!slotKey) return respond({ error: "slot_key_required" }, 400);
    const { data: rows, error } = await ops.from("weekend_balance_alerts")
      .select("id")
      .eq("target_gt", person)
      .eq("slot_key", slotKey);
    if (error) return respond({ error: "query_failed", detail: error.message }, 500);
    const reads = (rows ?? []).map((row: any) => ({ alert_id: row.id, user_key: userKey, read_at: new Date().toISOString() }));
    if (reads.length) {
      const { error: readError } = await ops.from("weekend_balance_alert_reads").upsert(reads, { onConflict: "alert_id,user_key" });
      if (readError) return respond({ error: "ack_failed", detail: readError.message }, 500);
    }
    return respond({ ok: true, acknowledged: reads.length });
  }

  if (!isFriday()) return respond({ eligible: true, person, alerts: [], slot_key: null });
  const date = saoPauloDate();
  const { data: candidates, error } = await ops.from("weekend_balance_alerts")
    .select("id,slot_key,slot_at,target_gt,client_id,client_name,min_balance,checked_at,low_accounts")
    .eq("target_gt", person)
    .like("slot_key", `${date}-%`)
    .order("slot_at", { ascending: false })
    .limit(200);
  if (error) return respond({ error: "query_failed", detail: error.message }, 500);
  if (!candidates?.length) return respond({ eligible: true, person, alerts: [], slot_key: null });

  const latestSlot = String(candidates[0].slot_key);
  const slotRows = candidates.filter((row: any) => String(row.slot_key) === latestSlot);
  const ids = slotRows.map((row: any) => row.id);
  const { data: reads, error: readError } = await ops.from("weekend_balance_alert_reads")
    .select("alert_id")
    .eq("user_key", userKey)
    .in("alert_id", ids);
  if (readError) return respond({ error: "query_failed", detail: readError.message }, 500);
  const readIds = new Set((reads ?? []).map((row: any) => String(row.alert_id)));
  const unread = slotRows.filter((row: any) => !readIds.has(String(row.id)));

  return respond({
    eligible: true,
    person,
    slot_key: latestSlot,
    alerts: unread,
    generated_at: new Date().toISOString(),
  });
});
