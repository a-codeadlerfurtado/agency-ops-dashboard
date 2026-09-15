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

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const errText = (e) => String(e instanceof Error ? e.message : e).slice(0, 500);
const clip = (v, max = 360) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const norm = (v) => String(v ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();
const fmtDate = (v) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
}).format(new Date(v));
const fmtDateTime = (v) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date(v));
const formatNames = (names, max = 15) => {
  const clean = names.filter(Boolean);
  if (!clean.length) return "";
  const shown = clean.slice(0, max).join(", ");
  return clean.length > max ? `${shown} e mais ${clean.length - max}` : shown;
};

function safeAnswer(body, raw) {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const v of candidates) if (typeof v === "string" && v.trim()) return v.trim();
  if (!body && raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

const TECH = [
  [/\bINTEGRATION_MEETING\b/gi, "reunião de integração com o GT"],
  [/\bPRODUCT_PERSONA_MEETING\b/gi, "reunião de Produto e Persona"],
  [/\bINTRO_MEETING\b/gi, "primeira reunião de apresentação"],
  [/\bRAW_ASSETS\b/gi, "envio/organização dos materiais"],
  [/\bCAMPAIGN_LAUNCH\b/gi, "campanha no ar"],
  [/\bCREATIVE_PRODUCTION\b/gi, "produção de criativos"],
  [/\bACTIVE_DELIVERY\b/gi, "campanha rodando"],
  [/\bNO_DELIVERY\b/gi, "sem entrega"],
  [/\bNO_ACTIVE_CAMPAIGN\b/gi, "sem campanha ativa"],
  [/\bWAITING_SCHEDULING\b/gi, "aguardando agendamento"],
  [/\bcurrent_stage\b/gi, "etapa atual"],
  [/\bstage_code\b/gi, "etapa"],
  [/\bgt_owner\b/gi, "GT responsável"],
  [/\bcs_owner\b/gi, "CS responsável"],
  [/\bdesigner_owner\b/gi, "designer responsável"],
  [/\bagency_ops\b/gi, "base operacional"],
];
function humanize(answer) {
  let out = String(answer || "").trim();
  for (const [a, b] of TECH) out = out.replace(a, b);
  return out
    .replace(/\b(schema|tabela|coluna|enum|campo)\s+["'`]?([a-z0-9_.-]+)["'`]?/gi, "informação registrada")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

function mentionedPerson(question, roster, roleFilter = null) {
  const q = norm(question);
  const tokens = new Set(q.split(" ").filter(Boolean));
  const candidates = roster
    .filter((r) => !roleFilter || r.role === roleFilter)
    .map((r) => {
      const full = norm(r.person);
      if (q.includes(full)) return { r, score: 1000 + full.length };
      const parts = full.split(" ").filter((p) => p.length >= 3);
      return { r, score: parts.filter((p) => tokens.has(p)).reduce((s, p) => s + p.length, 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0].r;
}

function resolveClient(question, clients) {
  const q = ` ${norm(question)} `;
  let best = null, score = 0;
  for (const c of clients) {
    const name = norm(c.display_name);
    if (!name || name.length < 3) continue;
    if (q.includes(` ${name} `) && name.length + 1000 > score) {
      best = c; score = name.length + 1000; continue;
    }
    const parts = name.split(" ").filter((p) => p.length >= 4);
    const s = parts.filter((p) => q.includes(` ${p} `)).reduce((a, p) => a + p.length, 0);
    if (s >= Math.max(5, Math.floor(name.length * 0.5)) && s > score) { best = c; score = s; }
  }
  return best;
}

function saoPauloParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}
function dayPeriod(offset, label) {
  const { year, month, day } = saoPauloParts();
  const start = Date.UTC(year, month - 1, day + offset, 3, 0, 0, 0);
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString(), label };
}
function weekPeriod() {
  const { year, month, day } = saoPauloParts();
  const d = new Date(Date.UTC(year, month - 1, day));
  const sinceMon = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(year, month - 1, day - sinceMon, 3, 0, 0, 0);
  return { start: new Date(start).toISOString(), end: new Date().toISOString(), label: "nesta semana" };
}
function monthPeriod() {
  const { year, month } = saoPauloParts();
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 3)).toISOString(),
    end: new Date(Date.UTC(year, month, 1, 3)).toISOString(),
    label: "neste mês",
  };
}
function periodFromQuestion(q) {
  if (/\bontem\b/.test(q)) return dayPeriod(-1, "ontem");
  if (/\bhoje\b/.test(q)) return dayPeriod(0, "hoje");
  if (/\b(esta semana|essa semana|semana atual|desde segunda)\b/.test(q)) return weekPeriod();
  if (/\b(este mes|esse mes|mes atual)\b/.test(q)) return monthPeriod();
  if (/\b(ultimos 7 dias|sete dias)\b/.test(q)) return { start: new Date(Date.now() - 7 * 86_400_000).toISOString(), end: new Date().toISOString(), label: "nos últimos 7 dias" };
  return null;
}
const teamWide = (role) => ["MGMT", "AI", "CS"].includes(role);
const financeAllowed = (role, person) => role === "MGMT" || person === "Adler Furtado";
const restricted = () => ({ answer: "Essa informação fica fora do seu escopo de acesso. Posso consultar o que estiver dentro da sua carteira/área.", source: "DIRECT_DB_FAST", intent: "scope_restriction" });
function looksLikeFollowUp(q) {
  const words = q.split(" ").filter(Boolean);
  if (words.length > 7) return false;
  return /^(por cliente|por pessoa|por gt|por vendedor)$/.test(q)
    || /\b(e|eles|elas|deles|delas|esses|essas|isso|hoje|ontem|agora|cliente|clientes|pessoa|pessoas|yuri|felipe|rodrigo|hugo|qual|quais)\b/.test(q);
}
function stageIntent(q) {
  const scheduled = /\b(marcad[ao]s?|agendad[ao]s?|agenda|quando e|quando vai|data da)\b/.test(q);
  const waiting = /\b(aguardando|esperando|falta marcar|sem marcar|pendente de integracao)\b/.test(q);
  if (/\b(primeira reuniao|1 reuniao|reuniao de apresentacao|apresentacao inicial)\b/.test(q)) return { stage: "INTRO_MEETING", mode: "CURRENT", human: "primeira reunião de apresentação" };
  if (/\b(produto e persona|produto persona|segunda reuniao|2 reuniao|reuniao de produto)\b/.test(q)) return { stage: "PRODUCT_PERSONA_MEETING", mode: "CURRENT", human: "reunião de Produto e Persona" };
  if (/\b(reuniao de integracao|integracao com gt|integracao do gt|em integracao|na integracao|integracao)\b/.test(q)) return { stage: "INTEGRATION_MEETING", mode: scheduled ? "SCHEDULED" : waiting ? "WAITING" : "CURRENT", human: scheduled ? "integração já marcada" : waiting ? "aguardando marcar a integração" : "reunião de integração com o GT" };
  if (/\b(material|materiais|aguardando material|envio de material)\b/.test(q) && /\b(onboarding|etapa|aguardando|cliente|clientes)\b/.test(q)) return { stage: "RAW_ASSETS", mode: "CURRENT", human: "envio/organização dos materiais" };
  return null;
}
function visibleClients(clients, role, person) {
  if (role === "GT") return clients.filter((c) => c.gt_owner === person);
  if (role === "DESIGN") return clients.filter((c) => c.designer_owner === person);
  return clients;
}

async function fastAnswer(ops, role, person, question, previousQuestion) {
  const currentQ = norm(question);
  const contextQ = previousQuestion && looksLikeFollowUp(currentQ) ? `${norm(previousQuestion)} ${currentQ}`.trim() : currentQ;
  const [{ data: rosterRows, error: rErr }, { data: clientRows, error: cErr }] = await Promise.all([
    ops.from("team_roster").select("person,role,clickup_user").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,saida").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).order("display_name").limit(500),
  ]);
  if (rErr) throw new Error(`roster:${rErr.message}`);
  if (cErr) throw new Error(`clients:${cErr.message}`);
  const roster = rosterRows ?? [];
  const clients = clientRows ?? [];
  const activeScope = visibleClients(clients.filter((c) => ["ACTIVE", "ONBOARDING"].includes(c.lifecycle)), role, person);
  const visibleIds = activeScope.map((c) => c.id);
  const countWords = /\b(quanto|quantos|quantas|total|numero|tivemos|tem|temos)\b/;
  const listWords = /\b(qual|quais|quem|lista|listar|mostra|mostre|nomes|sao)\b/;
  const asksClients = /\b(cliente|clientes|carteira|carteiras)\b/.test(contextQ);
  const gt = mentionedPerson(currentQ, roster, "GT") || mentionedPerson(contextQ, roster, "GT");
  const member = mentionedPerson(currentQ, roster) || mentionedPerson(contextQ, roster);
  const client = resolveClient(currentQ, clients) || resolveClient(contextQ, clients);

  const st = stageIntent(contextQ);
  if (st && /\b(cliente|clientes|quantos|quantas|quem|quais|estao|tem|temos|onboarding|reuniao|integracao|material|materiais)\b/.test(contextQ)) {
    if (role === "DESIGN") return restricted();
    let q = ops.from("gt_onboarding_worklist").select("display_name,gt_owner,current_stage,integration_status,integration_bucket,integration_meet_scheduled_for").order("display_name");
    if (role === "GT") q = q.eq("gt_owner", person);
    if (gt && teamWide(role)) q = q.eq("gt_owner", gt.person);
    const { data, error } = await q;
    if (error) throw new Error(`onboarding_stage:${error.message}`);
    let rows = data ?? [];
    if (st.stage === "INTEGRATION_MEETING" && st.mode === "SCHEDULED") rows = rows.filter((r) => r.integration_status === "SCHEDULED" || r.integration_meet_scheduled_for);
    else if (st.stage === "INTEGRATION_MEETING" && st.mode === "WAITING") rows = rows.filter((r) => r.integration_status === "PENDING" && r.integration_bucket === "WAITING_SCHEDULING");
    else rows = rows.filter((r) => r.current_stage === st.stage);
    const owner = gt ? ` do ${gt.person}` : "";
    if (!rows.length) return { answer: `Não encontrei cliente${owner} nessa condição agora.`, source: "DIRECT_DB_FAST", intent: "onboarding_stage" };
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"}${owner} ${st.mode === "CURRENT" ? `na etapa de ${st.human}` : st.human}: ${formatNames(rows.map((r) => r.display_name))}.`;
    if (st.mode === "SCHEDULED") {
      const details = rows.filter((r) => r.integration_meet_scheduled_for).slice(0, 8).map((r) => `• ${r.display_name}: ${fmtDateTime(r.integration_meet_scheduled_for)}`);
      if (details.length) answer += `\n${details.join("\n")}`;
    }
    return { answer, source: "DIRECT_DB_FAST", intent: "onboarding_stage" };
  }

  if (gt && asksClients) {
    if (role === "GT" && gt.person !== person) return restricted();
    if (role === "DESIGN") return restricted();
    const rows = clients.filter((c) => c.gt_owner === gt.person && ["ACTIVE", "ONBOARDING"].includes(c.lifecycle));
    const active = rows.filter((c) => c.lifecycle === "ACTIVE");
    const onboarding = rows.filter((c) => c.lifecycle === "ONBOARDING");
    const onlyOnboarding = contextQ.includes("onboarding");
    const onlyActive = /\b(ativo|ativos)\b/.test(contextQ) && !onlyOnboarding;
    const selected = onlyOnboarding ? onboarding : onlyActive ? active : rows;
    let answer = `${gt.person} está com ${selected.length} ${selected.length === 1 ? "cliente" : "clientes"}${onlyOnboarding ? " em onboarding" : onlyActive ? " ativos" : " na carteira"}.`;
    if (!onlyOnboarding && !onlyActive) answer += ` São ${active.length} ativos e ${onboarding.length} em onboarding.`;
    if (listWords.test(contextQ) || (!countWords.test(contextQ) && asksClients)) answer += `\n${selected.map((c) => `• ${c.display_name}`).join("\n")}`;
    return { answer, source: "DIRECT_DB_FAST", intent: "gt_portfolio" };
  }

  if (asksClients && /\b(cada gt|por gt|todos os gt|carteiras dos gt|carteira dos gt)\b/.test(contextQ)) {
    if (!teamWide(role)) return restricted();
    const map = new Map();
    for (const c of clients.filter((x) => ["ACTIVE", "ONBOARDING"].includes(x.lifecycle) && x.gt_owner)) {
      const v = map.get(c.gt_owner) ?? { active: 0, onboarding: 0 };
      c.lifecycle === "ACTIVE" ? v.active++ : v.onboarding++;
      map.set(c.gt_owner, v);
    }
    const lines = [...map.entries()].map(([name, v]) => ({ name, ...v, total: v.active + v.onboarding })).sort((a, b) => b.total - a.total).map((x) => `• ${x.name}: ${x.total} (${x.active} ativos + ${x.onboarding} onboarding)`);
    return { answer: `As carteiras estão assim agora:\n${lines.join("\n")}`, source: "DIRECT_DB_FAST", intent: "gt_portfolio_breakdown" };
  }

  if (contextQ.includes("onboarding") && /\b(qual|quais|quem|lista|listar|estao|cliente|clientes|quantos|quantas|total|tem|temos)\b/.test(contextQ)) {
    const rows = activeScope.filter((c) => c.lifecycle === "ONBOARDING");
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} em onboarding agora.`;
    if ((listWords.test(contextQ) || /\bestao\b/.test(contextQ)) && rows.length) answer += `\n${rows.map((c) => `• ${c.display_name}${c.gt_owner ? ` — GT: ${c.gt_owner}` : " — GT ainda não definido"}`).join("\n")}`;
    return { answer, source: "DIRECT_DB_FAST", intent: "onboarding" };
  }

  if (asksClients && countWords.test(contextQ) && contextQ.includes("operacao") && !/\b(ativo|ativos)\b/.test(contextQ)) {
    const active = activeScope.filter((c) => c.lifecycle === "ACTIVE").length;
    const onboarding = activeScope.filter((c) => c.lifecycle === "ONBOARDING").length;
    return { answer: role === "GT" ? `Você está com ${activeScope.length} clientes na carteira: ${active} ativos e ${onboarding} em onboarding.` : `A operação está com ${activeScope.length} clientes agora: ${active} ativos e ${onboarding} em onboarding.`, source: "DIRECT_DB_FAST", intent: "operation_total" };
  }
  if (asksClients && countWords.test(contextQ) && /\b(ativo|ativos)\b/.test(contextQ)) {
    const total = activeScope.filter((c) => c.lifecycle === "ACTIVE").length;
    return { answer: role === "GT" ? `Você está com ${total} clientes ativos na carteira.` : `Temos ${total} clientes ativos na operação.`, source: "DIRECT_DB_FAST", intent: "active_clients" };
  }

  if (client && /\b(quem cuida|quem ta com|quem esta com|de quem e|responsavel|gt dele|cs dele|designer dele|quem atende)\b/.test(contextQ)) {
    if (role === "GT" && client.gt_owner !== person) return restricted();
    if (role === "DESIGN" && client.designer_owner !== person) return restricted();
    const parts = [client.gt_owner ? `GT: ${client.gt_owner}` : "GT ainda não definido", client.cs_owner ? `CS: ${client.cs_owner}` : null, client.designer_owner ? `designer: ${client.designer_owner}` : null].filter(Boolean);
    return { answer: `${client.display_name}: ${parts.join(" · ")}.`, source: "DIRECT_DB_FAST", intent: "client_owners" };
  }

  if (/\b(task|tasks|tarefa|tarefas)\b/.test(contextQ)) {
    let taskPerson = member;
    if (["GT", "DESIGN"].includes(role)) {
      if (taskPerson && taskPerson.person !== person) return restricted();
      taskPerson = roster.find((r) => r.person === person) ?? { person, role, clickup_user: person };
    }
    const assignee = taskPerson?.clickup_user || taskPerson?.person || null;
    const period = periodFromQuestion(contextQ) ?? dayPeriod(0, "hoje");
    const ranking = /\b(quem mais|ranking|por pessoa|por colaborador|cada pessoa|cada colaborador)\b/.test(contextQ);
    const overdue = /\b(atrasada|atrasadas|atrasado|atrasados|vencida|vencidas|ficou pra tras|ficaram pra tras)\b/.test(contextQ);
    const open = /\b(aberta|abertas|aberto|abertos|pendente|pendentes)\b/.test(contextQ) && !/\b(criada|criadas|criado|criados)\b/.test(contextQ);
    const created = /\b(criada|criadas|criado|criados|criamos|abriu|abrimos)\b/.test(contextQ);
    const closed = /\b(feita|feitas|feito|feitos|concluida|concluidas|concluido|concluidos|finalizada|finalizadas|finalizado|finalizados|fez|fizeram)\b/.test(contextQ);
    if (ranking) {
      if (!teamWide(role)) return restricted();
      const { data, error } = await ops.from("clickup_tasks").select("assignee_names,date_closed").gte("date_closed", period.start).lt("date_closed", period.end).not("assignee_names", "is", null).limit(1500);
      if (error) throw new Error(`task_ranking:${error.message}`);
      const counts = new Map();
      for (const row of data ?? []) for (const n of String(row.assignee_names ?? "").split(",").map((x) => x.trim()).filter(Boolean)) counts.set(n, (counts.get(n) ?? 0) + 1);
      const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, t], i) => `${i + 1}. ${n}: ${t}`);
      return { answer: lines.length ? `Quem mais concluiu tasks ${period.label}:\n${lines.join("\n")}` : `Não teve task concluída ${period.label}.`, source: "DIRECT_DB_FAST", intent: "task_ranking" };
    }
    if (overdue || (open && !/\b(hoje|ontem|semana|mes)\b/.test(contextQ))) {
      let q = ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("is_closed", false);
      if (overdue) q = q.not("due_date", "is", null).lt("due_date", new Date().toISOString());
      if (assignee) q = q.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await q;
      if (error) throw new Error(`task_open:${error.message}`);
      return { answer: `Tem ${count ?? 0} ${overdue ? "tasks atrasadas" : "tasks abertas"}${taskPerson ? ` de ${taskPerson.person}` : " na operação"}.`, source: "DIRECT_DB_FAST", intent: overdue ? "tasks_overdue" : "tasks_open" };
    }
    const countFor = async (column) => {
      let q = ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).gte(column, period.start).lt(column, period.end);
      if (assignee) q = q.ilike("assignee_names", `%${assignee}%`);
      const { count, error } = await q;
      if (error) throw new Error(`tasks_${column}:${error.message}`);
      return count ?? 0;
    };
    if (created) { const total = await countFor("date_created"); return { answer: `${taskPerson ? taskPerson.person : "A operação"} teve ${total} ${total === 1 ? "task criada" : "tasks criadas"} ${period.label}.`, source: "DIRECT_DB_FAST", intent: "tasks_created" }; }
    if (closed) { const total = await countFor("date_closed"); return { answer: `${taskPerson ? taskPerson.person : "A operação"} concluiu ${total} ${total === 1 ? "task" : "tasks"} ${period.label}.`, source: "DIRECT_DB_FAST", intent: "tasks_closed" }; }
    const [done, made] = await Promise.all([countFor("date_closed"), countFor("date_created")]);
    return { answer: `${period.label[0].toUpperCase()}${period.label.slice(1)}, ${taskPerson ? taskPerson.person : "a operação"} concluiu ${done} ${done === 1 ? "task" : "tasks"}. Foram criadas ${made}.`, source: "DIRECT_DB_FAST", intent: "tasks_snapshot" };
  }

  if (/\b(campanha|campanhas|anuncio|anuncios|meta ads)\b/.test(contextQ) && /\b(rodando|no ar|ativa|ativas|pausada|pausadas|sem campanha|parada|paradas|entrega|sem entrega|desatualizada|desatualizadas)\b/.test(contextQ)) {
    if (!visibleIds.length) return { answer: "Não encontrei clientes no seu escopo agora.", source: "DIRECT_DB_FAST", intent: "campaign_status" };
    let q = ops.from("campaign_client_latest").select("client_id,display_name,gt_owner,active_campaigns,paused_campaigns,delivery_status,latest_date,age_days").in("client_id", visibleIds).limit(500);
    if (gt && teamWide(role)) q = q.eq("gt_owner", gt.person);
    const { data, error } = await q;
    if (error) throw new Error(`campaigns:${error.message}`);
    let rows = data ?? [];
    const activeNoDelivery = /\b(ativa|ativas|ativa sem entrega|ativas sem entrega)\b/.test(contextQ) && /\bsem entrega\b/.test(contextQ);
    const stale = /\b(desatualizada|desatualizadas|dados desatualizados|stale)\b/.test(contextQ);
    const paused = /\b(pausada|pausadas)\b/.test(contextQ);
    const noCampaign = /\b(sem campanha|sem campanha no ar|parada|paradas)\b/.test(contextQ);
    const running = !activeNoDelivery && !stale && !paused && !noCampaign && /\b(rodando|no ar|ativa|ativas|entregando)\b/.test(contextQ);
    let state = "nessa condição";
    if (activeNoDelivery) { rows = rows.filter((r) => Number(r.active_campaigns || 0) > 0 && String(r.delivery_status) === "NO_DELIVERY"); state = "com campanha ativa, mas sem entrega"; }
    else if (stale) { rows = rows.filter((r) => Number(r.active_campaigns || 0) > 0 && String(r.delivery_status) === "STALE"); state = "com campanha ativa, mas com dados desatualizados"; }
    else if (paused) { rows = rows.filter((r) => Number(r.active_campaigns || 0) === 0 && Number(r.paused_campaigns || 0) > 0); state = "com campanha pausada e nenhuma ativa"; }
    else if (noCampaign) { rows = rows.filter((r) => Number(r.active_campaigns || 0) === 0 || ["NO_ACTIVE_CAMPAIGN", "NO_CAMPAIGNS", "NO_DELIVERY"].includes(String(r.delivery_status || ""))); state = "sem campanha ativa no ar"; }
    else if (running) { rows = rows.filter((r) => Number(r.active_campaigns || 0) > 0 && String(r.delivery_status) === "ACTIVE_DELIVERY"); state = "com campanha rodando e entregando"; }
    let answer = `Temos ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} ${state}.`;
    if (rows.length) answer += ` ${formatNames(rows.map((r) => r.display_name), 20)}.`;
    return { answer, source: "DIRECT_DB_FAST", intent: activeNoDelivery ? "campaign_active_no_delivery" : "campaign_status" };
  }

  const salesIntent = /\b(vendeu|venderam|vendas|venda|mais vendeu|vendeu mais|ranking de vendas)\b/.test(contextQ);
  if (salesIntent) {
    if (role === "DESIGN") return restricted();
    const { data, error } = await ops.from("weekly_commercial_reports")
      .select("client_id,week_start,week_end,gt_owner,metrics,commercial_leads,meta_leads,generated_at")
      .order("week_end", { ascending: false })
      .order("generated_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(`sales_reports:${error.message}`);
    let rows = data ?? [];
    if (role === "GT") rows = rows.filter((r) => r.gt_owner === person);
    if (gt && teamWide(role)) rows = rows.filter((r) => r.gt_owner === gt.person);
    if (!rows.length) return { answer: "Ainda não tenho relatório comercial suficiente para dizer quem vendeu mais.", source: "DIRECT_DB_FAST", intent: "sales_ranking" };
    const latestWeek = rows[0].week_end;
    rows = rows.filter((r) => r.week_end === latestWeek);
    const clientMap = new Map(clients.map((c) => [c.id, c.display_name]));
    const byClient = new Map();
    for (const r of rows) {
      if (!visibleIds.includes(r.client_id) && !teamWide(role)) continue;
      const name = clientMap.get(r.client_id) || "Cliente sem nome";
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, { name, sales: Number(r.metrics?.sales || 0), proposals: Number(r.metrics?.proposals || 0), visits: Number(r.metrics?.visits_completed || 0) });
    }
    const ranking = [...byClient.values()].sort((a, b) => b.sales - a.sales || b.proposals - a.proposals);
    const start = rows[0]?.week_start;
    const periodText = start && latestWeek ? `${fmtDate(start)} a ${fmtDate(latestWeek)}` : "no relatório mais recente";
    if (!ranking.length) return { answer: `Ainda não tenho dados comerciais comparáveis para os clientes no período ${periodText}.`, source: "DIRECT_DB_FAST", intent: "sales_ranking" };
    const positive = ranking.filter((x) => x.sales > 0);
    if (!positive.length) {
      if (ranking.length === 1) return { answer: `No relatório comercial mais recente (${periodText}), só tenho ${ranking[0].name} reportado e ele marcou 0 vendas. Então ainda não dá para dizer quem vendeu mais entre os clientes — faltam relatórios dos outros grupos.`, source: "DIRECT_DB_FAST", intent: "sales_ranking" };
      return { answer: `No relatório comercial mais recente (${periodText}), há ${ranking.length} clientes reportados e nenhum registrou venda.`, source: "DIRECT_DB_FAST", intent: "sales_ranking" };
    }
    const top = positive[0].sales;
    const winners = positive.filter((x) => x.sales === top);
    let answer = winners.length === 1 ? `${winners[0].name} foi quem mais vendeu no relatório comercial mais recente (${periodText}), com ${top} ${top === 1 ? "venda" : "vendas"}.` : `Tem empate no topo no relatório comercial mais recente (${periodText}): ${formatNames(winners.map((x) => x.name))}, com ${top} vendas cada.`;
    const top5 = positive.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}: ${x.sales}`).join("\n");
    if (positive.length > 1) answer += `\n${top5}`;
    return { answer, source: "DIRECT_DB_FAST", intent: "sales_ranking" };
  }

  if (/\b(precisa de atencao|precisam de atencao|risco|churnar|dando problema|problema|reclamando|reclamacao|insatisfeito|insatisfeitos)\b/.test(contextQ)) {
    if (role === "DESIGN") return restricted();
    let q = ops.from("client_health_board").select("client_id,display_name,priority,gt_owner,external_risk_level,external_summary,external_recommended_action,sentimento,sinais_alerta,reclamacoes,prioridade").in("client_id", visibleIds).order("prioridade", { ascending: false, nullsFirst: false }).limit(120);
    if (gt && teamWide(role)) q = q.eq("gt_owner", gt.person);
    const { data, error } = await q;
    if (error) throw new Error(`health:${error.message}`);
    let rows = data ?? [];
    const complaints = /\b(reclamando|reclamacao|reclamacoes)\b/.test(contextQ);
    const risk = /\b(churnar|risco)\b/.test(contextQ);
    rows = rows.filter((r) => complaints ? Boolean(String(r.reclamacoes ?? "").trim()) : risk ? ["ATTENTION", "FOLLOW_UP"].includes(String(r.priority || "")) || /high|alto|critical|critico/i.test(String(r.external_risk_level || "")) : ["ATTENTION", "FOLLOW_UP"].includes(String(r.priority || "")));
    if (!rows.length) return { answer: "Não encontrei nenhum cliente com sinal claro nessa condição agora.", source: "DIRECT_DB_FAST", intent: "client_health" };
    const lines = rows.slice(0, 10).map((r) => `• ${r.display_name}: ${clip(r.reclamacoes || r.sinais_alerta || r.external_summary || "há sinais de atenção registrados", 180)}`);
    return { answer: `Encontrei ${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} que merecem atenção agora.\n${lines.join("\n")}${rows.length > 10 ? `\n…e mais ${rows.length - 10}.` : ""}`, source: "DIRECT_DB_FAST", intent: "client_health" };
  }

  if (/\b(quem esta atrasado|quem ta atrasado|o que esta atrasado|o que ta atrasado|ficou pra tras|ficaram pra tras|pendencias atrasadas)\b/.test(contextQ)) {
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([
      ops.from("work_items").select("client_id,title,due_at").in("client_id", visibleIds).in("status", ["OPEN", "IN_PROGRESS", "WAITING", "SNOOZED"]).not("due_at", "is", null).lt("due_at", now).order("due_at").limit(80),
      ops.from("clickup_tasks").select("client_id,name,due_date").in("client_id", visibleIds).eq("is_closed", false).not("due_date", "is", null).lt("due_date", now).order("due_date").limit(80),
    ]);
    if (a.error) throw new Error(`late_work:${a.error.message}`);
    if (b.error) throw new Error(`late_click:${b.error.message}`);
    const nameMap = new Map(clients.map((c) => [c.id, c.display_name]));
    const sample = [...(a.data ?? []).map((r) => ({ client: nameMap.get(r.client_id) || "Sem cliente", item: r.title })), ...(b.data ?? []).map((r) => ({ client: nameMap.get(r.client_id) || "Sem cliente", item: r.name }))].slice(0, 8);
    return { answer: `Temos ${(a.data?.length ?? 0) + (b.data?.length ?? 0)} pendências vencidas no seu escopo agora: ${a.data?.length ?? 0} operacionais e ${b.data?.length ?? 0} tasks do ClickUp.${sample.length ? `\n${sample.map((r) => `• ${r.client}: ${clip(r.item, 120)}`).join("\n")}` : ""}`, source: "DIRECT_DB_FAST", intent: "overdue_snapshot" };
  }

  if (/\b(devendo|inadimplente|inadimplentes|mensalidade|mrr|pagamento atrasado|pagamentos atrasados)\b/.test(contextQ)) {
    if (!financeAllowed(role, person)) return restricted();
    const { data, error } = await ops.from("client_finance_controls").select("client_id,monthly_value,overdue_since").limit(300);
    if (error) throw new Error(`finance:${error.message}`);
    const rows = data ?? [];
    const nameMap = new Map(clients.map((c) => [c.id, c.display_name]));
    if (/\b(devendo|inadimplente|inadimplentes|pagamento atrasado|pagamentos atrasados)\b/.test(contextQ)) {
      const late = rows.filter((r) => r.overdue_since);
      return { answer: late.length ? `Temos ${late.length} ${late.length === 1 ? "cliente com pagamento atrasado" : "clientes com pagamento atrasado"}: ${formatNames(late.map((r) => nameMap.get(r.client_id) || "Cliente sem nome"), 20)}.` : "Não encontrei cliente com pagamento atrasado registrado agora.", source: "DIRECT_DB_FAST", intent: "finance_overdue" };
    }
    const total = rows.reduce((s, r) => s + Number(r.monthly_value || 0), 0);
    return { answer: `O valor mensal registrado soma R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`, source: "DIRECT_DB_FAST", intent: "finance_mrr" };
  }

  if (/\b(churn|churns|churned|saiu|sairam|perdemos|encerrado|encerraram)\b/.test(contextQ) && /\b(cliente|clientes|quem|quantos|quantas|mes|hoje|ontem|semana)\b/.test(contextQ)) {
    if (["GT", "DESIGN"].includes(role)) return restricted();
    const p = periodFromQuestion(contextQ) ?? monthPeriod();
    const rows = clients.filter((c) => c.lifecycle === "CHURNED" && c.saida && c.saida >= p.start.slice(0, 10) && c.saida < p.end.slice(0, 10));
    return { answer: rows.length ? `Tivemos ${rows.length} ${rows.length === 1 ? "churn" : "churns"} ${p.label}: ${formatNames(rows.map((r) => r.display_name), 20)}.` : `Não encontrei churn registrado ${p.label}.`, source: "DIRECT_DB_FAST", intent: "churn_period" };
  }

  return null;
}

async function cloudflareFallback(authHeader, question) {
  let conversationId = "";
  async function post(path, body) {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, { method: "POST", headers: { Authorization: authHeader, "content-type": "application/json" }, body: JSON.stringify(body) });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || !parsed?.ok) throw new Error(`cloudflare_${response.status}:${clip(parsed?.detail || parsed?.error || raw, 250)}`);
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

function operationalPrompt(person, role, scope, allowedClients, question, previous) {
  const last = previous?.question ? `CONTEXTO DA ÚLTIMA TROCA:\nPergunta anterior: ${clip(previous.question, 700)}\nResposta anterior: ${clip(previous.answer, 1200)}` : "";
  return [
    "Você é o OpsQuestion, copiloto operacional interno da Leonardo Imobi.",
    "Fale como alguém da equipe: português do Brasil, natural, direto, curto e útil. Não fale como banco de dados, documentação ou suporte técnico.",
    "Entenda primeiro a intenção operacional. Depois consulte os dados. Só então responda.",
    "Nunca mostre nomes de tabela, schema, coluna, enum, stage_code, current_stage ou códigos internos, salvo se o usuário pedir tecnicamente.",
    "Vocabulário: carteira = clientes atribuídos ao GT; task feita = task concluída; integração = integração com GT; campanha ativa sem entrega = campanha ativa que não está entregando; campanha rodando = ativa e entregando.",
    "Quando perguntarem quem vendeu mais por cliente, use os relatórios comerciais semanais e a métrica de vendas reportadas. Não confunda resultado/leads do Meta com venda.",
    "Se só houver dados de poucos clientes, diga isso claramente em vez de inventar ranking geral.",
    "Aceite fala informal e erro de digitação. Perguntas curtas como 'por cliente', 'e o Yuri?', 'e hoje?' podem continuar a pergunta anterior.",
    "Se houver interpretação claramente mais provável, assuma e responda. Só peça esclarecimento se houver duas interpretações humanas realmente plausíveis e a resposta mudar bastante.",
    "Use America/Sao_Paulo para datas relativas. Nunca invente fatos, números, responsáveis, datas ou evidências.",
    "Consulta somente leitura.",
    `Usuário: ${person} (${role}).`,
    `Escopo: ${scope}`,
    allowedClients,
    last,
    `Pergunta atual: ${question}`,
  ].filter(Boolean).join("\n\n");
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
  let scope = "Pode consultar a base operacional da empresa em modo somente leitura.";
  let scopedClients = [];
  if (role === "GT") {
    scopeLabel = "GT_PORTFOLIO_READ_ONLY";
    scope = `Responda somente sobre clientes da carteira de ${person}.`;
    const { data } = await ops.from("clients").select("id,display_name").eq("gt_owner", person).in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name");
    scopedClients = data ?? [];
  } else if (role === "DESIGN") {
    scopeLabel = "DESIGN_SELF_READ_ONLY";
    scope = `Priorize produtividade própria e trabalho de design de ${person}.`;
  } else if (role === "CS") {
    scopeLabel = "CS_SHARED_BASE_READ_ONLY";
    scope = "Pode consultar a base compartilhada dos CS em modo somente leitura.";
  } else if (["MGMT", "AI"].includes(role)) {
    scopeLabel = "FULL_READ_ONLY";
    scope = "Pode consultar a visão operacional ampla em modo somente leitura.";
  }

  const { data: previousRows } = await ops.from("opsquestion_interactions")
    .select("question,answer,created_at")
    .eq("user_key", user.id)
    .eq("status", "SUCCESS")
    .order("created_at", { ascending: false })
    .limit(1);
  const previous = previousRows?.[0] ?? null;
  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const direct = await fastAnswer(ops, role, String(person), question, previous?.question ?? null);
    if (direct) {
      const latency = Date.now() - started;
      await ops.from("opsquestion_interactions").insert({
        user_key: user.id, person, role, access_level: accessLevel, question,
        status: "SUCCESS", source: direct.source, answer: direct.answer.slice(0, 20000),
        request_id: requestId, latency_ms: latency, answered_at: new Date().toISOString(),
      });
      return reply({ ok: true, name: "OpsQuestion", answer: direct.answer, source: "Base operacional · resposta rápida", read_only: true, mode: direct.source, intent: direct.intent, scope: scopeLabel, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
    }
  } catch (e) {
    console.error("[opsquestion-fast-lane]", errText(e));
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
  const allowedClients = role === "GT" ? `Clientes permitidos: ${scopedClients.map((c) => c.display_name).join("; ") || "nenhum"}.` : "";
  const prompt = operationalPrompt(String(person), role, scope, allowedClients, question, previous);

  let answer = null, primaryError = null, fallbackError = null;
  if (webhookUrl && readSecret) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECT_AI_TIMEOUT_MS);
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ai-read-secret": readSecret },
        body: JSON.stringify({
          question: prompt, original_question: question, source: "OpsQuestion", request_id: requestId,
          user: { person, role, access_level: accessLevel, scope: scopeLabel, allowed_clients: scopedClients },
          constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true, human_language: true, hide_technical_identifiers: true, infer_common_operational_meaning: true },
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      answer = response.ok ? safeAnswer(parsed, raw) : null;
      if (!response.ok) primaryError = `http_${response.status}`;
      else if (!answer) primaryError = "empty_ai_answer";
    } catch (e) {
      primaryError = e instanceof DOMException && e.name === "AbortError" ? "direct_ai_timeout" : errText(e);
    } finally { clearTimeout(timeout); }
  } else if (webhookUrl && !readSecret) primaryError = "missing_ai_read_secret";
  else primaryError = "direct_ai_not_configured";

  if (!answer) {
    try { answer = await cloudflareFallback(authHeader, question); routeMode = "CLOUDFLARE_AI_FALLBACK"; }
    catch (e) { fallbackError = errText(e); }
  }
  const latency = Date.now() - started;
  if (!answer) {
    const error = [primaryError, fallbackError].filter(Boolean).join(" | ").slice(0, 500) || "ai_unavailable";
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
    return reply({ ok: false, error: "Falha temporária no OpsQuestion.", detail: error, request_id: requestId }, 502);
  }
  answer = humanize(answer);
  await ops.from("opsquestion_interactions").update({ status: "SUCCESS", source: routeMode, answer: answer.slice(0, 20000), error: primaryError && routeMode === "CLOUDFLARE_AI_FALLBACK" ? `primary_failed:${primaryError}`.slice(0, 500) : null, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
  return reply({ ok: true, name: "OpsQuestion", answer, source: routeMode === "CLOUDFLARE_AI_FALLBACK" ? "Base operacional · IA de contingência" : "Base operacional · análise IA", read_only: true, mode: routeMode, scope: scopeLabel, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
});
