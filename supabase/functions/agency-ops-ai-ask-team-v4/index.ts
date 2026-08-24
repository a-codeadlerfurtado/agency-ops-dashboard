import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const V3_PATH = "/functions/v1/agency-ops-ai-ask-team-v3";
const MAX_CONTEXT = 118_000;
const DIRECT_TIMEOUT_MS = 70_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (value: unknown, max = 420) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const safeAnswer = (body: any, raw: string) => {
  const values = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  if (raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
};
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const isoDate = (value: unknown) => {
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const fmtDateTime = (value: unknown) => {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
};

function resolveClient(question: string, clients: any[]) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const row of clients) {
    const name = norm(row.display_name);
    if (!name || name.length < 3) continue;
    let current = q.includes(` ${name} `) ? 1000 + name.length : 0;
    if (!current) {
      const parts = name.split(" ").filter((part) => part.length >= 4);
      current = parts.filter((part) => q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
    }
    if (current > score) { best = row; score = current; }
  }
  return score >= 5 ? best : null;
}

function resolvePerson(question: string, roster: any[]) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const row of roster) {
    const name = norm(row.person);
    if (!name) continue;
    let current = q.includes(` ${name} `) ? 1000 + name.length : 0;
    if (!current) current = name.split(" ").filter((p) => p.length >= 3 && q.includes(` ${p} `)).reduce((s, p) => s + p.length, 0);
    if (current > score) { best = row; score = current; }
  }
  return score >= 3 ? best : null;
}

function domainPlan(question: string, hasClient: boolean) {
  const q = norm(question);
  const domains = new Set<string>();
  const add = (name: string, re: RegExp) => { if (re.test(q)) domains.add(name); };
  if (hasClient) domains.add("history");
  add("history", /\b(aconteceu|historico|historia|antes|depois|comecou|inicio|sequencia|desde|mudou|piorou|melhorou|ultima coisa|primeiro sinal|imediatamente)\b/);
  add("conversation", /\b(whatsapp|wpp|mensagem|mensagens|conversa|resposta|responder|pergunta|reclam|elog|clima|cobrou|cobranca|aguardando resposta|esperando resposta|vou verificar|retorno)\b/);
  add("commitments", /\b(promessa|promessas|promet|compromisso|compromissos|cumpr|descumpr|retorno posterior|vou verificar|ficou de)\b/);
  add("commercial", /\b(venda|vendas|vendeu|venderam|comercial|funil|corretor|corretores|visita|visitas|proposta|propostas|planilha|atualiz|conversao|converte|lead trabalhado|origem da venda)\b/);
  add("lead_dispatch", /\b(distribuicao|distribuir|recebe mais leads|lead duplicado|dois corretores|corretor recebe|fora do horario|enviado para|roteamento)\b/);
  add("media", /\b(meta|campanha|campanhas|cpl|ctr|cpc|cpm|frequencia|fadiga|orcamento|budget|gasto|investimento|anuncio|anuncios|trafego|criativo|publico|entrega|lead barato|lead caro)\b/);
  add("onboarding", /\b(onboarding|integracao|reuniao|material|materiais|sla|reagend|campanha no ar|gt definido|etapa)\b/);
  add("creative", /\b(criativo|criativos|design|designer|ajuste|ajustes|logo|cor|layout|revisao|revisoes|retrabalho|reprov|identidade visual|informacao incorreta)\b/);
  add("team", /\b(equipe|colaborador|colaboradores|gt|cs|designer|task|tasks|tarefa|tarefas|produtiv|carga|performance|desempenho|atrasad|capacidade|responde mais rapido|carteira pesada|gargalo)\b/);
  add("contract", /\b(contrato|contratos|renovacao|renovar|vencimento|vigencia|assinatura)\b/);
  add("management", /\b(risco|churn|atencao|prioridade|resolver hoje|se eu fosse|decisao|decisoes|proximos 7 dias|amanha|problema repet|automatizado primeiro|dependem demais|recebendo atencao|nao percebi|perdendo dinheiro|gargalo|piorando semana)\b/);
  add("causal", /\b(causa|causou|provavelmente caus|impacto|efeito|logo apos|depois da troca|depois do aumento|melhorou depois|piorou depois|gerou a venda|veio do trafego|atribui|relacao|correlacao)\b/);
  add("forecast", /\b(prestes|proximos 7 dias|vai gerar|provavelmente vai|amanha|risco aumentando|tendencia|prever|previsao)\b/);
  if (!domains.size) { domains.add("management"); domains.add("history"); }
  if (domains.has("causal")) { domains.add("history"); domains.add("media"); domains.add("commercial"); }
  if (domains.has("forecast")) { domains.add("management"); domains.add("history"); domains.add("conversation"); }
  return domains;
}

function scopeClients(role: string, person: string, clients: any[]) {
  if (role === "GT") return clients.filter((c) => c.gt_owner === person);
  if (role === "DESIGN") return clients.filter((c) => c.designer_owner === person);
  return clients;
}

function compact(rows: any[], fields: string[], max = 150) {
  return (rows ?? []).slice(0, max).map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = row?.[field];
      if (value === undefined || value === null || value === "") continue;
      out[field] = typeof value === "string" ? clip(value, 520) : value;
    }
    return out;
  });
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[index].toFixed(1));
}

function aggregateResponses(rows: any[]) {
  const map = new Map<string, number[]>();
  for (const row of rows ?? []) {
    const person = String(row.cs_person || "Sem CS");
    const min = Number(row.response_minutes);
    if (!Number.isFinite(min)) continue;
    if (!map.has(person)) map.set(person, []);
    map.get(person)!.push(min);
  }
  return [...map.entries()].map(([person, values]) => ({
    person,
    replies: values.length,
    avg_minutes: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)),
    median_minutes: percentile(values, .5),
    p90_minutes: percentile(values, .9),
  })).sort((a, b) => b.avg_minutes - a.avg_minutes);
}

function aggregateHealthVelocity(rows: any[], nameMap: Map<string, string>) {
  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    if (!row.client_id) continue;
    if (!grouped.has(row.client_id)) grouped.set(row.client_id, []);
    grouped.get(row.client_id)!.push(row);
  }
  const result: any[] = [];
  for (const [clientId, list] of grouped) {
    list.sort((a, b) => new Date(a.observed_at || a.captured_at).getTime() - new Date(b.observed_at || b.captured_at).getTime());
    const first = list[0], last = list[list.length - 1];
    const firstScore = Number(first?.health_score);
    const lastScore = Number(last?.health_score);
    result.push({
      client_id: clientId,
      client: nameMap.get(clientId) || first?.client_name_raw || clientId,
      first_at: first?.observed_at || first?.captured_at,
      last_at: last?.observed_at || last?.captured_at,
      first_score: Number.isFinite(firstScore) ? firstScore : null,
      last_score: Number.isFinite(lastScore) ? lastScore : null,
      score_delta: Number.isFinite(firstScore) && Number.isFinite(lastScore) ? Number((lastScore - firstScore).toFixed(1)) : null,
      first_risk: first?.risk_level ?? null,
      last_risk: last?.risk_level ?? null,
      last_summary: clip(last?.summary, 300),
    });
  }
  return result.sort((a, b) => (a.score_delta ?? 0) - (b.score_delta ?? 0));
}

function aggregateMedia(rows: any[], nameMap: Map<string, string>) {
  const now = Date.now();
  const map = new Map<string, any>();
  for (const row of rows ?? []) {
    if (!row.client_id) continue;
    if (!map.has(row.client_id)) map.set(row.client_id, { client_id: row.client_id, client: nameMap.get(row.client_id) || row.client_id, d7: { spend: 0, leads: 0, clicks: 0, impressions: 0 }, p7: { spend: 0, leads: 0, clicks: 0, impressions: 0 }, d30: { spend: 0, leads: 0, clicks: 0, impressions: 0 } });
    const item = map.get(row.client_id);
    const age = Math.floor((now - new Date(`${row.date}T12:00:00Z`).getTime()) / 86_400_000);
    const add = (bucket: any) => { bucket.spend += Number(row.spend || 0); bucket.leads += Number(row.leads || 0); bucket.clicks += Number(row.clicks || 0); bucket.impressions += Number(row.impressions || 0); };
    if (age >= 0 && age < 7) add(item.d7);
    if (age >= 7 && age < 14) add(item.p7);
    if (age >= 0 && age < 30) add(item.d30);
  }
  return [...map.values()].map((item) => {
    for (const key of ["d7", "p7", "d30"]) {
      item[key].spend = Number(item[key].spend.toFixed(2));
      item[key].cpl = item[key].leads > 0 ? Number((item[key].spend / item[key].leads).toFixed(2)) : null;
      item[key].ctr = item[key].impressions > 0 ? Number(((item[key].clicks / item[key].impressions) * 100).toFixed(2)) : null;
    }
    item.leads_delta_pct = item.p7.leads > 0 ? Number((((item.d7.leads - item.p7.leads) / item.p7.leads) * 100).toFixed(1)) : null;
    item.cpl_delta_pct = item.p7.cpl && item.d7.cpl ? Number((((item.d7.cpl - item.p7.cpl) / item.p7.cpl) * 100).toFixed(1)) : null;
    return item;
  });
}

function aggregateCommitments(rows: any[], nameMap: Map<string, string>) {
  const now = Date.now();
  const byOwner = new Map<string, any>();
  const byClient = new Map<string, any>();
  for (const row of rows ?? []) {
    const open = !["DONE", "COMPLETED", "CANCELLED", "RESOLVED"].includes(String(row.status || "").toUpperCase());
    const overdue = open && row.due_at && new Date(row.due_at).getTime() < now;
    const owner = row.owner || "Sem responsável";
    if (!byOwner.has(owner)) byOwner.set(owner, { owner, open: 0, overdue: 0, total: 0 });
    const o = byOwner.get(owner); o.total++; if (open) o.open++; if (overdue) o.overdue++;
    const client = row.client_id || "sem_cliente";
    if (!byClient.has(client)) byClient.set(client, { client_id: row.client_id, client: nameMap.get(row.client_id) || "Sem cliente", open: 0, overdue: 0, total: 0 });
    const c = byClient.get(client); c.total++; if (open) c.open++; if (overdue) c.overdue++;
  }
  return { by_owner: [...byOwner.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open), by_client: [...byClient.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open) };
}

function aggregateAdjustments(rows: any[], nameMap: Map<string, string>) {
  const groups = new Map<string, any>();
  for (const row of rows ?? []) {
    const key = `${row.client_id || "none"}|${row.category_code || row.tipo || "outro"}|${row.responsible_area || "sem_area"}`;
    if (!groups.has(key)) groups.set(key, { client_id: row.client_id, client: nameMap.get(row.client_id) || "Sem cliente", category: row.category_code || row.tipo || "Outro", area: row.responsible_area || "Sem área", count: 0, recurrent: 0, unresolved: 0 });
    const item = groups.get(key); item.count++; if (row.is_recurrent) item.recurrent++; if (!/DONE|RESOLVED|CLOSED|COMPLETED/i.test(String(row.status || ""))) item.unresolved++;
  }
  return [...groups.values()].sort((a, b) => b.recurrent - a.recurrent || b.count - a.count);
}

function aggregateWon(rows: any[], nameMap: Map<string, string>) {
  const map = new Map<string, any>();
  for (const row of rows ?? []) {
    if (!map.has(row.client_id)) map.set(row.client_id, { client_id: row.client_id, client: nameMap.get(row.client_id) || row.client_id, confirmed_events: 0, high_confidence: 0, latest_at: null, sources: new Set<string>() });
    const item = map.get(row.client_id); item.confirmed_events++;
    if (Number(row.confidence || 0) >= .8) item.high_confidence++;
    if (!item.latest_at || new Date(row.occurred_at) > new Date(item.latest_at)) item.latest_at = row.occurred_at;
    if (row.initial_source) item.sources.add(String(row.initial_source));
  }
  return [...map.values()].map((x) => ({ ...x, sources: [...x.sources] })).sort((a, b) => b.confirmed_events - a.confirmed_events);
}

function aggregateDispatch(rows: any[], nameMap: Map<string, string>) {
  const byRecipient = new Map<string, any>();
  const leadToRecipients = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const recipient = String(row.recipient_phone || "sem_destino");
    const clientId = row.expected_client_id || row.recipient_client_id || null;
    const key = `${clientId || "none"}|${recipient}`;
    if (!byRecipient.has(key)) byRecipient.set(key, { client_id: clientId, client: nameMap.get(clientId) || null, recipient_phone: recipient, dispatches: 0, routing_problems: 0 });
    const item = byRecipient.get(key); item.dispatches++; if (!/MATCH|OK|CORRECT/i.test(String(row.routing_status || ""))) item.routing_problems++;
    const leadKey = norm(`${row.lead_phone || ""}|${row.lead_email || ""}|${row.product_label || ""}`);
    if (leadKey.replace(/\|/g, "")) { if (!leadToRecipients.has(leadKey)) leadToRecipients.set(leadKey, new Set()); leadToRecipients.get(leadKey)!.add(recipient); }
  }
  const duplicates = [...leadToRecipients.entries()].filter(([, recipients]) => recipients.size > 1).slice(0, 100).map(([lead_key, recipients]) => ({ lead_key, recipients: [...recipients] }));
  return { by_recipient: [...byRecipient.values()].sort((a, b) => b.dispatches - a.dispatches), possible_multi_recipient: duplicates };
}

function buildTimeline(pack: any) {
  const events: any[] = [];
  const push = (at: any, source: string, type: string, detail: any, extra: any = {}) => {
    const iso = isoDate(at); if (!iso) return;
    events.push({ at: iso, source, type, detail: clip(typeof detail === "string" ? detail : JSON.stringify(detail ?? {}), 360), ...extra });
  };
  for (const row of pack.timeline_raw || []) push(row.at, row.source || "Histórico", row.event_type || "evento", row.detail);
  for (const row of pack.event_activity || []) push(row.occurred_at, row.source_key || "Operação", row.event_type || "evento", `${row.title || ""} ${row.details || ""}`, { status: row.event_status, severity: row.severity, responsible: row.responsible_employee_name });
  for (const row of pack.daily_summaries || []) push(`${row.summary_date}T12:00:00Z`, "Resumo diário", "daily_summary", `${row.summary || ""} Pendências: ${JSON.stringify(row.pending_items || [])} Bloqueios: ${JSON.stringify(row.blockers || [])}`);
  for (const row of pack.commitments || []) push(row.created_at, "Compromisso", "commitment_created", row.descricao, { owner: row.owner, due_at: row.due_at, status: row.status });
  for (const row of pack.commitments || []) if (row.updated_at && row.updated_at !== row.created_at) push(row.updated_at, "Compromisso", "commitment_updated", row.descricao, { owner: row.owner, status: row.status });
  for (const row of pack.won_events || []) push(row.occurred_at, "Comercial", "sale_confirmed", row.evidence, { confidence: row.confidence, initial_source: row.initial_source });
  for (const row of pack.adjustments || []) push(row.occurred_at || row.created_at, "Ajustes", "adjustment", `${row.tipo || row.category_code || "Ajuste"}: ${row.descricao || ""}`, { area: row.responsible_area, responsible: row.responsible_person, recurrent: row.is_recurrent });
  for (const row of pack.whatsapp_recent || []) push(row.event_at, `WhatsApp ${row.chat_name || ""}`, "message", `${row.sender_name || ""}: ${row.text_body || row.caption || ""}`);
  for (const row of pack.weekly_commercial || []) push(row.generated_at, "Acompanhamento comercial", "commercial_report", `Semana ${row.week_start} a ${row.week_end}. Leads comerciais ${row.commercial_leads}; Meta ${row.meta_leads}; métricas ${JSON.stringify(row.metrics || {})}`);
  for (const row of pack.weekly_traffic || []) push(row.generated_at, "Tráfego", "traffic_report", `${row.summary || row.report_text || ""}`);
  for (const row of pack.onboarding_sla || []) push(row.started_at, "Onboarding", `sla_${row.event_type || "event"}`, row.evidence, { due_at: row.due_at, completed_at: row.completed_at, sla_status: row.sla_status, responsible: row.responsible_person || row.responsible_role });
  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).slice(-500);
}

async function buildEvidence(ops: any, role: string, person: string, question: string, clients: any[], roster: any[]) {
  const allowed = scopeClients(role, person, clients);
  const client = resolveClient(question, allowed);
  const mentionedPerson = resolvePerson(question, roster);
  const domains = domainPlan(question, Boolean(client));
  const allowedIds = allowed.map((c) => c.id);
  const nameMap = new Map(clients.map((c) => [c.id, c.display_name]));
  const unrestricted = ["MGMT", "AI", "CS"].includes(role);
  const coverage: Record<string, string> = {};
  const pack: any = {
    question_context: { domains: [...domains], client: client ? { id: client.id, name: client.display_name, lifecycle: client.lifecycle, gt_owner: client.gt_owner, cs_owner: client.cs_owner, designer_owner: client.designer_owner, entrada: client.entrada, saida: client.saida } : null, mentioned_person: mentionedPerson ? { person: mentionedPerson.person, role: mentionedPerson.role } : null },
    scope: { role, person, allowed_clients: allowed.length },
    generated_at: new Date().toISOString(),
  };
  const run = async (label: string, factory: () => any) => {
    try { const { data, error } = await factory(); if (error) throw error; coverage[label] = "OK"; return data ?? []; }
    catch (error) { coverage[label] = `UNAVAILABLE:${clip(error instanceof Error ? error.message : error, 120)}`; return []; }
  };
  const constrain = (query: any) => client ? query.eq("client_id", client.id) : (!unrestricted ? (allowedIds.length ? query.in("client_id", allowedIds) : query.eq("client_id", "00000000-0000-0000-0000-000000000000")) : query);
  const jobs: Promise<void>[] = [];

  if (domains.has("management") || domains.has("history") || domains.has("forecast")) jobs.push((async () => {
    let snapQ = ops.from("client_operational_snapshot").select("*").order("priority", { ascending: false }).order("last_activity_at", { ascending: false });
    snapQ = constrain(snapQ);
    const snapshots = await run("operational_snapshot", () => snapQ.limit(client ? 10 : 180));
    pack.operational_snapshots = compact(snapshots, ["client_id","priority","waiting_direction","summary_today","current_subject","action_owner","next_step","next_step_due","open_commitments","overdue_commitments","open_complaints","pending_approvals","blockers","data_coverage","confidence","evidence","last_activity_at","snapshot_at"], client ? 10 : 180);

    let healthQ = ops.from("client_health_board").select("*").order("prioridade", { ascending: false, nullsFirst: false });
    healthQ = constrain(healthQ);
    const health = await run("health_current", () => healthQ.limit(client ? 10 : 180));
    pack.health_current = compact(health, ["client_id","display_name","lifecycle","priority","gt_owner","cs_owner","internal_score","internal_band","external_health_status","external_health_score","external_risk_level","external_summary","external_recommended_action","sentimento","sinais_alerta","sinais_positivos","reclamacoes","responsavel_acao","crosscheck_status","prioridade"], client ? 10 : 180);

    let hhQ = ops.from("client_health_external_history").select("client_id,client_name_raw,health_status,health_score,risk_level,satisfaction_avg,risk_avg,summary,recommended_action,observed_at,captured_at").gte("captured_at", daysAgo(45)).order("captured_at", { ascending: true });
    hhQ = constrain(hhQ);
    const hh = await run("health_history", () => hhQ.limit(client ? 300 : 2500));
    pack.health_velocity = aggregateHealthVelocity(hh, nameMap).slice(0, client ? 10 : 180);
  })());

  if (domains.has("history") || domains.has("conversation") || domains.has("causal")) jobs.push((async () => {
    if (client) {
      const [timeline, daily, events, chats] = await Promise.all([
        run("timeline", () => ops.from("client_timeline").select("client_id,event_type,at,detail,source").eq("client_id", client.id).gte("at", daysAgo(180)).order("at", { ascending: true }).limit(800)),
        run("daily_summary", () => ops.from("client_daily_summary").select("*").eq("client_id", client.id).gte("summary_date", daysAgo(90).slice(0,10)).order("summary_date", { ascending: true }).limit(120)),
        run("event_activity", () => ops.from("client_event_activity").select("*").eq("client_id", client.id).gte("occurred_at", daysAgo(180)).order("occurred_at", { ascending: true }).limit(600)),
        run("client_chats", () => ops.from("whatsapp_chat_registry").select("chat_id,chat_name,scope,confidence,last_seen_at,message_count").eq("client_id", client.id).order("last_seen_at", { ascending: false }).limit(120)),
      ]);
      pack.timeline_raw = compact(timeline, ["event_type","at","detail","source"], 800);
      pack.daily_summaries = compact(daily, ["summary_date","priority","waiting_direction","summary","deliveries","approvals","pending_items","promises","blockers","next_steps","evidence","generated_at"], 120);
      pack.event_activity = compact(events, ["event_type","event_status","severity","title","details","occurred_at","due_at","resolved_at","responsible_employee_name","responsible_employee_role","source_key","metadata"], 600);
      pack.chats = chats;
      const chatIds = chats.map((c: any) => c.chat_id).filter(Boolean);
      if (chatIds.length) {
        const [semantic, states, messages] = await Promise.all([
          run("conversation_semantic", () => ops.from("conversation_semantic_state").select("*").in("chat_id", chatIds).limit(120)),
          run("conversation_state", () => ops.from("conversation_state").select("*").in("chat_id", chatIds).limit(120)),
          run("whatsapp_recent", () => ops.from("whatsapp_messages").select("message_id,chat_id,chat_name,sender_name,from_me,event_at,message_type,text_body,caption").in("chat_id", chatIds).gte("event_at", daysAgo(120)).order("event_at", { ascending: false }).limit(500)),
        ]);
        pack.conversation_semantic = compact(semantic, ["chat_id","priority","waiting_direction","current_subject","today_summary","client_requests","team_actions","deliveries","decisions","approvals","pending_items","next_steps","blockers","complaints","promises","confidence","processed_at"], 120);
        pack.conversation_state = compact(states, ["chat_id","last_client_message_at","last_team_message_at","waiting_for_agency","waiting_since","waiting_for_client","open_question","conversation_status","sla_level","last_intent","last_summary","updated_at","last_actor","last_message_requires_response"], 120);
        pack.whatsapp_recent = compact(messages, ["message_id","chat_id","chat_name","sender_name","from_me","event_at","message_type","text_body","caption"], 500);
      }
    } else {
      let semQ = ops.from("conversation_semantic_state").select("chat_id,client_id,priority,waiting_direction,current_subject,today_summary,client_requests,team_actions,pending_items,next_steps,blockers,complaints,promises,confidence,processed_at").order("priority", { ascending: false });
      let stateQ = ops.from("conversation_state").select("chat_id,client_id,last_client_message_at,last_team_message_at,waiting_for_agency,waiting_since,waiting_for_client,open_question,conversation_status,sla_level,last_summary,last_actor,last_message_requires_response,updated_at").order("waiting_since", { ascending: true, nullsFirst: false });
      if (!unrestricted) { semQ = allowedIds.length ? semQ.in("client_id", allowedIds) : semQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); stateQ = allowedIds.length ? stateQ.in("client_id", allowedIds) : stateQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); }
      const [semantic, states] = await Promise.all([run("conversation_semantic", () => semQ.limit(400)), run("conversation_state", () => stateQ.limit(400))]);
      pack.conversation_semantic = compact(semantic, ["client_id","priority","waiting_direction","current_subject","today_summary","client_requests","team_actions","pending_items","next_steps","blockers","complaints","promises","confidence","processed_at"], 400);
      pack.conversation_state = compact(states, ["client_id","last_client_message_at","last_team_message_at","waiting_for_agency","waiting_since","waiting_for_client","open_question","conversation_status","sla_level","last_summary","last_actor","last_message_requires_response","updated_at"], 400);
    }
  })());

  if (domains.has("commitments") || domains.has("history") || domains.has("management")) jobs.push((async () => {
    let q = ops.from("commitments").select("*").order("due_at", { ascending: true, nullsFirst: false }); q = constrain(q);
    const rows = await run("commitments", () => q.limit(client ? 200 : 1000));
    pack.commitments = compact(rows, ["id","client_id","origem","origem_ref","descricao","owner","due_at","status","task_id","evidencia","confirmed_by_human","created_at","updated_at"], client ? 200 : 1000);
    pack.commitment_summary = aggregateCommitments(rows, nameMap);
  })());

  if (domains.has("commercial") || domains.has("causal") || domains.has("management")) jobs.push((async () => {
    let reportQ = ops.from("weekly_commercial_reports").select("*").order("week_end", { ascending: false }).order("generated_at", { ascending: false }); reportQ = constrain(reportQ);
    let wonQ = ops.from("client_won_events").select("*").gte("occurred_at", daysAgo(365)).order("occurred_at", { ascending: false }); wonQ = constrain(wonQ);
    let recQ = ops.from("lead_reconciliation").select("*").order("period_end", { ascending: false }); recQ = constrain(recQ);
    const [reports, won, recon] = await Promise.all([
      run("commercial_reports", () => reportQ.limit(client ? 100 : 800)),
      run("won_events", () => wonQ.limit(client ? 200 : 1000)),
      run("lead_reconciliation", () => recQ.limit(client ? 100 : 500)),
    ]);
    pack.weekly_commercial = compact(reports, ["client_id","week_start","week_end","cs_owner","gt_owner","commercial_leads","meta_leads","meta_source","meta_cross_status","meta_difference","meta_difference_pct","confidence_level","metrics","previous_metrics","reporters","context","internal_warning","source_summary","generated_at"], client ? 100 : 800);
    pack.won_events = compact(won, ["dedupe_key","client_id","occurred_at","initial_source","crm_lead_id","whatsapp_chat_id","confidence","evidence","created_at"], client ? 200 : 1000);
    pack.won_summary = aggregateWon(won, nameMap);
    pack.lead_reconciliation = compact(recon, ["client_id","period_start","period_end","meta_leads","crm_leads","delta","ratio","source_crm","status","metadata","created_at"], client ? 100 : 500);
  })());

  if (domains.has("lead_dispatch") || domains.has("commercial")) jobs.push((async () => {
    let q = ops.from("meta_lead_dispatches").select("message_id,event_at,recipient_phone,product_label,lead_name,lead_phone,lead_email,recipient_client_id,expected_client_id,routing_status,recipient_match_method,expected_match_method,recipient_candidates,expected_candidates").gte("event_at", daysAgo(60)).order("event_at", { ascending: false });
    if (client) q = q.or(`recipient_client_id.eq.${client.id},expected_client_id.eq.${client.id}`);
    const dispatches = await run("lead_dispatches", () => q.limit(client ? 1500 : 5000));
    const filtered = !client && !unrestricted ? dispatches.filter((r: any) => allowedIds.includes(r.expected_client_id) || allowedIds.includes(r.recipient_client_id)) : dispatches;
    pack.lead_dispatch_summary = aggregateDispatch(filtered, nameMap);
    if (client) pack.lead_dispatches = compact(filtered, ["message_id","event_at","recipient_phone","product_label","lead_name","lead_phone","lead_email","recipient_client_id","expected_client_id","routing_status","recipient_match_method","expected_match_method"], 1200);
  })());

  if (domains.has("media") || domains.has("causal") || domains.has("management")) jobs.push((async () => {
    let mediaQ = ops.from("media_metrics_daily").select("client_id,date,spend,impressions,clicks,leads,cpl,ctr,cpc,campaign_count,source").gte("date", daysAgo(35).slice(0,10)).order("date", { ascending: true }); mediaQ = constrain(mediaQ);
    const media = await run("media_daily", () => mediaQ.limit(client ? 2000 : 8000));
    pack.media_trends = aggregateMedia(media, nameMap).slice(0, client ? 10 : 200);
    let campaignQ = ops.from("meta_campaign_insights").select("client_id,campaign_id,campaign_name,campaign_status,objective,date_start,date_stop,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,leads_estimate,cost_per_lead_estimate,checked_at,result_type,result_count,cost_per_result,result_source").gte("checked_at", daysAgo(35)).order("checked_at", { ascending: false }); campaignQ = constrain(campaignQ);
    const campaigns = await run("campaign_insights", () => campaignQ.limit(client ? 800 : 3500));
    pack.campaign_insights = compact(campaigns, ["client_id","campaign_id","campaign_name","campaign_status","objective","date_start","date_stop","spend","impressions","clicks","ctr","cpc","cpm","reach","frequency","leads_estimate","cost_per_lead_estimate","checked_at","result_type","result_count","cost_per_result","result_source"], client ? 800 : 1200);
    let trafficQ = ops.from("weekly_traffic_reports").select("client_id,week_start,week_end,client_name,gt_owner,summary,report_text,data_status,review_status,generated_at").order("week_end", { ascending: false }); trafficQ = constrain(trafficQ);
    pack.weekly_traffic = compact(await run("weekly_traffic", () => trafficQ.limit(client ? 60 : 300)), ["client_id","week_start","week_end","client_name","gt_owner","summary","report_text","data_status","review_status","generated_at"], client ? 60 : 300);
    let expQ = ops.from("traffic_experiments").select("*").order("start_at", { ascending: false }); expQ = constrain(expQ);
    pack.traffic_experiments = compact(await run("traffic_experiments", () => expQ.limit(client ? 100 : 500)), ["client_id","title","experiment_type","hypothesis","variable_tested","control_description","variant_description","primary_metric","baseline_value","result_value","start_at","end_at","status","conclusion","result_summary","learning","campaign_ids","created_by_person","source_type","source_ref"], client ? 100 : 500);
  })());

  if (domains.has("onboarding") || domains.has("management")) jobs.push((async () => {
    let workQ = ops.from("gt_onboarding_worklist").select("*").order("next_action_due", { ascending: true, nullsFirst: false }); workQ = constrain(workQ);
    let slaQ = ops.from("onboarding_sla_board").select("*").order("due_at", { ascending: true }); slaQ = constrain(slaQ);
    const [work, sla] = await Promise.all([run("onboarding_worklist", () => workQ.limit(client ? 20 : 300)), run("onboarding_sla", () => slaQ.limit(client ? 120 : 900))]);
    pack.onboarding = compact(work, ["client_id","display_name","lifecycle","entrada","gt_owner","onboarding_risk","current_stage","next_action","next_action_due","integration_status","integration_started_at","integration_due_at","integration_completed_at","access_status","access_due_at","integration_bucket","integration_attempt_count","last_attempt_outcome","last_attempt_reason_code","last_attempt_reason_detail","last_attempt_rescheduled_for","last_attempt_ended_at","last_attempt_evidence","integration_meet_scheduled_for"], client ? 20 : 300);
    pack.onboarding_sla = compact(sla, ["client_id","display_name","cs_owner","gt_owner","event_type","status","responsible_role","responsible_person","started_at","due_at","completed_at","source_type","evidence","sla_status","overdue_minutes"], client ? 120 : 900);
  })());

  if (domains.has("creative") || domains.has("causal")) jobs.push((async () => {
    let adjQ = ops.from("client_adjustments").select("*").gte("occurred_at", daysAgo(180)).order("occurred_at", { ascending: false }); adjQ = constrain(adjQ);
    let rulesQ = ops.from("creative_client_rules").select("*").order("last_confirmed_at", { ascending: false, nullsFirst: false }); rulesQ = constrain(rulesQ);
    const [adjustments, rules] = await Promise.all([run("adjustments", () => adjQ.limit(client ? 500 : 2500)), run("creative_rules", () => rulesQ.limit(client ? 300 : 1800))]);
    pack.adjustments = compact(adjustments, ["id","client_id","source","tipo","descricao","occurred_at","responsible_person","category_code","subcategory_code","reason","request_origin","responsible_area","status","severity","resolution","is_recurrent","parent_adjustment_id","created_at","updated_at","resolved_at"], client ? 500 : 1800);
    pack.adjustment_patterns = aggregateAdjustments(adjustments, nameMap).slice(0, client ? 100 : 300);
    pack.creative_rules = compact(rules, ["client_id","classification","rule_kind","rule_text","product_scope","status","confidence","source_type","source_ref","observed_at","last_confirmed_at"], client ? 300 : 1200);
    if (client) {
      const brand = await run("creative_brand_profile", () => ops.from("creative_brand_profiles").select("*").eq("client_id", client.id).limit(1));
      pack.creative_brand_profile = compact(brand, ["color_palette","fonts","logo_rules","visual_direction","asset_links","status","source_type","source_ref","last_verified_at"], 1);
    }
  })());

  if (domains.has("team") || domains.has("management") || domains.has("conversation")) jobs.push((async () => {
    const [workload, taskFacts, response] = await Promise.all([
      run("current_workload", () => ops.from("op_perf_current_workload").select("person,role,open_tasks,overdue_tasks").limit(200)),
      run("task_facts", () => ops.from("op_perf_task_facts").select("person,role,task_name,folder_name,list_name,status,date_created,date_closed,due_date,completed,is_adjustment,hours_to_close,on_time").gte("date_created", daysAgo(30)).order("date_created", { ascending: false }).limit(5000)),
      run("cs_response_times", () => ops.from("op_perf_cs_response_times").select("chat_id,client_msg_at,reply_at,cs_person,response_minutes").gte("client_msg_at", daysAgo(30)).order("client_msg_at", { ascending: false }).limit(6000)),
    ]);
    pack.current_workload = workload;
    const filteredTasks = mentionedPerson ? taskFacts.filter((r: any) => r.person === mentionedPerson.person) : taskFacts;
    pack.task_facts = compact(filteredTasks, ["person","role","task_name","folder_name","list_name","status","date_created","date_closed","due_date","completed","is_adjustment","hours_to_close","on_time"], mentionedPerson ? 800 : 1800);
    pack.cs_response_stats = aggregateResponses(response);
    if (mentionedPerson?.role === "CS") pack.cs_response_samples = compact(response.filter((r: any) => r.cs_person === mentionedPerson.person), ["chat_id","client_msg_at","reply_at","cs_person","response_minutes"], 600);
  })());

  if ((domains.has("contract") || Boolean(client)) && (role === "MGMT" || person === "Adler Furtado")) jobs.push((async () => {
    let q = ops.from("client_contract_status").select("*").order("days_remaining", { ascending: true }); q = constrain(q);
    pack.contracts = compact(await run("contracts", () => q.limit(client ? 20 : 250)), ["client_id","display_name","lifecycle","cs_owner","gt_owner","document_name","document_status","is_finished","contract_start_date","contract_end_date","days_remaining","contract_state","renewal_pending","tasks_last_30d","last_task_at","inconsistency"], client ? 20 : 250);
  })());

  if (domains.has("management") || domains.has("team") || domains.has("history")) jobs.push((async () => {
    let workQ = ops.from("work_items").select("*").order("priority", { ascending: false }).order("due_at", { ascending: true, nullsFirst: false }); workQ = constrain(workQ);
    pack.work_items = compact(await run("work_items", () => workQ.limit(client ? 300 : 1200)), ["id","client_id","type","status","priority","title","description","source","source_id","created_by_person","target_role","target_person","due_at","snoozed_until","started_at","completed_at","completed_by","resolution","created_at","updated_at"], client ? 300 : 1000);
  })());

  await Promise.all(jobs);
  if (client) pack.temporal_timeline = buildTimeline(pack);
  pack.coverage = coverage;
  pack.known_data_gaps = {
    google_sheets_direct: "NOT_CONNECTED: não há credencial Google/Sheets configurada no backend; dados de planilha só podem ser inferidos de mensagens/relatórios já ingeridos.",
    traffic_experiments: coverage.traffic_experiments === "OK" && Array.isArray(pack.traffic_experiments) && pack.traffic_experiments.length === 0 ? "EMPTY: sem experimentos estruturados; causalidade de mudanças de campanha/criativo deve ser tratada como inferência temporal." : "AVAILABLE_OR_NOT_REQUESTED",
    commercial_reports: coverage.commercial_reports === "OK" && Array.isArray(pack.weekly_commercial) && pack.weekly_commercial.length === 0 ? "EMPTY_FOR_SCOPE" : "AVAILABLE_OR_NOT_REQUESTED",
  };
  return { pack, client, mentionedPerson, domains };
}

function promptFor(question: string, person: string, role: string, evidence: any, previous: any) {
  let context = JSON.stringify(evidence);
  if (context.length > MAX_CONTEXT) context = `${context.slice(0, MAX_CONTEXT)}\n[CONTEXTO TRUNCADO]`;
  const prior = previous?.question ? `Pergunta anterior: ${clip(previous.question, 500)}\nResposta anterior: ${clip(previous.answer, 900)}` : "Sem contexto anterior relevante.";
  return `Você é o OpsQuestion v4, copiloto de gestão operacional da Leonardo Imobi. Sua função é responder com inteligência baseada em evidências e apontar o próximo passo operacional quando fizer sentido.\n\nREGRAS OBRIGATÓRIAS:\n1. Cruze TODAS as fontes presentes no pacote. Nunca conclua pela ausência em uma única fonte.\n2. Reconstrua a ordem temporal quando a pergunta envolver antes/depois, piora, melhora, causa, impacto, churn ou mudança de responsável/campanha.\n3. CAUSALIDADE: correlação temporal NÃO é prova. Use três níveis: CONFIRMADO (evidência explícita/experimento), INDÍCIO FORTE (sequência temporal + múltiplas evidências coerentes), HIPÓTESE (coincidência plausível). Diga o nível.\n4. VENDAS: use eventos deduplicados de venda e relatório comercial para contagem. Mensagem explícita pode confirmar ocorrência, mas não conte comemorações repetidas. Não atribua venda ao tráfego sem evidência de origem.\n5. LEADS/CORRETORES: diferencie lead Meta, disparo, recebimento, atendimento, visita, proposta e venda. Se não houver mapeamento de telefone para nome do corretor ou leitura direta da planilha, diga isso; ainda responda o que for possível.\n6. META: compare janelas temporais equivalentes. Não recomende pausar/aumentar orçamento com base em um único dia. Considere volume, tendência, CPL, CTR, frequência, entrega e resultado comercial quando disponível.\n7. ATENDIMENTO: tempo de resposta sozinho não mede qualidade. Cruze reclamações, perguntas em aberto, promessa, retorno, estado semântico e reincidência.\n8. PRODUTIVIDADE: volume de tasks sozinho não define performance. Cruze prazo, atraso, carga, carteira, retrabalho e tempo de resposta quando aplicável.\n9. RETRABALHO: diferencie erro interno, pedido estético do cliente, mudança de opinião e falta de informação. Não atribua culpa sem evidência.\n10. PREVISÃO/RISCO: não diga que algo “vai” acontecer. Use risco estimado com sinais que estão piorando e explique os indicadores antecedentes.\n11. Se fontes divergirem, mostre a divergência e diga qual é mais adequada para a pergunta.\n12. Se faltar dado essencial, responda o máximo possível e diga exatamente o que falta — sem inventar.\n13. Nunca exponha nomes de tabelas/schemas/códigos internos. Fale WhatsApp, Meta, ClickUp, acompanhamento comercial, onboarding, contratos etc.\n14. Datas relativas usam America/Sao_Paulo.\n15. Para pergunta simples, seja curto. Para comparação/diagnóstico, use bullets.\n16. Quando houver evidência literal decisiva, cite no máximo um trecho curto, autor e data.\n17. Para perguntas de gestão/diagnóstico, finalize com “Próximos passos” contendo 1 a 3 ações concretas, na ordem, com responsável provável e motivo. Se o responsável não estiver comprovado, use a função (CS/GT/Operações), não invente nome.\n18. O OpsQuestion continua SOMENTE LEITURA: próximos passos são recomendações. Nunca diga que criou task, enviou mensagem, pausou campanha ou alterou dado.\n19. Se a pergunta for “se você fosse o Adler” ou equivalente, priorize impacto sobre clientes, risco de churn, SLA, receita/resultado e capacidade da equipe.\n20. Se a confiança for inferior a alta, termine com “Confiança: média” ou “Confiança: baixa” e explique em uma frase.\n\nUsuário: ${person} (${role})\n${prior}\n\nPERGUNTA:\n${question}\n\nPACOTE DE EVIDÊNCIAS:\n${context}\n\nResponda à pergunta e, quando aplicável, indique os próximos passos. Não faça uma aula sobre o sistema.`;
}

async function callDirect(ops: any, prompt: string, question: string, person: string, role: string, requestId: string) {
  const [{ data: endpointCfg }, { data: secretCfg }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);
  const endpoint = typeof endpointCfg?.value === "string" ? endpointCfg.value : null;
  const secret = typeof secretCfg?.value === "string" ? secretCfg.value : null;
  if (!endpoint || !secret) throw new Error("direct_ai_not_configured");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": secret },
      body: JSON.stringify({ question: prompt, original_question: question, source: "OpsQuestionCausalV4", request_id: requestId, user: { person, role, scope: "causal_evidence_read_only" }, constraints: { read_only: true, timezone: "America/Sao_Paulo", no_invention: true, cross_source_reasoning: true, temporal_reasoning: true, causal_labels: true, action_plan: true } }),
      signal: controller.signal,
    });
    const raw = await response.text(); let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) throw new Error(`direct_ai_${response.status}:${clip(raw, 180)}`);
    const answer = safeAnswer(body, raw); if (!answer) throw new Error("direct_ai_empty"); return answer;
  } finally { clearTimeout(timeout); }
}

async function proxyV3(supabaseUrl: string, anonKey: string, authorization: string, body: any) {
  const response = await fetch(`${supabaseUrl}${V3_PATH}`, { method: "POST", headers: { Authorization: authorization, apikey: anonKey, "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await response.text(); return { response, raw };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return json({ ok: false, error: "missing_question" }, 400);
  if (question.length > 2500) return json({ ok: false, error: "question_too_long", max_chars: 2500 }, 400);

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData } = await auth.auth.getUser(); const user = userData?.user;
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: rosterRows }, { data: clients }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,access_level,clickup_user,email,is_former").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,entrada,saida").in("lifecycle", ["ACTIVE","ONBOARDING","CHURNED"]).order("display_name").limit(600),
  ]);
  const person = pref?.collaborator_person ?? null;
  const member = (rosterRows ?? []).find((r: any) => r.person === person);
  if (!person || !member) return json({ ok: false, error: "OpsQuestion indisponível: colaborador não está ativo." }, 403);
  const role = String(member.role || "");
  const accessLevel = String(member.access_level || "RESTRICTED");
  const requestId = crypto.randomUUID(); const started = Date.now();
  const { data: previousRows } = await ops.from("opsquestion_interactions").select("question,answer,created_at").eq("user_key", user.id).eq("status", "SUCCESS").order("created_at", { ascending: false }).limit(1);
  const previous = previousRows?.[0] ?? null;

  try {
    const { pack, client, mentionedPerson, domains } = await buildEvidence(ops, role, String(person), question, clients ?? [], rosterRows ?? []);
    const prompt = promptFor(question, String(person), role, pack, previous);
    const answer = await callDirect(ops, prompt, question, String(person), role, requestId);
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "SUCCESS", source: "CAUSAL_EVIDENCE_V4", answer: answer.slice(0, 20000), request_id: requestId, latency_ms: latency, answered_at: new Date().toISOString() });
    return json({ ok: true, name: "OpsQuestion", answer, source: "Base operacional · inteligência causal", read_only: true, mode: "CAUSAL_EVIDENCE_V4", intent: [...domains].join(","), scope: role, client: client?.display_name ?? null, person_mentioned: mentionedPerson?.person ?? null, coverage: pack.coverage, data_gaps: pack.known_data_gaps, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
  } catch (error) {
    console.error("[opsquestion-v4]", error);
    try {
      const { response, raw } = await proxyV3(supabaseUrl, anonKey, authorization, body);
      return new Response(raw, { status: response.status, headers: { ...CORS, "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store", "x-opsquestion-fallback": "v3" } });
    } catch (fallbackError) {
      const latency = Date.now() - started;
      await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "ERROR", source: "CAUSAL_EVIDENCE_V4", error: clip(`${error} | fallback:${fallbackError}`, 500), request_id: requestId, latency_ms: latency, answered_at: new Date().toISOString() });
      return json({ ok: false, error: "Falha temporária no OpsQuestion.", request_id: requestId }, 502);
    }
  }
});
