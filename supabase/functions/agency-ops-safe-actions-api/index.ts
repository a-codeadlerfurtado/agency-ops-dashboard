import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "v21.0";
const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};
type Row = Record<string, any>;
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function metaJson(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const b = await r.json().catch(() => null);
  if (!r.ok || b?.error) throw new Error(b?.error?.message || `Meta HTTP ${r.status}`);
  return b;
}
async function campaign(token: string, id: string) {
  return await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}?fields=id,name,status,effective_status,account_id&access_token=${encodeURIComponent(token)}`);
}
async function setCampaignStatus(token: string, id: string, status: "ACTIVE" | "PAUSED") {
  const body = new URLSearchParams();
  body.set("access_token", token);
  body.set("status", status);
  return await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
}
async function adsManagementGranted(token: string) {
  const body = await metaJson(`https://graph.facebook.com/${VERSION}/me/permissions?access_token=${encodeURIComponent(token)}`);
  return (body?.data || []).some((p: Row) => p.permission === "ads_management" && p.status === "granted");
}
async function resolveMetaToken(db: any) {
  const { data, error } = await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vaultToken = !error && typeof data === "string" ? data.trim() : "";
  if (vaultToken) return { token: vaultToken, source: "SUPABASE_VAULT" };
  const envToken = String(Deno.env.get("META_SYSTEM_USER_TOKEN") || "").trim();
  if (envToken) return { token: envToken, source: "EDGE_ENV" };
  return { token: "", source: null };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  const user = userData?.user;
  if (authError || !user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { token: metaToken, source: metaTokenSource } = await resolveMetaToken(db);
  if (!metaToken) return reply({ error: "meta_token_missing" }, 503);
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((r: Row) => r.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "inactive_profile" }, 403);
  const role = String(roster.role || "").toUpperCase();
  if (!["GT", "MGMT"].includes(role) || person === "Leonardo Augusto") return reply({ error: "forbidden" }, 403);
  const elevated = (approvals || []).some((r: Row) => r.kind === "ELEVATION");

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "CAPABILITIES").toUpperCase();
  const requestSource = String(body?.source || "CLIENT_360").toUpperCase() === "CAMPAIGNS" ? "CAMPAIGNS" : "CLIENT_360";

  if (action === "DISCOVER") {
    const clientName = String(body?.client_name || "").trim();
    if (!clientName) return reply({ error: "client_required" }, 400);
    const { data: candidates, error: clientError } = await ops.from("clients")
      .select("id,display_name,gt_owner,lifecycle")
      .eq("display_name", clientName)
      .limit(3);
    if (clientError) return reply({ error: "query_failed" }, 500);
    const scoped = (candidates || []).filter((row: Row) => role !== "GT" || elevated || String(row.gt_owner || "") === person);
    if (!(candidates || []).length) return reply({ error: "client_not_found" }, 404);
    if (!scoped.length) return reply({ error: "forbidden" }, 403);
    if (scoped.length !== 1) return reply({ error: "client_ambiguous" }, 409);
    const found = scoped[0];
    const { data: inventory, error: inventoryError } = await ops.from("meta_campaign_inventory")
      .select("client_id,account_key,meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,checked_at")
      .eq("client_id", found.id)
      .order("campaign_name", { ascending: true })
      .limit(500);
    if (inventoryError) return reply({ error: "query_failed" }, 500);
    return reply({ ok: true, client: found, campaigns: inventory || [], source: requestSource });
  }

  const clientId = String(body?.client_id || "").trim();
  if (!clientId) return reply({ error: "client_required" }, 400);
  const { data: client, error: clientError } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle").eq("id", clientId).maybeSingle();
  if (clientError) return reply({ error: "query_failed" }, 500);
  if (!client) return reply({ error: "client_not_found" }, 404);
  if (role === "GT" && !elevated && String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403);
  if (client.lifecycle === "CHURNED" && !["CAPABILITIES"].includes(action)) return reply({ error: "client_churned" }, 409);

  if (action === "CAPABILITIES") {
    try {
      const granted = await adsManagementGranted(metaToken);
      return reply({ ok: true, meta_write: granted, permission: granted ? "ads_management" : null, actions: granted ? ["PAUSE", "RESUME"] : [], token_source: metaTokenSource });
    } catch (error) {
      return reply({ ok: false, error: "meta_capability_check_failed", detail: String((error as Error)?.message || error) }, 502);
    }
  }

  if (action === "PREVIEW") {
    const requestedAction = String(body?.action_type || "").toUpperCase();
    const actionType = requestedAction === "PAUSE" ? "META_PAUSE_CAMPAIGNS" : requestedAction === "RESUME" ? "META_RESUME_CAMPAIGNS" : "";
    if (!actionType) return reply({ error: "invalid_action_type" }, 400);
    const ids = [...new Set((Array.isArray(body?.campaign_ids) ? body.campaign_ids : []).map(String).filter((id: string) => /^\d{5,30}$/.test(id)))].slice(0, 20);
    if (!ids.length) return reply({ error: "campaigns_required" }, 400);
    const oneHourAgo = new Date(Date.now() - 36e5).toISOString();
    const { count } = await ops.from("safe_action_requests").select("id", { count: "exact", head: true }).eq("actor_user_id", user.id).gte("created_at", oneHourAgo);
    if (Number(count || 0) >= 20) return reply({ error: "rate_limited" }, 429);

    let hasWrite = false;
    try { hasWrite = await adsManagementGranted(metaToken); } catch { return reply({ error: "meta_capability_check_failed" }, 502); }
    if (!hasWrite) return reply({ error: "meta_write_permission_missing", required: "ads_management" }, 403);

    const { data: inventory, error: inventoryError } = await ops.from("meta_campaign_inventory").select("campaign_id,campaign_name,meta_ad_account_id").eq("client_id", clientId).in("campaign_id", ids);
    if (inventoryError) return reply({ error: "query_failed" }, 500);
    if ((inventory || []).length !== ids.length) return reply({ error: "campaign_not_owned_or_missing" }, 409);

    const live: Row[] = [];
    try {
      for (const id of ids) live.push(await campaign(metaToken, id));
    } catch (error) {
      return reply({ error: "meta_preview_failed", detail: String((error as Error)?.message || error) }, 502);
    }
    const desired = actionType === "META_PAUSE_CAMPAIGNS" ? "PAUSED" : "ACTIVE";
    const eligible = live.filter((c) => actionType === "META_PAUSE_CAMPAIGNS" ? c.status === "ACTIVE" : c.status === "PAUSED");
    if (!eligible.length) return reply({ error: "no_eligible_targets", desired_status: desired, campaigns: live.map((c) => ({ id: String(c.id), name: c.name || null, status: c.status || null, effective_status: c.effective_status || null })) }, 409);
    if (eligible.length !== live.length) return reply({ error: "mixed_or_ineligible_targets", eligible_ids: eligible.map((c) => String(c.id)), campaigns: live.map((c) => ({ id: String(c.id), name: c.name || null, status: c.status || null, effective_status: c.effective_status || null })) }, 409);

    const previewState = eligible.map((c) => ({ id: String(c.id), name: c.name || null, account_id: c.account_id || null, status: c.status || null, effective_status: c.effective_status || null, new_status: desired }));
    const previewHash = await sha256(JSON.stringify({ actor: user.id, client: clientId, action_type: actionType, targets: previewState }));
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { data: inserted, error: insertError } = await ops.from("safe_action_requests").insert({
      actor_user_id: user.id,
      actor_person: person,
      actor_role: role,
      client_id: clientId,
      action_type: actionType,
      target_ids: eligible.map((c) => String(c.id)),
      preview_state: previewState,
      before_state: previewState,
      preview_hash: previewHash,
      expires_at: expiresAt,
      request_metadata: { client_name: client.display_name, source: requestSource, meta_permission_checked: true, token_source: metaTokenSource },
    }).select("id,action_type,preview_state,expires_at,status").single();
    if (insertError || !inserted) return reply({ error: "preview_store_failed" }, 500);
    return reply({ ok: true, preview: inserted, confirmation_phrase: "CONFIRMAR", requires_password: true });
  }

  if (action === "EXECUTE") {
    const previewId = String(body?.preview_id || "").trim();
    const confirmation = String(body?.confirmation || "").trim().toUpperCase();
    const password = String(body?.password || "");
    if (!previewId || confirmation !== "CONFIRMAR" || !password) return reply({ error: "confirmation_required" }, 400);
    const { data: requestRow, error: requestError } = await ops.from("safe_action_requests").select("*").eq("id", previewId).eq("actor_user_id", user.id).eq("client_id", clientId).maybeSingle();
    if (requestError) return reply({ error: "query_failed" }, 500);
    if (!requestRow) return reply({ error: "preview_not_found" }, 404);
    if (requestRow.status !== "PREVIEWED") return reply({ error: "preview_not_executable", status: requestRow.status }, 409);
    if (new Date(requestRow.expires_at).getTime() < Date.now()) {
      await ops.from("safe_action_requests").update({ status: "EXPIRED", error: "Preview expired before confirmation." }).eq("id", previewId);
      return reply({ error: "preview_expired" }, 409);
    }
    if (!user.email) return reply({ error: "reauth_unavailable" }, 403);

    const reauth = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: reauthData, error: reauthError } = await reauth.auth.signInWithPassword({ email: user.email, password });
    if (reauthError || reauthData?.user?.id !== user.id) return reply({ error: "reauth_failed" }, 401);

    let hasWrite = false;
    try { hasWrite = await adsManagementGranted(metaToken); } catch { return reply({ error: "meta_capability_check_failed" }, 502); }
    if (!hasWrite) return reply({ error: "meta_write_permission_missing", required: "ads_management" }, 403);

    const before = Array.isArray(requestRow.preview_state) ? requestRow.preview_state : [];
    const expectedHash = await sha256(JSON.stringify({ actor: user.id, client: clientId, action_type: requestRow.action_type, targets: before }));
    if (expectedHash !== requestRow.preview_hash) return reply({ error: "preview_integrity_failed" }, 409);
    const desired: "ACTIVE" | "PAUSED" = requestRow.action_type === "META_PAUSE_CAMPAIGNS" ? "PAUSED" : "ACTIVE";

    const fresh: Row[] = [];
    try {
      for (const item of before) fresh.push(await campaign(metaToken, String(item.id)));
    } catch (error) {
      return reply({ error: "meta_preflight_failed", detail: String((error as Error)?.message || error) }, 502);
    }
    const stale = fresh.find((c) => {
      const p = before.find((x: Row) => String(x.id) === String(c.id));
      return !p || String(c.status || "") !== String(p.status || "");
    });
    if (stale) {
      await ops.from("safe_action_requests").update({ status: "EXPIRED", error: "Campaign state changed after preview." }).eq("id", previewId);
      return reply({ error: "preview_stale", campaign_id: String(stale.id) }, 409);
    }

    await ops.from("safe_action_requests").update({ status: "EXECUTING", confirmed_at: new Date().toISOString() }).eq("id", previewId);
    const changed: Row[] = [];
    try {
      for (const item of before) {
        await setCampaignStatus(metaToken, String(item.id), desired);
        changed.push(item);
      }
    } catch (error) {
      let rollbackOk = true;
      for (const item of changed.reverse()) {
        const oldStatus = String(item.status || "").toUpperCase();
        if (!(["ACTIVE", "PAUSED"] as string[]).includes(oldStatus)) continue;
        try { await setCampaignStatus(metaToken, String(item.id), oldStatus as "ACTIVE" | "PAUSED"); } catch { rollbackOk = false; }
      }
      await ops.from("safe_action_requests").update({
        status: rollbackOk ? "ROLLED_BACK" : "FAILED",
        executed_at: new Date().toISOString(),
        error: String((error as Error)?.message || error).slice(0, 500),
        verification: { rollback_attempted: true, rollback_ok: rollbackOk },
      }).eq("id", previewId);
      return reply({ error: "execution_failed", rollback_ok: rollbackOk }, 502);
    }

    const after: Row[] = [];
    try {
      for (const item of before) after.push(await campaign(metaToken, String(item.id)));
    } catch (error) {
      await ops.from("safe_action_requests").update({ status: "FAILED", executed_at: new Date().toISOString(), error: `Verification failed: ${String((error as Error)?.message || error).slice(0, 400)}` }).eq("id", previewId);
      return reply({ error: "verification_failed" }, 502);
    }
    const verified = after.every((c) => String(c.status || "").toUpperCase() === desired);
    const afterState = after.map((c) => ({ id: String(c.id), name: c.name || null, status: c.status || null, effective_status: c.effective_status || null, account_id: c.account_id || null }));
    await ops.from("safe_action_requests").update({
      status: verified ? "VERIFIED" : "FAILED",
      executed_at: new Date().toISOString(),
      after_state: afterState,
      verification: { verified, desired_status: desired, verified_at: new Date().toISOString() },
      error: verified ? null : "Meta returned a state different from the requested state after execution.",
    }).eq("id", previewId);
    if (verified) {
      for (const c of after) await ops.from("meta_campaign_inventory").update({ campaign_status: c.status, checked_at: new Date().toISOString() }).eq("client_id", clientId).eq("campaign_id", String(c.id));
    }
    return reply({ ok: verified, status: verified ? "VERIFIED" : "FAILED", desired_status: desired, before, after: afterState, verification: { verified } }, verified ? 200 : 502);
  }

  return reply({ error: "unknown_action" }, 400);
});
