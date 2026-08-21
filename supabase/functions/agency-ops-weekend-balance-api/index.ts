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

function saoPauloParts() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(now));
  return { date, weekday, hour };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

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
    const runKey = String(body?.run_key ?? "").trim();
    const slotKey = String(body?.slot_key ?? "").trim();
    if (!runKey && !slotKey) return respond({ error: "run_key_required" }, 400);

    let query = ops.from("weekend_balance_alerts").select("id").eq("target_gt", person);
    query = runKey ? query.eq("run_key", runKey) : query.eq("slot_key", slotKey);
    const { data: rows, error } = await query;
    if (error) return respond({ error: "query_failed", detail: error.message }, 500);

    const reads = (rows ?? []).map((row: any) => ({ alert_id: row.id, user_key: userKey, read_at: new Date().toISOString() }));
    if (reads.length) {
      const { error: readError } = await ops.from("weekend_balance_alert_reads").upsert(reads, { onConflict: "alert_id,user_key" });
      if (readError) return respond({ error: "ack_failed", detail: readError.message }, 500);
    }
    return respond({ ok: true, acknowledged: reads.length });
  }

  const local = saoPauloParts();
  // Na sexta a partir das 17h, a regra de fim de semana (<R$100) tem prioridade.
  // Nos demais momentos, a consulta usa a regra diária crítica (<R$30).
  const ruleKey = local.weekday === "Fri" && local.hour >= 17 ? "FRIDAY_WEEKEND_100" : "DAILY_CRITICAL_30";

  const { data: runs, error: runError } = await ops.from("balance_alert_runs")
    .select("run_key,rule_key,slot_key,threshold,ran_at,matched_count")
    .eq("rule_key", ruleKey)
    .eq("local_date", local.date)
    .order("ran_at", { ascending: false })
    .limit(1);
  if (runError) return respond({ error: "query_failed", detail: runError.message }, 500);
  const run = runs?.[0] ?? null;
  if (!run || Number(run.matched_count ?? 0) <= 0) {
    return respond({ eligible: true, person, alerts: [], slot_key: run?.slot_key ?? null, run_key: run?.run_key ?? null, rule_key: ruleKey, threshold: run?.threshold ?? (ruleKey === "FRIDAY_WEEKEND_100" ? 100 : 30) });
  }

  const { data: candidates, error } = await ops.from("weekend_balance_alerts")
    .select("id,slot_key,slot_at,target_gt,client_id,client_name,min_balance,checked_at,low_accounts,rule_key,threshold,run_key")
    .eq("target_gt", person)
    .eq("run_key", run.run_key)
    .order("min_balance", { ascending: true })
    .limit(200);
  if (error) return respond({ error: "query_failed", detail: error.message }, 500);
  if (!candidates?.length) return respond({ eligible: true, person, alerts: [], slot_key: run.slot_key, run_key: run.run_key, rule_key: run.rule_key, threshold: run.threshold });

  const ids = candidates.map((row: any) => row.id);
  const { data: reads, error: readError } = await ops.from("weekend_balance_alert_reads")
    .select("alert_id")
    .eq("user_key", userKey)
    .in("alert_id", ids);
  if (readError) return respond({ error: "query_failed", detail: readError.message }, 500);
  const readIds = new Set((reads ?? []).map((row: any) => String(row.alert_id)));
  const unread = candidates.filter((row: any) => !readIds.has(String(row.id)));

  return respond({
    eligible: true,
    person,
    slot_key: run.slot_key,
    run_key: run.run_key,
    rule_key: run.rule_key,
    threshold: run.threshold,
    alerts: unread,
    generated_at: new Date().toISOString(),
  });
});
