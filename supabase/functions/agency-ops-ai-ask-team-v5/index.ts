import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const CREATE_TIMEOUT_MS = 5_000;
const CHAT_TIMEOUT_MS = 38_000;
const CLEANUP_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 20 * 60_000;
const STALE_PENDING_MS = 2 * 60_000;

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const clip = (value: unknown, max = 240) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function timedPost(url: string, authorization: string, body: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || !parsed?.ok) {
      throw new Error(String(parsed?.detail || parsed?.error || `HTTP ${response.status}`));
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function contextHints(question: string) {
  const q = norm(question);
  const hints = new Set<string>();
  if (/\b(causa|causou|antes|depois|mudou|piorou|melhorou|sequencia|historico|deterior|tendencia|evolucao|ultimos dias|semana a semana)\b/.test(q)) {
    ["historico", "whatsapp", "saude", "tarefas", "comercial", "meta"].forEach((v) => hints.add(v));
  }
  if (/\b(promessa|promessas|compromisso|compromissos|prometeu|cobrou|cobranca|retorno|resposta|responder|atendimento)\b/.test(q)) {
    ["tarefas", "whatsapp", "saude"].forEach((v) => hints.add(v));
  }
  if (/\b(venda|vendas|vendeu|vendido|corretor|corretores|visita|visitas|proposta|propostas|funil|comercial|lead|leads)\b/.test(q)) {
    ["vendas", "comercial", "meta", "whatsapp"].forEach((v) => hints.add(v));
  }
  if (/\b(meta|campanha|campanhas|cpl|cpc|ctr|cpm|frequencia|orcamento|criativo|publico|trafego|spend|investimento)\b/.test(q)) {
    ["meta", "campanhas"].forEach((v) => hints.add(v));
  }
  if (/\b(onboarding|integracao|reuniao|material|sla|campanha no ar)\b/.test(q)) hints.add("onboarding");
  if (/\b(criativo|criativos|design|designer|ajuste|ajustes|retrabalho|logo|layout|arte)\b/.test(q)) hints.add("criativos");
  if (/\b(equipe|gt|cs|designer|colaborador|produtividade|carga|gargalo|responsavel|responsabilidade)\b/.test(q)) hints.add("tarefas");
  if (/\b(risco|churn|saudavel|insatisfeito|reclamacao|reclamacoes|prioridade|preocupante|problema)\b/.test(q)) hints.add("saude");
  return [...hints].join(" ");
}

function buildPrompt(question: string) {
  const hints = contextHints(question);
  return [
    `PERGUNTA DO ADLER: ${question}`,
    hints ? `CONTEXTO A PRIORIZAR NESTA ANÁLISE: ${hints}.` : "Use as fontes operacionais relevantes para a pergunta.",
    "Responda como copiloto operacional da Leonardo Imobi. Entregue a conclusão, não narre o processo de busca.",
    "Cruze as fontes que estiverem disponíveis. Ausência em uma fonte não prova que o fato não aconteceu.",
    "Diferencie claramente fato confirmado, indício forte e hipótese quando houver inferência.",
    "Em causalidade, sequência temporal é indício e não prova de causa. Não invente causalidade.",
    "Venda confirmada não significa venda originada pelo tráfego sem evidência de origem.",
    "Não transforme menções genéricas ou comemorações repetidas em múltiplas vendas.",
    "Quando houver conflito entre fontes, mostre a divergência e diga qual fonte é mais confiável para aquela afirmação.",
    "Se faltar dado, responda com o que é possível concluir e diga exatamente qual dado falta.",
    "Para perguntas de decisão, risco, gargalo ou diagnóstico, termine obrigatoriamente com a seção 'Próximos passos' e até 3 itens numerados, cada item começando pela área responsável (GT, CS, Design ou Operações) e descrevendo uma ação concreta.",
    "Finalize com o nível de confiança quando a conclusão não for totalmente factual.",
  ].join("\n\n");
}

function resolveNamed(question: string, rows: any[], field: string) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const row of rows) {
    const value = norm(row?.[field]);
    if (!value || value.length < 3) continue;
    let current = q.includes(` ${value} `) ? 1000 + value.length : 0;
    if (!current) {
      const parts = value.split(" ").filter((part) => part.length >= 4);
      current = parts.filter((part) => q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
    }
    if (current > score) { best = row; score = current; }
  }
  return score >= 4 ? best : null;
}

function actionLines(answer: string) {
  const rawLower = answer.toLowerCase();
  const markers = ["próximos passos", "proximos passos", "ações prioritárias", "acoes prioritarias", "3 ações prioritárias", "3 acoes prioritarias"];
  const marker = markers.reduce((best, item) => Math.max(best, rawLower.lastIndexOf(item)), -1);
  if (marker < 0) return [];
  const section = answer.slice(marker);
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = lines.filter((line) => /^(?:\d{1,2}[.)]|[-•])\s+/.test(line));
  const source = numbered.length ? numbered : lines.slice(1, 4);
  return source.slice(0, 3)
    .map((line) => line.replace(/^(?:\d{1,2}[.)]|[-•])\s+/, "").trim())
    .filter((line) => line.length >= 8);
}

function inferRole(text: string) {
  const q = norm(text);
  if (/^(operacoes|operacao|adler|gestao|management)\b/.test(q)) return "MGMT";
  if (/^(designer|design)\b/.test(q)) return "DESIGN";
  if (/^(cs|customer success|atendimento|relacionamento)\b/.test(q)) return "CS";
  if (/^(gt|gestor de trafego|trafego)\b/.test(q)) return "GT";
  if (/\b(operacoes|operacao|adler|gestao|management)\b/.test(q)) return "MGMT";
  if (/\b(designer|design|criativo|criativos)\b/.test(q)) return "DESIGN";
  if (/\b(cs|customer success|atendimento|relacionamento)\b/.test(q)) return "CS";
  if (/\b(gt|gestor de trafego|trafego|campanha|meta ads|meta)\b/.test(q)) return "GT";
  return "MGMT";
}

function inferPriority(text: string) {
  const q = norm(text);
  if (/\b(critico|critica|imediato|imediata|agora|urgente|risco alto|churn)\b/.test(q)) return "CRITICAL";
  if (/\b(alta|alto|prioridade|hoje|sla vencido|atrasado)\b/.test(q)) return "HIGH";
  if (/\b(baixa|baixo|quando possivel|sem urgencia)\b/.test(q)) return "LOW";
  return "MEDIUM";
}

function inferType(text: string) {
  const q = norm(text);
  if (/\b(criativo|criativos|design|logo|layout|arte)\b/.test(q)) return "CREATIVE_REQUEST";
  if (/\b(integracao|api|z api|zapi|erro tecnico|webhook|falha tecnica|sincronizacao)\b/.test(q)) return "TECHNICAL";
  if (/\b(responder|follow up|cobrar|retorno|contato)\b/.test(q)) return "CLIENT_FOLLOWUP";
  if (/\b(clickup|task|tarefa)\b/.test(q)) return "CLICKUP";
  if (/\b(escalar|escalonar|escalacao)\b/.test(q)) return "ESCALATION";
  return "GENERAL";
}

function buildActions(answer: string, requestId: string, questionClient: any, permitted: any[], roster: any[]) {
  const baseClient = questionClient || resolveNamed(answer, permitted, "display_name");
  return actionLines(answer).map((text, index) => {
    const client = baseClient || resolveNamed(text, permitted, "display_name");
    const role = inferRole(text);
    let targetPerson: string | null = null;
    if (client && role === "CS") targetPerson = client.cs_owner || null;
    else if (client && role === "DESIGN") targetPerson = client.designer_owner || null;
    else if (role !== "GT") {
      const named = resolveNamed(text, roster ?? [], "person");
      if (named && named.role === role) targetPerson = named.person;
    }
    return {
      id: `${requestId}:${index + 1}`,
      title: clip(text, 220),
      description: text,
      client_id: client?.id ?? null,
      client_name: client?.display_name ?? null,
      target_role: role,
      target_person: targetPerson,
      priority: inferPriority(text),
      type: inferType(text),
      create_clickup: /\b(clickup|task|tarefa)\b/.test(norm(text)),
      source: "opsquestion_v5",
      source_id: requestId,
    };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ ok: false, error: "method_not_allowed" }, 405);

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ ok: false, error: "server_configuration" }, 500);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return respond({ ok: false, error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return respond({ ok: false, error: "question_required" }, 400);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user) return respond({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: roster }, { data: clients }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,access_level,is_former").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).limit(600),
  ]);

  const person = pref?.collaborator_person ?? null;
  const me = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !me) return respond({ ok: false, error: "collaborator_required" }, 403);

  const permitted = me.role === "GT"
    ? (clients ?? []).filter((client: any) => client.gt_owner === person && ["ACTIVE", "ONBOARDING"].includes(client.lifecycle))
    : me.role === "DESIGN"
      ? (clients ?? []).filter((client: any) => client.designer_owner === person && ["ACTIVE", "ONBOARDING"].includes(client.lifecycle))
      : (clients ?? []);
  const questionClient = resolveNamed(question, permitted, "display_name");
  const requestId = crypto.randomUUID();

  const staleBefore = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  await ops.from("opsquestion_interactions").update({
    status: "ERROR",
    error: "stale_pending_reaped",
    answered_at: new Date().toISOString(),
  }).eq("user_key", userData.user.id).eq("status", "PENDING").lt("created_at", staleBefore);

  const cacheSince = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data: recentSuccess } = await ops.from("opsquestion_interactions")
    .select("question,answer,request_id,created_at")
    .eq("user_key", userData.user.id)
    .eq("status", "SUCCESS")
    .not("answer", "is", null)
    .gte("created_at", cacheSince)
    .order("created_at", { ascending: false })
    .limit(30);
  const cached = (recentSuccess ?? []).find((row: any) => norm(row.question) === norm(question) && String(row.answer || "").trim());
  if (cached) {
    const answer = String(cached.answer).trim();
    const actions = buildActions(answer, requestId, questionClient, permitted, roster ?? []);
    const latency = Date.now() - startedAt;
    await ops.from("opsquestion_interactions").insert({
      user_key: userData.user.id,
      person,
      role: me.role,
      access_level: me.access_level ?? null,
      question,
      answer: answer.slice(0, 30000),
      status: "SUCCESS",
      source: "OPSQUESTION_CACHE_V5",
      latency_ms: latency,
      request_id: requestId,
      answered_at: new Date().toISOString(),
    });
    return respond({
      ok: true,
      answer,
      source: "Cache operacional recente",
      latency_ms: latency,
      request_id: requestId,
      client: questionClient?.display_name ?? resolveNamed(answer, permitted, "display_name")?.display_name ?? null,
      suggested_actions: actions,
      cached: true,
      cached_from: cached.created_at,
    });
  }

  const { data: interaction } = await ops.from("opsquestion_interactions").insert({
    user_key: userData.user.id,
    person,
    role: me.role,
    access_level: me.access_level ?? null,
    question,
    status: "PENDING",
    source: "CLOUDFLARE_WORKERS_AI_FAST_V5",
    request_id: requestId,
  }).select("id").maybeSingle();

  let conversationId = "";
  try {
    const created = await timedPost(`${CLOUDFLARE_AI_BASE}/conversations/create`, authorization, {
      client_id: questionClient?.id ?? null,
      title: `OpsQuestion · ${question.slice(0, 72)}`,
    }, CREATE_TIMEOUT_MS);
    conversationId = String(created?.conversation?.id || "");
    if (!conversationId) throw new Error("conversation_missing");

    const completion = await timedPost(`${CLOUDFLARE_AI_BASE}/chat`, authorization, {
      conversation_id: conversationId,
      message: buildPrompt(question),
      ops_fast: true,
    }, CHAT_TIMEOUT_MS);

    const answer = String(completion?.assistant_message?.content || "").trim();
    if (!answer) throw new Error("empty_answer");

    const actions = buildActions(answer, requestId, questionClient, permitted, roster ?? []);
    const latency = Date.now() - startedAt;
    if (interaction?.id) {
      await ops.from("opsquestion_interactions").update({
        answer: answer.slice(0, 30000),
        status: "SUCCESS",
        source: "CLOUDFLARE_WORKERS_AI_FAST_V5",
        latency_ms: latency,
        answered_at: new Date().toISOString(),
      }).eq("id", interaction.id);
    }

    return respond({
      ok: true,
      answer,
      source: "Workers AI rápido · base operacional",
      latency_ms: latency,
      request_id: requestId,
      client: questionClient?.display_name ?? resolveNamed(answer, permitted, "display_name")?.display_name ?? null,
      suggested_actions: actions,
      model: completion?.model ?? null,
      timing: completion?.timing ?? null,
    });
  } catch (error) {
    const latency = Date.now() - startedAt;
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    const detail = timedOut ? "advanced_query_timeout" : clip(error instanceof Error ? error.message : error, 500);
    if (interaction?.id) {
      await ops.from("opsquestion_interactions").update({
        status: "ERROR",
        source: "CLOUDFLARE_WORKERS_AI_FAST_V5",
        latency_ms: latency,
        error: detail,
        answered_at: new Date().toISOString(),
      }).eq("id", interaction.id);
    }
    return respond({
      ok: false,
      error: timedOut ? "Essa análise excedeu o limite seguro de tempo. Tente novamente; o OpsQuestion não ficará preso indefinidamente." : "OpsQuestion não conseguiu concluir esta análise.",
      detail,
      latency_ms: latency,
      request_id: requestId,
    }, timedOut ? 504 : 502);
  } finally {
    if (conversationId) {
      try {
        await timedPost(`${CLOUDFLARE_AI_BASE}/conversations/delete`, authorization, { conversation_id: conversationId }, CLEANUP_TIMEOUT_MS);
      } catch {}
    }
  }
});
