import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
type Row = Record<string, any>;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function recencyScore(value: unknown, goodHours: number, staleHours: number) {
  if (!value) return { score: 0, state: "MISSING", last_at: null };
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return { score: 0, state: "MISSING", last_at: null };
  const hours = Math.max(0, (Date.now() - d.getTime()) / 36e5);
  if (hours <= goodHours) return { score: 100, state: "GOOD", last_at: d.toISOString() };
  if (hours <= staleHours) return { score: 65, state: "STALE", last_at: d.toISOString() };
  return { score: 30, state: "STALE", last_at: d.toISOString() };
}
function latestDate(...values: unknown[]) {
  const valid = values.map((v) => v ? new Date(String(v)) : null).filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime()))).toISOString();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  const user = userData?.user;
  if (authError || !user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((r: Row) => r.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "inactive_profile" }, 403);
  const role = String(roster.role || "").toUpperCase();
  if (!["GT", "CS", "MGMT"].includes(role)) return reply({ error: "forbidden" }, 403);
  if (person === "Leonardo Augusto") return reply({ error: "forbidden" }, 403);
  const elevated = (approvals || []).some((r: Row) => r.kind === "ELEVATION");

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get("client_id") || "").trim();
  const name = String(url.searchParams.get("name") || "").trim();
  if (!clientId && !name) return reply({ error: "missing_client" }, 400);

  let client: Row | null = null;
  if (clientId) {
    const { data, error } = await ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner,designer_owner,updated_at").eq("id", clientId).maybeSingle();
    if (error) return reply({ error: "query_failed" }, 500);
    client = data;
  } else {
    const { data, error } = await ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner,designer_owner,updated_at").eq("display_name", name).limit(2);
    if (error) return reply({ error: "query_failed" }, 500);
    if ((data || []).length > 1) return reply({ error: "ambiguous_client" }, 409);
    client = data?.[0] || null;
  }
  if (!client) return reply({ error: "client_not_found" }, 404);
  if (role === "GT" && !elevated && String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403);

  const cid = client.id;
  const [healthQ, snapshotQ, metaQ, integrationsQ, workQ, clickupQ, clickupRecentQ, commitmentsQ, adjustmentsQ, meetingsQ, reportsQ, notesQ, campaignsQ, whatsappQ] = await Promise.all([
    ops.from("client_health_board").select("priority,internal_score,internal_band,internal_date,external_health_status,external_health_score,external_risk_level,external_satisfaction_avg,external_risk_avg,external_summary,external_recommended_action,external_source_updated_at,sentimento,sinais_alerta,sinais_positivos,reclamacoes,crosscheck_status").eq("client_id", cid).maybeSingle(),
    ops.from("client_operational_snapshot").select("priority,waiting_direction,summary_today,current_subject,action_owner,next_step,next_step_due,open_commitments,overdue_commitments,open_complaints,pending_approvals,blockers,data_coverage,confidence,last_activity_at,snapshot_at,updated_at").eq("client_id", cid).maybeSingle(),
    ops.from("campaign_client_latest").select("configured_accounts,configured_account_names,latest_date,checked_at,insight_accounts,campaign_count,active_campaigns,paused_campaigns,spend,impressions,clicks,results,leads,result_types,ctr,cpc,cpm,cost_per_result,age_days,delivery_status").eq("client_id", cid).maybeSingle(),
    ops.from("client_integrations").select("system,external_id,external_name,confidence,matched_by,is_primary,created_at,meta_ad_account_id").eq("client_id", cid).order("is_primary", { ascending: false }).limit(30),
    ops.from("work_items").select("id,type,status,priority,title,description,target_role,target_person,due_at,snoozed_until,waiting_reason,waiting_since,updated_at").eq("client_id", cid).order("updated_at", { ascending: false }).limit(12),
    ops.from("clickup_tasks").select("task_id,name,status,due_date,date_updated,last_synced_at,url,assignee_names,is_closed").eq("client_id", cid).eq("is_closed", false).order("date_updated", { ascending: false }).limit(12),
    ops.from("clickup_tasks").select("last_synced_at").eq("client_id", cid).order("last_synced_at", { ascending: false }).limit(1),
    ops.from("commitments").select("id,origem,descricao,owner,due_at,status,task_id,evidencia,confirmed_by_human,updated_at").eq("client_id", cid).in("status", ["OPEN", "IN_PROGRESS"]).order("due_at", { ascending: true, nullsFirst: false }).limit(12),
    ops.from("client_adjustments").select("id,source,tipo,descricao,occurred_at,responsible_person,author_name_snapshot,category_code,subcategory_code,reason,request_origin,responsible_area,status,severity,resolution,is_recurrent,resolved_at,campaign_id,creative_id").eq("client_id", cid).order("occurred_at", { ascending: false }).limit(10),
    ops.from("meeting_transcripts").select("id,source_system,source_file_name,meeting_started_at,summary,participants,decisions,commitments,ai_signals,created_at").eq("client_id", cid).order("meeting_started_at", { ascending: false, nullsFirst: false }).limit(6),
    ops.from("weekly_commercial_reports").select("id,week_start,week_end,commercial_leads,meta_leads,meta_cross_status,meta_difference,meta_difference_pct,confidence_level,metrics,context,internal_warning,source_summary,generated_at").eq("client_id", cid).order("week_end", { ascending: false }).limit(3),
    ops.from("client_notes").select("id,title,body,note_type,importance,is_pinned,created_by_person,created_at,updated_at").eq("client_id", cid).is("archived_at", null).or("sensitivity.is.null,sensitivity.eq.NORMAL").order("is_pinned", { ascending: false }).order("created_at", { ascending: false }).limit(8),
    ops.from("meta_campaign_inventory").select("meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,checked_at").eq("client_id", cid).order("checked_at", { ascending: false }).limit(80),
    ops.from("whatsapp_chat_registry").select("chat_id,chat_name,scope,confidence,last_seen_at,message_count,updated_at").eq("client_id", cid).order("last_seen_at", { ascending: false }).limit(5),
  ]);

  const failed = [healthQ, snapshotQ, metaQ, integrationsQ, workQ, clickupQ, clickupRecentQ, commitmentsQ, adjustmentsQ, meetingsQ, reportsQ, notesQ, campaignsQ, whatsappQ].find((q: any) => q.error);
  if (failed?.error) return reply({ error: "query_failed", detail: failed.error.message }, 500);

  const health = healthQ.data || null;
  const snapshot = snapshotQ.data || null;
  const meta = metaQ.data || null;
  const clickupLast = clickupRecentQ.data?.[0]?.last_synced_at || null;
  const waLast = whatsappQ.data?.[0]?.last_seen_at || null;
  const sourceScores: Row[] = [];
  sourceScores.push({ source: "Cadastro", score: 100, state: "GOOD", last_at: client.updated_at || null });
  if (snapshot) {
    const raw = Number(snapshot.confidence);
    const score = Number.isFinite(raw) ? clamp(raw <= 1 ? raw * 100 : raw) : recencyScore(snapshot.updated_at, 24, 72).score;
    sourceScores.push({ source: "Operação", score, state: score >= 80 ? "GOOD" : score >= 50 ? "STALE" : "MISSING", last_at: snapshot.updated_at || snapshot.snapshot_at || null });
  } else sourceScores.push({ source: "Operação", score: 0, state: "MISSING", last_at: null });
  const healthLast = latestDate(health?.external_source_updated_at, health?.internal_date);
  sourceScores.push({ source: "Saúde", ...recencyScore(healthLast, 72, 168) });
  if (Number(meta?.configured_accounts || 0) > 0) sourceScores.push({ source: "Meta", ...recencyScore(meta?.checked_at, 24, 72) });
  else sourceScores.push({ source: "Meta", score: null, state: "NA", last_at: meta?.checked_at || null });
  sourceScores.push({ source: "ClickUp", ...recencyScore(clickupLast, 24, 72) });
  sourceScores.push({ source: "WhatsApp", ...recencyScore(waLast, 24, 72) });
  const applicable = sourceScores.filter((s) => typeof s.score === "number");
  const overall = applicable.length ? clamp(applicable.reduce((a, s) => a + Number(s.score), 0) / applicable.length) : 0;

  return reply({
    ok: true,
    actor: { person, role },
    client,
    health,
    operational: snapshot,
    meta,
    integrations: integrationsQ.data || [],
    work_items: workQ.data || [],
    clickup_tasks: clickupQ.data || [],
    commitments: commitmentsQ.data || [],
    adjustments: adjustmentsQ.data || [],
    meetings: meetingsQ.data || [],
    weekly_reports: reportsQ.data || [],
    notes: notesQ.data || [],
    campaigns: campaignsQ.data || [],
    whatsapp: whatsappQ.data || [],
    data_confidence: { overall, sources: sourceScores },
    permissions: { safe_meta_actions: ["GT", "MGMT"].includes(role), all_clients: role === "MGMT" || elevated },
    generated_at: new Date().toISOString(),
  });
});
