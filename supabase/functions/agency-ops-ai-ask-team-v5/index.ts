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
const ENGINE_SOURCE = "CLOUDFLARE_WORKERS_AI_FAST_V5_3";
const CACHE_SOURCE = "OPSQUESTION_CACHE_V5_3";
const CURRENT_LIFECYCLES = new Set(["ACTIVE", "ONBOARDING"]);

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
    if (!response.ok || !parsed?.ok) throw new Error(String(parsed?.detail || parsed?.error || `HTTP ${response.status}`));
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function resolveExactNamed(text: string, rows: any[], field: string) {
  const normalizedText = ` ${norm(text)} `;
  let best: any = null;
  let bestLen = -1;
  for (const row of rows ?? []) {
    const name = norm(row?.[field]);
    if (!name || name.length < 3) continue;
    if (normalizedText.includes(` ${name} `) && name.length > bestLen) {
      best = row;
      bestLen = name.length;
    }
  }
  return best;
}

function resolvePrimaryClient(answer: string, clients: any[]) {
  const lead = norm(answer.slice(0, 1800));
  let best: any = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestLength = -1;
  for (const client of clients ?? []) {
    const name = norm(client?.display_name);
    if (!name || name.length < 3) continue;
    const index = ` ${lead} `.indexOf(` ${name} `);
    if (index < 0) continue;
    if (index < bestIndex || (index === bestIndex && name.length > bestLength)) {
      best = client;
      bestIndex = index;
      bestLength = name.length;
    }
  }
  return best;
}

function asksForHistorical(question: string) {
  const q = norm(question);
  return /\b(churned|churn|cliente antigo|clientes antigos|ex cliente|ex clientes|desligado|desligados|encerrado|encerrados|historico de cliente|historico dos clientes)\b/.test(q);
}

function asksWhichClient(question: string) {
  const q = norm(question);
  return /\b(qual cliente|quais clientes|cliente mais|mais preocupante|maior risco|quem precisa de atencao)\b/.test(q);
}

function requiresHealthyMetaPremise(question: string) {
  const q = norm(question);
  return /\b(meta)\b/.test(q) && /\b(saudavel|saudaveis|parece estar saudavel|parecem saudaveis|olhando apenas os numeros)\b/.test(q);
}

function violatesHealthyMetaPremise(answer: string) {
  const q = norm(answer.slice(0, 3200));
  return /\b(nao tem conta(?:s)? configurad(?:a|as) no meta|sem conta(?:s)? no meta|sem meta configurado|nao ha dados do meta|sem dados do meta|0 spend|0 gasto|0 impressions|0 impressoes|0 clicks|0 cliques)\b/.test(q);
}

function contextHints(question: string) {
  const q = norm(question);
  const hints = new Set<string>();
  if (/\b(causa|causou|antes|depois|mudou|piorou|melhorou|sequencia|historico|deterior|tendencia|evolucao|semana a semana)\b/.test(q)) {
    ["histórico", "WhatsApp", "saúde", "tarefas", "comercial", "Meta"].forEach((v) => hints.add(v));
  }
  if (/\b(promessa|compromisso|prometeu|cobrou|cobranca|retorno|resposta|atendimento)\b/.test(q)) {
    ["compromissos", "WhatsApp", "tarefas", "saúde"].forEach((v) => hints.add(v));
  }
  if (/\b(venda|vendeu|comercial|corretor|visita|proposta|funil|lead)\b/.test(q)) {
    ["comercial", "vendas", "Meta", "WhatsApp"].forEach((v) => hints.add(v));
  }
  if (/\b(meta|campanha|cpl|cpc|ctr|cpm|frequencia|orcamento|trafego|investimento)\b/.test(q)) {
    ["Meta", "campanhas"].forEach((v) => hints.add(v));
  }
  if (/\b(onboarding|integracao|reuniao|material|sla)\b/.test(q)) hints.add("onboarding");
  if (/\b(criativo|design|designer|ajuste|retrabalho|logo|layout|arte)\b/.test(q)) hints.add("criativos");
  if (/\b(equipe|gt|cs|colaborador|produtividade|carga|gargalo|responsavel)\b/.test(q)) hints.add("equipe");
  if (/\b(risco|churn|saudavel|insatisfeito|reclamacao|prioridade|preocupante|problema)\b/.test(q)) hints.add("saúde");
  return [...hints].join(", ");
}

function eligibleNames(clients: any[]) {
  return (clients ?? []).map((c: any) => String(c.display_name || "").trim()).filter(Boolean).slice(0, 140).join("; ");
}

function buildPrompt(question: string, permitted: any[], historicalAllowed: boolean) {
  const hints = contextHints(question);
  const lifecycleRule = historicalAllowed
    ? "A pergunta permite contexto histórico porque cita explicitamente cliente antigo/churned ou nomeia um cliente já desligado. Diferencie claramente situação histórica de situação atual."
    : "REGRA CRÍTICA DE ESCOPO: para perguntas sobre hoje, risco atual, prioridade ou 'cliente mais preocupante', considere SOMENTE clientes ACTIVE ou ONBOARDING. Ignore completamente clientes CHURNED/desligados como candidatos, mesmo que apareçam no contexto recuperado.";
  const metaPremise = requiresHealthyMetaPremise(question)
    ? "REGRA CRÍTICA DA PREMISSA META: o cliente escolhido precisa realmente parecer saudável no Meta com evidência objetiva de entrega/desempenho. Cliente sem conta Meta, sem dados Meta ou com 0 gasto/0 impressões não satisfaz a premissa e NÃO pode ser escolhido."
    : "";

  return [
    `PERGUNTA DO ADLER: ${question}`,
    hints ? `FONTES/ASSUNTOS A PRIORIZAR: ${hints}.` : "Use as fontes operacionais relevantes.",
    lifecycleRule,
    metaPremise,
    `CLIENTES ELEGÍVEIS PARA ESTA RESPOSTA: ${eligibleNames(permitted) || "nenhum cliente elegível"}. Não escolha cliente fora desta lista.`,
    "Você é o copiloto operacional da Leonardo Imobi. Responda em português do Brasil, de forma direta e executiva.",
    "Cruze fontes; ausência em uma fonte nunca prova que o fato não aconteceu.",
    "Separe FATO CONFIRMADO, INDÍCIO FORTE e HIPÓTESE quando houver inferência. Não transforme hipótese em fato.",
    "Se uma fonte está parcial ou tem corte de data diferente, cite o corte real. Nunca amplie o período além do que a fonte cobre.",
    "Zero vendas em um relatório significa zero vendas reportadas naquele relatório, não prova absoluta de zero vendas em todos os canais.",
    "Relatos de lead inválido/bot são sinais de possível problema de qualidade; não estime quantos leads são bots sem evidência individual.",
    "Venda confirmada não significa venda originada pelo tráfego sem evidência de origem.",
    "Se a pergunta disser que alguém parece saudável no Meta, demonstre isso com pelo menos uma métrica ou tendência objetiva antes de selecionar o cliente.",
    "Se a pergunta pedir 'qual cliente' entre vários, compare candidatos elegíveis antes de escolher e explique resumidamente por que o escolhido superou os demais sinais de risco.",
    "NUNCA exponha nomes técnicos de tabelas, views, colunas, campos, códigos internos ou valores de banco. Use nomes amigáveis como Saúde do Cliente, Relatório Comercial, Meta Ads, WhatsApp, ClickUp e Onboarding.",
    "Não use identificadores como dashboard_client_overview, client_service_overview, health_detail, client_health, external_summary, internal_score, external_health_status, meta_cross_status, NO_EXTERNAL ou null na resposta.",
    "Antes de recomendar pausar campanha/criativo, confirme se ainda está ativo. Se a situação atual não estiver disponível, recomende primeiro validar o status e só então pausar se ainda estiver ativo e o problema persistir.",
    "Quando houver divergência Meta x comercial, não conclua automaticamente que os leads são inválidos: considere também subnotificação, atraso de atualização e diferença de período.",
    "Para perguntas de decisão, risco, gargalo ou diagnóstico, termine com o título exato 'Próximos passos' e no máximo 3 itens numerados.",
    "Cada próximo passo deve seguir EXATAMENTE o formato `<N>) <ÁREA> — <NOME EXATO DO CLIENTE> — <AÇÃO>`. Pode haver mais de uma ação para a mesma área. Use Design somente para produção/revisão visual.",
    "Regra de responsabilidade: Meta/campanha/auditoria/reconciliação de leads = GT; falar/retornar/fazer call com cliente = CS; criação/revisão visual = Design; processo/sistema/escalonamento interno = Operações.",
    "Finalize com `Confiança: alta/média/baixa — motivo`. Não termine com avisos genéricos do tipo 'essas ações são apenas sugestões'.",
  ].filter(Boolean).join("\n\n");
}

function sanitizeAnswer(value: string) {
  return String(value || "")
    .replace(/\bdashboard_client_overview\b/gi, "Visão Geral do Cliente")
    .replace(/\bclient_service_overview\b/gi, "Acompanhamento do Cliente")
    .replace(/\bhealth_detail\b/gi, "Saúde do Cliente")
    .replace(/\bclient_health\b/gi, "Saúde do Cliente")
    .replace(/\bexternal_summary\b/gi, "resumo externo")
    .replace(/\binternal_score\b/gi, "pontuação interna")
    .replace(/\bexternal_health_status\b/gi, "status externo de saúde")
    .replace(/\bmeta_cross_status\b/gi, "status do cruzamento Meta × comercial")
    .replace(/\bNO_EXTERNAL\b/g, "sem acompanhamento comercial externo")
    .replace(/\bCHURNED\b/g, "desligado")
    .replace(/\bnull\b/gi, "sem dado disponível")
    .trim();
}

function validationIssue(answer: string, question: string, permitted: any[], allClients: any[], historicalAllowed: boolean) {
  const activePermitted = (permitted ?? []).filter((c: any) => CURRENT_LIFECYCLES.has(String(c.lifecycle)));
  if (!historicalAllowed) {
    const churned = (allClients ?? []).filter((c: any) => String(c.lifecycle) === "CHURNED");
    const churnedLead = resolvePrimaryClient(answer.slice(0, 1000), churned);
    const activeLead = resolvePrimaryClient(answer.slice(0, 1000), activePermitted);
    if (churnedLead && !activeLead) return `cliente desligado escolhido: ${churnedLead.display_name}`;
    if (churnedLead && activeLead) {
      const lead = norm(answer.slice(0, 1000));
      const churnedIndex = lead.indexOf(norm(churnedLead.display_name));
      const activeIndex = lead.indexOf(norm(activeLead.display_name));
      if (churnedIndex >= 0 && (activeIndex < 0 || churnedIndex < activeIndex)) return `cliente desligado escolhido: ${churnedLead.display_name}`;
    }
  }
  if (asksWhichClient(question) && !resolvePrimaryClient(answer, permitted)) return "nenhum cliente elegível foi escolhido";
  if (requiresHealthyMetaPremise(question) && violatesHealthyMetaPremise(answer)) return "o candidato não satisfaz a premissa de parecer saudável no Meta";
  return null;
}

function correctionPrompt(question: string, issue: string, permitted: any[], historicalAllowed: boolean) {
  return [
    "CORREÇÃO OBRIGATÓRIA DA RESPOSTA ANTERIOR.",
    `Problema detectado automaticamente: ${issue}.`,
    historicalAllowed
      ? "Respeite o contexto histórico explicitamente solicitado."
      : "Refaça do zero considerando somente clientes ACTIVE ou ONBOARDING. Clientes CHURNED/desligados não são candidatos a risco operacional atual.",
    requiresHealthyMetaPremise(question)
      ? "O cliente escolhido precisa ter evidência real de saúde/entrega no Meta; ausência de conta/dados ou entrega zerada elimina o candidato."
      : "",
    `Clientes elegíveis: ${eligibleNames(permitted)}.`,
    "Não exponha nomes de tabelas, views, colunas, códigos ou campos internos.",
    "Responda novamente à pergunta original, compare candidatos elegíveis e conclua com 'Próximos passos' em até 3 itens no formato exigido, seguido de Confiança.",
    `Pergunta original: ${question}`,
  ].filter(Boolean).join("\n\n");
}

function actionLines(answer: string) {
  const lower = answer.toLowerCase();
  const markers = [
    "próximos passos", "proximos passos", "ações prioritárias", "acoes prioritarias",
    "3 ações prioritárias", "3 acoes prioritarias", "ações a serem executadas", "acoes a serem executadas",
  ];
  const marker = markers.reduce((best, item) => Math.max(best, lower.lastIndexOf(item)), -1);
  if (marker < 0) return [];
  const section = answer.slice(marker);
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = lines.filter((line) => /^(?:\d{1,2}[.)]|[-•])\s+/.test(line));
  return (numbered.length ? numbered : lines.slice(1, 4))
    .slice(0, 3)
    .map((line) => line.replace(/^(?:\d{1,2}[.)]|[-•])\s+/, "").trim())
    .filter((line) => line.length >= 8);
}

function inferRole(text: string) {
  const q = norm(text);
  if (/\b(comunicar|falar com o cliente|retornar ao cliente|retorno ao cliente|call com o cliente|ligar para o cliente|apresentar ao cliente|follow up com o cliente)\b/.test(q)) return "CS";
  if (/\b(meta|campanha|campanhas|auditar campanha|auditoria de campanha|auditoria tecnica|pausar campanha|pausar criativo|cpl|ctr|cpm|publico|segmentacao|reconciliar leads|meta x comercial|leads meta|qualidade dos leads|reavaliar a campanha)\b/.test(q)) return "GT";
  if (/\b(criar arte|criar criativo|produzir criativo|revisar layout|ajustar layout|logo|identidade visual|peca visual|design)\b/.test(q)) return "DESIGN";
  if (/\b(process|sistema|integracao|banco de dados|escalar|escalon|operacao|gestao|atualizar as informacoes do cliente)\b/.test(q)) return "MGMT";
  if (/^(gt|gestor de trafego|trafego)\b/.test(q)) return "GT";
  if (/^(cs|customer success|atendimento|relacionamento)\b/.test(q)) return "CS";
  if (/^(design|designer)\b/.test(q)) return "DESIGN";
  if (/^(operacoes|operacao|gestao|adler)\b/.test(q)) return "MGMT";
  return "MGMT";
}

function inferPriority(text: string) {
  const q = norm(text);
  if (/\b(critico|critica|imediato|imediata|agora|urgente|risco alto|churn)\b/.test(q)) return "CRITICAL";
  if (/\b(alta|alto|prioridade|hoje|24h|48h|sla vencido|atrasado)\b/.test(q)) return "HIGH";
  if (/\b(baixa|baixo|quando possivel|sem urgencia)\b/.test(q)) return "LOW";
  return "MEDIUM";
}

function inferType(text: string) {
  const q = norm(text);
  if (/\b(comunicar|retornar|call com o cliente|falar com o cliente|follow up)\b/.test(q)) return "CLIENT_FOLLOWUP";
  if (/\b(criar arte|criar criativo|produzir criativo|revisar layout|design)\b/.test(q)) return "CREATIVE_REQUEST";
  if (/\b(integracao|api|zapi|webhook|sincronizacao|erro tecnico|falha tecnica)\b/.test(q)) return "TECHNICAL";
  if (/\b(clickup|task|tarefa)\b/.test(q)) return "CLICKUP";
  if (/\b(escalar|escalonar|escalacao)\b/.test(q)) return "ESCALATION";
  return "GENERAL";
}

function resolveTargetPerson(client: any, role: string, text: string, roster: any[]) {
  if (client && role === "GT") return client.gt_owner || null;
  if (client && role === "CS") return client.cs_owner || null;
  if (client && role === "DESIGN") return client.designer_owner || null;
  const named = resolveExactNamed(text, roster ?? [], "person");
  if (named && named.role === role) return named.person;
  return null;
}

function buildActions(answer: string, requestId: string, questionClient: any, permitted: any[], roster: any[]) {
  const primaryClient = questionClient || resolvePrimaryClient(answer, permitted);
  return actionLines(answer).map((text, index) => {
    const explicitClient = resolveExactNamed(text, permitted, "display_name");
    const client = explicitClient || primaryClient || null;
    const role = inferRole(text);
    return {
      id: `${requestId}:${index + 1}`,
      title: clip(text, 220),
      description: text,
      client_id: client?.id ?? null,
      client_name: client?.display_name ?? null,
      target_role: role,
      target_person: resolveTargetPerson(client, role, text, roster),
      priority: inferPriority(text),
      type: inferType(text),
      create_clickup: /\b(clickup|task|tarefa)\b/.test(norm(text)),
      source: "opsquestion_v5_3",
      source_id: requestId,
      execution_mode: "CREATE_WORK_ITEM",
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

  const namedAnyClient = resolveExactNamed(question, clients ?? [], "display_name");
  const explicitNamedChurned = namedAnyClient?.lifecycle === "CHURNED";
  const broadHistorical = asksForHistorical(question);
  const historicalAllowed = broadHistorical || explicitNamedChurned;

  const lifecycleAllowed = (client: any) => historicalAllowed
    ? (broadHistorical ? ["ACTIVE", "ONBOARDING", "CHURNED"].includes(String(client.lifecycle)) : CURRENT_LIFECYCLES.has(String(client.lifecycle)) || client.id === namedAnyClient?.id)
    : CURRENT_LIFECYCLES.has(String(client.lifecycle));

  const permitted = me.role === "GT"
    ? (clients ?? []).filter((client: any) => client.gt_owner === person && lifecycleAllowed(client))
    : me.role === "DESIGN"
      ? (clients ?? []).filter((client: any) => client.designer_owner === person && lifecycleAllowed(client))
      : (clients ?? []).filter(lifecycleAllowed);

  const questionClient = resolveExactNamed(question, permitted, "display_name");
  const requestId = crypto.randomUUID();

  const staleBefore = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  await ops.from("opsquestion_interactions").update({
    status: "ERROR",
    error: "stale_pending_reaped",
    answered_at: new Date().toISOString(),
  }).eq("user_key", userData.user.id).eq("status", "PENDING").lt("created_at", staleBefore);

  const cacheSince = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data: recentSuccess } = await ops.from("opsquestion_interactions")
    .select("question,answer,source,request_id,created_at")
    .eq("user_key", userData.user.id)
    .eq("status", "SUCCESS")
    .in("source", [ENGINE_SOURCE, CACHE_SOURCE])
    .not("answer", "is", null)
    .gte("created_at", cacheSince)
    .order("created_at", { ascending: false })
    .limit(30);

  const cached = (recentSuccess ?? []).find((row: any) => norm(row.question) === norm(question) && String(row.answer || "").trim());
  if (cached) {
    const sanitized = sanitizeAnswer(String(cached.answer).trim());
    const cacheIssue = validationIssue(sanitized, question, permitted, clients ?? [], historicalAllowed);
    if (!cacheIssue) {
      const primaryClient = questionClient || resolvePrimaryClient(sanitized, permitted);
      const actions = buildActions(sanitized, requestId, primaryClient, permitted, roster ?? []);
      const latency = Date.now() - startedAt;
      await ops.from("opsquestion_interactions").insert({
        user_key: userData.user.id,
        person,
        role: me.role,
        access_level: me.access_level ?? null,
        question,
        answer: sanitized.slice(0, 30000),
        status: "SUCCESS",
        source: CACHE_SOURCE,
        latency_ms: latency,
        request_id: requestId,
        answered_at: new Date().toISOString(),
      });
      return respond({
        ok: true,
        answer: sanitized,
        source: "Cache operacional validado",
        latency_ms: latency,
        request_id: requestId,
        client: primaryClient?.display_name ?? null,
        suggested_actions: actions,
        cached: true,
        cached_from: cached.created_at,
      });
    }
  }

  const { data: interaction } = await ops.from("opsquestion_interactions").insert({
    user_key: userData.user.id,
    person,
    role: me.role,
    access_level: me.access_level ?? null,
    question,
    status: "PENDING",
    source: ENGINE_SOURCE,
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

    let completion = await timedPost(`${CLOUDFLARE_AI_BASE}/chat`, authorization, {
      conversation_id: conversationId,
      message: buildPrompt(question, permitted, historicalAllowed),
      ops_fast: true,
    }, CHAT_TIMEOUT_MS);

    let rawAnswer = String(completion?.assistant_message?.content || "").trim();
    if (!rawAnswer) throw new Error("empty_answer");
    let answer = sanitizeAnswer(rawAnswer);
    let issue = validationIssue(answer, question, permitted, clients ?? [], historicalAllowed);

    if (issue) {
      completion = await timedPost(`${CLOUDFLARE_AI_BASE}/chat`, authorization, {
        conversation_id: conversationId,
        message: correctionPrompt(question, issue, permitted, historicalAllowed),
        ops_fast: true,
      }, CHAT_TIMEOUT_MS);
      rawAnswer = String(completion?.assistant_message?.content || "").trim();
      if (!rawAnswer) throw new Error("empty_corrected_answer");
      answer = sanitizeAnswer(rawAnswer);
      issue = validationIssue(answer, question, permitted, clients ?? [], historicalAllowed);
    }

    if (issue) {
      const safe = requiresHealthyMetaPremise(question)
        ? "Não encontrei evidência suficiente para apontar com segurança um cliente ativo que cumpra a premissa de parecer saudável no Meta e, ao mesmo tempo, seja o mais preocupante no cruzamento das demais fontes. Prefiro não escolher um cliente que não satisfaça a premissa.\n\nConfiança: alta — a validação automática rejeitou candidatos sem evidência Meta suficiente ou fora do escopo atual."
        : "Não encontrei evidência suficiente para escolher com segurança um cliente elegível para esta pergunta sem violar o escopo operacional atual.\n\nConfiança: alta — a validação automática impediu a seleção de cliente fora do escopo ou sem suporte suficiente.";
      answer = safe;
    }

    const primaryClient = questionClient || resolvePrimaryClient(answer, permitted);
    const actions = issue ? [] : buildActions(answer, requestId, primaryClient, permitted, roster ?? []);
    const latency = Date.now() - startedAt;

    if (interaction?.id) {
      await ops.from("opsquestion_interactions").update({
        answer: answer.slice(0, 30000),
        status: "SUCCESS",
        source: ENGINE_SOURCE,
        latency_ms: latency,
        answered_at: new Date().toISOString(),
      }).eq("id", interaction.id);
    }

    return respond({
      ok: true,
      answer,
      source: issue ? "Validação operacional · resposta conservadora" : "Workers AI rápido · base operacional validada",
      latency_ms: latency,
      request_id: requestId,
      client: primaryClient?.display_name ?? null,
      suggested_actions: actions,
      model: completion?.model ?? null,
      timing: completion?.timing ?? null,
      validation_guard: issue || null,
    });
  } catch (error) {
    const latency = Date.now() - startedAt;
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    const detail = timedOut ? "advanced_query_timeout" : clip(error instanceof Error ? error.message : error, 500);
    if (interaction?.id) {
      await ops.from("opsquestion_interactions").update({
        status: "ERROR",
        source: ENGINE_SOURCE,
        latency_ms: latency,
        error: detail,
        answered_at: new Date().toISOString(),
      }).eq("id", interaction.id);
    }
    return respond({
      ok: false,
      error: timedOut
        ? "Essa análise excedeu o limite seguro de tempo. Tente novamente; o OpsQuestion não ficará preso indefinidamente."
        : "OpsQuestion não conseguiu concluir esta análise.",
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
