import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Row = Record<string, any>;

function family(jobName: unknown) {
  const value = String(jobName || "").toLowerCase();
  if (value.includes("make")) return "Make";
  if (value.includes("zapi") || value.includes("whatsapp")) return "Z-API / WhatsApp";
  if (value.includes("meta")) return "Meta Ads";
  if (value.includes("clickup")) return "ClickUp";
  if (value.includes("notion")) return "Notion";
  if (value.includes("sheet")) return "Google Sheets";
  if (value.includes("crm")) return "CRM";
  return "Automação interna";
}

function friendlyJob(jobName: unknown) {
  const raw = String(jobName || "automacao");
  const known: Record<string, string> = {
    zapi_direct_official: "Entrada e roteamento Z-API",
    zapi_direct_test: "Teste de entrada Z-API",
    notion_client_health_sync: "Sincronização Saúde → Notion",
    crm_sync: "Sincronização CRM",
    meta_balance_alerts_refresh: "Atualização de alertas de saldo Meta",
    meta_balance_sync: "Sincronização de saldo Meta",
    meta_campaign_metrics_sync: "Métricas de campanhas Meta",
    alerts_refresh: "Atualização dos alertas operacionais",
    weekly_traffic_reports_monday: "Relatórios semanais de tráfego",
    sheet_sync: "Sincronização de planilhas",
  };
  return known[raw] || raw.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryForJob(row: Row) {
  const haystack = `${row.job_name || ""} ${row.error || ""}`.toLowerCase();
  if (/permission|token|unauthor|forbidden|credential|oauth|grant|access/.test(haystack)) return "INTEGRATION";
  if (/timeout|timed out|network|socket|fetch|http 5|connection|dns/.test(haystack)) return "TECHNICAL";
  if (/routing|route|carteira|cliente errado|recipient|destination/.test(haystack)) return "ROUTING";
  return "EXECUTION";
}

function errorSignature(incident: Row) {
  const required = Array.isArray(incident.missing_required) ? incident.missing_required.map(String).sort() : [];
  const extras = Array.isArray(incident.missing_extra_questions)
    ? incident.missing_extra_questions.map((item: Row) => String(item?.question || "pergunta sem resposta")).sort()
    : [];
  return [...required, ...extras].join(" | ") || "Dado incompleto";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;

  const { data: preference } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userKey)
    .maybeSingle();
  const person = preference?.collaborator_person || null;
  if (!person) return respond({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("role,access_level,is_former")
    .eq("person", person)
    .maybeSingle();
  if (!roster || roster.is_former || String(roster.role).toUpperCase() !== "MGMT") {
    return respond({ error: "forbidden" }, 403);
  }

  const url = new URL(req.url);
  const requestedDays = Number(url.searchParams.get("days") || 7);
  const days = [1, 7, 30].includes(requestedDays) ? requestedDays : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [healthResult, runsResult, incidentsResult] = await Promise.all([
    ops.from("automation_health")
      .select("job_name,last_success_at,last_error_at,last_error,updated_at")
      .order("updated_at", { ascending: false }),
    ops.from("job_runs")
      .select("id,job_name,started_at,finished_at,status,events_processed,error,duration_ms")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1500),
    ops.from("lead_dispatch_quality_incidents")
      .select("id,dispatch_id,message_id,client_id,client_name,target_gt,product_label,missing_required,missing_extra_questions,occurrence_no,severity,status,raw_text,created_at,acknowledged_by_person,acknowledged_at,resolved_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(800),
  ]);

  if (healthResult.error) return respond({ error: "automation_health_query_failed", detail: healthResult.error.message }, 500);
  if (runsResult.error) return respond({ error: "job_runs_query_failed", detail: runsResult.error.message }, 500);
  if (incidentsResult.error) return respond({ error: "incidents_query_failed", detail: incidentsResult.error.message }, 500);

  const health = (healthResult.data || []) as Row[];
  const runs = (runsResult.data || []) as Row[];
  const incidents = (incidentsResult.data || []) as Row[];
  const dispatchIds = [...new Set(incidents.map((row) => row.dispatch_id).filter((value) => value != null).map(String))];

  const dispatchById = new Map<string, Row>();
  if (dispatchIds.length) {
    const { data: dispatches } = await ops.from("meta_lead_dispatches")
      .select("id,message_id,event_at,connected_phone,recipient_phone,product_label,lead_name,lead_phone,lead_email,recipient_client_id,expected_client_id,routing_status,recipient_match_method,expected_match_method,group_product_evidence_count")
      .in("id", dispatchIds.slice(0, 800));
    for (const row of dispatches || []) dispatchById.set(String(row.id), row as Row);
  }

  const latestRunByJob = new Map<string, Row>();
  for (const run of runs) {
    const key = String(run.job_name || "");
    if (key && !latestRunByJob.has(key)) latestRunByJob.set(key, run);
  }

  const automations = health.map((row) => {
    const latest = latestRunByJob.get(String(row.job_name)) || null;
    const lastErrorAt = row.last_error_at ? new Date(row.last_error_at).getTime() : 0;
    const lastSuccessAt = row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
    const latestStatus = String(latest?.status || "").toUpperCase();
    const degraded = Boolean(latest?.error) || Boolean(row.last_error && lastErrorAt >= lastSuccessAt);
    const status = latestStatus && latestStatus !== "SUCCESS" ? "ERROR" : degraded ? "DEGRADED" : "OK";
    return {
      ...row,
      friendly_name: friendlyJob(row.job_name),
      family: family(row.job_name),
      status,
      latest_run: latest,
    };
  }).sort((a, b) => {
    const rank: Record<string, number> = { ERROR: 0, DEGRADED: 1, OK: 2 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.friendly_name).localeCompare(String(b.friendly_name), "pt-BR");
  });

  const issueRuns = runs
    .filter((row) => String(row.status || "").toUpperCase() !== "SUCCESS" || Boolean(String(row.error || "").trim()))
    .map((row) => ({
      ...row,
      kind: "JOB",
      family: family(row.job_name),
      friendly_name: friendlyJob(row.job_name),
      category: categoryForJob(row),
      severity: String(row.status || "").toUpperCase() === "SUCCESS" ? "ATTENTION" : "CRITICAL",
      occurred_at: row.started_at,
      title: friendlyJob(row.job_name),
      detail: row.error || `Execução finalizada com status ${row.status}`,
    }));

  const enrichedIncidents = incidents.map((incident) => {
    const dispatch = dispatchById.get(String(incident.dispatch_id)) || null;
    return {
      ...incident,
      kind: "LEAD_DATA",
      family: "Make / Z-API",
      category: "DATA",
      occurred_at: incident.created_at,
      title: `${incident.client_name || "Cliente não identificado"} · ${incident.product_label || "Produto não identificado"}`,
      detail: errorSignature(incident),
      dispatch,
    };
  });

  const recurrenceMap = new Map<string, Row>();
  for (const incident of enrichedIncidents) {
    const key = [incident.client_id || incident.client_name || "sem-cliente", incident.product_label || "sem-produto", errorSignature(incident)].join("|");
    const current = recurrenceMap.get(key) || {
      key,
      client_id: incident.client_id,
      client_name: incident.client_name,
      product_label: incident.product_label,
      signature: errorSignature(incident),
      count: 0,
      critical: 0,
      open: 0,
      first_at: incident.created_at,
      last_at: incident.created_at,
      last_incident_id: incident.id,
    };
    current.count += 1;
    if (String(incident.severity).toUpperCase() === "CRITICAL") current.critical += 1;
    if (String(incident.status).toUpperCase() === "OPEN") current.open += 1;
    if (new Date(incident.created_at).getTime() < new Date(current.first_at).getTime()) current.first_at = incident.created_at;
    if (new Date(incident.created_at).getTime() > new Date(current.last_at).getTime()) {
      current.last_at = incident.created_at;
      current.last_incident_id = incident.id;
    }
    recurrenceMap.set(key, current);
  }

  const recurring = [...recurrenceMap.values()]
    .filter((row) => Number(row.count) >= 2)
    .sort((a, b) => Number(b.count) - Number(a.count) || new Date(b.last_at).getTime() - new Date(a.last_at).getTime())
    .slice(0, 30);

  const timeline = [...issueRuns, ...enrichedIncidents]
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
    .slice(0, 150);

  const affectedClients = new Set(enrichedIncidents.map((row) => row.client_id || row.client_name).filter(Boolean));
  const openIncidents = enrichedIncidents.filter((row) => String(row.status).toUpperCase() === "OPEN");
  const criticalIncidents = enrichedIncidents.filter((row) => String(row.severity).toUpperCase() === "CRITICAL");

  return respond({
    ok: true,
    profile: { person, role: roster.role, access_level: roster.access_level },
    period: { days, since, until: new Date().toISOString() },
    summary: {
      monitored_automations: automations.length,
      automations_with_issue: automations.filter((row) => row.status !== "OK").length,
      execution_issues: issueRuns.length,
      lead_data_incidents: enrichedIncidents.length,
      critical_incidents: criticalIncidents.length,
      open_incidents: openIncidents.length,
      affected_clients: affectedClients.size,
      recurring_groups: recurring.length,
    },
    automations,
    recurring,
    timeline,
    incidents: enrichedIncidents,
    generated_at: new Date().toISOString(),
  });
});
