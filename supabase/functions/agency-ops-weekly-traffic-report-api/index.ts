import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH_API_VERSION = "v21.0";
const TZ = "America/Sao_Paulo";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-cron-secret",
  "access-control-allow-methods": "GET,POST,OPTIONS",
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
type Profile = { person: string; role: string; access_level: string };

function num(v: unknown) {
  const value = Number(v ?? 0);
  return Number.isFinite(value) ? value : 0;
}
function exact(actions: Action[] | undefined, type: string) {
  const row = (actions ?? []).find((item) => item.action_type.toLowerCase() === type.toLowerCase());
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? { value, source: row.action_type } : null;
}
function contains(actions: Action[] | undefined, needle: string) {
  let best: { value: number; source: string } | null = null;
  for (const row of (actions ?? []).filter((item) => item.action_type.toLowerCase().includes(needle.toLowerCase()))) {
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
function ymdParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}
function iso(date: Date) { return date.toISOString().slice(0, 10); }
function shift(day: string, delta: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return iso(date);
}
function latestCompletedSunday(now = new Date()) {
  const p = ymdParts(now);
  const local = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = local.getUTCDay();
  const daysBack = dow === 0 ? 7 : dow;
  return iso(new Date(local.getTime() - daysBack * 86_400_000));
}
function validDate(value: string | null) { return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function ddmm(day: string) {
  const [, month, date] = day.split("-");
  return `${date}/${month}`;
}
function brNumber(value: number) { return Math.round(value).toLocaleString("pt-BR"); }
function brMoney(value: number) { return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function currentStatusLabel(status: unknown) {
  const value = String(status || "").toUpperCase();
  if (value === "ACTIVE") return "ativa";
  if (value === "PAUSED") return "pausada";
  if (value === "ARCHIVED") return "arquivada";
  return value ? value.toLowerCase() : "sem status confirmado";
}
function reportCode(metadata: any) {
  const candidates = [metadata?.weekly_report_code, metadata?.client_code, metadata?.account_code];
  for (const value of candidates) {
    const text = String(value || "").trim().toUpperCase();
    if (text && text.length <= 20) return text;
  }
  return null;
}
function objectiveLabel(row: any) {
  if (row.result_type === "MENSAGEM") return "GERAÇÃO DE CONVERSAS";
  if (row.result_type === "LEAD") return "GERAÇÃO DE LEADS";
  const objective = String(row.objective || "").toUpperCase();
  if (objective.includes("LEAD")) return "GERAÇÃO DE LEADS";
  if (objective.includes("MESSAGE") || objective.includes("ENGAGEMENT")) return "GERAÇÃO DE CONVERSAS";
  return objective ? objective.replace(/^OUTCOME_/, "").replaceAll("_", " ") : "META ADS";
}
function campaignAnalysis(row: any, accountAvgCpa: number | null) {
  const results = num(row.result_count);
  const spend = num(row.spend);
  const impressions = num(row.impressions);
  const cpa = results > 0 ? spend / results : null;
  const active = String(row.campaign_status || "").toUpperCase() === "ACTIVE";
  const noun = row.result_type === "MENSAGEM" ? "conversas" : "leads";

  if (results > 0 && cpa != null && accountAvgCpa != null && cpa <= accountAvgCpa * 0.8 && results >= 8) {
    return `A campanha foi um dos destaques da conta, gerando ${brNumber(results)} ${noun} com custo bastante competitivo. Os dados mostram boa eficiência na captação e bom aproveitamento do orçamento no período.`;
  }
  if (results > 0 && cpa != null && accountAvgCpa != null && cpa <= accountAvgCpa) {
    return `A campanha apresentou bom desempenho, gerando ${brNumber(results)} ${noun} com custo dentro de um patamar saudável para a conta. Seguimos acompanhando para sustentar a eficiência e ampliar o volume.`;
  }
  if (results > 0 && cpa != null && accountAvgCpa != null && cpa > accountAvgCpa * 1.25) {
    return `A campanha gerou ${brNumber(results)} ${noun}, porém com custo acima da média observada na conta nesta semana. Seguimos com otimizações para buscar mais eficiência sem perder volume de entrega.`;
  }
  if (results > 0) {
    return `A campanha manteve entrega consistente e gerou ${brNumber(results)} ${noun} no período. Seguimos monitorando os indicadores e realizando otimizações para ampliar o volume mantendo a eficiência da captação.`;
  }
  if (!active && (spend > 0 || impressions > 0)) {
    return `A campanha teve entrega limitada e não registrou conversões no período. A estrutura está ${currentStatusLabel(row.campaign_status)}, o que interrompe novos gastos enquanto permanece nesse status.`;
  }
  if (active && spend > 0) {
    return "A campanha teve entrega no período, mas ainda não registrou conversões. Seguimos acompanhando a distribuição e realizando ajustes para buscar geração de resultados.";
  }
  return "A campanha não registrou conversões no período e apresentou volume reduzido de entrega. Seguimos acompanhando a estrutura para validar a necessidade de novos ajustes.";
}
function buildMessage(client: any, weekStart: string, weekEnd: string, campaigns: any[]) {
  const code = reportCode(client.metadata);
  const header = code ? `${code} — ${client.display_name}` : client.display_name;
  const totalSpend = campaigns.reduce((sum, row) => sum + num(row.spend), 0);
  const totalResults = campaigns.reduce((sum, row) => sum + num(row.result_count), 0);
  const accountAvgCpa = totalResults > 0 ? totalSpend / totalResults : null;
  const blocks = campaigns.map((row) => {
    const cpa = num(row.result_count) > 0 ? num(row.spend) / num(row.result_count) : null;
    const cpaLine = cpa == null ? "Não calculado — sem conversões" : brMoney(cpa);
    return [
      `${row.campaign_name} – ${objectiveLabel(row)}`,
      `📈 Leads/Conversas: ${brNumber(num(row.result_count))}`,
      `Valor usado: ${brMoney(num(row.spend))}`,
      `💰 CPA: ${cpaLine}`,
      `Impressões: ${brNumber(num(row.impressions))}`,
      `Alcance: ${brNumber(num(row.reach))}`,
      "",
      `➡️ ${campaignAnalysis(row, accountAvgCpa)}`,
    ].join("\n");
  });

  const body = blocks.length
    ? blocks.join("\n\n")
    : "Não houve entrega registrada nas campanhas Meta Ads durante o período.";
  return [
    "Bom dia, time! Ótima semana 🚀",
    "",
    header,
    "",
    `Segue relatório de tráfego do dia ${ddmm(weekStart)} a ${ddmm(weekEnd)}:`,
    "",
    body,
  ].join("\n");
}

async function fetchInsights(accountId: string, token: string, since: string, until: string) {
  const fields = ["campaign_id","campaign_name","date_start","date_stop","spend","impressions","clicks","ctr","cpc","cpm","reach","frequency","actions","cost_per_action_type"].join(",");
  const rows: InsightRow[] = [];
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  let url: string | null = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights?level=campaign&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`;
  while (url) {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    for (const row of body.data ?? []) rows.push(row as InsightRow);
    url = body.paging?.next ?? null;
  }
  return rows;
}
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const output: R[] = [];
  for (let i = 0; i < items.length; i += size) output.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return output;
}

async function resolveProfile(req: Request, supabaseUrl: string, anonKey: string, db: any): Promise<Profile | null> {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data } = await auth.auth.getUser();
  if (!data?.user) return null;
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", data.user.id).maybeSingle();
  const person = String(pref?.collaborator_person || "");
  if (!person) return null;
  const { data: roster } = await ops.from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return null;
  const { data: approvals } = await ops.from("access_requests").select("kind,status").eq("user_key", data.user.id).eq("status", "APPROVED");
  if (!(approvals ?? []).some((row: any) => row.kind === "SIGNUP")) return null;
  return { person, role: String(roster.role || ""), access_level: String(roster.access_level || "RESTRICTED") };
}
function canUse(profile: Profile) { return profile.role === "GT" || profile.role === "MGMT"; }

async function generateReports(db: any, metaToken: string, weekEnd: string, scopePerson: string | null, onlyClientId: string | null = null) {
  const ops = db.schema("agency_ops");
  const weekStart = shift(weekEnd, -6);
  let clientQuery = ops.from("clients").select("id,display_name,gt_owner,metadata,lifecycle").eq("lifecycle", "ACTIVE");
  if (scopePerson) clientQuery = clientQuery.eq("gt_owner", scopePerson);
  if (onlyClientId) clientQuery = clientQuery.eq("id", onlyClientId);
  const { data: clients, error: clientError } = await clientQuery.order("display_name");
  if (clientError) throw new Error(clientError.message);
  const clientRows = clients ?? [];
  const ids = clientRows.map((row: any) => row.id);
  if (!ids.length) return [];

  const [{ data: integrations, error: integrationError }, { data: inventory, error: inventoryError }] = await Promise.all([
    ops.from("client_integrations").select("client_id,meta_ad_account_id,external_name,is_primary").in("client_id", ids).eq("system", "META_BM").not("meta_ad_account_id", "is", null),
    ops.from("meta_campaign_inventory").select("client_id,meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,checked_at").in("client_id", ids),
  ]);
  if (integrationError) throw new Error(integrationError.message);
  if (inventoryError) throw new Error(inventoryError.message);

  const inventoryMap = new Map<string, any>();
  for (const row of inventory ?? []) inventoryMap.set(`${row.client_id}:${row.campaign_id}`, row);
  const accountRows = (integrations ?? []).map((row: any) => ({ ...row, meta_ad_account_id: String(row.meta_ad_account_id) }));
  const accountResults = await inBatches(accountRows, 8, async (integration: any) => {
    try {
      const rows = await fetchInsights(integration.meta_ad_account_id, metaToken, weekStart, weekEnd);
      return { ok: true, integration, rows, error: null };
    } catch (error) {
      return { ok: false, integration, rows: [] as InsightRow[], error: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
  });

  const byClient = new Map<string, any[]>();
  const errorsByClient = new Map<string, string[]>();
  for (const result of accountResults) {
    const clientId = String(result.integration.client_id);
    if (!result.ok) {
      errorsByClient.set(clientId, [...(errorsByClient.get(clientId) ?? []), String(result.error)]);
      continue;
    }
    for (const insight of result.rows) {
      const canonical = canonicalMetrics(insight.campaign_name ?? null, insight.actions);
      const inventoryRow = inventoryMap.get(`${clientId}:${insight.campaign_id}`) || {};
      const campaign = {
        client_id: clientId,
        campaign_id: insight.campaign_id,
        campaign_name: insight.campaign_name ?? inventoryRow.campaign_name ?? insight.campaign_id,
        campaign_status: inventoryRow.campaign_status ?? null,
        objective: inventoryRow.objective ?? null,
        spend: num(insight.spend),
        impressions: num(insight.impressions),
        clicks: num(insight.clicks),
        ctr: num(insight.ctr),
        cpc: num(insight.cpc),
        cpm: num(insight.cpm),
        reach: num(insight.reach),
        frequency: num(insight.frequency),
        leads: canonical.leads,
        result_count: canonical.result_count,
        result_type: canonical.result_type,
        result_source: canonical.result_source,
        cost_per_result: canonical.result_count > 0 ? num(insight.spend) / canonical.result_count : null,
      };
      if (campaign.spend > 0 || campaign.impressions > 0 || campaign.result_count > 0) {
        byClient.set(clientId, [...(byClient.get(clientId) ?? []), campaign]);
      }
    }
  }

  const now = new Date().toISOString();
  const output: any[] = [];
  for (const client of clientRows) {
    const clientId = String(client.id);
    const clientIntegrations = accountRows.filter((row: any) => String(row.client_id) === clientId);
    const campaigns = (byClient.get(clientId) ?? []).sort((a, b) => num(b.result_count) - num(a.result_count) || num(b.spend) - num(a.spend) || String(a.campaign_name).localeCompare(String(b.campaign_name), "pt-BR"));
    const errors = errorsByClient.get(clientId) ?? [];
    const summary = {
      spend: Number(campaigns.reduce((sum, row) => sum + num(row.spend), 0).toFixed(2)),
      results: campaigns.reduce((sum, row) => sum + num(row.result_count), 0),
      leads: campaigns.reduce((sum, row) => sum + num(row.leads), 0),
      impressions: campaigns.reduce((sum, row) => sum + num(row.impressions), 0),
      reach_sum: campaigns.reduce((sum, row) => sum + num(row.reach), 0),
      clicks: campaigns.reduce((sum, row) => sum + num(row.clicks), 0),
      campaigns_with_delivery: campaigns.length,
      queried_accounts: clientIntegrations.length,
      account_errors: errors,
      graph_api_version: GRAPH_API_VERSION,
      source: "META_MARKETING_API_LIVE_WEEKLY",
    };
    let dataStatus = "READY";
    if (!clientIntegrations.length) dataStatus = "NO_META_ACCOUNT";
    else if (!campaigns.length && errors.length >= clientIntegrations.length) dataStatus = "ERROR";
    else if (errors.length) dataStatus = "PARTIAL";
    else if (!campaigns.length) dataStatus = "NO_ACTIVITY";

    const payload = {
      client_id: clientId,
      week_start: weekStart,
      week_end: weekEnd,
      client_name: client.display_name,
      client_code: reportCode(client.metadata),
      gt_owner: client.gt_owner,
      report_text: buildMessage(client, weekStart, weekEnd, campaigns),
      campaigns,
      summary,
      data_status: dataStatus,
      review_status: "READY",
      reviewed_by: null,
      reviewed_at: null,
      sent_by: null,
      sent_at: null,
      generated_at: now,
      updated_at: now,
    };
    const { data: saved, error: saveError } = await ops.from("weekly_traffic_reports").upsert(payload, { onConflict: "client_id,week_end" }).select("*").single();
    if (saveError) throw new Error(saveError.message);
    output.push(saved);
  }
  return output;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const metaToken = Deno.env.get("META_SYSTEM_USER_TOKEN");
  const cronSecret = Deno.env.get("META_CAMPAIGN_SYNC_SECRET");
  if (!supabaseUrl || !serviceRole || !anonKey || !metaToken) return reply({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  if (req.method === "POST" && cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "generate_all") return reply({ error: "invalid_cron_action" }, 400);
    const weekEnd = validDate(body?.week_end) ? String(body.week_end) : latestCompletedSunday();
    const reports = await generateReports(db, metaToken, weekEnd, null);
    return reply({ ok: true, mode: "CRON", week_end: weekEnd, generated: reports.length, generated_at: new Date().toISOString() });
  }

  const profile = await resolveProfile(req, supabaseUrl, anonKey, db);
  if (!profile) return reply({ error: "unauthorized" }, 401);
  if (!canUse(profile)) return reply({ error: "forbidden" }, 403);
  const isGt = profile.role === "GT";

  if (req.method === "GET") {
    const url = new URL(req.url);
    const requestedWeek = url.searchParams.get("week_end");
    const weekEnd = validDate(requestedWeek) ? requestedWeek! : latestCompletedSunday();
    let query = ops.from("weekly_traffic_reports").select("*").eq("week_end", weekEnd).order("client_name");
    if (isGt) query = query.eq("gt_owner", profile.person);
    let { data: reports, error } = await query;
    if (error) return reply({ error: "query_failed", detail: error.message }, 500);
    if (!(reports ?? []).length) {
      await generateReports(db, metaToken, weekEnd, isGt ? profile.person : null);
      let retry = ops.from("weekly_traffic_reports").select("*").eq("week_end", weekEnd).order("client_name");
      if (isGt) retry = retry.eq("gt_owner", profile.person);
      const retried = await retry;
      reports = retried.data ?? [];
      error = retried.error;
      if (error) return reply({ error: "query_failed", detail: error.message }, 500);
    }
    let historyQuery = ops.from("weekly_traffic_reports").select("week_end").order("week_end", { ascending: false }).limit(1000);
    if (isGt) historyQuery = historyQuery.eq("gt_owner", profile.person);
    const { data: history } = await historyQuery;
    const weeks = [...new Set((history ?? []).map((row: any) => String(row.week_end)))].slice(0, 16);
    return reply({
      profile,
      week: { start: shift(weekEnd, -6), end: weekEnd },
      reports: reports ?? [],
      weeks,
      generated_at: new Date().toISOString(),
      source: "META_MARKETING_API_LIVE_WEEKLY",
    });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").toLowerCase();
    if (action === "regenerate") {
      const weekEnd = validDate(body?.week_end) ? String(body.week_end) : latestCompletedSunday();
      const clientId = body?.client_id ? String(body.client_id) : null;
      if (clientId && isGt) {
        const { data: client } = await ops.from("clients").select("id,gt_owner").eq("id", clientId).maybeSingle();
        if (!client || client.gt_owner !== profile.person) return reply({ error: "forbidden_client" }, 403);
      }
      const reports = await generateReports(db, metaToken, weekEnd, isGt ? profile.person : null, clientId);
      return reply({ ok: true, action: "regenerate", week_end: weekEnd, generated: reports.length, reports });
    }
    if (action === "review" || action === "sent") {
      const reportId = String(body?.report_id || "");
      if (!reportId) return reply({ error: "report_id_required" }, 400);
      let check = ops.from("weekly_traffic_reports").select("id,gt_owner").eq("id", reportId);
      if (isGt) check = check.eq("gt_owner", profile.person);
      const { data: report } = await check.maybeSingle();
      if (!report) return reply({ error: "report_not_found" }, 404);
      const patch = action === "review"
        ? { review_status: "REVIEWED", reviewed_by: profile.person, reviewed_at: new Date().toISOString() }
        : { review_status: "SENT", sent_by: profile.person, sent_at: new Date().toISOString(), reviewed_by: profile.person, reviewed_at: new Date().toISOString() };
      const { data: updated, error: updateError } = await ops.from("weekly_traffic_reports").update(patch).eq("id", reportId).select("*").single();
      if (updateError) return reply({ error: "update_failed", detail: updateError.message }, 500);
      return reply({ ok: true, report: updated });
    }
    return reply({ error: "invalid_action" }, 400);
  }

  return reply({ error: "method_not_allowed" }, 405);
});
