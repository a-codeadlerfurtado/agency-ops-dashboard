import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const hidden = () => reply({ error: "not_found" }, 404);
const clean = (value: unknown) => String(value ?? "").trim();
const monthStart = (value: string) => /^2026-(0[1-9]|1[0-2])$/.test(value) ? `${value}-01` : null;

async function identify(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authHeader = req.headers.get("Authorization") || "";
  if (!supabaseUrl || !anon || !service || !authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData.user) return null;
  const db = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userData.user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name || userData.user.user_metadata?.collaborator_person);
  if (!person || !(approvals || []).length) return null;
  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return null;
  return { db, ops, userId: userData.user.id, person, role: clean(roster.role).toUpperCase(), access: clean(roster.access_level).toUpperCase() };
}

function currentMonthKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}
function previousMonthKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(now).split("-");
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 2, 1));
  return date.toISOString().slice(0, 7);
}
function availableMonths() {
  const out: string[] = [];
  const end = currentMonthKey();
  for (let year = 2026, month = 1; ; month++) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
  }
  return out.reverse();
}async function loadCompany(ctx: any, month: string, refresh: boolean) {
  const monthDate = `${month}-01`;
  const closed = month < currentMonthKey();
  if (closed && !refresh) {
    const { data: saved, error } = await ctx.ops.from("monthly_wrapped_snapshots")
      .select("payload,coverage_tier,is_final,generated_at,source_version")
      .eq("month_key", monthDate).eq("scope_type", "COMPANY").eq("scope_key", "COMPANY").maybeSingle();
    if (error) throw error;
    if (saved?.payload) return { ...saved.payload, snapshot: true, snapshot_generated_at: saved.generated_at };
  }
  const { data, error } = await ctx.ops.rpc("wrapped_company_month", { p_month: monthDate });
  if (error) throw error;
  const payload = data as Row;
  if (closed) {
    const row = {
      month_key: monthDate, scope_type: "COMPANY", scope_key: "COMPANY",
      coverage_tier: payload.coverage_tier, is_final: true, payload,
      source_version: "wrapped-v2-no-work-center", generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error: saveError } = await ctx.ops.from("monthly_wrapped_snapshots")
      .upsert(row, { onConflict: "month_key,scope_type,scope_key" });
    if (saveError) throw saveError;
  }
  return { ...payload, snapshot: closed, refreshed: refresh };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return hidden();
  try {
    const ctx = await identify(req);
    if (!ctx) return hidden();
    const url = new URL(req.url);
    if (url.searchParams.get("months") === "1") {
      return reply({ ok: true, months: availableMonths(), default_month: previousMonthKey(), role: ctx.role, person: ctx.person });
    }
    const month = clean(url.searchParams.get("month") || previousMonthKey());
    if (!monthStart(month) || !availableMonths().includes(month)) return reply({ error: "invalid_month" }, 400);
    if (ctx.role !== "MGMT") return reply({ error: "company_wrapped_management_only" }, 403);
    const refresh = url.searchParams.get("refresh") === "1";
    const payload = await loadCompany(ctx, month, refresh);
    return reply({ ok: true, scope: "COMPANY", person: ctx.person, payload });
  } catch (error) {
    console.error("[wrapped-api]", error);
    return reply({ error: "wrapped_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
