import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const VERSION = "v21.0";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = (v: unknown) => String(v || "").trim();
const finite = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const cleanAccount = (v: unknown) => clean(v).replace(/^act_/, "");
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(""); }

async function metaJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `Meta HTTP ${response.status}`);
    (error as any).metaCode = body?.error?.code ?? response.status;
    (error as any).metaSubcode = body?.error?.error_subcode ?? null;
    throw error;
  }
  return body;
}
async function resolveToken(db: any) {
  const { data, error } = await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vault = !error && typeof data === "string" ? data.trim() : "";
  return vault || String(Deno.env.get("META_SYSTEM_USER_TOKEN") || "").trim();
}
async function canWrite(token: string) {
  const body = await metaJson(`https://graph.facebook.com/${VERSION}/me/permissions?access_token=${encodeURIComponent(token)}`);
  return (body?.data || []).some((r: Row) => r.permission === "ads_management" && r.status === "granted");
}
async function stateWithFallback(token: string, objectType: string, id: string) {
  const candidates = objectType === "ADSET" ? [
    "id,name,status,effective_status,account_id,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,start_time,end_time,targeting,attribution_spec,destination_type,promoted_object",
    "id,name,status,effective_status,account_id,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,start_time,end_time,targeting",
    "id,name,status,effective_status,account_id,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,start_time,end_time",
    "id,name,status,effective_status,account_id,campaign_id,daily_budget,lifetime_budget",
    "id,name,status,effective_status,account_id,campaign_id",
  ] : ["id,name,status,effective_status,account_id,campaign_id,adset_id", "id,name,status,account_id,campaign_id,adset_id"];
  let last: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const state = await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}?fields=${encodeURIComponent(candidates[i])}&access_token=${encodeURIComponent(token)}`);
      return { ...state, read_fallback_level: i };
    } catch (error) { last = error; }
  }
  throw last || new Error("meta_state_failed");
}
async function postObject(token: string, id: string, values: Row) {
  const body = new URLSearchParams(); body.set("access_token", token);
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    body.set(key, value);
  }
  return await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
}
async function liveMtd(token: string, accounts: string[], since: string, until: string) {
  let spend = 0, success = 0;
  for (const account of accounts) {
    try {
      const range = encodeURIComponent(JSON.stringify({ since, until }));
      const body = await metaJson(`https://graph.facebook.com/${VERSION}/act_${account}/insights?level=account&time_range=${range}&fields=spend&access_token=${encodeURIComponent(token)}`);
      spend += finite(body?.data?.[0]?.spend) || 0; success += 1;
    } catch {}
  }
  return success ? spend : null;
}
function sameScalar(a: unknown, b: unknown) {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  const an = finite(a), bn = finite(b); if (an !== null && bn !== null) return an === bn;
  return clean(a).toUpperCase() === clean(b).toUpperCase();
}
function sanitizePatch(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Row; const patch: Row = {};
  const textFields = ["name", "status", "optimization_goal", "billing_event", "bid_strategy", "destination_type", "start_time", "end_time"];
  for (const field of textFields) {
    if (!(field in source)) continue;
    const value = clean(source[field]);
    if (!value || value.length > 500) continue;
    patch[field] = field === "name" ? value.slice(0, 255) : value.toUpperCase();
    if (field === "start_time" || field === "end_time") patch[field] = value;
  }
  for (const field of ["daily_budget", "lifetime_budget", "bid_amount"]) {
    if (!(field in source)) continue;
    const value = finite(source[field]);
    if (value === null || value < 0 || value > 10000000) continue;
    patch[field] = Math.round(value * 100);
  }
  for (const field of ["targeting", "attribution_spec", "promoted_object"]) {
    if (!(field in source)) continue;
    const value = source[field];
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 40000) continue;
    patch[field] = value;
  }
  return patch;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "", anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "", serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || ""; if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(); const user = authData?.user;
  if (authError || !user?.id) return json({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } }); const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name);
  if (!person || !(approvals || []).some((r: Row) => r.kind === "SIGNUP")) return json({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  const role = clean(roster?.role).toUpperCase(); const elevated = (approvals || []).some((r: Row) => r.kind === "ELEVATION");
  if (!roster || roster.is_former || !["GT", "MGMT"].includes(role)) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const clientName = clean(body.client_name), objectType = clean(body.object_type).toUpperCase(), objectId = clean(body.object_id), action = clean(body.action).toUpperCase();
  if (!clientName || !["ADSET", "AD"].includes(objectType) || !/^\d{5,30}$/.test(objectId)) return json({ error: "invalid_target" }, 400);
  if (!["GET_STATE", "SET_STATUS", "SET_DAILY_BUDGET", "PATCH_ADSET"].includes(action)) return json({ error: "invalid_action" }, 400);
  if (["SET_DAILY_BUDGET", "PATCH_ADSET"].includes(action) && objectType !== "ADSET") return json({ error: "adset_only_action" }, 400);

  let clientQ = ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("display_name", clientName).eq("lifecycle", "ACTIVE");
  if (role === "GT" && !elevated) clientQ = clientQ.eq("gt_owner", person);
  const { data: clients } = await clientQ.limit(3);
  if (!(clients || []).length) return json({ error: "client_not_found" }, 404);
  if ((clients || []).length !== 1) return json({ error: "client_ambiguous" }, 409);
  const client = clients![0];
  const [{ data: balances }, { data: term }] = await Promise.all([
    ops.from("client_balance_overview").select("meta_ad_account_id,currency,avg_daily_spend").eq("client_id", client.id),
    ops.from("client_private_commercial_terms").select("minimum_ad_budget,verified_at,confidence").eq("client_id", client.id).maybeSingle(),
  ]);
  const accountIds = [...new Set((balances || []).map((r: Row) => cleanAccount(r.meta_ad_account_id)).filter((id: string) => /^\d{5,30}$/.test(id)))];
  if (!accountIds.length) return json({ error: "meta_account_missing" }, 409);
  const token = await resolveToken(db); if (!token) return json({ error: "meta_token_missing" }, 503);

  let before: Row;
  try { before = await stateWithFallback(token, objectType, objectId); }
  catch (error) { return json({ error: "meta_read_failed", detail: clean((error as Error)?.message || error) }, 502); }
  const accountId = cleanAccount(before.account_id); if (!accountIds.includes(accountId)) return json({ error: "object_not_owned_by_client" }, 403);
  if (action === "GET_STATE") return json({ ok: true, state: before, client: { id: client.id, display_name: client.display_name }, generated_at: new Date().toISOString() });

  try { if (!(await canWrite(token))) return json({ error: "meta_write_permission_missing" }, 403); }
  catch { return json({ error: "meta_capability_check_failed" }, 502); }
  const oneHourAgo = new Date(Date.now() - 36e5).toISOString();
  const { count } = await ops.from("safe_action_requests").select("id", { count: "exact", head: true }).eq("actor_user_id", user.id).gte("created_at", oneHourAgo);
  if (Number(count || 0) >= 60) return json({ error: "rate_limited" }, 429);

  let patch: Row = {};
  if (action === "SET_STATUS") {
    const status = clean(body.status).toUpperCase(); if (!["ACTIVE", "PAUSED"].includes(status)) return json({ error: "invalid_status" }, 400);
    if (!["ACTIVE", "PAUSED"].includes(clean(before.status).toUpperCase())) return json({ error: "object_state_not_toggleable", status: before.status }, 409);
    patch.status = status;
  } else if (action === "SET_DAILY_BUDGET") {
    const requested = finite(body.daily_budget); if (requested === null || requested < 1 || requested > 1000000) return json({ error: "invalid_daily_budget" }, 400);
    patch.daily_budget = Math.round(requested * 100);
  } else {
    patch = sanitizePatch(body.changes);
    if (!Object.keys(patch).length) return json({ error: "no_changes" }, 400);
    if (patch.status && !["ACTIVE", "PAUSED"].includes(patch.status)) return json({ error: "invalid_status" }, 400);
  }

  let budgetGuard: Row | null = null;
  const dailyIncrease = patch.daily_budget !== undefined ? Math.max(0, (Number(patch.daily_budget) - (finite(before.daily_budget) || 0)) / 100) : 0;
  const lifetimeIncrease = patch.lifetime_budget !== undefined ? Math.max(0, (Number(patch.lifetime_budget) - (finite(before.lifetime_budget) || 0)) / 100) : 0;
  if (dailyIncrease > 0 || lifetimeIncrease > 0) {
    const account = await metaJson(`https://graph.facebook.com/${VERSION}/act_${accountId}?fields=id,currency&access_token=${encodeURIComponent(token)}`);
    if (clean(account.currency).toUpperCase() !== "BRL") return json({ error: "currency_not_supported_for_inline_budget", currency: account.currency || null }, 409);
    const monthly = finite(term?.minimum_ad_budget); const today = localDate(), since = `${today.slice(0, 8)}01`; const mtd = await liveMtd(token, accountIds, since, today);
    const day = Number(today.slice(8, 10)), daysInMonth = new Date(Number(today.slice(0,4)), Number(today.slice(5,7)), 0).getDate(); const remainingDays = Math.max(1, daysInMonth - day);
    const remaining = monthly !== null && mtd !== null ? Math.max(0, monthly - mtd) : null; const currentPace = mtd !== null ? mtd / Math.max(1, day) : null; const idealRemaining = remaining !== null ? remaining / remainingDays : null; const extraRoom = idealRemaining !== null && currentPace !== null ? Math.max(0, idealRemaining - currentPace) : null;
    budgetGuard = { monthly_budget: monthly, mtd_spend: mtd, remaining_budget: remaining, remaining_days: remainingDays, current_daily_pace: currentPace, ideal_daily_remaining: idealRemaining, requested_daily_increase: dailyIncrease, requested_lifetime_increase: lifetimeIncrease, daily_increase_room: extraRoom };
    const dailyFailed = dailyIncrease > 0 && (extraRoom === null || dailyIncrease > Math.max(1, extraRoom * 1.15));
    const lifetimeFailed = lifetimeIncrease > 0 && (remaining === null || lifetimeIncrease > remaining);
    const guardFailed = monthly === null || mtd === null || remaining === null || remaining <= 0 || dailyFailed || lifetimeFailed;
    const override = Boolean(body.override_budget_guard) && role === "MGMT";
    if (guardFailed && !override) return json({ error: "budget_guard_blocked", budget_guard: budgetGuard, override_available: role === "MGMT" }, 409);
    budgetGuard.override_used = override && guardFailed;
  }

  const actionType = action === "SET_STATUS" ? `META_${objectType}_STATUS` : action === "SET_DAILY_BUDGET" ? "META_ADSET_DAILY_BUDGET" : "META_ADSET_PATCH";
  const beforeState = [{ ...before }]; const previewHash = await sha256(JSON.stringify({ actor: user.id, client: client.id, objectType, objectId, action, patch, before: beforeState })); const now = new Date().toISOString();
  const { data: audit, error: auditError } = await ops.from("safe_action_requests").insert({
    actor_user_id: user.id, actor_person: person, actor_role: role, client_id: client.id,
    action_type: actionType, target_ids: [objectId], preview_state: beforeState, preview_hash: previewHash, before_state: beforeState,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), status: "EXECUTING", confirmed_at: now,
    request_metadata: { source: "ADS_INTELLIGENCE", object_type: objectType, object_name: before.name || null, requested_changes: patch, budget_guard: budgetGuard },
  }).select("id").single();
  if (auditError || !audit?.id) return json({ error: "audit_store_failed" }, 500);

  try { await postObject(token, objectId, patch); }
  catch (error) {
    await ops.from("safe_action_requests").update({ status: "FAILED", executed_at: new Date().toISOString(), error: clean((error as Error)?.message || error).slice(0, 500) }).eq("id", audit.id);
    return json({ error: "execution_failed", detail: clean((error as Error)?.message || error), audit_id: audit.id }, 502);
  }

  let after: Row;
  try { after = await stateWithFallback(token, objectType, objectId); }
  catch (error) {
    await ops.from("safe_action_requests").update({ status: "FAILED", executed_at: new Date().toISOString(), error: `Verification failed: ${clean((error as Error)?.message || error).slice(0, 420)}` }).eq("id", audit.id);
    return json({ error: "verification_failed", audit_id: audit.id }, 502);
  }
  const complex = new Set(["targeting", "attribution_spec", "promoted_object"]); const mismatches: string[] = [];
  for (const [field, expected] of Object.entries(patch)) {
    if (complex.has(field)) continue;
    if (!sameScalar(after[field], expected)) mismatches.push(field);
  }
  if (mismatches.length) {
    const rollbackPatch: Row = {};
    for (const field of Object.keys(patch)) if (before[field] !== undefined && before[field] !== null) rollbackPatch[field] = before[field];
    let rollbackOk = false;
    try { if (Object.keys(rollbackPatch).length) { await postObject(token, objectId, rollbackPatch); const rollback = await stateWithFallback(token, objectType, objectId); rollbackOk = mismatches.every((field) => sameScalar(rollback[field], before[field])); } } catch { rollbackOk = false; }
    await ops.from("safe_action_requests").update({ status: rollbackOk ? "ROLLED_BACK" : "FAILED", executed_at: new Date().toISOString(), after_state: [after], verification: { verified: false, mismatches, rollback_attempted: true, rollback_ok: rollbackOk }, error: `Meta returned a different state for: ${mismatches.join(", ")}` }).eq("id", audit.id);
    return json({ error: "verification_failed", fields: mismatches, rollback_ok: rollbackOk, audit_id: audit.id }, 502);
  }

  await ops.from("safe_action_requests").update({ status: "VERIFIED", executed_at: new Date().toISOString(), after_state: [after], verification: { verified: true, verified_at: new Date().toISOString(), complex_fields_accepted: Object.keys(patch).filter((f) => complex.has(f)) }, error: null }).eq("id", audit.id);
  return json({ ok: true, status: "VERIFIED", object_type: objectType, object_id: objectId, before, after, changes: patch, budget_guard: budgetGuard, audit_id: audit.id });
});
