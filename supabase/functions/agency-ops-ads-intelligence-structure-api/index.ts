import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const VERSION = "v21.0";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=15" },
});
const finite = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const cleanAccount = (v: unknown) => String(v || "").trim().replace(/^act_/, "");
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (day: string, delta: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };

async function metaJson(url: string) {
  const response = await fetch(url);
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
async function paged(url: string, cap = 500) {
  const rows: Row[] = [];
  let next = url, pages = 0;
  while (next && rows.length < cap && pages < 6) {
    const body = await metaJson(next);
    rows.push(...(body?.data || []));
    next = String(body?.paging?.next || "");
    pages += 1;
  }
  return rows.slice(0, cap);
}
async function edgeWithFieldFallback(accountId: string, edge: "adsets" | "ads", candidates: string[], limit: number, cap: number, token: string) {
  const attempts: Row[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const rows = await paged(`https://graph.facebook.com/${VERSION}/act_${accountId}/${edge}?fields=${encodeURIComponent(candidates[i])}&limit=${limit}&access_token=${encodeURIComponent(token)}`, cap);
      return { rows, fallback_level: i, attempts };
    } catch (error) {
      attempts.push({ level: i, error: String(error instanceof Error ? error.message : error).slice(0, 220), meta_code: (error as any)?.metaCode ?? null });
    }
  }
  throw Object.assign(new Error(attempts.at(-1)?.error || `Meta ${edge} failed`), { attempts });
}
async function insightsWithFieldFallback(accountId: string, level: "adset" | "ad", range: string, candidates: string[], limit: number, cap: number, token: string) {
  const attempts: Row[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const rows = await paged(`https://graph.facebook.com/${VERSION}/act_${accountId}/insights?level=${level}&time_range=${range}&fields=${encodeURIComponent(candidates[i])}&limit=${limit}&access_token=${encodeURIComponent(token)}`, cap);
      return { rows, fallback_level: i, attempts };
    } catch (error) {
      attempts.push({ level: i, error: String(error instanceof Error ? error.message : error).slice(0, 220), meta_code: (error as any)?.metaCode ?? null });
    }
  }
  throw Object.assign(new Error(attempts.at(-1)?.error || `Meta ${level} insights failed`), { attempts });
}
function actionCount(actions: unknown) {
  if (!Array.isArray(actions)) return null;
  const priorities = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "onsite_conversion.messaging_conversation_started_7d", "omni_lead"];
  for (const key of priorities) {
    const row = actions.find((x: Row) => String(x.action_type) === key);
    const value = finite(row?.value); if (value !== null) return value;
  }
  return null;
}
function cpr(spend: unknown, results: unknown) {
  const s = finite(spend), r = finite(results);
  return s !== null && r !== null && r > 0 ? s / r : null;
}
function failure(stage: string, accountId: string, reason: unknown) {
  return { account_id: accountId, stage, error: String(reason instanceof Error ? reason.message : reason).slice(0, 240), meta_code: (reason as any)?.metaCode ?? null };
}
function fallbackAds(catalog: Row[], accountId: string) {
  return catalog.filter((r) => cleanAccount(r.meta_ad_account_id) === accountId && r.ad_id).map((r) => ({
    id: String(r.ad_id), name: r.ad_name || r.creative_name || `Anúncio ${r.ad_id}`, status: r.ad_status || "", effective_status: null,
    campaign_id: r.campaign_id || null, campaign_name: r.campaign_name || null, adset_id: r.adset_id || null,
    creative: { id: r.creative_id || null, name: r.creative_name || null, thumbnail_url: r.thumbnail_url || null, image_url: r.image_url || null },
    account_id: accountId, source: "WAREHOUSE_SNAPSHOT", last_synced_at: r.last_synced_at || null, metrics_available: true,
    spend: finite(r.spend_7d), impressions: finite(r.impressions_7d), clicks: finite(r.clicks_7d), ctr: finite(r.ctr_7d),
    cpc: finite(r.clicks_7d) && finite(r.spend_7d) !== null ? Number(r.spend_7d) / Number(r.clicks_7d) : null,
    cpm: finite(r.impressions_7d) && finite(r.spend_7d) !== null ? Number(r.spend_7d) / Number(r.impressions_7d) * 1000 : null,
    frequency: finite(r.frequency_7d), results: finite(r.results_7d ?? r.leads_7d), cost_per_result: finite(r.cost_per_result_7d),
  }));
}
function fallbackAdsets(catalog: Row[], accountId: string) {
  const groups = new Map<string, Row[]>();
  for (const r of catalog.filter((x) => cleanAccount(x.meta_ad_account_id) === accountId && x.adset_id)) {
    const id = String(r.adset_id); if (!groups.has(id)) groups.set(id, []); groups.get(id)!.push(r);
  }
  return [...groups.entries()].map(([id, rows]) => {
    const first = rows[0];
    const spend = rows.reduce((s, r) => s + (finite(r.spend_7d) || 0), 0);
    const impressions = rows.reduce((s, r) => s + (finite(r.impressions_7d) || 0), 0);
    const clicks = rows.reduce((s, r) => s + (finite(r.clicks_7d) || 0), 0);
    const results = rows.reduce((s, r) => s + (finite(r.results_7d ?? r.leads_7d) || 0), 0);
    return {
      id, name: first.adset_name || `Conjunto ${id}`, status: "", effective_status: null, campaign_id: first.campaign_id || null,
      campaign_name: first.campaign_name || null, daily_budget: null, lifetime_budget: null, optimization_goal: null,
      account_id: accountId, source: "WAREHOUSE_SNAPSHOT", last_synced_at: rows.map((r) => r.last_synced_at).filter(Boolean).sort().at(-1) || null,
      metrics_available: true, spend, impressions, clicks, ctr: impressions > 0 ? clicks / impressions * 100 : null,
      cpc: clicks > 0 ? spend / clicks : null, cpm: impressions > 0 ? spend / impressions * 1000 : null,
      reach: null, frequency: null, results, cost_per_result: results > 0 ? spend / results : null,
    };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "", anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "", serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user?.id) return json({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", authData.user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", authData.user.id).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((r: Row) => r.kind === "SIGNUP")) return json({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  const role = String(roster?.role || "").toUpperCase();
  const elevated = (approvals || []).some((r: Row) => r.kind === "ELEVATION");
  if (!roster || roster.is_former || !["GT", "MGMT"].includes(role)) return json({ error: "not_found" }, 404);

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get("client_id") || "").trim();
  const clientName = String(url.searchParams.get("client_name") || "").trim();
  if (!clientId && !clientName) return json({ error: "client_required" }, 400);
  let clientQ = ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner").eq("lifecycle", "ACTIVE");
  clientQ = clientId ? clientQ.eq("id", clientId) : clientQ.eq("display_name", clientName);
  if (role === "GT" && !elevated) clientQ = clientQ.eq("gt_owner", person);
  const { data: clients, error: clientError } = await clientQ.limit(3);
  if (clientError) return json({ error: "query_failed" }, 500);
  if (!(clients || []).length) return json({ error: "client_not_found" }, 404);
  if ((clients || []).length !== 1) return json({ error: "client_ambiguous" }, 409);
  const client = clients![0];
  const [{ data: balances, error: balanceError }, { data: catalogRows }] = await Promise.all([
    ops.from("client_balance_overview").select("meta_ad_account_id,account_key,currency,account_status,checked_at").eq("client_id", client.id),
    ops.from("meta_creative_catalog").select("meta_ad_account_id,ad_id,ad_name,ad_status,campaign_id,campaign_name,campaign_status,adset_id,adset_name,creative_id,creative_name,thumbnail_url,image_url,spend_7d,impressions_7d,clicks_7d,ctr_7d,frequency_7d,leads_7d,results_7d,cost_per_result_7d,last_synced_at,is_current").eq("client_id", client.id).eq("is_current", true).limit(2000),
  ]);
  if (balanceError) return json({ error: "query_failed" }, 500);
  const accountIds = [...new Set((balances || []).map((r: Row) => cleanAccount(r.meta_ad_account_id)).filter((id: string) => /^\d{5,30}$/.test(id)))];
  if (!accountIds.length) return json({ error: "meta_account_missing", client }, 409);
  const token = await resolveToken(db);
  if (!token) return json({ error: "meta_token_missing" }, 503);

  const today = localDate(), since = shift(today, -6), range = encodeURIComponent(JSON.stringify({ since, until: today }));
  const adsets: Row[] = [], ads: Row[] = [], liveErrors: Row[] = [], unresolvedErrors: Row[] = [], fallbacksUsed: Row[] = [];
  const catalog = catalogRows || [];
  const adsetFieldCandidates = [
    "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,start_time,end_time",
    "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,start_time,end_time",
    "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget",
    "id,name,status,campaign_id",
  ];
  const adFieldCandidates = [
    "id,name,status,effective_status,campaign_id,adset_id,creative{id,name,thumbnail_url,image_url}",
    "id,name,status,effective_status,campaign_id,adset_id,creative{id,name,thumbnail_url}",
    "id,name,status,effective_status,campaign_id,adset_id",
    "id,name,status,campaign_id,adset_id",
  ];
  const insightCandidates = [
    "spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions",
    "spend,impressions,clicks,ctr,cpc,cpm,frequency,actions",
    "spend,impressions,clicks,ctr,frequency",
  ];

  await Promise.all(accountIds.map(async (accountId) => {
    const [setsResult, adsResult, setInsightsResult, adInsightsResult] = await Promise.allSettled([
      edgeWithFieldFallback(accountId, "adsets", adsetFieldCandidates, 200, 500, token),
      edgeWithFieldFallback(accountId, "ads", adFieldCandidates, 250, 800, token),
      insightsWithFieldFallback(accountId, "adset", range, insightCandidates, 200, 500, token),
      insightsWithFieldFallback(accountId, "ad", range, insightCandidates, 250, 800, token),
    ]);
    let setsRaw = setsResult.status === "fulfilled" ? setsResult.value.rows : [];
    let adsRaw = adsResult.status === "fulfilled" ? adsResult.value.rows : [];
    const setInsights = setInsightsResult.status === "fulfilled" ? setInsightsResult.value.rows : [];
    const adInsights = adInsightsResult.status === "fulfilled" ? adInsightsResult.value.rows : [];

    if (setsResult.status === "fulfilled" && setsResult.value.fallback_level > 0) fallbacksUsed.push({ account_id: accountId, stage: "ADSETS_FIELDS", level: setsResult.value.fallback_level });
    if (adsResult.status === "fulfilled" && adsResult.value.fallback_level > 0) fallbacksUsed.push({ account_id: accountId, stage: "ADS_FIELDS", level: adsResult.value.fallback_level });
    if (setInsightsResult.status === "fulfilled" && setInsightsResult.value.fallback_level > 0) fallbacksUsed.push({ account_id: accountId, stage: "ADSETS_INSIGHTS_FIELDS", level: setInsightsResult.value.fallback_level });
    if (adInsightsResult.status === "fulfilled" && adInsightsResult.value.fallback_level > 0) fallbacksUsed.push({ account_id: accountId, stage: "ADS_INSIGHTS_FIELDS", level: adInsightsResult.value.fallback_level });

    if (setsResult.status === "rejected") {
      liveErrors.push(failure("ADSETS_STRUCTURE", accountId, setsResult.reason));
      const backup = fallbackAdsets(catalog, accountId);
      if (backup.length) { setsRaw = backup; fallbacksUsed.push({ account_id: accountId, stage: "ADSETS_WAREHOUSE", rows: backup.length }); }
      else unresolvedErrors.push(failure("ADSETS_STRUCTURE", accountId, setsResult.reason));
    }
    if (adsResult.status === "rejected") {
      liveErrors.push(failure("ADS_STRUCTURE", accountId, adsResult.reason));
      const backup = fallbackAds(catalog, accountId);
      if (backup.length) { adsRaw = backup; fallbacksUsed.push({ account_id: accountId, stage: "ADS_WAREHOUSE", rows: backup.length }); }
      else unresolvedErrors.push(failure("ADS_STRUCTURE", accountId, adsResult.reason));
    }
    if (setInsightsResult.status === "rejected") liveErrors.push(failure("ADSETS_INSIGHTS", accountId, setInsightsResult.reason));
    if (adInsightsResult.status === "rejected") liveErrors.push(failure("ADS_INSIGHTS", accountId, adInsightsResult.reason));

    const setInsightMap = new Map(setInsights.map((r: Row) => [String(r.adset_id), r]));
    const adInsightMap = new Map(adInsights.map((r: Row) => [String(r.ad_id), r]));
    for (const row of setsRaw) {
      if (row.source === "WAREHOUSE_SNAPSHOT") { adsets.push(row); continue; }
      const m = setInsightMap.get(String(row.id)) || {};
      const results = actionCount(m.actions);
      adsets.push({ ...row, account_id: accountId, source: "META_LIVE", metrics_available: setInsightsResult.status === "fulfilled", spend: finite(m.spend), impressions: finite(m.impressions), clicks: finite(m.clicks), ctr: finite(m.ctr), cpc: finite(m.cpc), cpm: finite(m.cpm), reach: finite(m.reach), frequency: finite(m.frequency), results, cost_per_result: cpr(m.spend, results) });
    }
    for (const row of adsRaw) {
      if (row.source === "WAREHOUSE_SNAPSHOT") { ads.push(row); continue; }
      const m = adInsightMap.get(String(row.id)) || {};
      const results = actionCount(m.actions);
      ads.push({ ...row, account_id: accountId, source: "META_LIVE", metrics_available: adInsightsResult.status === "fulfilled", spend: finite(m.spend), impressions: finite(m.impressions), clicks: finite(m.clicks), ctr: finite(m.ctr), cpc: finite(m.cpc), cpm: finite(m.cpm), reach: finite(m.reach), frequency: finite(m.frequency), results, cost_per_result: cpr(m.spend, results) });
    }
  }));

  adsets.sort((a, b) => (finite(b.spend) || 0) - (finite(a.spend) || 0) || String(a.name).localeCompare(String(b.name), "pt-BR"));
  ads.sort((a, b) => (finite(b.spend) || 0) - (finite(a.spend) || 0) || String(a.name).localeCompare(String(b.name), "pt-BR"));
  const warehouseRows = [...adsets, ...ads].filter((r) => r.source === "WAREHOUSE_SNAPSHOT");
  const liveRows = [...adsets, ...ads].filter((r) => r.source === "META_LIVE");
  return json({
    ok: true, client, period: { since, until: today, days: 7 }, accounts: accountIds,
    adsets, ads,
    partial: unresolvedErrors.length > 0,
    account_errors: unresolvedErrors,
    live_errors: liveErrors,
    fallbacks_used: fallbacksUsed,
    data_source: warehouseRows.length && liveRows.length ? "MIXED" : warehouseRows.length ? "WAREHOUSE_FALLBACK" : "META_LIVE",
    coverage: { accounts_total: accountIds.length, accounts_with_unresolved_errors: [...new Set(unresolvedErrors.map((x) => x.account_id))].length, adsets_loaded: adsets.length, ads_loaded: ads.length, warehouse_rows: warehouseRows.length, live_rows: liveRows.length },
    capabilities: { adset_status: true, ad_status: true, adset_daily_budget: true }, generated_at: new Date().toISOString(),
  });
});
