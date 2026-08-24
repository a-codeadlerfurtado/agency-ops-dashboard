import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
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

function leadIssueKey(incident: Row) {
  return ["lead", incident.client_id || incident.client_name || "sem-cliente", incident.product_label || "sem-produto", errorSignature(incident)].join("|");
}
function jobIssueKey(row: Row, category?: string, detail?: string) {
  return ["job", row.job_name || "sem-job", category || categoryForJob(row), detail || row.error || `status:${row.status || "desconhecido"}`].join("|");
}
function automationIssueKey(jobName: unknown) {
  return `automation|${String(jobName || "sem-job")}`;
}
function time(value: unknown) {
  const ms = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

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

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (String(body?.action || "").toLowerCase() !== "resolve") return respond({ error: "unsupported_action" }, 400);
    const issueKey = String(body?.issue_key || "").trim();
    const issueKind = String(body?.issue_kind || "ISSUE").trim().toUpperCase();
    const referenceId = body?.reference_id == null ? null : String(body.reference_id);
    const incidentIds = Array.isArray(body?.incident_ids) ? body.incident_ids.map(String).filter(Boolean).slice(0, 800) : [];
    const note = body?.note == null ? null : String(body.note).trim().slice(0, 2000);
    if (!issueKey) return respond({ error: "issue_key_required" }, 400);

    const resolvedAt = new Date().toISOString();
    const { error: resolutionError } = await ops.from("automation_issue_resolutions").upsert({
      issue_key: issueKey,
      issue_kind: issueKind,
      reference_id: referenceId,
      resolved_by_user_key: userKey,
      resolved_by_person: person,
      resolved_at: resolvedAt,
      note,
      updated_at: resolvedAt,
    }, { onConflict: "issue_key" });
    if (resolutionError) return respond({ error: "resolve_failed", detail: resolutionError.message }, 500);

    if (issueKind === "LEAD_DATA") {
      const ids = incidentIds.length ? incidentIds : referenceId ? [referenceId] : [];
      if (ids.length) {
        await ops.from("lead_dispatch_quality_incidents")
          .update({ status: "RESOLVED", resolved_at: resolvedAt, updated_at: resolvedAt })
          .in("id", ids);
      }
    }

    return respond({ ok: true, issue_key: issueKey, resolved_at: resolvedAt, resolved_by: person });
  }

  const url = new URL(req.url);
  const requestedDays = Number(url.searchParams.get("days") || 7);
  const days = [1, 7, 30].includes(requestedDays) ? requestedDays : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [healthResult, runsResult, incidentsResult, resolutionsResult] = await Promise.all([
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
    ops.from("automation_issue_resolutions")
      .select("issue_key,issue_kind,reference_id,resolved_by_person,resolved_at,note")
      .order("resolved_at", { ascending: false })
      .limit(2000),
  ]);

  if (healthResult.error) return respond({ error: "automation_health_query_failed", detail: healthResult.error.message }, 500);
  if (runsResult.error) return respond({ error: "job_runs_query_failed", detail: runsResult.error.message }, 500);
  if (incidentsResult.error) return respond({ error: "incidents_query_failed", detail: incidentsResult.error.message }, 500);
  if (resolutionsResult.error) return respond({ error: "resolutions_query_failed", detail: resolutionsResult.error.message }, 500);

  const health = (healthResult.data || []) as Row[];
  const runs = (runsResult.data || []) as Row[];
  const incidents = (incidentsResult.data || []) as Row[];
  const resolutions = (resolutionsResult.data || []) as Row[];
  const resolutionByKey = new Map<string, Row>(resolutions.map((row) => [String(row.issue_key), row]));
  const resolvedThrough = (issueKey: string, occurredAt: unknown) => {
    const resolution = resolutionByKey.get(issueKey);
    return Boolean(resolution && time(resolution.resolved_at) >= time(occurredAt));
  };

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
    const lastErrorAt = time(row.last_error_at);
    const lastSuccessAt = time(row.last_success_at);
    const latestStatus = String(latest?.status || "").toUpperCase();
    const degraded = Boolean(latest?.error) || Boolean(row.last_error && lastErrorAt >= lastSuccessAt);
    const rawStatus = latestStatus && latestStatus !== "SUCCESS" ? "ERROR" : degraded ? "DEGRADED" : "OK";
    const issueKey = automationIssueKey(row.job_name);
    const signalAt = row.last_error_at || latest?.started_at || row.updated_at;
    const resolution = resolutionByKey.get(issueKey) || null;
    const dashboardResolved = rawStatus !== "OK" && resolvedThrough(issueKey, signalAt);
    return {
      ...row,
      friendly_name: friendlyJob(row.job_name),
      family: family(row.job_name),
      status: dashboardResolved ? "RESOLVED" : rawStatus,
      raw_status: rawStatus,
      issue_key: issueKey,
      dashboard_resolved: dashboardResolved,
      resolved_at: dashboardResolved ? resolution?.resolved_at : null,
      resolved_by: dashboardResolved ? resolution?.resolved_by_person : null,
      latest_run: latest,
    };
  }).sort((a, b) => {
    const rank: Record<string, number> = { ERROR: 0, DEGRADED: 1, RESOLVED: 2, OK: 3 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.friendly_name).localeCompare(String(b.friendly_name), "pt-BR");
  });

  const issueRuns = runs
    .filter((row) => String(row.status || "").toUpperCase() !== "SUCCESS" || Boolean(String(row.error || "").trim()))
    .map((row) => {
      const category = categoryForJob(row);
      const detail = row.error || `Execução finalizada com status ${row.status}`;
      const issueKey = jobIssueKey(row, category, detail);
      const resolution = resolutionByKey.get(issueKey) || null;
      const dashboardResolved = resolvedThrough(issueKey, row.started_at);
      return {
        ...row,
        kind: "JOB",
        family: family(row.job_name),
        friendly_name: friendlyJob(row.job_name),
        category,
        severity: String(row.status || "").toUpperCase() === "SUCCESS" ? "ATTENTION" : "CRITICAL",
        occurred_at: row.started_at,
        title: friendlyJob(row.job_name),
        detail,
        issue_key: issueKey,
        dashboard_resolved: dashboardResolved,
        resolved_at: dashboardResolved ? resolution?.resolved_at : null,
        resolved_by: dashboardResolved ? resolution?.resolved_by_person : null,
      };
    });

  const enrichedIncidents = incidents.map((incident) => {
    const dispatch = dispatchById.get(String(incident.dispatch_id)) || null;
    const issueKey = leadIssueKey(incident);
    const resolution = resolutionByKey.get(issueKey) || null;
    const dashboardResolved = String(incident.status || "").toUpperCase() === "RESOLVED" || resolvedThrough(issueKey, incident.created_at);
    return {
      ...incident,
      kind: "LEAD_DATA",
      family: "Make / Z-API",
      category: "DATA",
      occurred_at: incident.created_at,
      title: `${incident.client_name || "Cliente não identificado"} · ${incident.product_label || "Produto não identificado"}`,
      detail: errorSignature(incident),
      issue_key: issueKey,
      dashboard_resolved: dashboardResolved,
      resolved_at: dashboardResolved ? (incident.resolved_at || resolution?.resolved_at) : null,
      resolved_by: dashboardResolved ? resolution?.resolved_by_person : null,
      dispatch,
    };
  });

  const activeIncidents = enrichedIncidents.filter((row) => !row.dashboard_resolved);
  const recurrenceMap = new Map<string, Row>();
  for (const incident of activeIncidents) {
    const key = String(incident.issue_key);
    const current = recurrenceMap.get(key) || {
      key,
      issue_key: key,
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
      incident_ids: [],
    };
    current.count += 1;
    current.incident_ids.push(String(incident.id));
    if (String(incident.severity).toUpperCase() === "CRITICAL") current.critical += 1;
    if (String(incident.status).toUpperCase() !== "RESOLVED") current.open += 1;
    if (time(incident.created_at) < time(current.first_at)) current.first_at = incident.created_at;
    if (time(incident.created_at) > time(current.last_at)) {
      current.last_at = incident.created_at;
      current.last_incident_id = incident.id;
    }
    recurrenceMap.set(key, current);
  }

  const recurring = [...recurrenceMap.values()]
    .filter((row) => Number(row.count) >= 2)
    .sort((a, b) => Number(b.count) - Number(a.count) || time(b.last_at) - time(a.last_at))
    .slice(0, 30);

  const timeline = [...issueRuns, ...enrichedIncidents]
    .sort((a, b) => time(b.occurred_at) - time(a.occurred_at))
    .slice(0, 150);

  const activeAffectedClients = new Set(activeIncidents.map((row) => row.client_id || row.client_name).filter(Boolean));
  const openIncidents = activeIncidents.filter((row) => String(row.status).toUpperCase() !== "RESOLVED");
  const criticalIncidents = activeIncidents.filter((row) => String(row.severity).toUpperCase() === "CRITICAL");

  return respond({
    ok: true,
    profile: { person, role: roster.role, access_level: roster.access_level },
    period: { days, since, until: new Date().toISOString() },
    summary: {
      monitored_automations: automations.length,
      automations_with_issue: automations.filter((row) => !["OK", "RESOLVED"].includes(row.status)).length,
      execution_issues: issueRuns.filter((row) => !row.dashboard_resolved).length,
      lead_data_incidents: activeIncidents.length,
      critical_incidents: criticalIncidents.length,
      open_incidents: openIncidents.length,
      affected_clients: activeAffectedClients.size,
      recurring_groups: recurring.length,
      resolved_in_period: timeline.filter((row) => row.dashboard_resolved).length,
    },
    automations,
    recurring,
    timeline,
    incidents: enrichedIncidents,
    generated_at: new Date().toISOString(),
  });
});
