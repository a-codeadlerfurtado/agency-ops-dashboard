import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const SOURCE_GUIDE = `FONTES PREFERENCIAIS NO SCHEMA agency_ops:
- Carteira atual, lifecycle, GT/CS, próxima ação e visão geral: dashboard_client_overview, clients, client_operational_snapshot, client_operational_status.
- Onboarding: dashboard_client_overview, onboarding_cases, onboarding_stages.
- Campanhas/Meta Ads: campaign_client_latest, campaign_latest_details, meta_campaign_insights, meta_campaign_inventory, client_integrations.
- Saúde, risco e churn: client_health_scores, client_health_attention_queue, client_health_crosscheck, client_health_timeline, client_health_trends, complaint_events, client_churn_log, client_lifecycle_events.
- WhatsApp e atendimento: conversation_state, whatsapp_messages, whatsapp_daily_group_status, whatsapp_group_registry.
- Compromissos e pendências: commitments, operational_alerts.
- Reuniões Donnah/Google Meet: meeting_transcripts, meeting_transcript_actions, donnah_ingestion_overview, donnah_transcript_health.
- ClickUp e produtividade: clickup_tasks, clickup_productivity_daily, clickup_productivity_30d, task_log_entries.
- Serviços e IA dos clientes: client_service_overview, client_services, client_ai_evidence, client_ai_overrides, ai_source_registry, ai_source_discovery.
- Formulários e materiais: form_responses, client_raw_material_uploads, client_raw_material_uploads_summary.
- CRM e pré-clientes: crm_preclients.
- Saúde das integrações: integration_health_overview.
- Carteira/retention: portfolio_live, portfolio_client_status, portfolio_gt_retention.
Se uma fonte não trouxer o dado, consulte as fontes adjacentes acima. Não conclua pela ausência numa única tabela.`;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function safeAnswer(body: any, raw: string): string | null {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (!body && raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ ok: false, error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", user.id)
    .maybeSingle();

  const person = pref?.collaborator_person ?? null;
  let role: string | null = null;
  let accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops.from("team_roster")
      .select("role,access_level")
      .eq("person", person)
      .eq("is_former", false)
      .maybeSingle();
    role = roster?.role ?? null;
    accessLevel = roster?.access_level ?? "RESTRICTED";
  }

  const { data: approvals } = await ops.from("access_requests")
    .select("kind,status")
    .eq("user_key", user.id)
    .eq("status", "APPROVED");
  const approved = approvals ?? [];
  const accountApproved = approved.some((r: any) => r.kind === "SIGNUP");
  const elevated = accessLevel === "RESTRICTED" && approved.some((r: any) => r.kind === "ELEVATION");
  const isFull = accessLevel === "FULL" || elevated;

  if (!accountApproved || !person) return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  if (!isFull) return reply({ ok: false, error: "OpsQuestion está liberado somente para perfis de gestão/acesso total por enquanto." }, 403);

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return reply({ ok: false, error: "missing_question" }, 400);
  if (question.length > 2500) return reply({ ok: false, error: "question_too_long", max_chars: 2500 }, 400);

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount } = await ops.from("opsquestion_interactions")
    .select("id", { count: "exact", head: true })
    .eq("user_key", user.id)
    .gte("created_at", since);
  if ((recentCount ?? 0) >= 12) return reply({ ok: false, error: "Muitas perguntas em sequência. Aguarde alguns segundos." }, 429);

  const requestId = crypto.randomUUID();
  const started = Date.now();
  await ops.from("opsquestion_interactions").insert({
    user_key: user.id,
    person,
    role,
    access_level: accessLevel,
    question,
    status: "PENDING",
    source: "MAKE_AI",
    request_id: requestId,
  });

  const [{ data: webhookCfg }, { data: secretCfg }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "MAKE_AI_ASK_WEBHOOK_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);
  const webhookUrl = typeof webhookCfg?.value === "string" ? webhookCfg.value : null;
  const readSecret = typeof secretCfg?.value === "string" ? secretCfg.value : null;
  if (!webhookUrl || !readSecret) {
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error: "missing_ai_configuration", latency_ms: latency }).eq("request_id", requestId);
    return reply({ ok: false, error: "OpsQuestion não está configurado no backend." }, 503);
  }

  const prompt = [
    "Você é o OpsQuestion, copiloto operacional da Leonardo Imobi.",
    "Responda em português do Brasil usando SOMENTE dados encontrados no banco agency_ops.",
    "Nunca invente fatos, números, responsáveis, status, datas ou evidências.",
    "Se os dados não forem suficientes, diga claramente que não encontrou evidência suficiente.",
    "A conexão de banco usada por você é SOMENTE LEITURA; não proponha nem execute INSERT, UPDATE, DELETE, DDL ou alterações.",
    "Quando a pergunta disser 'clientes atuais', considere ACTIVE + ONBOARDING. Quando disser apenas 'ativos', respeite literalmente ACTIVE, salvo se o contexto pedir carteira atual.",
    "Sempre prefira a fonte operacional mais recente disponível e confira mais de uma fonte quando houver risco de ambiguidade.",
    SOURCE_GUIDE,
    `Usuário: ${person}${role ? ` (${role})` : ""}.`,
    `Pergunta do usuário: ${question}`,
  ].join("\n\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": readSecret },
      body: JSON.stringify({
        question: prompt,
        original_question: question,
        source: "OpsQuestion",
        request_id: requestId,
        user: { person, role, access_level: accessLevel, scope: "FULL" },
        constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    const answer = safeAnswer(parsed, raw);
    const latency = Date.now() - started;

    if (!response.ok || !answer) {
      const error = !response.ok ? `make_http_${response.status}` : "empty_ai_answer";
      await ops.from("opsquestion_interactions").update({ status: "ERROR", error, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
      return reply({ ok: false, error: "Falha temporária no OpsQuestion.", detail: error, request_id: requestId }, 502);
    }

    await ops.from("opsquestion_interactions").update({
      status: "SUCCESS",
      answer: answer.slice(0, 20000),
      latency_ms: latency,
      answered_at: new Date().toISOString(),
    }).eq("request_id", requestId);

    return reply({
      ok: true,
      name: "OpsQuestion",
      answer,
      source: "agency_ops via Make/IA",
      read_only: true,
      request_id: requestId,
      latency_ms: latency,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    clearTimeout(timeout);
    const latency = Date.now() - started;
    const message = error instanceof DOMException && error.name === "AbortError" ? "ai_timeout" : String(error instanceof Error ? error.message : error).slice(0, 500);
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error: message, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
    return reply({ ok: false, error: message === "ai_timeout" ? "OpsQuestion demorou demais para responder. Tente novamente." : "Falha temporária no OpsQuestion.", request_id: requestId }, message === "ai_timeout" ? 504 : 502);
  }
});
