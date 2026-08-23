import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const DIRECT_AI_TIMEOUT_MS = 55_000;
const AI_RATE_LIMIT_PER_MINUTE = 12;

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

function clip(value: unknown, max = 360): string {
  const s = String(value ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

type TeamPerson = { person: string; role: string; clickup_user: string | null };
type FastAnswer = { answer: string; source: string; intent: string };
type Period = { start: string; end: string; label: string };
type ClientRow = {
  id: string;
  display_name: string;
  lifecycle: string;
  gt_owner: string | null;
  cs_owner: string | null;
  designer_owner: string | null;
};

type StageIntent = {
  stage?: "INTRO_MEETING" | "PRODUCT_PERSONA_MEETING" | "INTEGRATION_MEETING" | "RAW_ASSETS";
  mode?: "CURRENT" | "SCHEDULED" | "WAITING";
  human: string;
};

const TECH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bINTEGRATION_MEETING\b/gi, "reunião de integração com o GT"],
  [/\bPRODUCT_PERSONA_MEETING\b/gi, "reunião de Produto e Persona"],
  [/\bINTRO_MEETING\b/gi, "primeira reunião de apresentação"],
  [/\bRAW_ASSETS\b/gi, "envio/organização dos materiais"],
  [/\bCAMPAIGN_LAUNCH\b/gi, "campanha no ar"],
  [/\bCREATIVE_PRODUCTION\b/gi, "produção de criativos"],
  [/\bCOMPLETED\b/gi, "concluído"],
  [/\bSCHEDULED\b/gi, "agendado"],
  [/\bPENDING\b/gi, "pendente"],
  [/\bWAITING_SCHEDULING\b/gi, "aguardando agendamento"],
  [/\bACTIVE_DELIVERY\b/gi, "campanha rodando"],
  [/\bNO_ACTIVE_CAMPAIGN\b/gi, "sem campanha ativa"],
  [/\bNO_CAMPAIGNS\b/gi, "sem campanha cadastrada"],
  [/\bNO_DELIVERY\b/gi, "sem entrega"],
  [/\bNO_META_ACCOUNT\b/gi, "sem conta Meta vinculada"],
  [/\bSTALE\b/gi, "dados desatualizados"],
  [/\bATTENTION\b/gi, "precisa de atenção"],
  [/\bFOLLOW_UP\b/gi, "precisa de acompanhamento"],
  [/\bDATA_INCOMPLETE\b/gi, "dados incompletos"],
  [/\bUNDETERMINED\b/gi, "ainda sem classificação"],
  [/\bcurrent_stage\b/gi, "etapa atual"],
  [/\bstage_code\b/gi, "etapa"],
  [/\bgt_owner\b/gi, "GT responsável"],
  [/\bcs_owner\b/gi, "CS responsável"],
  [/\bdesigner_owner\b/gi, "designer responsável"],
  [/\blifecycle\b/gi, "situação do cliente"],
  [/\bonboarding_cases\b/gi, "onboarding"],
  [/\bonboarding_events\b/gi, "histórico do onboarding"],
  [/\bagency_ops\b/gi, "base operacional"],
];

function humanizeAiAnswer(answer: string): string {
  let out = String(answer || "").trim();
  for (const [pattern, replacement] of TECH_REPLACEMENTS) out = out.replace(pattern, replacement);
  out = out
    .replace(/\b(schema|tabela|coluna|enum|campo)\s+["'`]?([a-z0-9_.-]+)["'`]?/gi, (_m, kind, _name) => {
      const label = String(kind).toLowerCase();
      return label === "campo" || label === "coluna" ? "informação registrada" : "base operacional";
    })
    .replace(/\s{3,}/g, "\n\n")
    .trim();
  return out;
}

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
      return { row, score: hits.reduce((sum, part) => sum + part.length, 0) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0].row;
}

function resolveClientMention(question: string, clients: ClientRow[]): ClientRow | null {
  const q = ` ${norm(question)} `;
  let best: ClientRow | null = null;
  let bestScore = 0;
  for (const client of clients) {
    const name = norm(client.display_name);
    if (!name || name.length < 3) continue;
    if (q.includes(` ${name} `) && name.length > bestScore) {
      best = client;
      bestScore = name.length + 1000;
      continue;
    }
    const parts = name.split(" ").filter((p) => p.length >= 4);
    const score = parts.filter((p) => q.includes(` ${p} `)).reduce((sum, p) => sum + p.length, 0);
    if (score >= Math.max(5, Math.floor(name.length * 0.5)) && score > bestScore) {
      best = client;
      bestScore = score;
    }
  }
  return best;
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
  const startMs = Date.UTC(year, month - 1, day + offsetDays, 3, 0, 0, 0);
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 86_400_000).toISOString(), label };
}

function weekPeriod(): Period {
  const { year, month, day } = saoPauloDateParts();
  const localDate = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  const startMs = Date.UTC(year, month - 1, day - daysSinceMonday, 3, 0, 0, 0);
  return { start: new Date(startMs).toISOString(), end: new Date().toISOString(), label: "nesta semana" };
}

function monthPeriod(): Period {
  const { year, month } = saoPauloDateParts();
  const startMs = Date.UTC(year, month - 1, 1, 3, 0, 0, 0);
  const endMs = Date.UTC(year, month, 1, 3, 0, 0, 0);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), label: "neste mês" };
}

function periodFromQuestion(q: string): Period | null {
  if (/\bontem\b/.test(q)) return dayPeriod(-1, "ontem");
  if (/\bhoje\b/.test(q)) return dayPeriod(0, "hoje");
  if (/\b(esta semana|essa semana|semana atual|desde segunda)\b/.test(q)) return weekPeriod();
  if (/\b(este mes|esse mes|mes atual)\b/.test(q)) return monthPeriod();
  if (/\b(ultimos 7 dias|sete dias)\b/.test(q)) {
    return { start: new Date(Date.now() - 7 * 86_400_000).toISOString(), end: new Date().toISOString(), label: "nos últimos 7 dias" };
  }
  return null;
}

function canSeeTeamWide(role: string): boolean {
  return role === "MGMT" || role === "AI" || role === "CS";
}

function canSeeFinance(role: string, person: string): boolean {
  return role === "MGMT" || person === "Adler Furtado";
}

function restrictedAnswer(): FastAnswer {
  return {
    answer: "Essa informação fica fora do seu escopo de acesso. Posso consultar o que estiver dentro da sua carteira/área.",
    source: "DIRECT_DB_FAST",
    intent: "scope_restriction",
  };
}

function looksLikeFollowUp(q: string): boolean {
  const words = q.split(" ").filter(Boolean);
  return words.length <= 6 && /\b(e|eles|elas|deles|delas|esses|essas|isso|hoje|ontem|agora|yuri|felipe|rodrigo|hugo|qual|quais)\b/.test(q);
}

function stageIntentFromQuestion(q: string): StageIntent | null {
  const scheduled = /\b(marcad[ao]s?|agendad[ao]s?|agenda|quando e|quando vai|data da)\b/.test(q);
  const waiting = /\b(aguardando|esperando|falta marcar|sem marcar|marcar integracao|pendente de integracao)\b/.test(q);

  if (/\b(primeira reuniao|1 reuniao|reuniao de apresentacao|apresentacao inicial)\b/.test(q)) {
    return { stage: "INTRO_MEETING", mode: "CURRENT", human: "primeira reunião de apresentação" };
  }
  if (/\b(produto e persona|produto persona|segunda reuniao|2 reuniao|reuniao de produto)\b/.test(q)) {
    return { stage: "PRODUCT_PERSONA_MEETING", mode: "CURRENT", human: "reunião de Produto e Persona" };
  }
  if (/\b(reuniao de integracao|integracao com gt|integracao do gt|em integracao|na integracao|integracao)\b/.test(q)) {
    return {
      stage: "INTEGRATION_MEETING",
      mode: scheduled ? "SCHEDULED" : waiting ? "WAITING" : "CURRENT",
      human: scheduled ? "integração já marcada" : waiting ? "aguardando marcar a integração" : "reunião de integração com o GT",
    };
  }
  if (/\b(material|materiais|ativos brutos|raw assets|aguardando material|envio de material)\b/.test(q) && /\b(onboarding|etapa|aguardando|cliente|clientes)\b/.test(q)) {
    return { stage: "RAW_ASSETS", mode: "CURRENT", human: "envio/organização dos materiais" };
  }
  return null;
}

function formatNames(names: string[], max = 12): string {
  const clean = names.filter(Boolean);
  if (!clean.length) return "";
  const shown = clean.slice(0, max);
  const text = shown.join(", ");
  return clean.length > max ? `${text} e mais ${clean.length - max}` : text;
}

function visibleClientIds(clients: ClientRow[], role: string, person: string): string[] {
  if (role === "GT") return clients.filter((c) => c.gt_owner === person).map((c) => c.id);
  if (role === "DESIGN") return clients.filter((c) => c.designer_owner === person).map((c) => c.id);
  return clients.map((c) => c.id);
}

async function directDbAnswer(ops: any, role: string, person: string, question: string, previousQuestion?: string | null): Promise<FastAnswer | null> {
  const currentQ = norm(question);
  const contextQ = previousQuestion && looksLikeFollowUp(currentQ) ? `${norm(previousQuestion)} ${currentQ}`.trim() : currentQ;

  const [{ data: rosterData, error: rosterError }, { data: clientData, error: clientError }] = await Promise.all([
    ops.from("team_roster").select("person,role,clickup_user").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).order("display_name").limit(400),
  ]);
  if (rosterError) throw new Error(`direct_db_roster:${rosterError.message}`);
  if (clientError) throw new Error(`direct_db_clients:${clientError.message}`);

  const roster = (rosterData ?? []).map((row: any) => ({
    person: String(row.person), role: String(row.role), clickup_user: row.clickup_user ? String(row.clickup_user) : null,
  })) as TeamPerson[];
  const clients = (clientData ?? []).map((row: any) => ({
    id: String(row.id), display_name: String(row.display_name), lifecycle: String(row.lifecycle),
    gt_owner: row.gt_owner ? String(row.gt_owner) : null,
    cs_owner: row.cs_owner ? String(row.cs_owner) : null,
    designer_owner: row.designer_owner ? String(row.designer_owner) : null,
  })) as ClientRow[];

  const countWords = /\b(quanto|quantos|quantas|total|numero|tivemos|tem|temos)\b/;
  const listWords = /\b(qual|quais|quem|lista|listar|mostra|mostre|nomes|sao)\b/;
  const asksClients = /\b(cliente|clientes|carteira|carteiras)\b/.test(contextQ);
  const mentionedGt = mentionedPerson(currentQ, roster, "GT") || mentionedPerson(contextQ, roster, "GT");
  const namedMember = mentionedPerson(currentQ, roster) || mentionedPerson(contextQ, roster);
  const mentionedClient = resolveClientMention(currentQ, clients) || resolveClientMention(contextQ, clients);

  const stageIntent = stageIntentFromQuestion(contextQ);
  if (stageIntent && /\b(cliente|clientes|quantos|quantas|quem|quais|estao|tem|temos|onboarding|reuniao|integracao|material|materiais)\b/.test(contextQ)) {
    if (role === "DESIGN") return restrictedAnswer();

    let query = ops.from("gt_onboarding_worklist")
      .select("client_id,display_name,gt_owner,current_stage,next_action,integration_status,integration_bucket,integration_meet_scheduled_for,integration_attempt_count,last_attempt_outcome")
      .order("display_name");
    if (role === "GT") query = query.eq("gt_owner", person);
    if (mentionedGt && canSeeTeamWide(role)) query = query.eq("gt_owner", mentionedGt.person);

    const { data, error } = await query;
    if (error) throw new Error(`direct_db_onboarding_stage:${error.message}`);
    let rows = data ?? [];
    if (stageIntent.stage === "INTEGRATION_MEETING" && stageIntent.mode === "SCHEDULED") {
      rows = rows.filter((row: any) => row.integration_status === "SCHEDULED" || Boolean(row.integration_meet_scheduled_for));
    } else if (stageIntent.stage === "INTEGRATION_MEETING" && stageIntent.mode === "WAITING") {
      rows = rows.filter((row: any) => row.integration_status === "PENDING" && row.integration_bucket === "WAITING_SCHEDULING");
    } else if (stageIntent.stage) {
      rows = rows.filter((row: any) => row.current_stage === stageIntent.stage);
    }

    const owner = mentionedGt ? ` do ${mentionedGt.person}` : "";
    if (!rows.length) {
      return {
        answer: `Não encontrei nenhum cliente${owner} ${stageIntent.human === "reunião de integração com o GT" ? "na etapa de reunião de integração agora" : `em ${stageIntent.human}`}.`,
        source: "DIRECT_DB_FAST", intent: "onboarding_stage",
      };
    }

    const names = rows.map((row: any) => String(row.display_name));
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"}${owner} ${stageIntent.human === "reunião de integração com o GT" ? "na etapa de reunião de integração agora" : `em ${stageIntent.human}`}: ${formatNames(names)}.`;
    if (stageIntent.mode === "SCHEDULED") {
      const details = rows.slice(0, 8).map((row: any) => {
        if (!row.integration_meet_scheduled_for) return null;
        const when = new Intl.DateTimeFormat("pt-BR", {
          timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        }).format(new Date(row.integration_meet_scheduled_for));
        return `${row.display_name}: ${when}`;
      }).filter(Boolean);
      if (details.length) answer += `\n${details.map((d: string) => `• ${d}`).join("\n")}`;
    }
    return { answer, source: "DIRECT_DB_FAST", intent: "onboarding_stage" };
  }

  if (mentionedGt && asksClients) {
    if (role === "GT" && mentionedGt.person !== person) return restrictedAnswer();
    if (role === "DESIGN") return restrictedAnswer();
    const rows = clients.filter((c) => c.gt_owner === mentionedGt.person && ["ACTIVE", "ONBOARDING"].includes(c.lifecycle));
    const active = rows.filter((c) => c.lifecycle === "ACTIVE");
    const onboarding = rows.filter((c) => c.lifecycle === "ONBOARDING");
    const onlyOnboarding = contextQ.includes("onboarding");
    const onlyActive = /\b(ativo|ativos)\b/.test(contextQ) && !onlyOnboarding;
    const selected = onlyOnboarding ? onboarding : onlyActive ? active : rows;
    const label = onlyOnboarding ? "em onboarding" : onlyActive ? "ativos" : "na carteira";
    let answer = `${mentionedGt.person} está com ${selected.length} ${selected.length === 1 ? "cliente" : "clientes"} ${label}.`;
    if (!onlyOnboarding && !onlyActive) answer += ` São ${active.length} ativos e ${onboarding.length} em onboarding.`;
    if (listWords.test(contextQ) || (!countWords.test(contextQ) && asksClients)) {
      const names = selected.map((row) => `• ${row.display_name}`).join("\n");
      if (names) answer += `\n${names}`;
    }
    return { answer, source: "DIRECT_DB_FAST", intent: "gt_portfolio" };
  }

  if (asksClients && /\b(cada gt|por gt|todos os gt|carteiras dos gt|carteira dos gt)\b/.test(contextQ)) {
    if (!canSeeTeamWide(role)) return restrictedAnswer();
    const map = new Map<string, { active: number; onboarding: number }>();
    for (const row of clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle))) {
      const gt = String(row.gt_owner ?? "").trim();
      if (!gt) continue;
      const item = map.get(gt) ?? { active: 0, onboarding: 0 };
      if (row.lifecycle === "ACTIVE") item.active += 1;
      if (row.lifecycle === "ONBOARDING") item.onboarding += 1;
      map.set(gt, item);
    }
    const lines = [...map.entries()]
      .map(([gt, value]) => ({ gt, ...value, total: value.active + value.onboarding }))
      .filter((item) => item.total > 0).sort((a, b) => b.total - a.total)
      .map((item) => `• ${item.gt}: ${item.total} (${item.active} ativos + ${item.onboarding} onboarding)`);
    return { answer: lines.length ? `As carteiras estão assim agora:\n${lines.join("\n")}` : "Não encontrei clientes atribuídos aos GTs ativos.", source: "DIRECT_DB_FAST", intent: "gt_portfolio_breakdown" };
  }

  if (contextQ.includes("onboarding") && /\b(qual|quais|quem|lista|listar|estao|cliente|clientes|quantos|quantas|total|tem|temos)\b/.test(contextQ)) {
    let rows = clients.filter((c) => c.lifecycle === "ONBOARDING");
    if (role === "GT") rows = rows.filter((c) => c.gt_owner === person);
    if (role === "DESIGN") rows = rows.filter((c) => c.designer_owner === person);
    const wantsList = listWords.test(contextQ) || /\bestao\b/.test(contextQ);
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} em onboarding agora.`;
    if (wantsList && rows.length) answer += `\n${rows.map((row) => `• ${row.display_name}${row.gt_owner ? ` — GT: ${row.gt_owner}` : " — GT ainda não definido"}`).join("\n")}`;
    return { answer, source: "DIRECT_DB_FAST", intent: "onboarding" };
  }

  if (asksClients && countWords.test(contextQ) && contextQ.includes("operacao") && !/\b(ativo|ativos)\b/.test(contextQ)) {
    let rows = clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle));
    if (role === "GT") rows = rows.filter((c) => c.gt_owner === person);
    if (role === "DESIGN") rows = rows.filter((c) => c.designer_owner === person);
    const active = rows.filter((c) => c.lifecycle === "ACTIVE").length;
    const onboarding = rows.filter((c) => c.lifecycle === "ONBOARDING").length;
    return { answer: role === "GT" ? `Você está com ${rows.length} clientes na carteira: ${active} ativos e ${onboarding} em onboarding.` : `A operação está com ${rows.length} clientes agora: ${active} ativos e ${onboarding} em onboarding.`, source: "DIRECT_DB_FAST", intent: "operation_total" };
  }

  if (asksClients && countWords.test(contextQ) && /\b(ativo|ativos)\b/.test(contextQ)) {
    let rows = clients.filter((c) => c.lifecycle === "ACTIVE");
    if (role === "GT") rows = rows.filter((c) => c.gt_owner === person);
    if (role === "DESIGN") rows = rows.filter((c) => c.designer_owner === person);
    return { answer: role === "GT" ? `Você está com ${rows.length} clientes ativos na carteira.` : `Temos ${rows.length} clientes ativos na operação.`, source: "DIRECT_DB_FAST", intent: "active_clients" };
  }

  if (mentionedClient && /\b(quem cuida|quem ta com|quem esta com|de quem e|responsavel|gt dele|cs dele|designer dele|quem atende)\b/.test(contextQ)) {
    if (role === "GT" && mentionedClient.gt_owner !== person) return restrictedAnswer();
    if (role === "DESIGN" && mentionedClient.designer_owner !== person) return restrictedAnswer();
    const parts = [mentionedClient.gt_owner ? `GT: ${mentionedClient.gt_owner}` : "GT ainda não definido", mentionedClient.cs_owner ? `CS: ${mentionedClient.cs_owner}` : null, mentionedClient.designer_owner ? `designer: ${mentionedClient.designer_owner}` : null].filter(Boolean);
    return { answer: `${mentionedClient.display_name}: ${parts.join(" · ")}.`, source: "DIRECT_DB_FAST", intent: "client_owners" };
  }

  if (/\b(task|tasks|tarefa|tarefas)\b/.test(contextQ)) {
    let taskPerson: TeamPerson | null = namedMember;
    if (role === "GT" || role === "DESIGN") {
      if (taskPerson && taskPerson.person !== person) return restrictedAnswer();
      taskPerson = roster.find((row) => row.person === person) ?? { person, role, clickup_user: person };
    }
    const assignee = taskPerson?.clickup_user || taskPerson?.person || null;
    const period = periodFromQuestion(contextQ) ?? dayPeriod(0, "hoje");
    const ranking = /\b(quem mais|ranking|por pessoa|por colaborador|cada pessoa|cada colaborador)\b/.test(contextQ);
    const wantsOverdue = /\b(atrasada|atrasadas|atrasado|atrasados|vencida|vencidas|ficou pra tras|ficaram pra tras)\b/.test(contextQ);
    const wantsOpen = /\b(aberta|abertas|aberto|abertos|pendente|pendentes)\b/.test(contextQ) && !/\b(criada|criadas|criado|criados)\b/.test(contextQ);
    const wantsCreated = /\b(criada|criadas|criado|criados|criamos|abriu|abrimos)\b/.test(contextQ);
    const wantsClosed = /\b(feita|feitas|feito|feitos|concluida|concluidas|concluido|concluidos|finalizada|finalizadas|finalizado|finalizados|fez|fizeram)\b/.test(contextQ);

    if (ranking) {
      if (!canSeeTeamWide(role)) return restrictedAnswer();
      const { data, error } = await ops.from("clickup_tasks").select("assignee_names,date_closed").gte("date_closed", period.start).lt("date_closed", period.end).not("assignee_names", "is", null).limit(1500);
      if (error) throw new Error(`direct_db_task_ranking:${error.message}`);
      const counts = new Map<string, number>();
      for (const row of data ?? []) for (const name of String(row.assignee_names ?? "").split(",").map((n) => n.trim()).filter(Boolean)) counts.set(name, (counts.get(name) ?? 0) + 1);
      const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, total], i) => `${i + 1}. ${name}: ${total}`);
      return { answer: lines.length ? `Quem mais concluiu tasks ${period.label}:\n${lines.join("\n")}` : `Não teve task concluída ${period.label}.`, source: "DIRECT_DB_FAST", intent: "task_ranking" };
    }

    if (wantsOverdue || (wantsOpen && !/\b(hoje|ontem|semana|mes)\b/.test(contextQ))) {
      let query = ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("is_closed", false);
      if (wantsOverdue) query = query.not("due_date", "is", null).lt("due_date", new Date().toISOString());
      if (assignee) query = query.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await query;
      if (error) throw new Error(`direct_db_task_open:${error.message}`);
      const total = count ?? 0;
      const ownerText = taskPerson ? ` de ${taskPerson.person}` : " na operação";
      return { answer: wantsOverdue ? `Tem ${total} ${total === 1 ? "task atrasada" : "tasks atrasadas"}${ownerText}.` : `Tem ${total} ${total === 1 ? "task aberta" : "tasks abertas"}${ownerText}.`, source: "DIRECT_DB_FAST", intent: wantsOverdue ? "tasks_overdue" : "tasks_open" };
    }

    const countFor = async (column: "date_closed" | "date_created") => {
      let query = ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).gte(column, period.start).lt(column, period.end);
      if (assignee) query = query.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await query;
      if (error) throw new Error(`direct_db_tasks_${column}:${error.message}`);
      return count ?? 0;
    };
    if (wantsCreated) {
      const total = await countFor("date_created");
      return { answer: `${taskPerson ? taskPerson.person : "A operação"} teve ${total} ${total === 1 ? "task criada" : "tasks criadas"} ${period.label}.`, source: "DIRECT_DB_FAST", intent: "tasks_created" };
    }
    if (wantsClosed) {
      const total = await countFor("date_closed");
      return { answer: `${taskPerson ? taskPerson.person : "A operação"} concluiu ${total} ${total === 1 ? "task" : "tasks"} ${period.label}.`, source: "DIRECT_DB_FAST", intent: "tasks_closed" };
    }
    const [closed, created] = await Promise.all([countFor("date_closed"), countFor("date_created")]);
    return { answer: `${period.label[0].toUpperCase()}${period.label.slice(1)}, ${taskPerson ? taskPerson.person : "a operação"} concluiu ${closed} ${closed === 1 ? "task" : "tasks"}. Foram criadas ${created}.`, source: "DIRECT_DB_FAST", intent: "tasks_snapshot" };
  }

  if (/\b(campanha|campanhas|anuncio|anuncios|meta ads)\b/.test(contextQ) && /\b(rodando|no ar|ativa|ativas|pausada|pausadas|sem campanha|parada|paradas|entrega)\b/.test(contextQ)) {
    const visibleIds = visibleClientIds(clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle)), role, person);
    if (!visibleIds.length) return { answer: "Não encontrei clientes no seu escopo agora.", source: "DIRECT_DB_FAST", intent: "campaign_status" };
    let query = ops.from("campaign_client_latest").select("client_id,display_name,gt_owner,active_campaigns,paused_campaigns,delivery_status,latest_date,age_days").in("client_id", visibleIds).limit(400);
    if (mentionedGt && canSeeTeamWide(role)) query = query.eq("gt_owner", mentionedGt.person);
    const { data, error } = await query;
    if (error) throw new Error(`direct_db_campaigns:${error.message}`);
    let rows = data ?? [];
    const asksRunning = /\b(rodando|no ar|ativa|ativas|entregando)\b/.test(contextQ) && !/\b(sem campanha|pausada|pausadas)\b/.test(contextQ);
    const asksPaused = /\b(pausada|pausadas)\b/.test(contextQ);
    const asksNoCampaign = /\b(sem campanha|sem campanha no ar|parada|paradas)\b/.test(contextQ);
    if (asksRunning) rows = rows.filter((r: any) => Number(r.active_campaigns || 0) > 0 && r.delivery_status === "ACTIVE_DELIVERY");
    else if (asksPaused) rows = rows.filter((r: any) => Number(r.active_campaigns || 0) === 0 && Number(r.paused_campaigns || 0) > 0);
    else if (asksNoCampaign) rows = rows.filter((r: any) => Number(r.active_campaigns || 0) === 0 || ["NO_ACTIVE_CAMPAIGN", "NO_CAMPAIGNS", "NO_DELIVERY"].includes(String(r.delivery_status || "")));
    const state = asksRunning ? "com campanha rodando" : asksPaused ? "com campanha pausada e nenhuma ativa" : "sem campanha ativa no ar";
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} ${state}.`;
    if ((listWords.test(contextQ) || rows.length <= 10) && rows.length) answer += ` ${formatNames(rows.map((r: any) => String(r.display_name)), 15)}.`;
    return { answer, source: "DIRECT_DB_FAST", intent: "campaign_status" };
  }

  if (/\b(precisa de atencao|precisam de atencao|risco|churnar|churn|dando problema|problema|reclamando|reclamacao|insatisfeito|insatisfeitos)\b/.test(contextQ)) {
    if (role === "DESIGN") return restrictedAnswer();
    const visibleIds = visibleClientIds(clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle)), role, person);
    let query = ops.from("client_health_board").select("client_id,display_name,priority,gt_owner,external_risk_level,external_summary,external_recommended_action,sentimento,sinais_alerta,reclamacoes,prioridade").in("client_id", visibleIds).order("prioridade", { ascending: false, nullsFirst: false }).limit(120);
    if (mentionedGt && canSeeTeamWide(role)) query = query.eq("gt_owner", mentionedGt.person);
    const { data, error } = await query;
    if (error) throw new Error(`direct_db_health:${error.message}`);
    let rows = data ?? [];
    const complaintMode = /\b(reclamando|reclamacao|reclamacoes)\b/.test(contextQ);
    const churnMode = /\b(churnar|churn|risco)\b/.test(contextQ);
    rows = rows.filter((r: any) => complaintMode ? Boolean(String(r.reclamacoes ?? "").trim()) : churnMode ? ["ATTENTION", "FOLLOW_UP"].includes(String(r.priority || "")) || /high|alto|critical|critico/i.test(String(r.external_risk_level || "")) : ["ATTENTION", "FOLLOW_UP"].includes(String(r.priority || "")));
    if (!rows.length) return { answer: "Não encontrei nenhum cliente com sinal claro nessa condição agora.", source: "DIRECT_DB_FAST", intent: "client_health" };
    const lines = rows.slice(0, 10).map((r: any) => `• ${r.display_name}: ${clip(r.reclamacoes || r.sinais_alerta || r.external_summary || "há sinais de atenção registrados", 180)}`);
    return { answer: `Encontrei ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} que merecem atenção agora.${lines.length ? `\n${lines.join("\n")}` : ""}${rows.length > 10 ? `\n…e mais ${rows.length - 10}.` : ""}`, source: "DIRECT_DB_FAST", intent: "client_health" };
  }

  if (/\b(quem esta atrasado|quem ta atrasado|o que esta atrasado|o que ta atrasado|ficou pra tras|ficaram pra tras|pendencias atrasadas)\b/.test(contextQ)) {
    const visibleIds = visibleClientIds(clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle)), role, person);
    const nowIso = new Date().toISOString();
    const [workRes, clickRes] = await Promise.all([
      ops.from("work_items").select("client_id,title,target_person,due_at").in("client_id", visibleIds).in("status", ["OPEN", "IN_PROGRESS", "WAITING", "SNOOZED"]).not("due_at", "is", null).lt("due_at", nowIso).order("due_at").limit(80),
      ops.from("clickup_tasks").select("client_id,name,assignee_names,due_date").in("client_id", visibleIds).eq("is_closed", false).not("due_date", "is", null).lt("due_date", nowIso).order("due_date").limit(80),
    ]);
    if (workRes.error) throw new Error(`direct_db_late_work:${workRes.error.message}`);
    if (clickRes.error) throw new Error(`direct_db_late_clickup:${clickRes.error.message}`);
    const work = workRes.data ?? [], click = clickRes.data ?? [];
    const clientMap = new Map(clients.map((c) => [c.id, c.display_name]));
    const sample = [...work.map((r: any) => ({ client: clientMap.get(String(r.client_id)) || "Sem cliente", item: r.title })), ...click.map((r: any) => ({ client: clientMap.get(String(r.client_id)) || "Sem cliente", item: r.name }))].slice(0, 8);
    return { answer: `Temos ${work.length + click.length} pendências vencidas no seu escopo agora: ${work.length} operacionais e ${click.length} tasks do ClickUp.${sample.length ? `\n${sample.map((r) => `• ${r.client}: ${clip(r.item, 120)}`).join("\n")}` : ""}`, source: "DIRECT_DB_FAST", intent: "overdue_snapshot" };
  }

  if (/\b(devendo|inadimplente|inadimplentes|mensalidade|mrr|vence essa semana|vencem essa semana|pagamento atrasado|pagamentos atrasados)\b/.test(contextQ)) {
    if (!canSeeFinance(role, person)) return restrictedAnswer();
    const { data, error } = await ops.from("client_finance_controls").select("client_id,payment_status,operational_status,monthly_value,next_due_date,overdue_since,pause_reason").limit(300);
    if (error) throw new Error(`direct_db_finance:${error.message}`);
    const rows = data ?? [];
    const nameMap = new Map(clients.map((c) => [c.id, c.display_name]));
    if (/\b(devendo|inadimplente|inadimplentes|pagamento atrasado|pagamentos atrasados)\b/.test(contextQ)) {
      const late = rows.filter((r: any) => Boolean(r.overdue_since));
      return { answer: late.length ? `Temos ${late.length} ${late.length === 1 ? "cliente com pagamento atrasado" : "clientes com pagamento atrasado"}: ${formatNames(late.map((r: any) => nameMap.get(String(r.client_id)) || "Cliente sem nome"), 20)}.` : "Não encontrei cliente com pagamento atrasado registrado agora.", source: "DIRECT_DB_FAST", intent: "finance_overdue" };
    }
    if (/\b(mensalidade|mrr)\b/.test(contextQ) && countWords.test(contextQ)) {
      const total = rows.reduce((sum: number, r: any) => sum + Number(r.monthly_value || 0), 0);
      return { answer: `O valor mensal registrado soma R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`, source: "DIRECT_DB_FAST", intent: "finance_mrr" };
    }
  }

  if (/\b(churn|churns|churned|saiu|sairam|perdemos|encerrado|encerraram)\b/.test(contextQ) && /\b(cliente|clientes|quem|quantos|quantas|esse mes|este mes|hoje|ontem|semana)\b/.test(contextQ)) {
    if (role === "GT" || role === "DESIGN") return restrictedAnswer();
    const period = periodFromQuestion(contextQ) ?? monthPeriod();
    const { data, error } = await ops.from("clients").select("display_name,saida").eq("lifecycle", "CHURNED").gte("saida", period.start.slice(0, 10)).lt("saida", period.end.slice(0, 10)).order("saida", { ascending: false });
    if (error) throw new Error(`direct_db_churn:${error.message}`);
    const rows = data ?? [];
    return { answer: rows.length ? `Tivemos ${rows.length} ${rows.length === 1 ? "churn" : "churns"} ${period.label}: ${formatNames(rows.map((r: any) => String(r.display_name)), 20)}.` : `Não encontrei churn registrado ${period.label}.`, source: "DIRECT_DB_FAST", intent: "churn_period" };
  }

  return null;
}

async function cloudflareFallback(authHeader: string, question: string): Promise<string> {
  let conversationId = "";
  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, { method: "POST", headers: { Authorization: authHeader, "content-type": "application/json" }, body: JSON.stringify(body) });
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
    const created = await post("/conversations/create", { client_id: null, title: "OpsQuestion · fallback" });
    conversationId = String(created?.conversation?.id || "");
    if (!conversationId) throw new Error("cloudflare_conversation_missing");
    const result = await post("/chat", { conversation_id: conversationId, message: question });
    const answer = safeAnswer({ answer: result?.assistant_message?.content }, "");
    if (!answer) throw new Error("cloudflare_empty_ai_answer");
    return answer;
  } finally {
    if (conversationId) { try { await post("/conversations/delete", { conversation_id: conversationId }); } catch {} }
  }
}

function operationalPrompt(person: string, role: string, scopeInstruction: string, allowedClientsText: string, question: string, previous?: { question?: string; answer?: string } | null): string {
  const conversationContext = previous?.question ? `CONTEXTO DA ÚLTIMA TROCA (use apenas se a pergunta atual for continuação):\nPergunta anterior: ${clip(previous.question, 700)}\nResposta anterior: ${clip(previous.answer, 1200)}` : "";
  return [
    "Você é o OpsQuestion, copiloto operacional interno da Leonardo Imobi.",
    "Fale como alguém da equipe de operações: português do Brasil, natural, direto, curto e útil. Não fale como banco de dados, documentação técnica ou suporte de TI.",
    "REGRA CENTRAL: entenda primeiro a intenção operacional da pergunta; depois consulte os dados; só então responda em linguagem humana.",
    "Nunca mostre ao usuário nomes de tabela, schema, coluna, enum, stage_code, current_stage, códigos em CAIXA_ALTA ou identificadores internos, a menos que ele peça explicitamente uma explicação técnica do banco.",
    "Traduza estados internos para o jeito da equipe: INTRO_MEETING = primeira reunião de apresentação; PRODUCT_PERSONA_MEETING = reunião de Produto e Persona; INTEGRATION_MEETING = reunião de integração com o GT; RAW_ASSETS = envio/organização dos materiais; campanha no ar = onboarding concluído.",
    "Vocabulário da operação: 'carteira do Yuri/Felipe/Rodrigo' = clientes atribuídos ao GT; se não disser 'ativos', conte ativos + onboarding e separe os dois números. 'task feita' = task concluída no ClickUp. 'quem está parado/atrasado' = procure falta de avanço, prazos vencidos e pendências e explique o motivo em português.",
    "Reuniões: 'em integração' significa cliente cuja etapa atual é integração com o GT. 'integração marcada/agendada' significa que existe data agendada. 'aguardando integração' significa que está esperando agendamento. Não misture essas três coisas.",
    "Campanhas: 'rodando/no ar' = existe campanha ativa com entrega; 'pausada' = sem campanha ativa e com campanha pausada; 'sem campanha' = nenhuma campanha ativa. Explique o resultado sem mostrar delivery_status ou códigos internos.",
    "Saúde: 'dando problema', 'precisa de atenção', 'pode churnar', 'reclamando' devem virar uma síntese de nomes + motivo + ação recomendada quando houver evidência.",
    "WhatsApp: quando perguntarem o que o cliente falou, reclamou, pediu ou combinou, sintetize as mensagens relevantes com contexto e data; não despeje mensagens cruas sem necessidade.",
    "Responsabilidade: 'quem cuida', 'de quem é', 'quem deveria resolver' = responda com pessoas/áreas reais. Se não houver responsável, diga 'ainda não foi atribuído'.",
    "Datas relativas como hoje, ontem, esta semana e últimos dias usam America/Sao_Paulo automaticamente. Não pergunte timezone.",
    "Aceite erro de digitação, abreviação e fala informal: 'qnts cliente yuri tem', 'tasks hj', 'qm ta atrasado' devem ser entendidos normalmente.",
    "Se houver uma interpretação claramente mais provável, assuma e responda. Se ajudar, diga em uma frase curta 'Entendi como...' sem transformar isso em interrogatório.",
    "Só peça esclarecimento quando existirem duas interpretações humanas realmente plausíveis e a resposta mudaria bastante. Nesse caso faça UMA pergunta curta em linguagem comum. Exemplo: 'Você quer quem está nessa etapa agora ou quem já tem a reunião marcada?' Nunca ofereça opções com nomes de colunas/códigos.",
    "Se a pergunta for ambígua mas você puder entregar os dois números de forma útil, entregue os dois em vez de perguntar. Exemplo: 'quantas tasks tivemos hoje?' => concluídas + criadas.",
    "Use SOMENTE dados encontrados na base operacional. Nunca invente fatos, números, responsáveis, datas, status ou evidências. Se não houver evidência suficiente, diga em português simples o que não encontrou.",
    "A consulta é SOMENTE LEITURA. Nunca execute nem proponha alteração de dados.",
    `Usuário autenticado: ${person} (${role}).`,
    `ESCOPO OBRIGATÓRIO: ${scopeInstruction}`,
    allowedClientsText,
    conversationContext,
    `PERGUNTA ATUAL: ${question}`,
  ].filter(Boolean).join("\n\n");
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
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
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
  if (!person || !(approvals ?? []).length) return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
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
    scopeInstruction = `Responda somente sobre clientes da carteira de ${person}.`;
    const { data } = await ops.from("clients").select("id,display_name").eq("gt_owner", person).in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name");
    scopedClients = (data ?? []).map((row: any) => ({ id: String(row.id), display_name: String(row.display_name) }));
  } else if (role === "DESIGN") {
    scopeLabel = "DESIGN_SELF_READ_ONLY";
    scopeInstruction = `Priorize somente produtividade própria e trabalho de design associado a ${person}. Não revele saúde, financeiro ou carteira de outros usuários.`;
  } else if (role === "CS") {
    scopeLabel = "CS_SHARED_BASE_READ_ONLY";
    scopeInstruction = "Os CS atendem a base compartilhada; pode consultar os clientes da operação em modo somente leitura.";
  } else if (role === "MGMT" || role === "AI") {
    scopeLabel = "FULL_READ_ONLY";
    scopeInstruction = "Pode consultar a visão operacional ampla em modo somente leitura.";
  }

  const { data: previousRows } = await ops.from("opsquestion_interactions").select("question,answer,created_at").eq("user_key", user.id).eq("status", "SUCCESS").order("created_at", { ascending: false }).limit(1);
  const previous = previousRows?.[0] ?? null;
  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const direct = await directDbAnswer(ops, role, String(person), question, previous?.question ?? null);
    if (direct) {
      const latency = Date.now() - started;
      await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "SUCCESS", source: direct.source, answer: direct.answer.slice(0, 20000), request_id: requestId, latency_ms: latency, answered_at: new Date().toISOString() });
      return reply({ ok: true, name: "OpsQuestion", answer: direct.answer, source: "Base operacional · resposta rápida", read_only: true, mode: direct.source, intent: direct.intent, scope: scopeLabel, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
    }
  } catch (err) {
    console.error("[opsquestion-fast-lane]", errorText(err));
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount } = await ops.from("opsquestion_interactions").select("id", { count: "exact", head: true }).eq("user_key", user.id).gte("created_at", since).neq("source", "DIRECT_DB_FAST");
  if ((recentCount ?? 0) >= AI_RATE_LIMIT_PER_MINUTE) return reply({ ok: false, error: "Muitas perguntas analíticas em sequência. Aguarde alguns segundos." }, 429);

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
  await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "PENDING", source: routeMode, request_id: requestId });

  const allowedClientsText = role === "GT" ? `Clientes permitidos nesta carteira: ${scopedClients.length ? scopedClients.map((c) => c.display_name).join("; ") : "nenhum cliente ativo/onboarding encontrado"}.` : "";
  const prompt = operationalPrompt(String(person), role, scopeInstruction, allowedClientsText, question, previous);

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
        body: JSON.stringify({ question: prompt, original_question: question, source: "OpsQuestion", request_id: requestId, user: { person, role, access_level: accessLevel, scope: scopeLabel, allowed_clients: scopedClients }, constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true, human_language: true, hide_technical_identifiers: true, infer_common_operational_meaning: true } }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      answer = response.ok ? safeAnswer(parsed, raw) : null;
      if (!response.ok) primaryError = `http_${response.status}`;
      else if (!answer) primaryError = "empty_ai_answer";
    } catch (err) {
      primaryError = err instanceof DOMException && err.name === "AbortError" ? "direct_ai_timeout" : errorText(err);
    } finally { clearTimeout(timeout); }
  } else if (webhookUrl && !readSecret) primaryError = "missing_ai_read_secret";
  else primaryError = "direct_ai_not_configured";

  if (!answer) {
    try { answer = await cloudflareFallback(authHeader, question); routeMode = "CLOUDFLARE_AI_FALLBACK"; }
    catch (err) { fallbackError = errorText(err); }
  }

  const latency = Date.now() - started;
  if (!answer) {
    const error = [primaryError, fallbackError].filter(Boolean).join(" | ").slice(0, 500) || "ai_unavailable";
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
    return reply({ ok: false, error: "Falha temporária no OpsQuestion.", detail: error, request_id: requestId }, 502);
  }

  answer = humanizeAiAnswer(answer);
  await ops.from("opsquestion_interactions").update({ status: "SUCCESS", source: routeMode, answer: answer.slice(0, 20000), error: primaryError && routeMode === "CLOUDFLARE_AI_FALLBACK" ? `primary_failed:${primaryError}`.slice(0, 500) : null, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
  return reply({ ok: true, name: "OpsQuestion", answer, source: routeMode === "CLOUDFLARE_AI_FALLBACK" ? "Base operacional · IA de contingência" : "Base operacional · análise IA", read_only: true, mode: routeMode, scope: scopeLabel, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
});
