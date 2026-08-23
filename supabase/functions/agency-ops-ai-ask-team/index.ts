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

type TeamPerson = { person: string; role: string; clickup_user: string | null };
type FastAnswer = { answer: string; source: string; intent: string };
type Period = { start: string; end: string; label: string };

function tokenSet(value: string): Set<string> {
  return new Set(norm(value).split(" ").filter(Boolean));
}

function mentionedPerson(question: string, roster: TeamPerson[], roleFilter?: string): TeamPerson | null {
  const q = norm(question);
  const qTokens = tokenSet(q);
  const candidates = roster
    .filter((row) => !roleFilter || row.role === roleFilter)
    .map((row) => {
      const full = norm(row.person);
      if (q.includes(full)) return { row, score: 1000 + full.length };
      const parts = full.split(" ").filter((part) => part.length >= 3);
      const hits = parts.filter((part) => qTokens.has(part));
      const score = hits.reduce((sum, part) => sum + part.length, 0);
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0].row;
}

function saoPauloDateParts(now = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dayPeriod(offsetDays: number, label: string): Period {
  const { year, month, day } = saoPauloDateParts();
  // Brasil não usa horário de verão desde 2019. 00:00 em São Paulo = 03:00 UTC.
  const startMs = Date.UTC(year, month - 1, day + offsetDays, 3, 0, 0, 0);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86_400_000).toISOString(),
    label,
  };
}

function weekPeriod(): Period {
  const { year, month, day } = saoPauloDateParts();
  const localDate = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  const startMs = Date.UTC(year, month - 1, day - daysSinceMonday, 3, 0, 0, 0);
  return { start: new Date(startMs).toISOString(), end: new Date().toISOString(), label: "nesta semana" };
}

function periodFromQuestion(q: string): Period | null {
  if (/\bontem\b/.test(q)) return dayPeriod(-1, "ontem");
  if (/\bhoje\b/.test(q)) return dayPeriod(0, "hoje");
  if (/\b(esta semana|essa semana|semana atual)\b/.test(q)) return weekPeriod();
  if (/\b(ultimos 7 dias|sete dias)\b/.test(q)) {
    return { start: new Date(Date.now() - 7 * 86_400_000).toISOString(), end: new Date().toISOString(), label: "nos últimos 7 dias" };
  }
  return null;
}

function canSeeTeamWide(role: string): boolean {
  return role === "MGMT" || role === "AI" || role === "CS";
}

function restrictedAnswer(): FastAnswer {
  return {
    answer: "Seu perfil só pode consultar dados do próprio escopo operacional.",
    source: "DIRECT_DB_FAST",
    intent: "scope_restriction",
  };
}

async function directDbAnswer(ops: any, role: string, person: string, question: string): Promise<FastAnswer | null> {
  const q = norm(question);
  const { data: rosterData, error: rosterError } = await ops.from("team_roster")
    .select("person,role,clickup_user")
    .eq("is_former", false);
  if (rosterError) throw new Error(`direct_db_roster:${rosterError.message}`);
  const roster = (rosterData ?? []).map((row: any) => ({
    person: String(row.person),
    role: String(row.role),
    clickup_user: row.clickup_user ? String(row.clickup_user) : null,
  })) as TeamPerson[];

  const countWords = /\b(quanto|quantos|quantas|total|numero|tivemos|tem|temos)\b/;
  const listWords = /\b(qual|quais|quem|lista|listar|mostra|mostre|nomes)\b/;
  const asksClients = /\b(cliente|clientes|carteira|carteiras)\b/.test(q);
  const mentionedGt = mentionedPerson(q, roster, "GT");

  // 1) Carteira de um GT específico: "quantos clientes tem o Yuri?", "carteira do GT Yuri" etc.
  if (mentionedGt && asksClients) {
    if (role === "GT" && mentionedGt.person !== person) return restrictedAnswer();
    if (role === "DESIGN") return restrictedAnswer();

    let query = ops.from("clients")
      .select("display_name,lifecycle")
      .eq("gt_owner", mentionedGt.person)
      .in("lifecycle", ["ACTIVE", "ONBOARDING"])
      .order("display_name");
    const { data, error } = await query;
    if (error) throw new Error(`direct_db_gt_portfolio:${error.message}`);
    const rows = data ?? [];
    const active = rows.filter((row: any) => row.lifecycle === "ACTIVE");
    const onboarding = rows.filter((row: any) => row.lifecycle === "ONBOARDING");

    const onlyOnboarding = q.includes("onboarding");
    const onlyActive = /\b(ativo|ativos)\b/.test(q) && !onlyOnboarding;
    const selected = onlyOnboarding ? onboarding : onlyActive ? active : rows;
    const label = onlyOnboarding ? "em onboarding" : onlyActive ? "ativos" : "na carteira";
    let answer = `${mentionedGt.person} tem ${selected.length} ${selected.length === 1 ? "cliente" : "clientes"} ${label}.`;
    if (!onlyOnboarding && !onlyActive) answer += ` São ${active.length} ativos e ${onboarding.length} em onboarding.`;
    if (listWords.test(q) || (!countWords.test(q) && asksClients)) {
      const names = selected.map((row: any) => `• ${row.display_name}`).join("\n");
      if (names) answer += `\n${names}`;
    }
    return { answer, source: "DIRECT_DB_FAST", intent: "gt_portfolio" };
  }

  // 2) Comparativo das carteiras: "quantos clientes cada GT tem?"
  const asksGtBreakdown = asksClients && /\b(cada gt|por gt|todos os gt|carteiras dos gt|carteira dos gt)\b/.test(q);
  if (asksGtBreakdown) {
    if (!canSeeTeamWide(role)) return restrictedAnswer();
    const { data, error } = await ops.from("clients")
      .select("gt_owner,lifecycle")
      .in("lifecycle", ["ACTIVE", "ONBOARDING"]);
    if (error) throw new Error(`direct_db_gt_breakdown:${error.message}`);
    const map = new Map<string, { active: number; onboarding: number }>();
    for (const row of data ?? []) {
      const gt = String(row.gt_owner ?? "").trim();
      if (!gt) continue;
      const item = map.get(gt) ?? { active: 0, onboarding: 0 };
      if (row.lifecycle === "ACTIVE") item.active += 1;
      if (row.lifecycle === "ONBOARDING") item.onboarding += 1;
      map.set(gt, item);
    }
    const lines = [...map.entries()]
      .map(([gt, value]) => ({ gt, ...value, total: value.active + value.onboarding }))
      .sort((a, b) => b.total - a.total)
      .map((item) => `• ${item.gt}: ${item.total} (${item.active} ativos + ${item.onboarding} onboarding)`);
    return {
      answer: lines.length ? `Carteiras dos GTs agora:\n${lines.join("\n")}` : "Não encontrei clientes atribuídos a GTs ativos.",
      source: "DIRECT_DB_FAST",
      intent: "gt_portfolio_breakdown",
    };
  }

  // 3) Onboarding geral ou do próprio escopo.
  const asksOnboarding = q.includes("onboarding") && /\b(qual|quais|quem|lista|listar|estao|cliente|clientes|quantos|quantas|total)\b/.test(q);
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
        source: "DIRECT_DB_FAST",
        intent: "onboarding",
      };
    }
    const wantsList = listWords.test(q) || /\b(estao)\b/.test(q);
    let answer = `Há ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} em onboarding.`;
    if (wantsList) {
      const lines = rows.map((row: any) => `• ${row.display_name}${row.gt_owner ? ` — GT: ${row.gt_owner}` : " — GT ainda não definido"}`);
      answer += `\n${lines.join("\n")}`;
    }
    return { answer, source: "DIRECT_DB_FAST", intent: "onboarding" };
  }

  // 4) Total da operação ou clientes ativos.
  const asksOperationTotal = asksClients && countWords.test(q) && q.includes("operacao") && !/\b(ativo|ativos)\b/.test(q);
  if (asksOperationTotal) {
    let query = ops.from("clients").select("lifecycle").in("lifecycle", ["ACTIVE", "ONBOARDING"]);
    if (role === "GT") query = query.eq("gt_owner", person);
    if (role === "DESIGN") query = query.eq("designer_owner", person);
    const { data, error } = await query;
    if (error) throw new Error(`direct_db_operation_total:${error.message}`);
    const rows = data ?? [];
    const active = rows.filter((row: any) => row.lifecycle === "ACTIVE").length;
    const onboarding = rows.filter((row: any) => row.lifecycle === "ONBOARDING").length;
    return {
      answer: role === "GT"
        ? `${person} tem ${rows.length} clientes na carteira: ${active} ativos e ${onboarding} em onboarding.`
        : `A operação tem ${rows.length} clientes agora: ${active} ativos e ${onboarding} em onboarding.`,
      source: "DIRECT_DB_FAST",
      intent: "operation_total",
    };
  }

  const asksActiveCount = asksClients && countWords.test(q) && /\b(ativo|ativos)\b/.test(q);
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
      source: "DIRECT_DB_FAST",
      intent: "active_clients",
    };
  }

  // 5) Tasks / tarefas: produtividade rápida do ClickUp.
  const asksTasks = /\b(task|tasks|tarefa|tarefas)\b/.test(q);
  if (asksTasks) {
    const namedMember = mentionedPerson(q, roster);
    let taskPerson: TeamPerson | null = namedMember;
    if (role === "GT" || role === "DESIGN") {
      if (namedMember && namedMember.person !== person) return restrictedAnswer();
      taskPerson = roster.find((row) => row.person === person) ?? { person, role, clickup_user: person };
    }

    const assignee = taskPerson?.clickup_user || taskPerson?.person || null;
    const period = periodFromQuestion(q) ?? dayPeriod(0, "hoje");
    const ranking = /\b(quem mais|ranking|por pessoa|por colaborador|cada pessoa|cada colaborador)\b/.test(q);
    const wantsOverdue = /\b(atrasada|atrasadas|atrasado|atrasados|vencida|vencidas)\b/.test(q);
    const wantsOpen = /\b(aberta|abertas|aberto|abertos|pendente|pendentes)\b/.test(q) && !/\b(criada|criadas|criado|criados)\b/.test(q);
    const wantsCreated = /\b(criada|criadas|criado|criados|criamos|abriu|abrimos)\b/.test(q);
    const wantsClosed = /\b(feita|feitas|feito|feitos|concluida|concluidas|concluido|concluidos|finalizada|finalizadas|finalizado|finalizados|fez|fizeram)\b/.test(q);

    if (ranking) {
      if (!canSeeTeamWide(role)) return restrictedAnswer();
      const { data, error } = await ops.from("clickup_tasks")
        .select("assignee_names,date_closed")
        .gte("date_closed", period.start)
        .lt("date_closed", period.end)
        .not("assignee_names", "is", null)
        .limit(1000);
      if (error) throw new Error(`direct_db_task_ranking:${error.message}`);
      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        const names = String(row.assignee_names ?? "").split(",").map((name) => name.trim()).filter(Boolean);
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, total], index) => `${index + 1}. ${name}: ${total}`);
      return {
        answer: lines.length ? `Tasks concluídas ${period.label}, por pessoa:\n${lines.join("\n")}` : `Não há tasks concluídas ${period.label}.`,
        source: "DIRECT_DB_FAST",
        intent: "task_ranking",
      };
    }

    if (wantsOverdue || (wantsOpen && !/\b(hoje|ontem|semana)\b/.test(q))) {
      let query = ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("is_closed", false);
      if (wantsOverdue) query = query.not("due_date", "is", null).lt("due_date", new Date().toISOString());
      if (assignee) query = query.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await query;
      if (error) throw new Error(`direct_db_task_open:${error.message}`);
      const total = count ?? 0;
      const ownerText = taskPerson ? ` de ${taskPerson.person}` : " da operação";
      return {
        answer: wantsOverdue
          ? `Há ${total} ${total === 1 ? "task atrasada" : "tasks atrasadas"}${ownerText} no ClickUp.`
          : `Há ${total} ${total === 1 ? "task aberta" : "tasks abertas"}${ownerText} no ClickUp.`,
        source: "DIRECT_DB_FAST",
        intent: wantsOverdue ? "tasks_overdue" : "tasks_open",
      };
    }

    const countFor = async (column: "date_closed" | "date_created") => {
      let query = ops.from("clickup_tasks")
        .select("task_id", { count: "exact", head: true })
        .gte(column, period.start)
        .lt(column, period.end);
      if (assignee) query = query.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await query;
      if (error) throw new Error(`direct_db_tasks_${column}:${error.message}`);
      return count ?? 0;
    };

    if (wantsCreated) {
      const total = await countFor("date_created");
      return {
        answer: `${taskPerson ? taskPerson.person : "A operação"} teve ${total} ${total === 1 ? "task criada" : "tasks criadas"} ${period.label} no ClickUp.`,
        source: "DIRECT_DB_FAST",
        intent: "tasks_created",
      };
    }

    if (wantsClosed) {
      const total = await countFor("date_closed");
      return {
        answer: `${taskPerson ? taskPerson.person : "A operação"} concluiu ${total} ${total === 1 ? "task" : "tasks"} ${period.label} no ClickUp.`,
        source: "DIRECT_DB_FAST",
        intent: "tasks_closed",
      };
    }

    // "Hoje tivemos quantas tasks?" é ambíguo. Entrega os dois números sem pedir esclarecimento.
    const [closed, created] = await Promise.all([countFor("date_closed"), countFor("date_created")]);
    return {
      answer: `${period.label[0].toUpperCase()}${period.label.slice(1)}, ${taskPerson ? taskPerson.person : "a operação"} concluiu ${closed} ${closed === 1 ? "task" : "tasks"} no ClickUp. Foram criadas ${created}.`,
      source: "DIRECT_DB_FAST",
      intent: "tasks_snapshot",
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

  // FAST LANE: perguntas operacionais objetivas não gastam IA e não entram no rate limit da IA.
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
        source: "agency_ops · resposta operacional rápida",
        read_only: true,
        mode: direct.source,
        intent: direct.intent,
        scope: scopeLabel,
        request_id: requestId,
        latency_ms: latency,
        generated_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("[opsquestion-direct-db]", errorText(err));
  }

  // Só a camada de IA recebe limite de rajada; consultas rápidas acima já foram respondidas.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount } = await ops.from("opsquestion_interactions")
    .select("id", { count: "exact", head: true })
    .eq("user_key", user.id)
    .gte("created_at", since)
    .neq("source", "DIRECT_DB_FAST");
  if ((recentCount ?? 0) >= 12) return reply({ ok: false, error: "Muitas perguntas analíticas em sequência. Aguarde alguns segundos." }, 429);

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
