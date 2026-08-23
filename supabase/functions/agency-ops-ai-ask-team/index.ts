import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const DIRECT_AI_TIMEOUT_MS = 55_000;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function safeAnswer(body: any, raw: string): string | null {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  if (!body && raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function directDbAnswer(ops: any, role: string, person: string, question: string): Promise<{ answer: string; source: string } | null> {
  const q = norm(question);

  const asksOnboarding = q.includes("onboarding") && /\b(qual|quais|quem|lista|listar|estao|cliente|clientes|quantos|quantas)\b/.test(q);
  if (asksOnboarding) {
    let query = ops.from("clients")
      .select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner")
      .eq("lifecycle", "ONBOARDING")
      .order("display_name");

    if (role === "GT") query = query.eq("gt_owner", person);
    if (role === "DESIGN") query = query.eq("designer_owner", person);

    const { data, error } = await query;
    if (error) throw new Error(`direct_db_onboarding:${error.message}`);
    const rows = data ?? [];

    if (!rows.length) {
      return {
        answer: role === "GT"
          ? `Não há clientes em onboarding atribuídos à carteira de ${person} neste momento.`
          : "Não há clientes em onboarding neste momento.",
        source: "DIRECT_DB_TEAM",
      };
    }

    const lines = rows.map((row: any) => {
      const gt = row.gt_owner ? ` — GT: ${row.gt_owner}` : " — GT ainda não definido";
      return `• ${row.display_name}${gt}`;
    });

    return {
      answer: `Há ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} em onboarding:\n${lines.join("\n")}`,
      source: "DIRECT_DB_TEAM",
    };
  }

  const asksActiveCount = /\b(quantos|quantas|total)\b/.test(q)
    && /\b(cliente|clientes)\b/.test(q)
    && /\b(ativo|ativos|operacao)\b/.test(q);

  if (asksActiveCount) {
    let query = ops.from("clients").select("id", { count: "exact", head: true }).eq("lifecycle", "ACTIVE");
    if (role === "GT") query = query.eq("gt_owner", person);
    if (role === "DESIGN") query = query.eq("designer_owner", person);
    const { count, error } = await query;
    if (error) throw new Error(`direct_db_active_count:${error.message}`);
    const total = count ?? 0;
    return {
      answer: role === "GT"
        ? `${person} tem ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"} na carteira.`
        : `Há ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"} na operação.`,
      source: "DIRECT_DB_TEAM",
    };
  }

  return null;
}

async function cloudflareFallback(authHeader: string, question: string): Promise<string> {
  let conversationId = "";

  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!response.ok || !parsed?.ok) {
      const detail = parsed?.detail || parsed?.error || raw || `http_${response.status}`;
      throw new Error(`cloudflare_${path.replaceAll("/", "_")}_${response.status}:${String(detail).slice(0, 260)}`);
    }
    return parsed;
  }

  try {
    const created = await post("/conversations/create", {
      client_id: null,
      title: "OpsQuestion · fallback",
    });
    conversationId = String(created?.conversation?.id || "");
    if (!conversationId) throw new Error("cloudflare_conversation_missing");

    const result = await post("/chat", {
      conversation_id: conversationId,
      message: question,
    });
    const answer = safeAnswer({ answer: result?.assistant_message?.content }, "");
    if (!answer) throw new Error("cloudflare_empty_ai_answer");
    return answer;
  } finally {
    if (conversationId) {
      try {
        await post("/conversations/delete", { conversation_id: conversationId });
      } catch {
        // Falha de limpeza não pode derrubar uma resposta válida do OpsQuestion.
      }
    }
  }
}

Deno.serve(async (req: Request) => {
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

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);

  const person = pref?.collaborator_person ?? null;
  if (!person || !(approvals ?? []).length) {
    return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  }

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return reply({ ok: false, error: "OpsQuestion indisponível: colaborador não está ativo." }, 403);

  const role = String(roster.role ?? "");
  const accessLevel = String(roster.access_level ?? "RESTRICTED");
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

  let scopeLabel = "COMPANY_READ_ONLY";
  let scopeInstruction = "Pode consultar a base operacional da empresa em modo somente leitura.";
  let scopedClients: Array<{ id: string; display_name: string }> = [];

  if (role === "GT") {
    scopeLabel = "GT_PORTFOLIO_READ_ONLY";
    scopeInstruction = `O usuário é GT. Responda SOMENTE sobre clientes cuja coluna gt_owner seja exatamente ${person}. Nunca revele dados de clientes de outra carteira.`;
    const { data } = await ops.from("clients")
      .select("id,display_name")
      .eq("gt_owner", person)
      .in("lifecycle", ["ACTIVE", "ONBOARDING"])
      .order("display_name");
    scopedClients = (data ?? []).map((row: any) => ({ id: String(row.id), display_name: String(row.display_name) }));
  } else if (role === "DESIGN") {
    scopeLabel = "DESIGN_SELF_READ_ONLY";
    scopeInstruction = `O usuário é designer. Priorize somente produtividade própria, TaskLog, Diário e trabalho de design associado ao próprio usuário ${person}. Não revele saúde, WhatsApp, financeiro, carteira ou dados operacionais de clientes que não sejam necessários ao trabalho de design do usuário.`;
  } else if (role === "CS") {
    scopeLabel = "CS_SHARED_BASE_READ_ONLY";
    scopeInstruction = "O usuário é CS. Os CS atendem a mesma base de clientes; pode consultar a base compartilhada em modo somente leitura.";
  } else if (role === "MGMT" || role === "AI") {
    scopeLabel = "FULL_READ_ONLY";
    scopeInstruction = "O usuário possui visão operacional ampla. Pode consultar a base da empresa em modo somente leitura.";
  }

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const direct = await directDbAnswer(ops, role, String(person), question);
    if (direct) {
      const latency = Date.now() - started;
      await ops.from("opsquestion_interactions").insert({
        user_key: user.id,
        person,
        role,
        access_level: accessLevel,
        question,
        status: "SUCCESS",
        source: direct.source,
        answer: direct.answer.slice(0, 20000),
        request_id: requestId,
        latency_ms: latency,
        answered_at: new Date().toISOString(),
      });
      return reply({
        ok: true,
        name: "OpsQuestion",
        answer: direct.answer,
        source: "agency_ops · consulta direta",
        read_only: true,
        mode: direct.source,
        scope: scopeLabel,
        request_id: requestId,
        latency_ms: latency,
        generated_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("[opsquestion-direct-db]", errorText(err));
  }

  const [{ data: endpointCfg }, { data: webhookCfg }, { data: secretCfg }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "MAKE_AI_ASK_WEBHOOK_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);

  const directUrl = typeof endpointCfg?.value === "string" ? endpointCfg.value : null;
  const makeUrl = typeof webhookCfg?.value === "string" ? webhookCfg.value : null;
  const webhookUrl = directUrl ?? makeUrl;
  const readSecret = typeof secretCfg?.value === "string" ? secretCfg.value : null;

  let routeMode = directUrl ? "DIRECT_AI_TEAM" : makeUrl ? "MAKE_AI_TEAM" : "CLOUDFLARE_AI_FALLBACK";

  await ops.from("opsquestion_interactions").insert({
    user_key: user.id,
    person,
    role,
    access_level: accessLevel,
    question,
    status: "PENDING",
    source: routeMode,
    request_id: requestId,
  });

  const allowedClientsText = role === "GT"
    ? `Clientes permitidos nesta carteira: ${scopedClients.length ? scopedClients.map((c) => `${c.display_name} [${c.id}]`).join("; ") : "nenhum cliente ativo/onboarding encontrado"}.`
    : "";

  const prompt = [
    "Você é o OpsQuestion, copiloto operacional da Leonardo Imobi.",
    "Responda em português do Brasil usando SOMENTE dados encontrados no schema agency_ops.",
    "A consulta é SOMENTE LEITURA. Nunca execute ou proponha INSERT, UPDATE, DELETE, DDL ou qualquer alteração de dados.",
    "Nunca invente fatos, números, responsáveis, status, datas ou evidências.",
    "Se não houver evidência suficiente, diga claramente que não encontrou evidência suficiente.",
    `Usuário autenticado: ${person} (${role}).`,
    `ESCOPO OBRIGATÓRIO: ${scopeInstruction}`,
    allowedClientsText,
    `Pergunta: ${question}`,
  ].filter(Boolean).join("\n\n");

  let answer: string | null = null;
  let primaryError: string | null = null;
  let fallbackError: string | null = null;

  if (webhookUrl && readSecret) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECT_AI_TIMEOUT_MS);
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ai-read-secret": readSecret },
        body: JSON.stringify({
          question: prompt,
          original_question: question,
          source: "OpsQuestion",
          request_id: requestId,
          user: { person, role, access_level: accessLevel, scope: scopeLabel, allowed_clients: scopedClients },
          constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true },
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      answer = response.ok ? safeAnswer(parsed, raw) : null;
      if (!response.ok) primaryError = `http_${response.status}`;
      else if (!answer) primaryError = "empty_ai_answer";
    } catch (err) {
      primaryError = err instanceof DOMException && err.name === "AbortError"
        ? "direct_ai_timeout"
        : errorText(err);
    } finally {
      clearTimeout(timeout);
    }
  } else if (webhookUrl && !readSecret) {
    primaryError = "missing_ai_read_secret";
  } else {
    primaryError = "direct_ai_not_configured";
  }

  if (!answer) {
    try {
      answer = await cloudflareFallback(authHeader, question);
      routeMode = "CLOUDFLARE_AI_FALLBACK";
    } catch (err) {
      fallbackError = errorText(err);
    }
  }

  const latency = Date.now() - started;
  if (!answer) {
    const error = [primaryError, fallbackError].filter(Boolean).join(" | ").slice(0, 500) || "ai_unavailable";
    await ops.from("opsquestion_interactions").update({
      status: "ERROR",
      error,
      latency_ms: latency,
      answered_at: new Date().toISOString(),
    }).eq("request_id", requestId);
    return reply({
      ok: false,
      error: "Falha temporária no OpsQuestion.",
      detail: error,
      request_id: requestId,
    }, 502);
  }

  await ops.from("opsquestion_interactions").update({
    status: "SUCCESS",
    source: routeMode,
    answer: answer.slice(0, 20000),
    error: primaryError && routeMode === "CLOUDFLARE_AI_FALLBACK" ? `primary_failed:${primaryError}`.slice(0, 500) : null,
    latency_ms: latency,
    answered_at: new Date().toISOString(),
  }).eq("request_id", requestId);

  return reply({
    ok: true,
    name: "OpsQuestion",
    answer,
    source: routeMode === "CLOUDFLARE_AI_FALLBACK"
      ? "agency_ops via Cloudflare Workers AI · fallback automático"
      : "agency_ops via IA · escopo do perfil",
    read_only: true,
    mode: routeMode,
    scope: scopeLabel,
    request_id: requestId,
    latency_ms: latency,
    generated_at: new Date().toISOString(),
  });
});
