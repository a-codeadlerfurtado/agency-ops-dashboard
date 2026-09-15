import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown, max = 12000) => String(value ?? "").trim().slice(0, max);
const upper = (value: unknown) => clean(value, 80).toUpperCase();
const numberOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const dateOrNull = (value: unknown) => {
  const raw = clean(value, 80);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const DECISION_CATEGORIES = new Set(["STRATEGY","BUDGET","CAMPAIGN","CREATIVE","AUDIENCE","COMMUNICATION","ONBOARDING","PROCESS","OTHER"]);
const DECISION_STATUS = new Set(["ACTIVE","CLOSED","SUPERSEDED","REVERSED"]);
const EXPERIMENT_TYPES = new Set(["AUDIENCE","CREATIVE","BUDGET","PLACEMENT","OBJECTIVE","COPY","LANDING_PAGE","CAMPAIGN_STRUCTURE","OTHER"]);
const EXPERIMENT_METRICS = new Set(["CPL","CPA","CTR","CPM","LEADS","CONVERSIONS","ROAS","CPC","OTHER"]);
const EXPERIMENT_STATUS = new Set(["PLANNED","RUNNING","COMPLETED","CANCELLED"]);
const EXPERIMENT_CONCLUSION = new Set(["ONGOING","WIN","LOSS","INCONCLUSIVE"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData?.user?.id) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const actorUserId = userData.user.id;

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", actorUserId).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", actorUserId).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const actorPerson = pref?.collaborator_person ?? pref?.name ?? null;
  if (!actorPerson || !(approvals ?? []).length) return respond({ error: "profile_locked" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level")
    .eq("person", actorPerson)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return respond({ error: "profile_not_found" }, 403);
  const actorRole = upper(roster.role);

  const { data: allowedViews, error: viewsError } = await ops.rpc("dashboard_allowed_views", { p_person: roster.person, p_role: roster.role });
  if (viewsError || !Array.isArray(allowedViews) || !allowedViews.some((view: string) => ["clients","campaigns","work"].includes(view))) {
    return respond({ error: "forbidden" }, 403);
  }

  let clientsQuery = ops.from("dashboard_client_overview")
    .select("client_id,display_name,lifecycle,gt_owner,cs_owner,designer_owner")
    .order("display_name", { ascending: true })
    .limit(1000);
  if (actorRole === "GT") clientsQuery = clientsQuery.eq("gt_owner", actorPerson);
  const { data: clients, error: clientsError } = await clientsQuery;
  if (clientsError) return respond({ error: "clients_query_failed", detail: clientsError.message }, 500);
  const scopedClients = clients ?? [];
  const clientIds = scopedClients.map((row: any) => String(row.client_id)).filter(Boolean);
  const clientMap = new Map(scopedClients.map((row: any) => [String(row.client_id), row]));

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "overview";
  const requestedClientId = clean(url.searchParams.get("client_id"), 80);
  const ensureClient = (id: string) => clientIds.includes(id);
  if (requestedClientId && !ensureClient(requestedClientId)) return respond({ error: "client_forbidden" }, 403);

  if (req.method === "GET") {
    if (view !== "overview") return respond({ error: "unknown_view" }, 404);
    if (!clientIds.length) return respond({ profile: { person: actorPerson, role: actorRole }, clients: [], decisions: [], experiments: [], stats: {}, generated_at: new Date().toISOString() });

    let decisionsQuery = ops.from("client_decisions").select("*").order("decided_at", { ascending: false }).limit(500);
    let experimentsQuery = ops.from("traffic_experiments").select("*").order("created_at", { ascending: false }).limit(500);
    if (requestedClientId) {
      decisionsQuery = decisionsQuery.eq("client_id", requestedClientId);
      experimentsQuery = experimentsQuery.eq("client_id", requestedClientId);
    } else {
      decisionsQuery = decisionsQuery.in("client_id", clientIds);
      experimentsQuery = experimentsQuery.in("client_id", clientIds);
    }

    const [{ data: decisions, error: decisionsError }, { data: experiments, error: experimentsError }] = await Promise.all([decisionsQuery, experimentsQuery]);
    if (decisionsError) return respond({ error: "decisions_query_failed", detail: decisionsError.message }, 500);
    if (experimentsError) return respond({ error: "experiments_query_failed", detail: experimentsError.message }, 500);

    const decoratedDecisions = (decisions ?? []).map((row: any) => ({
      ...row,
      client_name: clientMap.get(String(row.client_id))?.display_name ?? "Cliente",
    }));
    const decoratedExperiments = (experiments ?? []).map((row: any) => {
      const baseline = numberOrNull(row.baseline_value);
      const result = numberOrNull(row.result_value);
      const delta = baseline !== null && result !== null && baseline !== 0 ? ((result - baseline) / Math.abs(baseline)) * 100 : null;
      return { ...row, client_name: clientMap.get(String(row.client_id))?.display_name ?? "Cliente", delta_pct: delta };
    });
    const now = Date.now();
    const last30 = now - 30 * 86400000;
    return respond({
      profile: {
        person: actorPerson,
        role: actorRole,
        can_create_decision: true,
        can_manage_experiments: ["GT","MGMT","AI"].includes(actorRole),
        scope_model: actorRole === "GT" ? "OWN_WALLET" : "ALL_ALLOWED_CLIENTS",
      },
      clients: scopedClients,
      decisions: decoratedDecisions,
      experiments: decoratedExperiments,
      stats: {
        decisions_30d: decoratedDecisions.filter((row: any) => new Date(row.decided_at).getTime() >= last30).length,
        active_decisions: decoratedDecisions.filter((row: any) => row.status === "ACTIVE").length,
        experiments_running: decoratedExperiments.filter((row: any) => row.status === "RUNNING").length,
        experiments_completed: decoratedExperiments.filter((row: any) => row.status === "COMPLETED").length,
        experiment_wins: decoratedExperiments.filter((row: any) => row.conclusion === "WIN").length,
        learnings_recorded: decoratedExperiments.filter((row: any) => clean(row.learning).length > 0).length,
      },
      generated_at: new Date().toISOString(),
    });
  }

  const body = await req.json().catch(() => ({}));
  const clientId = clean(body.client_id, 80);
  if (!clientId || !ensureClient(clientId)) return respond({ error: "client_forbidden" }, 403);

  if (view === "decision-create") {
    const title = clean(body.title, 240);
    const decisionText = clean(body.decision_text);
    if (title.length < 3 || decisionText.length < 3) return respond({ error: "missing_fields", required: ["title","decision_text"] }, 400);
    const category = DECISION_CATEGORIES.has(upper(body.category)) ? upper(body.category) : "OTHER";
    const status = DECISION_STATUS.has(upper(body.status)) ? upper(body.status) : "ACTIVE";
    const decidedAt = dateOrNull(body.decided_at) ?? new Date().toISOString();
    const { data, error } = await ops.from("client_decisions").insert({
      client_id: clientId,
      category,
      title,
      decision_text: decisionText,
      reason: clean(body.reason) || null,
      expected_impact: clean(body.expected_impact) || null,
      outcome: clean(body.outcome) || null,
      status,
      decided_at: decidedAt,
      created_by_user_id: actorUserId,
      created_by_person: actorPerson,
      supersedes_decision_id: clean(body.supersedes_decision_id, 80) || null,
      source_type: "MANUAL",
      metadata: { role: actorRole },
    }).select("*").maybeSingle();
    if (error) return respond({ error: "decision_create_failed", detail: error.message }, 500);
    return respond({ ok: true, decision: { ...data, client_name: clientMap.get(clientId)?.display_name ?? "Cliente" } });
  }

  if (view === "decision-update") {
    const id = clean(body.id, 80);
    if (!id) return respond({ error: "id_required" }, 400);
    const { data: existing } = await ops.from("client_decisions").select("id,client_id,created_by_user_id").eq("id", id).maybeSingle();
    if (!existing || !ensureClient(String(existing.client_id))) return respond({ error: "not_found" }, 404);
    if (String(existing.created_by_user_id) !== actorUserId && !["MGMT","AI"].includes(actorRole)) return respond({ error: "forbidden_update" }, 403);
    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) {
      const status = upper(body.status);
      if (!DECISION_STATUS.has(status)) return respond({ error: "invalid_status" }, 400);
      patch.status = status;
    }
    if (body.outcome !== undefined) patch.outcome = clean(body.outcome) || null;
    if (body.reason !== undefined) patch.reason = clean(body.reason) || null;
    if (body.expected_impact !== undefined) patch.expected_impact = clean(body.expected_impact) || null;
    const { data, error } = await ops.from("client_decisions").update(patch).eq("id", id).select("*").maybeSingle();
    if (error) return respond({ error: "decision_update_failed", detail: error.message }, 500);
    return respond({ ok: true, decision: data });
  }

  if (view === "experiment-create") {
    if (!["GT","MGMT","AI"].includes(actorRole)) return respond({ error: "experiment_write_forbidden" }, 403);
    const title = clean(body.title, 240);
    const hypothesis = clean(body.hypothesis);
    if (title.length < 3 || hypothesis.length < 3) return respond({ error: "missing_fields", required: ["title","hypothesis"] }, 400);
    const experimentType = EXPERIMENT_TYPES.has(upper(body.experiment_type)) ? upper(body.experiment_type) : "OTHER";
    const primaryMetric = EXPERIMENT_METRICS.has(upper(body.primary_metric)) ? upper(body.primary_metric) : "CPL";
    const status = EXPERIMENT_STATUS.has(upper(body.status)) ? upper(body.status) : "PLANNED";
    const conclusion = EXPERIMENT_CONCLUSION.has(upper(body.conclusion)) ? upper(body.conclusion) : "ONGOING";
    const startAt = dateOrNull(body.start_at);
    const endAt = dateOrNull(body.end_at);
    if (startAt && endAt && new Date(endAt) < new Date(startAt)) return respond({ error: "invalid_date_order" }, 400);
    const campaignIds = Array.isArray(body.campaign_ids) ? body.campaign_ids.map((x: unknown) => clean(x, 120)).filter(Boolean).slice(0, 50) : [];
    const { data, error } = await ops.from("traffic_experiments").insert({
      client_id: clientId,
      title,
      experiment_type: experimentType,
      hypothesis,
      variable_tested: clean(body.variable_tested) || null,
      control_description: clean(body.control_description) || null,
      variant_description: clean(body.variant_description) || null,
      primary_metric: primaryMetric,
      baseline_value: numberOrNull(body.baseline_value),
      result_value: numberOrNull(body.result_value),
      start_at: startAt,
      end_at: endAt,
      status,
      conclusion,
      result_summary: clean(body.result_summary) || null,
      learning: clean(body.learning) || null,
      campaign_ids: campaignIds,
      created_by_user_id: actorUserId,
      created_by_person: actorPerson,
      source_type: "MANUAL",
      metadata: { role: actorRole },
    }).select("*").maybeSingle();
    if (error) return respond({ error: "experiment_create_failed", detail: error.message }, 500);
    return respond({ ok: true, experiment: { ...data, client_name: clientMap.get(clientId)?.display_name ?? "Cliente" } });
  }

  if (view === "experiment-update") {
    if (!["GT","MGMT","AI"].includes(actorRole)) return respond({ error: "experiment_write_forbidden" }, 403);
    const id = clean(body.id, 80);
    if (!id) return respond({ error: "id_required" }, 400);
    const { data: existing } = await ops.from("traffic_experiments").select("id,client_id").eq("id", id).maybeSingle();
    if (!existing || !ensureClient(String(existing.client_id))) return respond({ error: "not_found" }, 404);
    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) {
      const value = upper(body.status);
      if (!EXPERIMENT_STATUS.has(value)) return respond({ error: "invalid_status" }, 400);
      patch.status = value;
    }
    if (body.conclusion !== undefined) {
      const value = upper(body.conclusion);
      if (!EXPERIMENT_CONCLUSION.has(value)) return respond({ error: "invalid_conclusion" }, 400);
      patch.conclusion = value;
    }
    if (body.result_value !== undefined) patch.result_value = numberOrNull(body.result_value);
    if (body.result_summary !== undefined) patch.result_summary = clean(body.result_summary) || null;
    if (body.learning !== undefined) patch.learning = clean(body.learning) || null;
    if (body.end_at !== undefined) patch.end_at = dateOrNull(body.end_at);
    if (body.baseline_value !== undefined) patch.baseline_value = numberOrNull(body.baseline_value);
    const { data, error } = await ops.from("traffic_experiments").update(patch).eq("id", id).select("*").maybeSingle();
    if (error) return respond({ error: "experiment_update_failed", detail: error.message }, 500);
    return respond({ ok: true, experiment: data });
  }

  return respond({ error: "unknown_action" }, 404);
});