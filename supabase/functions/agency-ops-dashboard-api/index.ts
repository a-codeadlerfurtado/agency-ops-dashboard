import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-dashboard-key,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const number = (value: unknown) => Number(value ?? 0);
const value = <T>(result: any, fallback: T): T => result?.error ? fallback : (result?.data ?? fallback);
const aggregateMedia = (rows: any[]) => {
  const daily = rows.filter((row) => (row.granularity ?? "day") === "day");
  const dates = daily.map((row) => row.date).filter(Boolean).sort();
  const latestDate = dates.at(-1) ?? null;
  const latest = latestDate ? daily.filter((row) => row.date === latestDate) : [];
  const spend = latest.reduce((sum, row) => sum + number(row.spend), 0);
  const leads = latest.reduce((sum, row) => sum + number(row.leads), 0);
  const clicks = latest.reduce((sum, row) => sum + number(row.clicks), 0);
  const impressions = latest.reduce((sum, row) => sum + number(row.impressions), 0);
  const ageDays = latestDate ? Math.max(0, Math.floor((Date.now() - new Date(`${latestDate}T23:59:59Z`).getTime()) / 86400000)) : null;
  return { latest_date: latestDate, age_days: ageDays, is_stale: ageDays === null || ageDays > 2, accounts: new Set(latest.map((row) => row.account_key).filter(Boolean)).size, clients_with_media: new Set(latest.map((row) => row.client_id).filter(Boolean)).size, spend: Number(spend.toFixed(2)), leads, impressions, clicks, ctr: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null, cpc: clicks ? Number((spend / clicks).toFixed(2)) : null, cpl: leads ? Number((spend / leads).toFixed(2)) : null };
};
const aggregateTaskLog = (rows: any[]) => {
  const byCategory: Record<string, number> = {};
  const byCollaborator: Record<string, { total: number; by_category: Record<string, number> }> = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    const bucket = byCollaborator[row.collaborator_name] ?? { total: 0, by_category: {} };
    bucket.total += 1;
    bucket.by_category[row.category] = (bucket.by_category[row.category] ?? 0) + 1;
    byCollaborator[row.collaborator_name] = bucket;
  }
  return { total: rows.length, by_category: byCategory, by_collaborator: byCollaborator, recent: rows.slice(0, 100) };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!['GET','POST'].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  // ---- Autenticacao: aceita a chave fixa do dashboard (uso atual, mantido para nao
  // quebrar o front-end existente) OU um login de colaborador via Supabase Auth (novo).
  // Quando autenticado por login, currentUserKey passa a ser o id do proprio usuario,
  // e cada um ve/edita seu proprio perfil em vez do perfil fixo "adler-furtado".
  let currentUserKey = "adler-furtado";
  let authenticated = false;

  const suppliedKey = req.headers.get("x-dashboard-key") ?? "";
  if (suppliedKey.length >= 40) {
    const keyHash = await sha256(suppliedKey);
    const { data: apiKey } = await ops.from("dashboard_api_keys").select("active,expires_at").eq("key_hash", keyHash).maybeSingle();
    if (apiKey?.active && !(apiKey.expires_at && new Date(apiKey.expires_at) <= new Date())) {
      authenticated = true;
      await ops.from("dashboard_api_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", keyHash);
    }
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authenticated && authHeader.startsWith("Bearer ")) {
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await authClient.auth.getUser();
    if (userData?.user) {
      authenticated = true;
      currentUserKey = userData.user.id;
    }
  }

  if (!authenticated) return respond({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "home";

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (view === "notifications-read") {
      let query = ops.from("platform_notifications").update({ read_at: new Date().toISOString() });
      if (body.id) query = query.eq("id", String(body.id)); else query = query.is("read_at", null);
      const result = await query.select("id");
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, updated: result.data?.length ?? 0 });
    }
    if (view === "preferences") {
      const allowed = ["theme","sounds_enabled","win_sound_enabled","win_celebration_enabled","notifications_enabled","animations_enabled","interface_density","name","role"];
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      const result = await ops.from("user_preferences").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_key", currentUserKey).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, preferences: result.data });
    }
    return respond({ error: "unknown_action" }, 404);
  }

  if (view === "client") {
    const clientId = url.searchParams.get("id");
    if (!clientId) return respond({ error: "missing_client_id" }, 400);
    const core = await Promise.all([
      ops.from("dashboard_client_overview").select("*").eq("client_id", clientId).maybeSingle(),
      ops.from("conversation_state").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }),
      ops.from("operational_alerts").select("*").eq("client_id", clientId).order("last_detected_at", { ascending: false }).limit(50),
      ops.from("commitments").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(50),
    ]);
    const context = await Promise.all([
      ops.from("notion_briefing_pages").select("notion_page_id,title,page_url,sync_status,match_status,extracted_profile,last_fetched_at").eq("client_id", clientId).order("updated_at", { ascending: false }),
      ops.from("client_daily_summary").select("*").eq("client_id", clientId).order("summary_date", { ascending: false }).limit(30),
      ops.from("media_metrics_daily").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(180),
      ops.from("client_timeline").select("*").eq("client_id", clientId).order("at", { ascending: false }).limit(100),
    ]);
    const history = await Promise.all([
      ops.from("client_health_scores").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(90),
      ops.from("client_integrations").select("*").eq("client_id", clientId),
      ops.from("clickup_tasks").select("task_id,name,status,is_closed,date_created,date_closed,due_date,list_name,url,last_synced_at").eq("client_id", clientId).order("date_updated", { ascending: false }).limit(100),
      ops.from("onboarding_cases").select("*,onboarding_stages(*)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
      ops.from("client_lifecycle_events").select("*").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(100),
      ops.from("client_won_events").select("*").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(20),
    ]);
    const results = [...core, ...context, ...history];
    if (results[0].error) return respond({ error: "query_failed", detail: results[0].error.message }, 500);
    return respond({ client: results[0].data, conversations: value(results[1], []), alerts: value(results[2], []), commitments: value(results[3], []), briefings: value(results[4], []), daily_summaries: value(results[5], []), media: value(results[6], []), timeline: value(results[7], []), health_history: value(results[8], []), integrations: value(results[9], []), clickup_tasks: value(results[10], []), onboarding_cases: value(results[11], []), lifecycle_events: value(results[12], []), won_events: value(results[13], []), generated_at: new Date().toISOString() });
  }

  const core = await Promise.all([
    ops.from("dashboard_client_overview").select("*").limit(300),
    ops.from("operational_alerts").select("*").eq("status", "OPEN").limit(500),
    ops.from("commitments").select("*").in("status", ["OPEN", "IN_PROGRESS"]).limit(500),
    ops.from("conversation_state").select("*").limit(500),
  ]);
  const sources = await Promise.all([
    ops.from("notion_briefing_pages").select("notion_page_id,client_id,match_status,sync_status,updated_at").limit(500),
    ops.from("notion_briefing_sync_runs").select("*").order("started_at", { ascending: false }).limit(1),
    ops.from("job_runs").select("job_name,status,started_at,finished_at,error").order("started_at", { ascending: false }).limit(40),
    ops.from("conversation_processing_queue").select("chat_id,status,dirty_since,last_error").limit(500),
  ]);
  const operationsData = await Promise.all([
    ops.from("whatsapp_messages").select("id,event_at,received_at,chat_id").order("id", { ascending: false }).limit(1),
    ops.from("media_metrics_daily").select("*").order("date", { ascending: false }).limit(3000),
    ops.from("employee_capacity").select("*").order("date", { ascending: false }).limit(300),
    ops.from("client_health_scores").select("*").order("date", { ascending: false }).limit(1000),
  ]);
  const clickupData = await Promise.all([
    ops.from("clickup_productivity_30d").select("*").order("tasks_done", { ascending: false }),
    ops.from("clickup_productivity_daily").select("*").gte("date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)).order("date", { ascending: true }),
    ops.from("clickup_tasks").select("task_id,name,status,date_closed,due_date,list_name,client_id,url,clickup_task_assignees(user_id,username,email)", { count: "exact" }).eq("is_closed", true).order("date_closed", { ascending: false }).limit(100),
    ops.from("clickup_sync_runs").select("*").order("started_at", { ascending: false }).limit(1),
    ops.rpc("get_clickup_config"),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).not("client_id", "is", null),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("client_match_status", "UNMATCHED"),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("client_match_status", "NO_LABEL"),
    ops.from("clickup_client_label_audit").select("client_label,task_count,status").eq("status", "UNMATCHED").order("task_count", { ascending: false }).limit(30),
  ]);
  const platformData = await Promise.all([
    ops.from("platform_notifications").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("crm_preclients").select("*").order("updated_at", { ascending: false }).limit(200),
    ops.from("client_won_events").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("data_audit_runs").select("*").order("started_at", { ascending: false }).limit(2),
    ops.from("data_audit_issues").select("id,severity,category,issue_code,entity_type,entity_id,resolution_status,explanation,created_at").order("created_at", { ascending: false }).limit(100),
    ops.from("user_preferences").select("*").eq("user_key", currentUserKey).maybeSingle(),
    ops.from("automation_health").select("*").order("updated_at", { ascending: false }),
    ops.from("task_log_entries").select("category,collaborator_name,task_name,task_date,synced_at").is("deleted_at", null).order("task_date", { ascending: false }).limit(3000),
  ]);
  const results = [...core, ...sources, ...operationsData, ...clickupData];
  if (results[0].error) return respond({ error: "query_failed", detail: results[0].error.message }, 500);
  const clients: any[] = value(results[0], []);
  const activeClients = clients.filter((row) => ["ACTIVE", "ONBOARDING"].includes(row.lifecycle));
  const activeIds = new Set(activeClients.map((row) => row.client_id));
  const alerts: any[] = value(results[1], []);
  const commitments: any[] = value(results[2], []);
  const conversations: any[] = value(results[3], []);
  const briefings: any[] = value(results[4], []);
  const jobs: any[] = value(results[6], []);
  const queue: any[] = value(results[7], []);
  const mediaRows: any[] = value(results[9], []);
  const activeMediaRows = mediaRows.filter((row) => row.client_id && activeIds.has(row.client_id));
  const latestHealthByClient = new Map<string, any>();
  for (const row of value<any[]>(results[11], [])) if (!latestHealthByClient.has(row.client_id)) latestHealthByClient.set(row.client_id, row);
  const enrichedClients = clients.map((client) => ({ ...client, health: latestHealthByClient.get(client.client_id) ?? null }));
  const count = (fn: (row: any) => boolean) => activeClients.filter(fn).length;
  const severity: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const now = new Date();
  const overdue = commitments.filter((row) => row.due_at && new Date(row.due_at) < now);
  const waitingAgency = conversations.filter((row) => row.waiting_for_agency);
  const waitingClient = conversations.filter((row) => row.waiting_for_client);
  const bottlenecks = activeClients.reduce((acc: Record<string, number>, row: any) => { const key = row.waiting_direction || row.onboarding_blocked_by || "NO_BLOCKER"; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
  const evidenceReview = activeClients.filter((row) => row.needs_semantic_review || ["PARTIAL", "INCOMPLETE"].includes(row.data_coverage));
  const clientNames = new Map(clients.map((row) => [row.client_id, row.display_name]));
  const clientLifecycles = new Map(clients.map((row) => [row.client_id, row.lifecycle]));
  const mediaGroups = new Map<string, any[]>();
  for (const row of mediaRows) {
    const key = `${row.client_id ?? "unlinked"}:${row.account_key ?? "unknown"}`;
    mediaGroups.set(key, [...(mediaGroups.get(key) ?? []), row]);
  }
  const campaigns = [...mediaGroups.values()].map((rows) => {
    const latestDate = rows.map((row) => row.date).filter(Boolean).sort().at(-1) ?? null;
    const latest = rows.filter((row) => row.date === latestDate);
    const spend = latest.reduce((sum, row) => sum + number(row.spend), 0);
    const leads = latest.reduce((sum, row) => sum + number(row.leads), 0);
    const clicks = latest.reduce((sum, row) => sum + number(row.clicks), 0);
    const impressions = latest.reduce((sum, row) => sum + number(row.impressions), 0);
    const ageDays = latestDate ? Math.floor((Date.now() - new Date(`${latestDate}T23:59:59Z`).getTime()) / 86400000) : null;
    return { client_id: latest[0]?.client_id ?? null, display_name: clientNames.get(latest[0]?.client_id) ?? null, lifecycle: clientLifecycles.get(latest[0]?.client_id) ?? "UNLINKED", account_key: latest[0]?.account_key ?? null, latest_date: latestDate, age_days: ageDays, is_stale: ageDays === null || ageDays > 2, spend: Number(spend.toFixed(2)), leads, clicks, impressions, cpl: leads ? Number((spend / leads).toFixed(2)) : null, ctr: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null, campaign_count: latest.reduce((sum, row) => sum + number(row.campaign_count), 0) };
  }).sort((a, b) => b.spend - a.spend);

  const lastClickupSync = value<any[]>(results[15], [])[0] ?? null;
  const clickupConfig: any = value(results[16], {});
  const totalClickup = results[14].count ?? 0;
  const matchedClickup = results[17].count ?? 0;
  return respond({
    kpis: { active_clients: activeClients.length, churned_clients: clients.filter((row) => row.lifecycle === "CHURNED").length, onboarding_clients: clients.filter((row) => row.lifecycle === "ONBOARDING").length, operation_clients: clients.filter((row) => row.lifecycle === "ACTIVE").length, attention_now: count((row) => row.priority === "ATTENTION"), follow_up: count((row) => row.priority === "FOLLOW_UP"), ok: count((row) => row.priority === "OK"), undetermined: count((row) => row.priority === "UNDETERMINED"), data_incomplete: count((row) => row.priority === "DATA_INCOMPLETE"), client_waiting_agency: count((row) => row.waiting_direction === "CLIENT_WAITING_AGENCY"), agency_waiting_client: count((row) => row.waiting_direction === "AGENCY_WAITING_CLIENT"), overdue_commitments: overdue.filter((row) => !row.client_id || activeIds.has(row.client_id)).length, open_alerts: alerts.filter((row) => !row.client_id || activeIds.has(row.client_id)).length, critical_alerts: alerts.filter((row) => (!row.client_id || activeIds.has(row.client_id)) && ["CRITICAL", "HIGH"].includes(row.severity)).length, semantic_review: conversations.filter((row) => row.needs_semantic_review && (!row.client_id || activeIds.has(row.client_id))).length, briefing_pages: briefings.length, briefing_pending: briefings.filter((row) => row.sync_status === "DISCOVERED").length, briefing_unlinked: briefings.filter((row) => !row.client_id).length, queue_pending: queue.filter((row) => row.status === "PENDING").length, queue_errors: queue.filter((row) => row.status === "ERROR").length },
    clients: enrichedClients, campaigns,
    alerts: alerts.sort((a, b) => (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9)).slice(0, 100),
    commitments, conversations, media: aggregateMedia(activeMediaRows),
    operations: { sla: { waiting_agency: waitingAgency, waiting_client: waitingClient, overdue_commitments: overdue }, bottlenecks, evidence_review: evidenceReview.slice(0, 100), employee_capacity: value(results[10], []), task_log: aggregateTaskLog(value(platformData[7], [])) },
    clickup: { productivity_30d: value(results[12], []), productivity_daily: value(results[13], []), recent_completed: value(results[14], []), total_completed: totalClickup, last_sync: lastClickupSync, configured: Boolean(clickupConfig?.token && clickupConfig?.team_id), webhook_configured: Boolean(clickupConfig?.webhook_secret), indexing: { matched: matchedClickup, match_rate: totalClickup ? Number((100 * matchedClickup / totalClickup).toFixed(1)) : 0, unmatched_label: results[18].count ?? 0, without_label: results[19].count ?? 0, unmatched_labels: value(results[20], []) } },
    coverage: { complete: count((row) => row.data_coverage === "COMPLETE"), partial: count((row) => row.data_coverage === "PARTIAL"), incomplete: count((row) => row.data_coverage === "INCOMPLETE") },
    notifications: value(platformData[0], []), preclients: value(platformData[1], []), won_events: value(platformData[2], []), audit_runs: value(platformData[3], []), audit_issues: value(platformData[4], []), preferences: value(platformData[5], {}), integration_health: value(platformData[6], []),
    health: { latest_whatsapp_message: value<any[]>(results[8], [])[0] ?? null, latest_notion_sync: value<any[]>(results[5], [])[0] ?? null, failed_jobs_24h: jobs.filter((row) => row.status === "ERROR" && new Date(row.started_at) > new Date(Date.now() - 86400000)), last_jobs: jobs.slice(0, 10) },
    auth_mode: currentUserKey === "adler-furtado" && suppliedKey.length >= 40 ? "dashboard_key" : "login",
    generated_at: new Date().toISOString(),
  });
});

