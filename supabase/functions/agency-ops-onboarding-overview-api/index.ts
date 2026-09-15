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
const DONE = new Set(["DONE", "SKIPPED", "COMPLETED"]);
const MEETINGS = new Set(["INTRO_MEETING", "PRODUCT_PERSONA_MEETING", "INTEGRATION_MEETING"]);

function ownerFor(stage: string, client: Row) {
  if (stage === "INTRO_MEETING") return "Joel Antoniete";
  if (["PRODUCT_PERSONA_MEETING", "PRODUCT_FORM", "PERSONA_FORM"].includes(stage)) return "Gustavo Lima";
  if (["INTEGRATION_MEETING", "ACCESS_VALIDATION", "CAMPAIGN_LAUNCH", "READY_TO_LAUNCH"].includes(stage)) return client.gt_owner || "GT ainda não definido";
  if (["CREATIVE_PRODUCTION", "CREATIVE_APPROVAL"].includes(stage)) return "Equipe criativa";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

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
  const userKey = authData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || "");
  if (!person || !(approvals || []).length) return respond({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster").select("person,role,access_level,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);
  const role = String(roster.role || "");
  const isAdler = person === "Adler Furtado";
  const isLeonardo = person === "Leonardo Augusto" && role === "COMMERCIAL";
  const canManage = isAdler || isLeonardo;
  if (!canManage && role !== "CS") return respond({ error: "forbidden", detail: "Visão geral disponível para Direção e CS." }, 403);

  const [{ data: definitions, error: defError }, { data: cases, error: caseError }] = await Promise.all([
    ops.from("onboarding_stage_definitions").select("code,label,ordem,is_parallel,default_sla_hours").order("ordem", { ascending: true }),
    ops.from("onboarding_cases").select("id,client_id,status,current_stage,onboarding_risk,blocked_by,next_action,next_action_due,opened_at,updated_at").eq("status", "OPEN").order("opened_at", { ascending: false }),
  ]);
  if (defError) return respond({ error: "definitions_failed", detail: defError.message }, 500);
  if (caseError) return respond({ error: "cases_failed", detail: caseError.message }, 500);

  const caseRows = cases || [];
  const caseIds = caseRows.map((row: Row) => row.id);
  const clientIds = Array.from(new Set(caseRows.map((row: Row) => String(row.client_id)).filter(Boolean)));
  const profile = { person, role, access_level: canManage ? "DIRECTION_MANAGER" : roster.access_level, is_adler: isAdler, is_leonardo: isLeonardo, can_edit: canManage };
  if (!caseIds.length) return respond({ profile, definitions: definitions || [], clients: [], summary: { clients: 0 }, generated_at: new Date().toISOString() });

  const [clientResult, stageResult, linkResult, attemptResult] = await Promise.all([
    ops.from("clients").select("id,display_name,entrada,cs_owner,gt_owner,designer_owner,lifecycle").in("id", clientIds),
    ops.from("onboarding_stages").select("id,case_id,stage_code,status,started_at,completed_at,due_at,blocked_type,notes,applicability").in("case_id", caseIds),
    ops.from("onboarding_stage_meet_links").select("id,case_id,stage_code,url,provider,scheduled_for,occurred_at,is_current,metadata").in("case_id", caseIds).eq("is_current", true),
    ops.from("onboarding_stage_attempts").select("id,case_id,stage_code,attempt_no,scheduled_at,started_at,ended_at,outcome,reason_code,reason_detail,objective_achieved,retry_required,rescheduled_for,evidence_text,confidence").in("case_id", caseIds).order("attempt_no", { ascending: false }),
  ]);
  for (const result of [clientResult, stageResult, linkResult, attemptResult]) if (result.error) return respond({ error: "overview_query_failed", detail: result.error.message }, 500);

  const clientMap = new Map((clientResult.data || []).map((row: Row) => [String(row.id), row]));
  const defMap = new Map((definitions || []).map((row: Row) => [String(row.code), row]));
  const linkMap = new Map<string, Row>();
  for (const row of linkResult.data || []) linkMap.set(`${row.case_id}:${row.stage_code}`, row);
  const attemptMap = new Map<string, Row>();
  for (const row of attemptResult.data || []) { const key = `${row.case_id}:${row.stage_code}`; if (!attemptMap.has(key)) attemptMap.set(key, row); }
  const stageByCase = new Map<number, Row[]>();
  for (const row of stageResult.data || []) stageByCase.set(Number(row.case_id), [...(stageByCase.get(Number(row.case_id)) || []), row]);

  const now = Date.now();
  const clients = caseRows.map((item: Row) => {
    const client = clientMap.get(String(item.client_id)) || {};
    const stages = (stageByCase.get(Number(item.id)) || []).map((stage: Row) => {
      const def = defMap.get(String(stage.stage_code)) || {};
      const link = linkMap.get(`${item.id}:${stage.stage_code}`) || {};
      const attempt = attemptMap.get(`${item.id}:${stage.stage_code}`) || null;
      const overdue = !DONE.has(String(stage.status)) && stage.due_at && new Date(String(stage.due_at)).getTime() < now;
      return { ...stage, label: def.label || stage.stage_code, ordem: def.ordem ?? 999, is_parallel: Boolean(def.is_parallel), owner: ownerFor(String(stage.stage_code), client), meet_url: link.url || null, scheduled_for: link.scheduled_for || null, meet_provider: link.provider || null, last_attempt: attempt, overdue, is_meeting: MEETINGS.has(String(stage.stage_code)) };
    }).sort((a: Row, b: Row) => Number(a.ordem) - Number(b.ordem));
    const currentDef = defMap.get(String(item.current_stage)) || {};
    return { case_id: item.id, client_id: item.client_id, display_name: client.display_name || "Cliente", entrada: client.entrada || null, cs_owner: client.cs_owner || null, gt_owner: client.gt_owner || null, designer_owner: client.designer_owner || null, lifecycle: client.lifecycle || null, onboarding_risk: item.onboarding_risk || "OK", blocked_by: item.blocked_by || null, current_stage: item.current_stage, current_stage_label: currentDef.label || item.current_stage, next_action: item.next_action || null, next_action_due: item.next_action_due || null, opened_at: item.opened_at, updated_at: item.updated_at, stages };
  });

  const allStages = clients.flatMap((client: Row) => client.stages || []);
  const meetingStages = allStages.filter((stage: Row) => stage.is_meeting);
  const summary = {
    clients: clients.length,
    blocked: allStages.filter((stage: Row) => stage.status === "BLOCKED").length,
    overdue: allStages.filter((stage: Row) => stage.overdue).length,
    meetings_scheduled: meetingStages.filter((stage: Row) => stage.status === "SCHEDULED").length,
    intro_open: meetingStages.filter((stage: Row) => stage.stage_code === "INTRO_MEETING" && !DONE.has(String(stage.status))).length,
    product_persona_open: meetingStages.filter((stage: Row) => stage.stage_code === "PRODUCT_PERSONA_MEETING" && !DONE.has(String(stage.status))).length,
    integration_open: meetingStages.filter((stage: Row) => stage.stage_code === "INTEGRATION_MEETING" && !DONE.has(String(stage.status))).length,
  };

  return respond({ profile, definitions: definitions || [], clients, summary, generated_at: new Date().toISOString() });
});
