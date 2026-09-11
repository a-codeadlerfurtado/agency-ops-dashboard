import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const hidden = () => reply({ error: "not_found" }, 404);
const clean = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

function weekBucket(date = new Date()) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy.toISOString().slice(0, 10);
}

async function identifyAdler(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anon || !service) return null;
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return null;
  const db = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userData.user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name);
  if (person !== "Adler Furtado" || !(approvals || []).length) return null;
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster || clean(roster.role).toUpperCase() !== "MGMT") return null;
  return { db, ops, person };
}

function latestMap(rows: Row[] | null | undefined, dateField: string) {
  const map = new Map<string, Row>();
  for (const row of rows || []) {
    const id = clean(row.client_id);
    if (!id) continue;
    const current = map.get(id);
    if (!current || new Date(row[dateField] || 0).getTime() > new Date(current[dateField] || 0).getTime()) map.set(id, row);
  }
  return map;
}
async function loadBoard(ctx: any) {
  const [clientsR, runsR, questionsR, slasR, eventsR, experimentsR, metaR, obligationsR, analysesR] = await Promise.all([
    ctx.ops.from("dashboard_client_overview").select("client_id,display_name,lifecycle,priority,gt_owner,cs_owner,next_step,entrada").in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name"),
    ctx.ops.from("diagnostic_runs").select("id,client_id,period_start,period_end,status,health_score,primary_bottleneck,confidence,scores,created_at,updated_at").order("created_at", { ascending: false }).limit(250),
    ctx.ops.from("diagnostic_questions").select("id,client_id,run_id,dedupe_key,question,why_it_matters,decision_impact,options,priority,status,target_person,target_role,answer_text,answered_by,answered_at,created_at").order("created_at", { ascending: false }).limit(300),
    ctx.ops.from("diagnostic_sla_results").select("id,client_id,metric_key,label,start_at,end_at,duration_minutes,target_minutes,status,owner_side,metadata,created_at").order("created_at", { ascending: false }).limit(300),
    ctx.ops.from("diagnostic_events").select("id,client_id,event_type,occurred_at,actor,actor_side,source,evidence_ref,payload,expected_at,completed_at,confidence").order("occurred_at", { ascending: false }).limit(250),
    ctx.ops.from("diagnostic_experiments").select("id,client_id,hypothesis,intervention,success_metric,status,started_at,evaluate_at,finished_at,result,created_at").order("created_at", { ascending: false }).limit(200),
    ctx.ops.from("meta_performance_snapshots").select("client_id,client_name,gt_owner,snapshot_date,period_days,date_from,date_to,spend,impressions,clicks,ctr,cpc,cpm,frequency,leads,cpl,campaign_count,active_campaigns,data_status,collected_at").order("snapshot_date", { ascending: false }).limit(600),
    ctx.ops.from("client_service_obligation_summary").select("client_id,open_obligations,agency_due,waiting_client,overdue_or_critical,needs_review,severity_rank,next_check_at,open_items").limit(250),
    ctx.ops.from("meta_gt_client_analyses").select("client_id,gt_person,evidence,diagnosis,hypothesis,decision,decision_reason,expected_result,risk_blocker,next_validation,lead_quality_rating,lead_quality_notes,updated_at,created_at").order("updated_at", { ascending: false }).limit(600),
  ]);
  const first = [clientsR, runsR, questionsR, slasR, eventsR, experimentsR, metaR, obligationsR, analysesR].find((item: any) => item.error)?.error;
  if (first) throw first;
  const clients = clientsR.data || [];
  const runs = runsR.data || [];
  const questions = questionsR.data || [];
  const slas = slasR.data || [];
  const events = eventsR.data || [];
  const experiments = experimentsR.data || [];
  const latestRun = latestMap(runs, "created_at");
  const latestMeta = latestMap(metaR.data || [], "snapshot_date");
  const latestAnalysis = latestMap(analysesR.data || [], "updated_at");
  const obligationMap = new Map((obligationsR.data || []).map((row: Row) => [clean(row.client_id), row]));
  const openQuestions = questions.filter((row: Row) => row.status === "OPEN");
  const accountRows = clients.map((client: Row) => {
    const id = clean(client.client_id);
    const obligations = obligationMap.get(id) || null;
    const meta = latestMeta.get(id) || null;
    const analysis = latestAnalysis.get(id) || null;
    const diagnostic = latestRun.get(id) || null;
    let live_signal = "Monitorado";
    let live_tone = "ok";
    if (number(obligations?.overdue_or_critical) > 0) { live_signal = `${number(obligations?.overdue_or_critical)} pendência(s) vencida(s)/crítica(s)`; live_tone = "danger"; }
    else if (clean(client.priority).toUpperCase() === "ATTENTION") { live_signal = "Conta em atenção operacional"; live_tone = "danger"; }
    else if (analysis?.risk_blocker) { live_signal = clean(analysis.risk_blocker); live_tone = "warn"; }
    else if (meta && number(meta.active_campaigns) === 0) { live_signal = "Sem campanha ativa no último snapshot"; live_tone = "warn"; }
    else if (!meta) { live_signal = "Sem snapshot Meta recente"; live_tone = "muted"; }
    return { ...client, latest_diagnostic: diagnostic, meta_snapshot: meta, obligations, latest_gt_analysis: analysis, live_signal, live_tone };
  });
  return {
    clients: accountRows,
    runs,
    questions,
    slas,
    events,
    experiments,
    summary: {
      clients: accountRows.length,
      diagnosed: accountRows.filter((row: Row) => row.latest_diagnostic).length,
      open_questions: openQuestions.length,
      critical_questions: openQuestions.filter((row: Row) => ["CRITICAL", "HIGH"].includes(clean(row.priority).toUpperCase())).length,
      sla_breaches: slas.filter((row: Row) => row.status === "BREACHED").length,
      sla_pending: slas.filter((row: Row) => row.status === "PENDING").length,
      experiments_running: experiments.filter((row: Row) => row.status === "RUNNING").length,
      accounts_attention: accountRows.filter((row: Row) => row.live_tone === "danger").length,
      accounts_with_meta: accountRows.filter((row: Row) => row.meta_snapshot).length,
      open_obligations: accountRows.reduce((sum: number, row: Row) => sum + number(row.obligations?.open_obligations), 0),
    },
    generated_at: new Date().toISOString(),
  };
}

async function answerQuestion(ctx: any, body: Row) {
  const id = clean(body.id);
  const answer = clean(body.answer_text);
  if (!id || !answer) return reply({ error: "question_and_answer_required" }, 400);
  const now = new Date().toISOString();
  const { data, error } = await ctx.ops.from("diagnostic_questions").update({
    status: "ANSWERED", answer_text: answer, structured_answer: body.structured_answer || {}, answered_by: ctx.person, answered_at: now, updated_at: now,
  }).eq("id", id).eq("status", "OPEN").select().maybeSingle();
  if (error) throw error;
  if (!data) return reply({ error: "question_not_open" }, 409);
  return reply({ ok: true, question: data });
}
async function dismissQuestion(ctx: any, body: Row) {
  const id = clean(body.id);
  if (!id) return reply({ error: "question_required" }, 400);
  const now = new Date().toISOString();
  const { error } = await ctx.ops.from("diagnostic_questions").update({
    status: "DISMISSED", answered_by: ctx.person, answered_at: now, updated_at: now,
  }).eq("id", id).eq("status", "OPEN");
  if (error) throw error;
  return reply({ ok: true });
}

async function createQuestion(ctx: any, body: Row) {
  const question = clean(body.question);
  if (!question) return reply({ error: "question_required" }, 400);
  const payload = {
    client_id: clean(body.client_id) || null,
    run_id: clean(body.run_id) || null,
    dedupe_key: clean(body.dedupe_key) || null,
    question,
    why_it_matters: clean(body.why_it_matters) || null,
    decision_impact: clean(body.decision_impact) || null,
    options: Array.isArray(body.options) ? body.options : [],
    priority: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(clean(body.priority).toUpperCase()) ? clean(body.priority).toUpperCase() : "MEDIUM",
    target_person: clean(body.target_person) || "Adler Furtado",
    target_role: clean(body.target_role) || "MGMT",
    source_gap: body.source_gap && typeof body.source_gap === "object" ? body.source_gap : {},
  };
  const { data, error } = await ctx.ops.from("diagnostic_questions").insert(payload).select().single();
  if (error) throw error;
  return reply({ ok: true, question: data }, 201);
}
async function scanQuestions(ctx: any) {
  const board = await loadBoard(ctx);
  const bucket = weekBucket();
  const existing = new Set((board.questions || []).map((row: Row) => clean(row.dedupe_key)).filter(Boolean));
  const candidates: Row[] = [];
  const usedClients = new Set<string>();
  const sorted = [...(board.clients || [])].sort((a: Row, b: Row) => {
    const rank = (row: Row) => row.live_tone === "danger" ? 0 : row.live_tone === "warn" ? 1 : 2;
    return rank(a) - rank(b);
  });
  const push = (row: Row, rule: string, payload: Row) => {
    const clientId = clean(row.client_id);
    const dedupe = `auto:${rule}:${clientId}:${bucket}`;
    if (!clientId || usedClients.has(clientId) || existing.has(dedupe) || candidates.length >= 5) return;
    usedClients.add(clientId);
    candidates.push({ client_id: clientId, dedupe_key: dedupe, target_person: "Adler Furtado", target_role: "MGMT", status: "OPEN", ...payload });
  };

  for (const row of sorted) {
    if (candidates.length >= 5) break;
    if (number(row.obligations?.needs_review) > 0) {
      push(row, "obligation-context", {
        priority: "HIGH",
        question: `Em ${clean(row.display_name)}, há ${number(row.obligations.needs_review)} pendência(s) que o sistema não consegue fechar sozinho. Existe contexto fora dos sistemas que mude quem está com a bola ou o que deveria acontecer agora?`,
        why_it_matters: "Sem esse contexto, o motor pode atribuir o bloqueio à parte errada.",
        decision_impact: "Pode alterar responsabilidade, SLA e próxima ação da conta.",
        options: ["Dependência do cliente", "Pendência da agência", "Responsabilidade compartilhada", "Não sei / precisa apurar"],
        source_gap: { rule: "obligation_context", needs_review: number(row.obligations.needs_review) },
      });
      continue;
    }
    const analysisAt = row.latest_gt_analysis?.updated_at ? new Date(row.latest_gt_analysis.updated_at).getTime() : 0;
    const staleAnalysis = !analysisAt || Date.now() - analysisAt > 7 * 24 * 60 * 60 * 1000;
    if (clean(row.priority).toUpperCase() === "ATTENTION" && staleAnalysis) {
      push(row, "attention-context", {
        priority: "HIGH",
        question: `${clean(row.display_name)} está em atenção e não há uma análise recente suficiente para fechar a causa. Existe algum contexto estratégico, comercial ou operacional fora dos sistemas que eu deveria considerar?`,
        why_it_matters: "A conta está sinalizada, mas o motor ainda não consegue distinguir mídia, criativo, operação, comercial ou dependência externa.",
        decision_impact: "Define o principal gargalo e evita uma ação errada sobre a campanha.",
        options: ["Mídia/criativo", "Operação da agência", "Dependência do cliente", "Comercial/atendimento", "Não sei / falta apurar"],
        source_gap: { rule: "attention_context", priority: row.priority, last_analysis_at: row.latest_gt_analysis?.updated_at || null },
      });
      continue;
    }
    const meta = row.meta_snapshot || {};
    const noLeadSpend = number(meta.spend) >= 100 && number(meta.leads) === 0;
    const noHypothesis = !clean(row.latest_gt_analysis?.hypothesis) && !clean(row.latest_gt_analysis?.diagnosis);
    if (noLeadSpend && noHypothesis) {
      push(row, "spend-no-leads", {
        priority: "MEDIUM",
        question: `${clean(row.display_name)} investiu R$ ${number(meta.spend).toFixed(2).replace(".", ",")} no último snapshot e não registrou leads. Existe algum fato fora do Meta que explique esse resultado antes de eu classificar o gargalo?`,
        why_it_matters: "Zero lead com gasto relevante pode vir de mídia, criativo, tracking, destino ou contexto comercial; o Meta sozinho não prova a causa.",
        decision_impact: "Pode mudar completamente o próximo teste e impedir uma conclusão causal fraca.",
        options: ["Problema de mídia/criativo", "Tracking/destino", "Produto/oferta", "Há contexto externo", "Não sei"],
        source_gap: { rule: "spend_no_leads", spend: number(meta.spend), leads: number(meta.leads), period_days: number(meta.period_days) },
      });
    }
  }

  if (!candidates.length) return reply({ ok: true, created: 0, questions: [] });
  const { data, error } = await ctx.ops.from("diagnostic_questions").upsert(candidates, { onConflict: "dedupe_key", ignoreDuplicates: true }).select();
  if (error) throw error;
  return reply({ ok: true, created: (data || []).length, questions: data || [] });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return hidden();
  try {
    const ctx = await identifyAdler(req);
    if (!ctx) return hidden();
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("probe") === "1") return reply({ ok: true, can_view_diagnostics: true });
      return reply({ ok: true, ...(await loadBoard(ctx)) });
    }
    const body = await req.json().catch(() => ({}));
    const action = clean(body?.action).toLowerCase();
    if (action === "answer_question") return await answerQuestion(ctx, body);
    if (action === "dismiss_question") return await dismissQuestion(ctx, body);
    if (action === "create_question") return await createQuestion(ctx, body);
    if (action === "scan_questions") return await scanQuestions(ctx);
    return reply({ error: "unknown_action" }, 400);
  } catch (error) {
    console.error("[diagnostics-api]", error);
    return reply({ error: "diagnostics_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
