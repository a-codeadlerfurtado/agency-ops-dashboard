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
type TokenCandidate = { token: string; source: string };

function clean(value: unknown) { return String(value || "").trim(); }
function accountKey(value: unknown) { return clean(value).toLowerCase().replace(/^act_/, "").replace(/\s+/g, ""); }
function numericAccount(value: unknown) { const v = accountKey(value); return /^\d{5,30}$/.test(v) ? v : ""; }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function metaJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `Meta HTTP ${response.status}`);
    (error as any).metaCode = body?.error?.code ?? response.status;
    throw error;
  }
  return body;
}
async function adsManagementGranted(token: string) {
  const body = await metaJson(`https://graph.facebook.com/${VERSION}/me/permissions?access_token=${encodeURIComponent(token)}`);
  return (body?.data || []).some((item: Row) => item.permission === "ads_management" && item.status === "granted");
}
async function liveAdAccount(token: string, id: string) {
  return await metaJson(`https://graph.facebook.com/${VERSION}/act_${encodeURIComponent(id)}?fields=id,name,account_status&access_token=${encodeURIComponent(token)}`);
}
async function liveCampaign(token: string, id: string) {
  return await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}?fields=id,name,status,effective_status,account_id&access_token=${encodeURIComponent(token)}`);
}
async function setCampaignStatus(token: string, id: string, status: "ACTIVE" | "PAUSED") {
  const body = new URLSearchParams();
  body.set("access_token", token);
  body.set("status", status);
  return await metaJson(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
async function tokenCandidates(db: any): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const { data, error } = await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vault = !error && typeof data === "string" ? data.trim() : "";
  if (vault) out.push({ token: vault, source: "SUPABASE_VAULT" });
  const env = clean(Deno.env.get("META_SYSTEM_USER_TOKEN"));
  if (env && !out.some((item) => item.token === env)) out.push({ token: env, source: "EDGE_ENV" });
  return out;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = clean(Deno.env.get("SUPABASE_URL"));
  const anonKey = clean(Deno.env.get("SUPABASE_ANON_KEY"));
  const serviceRole = clean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  const user = userData?.user;
  if (authError || !user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name);
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "inactive_profile" }, 403);
  const role = clean(roster.role).toUpperCase();
  const isAdler = person === "Adler Furtado";
  if (!(role === "GT" || isAdler)) return reply({ error: "forbidden" }, 403);
  const elevated = (approvals || []).some((row: Row) => row.kind === "ELEVATION");

  const body = await req.json().catch(() => ({}));
  const clientName = clean(body?.client_name);
  const campaignName = clean(body?.campaign_name);
  const requestedAccount = clean(body?.account_key);
  const desired = clean(body?.desired_status).toUpperCase();
  if (!clientName || !campaignName) return reply({ error: "target_required" }, 400);
  if (!(desired === "ACTIVE" || desired === "PAUSED")) return reply({ error: "invalid_desired_status" }, 400);

  const { data: clients, error: clientsError } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle").eq("display_name", clientName).limit(4);
  if (clientsError) return reply({ error: "query_failed" }, 500);
  const scopedClients = (clients || []).filter((row: Row) => isAdler || elevated || (role === "GT" && clean(row.gt_owner) === person));
  if (!(clients || []).length) return reply({ error: "client_not_found" }, 404);
  if (!scopedClients.length) return reply({ error: "forbidden" }, 403);
  if (scopedClients.length !== 1) return reply({ error: "client_ambiguous" }, 409);
  const client = scopedClients[0];
  if (clean(client.lifecycle).toUpperCase() === "CHURNED") return reply({ error: "client_churned" }, 409);

  const { data: inventory, error: inventoryError } = await ops.from("meta_campaign_inventory")
    .select("client_id,account_key,meta_ad_account_id,campaign_id,campaign_name,campaign_status,checked_at")
    .eq("client_id", client.id).eq("campaign_name", campaignName).limit(10);
  if (inventoryError) return reply({ error: "query_failed" }, 500);
  let candidates = inventory || [];
  if (requestedAccount) {
    const key = accountKey(requestedAccount);
    const narrowed = candidates.filter((row: Row) => accountKey(row.account_key) === key || accountKey(row.meta_ad_account_id) === key);
    if (narrowed.length) candidates = narrowed;
  }
  if (!candidates.length) return reply({ error: "campaign_not_found" }, 404);
  if (candidates.length !== 1) return reply({ error: "campaign_ambiguous" }, 409);
  const inventoryRow = candidates[0];
  const campaignId = clean(inventoryRow.campaign_id);
  if (!/^\d{5,30}$/.test(campaignId)) return reply({ error: "invalid_campaign_id" }, 409);

  const oneHourAgo = new Date(Date.now() - 36e5).toISOString();
  const { count } = await ops.from("safe_action_requests").select("id", { count: "exact", head: true }).eq("actor_user_id", user.id).gte("created_at", oneHourAgo);
  if (Number(count || 0) >= 60) return reply({ error: "rate_limited" }, 429);

  const actionType = desired === "ACTIVE" ? "META_RESUME_CAMPAIGNS" : "META_PAUSE_CAMPAIGNS";
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const inventoryBefore = [{
    id: campaignId,
    name: campaignName,
    account_id: inventoryRow.meta_ad_account_id || null,
    status: inventoryRow.campaign_status || null,
    effective_status: null,
    new_status: desired,
  }];
  const baseHash = await sha256(JSON.stringify({ actor: user.id, client: client.id, campaign: campaignId, inventory_status: inventoryRow.campaign_status || null, desired }));

  const storeFailedPreflight = async (reason: string, tokenSource?: string | null) => {
    const { data } = await ops.from("safe_action_requests").insert({
      actor_user_id: user.id,
      actor_person: person,
      actor_role: role,
      client_id: client.id,
      action_type: actionType,
      target_ids: [campaignId],
      preview_state: inventoryBefore,
      preview_hash: baseHash,
      expires_at: expiresAt,
      status: "FAILED",
      confirmed_at: nowIso,
      executed_at: nowIso,
      before_state: inventoryBefore,
      error: reason.slice(0, 500),
      request_metadata: {
        source: "CAMPAIGNS_INLINE_V2",
        interaction: "ONE_CLICK",
        password_required: false,
        client_name: client.display_name,
        campaign_name: campaignName,
        account_key: requestedAccount || null,
        token_source: tokenSource || null,
        stage: "PREFLIGHT",
      },
    }).select("id").maybeSingle();
    return data?.id || null;
  };

  const tokens = await tokenCandidates(db);
  if (!tokens.length) {
    await storeFailedPreflight("No Meta write token configured.", null);
    return reply({ error: "meta_token_missing" }, 503);
  }

  const expectedAccountId = numericAccount(inventoryRow.meta_ad_account_id);
  let selected: TokenCandidate | null = null;
  let selectedAccount: Row | null = null;
  let anyAdsManagement = false;
  let capabilityCheckFailed = false;

  for (const candidate of tokens) {
    let granted = false;
    try { granted = await adsManagementGranted(candidate.token); }
    catch { capabilityCheckFailed = true; continue; }
    if (!granted) continue;
    anyAdsManagement = true;
    if (expectedAccountId) {
      try {
        const account = await liveAdAccount(candidate.token, expectedAccountId);
        selected = candidate;
        selectedAccount = account;
        break;
      } catch {
        continue;
      }
    } else {
      selected = candidate;
      break;
    }
  }

  if (!selected) {
    if (!anyAdsManagement) {
      await storeFailedPreflight(capabilityCheckFailed ? "Meta capability check failed for configured tokens." : "Configured Meta tokens do not have ads_management.", null);
      return reply({ error: capabilityCheckFailed ? "meta_capability_check_failed" : "meta_write_permission_missing" }, capabilityCheckFailed ? 502 : 403);
    }
    const auditId = await storeFailedPreflight(`Write token has ads_management but cannot access ad account ${expectedAccountId || requestedAccount || "unknown"}.`, "NO_ACCOUNT_MATCH");
    return reply({
      error: "meta_account_access_missing",
      account_id: expectedAccountId || null,
      account_name: requestedAccount || inventoryRow.account_key || null,
      audit_id: auditId,
    }, 403);
  }

  let before: Row;
  try { before = await liveCampaign(selected.token, campaignId); }
  catch (error) {
    const auditId = await storeFailedPreflight(`Meta campaign read failed: ${clean((error as Error)?.message || error)}`, selected.source);
    return reply({ error: "meta_read_failed", account_id: expectedAccountId || null, account_name: requestedAccount || inventoryRow.account_key || null, audit_id: auditId }, 502);
  }

  const liveAccount = accountKey(before.account_id);
  const expectedAccount = accountKey(inventoryRow.meta_ad_account_id || inventoryRow.account_key);
  if (liveAccount && expectedAccount && liveAccount !== expectedAccount) {
    await storeFailedPreflight(`Account mismatch. Live ${liveAccount}; expected ${expectedAccount}.`, selected.source);
    return reply({ error: "account_mismatch" }, 409);
  }
  const beforeStatus = clean(before.status).toUpperCase();
  if (!(beforeStatus === "ACTIVE" || beforeStatus === "PAUSED")) {
    await storeFailedPreflight(`Campaign state is not toggleable: ${beforeStatus}.`, selected.source);
    return reply({ error: "campaign_state_not_toggleable", status: beforeStatus }, 409);
  }

  const beforeState = [{
    id: campaignId,
    name: before.name || campaignName,
    account_id: before.account_id || null,
    status: before.status || null,
    effective_status: before.effective_status || null,
    new_status: desired,
  }];
  const hash = await sha256(JSON.stringify({ actor: user.id, client: client.id, campaign: campaignId, before: beforeStatus, desired }));
  const { data: audit, error: auditError } = await ops.from("safe_action_requests").insert({
    actor_user_id: user.id,
    actor_person: person,
    actor_role: role,
    client_id: client.id,
    action_type: actionType,
    target_ids: [campaignId],
    preview_state: beforeState,
    preview_hash: hash,
    expires_at: expiresAt,
    status: "EXECUTING",
    confirmed_at: nowIso,
    before_state: beforeState,
    request_metadata: {
      source: "CAMPAIGNS_INLINE_V2",
      interaction: "ONE_CLICK",
      password_required: false,
      client_name: client.display_name,
      campaign_name: campaignName,
      account_key: requestedAccount || null,
      token_source: selected.source,
      account_name: selectedAccount?.name || null,
    },
  }).select("id").single();
  if (auditError || !audit?.id) return reply({ error: "audit_store_failed" }, 500);

  if (beforeStatus === desired) {
    const afterState = [{ id: campaignId, name: before.name || campaignName, account_id: before.account_id || null, status: before.status || null, effective_status: before.effective_status || null }];
    await ops.from("safe_action_requests").update({ status: "VERIFIED", executed_at: new Date().toISOString(), after_state: afterState, verification: { verified: true, no_op: true, desired_status: desired, verified_at: new Date().toISOString() } }).eq("id", audit.id);
    await ops.from("meta_campaign_inventory").update({ campaign_status: desired, checked_at: new Date().toISOString() }).eq("client_id", client.id).eq("campaign_id", campaignId);
    return reply({ ok: true, status: "VERIFIED", no_op: true, campaign_id: campaignId, campaign_name: campaignName, before_status: beforeStatus, after_status: desired, audit_id: audit.id });
  }

  try { await setCampaignStatus(selected.token, campaignId, desired as "ACTIVE" | "PAUSED"); }
  catch (error) {
    await ops.from("safe_action_requests").update({ status: "FAILED", executed_at: new Date().toISOString(), error: clean((error as Error)?.message || error).slice(0, 500) }).eq("id", audit.id);
    return reply({ error: "execution_failed", audit_id: audit.id }, 502);
  }

  let after: Row;
  try { after = await liveCampaign(selected.token, campaignId); }
  catch (error) {
    await ops.from("safe_action_requests").update({ status: "FAILED", executed_at: new Date().toISOString(), error: `Verification failed: ${clean((error as Error)?.message || error).slice(0, 430)}` }).eq("id", audit.id);
    return reply({ error: "verification_failed", audit_id: audit.id }, 502);
  }

  const verified = clean(after.status).toUpperCase() === desired;
  const afterState = [{ id: campaignId, name: after.name || campaignName, account_id: after.account_id || null, status: after.status || null, effective_status: after.effective_status || null }];
  if (!verified) {
    let rollbackOk = false;
    try {
      await setCampaignStatus(selected.token, campaignId, beforeStatus as "ACTIVE" | "PAUSED");
      const rollback = await liveCampaign(selected.token, campaignId);
      rollbackOk = clean(rollback.status).toUpperCase() === beforeStatus;
    } catch { rollbackOk = false; }
    await ops.from("safe_action_requests").update({ status: rollbackOk ? "ROLLED_BACK" : "FAILED", executed_at: new Date().toISOString(), after_state: afterState, verification: { verified: false, desired_status: desired, rollback_attempted: true, rollback_ok: rollbackOk, verified_at: new Date().toISOString() }, error: "Meta returned a state different from the requested state after execution." }).eq("id", audit.id);
    return reply({ error: "verification_failed", rollback_ok: rollbackOk, audit_id: audit.id }, 502);
  }

  await ops.from("safe_action_requests").update({ status: "VERIFIED", executed_at: new Date().toISOString(), after_state: afterState, verification: { verified: true, desired_status: desired, verified_at: new Date().toISOString() }, error: null }).eq("id", audit.id);
  await ops.from("meta_campaign_inventory").update({ campaign_status: desired, checked_at: new Date().toISOString() }).eq("client_id", client.id).eq("campaign_id", campaignId);

  return reply({
    ok: true,
    status: "VERIFIED",
    campaign_id: campaignId,
    campaign_name: after.name || campaignName,
    before_status: beforeStatus,
    after_status: desired,
    effective_status: after.effective_status || null,
    audit_id: audit.id,
  });
});
