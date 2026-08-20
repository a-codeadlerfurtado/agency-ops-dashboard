import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH_API_VERSION = "v21.0";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Action = { action_type: string; value: string };
type InsightRow = {
  campaign_id: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  actions?: Action[];
  cost_per_action_type?: Action[];
};
type Integration = { client_id: string; external_id: string | null; meta_ad_account_id: string | null };

function toNum(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function exact(actions: Action[] | undefined, type: string) {
  const row = (actions ?? []).find((a) => a.action_type.toLowerCase() === type.toLowerCase());
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? { value, source: row.action_type } : null;
}
function contains(actions: Action[] | undefined, needle: string) {
  let best: { value: number; source: string } | null = null;
  for (const row of (actions ?? []).filter((a) => a.action_type.toLowerCase().includes(needle.toLowerCase()))) {
    const value = Number(row.value);
    if (Number.isFinite(value) && (!best || value > best.value)) best = { value, source: row.action_type };
  }
  return best;
}
function canonicalMetrics(name: string | null, actions: Action[] | undefined) {
  const lead = exact(actions, "lead") ?? exact(actions, "onsite_conversion.lead_grouped") ?? exact(actions, "offsite_complete_registration_add_meta_leads");
  const message = contains(actions, "messaging_conversation_started") ?? contains(actions, "total_messaging_connection");
  const messagingByName = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test((name ?? "").toLowerCase());
  const useMessage = messagingByName || (!lead && !!message);
  const result = useMessage ? message : lead;
  return {
    leads: lead?.value ?? 0,
    result_count: result?.value ?? 0,
    result_type: result ? (useMessage ? "MENSAGEM" : "LEAD") : null,
    result_source: result?.source ?? null,
  };
}
function validDate(v: string | null) {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1;
}
async function fetchInsights(accountId: string, token: string, since: string, until: string) {
  const fields = ["campaign_id","campaign_name","date_start","date_stop","spend","impressions","clicks","ctr","cpc","cpm","reach","frequency","actions","cost_per_action_type"].join(",");
  const rows: InsightRow[] = [];
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  let url: string | null = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights?level=campaign&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`;
  while (url) {
    const response: Response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    for (const row of body.data ?? []) rows.push(row as InsightRow);
    url = body.paging?.next ?? null;
  }
  return rows;
}
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const metaToken = Deno.env.get("META_SYSTEM_USER_TOKEN");
  if (!supabaseUrl || !serviceRole || !anonKey || !metaToken) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData } = await authClient.auth.getUser();
  if (!userData?.user) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  let role: string | null = null;
  let accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops.from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
    role = roster?.role ?? null;
    accessLevel = roster?.access_level ?? "RESTRICTED";
  }
  const { data: approvals } = await ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED");
  const accountApproved = (approvals ?? []).some((r: any) => r.kind === "SIGNUP");
  const elevated = accessLevel === "RESTRICTED" && (approvals ?? []).some((r: any) => r.kind === "ELEVATION");
  const isFull = accessLevel === "FULL" || elevated;
  const isWalletOnly = accessLevel === "WALLET_ONLY" && !elevated;
  if (!accountApproved || (!person && !elevated)) return reply({ error: "forbidden" }, 403);

  const url = new URL(req.url);
  const lifecycle = (url.searchParams.get("lifecycle") ?? "ACTIVE").toUpperCase();
  const includeDetails = url.searchParams.get("details") !== "0";
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const periodLabel = url.searchParams.get("period_label") ?? null;
  if (!validDate(since) || !validDate(until)) return reply({ error: "invalid_period", detail: "Informe since e until em YYYY-MM-DD" }, 400);
  if (since! > until!) return reply({ error: "invalid_period", detail: "A data inicial não pode ser maior que a final" }, 400);
  const dayCount = daysBetween(since!, until!);
  if (dayCount > 366) return reply({ error: "period_too_large", detail: "O intervalo máximo por consulta é de 366 dias" }, 400);

  let q = ops.from("campaign_client_latest").select("*");
  if (lifecycle === "ACTIVE") q = q.in("lifecycle", ["ACTIVE", "ONBOARDING"]);
  else if (lifecycle !== "ALL") q = q.eq("lifecycle", lifecycle);
  if (isWalletOnly && person) q = q.eq("gt_owner", person);
  const { data: baseClients, error: baseError } = await q.order("display_name");
  if (baseError) return reply({ error: "query_failed", detail: baseError.message }, 500);
  const base = baseClients ?? [];
  const ids = base.map((r: any) => r.client_id);

  if (!ids.length) return reply({
    clients: [], campaigns: [],
    summary: { lifecycle_filter: lifecycle, clients_total: 0, since, until, day_count: dayCount, source: "META_MARKETING_API", graph_api_version: GRAPH_API_VERSION, fetched_at: new Date().toISOString() },
    profile: { person, role, access_level: accessLevel, elevated, scope: isFull ? "FULL" : isWalletOnly ? "WALLET" : "RESTRICTED" },
  });

  const { data: integrationsData, error: integrationError } = await ops.from("client_integrations")
    .select("client_id,external_id,meta_ad_account_id")
    .eq("system", "META_BM")
    .not("meta_ad_account_id", "is", null)
    .in("client_id", ids);
  if (integrationError) return reply({ error: "query_failed", detail: integrationError.message }, 500);
  const integrations = (integrationsData ?? []) as Integration[];

  const accountResults = await inBatches(integrations, 10, async (integration) => {
    try {
      const rows = await fetchInsights(integration.meta_ad_account_id!, metaToken, since!, until!);
      return { ok: true, integration, rows, error: null };
    } catch (e) {
      return { ok: false, integration, rows: [] as InsightRow[], error: String(e instanceof Error ? e.message : e).slice(0, 220) };
    }
  });

  const byClient = new Map<string, any>();
  for (const row of base) byClient.set(row.client_id, { ...row, spend: 0, impressions: 0, clicks: 0, results: 0, leads: 0, account_errors: 0, queried_accounts: 0 });
  const insightByCampaign = new Map<string, any>();

  for (const result of accountResults) {
    const client = byClient.get(result.integration.client_id);
    if (!client) continue;
    client.queried_accounts += 1;
    if (!result.ok) {
      client.account_errors += 1;
      continue;
    }
    for (const insight of result.rows) {
      const spend = toNum(insight.spend), impressions = toNum(insight.impressions), clicks = toNum(insight.clicks);
      const canonical = canonicalMetrics(insight.campaign_name ?? null, insight.actions);
      const resultCount = canonical.result_count;
      client.spend += spend;
      client.impressions += impressions;
      client.clicks += clicks;
      client.results += resultCount;
      client.leads += canonical.leads;
      const key = `${result.integration.client_id}:${insight.campaign_id}`;
      insightByCampaign.set(key, {
        client_id: result.integration.client_id,
        account_key: result.integration.external_id,
        meta_ad_account_id: result.integration.meta_ad_account_id,
        campaign_id: insight.campaign_id,
        campaign_name: insight.campaign_name ?? null,
        date_start: insight.date_start ?? since,
        date_stop: insight.date_stop ?? until,
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions * 100 : null,
        cpc: clicks > 0 ? spend / clicks : null,
        cpm: impressions > 0 ? spend / impressions * 1000 : null,
        reach: toNum(insight.reach),
        frequency: toNum(insight.frequency) || null,
        leads_estimate: canonical.leads,
        cost_per_lead_estimate: canonical.leads > 0 ? spend / canonical.leads : null,
        result_type: canonical.result_type,
        result_count: resultCount,
        cost_per_result: resultCount > 0 ? spend / resultCount : null,
        result_source: canonical.result_source,
        has_delivery: impressions > 0 || spend > 0,
      });
    }
  }

  const fetchedAt = new Date().toISOString();
  const clients = [...byClient.values()].map((client: any) => {
    const spend = Number(client.spend.toFixed(2));
    const impressions = Number(client.impressions);
    const clicks = Number(client.clicks);
    const results = Number(client.results);
    const leads = Number(client.leads);
    let deliveryStatus = "ACTIVE_DELIVERY";
    if (Number(client.configured_accounts ?? 0) === 0) deliveryStatus = "NO_META_ACCOUNT";
    else if (Number(client.campaign_count ?? 0) === 0) deliveryStatus = "NO_CAMPAIGNS";
    else if (client.lifecycle === "CHURNED" && Number(client.active_campaigns ?? 0) > 0 && (spend > 0 || impressions > 0)) deliveryStatus = "CHURNED_WITH_DELIVERY";
    else if (Number(client.active_campaigns ?? 0) === 0) deliveryStatus = "NO_ACTIVE_CAMPAIGN";
    else if (spend === 0 && impressions === 0) deliveryStatus = "NO_DELIVERY";
    return {
      ...client,
      spend, impressions, clicks, results, leads,
      ctr: impressions > 0 ? Number((clicks / impressions * 100).toFixed(4)) : null,
      cpc: clicks > 0 ? Number((spend / clicks).toFixed(4)) : null,
      cpm: impressions > 0 ? Number((spend / impressions * 1000).toFixed(4)) : null,
      cost_per_result: results > 0 ? Number((spend / results).toFixed(4)) : null,
      delivery_status: deliveryStatus,
      latest_date: until,
      checked_at: Number(client.configured_accounts ?? 0) > 0 ? fetchedAt : null,
      period_since: since,
      period_until: until,
      partial_data: Number(client.account_errors ?? 0) > 0,
    };
  });

  let campaigns: any[] = [];
  if (includeDetails) {
    const { data: inventoryData, error: inventoryError } = await ops.from("meta_campaign_inventory")
      .select("client_id,account_key,meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,checked_at")
      .in("client_id", ids);
    if (inventoryError) return reply({ error: "query_failed", detail: inventoryError.message }, 500);
    const used = new Set<string>();
    campaigns = (inventoryData ?? []).map((inv: any) => {
      const key = `${inv.client_id}:${inv.campaign_id}`;
      const insight = insightByCampaign.get(key);
      used.add(key);
      return insight ? { ...inv, ...insight } : {
        ...inv,
        date_start: since, date_stop: until, spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null,
        reach: 0, frequency: null, leads_estimate: 0, cost_per_lead_estimate: null,
        result_type: null, result_count: 0, cost_per_result: null, result_source: null, has_delivery: false,
      };
    });
    for (const [key, insight] of insightByCampaign) if (!used.has(key)) campaigns.push({ ...insight, campaign_status: null, objective: null, checked_at: fetchedAt });
    campaigns.sort((a: any, b: any) => Number(b.has_delivery) - Number(a.has_delivery) || Number(b.spend) - Number(a.spend) || String(a.campaign_name ?? "").localeCompare(String(b.campaign_name ?? ""), "pt-BR"));
  }

  const sum = (key: string) => clients.reduce((acc: number, row: any) => acc + Number(row[key] ?? 0), 0);
  const byStatus = clients.reduce((acc: Record<string, number>, row: any) => {
    const key = String(row.delivery_status ?? "UNKNOWN"); acc[key] = (acc[key] ?? 0) + 1; return acc;
  }, {});
  const spend = sum("spend"), results = sum("results"), impressions = sum("impressions"), clicks = sum("clicks");
  const failedAccounts = accountResults.filter((r) => !r.ok);

  return reply({
    clients,
    campaigns,
    summary: {
      lifecycle_filter: lifecycle,
      clients_total: clients.length,
      active_delivery: byStatus.ACTIVE_DELIVERY ?? 0,
      no_meta_account: byStatus.NO_META_ACCOUNT ?? 0,
      no_delivery: byStatus.NO_DELIVERY ?? 0,
      no_active_campaign: byStatus.NO_ACTIVE_CAMPAIGN ?? 0,
      no_campaigns: byStatus.NO_CAMPAIGNS ?? 0,
      churned_with_delivery: byStatus.CHURNED_WITH_DELIVERY ?? 0,
      spend: Number(spend.toFixed(2)), results, leads: sum("leads"), impressions, clicks,
      ctr: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null,
      cost_per_result: results ? Number((spend / results).toFixed(2)) : null,
      since, until, day_count: dayCount, period_label: periodLabel,
      reference_date: until,
      source: "META_MARKETING_API",
      source_mode: "LIVE_RANGE_QUERY",
      graph_api_version: GRAPH_API_VERSION,
      level: "campaign",
      fetched_at: fetchedAt,
      checked_at: fetchedAt,
      accounts_queried: integrations.length,
      accounts_succeeded: accountResults.filter((r) => r.ok).length,
      accounts_failed: failedAccounts.length,
      partial: failedAccounts.length > 0,
      failures: failedAccounts.slice(0, 8).map((r) => ({ client_id: r.integration.client_id, account_key: r.integration.external_id, error: r.error })),
    },
    profile: { person, role, access_level: accessLevel, elevated, scope: isFull ? "FULL" : isWalletOnly ? "WALLET" : "RESTRICTED" },
    generated_at: fetchedAt,
  });
});
