import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Row = Record<string, any>;

const FOCUS: Record<string, { stage: string; label: string; description: string }> = {
  "Gustavo Lima": {
    stage: "PRODUCT_PERSONA_MEETING",
    label: "Reunião de Produto + Persona",
    description: "Acompanhamento da reunião de formulário de Produto e Persona e do preenchimento dos dois formulários.",
  },
  "Joel Antoniete": {
    stage: "INTRO_MEETING",
    label: "1ª reunião de apresentação",
    description: "Acompanhamento da primeira reunião de onboarding e apresentação do cliente.",
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user?.id) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || "");
  if (!person || !(approvals || []).length) return respond({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level,is_former")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);

  const focus = FOCUS[person] || null;
  if (!focus) {
    return respond({
      profile: { person, role: roster.role, access_level: roster.access_level, focus_stage: null, can_view_all: true },
      items: [],
      summary: {},
      generated_at: new Date().toISOString(),
    });
  }

  const [{ data: cases, error: casesError }, { data: definitions, error: definitionsError }] = await Promise.all([
    ops.from("onboarding_cases")
      .select("id,client_id,opened_at,status,current_stage,onboarding_risk,blocked_by,next_action,next_action_due")
      .eq("status", "OPEN")
      .order("opened_at", { ascending: false }),
    ops.from("onboarding_stage_definitions").select("code,label,ordem").order("ordem"),
  ]);
  if (casesError) return respond({ error: "cases_query_failed", detail: casesError.message }, 500);
  if (definitionsError) return respond({ error: "definitions_query_failed", detail: definitionsError.message }, 500);

  const caseRows = cases || [];
  const caseIds = caseRows.map((row: Row) => Number(row.id));
  const clientIds = Array.from(new Set(caseRows.map((row: Row) => String(row.client_id)).filter(Boolean)));
  if (!caseIds.length) {
    return respond({
      profile: { person, role: roster.role, access_level: roster.access_level, focus_stage: focus.stage, focus_label: focus.label, focus_description: focus.description, can_view_all: true },
      items: [], summary: { total: 0, action: 0, scheduled: 0, in_progress: 0, completed: 0, blocked: 0, product_forms_done: 0, persona_forms_done: 0 },
      generated_at: new Date().toISOString(),
    });
  }

  const stageCodes = person === "Gustavo Lima" ? [focus.stage, "PRODUCT_FORM", "PERSONA_FORM"] : [focus.stage];
  const [clientsResult, stagesResult, linksResult, proposalsResult] = await Promise.all([
    clientIds.length
      ? ops.from("clients").select("id,display_name,lifecycle,entrada,cs_owner,gt_owner,designer_owner").in("id", clientIds)
      : Promise.resolve({ data: [], error: null } as any),
    ops.from("onboarding_stages")
      .select("case_id,stage_code,status,started_at,completed_at,due_at,blocked_type,notes,applicability")
      .in("case_id", caseIds)
      .in("stage_code", stageCodes),
    ops.from("onboarding_stage_meet_links")
      .select("case_id,stage_code,url,provider,occurred_at,scheduled_for,is_current")
      .in("case_id", caseIds)
      .eq("stage_code", focus.stage)
      .eq("is_current", true),
    ops.from("onboarding_meeting_schedule_proposals")
      .select("case_id,stage_code,proposed_at,proposed_for,status,confirmed_at,proposal_text")
      .in("case_id", caseIds)
      .eq("stage_code", focus.stage)
      .order("confirmed_at", { ascending: false, nullsFirst: false })
      .order("proposed_at", { ascending: false }),
  ]);
  if (clientsResult.error) return respond({ error: "clients_query_failed", detail: clientsResult.error.message }, 500);
  if (stagesResult.error) return respond({ error: "stages_query_failed", detail: stagesResult.error.message }, 500);
  if (linksResult.error) return respond({ error: "links_query_failed", detail: linksResult.error.message }, 500);
  if (proposalsResult.error) return respond({ error: "schedule_query_failed", detail: proposalsResult.error.message }, 500);

  const clientMap = new Map((clientsResult.data || []).map((row: Row) => [String(row.id), row]));
  const defMap = new Map((definitions || []).map((row: Row) => [String(row.code), row]));
  const stageMap = new Map<string, Row>();
  for (const row of stagesResult.data || []) stageMap.set(`${row.case_id}:${row.stage_code}`, row);
  const linkMap = new Map<number, Row>();
  for (const row of linksResult.data || []) if (!linkMap.has(Number(row.case_id))) linkMap.set(Number(row.case_id), row);
  const proposalMap = new Map<number, Row>();
  for (const row of proposalsResult.data || []) if (!proposalMap.has(Number(row.case_id))) proposalMap.set(Number(row.case_id), row);

  const statusRank: Record<string, number> = { BLOCKED: 0, IN_PROGRESS: 1, SCHEDULED: 2, PENDING: 3, DONE: 4, SKIPPED: 5 };
  const focusOrder = Number(defMap.get(focus.stage)?.ordem || 0);
  const items = caseRows.map((caseRow: Row) => {
    const caseId = Number(caseRow.id);
    const client = clientMap.get(String(caseRow.client_id)) || {};
    const stage = stageMap.get(`${caseId}:${focus.stage}`) || {};
    const currentDefinition = defMap.get(String(caseRow.current_stage)) || {};
    const currentOrder = Number(currentDefinition.ordem || 0);
    const product = stageMap.get(`${caseId}:PRODUCT_FORM`) || {};
    const persona = stageMap.get(`${caseId}:PERSONA_FORM`) || {};
    const link = linkMap.get(caseId) || {};
    const proposal = proposalMap.get(caseId) || {};
    const stageStatus = String(stage.status || "PENDING");
    const waitingPrevious = stageStatus === "PENDING" && currentOrder > 0 && currentOrder < focusOrder;
    const scheduledFor = link.scheduled_for || (String(proposal.status || "").toUpperCase() === "CONFIRMED" ? proposal.proposed_for : null);
    return {
      case_id: caseId,
      client_id: caseRow.client_id,
      display_name: client.display_name || "Cliente",
      lifecycle: client.lifecycle,
      entrada: client.entrada,
      cs_owner: client.cs_owner,
      gt_owner: client.gt_owner,
      designer_owner: client.designer_owner,
      onboarding_risk: caseRow.onboarding_risk,
      blocked_by: caseRow.blocked_by,
      current_stage: caseRow.current_stage,
      current_stage_label: currentDefinition.label || caseRow.current_stage,
      next_action: caseRow.next_action,
      next_action_due: caseRow.next_action_due,
      stage_code: focus.stage,
      stage_label: focus.label,
      stage_status: stageStatus,
      stage_started_at: stage.started_at,
      stage_due_at: stage.due_at,
      stage_completed_at: stage.completed_at,
      stage_blocked_type: stage.blocked_type,
      stage_notes: stage.notes,
      waiting_previous_stage: waitingPrevious,
      scheduled_for: scheduledFor,
      meet_url: link.url || null,
      meet_detected_at: link.occurred_at || null,
      schedule_status: proposal.status || null,
      product_form_status: person === "Gustavo Lima" ? String(product.status || "PENDING") : null,
      persona_form_status: person === "Gustavo Lima" ? String(persona.status || "PENDING") : null,
    };
  }).sort((a: Row, b: Row) => {
    const rank = (statusRank[String(a.stage_status)] ?? 9) - (statusRank[String(b.stage_status)] ?? 9);
    if (rank) return rank;
    const aTime = new Date(String(a.scheduled_for || a.next_action_due || "9999-12-31")).getTime();
    const bTime = new Date(String(b.scheduled_for || b.next_action_due || "9999-12-31")).getTime();
    return aTime - bTime || String(a.display_name).localeCompare(String(b.display_name), "pt-BR");
  });

  const actionStatuses = new Set(["PENDING", "SCHEDULED", "IN_PROGRESS", "BLOCKED"]);
  const summary = {
    total: items.length,
    action: items.filter((row: Row) => actionStatuses.has(String(row.stage_status)) && !row.waiting_previous_stage).length,
    waiting_previous: items.filter((row: Row) => row.waiting_previous_stage).length,
    scheduled: items.filter((row: Row) => row.stage_status === "SCHEDULED").length,
    in_progress: items.filter((row: Row) => row.stage_status === "IN_PROGRESS").length,
    completed: items.filter((row: Row) => ["DONE", "SKIPPED"].includes(String(row.stage_status))).length,
    blocked: items.filter((row: Row) => row.stage_status === "BLOCKED").length,
    product_forms_done: items.filter((row: Row) => row.product_form_status === "DONE").length,
    persona_forms_done: items.filter((row: Row) => row.persona_form_status === "DONE").length,
  };

  return respond({
    profile: {
      person,
      role: roster.role,
      access_level: roster.access_level,
      focus_stage: focus.stage,
      focus_label: focus.label,
      focus_description: focus.description,
      can_view_all: true,
    },
    items,
    summary,
    generated_at: new Date().toISOString(),
  });
});
