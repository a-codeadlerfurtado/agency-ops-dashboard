import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH_API_VERSION = "v25.0";
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const WINDOWS = new Set([3, 7, 14, 30]);
const MAX_ADS_PER_CLIENT = 40;
const CACHE_HOURS = 12;
const PREVIEW_BUCKET = "agency-meta-creative-previews";
const PREVIEW_SIGNED_SECONDS = 6 * 60 * 60;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const PREVIEW_CONCURRENCY = 6;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};

type Row = Record<string, any>;
type Action = { action_type: string; value: string };
type Insight = {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  frequency?: string;
  actions?: Action[];
  account_id?: string;
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const number = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const divide = (a: number, b: number) => (b > 0 ? a / b : null);

function exact(actions: Action[] | undefined, type: string) {
  const row = (actions || []).find((item) => item.action_type.toLowerCase() === type.toLowerCase());
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? { value, source: row.action_type } : null;
}
function contains(actions: Action[] | undefined, needle: string) {
  let best: { value: number; source: string } | null = null;
  for (const row of (actions || []).filter((item) => item.action_type.toLowerCase().includes(needle.toLowerCase()))) {
    const value = Number(row.value);
    if (Number.isFinite(value) && (!best || value > best.value)) best = { value, source: row.action_type };
  }
  return best;
}
function canonical(adName: string | null, actions: Action[] | undefined) {
  const lead = exact(actions, "lead") ?? exact(actions, "onsite_conversion.lead_grouped") ?? exact(actions, "offsite_complete_registration_add_meta_leads");
  const message = contains(actions, "messaging_conversation_started") ?? contains(actions, "total_messaging_connection");
  const messageByName = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test(String(adName || "").toLowerCase());
  const useMessage = messageByName || (!lead && Boolean(message));
  const result = useMessage ? message : lead;
  return {
    leads: lead?.value ?? 0,
    results: result?.value ?? 0,
    resultType: result ? (useMessage ? "MENSAGEM" : "LEAD") : null,
    resultSource: result?.source ?? null,
  };
}
function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shift(day: string, delta: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function isFresh(value: string | null | undefined) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < CACHE_HOURS * 3600_000;
}
function previewExtension(contentType: string) {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

async function graph(url: string, retries = 3): Promise<any> {
  let lastError = "Meta API error";
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (response.ok && body && !body.error) return body;
    lastError = String(body?.error?.message || `HTTP ${response.status}`).slice(0, 500);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries - 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
  }
  throw new Error(lastError);
}
async function paged(url: string) {
  const rows: any[] = [];
  let next: string | null = url;
  while (next) {
    const body = await graph(next);
    rows.push(...(body.data || []));
    next = body.paging?.next || null;
    if (rows.length >= 1000) break;
  }
  return rows;
}
async function batchGet(paths: string[], token: string) {
  const output = new Map<string, Row>();
  for (let offset = 0; offset < paths.length; offset += 50) {
    const chunk = paths.slice(offset, offset + 50);
    const body = new URLSearchParams({
      access_token: token,
      batch: JSON.stringify(chunk.map((relativeUrl) => ({ method: "GET", relative_url: relativeUrl }))),
    });
    const response = await fetch(GRAPH_ROOT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const batch = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(batch)) throw new Error(String(batch?.error?.message || `Meta batch HTTP ${response.status}`));
    batch.forEach((item: any, index: number) => {
      if (Number(item?.code) < 200 || Number(item?.code) >= 300) return;
      try {
        const parsed = JSON.parse(String(item.body || "{}"));
        if (parsed && !parsed.error) output.set(chunk[index], parsed);
      } catch {
        // Uma resposta inválida não derruba o restante do lote.
      }
    });
  }
  return output;
}
async function adInsights(accountId: string, token: string, dateFrom: string, dateTo: string) {
  const fields = ["ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","spend","impressions","clicks","reach","frequency","actions"].join(",");
  const range = encodeURIComponent(JSON.stringify({ since: dateFrom, until: dateTo }));
  const url = `${GRAPH_ROOT}/act_${accountId}/insights?level=ad&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`;
  const rows = await paged(url) as Insight[];
  return rows.map((row) => ({ ...row, account_id: accountId }));
}

async function mirrorPreview(db: any, clientId: string, adId: string, sources: string[]) {
  const uniqueSources = [...new Set(sources.map((value) => String(value || "").trim()).filter(Boolean))];
  for (const source of uniqueSources) {
    try {
      const response = await fetch(source, { redirect: "follow" });
      if (!response.ok) continue;
      const contentType = String(response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      if (!contentType.startsWith("image/")) continue;
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > MAX_PREVIEW_BYTES) continue;
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > MAX_PREVIEW_BYTES) continue;
      const path = `${clientId}/${adId}.${previewExtension(contentType)}`;
      const { error } = await db.storage.from(PREVIEW_BUCKET).upload(path, new Uint8Array(buffer), {
        contentType,
        cacheControl: "31536000",
        upsert: true,
      });
      if (!error) return { path, bytes: buffer.byteLength, content_type: contentType };
    } catch {
      // Tenta a próxima URL de origem.
    }
  }
  return null;
}

async function mapConcurrent<T, R>(values: T[], worker: (value: T, index: number) => Promise<R>, concurrency = PREVIEW_CONCURRENCY) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function withSignedPreviews(db: any, rows: Row[]) {
  const paths = [...new Set(rows.map((row) => String(row.metadata?.preview_storage_path || "")).filter(Boolean))];
  if (!paths.length) return rows;
  const { data, error } = await db.storage.from(PREVIEW_BUCKET).createSignedUrls(paths, PREVIEW_SIGNED_SECONDS);
  if (error || !Array.isArray(data)) return rows;
  const signed = new Map<string, string>();
  data.forEach((item: any, index: number) => {
    const path = String(item?.path || paths[index] || "");
    const url = String(item?.signedUrl || "");
    if (path && url) signed.set(path, url);
  });
  return rows.map((row) => {
    const path = String(row.metadata?.preview_storage_path || "");
    const url = signed.get(path);
    if (!url) return row;
    return {
      ...row,
      thumbnail_url: url,
      image_url: url,
      metadata: { ...(row.metadata || {}), preview_stable: true, preview_delivery: "SUPABASE_SIGNED_URL" },
    };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user?.id) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", authData.user.id).maybeSingle();
  const person = String(pref?.collaborator_person || "").trim();
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
  const role = String(roster?.role || "").toUpperCase();
  if (!person || !roster || !["MGMT", "GT"].includes(role)) return respond({ error: "not_found" }, 404);
  const walletOnly = role === "GT";
  const profile = { person, role, scope: walletOnly ? "WALLET" : "ALL" };

  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (req.method === "GET" && url.searchParams.get("clients") === "1") {
    let clientsQuery = ops.from("clients").select("id,display_name,gt_owner").eq("lifecycle", "ACTIVE").order("display_name", { ascending: true });
    if (walletOnly) clientsQuery = clientsQuery.eq("gt_owner", person);
    const { data: clients, error: clientsError } = await clientsQuery;
    if (clientsError) return respond({ error: "clients_failed", detail: clientsError.message }, 500);
    return respond({ profile, clients: (clients || []).map((client: Row) => ({ client_id: client.id, client_name: client.display_name, gt_owner: client.gt_owner })), generated_at: new Date().toISOString() });
  }

  const clientId = String(body?.client_id || url.searchParams.get("client_id") || "").trim();
  const periodDays = Number(body?.period_days || url.searchParams.get("period_days") || 7);
  const force = Boolean(body?.force);
  if (!clientId || !WINDOWS.has(periodDays)) return respond({ error: "invalid_parameters" }, 400);

  let clientQuery = ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("id", clientId);
  if (walletOnly) clientQuery = clientQuery.eq("gt_owner", person);
  const { data: client } = await clientQuery.maybeSingle();
  if (!client) return respond({ error: "client_not_found" }, 404);

  const readCache = async () => {
    const [{ data: state }, { data: rawRows, error }] = await Promise.all([
      ops.from("meta_creative_refresh_state").select("*").eq("client_id", clientId).eq("period_days", periodDays).maybeSingle(),
      ops.from("meta_creative_snapshots").select("*").eq("client_id", clientId).eq("period_days", periodDays).order("results", { ascending: false }).order("spend", { ascending: false }).limit(MAX_ADS_PER_CLIENT),
    ]);
    if (error) throw error;
    const baseRows = rawRows || [];
    const previewCandidates = baseRows.filter((row: Row) => Boolean(row.thumbnail_url || row.image_url)).length;
    const storedPreviews = baseRows.filter((row: Row) => Boolean(row.metadata?.preview_storage_path)).length;
    const needsPreviewRepair = previewCandidates > storedPreviews;
    const creatives = await withSignedPreviews(db, baseRows);
    return {
      profile,
      client,
      period_days: periodDays,
      state: state || null,
      stale: !isFresh(state?.finished_at) || needsPreviewRepair,
      needs_preview_repair: needsPreviewRepair,
      preview_storage: { stored: storedPreviews, candidates: previewCandidates, bucket: PREVIEW_BUCKET },
      creatives,
      generated_at: new Date().toISOString(),
    };
  };

  if (req.method === "GET") {
    try {
      return respond(await readCache());
    } catch (error) {
      return respond({ error: "creative_cache_failed", detail: String(error) }, 500);
    }
  }

  const { data: currentState } = await ops.from("meta_creative_refresh_state").select("status,started_at,finished_at").eq("client_id", clientId).eq("period_days", periodDays).maybeSingle();
  const runningRecently = currentState?.status === "RUNNING" && Date.now() - new Date(currentState.started_at || 0).getTime() < 5 * 60_000;
  if (runningRecently) return respond({ ...(await readCache()), in_progress: true }, 202);
  if (!force && isFresh(currentState?.finished_at)) return respond({ ...(await readCache()), cached: true });

  const token = Deno.env.get("META_SYSTEM_USER_TOKEN");
  if (!token) return respond({ error: "meta_token_missing" }, 500);

  const captureId = crypto.randomUUID();
  await ops.from("meta_creative_refresh_state").upsert({
    client_id: clientId,
    period_days: periodDays,
    status: "RUNNING",
    ad_count: 0,
    capture_id: captureId,
    last_error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    metadata: { graph_api_version: GRAPH_API_VERSION, requested_by: person, preview_bucket: PREVIEW_BUCKET },
    updated_at: new Date().toISOString(),
  }, { onConflict: "client_id,period_days" });

  try {
    const { data: integrations, error: integrationError } = await ops.from("client_integrations").select("meta_ad_account_id").eq("client_id", clientId).eq("system", "META_BM").not("meta_ad_account_id", "is", null);
    if (integrationError) throw integrationError;
    const accountIds = [...new Set((integrations || []).map((row: Row) => String(row.meta_ad_account_id)).filter(Boolean))];
    if (!accountIds.length) {
      await ops.from("meta_creative_refresh_state").upsert({ client_id: clientId, period_days: periodDays, status: "NO_META_ACCOUNT", ad_count: 0, capture_id: captureId, finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: { graph_api_version: GRAPH_API_VERSION, requested_by: person, preview_bucket: PREVIEW_BUCKET } }, { onConflict: "client_id,period_days" });
      return respond({ ...(await readCache()), refreshed: true });
    }

    const dateTo = shift(localDate(), -1);
    const dateFrom = shift(dateTo, -(periodDays - 1));
    const insightGroups = await Promise.all(accountIds.map((accountId) => adInsights(accountId, token, dateFrom, dateTo)));
    const insights = insightGroups.flat().map((insight) => {
      const metric = canonical(insight.ad_name || null, insight.actions);
      return { insight, metric, spend: number(insight.spend) };
    }).filter(({ insight, metric, spend }) => spend > 0 || number(insight.impressions) > 0 || metric.results > 0).sort((a, b) => b.spend - a.spend).slice(0, MAX_ADS_PER_CLIENT);

    const adFields = "id,name,status,effective_status,creative{id,name}";
    const adPaths = insights.map(({ insight }) => `${insight.ad_id}?fields=${encodeURIComponent(adFields)}`);
    const adBatch = await batchGet(adPaths, token);
    const adById = new Map<string, Row>();
    adPaths.forEach((path, index) => {
      const adId = String(insights[index].insight.ad_id || "");
      const value = adBatch.get(path);
      if (value) adById.set(adId, value);
    });

    const creativeIds = [...new Set([...adById.values()].map((ad) => String(ad.creative?.id || "")).filter(Boolean))];
    const creativeFields = "id,name,thumbnail_url,image_url,effective_object_story_id";
    const creativePaths = creativeIds.map((creativeId) => `${creativeId}?thumbnail_width=600&thumbnail_height=600&fields=${encodeURIComponent(creativeFields)}`);
    const creativeBatch = await batchGet(creativePaths, token);
    const creativeById = new Map<string, Row>();
    creativePaths.forEach((path, index) => {
      const value = creativeBatch.get(path);
      if (value) creativeById.set(creativeIds[index], value);
    });

    const capturedAt = new Date().toISOString();
    const rowInputs = insights.map(({ insight, metric, spend }) => {
      const impressions = number(insight.impressions);
      const clicks = number(insight.clicks);
      const reach = number(insight.reach);
      const ad = adById.get(String(insight.ad_id || "")) || {};
      const creativeId = String(ad.creative?.id || "");
      const creative = creativeById.get(creativeId) || ad.creative || {};
      return { insight, metric, spend, impressions, clicks, reach, ad, creativeId, creative };
    }).filter(({ insight }) => Boolean(insight.ad_id));

    const rows = await mapConcurrent(rowInputs, async ({ insight, metric, spend, impressions, clicks, reach, ad, creativeId, creative }) => {
      const adId = String(insight.ad_id || "");
      const preview = await mirrorPreview(db, clientId, adId, [creative.thumbnail_url, creative.image_url]);
      return {
        capture_id: captureId,
        client_id: clientId,
        client_name: client.display_name,
        gt_owner: client.gt_owner,
        period_days: periodDays,
        date_from: dateFrom,
        date_to: dateTo,
        meta_ad_account_id: String(insight.account_id || ""),
        ad_id: adId,
        ad_name: insight.ad_name || ad.name || null,
        ad_status: ad.effective_status || ad.status || null,
        adset_id: insight.adset_id || null,
        adset_name: insight.adset_name || null,
        campaign_id: insight.campaign_id || null,
        campaign_name: insight.campaign_name || null,
        creative_id: creativeId || null,
        creative_name: creative.name || ad.creative?.name || null,
        thumbnail_url: creative.thumbnail_url || null,
        image_url: creative.image_url || null,
        effective_object_story_id: creative.effective_object_story_id || null,
        spend,
        impressions: Math.round(impressions),
        reach: Math.round(reach),
        clicks: Math.round(clicks),
        ctr: impressions > 0 ? clicks / impressions * 100 : null,
        cpc: divide(spend, clicks),
        cpm: impressions > 0 ? spend / impressions * 1000 : null,
        frequency: number(insight.frequency) || divide(impressions, reach),
        leads: metric.leads,
        results: metric.results,
        cpl: divide(spend, metric.leads),
        cost_per_result: divide(spend, metric.results),
        result_type: metric.resultType,
        result_source: metric.resultSource,
        data_status: "OK",
        metadata: {
          graph_api_version: GRAPH_API_VERSION,
          source: "META_MARKETING_API_AD_LEVEL",
          preview_storage_path: preview?.path || null,
          preview_mirror_status: preview ? "STORED" : (creative.thumbnail_url || creative.image_url ? "FAILED" : "UNAVAILABLE"),
          preview_bytes: preview?.bytes || null,
          preview_content_type: preview?.content_type || null,
        },
        captured_at: capturedAt,
      };
    });

    if (rows.length) {
      const { error: upsertError } = await ops.from("meta_creative_snapshots").upsert(rows, { onConflict: "client_id,period_days,meta_ad_account_id,ad_id" });
      if (upsertError) throw upsertError;
    }
    await ops.from("meta_creative_snapshots").delete().eq("client_id", clientId).eq("period_days", periodDays).neq("capture_id", captureId);

    const storedPreviewCount = rows.filter((row: Row) => Boolean(row.metadata?.preview_storage_path)).length;
    await ops.from("meta_creative_refresh_state").upsert({
      client_id: clientId,
      period_days: periodDays,
      status: rows.length ? "OK" : "NO_DELIVERY",
      ad_count: rows.length,
      capture_id: captureId,
      last_error: null,
      started_at: currentState?.started_at || capturedAt,
      finished_at: capturedAt,
      metadata: { graph_api_version: GRAPH_API_VERSION, requested_by: person, date_from: dateFrom, date_to: dateTo, account_count: accountIds.length, preview_bucket: PREVIEW_BUCKET, preview_stored_count: storedPreviewCount, preview_candidate_count: rows.filter((row: Row) => Boolean(row.thumbnail_url || row.image_url)).length },
      updated_at: capturedAt,
    }, { onConflict: "client_id,period_days" });

    return respond({ ...(await readCache()), refreshed: true });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 900);
    await ops.from("meta_creative_refresh_state").upsert({ client_id: clientId, period_days: periodDays, status: "ERROR", capture_id: captureId, last_error: message, finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: { graph_api_version: GRAPH_API_VERSION, requested_by: person, preview_bucket: PREVIEW_BUCKET } }, { onConflict: "client_id,period_days" });
    return respond({ error: "creative_refresh_failed", detail: message }, 502);
  }
});
