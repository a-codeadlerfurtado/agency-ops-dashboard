import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const V3_PATH = "/functions/v1/agency-ops-ai-ask-team-v3";
const MAX_CONTEXT = 110_000;
const AI_TIMEOUT_MS = 70_000;

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
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const teamWide = (role: string) => ["MGMT", "AI", "CS"].includes(role);

function safeAnswer(body: any, raw: string) {
  for (const value of [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

function resolveEntity(question: string, rows: any[], field: string, minPart = 4) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let bestScore = 0;
  for (const row of rows) {
    const value = norm(row?.[field]);
    if (!value) continue;
    let score = q.includes(` ${value} `) ? 1000 + value.length : 0;
    if (!score) {
      score = value.split(" ").filter((part) => part.length >= minPart && q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
    }
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return bestScore >= minPart ? best : null;
}

function allowedClients(role: string, person: string, clients: any[]) {
  if (role === "GT") return clients.filter((c) => c.gt_owner === person);
  if (role === "DESIGN") return clients.filter((c) => c.designer_owner === person);
  return clients;
}

function domains(question: string, hasClient: boolean) {
  const q = norm(question);
  const out = new Set<string>();
  const add = (name: string, re: RegExp) => { if (re.test(q)) out.add(name); };
  if (hasClient) out.add("history");
  add("history", /\b(aconteceu|historico|historia|antes|depois|comecou|inicio|sequencia|desde|mudou|piorou|melhorou|primeiro sinal|ultima coisa)\b/);
  add("conversation", /\b(whatsapp|wpp|mensagem|mensagens|conversa|resposta|responder|reclam|elog|clima|cobrou|cobranca|pergunta|vou verificar|retorno)\b/);
  add("commitments", /\b(promessa|promessas|promet|compromisso|compromissos|cumpr|descumpr|ficou de|retorno posterior)\b/);
  add("commercial", /\b(venda|vendas|vendeu|venderam|comercial|funil|corretor|corretores|visita|visitas|proposta|propostas|planilha|atualiz|conversao|origem da venda)\b/);
  add("dispatch", /\b(distribuicao|distribuir|recebe mais leads|lead duplicado|dois corretores|corretor recebe|enviado para|roteamento)\b/);
  add("media", /\b(meta|campanha|campanhas|cpl|ctr|cpc|cpm|frequencia|fadiga|orcamento|budget|gasto|investimento|anuncio|anuncios|trafego|criativo|publico|entrega|lead barato|lead caro)\b/);
  add("onboarding", /\b(onboarding|integracao|reuniao|material|materiais|sla|reagend|campanha no ar|gt definido|etapa)\b/);
  add("creative", /\b(criativo|criativos|design|designer|ajuste|ajustes|logo|cor|layout|revisao|retrabalho|reprov|identidade visual|informacao incorreta)\b/);
  add("team", /\b(equipe|colaborador|colaboradores|gt|cs|designer|task|tasks|tarefa|tarefas|produtiv|carga|performance|desempenho|atrasad|capacidade|carteira pesada|gargalo)\b/);
  add("contract", /\b(contrato|contratos|renovacao|renovar|vencimento|vigencia|assinatura)\b/);
  add("management", /\b(risco|churn|atencao|prioridade|resolver hoje|se eu fosse|decisao|decisoes|proximos 7 dias|amanha|problema repet|automatizado primeiro|dependem demais|nao percebi|perdendo dinheiro|gargalo)\b/);
  add("causal", /\b(causa|causou|impacto|efeito|logo apos|depois da troca|depois do aumento|melhorou depois|piorou depois|gerou a venda|veio do trafego|atribuicao|correlacao)\b/);
  add("forecast", /\b(prestes|proximos 7 dias|vai gerar|provavelmente vai|amanha|risco aumentando|tendencia|prever|previsao)\b/);
  if (out.has("causal")) { out.add("history"); out.add("media"); out.add("commercial"); }
  if (out.has("forecast")) { out.add("history"); out.add("conversation"); out.add("management"); }
  if (!out.size) { out.add("management"); out.add("history"); }
  return out;
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
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))].toFixed(1));
}

function responseStats(rows: any[]) {
  const map = new Map<string, number[]>();
  for (const row of rows ?? []) {
    const minutes = Number(row.response_minutes);
    if (!Number.isFinite(minutes)) continue;
    const key = String(row.cs_person || "Sem CS");
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(minutes);
  }
  return [...map.entries()].map(([person, values]) => ({
    person,
    replies: values.length,
    avg_minutes: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)),
    median_minutes: percentile(values, .5),
    p90_minutes: percentile(values, .9),
  })).sort((a, b) => b.avg_minutes - a.avg_minutes);
}

function healthVelocity(rows: any[], nameMap: Map<string, string>) {
  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    if (!row.client_id) continue;
    if (!grouped.has(row.client_id)) grouped.set(row.client_id, []);
    grouped.get(row.client_id)!.push(row);
  }
  return [...grouped.entries()].map(([clientId, list]) => {
    list.sort((a, b) => new Date(a.observed_at || a.captured_at).getTime() - new Date(b.observed_at || b.captured_at).getTime());
    const first = list[0], last = list[list.length - 1];
    const a = Number(first?.health_score), b = Number(last?.health_score);
    return {
      client_id: clientId,
      client: nameMap.get(clientId) || last?.client_name_raw || clientId,
      first_at: first?.observed_at || first?.captured_at,
      last_at: last?.observed_at || last?.captured_at,
      first_score: Number.isFinite(a) ? a : null,
      last_score: Number.isFinite(b) ? b : null,
      score_delta: Number.isFinite(a) && Number.isFinite(b) ? Number((b - a).toFixed(1)) : null,
      first_risk: first?.risk_level,
      last_risk: last?.risk_level,
      last_summary: clip(last?.summary, 320),
    };
  }).sort((x, y) => (x.score_delta ?? 0) - (y.score_delta ?? 0));
}

function mediaTrends(rows: any[], nameMap: Map<string, string>) {
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
      const b = item[key];
      b.spend = Number(b.spend.toFixed(2));
      b.cpl = b.leads > 0 ? Number((b.spend / b.leads).toFixed(2)) : null;
      b.ctr = b.impressions > 0 ? Number(((b.clicks / b.impressions) * 100).toFixed(2)) : null;
    }
    item.leads_delta_pct = item.p7.leads > 0 ? Number((((item.d7.leads - item.p7.leads) / item.p7.leads) * 100).toFixed(1)) : null;
    item.cpl_delta_pct = item.p7.cpl && item.d7.cpl ? Number((((item.d7.cpl - item.p7.cpl) / item.p7.cpl) * 100).toFixed(1)) : null;
    return item;
  });
}

function dispatchStats(rows: any[], nameMap: Map<string, string>) {
  const byRecipient = new Map<string, any>();
  const leadRecipients = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const recipient = String(row.recipient_phone || "sem_destino");
    const clientId = row.expected_client_id || row.recipient_client_id || null;
    const key = `${clientId || "none"}|${recipient}`;
    if (!byRecipient.has(key)) byRecipient.set(key, { client_id: clientId, client: nameMap.get(clientId) || null, recipient_phone: recipient, dispatches: 0, routing_problems: 0 });
    const item = byRecipient.get(key); item.dispatches++;
    if (!/MATCH|OK|CORRECT/i.test(String(row.routing_status || ""))) item.routing_problems++;
    const leadKey = norm(`${row.lead_phone || ""}|${row.lead_email || ""}|${row.product_label || ""}`);
    if (leadKey) {
      if (!leadRecipients.has(leadKey)) leadRecipients.set(leadKey, new Set());
      leadRecipients.get(leadKey)!.add(recipient);
    }
  }
  return {
    by_recipient: [...byRecipient.values()].sort((a, b) => b.dispatches - a.dispatches),
    possible_multi_recipient: [...leadRecipients.entries()].filter(([, recipients]) => recipients.size > 1).slice(0, 100).map(([lead_key, recipients]) => ({ lead_key, recipients: [...recipients] })),
  };
}

function adjustmentStats(rows: any[], nameMap: Map<string, string>) {
  const map = new Map<string, any>();
  for (const row of rows ?? []) {
    const key = `${row.client_id || "none"}|${row.category_code || row.tipo || "outro"}|${row.responsible_area || "sem_area"}`;
    if (!map.has(key)) map.set(key, { client_id: row.client_id, client: nameMap.get(row.client_id) || "Sem cliente", category: row.category_code || row.tipo || "Outro", area: row.responsible_area || "Sem área", count: 0, recurrent: 0, unresolved: 0 });
    const item = map.get(key); item.count++; if (row.is_recurrent) item.recurrent++; if (!/DONE|RESOLVED|CLOSED|COMPLETED/i.test(String(row.status || ""))) item.unresolved++;
  }
  return [...map.values()].sort((a, b) => b.recurrent - a.recurrent || b.count - a.count);
}

async function buildEvidence(ops: any, role: string, person: string, question: string, clients: any[], roster: any[]) {
  const permitted = allowedClients(role, person, clients);
  const permittedIds = permitted.map((c) => c.id);
  const client = resolveEntity(question, permitted, "display_name", 4);
  const mentionedPerson = resolveEntity(question, roster, "person", 3);
  const wanted = domains(question, Boolean(client));
  const unrestricted = teamWide(role);
  const nameMap = new Map(clients.map((c) => [c.id, c.display_name]));
  const coverage: Record<string, string> = {};
  const pack: any = {
    question_context: { domains: [...wanted], client: client ? { id: client.id, name: client.display_name, lifecycle: client.lifecycle, entrada: client.entrada, saida: client.saida, gt_owner: client.gt_owner, cs_owner: client.cs_owner, designer_owner: client.designer_owner } : null, mentioned_person: mentionedPerson ? { person: mentionedPerson.person, role: mentionedPerson.role } : null },
    scope: { person, role, client_count: permitted.length },
    generated_at: new Date().toISOString(),
  };
  const run = async (label: string, factory: () => any) => {
    try { const { data, error } = await factory(); if (error) throw error; coverage[label] = "OK"; return data ?? []; }
    catch (error) { coverage[label] = `UNAVAILABLE:${clip(error instanceof Error ? error.message : error, 120)}`; return []; }
  };
  const constrain = (query: any) => client ? query.eq("client_id", client.id) : (!unrestricted ? (permittedIds.length ? query.in("client_id", permittedIds) : query.eq("client_id", "00000000-0000-0000-0000-000000000000")) : query);
  const jobs: Promise<void>[] = [];

  if (wanted.has("management") || wanted.has("history") || wanted.has("forecast")) jobs.push((async () => {
    let snapshotQ = constrain(ops.from("client_operational_snapshot").select("*")).order("last_activity_at", { ascending: false });
    let healthQ = constrain(ops.from("client_health_board").select("*")).order("prioridade", { ascending: false, nullsFirst: false });
    let historyQ = constrain(ops.from("client_health_external_history").select("client_id,client_name_raw,health_status,health_score,risk_level,satisfaction_avg,risk_avg,summary,recommended_action,observed_at,captured_at")).gte("captured_at", daysAgo(45)).order("captured_at", { ascending: true });
    const [snapshots, health, history] = await Promise.all([
      run("operational_snapshot", () => snapshotQ.limit(client ? 12 : 180)),
      run("health_current", () => healthQ.limit(client ? 12 : 180)),
      run("health_history", () => historyQ.limit(client ? 350 : 2600)),
    ]);
    pack.operational_snapshots = compact(snapshots, ["client_id","priority","waiting_direction","summary_today","current_subject","action_owner","next_step","next_step_due","open_commitments","overdue_commitments","open_complaints","pending_approvals","blockers","data_coverage","confidence","evidence","last_activity_at","snapshot_at"], client ? 12 : 180);
    pack.health_current = compact(health, ["client_id","display_name","priority","internal_score","internal_band","external_health_status","external_health_score","external_risk_level","external_summary","external_recommended_action","sentimento","sinais_alerta","sinais_positivos","reclamacoes","responsavel_acao","crosscheck_status","prioridade"], client ? 12 : 180);
    pack.health_velocity = healthVelocity(history, nameMap).slice(0, client ? 10 : 180);
  })());

  if (wanted.has("history") && client) jobs.push((async () => {
    const [timeline, daily, events] = await Promise.all([
      run("timeline", () => ops.from("client_timeline").select("event_type,at,detail,source").eq("client_id", client.id).gte("at", daysAgo(180)).order("at", { ascending: true }).limit(800)),
      run("daily_summary", () => ops.from("client_daily_summary").select("*").eq("client_id", client.id).gte("summary_date", daysAgo(90).slice(0,10)).order("summary_date", { ascending: true }).limit(120)),
      run("event_activity", () => ops.from("client_event_activity").select("*").eq("client_id", client.id).gte("occurred_at", daysAgo(180)).order("occurred_at", { ascending: true }).limit(600)),
    ]);
    pack.timeline = compact(timeline, ["event_type","at","detail","source"], 800);
    pack.daily_summaries = compact(daily, ["summary_date","priority","waiting_direction","summary","deliveries","approvals","pending_items","promises","blockers","next_steps","evidence","generated_at"], 120);
    pack.event_activity = compact(events, ["event_type","event_status","severity","title","details","occurred_at","due_at","resolved_at","responsible_employee_name","responsible_employee_role","source_key","metadata"], 600);
  })());

  if (wanted.has("conversation") || wanted.has("history") || wanted.has("forecast")) jobs.push((async () => {
    if (client) {
      const chats = await run("client_chats", () => ops.from("whatsapp_chat_registry").select("chat_id,chat_name,scope,confidence,last_seen_at,message_count").eq("client_id", client.id).order("last_seen_at", { ascending: false }).limit(120));
      pack.chats = chats;
      const ids = chats.map((row: any) => row.chat_id).filter(Boolean);
      if (ids.length) {
        const [semantic, states, messages] = await Promise.all([
          run("conversation_semantic", () => ops.from("conversation_semantic_state").select("*").in("chat_id", ids).limit(120)),
          run("conversation_state", () => ops.from("conversation_state").select("*").in("chat_id", ids).limit(120)),
          run("whatsapp_recent", () => ops.from("whatsapp_messages").select("message_id,chat_id,chat_name,sender_name,from_me,event_at,message_type,text_body,caption").in("chat_id", ids).gte("event_at", daysAgo(120)).order("event_at", { ascending: false }).limit(550)),
        ]);
        pack.conversation_semantic = compact(semantic, ["chat_id","priority","waiting_direction","current_subject","today_summary","client_requests","team_actions","deliveries","decisions","approvals","pending_items","next_steps","blockers","complaints","promises","confidence","processed_at"], 120);
        pack.conversation_state = compact(states, ["chat_id","last_client_message_at","last_team_message_at","waiting_for_agency","waiting_since","waiting_for_client","open_question","conversation_status","sla_level","last_intent","last_summary","updated_at","last_actor","last_message_requires_response"], 120);
        pack.whatsapp_recent = compact(messages, ["message_id","chat_id","chat_name","sender_name","from_me","event_at","message_type","text_body","caption"], 550);
      }
    } else {
      let semQ = ops.from("conversation_semantic_state").select("chat_id,client_id,priority,waiting_direction,current_subject,today_summary,client_requests,team_actions,pending_items,next_steps,blockers,complaints,promises,confidence,processed_at").order("priority", { ascending: false });
      let stateQ = ops.from("conversation_state").select("chat_id,client_id,last_client_message_at,last_team_message_at,waiting_for_agency,waiting_since,waiting_for_client,open_question,conversation_status,sla_level,last_summary,last_actor,last_message_requires_response,updated_at").order("waiting_since", { ascending: true, nullsFirst: false });
      if (!unrestricted) { semQ = permittedIds.length ? semQ.in("client_id", permittedIds) : semQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); stateQ = permittedIds.length ? stateQ.in("client_id", permittedIds) : stateQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); }
      const [semantic, states] = await Promise.all([run("conversation_semantic", () => semQ.limit(420)), run("conversation_state", () => stateQ.limit(420))]);
      pack.conversation_semantic = compact(semantic, ["client_id","priority","waiting_direction","current_subject","today_summary","client_requests","team_actions","pending_items","next_steps","blockers","complaints","promises","confidence","processed_at"], 420);
      pack.conversation_state = compact(states, ["client_id","last_client_message_at","last_team_message_at","waiting_for_agency","waiting_since","waiting_for_client","open_question","conversation_status","sla_level","last_summary","last_actor","last_message_requires_response","updated_at"], 420);
    }
  })());

  if (wanted.has("commitments") || wanted.has("history") || wanted.has("management")) jobs.push((async () => {
    let q = constrain(ops.from("commitments").select("*")).order("due_at", { ascending: true, nullsFirst: false });
    pack.commitments = compact(await run("commitments", () => q.limit(client ? 220 : 1000)), ["id","client_id","origem","origem_ref","descricao","owner","due_at","status","task_id","evidencia","confirmed_by_human","created_at","updated_at"], client ? 220 : 1000);
  })());

  if ((wanted.has("commercial") || wanted.has("causal") || wanted.has("management")) && role !== "DESIGN") jobs.push((async () => {
    let reportsQ = constrain(ops.from("weekly_commercial_reports").select("*")).order("week_end", { ascending: false }).order("generated_at", { ascending: false });
    let reconQ = constrain(ops.from("lead_reconciliation").select("*")).order("period_end", { ascending: false });
    const [reports, recon] = await Promise.all([
      run("commercial_reports", () => reportsQ.limit(client ? 100 : 800)),
      run("lead_reconciliation", () => reconQ.limit(client ? 100 : 500)),
    ]);
    pack.weekly_commercial = compact(reports, ["client_id","week_start","week_end","cs_owner","gt_owner","commercial_leads","meta_leads","meta_source","meta_cross_status","meta_difference","meta_difference_pct","confidence_level","metrics","previous_metrics","reporters","context","internal_warning","source_summary","generated_at"], client ? 100 : 800);
    pack.lead_reconciliation = compact(recon, ["client_id","period_start","period_end","meta_leads","crm_leads","delta","ratio","source_crm","status","metadata","created_at"], client ? 100 : 500);
    let wonQ = ops.from("client_won_events").select("dedupe_key,client_id,occurred_at,initial_source,crm_lead_id,whatsapp_chat_id,confidence,evidence").not("client_id", "is", null).gte("occurred_at", daysAgo(365)).order("occurred_at", { ascending: false });
    wonQ = constrain(wonQ);
    pack.linked_won_events = compact(await run("linked_won_events", () => wonQ.limit(client ? 200 : 1000)), ["dedupe_key","client_id","occurred_at","initial_source","crm_lead_id","whatsapp_chat_id","confidence","evidence"], client ? 200 : 1000);
  })());

  if ((wanted.has("dispatch") || wanted.has("commercial")) && role !== "DESIGN") jobs.push((async () => {
    let q = ops.from("meta_lead_dispatches").select("message_id,event_at,recipient_phone,product_label,lead_name,lead_phone,lead_email,recipient_client_id,expected_client_id,routing_status,recipient_match_method,expected_match_method").gte("event_at", daysAgo(60)).order("event_at", { ascending: false });
    if (client) q = q.or(`recipient_client_id.eq.${client.id},expected_client_id.eq.${client.id}`);
    const rows = await run("lead_dispatches", () => q.limit(client ? 1600 : 5000));
    const scoped = !client && !unrestricted ? rows.filter((r: any) => permittedIds.includes(r.expected_client_id) || permittedIds.includes(r.recipient_client_id)) : rows;
    pack.lead_dispatch_summary = dispatchStats(scoped, nameMap);
    if (client) pack.lead_dispatches = compact(scoped, ["message_id","event_at","recipient_phone","product_label","lead_name","lead_phone","lead_email","recipient_client_id","expected_client_id","routing_status","recipient_match_method","expected_match_method"], 1200);
  })());

  if (wanted.has("media") || wanted.has("causal") || wanted.has("management")) jobs.push((async () => {
    let mediaQ = constrain(ops.from("media_metrics_daily").select("client_id,date,spend,impressions,clicks,leads,cpl,ctr,cpc,campaign_count,source")).gte("date", daysAgo(35).slice(0,10)).order("date", { ascending: true });
    const media = await run("media_daily", () => mediaQ.limit(client ? 2200 : 8500));
    pack.media_trends = mediaTrends(media, nameMap).slice(0, client ? 10 : 200);
    let campaignQ = constrain(ops.from("meta_campaign_insights").select("client_id,campaign_id,campaign_name,campaign_status,objective,date_start,date_stop,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,leads_estimate,cost_per_lead_estimate,checked_at,result_type,result_count,cost_per_result,result_source")).gte("checked_at", daysAgo(35)).order("checked_at", { ascending: false });
    pack.campaign_insights = compact(await run("campaign_insights", () => campaignQ.limit(client ? 900 : 3800)), ["client_id","campaign_id","campaign_name","campaign_status","objective","date_start","date_stop","spend","impressions","clicks","ctr","cpc","cpm","reach","frequency","leads_estimate","cost_per_lead_estimate","checked_at","result_type","result_count","cost_per_result","result_source"], client ? 900 : 1300);
    let trafficQ = constrain(ops.from("weekly_traffic_reports").select("client_id,week_start,week_end,client_name,gt_owner,summary,report_text,data_status,review_status,generated_at")).order("week_end", { ascending: false });
    pack.weekly_traffic = compact(await run("weekly_traffic", () => trafficQ.limit(client ? 60 : 320)), ["client_id","week_start","week_end","client_name","gt_owner","summary","report_text","data_status","review_status","generated_at"], client ? 60 : 320);
    let expQ = constrain(ops.from("traffic_experiments").select("*")).order("start_at", { ascending: false });
    pack.traffic_experiments = compact(await run("traffic_experiments", () => expQ.limit(client ? 100 : 500)), ["client_id","title","experiment_type","hypothesis","variable_tested","control_description","variant_description","primary_metric","baseline_value","result_value","start_at","end_at","status","conclusion","result_summary","learning","campaign_ids","created_by_person","source_type","source_ref"], client ? 100 : 500);
  })());

  if (wanted.has("onboarding") || wanted.has("management")) jobs.push((async () => {
    let workQ = constrain(ops.from("gt_onboarding_worklist").select("*")).order("next_action_due", { ascending: true, nullsFirst: false });
    let slaQ = constrain(ops.from("onboarding_sla_board").select("*")).order("due_at", { ascending: true });
    const [work, sla] = await Promise.all([run("onboarding", () => workQ.limit(client ? 30 : 320)), run("onboarding_sla", () => slaQ.limit(client ? 140 : 950))]);
    pack.onboarding = compact(work, ["client_id","display_name","entrada","gt_owner","onboarding_risk","current_stage","next_action","next_action_due","integration_status","integration_started_at","integration_due_at","integration_completed_at","access_status","access_due_at","integration_bucket","integration_attempt_count","last_attempt_outcome","last_attempt_reason_code","last_attempt_reason_detail","last_attempt_rescheduled_for","last_attempt_ended_at","last_attempt_evidence","integration_meet_scheduled_for"], client ? 30 : 320);
    pack.onboarding_sla = compact(sla, ["client_id","display_name","cs_owner","gt_owner","event_type","status","responsible_role","responsible_person","started_at","due_at","completed_at","source_type","evidence","sla_status","overdue_minutes"], client ? 140 : 950);
  })());

  if (wanted.has("creative") || wanted.has("causal")) jobs.push((async () => {
    let adjQ = constrain(ops.from("client_adjustments").select("*")).gte("occurred_at", daysAgo(180)).order("occurred_at", { ascending: false });
    let rulesQ = constrain(ops.from("creative_client_rules").select("*")).order("last_confirmed_at", { ascending: false, nullsFirst: false });
    const [adjustments, rules] = await Promise.all([run("adjustments", () => adjQ.limit(client ? 550 : 2600)), run("creative_rules", () => rulesQ.limit(client ? 320 : 1800))]);
    pack.adjustments = compact(adjustments, ["id","client_id","source","tipo","descricao","occurred_at","responsible_person","category_code","subcategory_code","reason","request_origin","responsible_area","status","severity","resolution","is_recurrent","parent_adjustment_id","created_at","updated_at","resolved_at"], client ? 550 : 1800);
    pack.adjustment_patterns = adjustmentStats(adjustments, nameMap).slice(0, client ? 100 : 300);
    pack.creative_rules = compact(rules, ["client_id","classification","rule_kind","rule_text","product_scope","status","confidence","source_type","source_ref","observed_at","last_confirmed_at"], client ? 320 : 1200);
  })());

  if (wanted.has("team") || wanted.has("management") || wanted.has("conversation")) jobs.push((async () => {
    let taskQ = ops.from("op_perf_task_facts").select("person,role,task_name,folder_name,list_name,status,date_created,date_closed,due_date,completed,is_adjustment,hours_to_close,on_time").gte("date_created", daysAgo(30)).order("date_created", { ascending: false });
    let workloadQ = ops.from("op_perf_current_workload").select("person,role,open_tasks,overdue_tasks");
    let responseQ = ops.from("op_perf_cs_response_times").select("chat_id,client_msg_at,reply_at,cs_person,response_minutes").gte("client_msg_at", daysAgo(30)).order("client_msg_at", { ascending: false });
    if (!teamWide(role)) {
      taskQ = taskQ.eq("person", person);
      workloadQ = workloadQ.eq("person", person);
      if (role !== "CS") responseQ = responseQ.eq("cs_person", "__NO_MATCH__");
      else responseQ = responseQ.eq("cs_person", person);
    } else if (mentionedPerson) {
      taskQ = taskQ.eq("person", mentionedPerson.person);
      workloadQ = workloadQ.eq("person", mentionedPerson.person);
      if (mentionedPerson.role === "CS") responseQ = responseQ.eq("cs_person", mentionedPerson.person);
    }
    const [tasks, workload, responses] = await Promise.all([run("task_performance", () => taskQ.limit(5000)), run("workload", () => workloadQ.limit(200)), run("cs_response_times", () => responseQ.limit(6000))]);
    pack.task_performance = compact(tasks, ["person","role","task_name","folder_name","list_name","status","date_created","date_closed","due_date","completed","is_adjustment","hours_to_close","on_time"], mentionedPerson || !teamWide(role) ? 1200 : 2000);
    pack.current_workload = workload;
    pack.cs_response_stats = responseStats(responses);
  })());

  if (wanted.has("management") || wanted.has("team") || wanted.has("history")) jobs.push((async () => {
    let q = constrain(ops.from("work_items").select("*")).order("priority", { ascending: false }).order("due_at", { ascending: true, nullsFirst: false });
    pack.work_items = compact(await run("work_items", () => q.limit(client ? 320 : 1200)), ["id","client_id","type","status","priority","title","description","source","source_id","created_by_person","target_role","target_person","due_at","snoozed_until","started_at","completed_at","completed_by","resolution","created_at","updated_at"], client ? 320 : 1000);
  })());

  if ((wanted.has("contract") || Boolean(client)) && (role === "MGMT" || person === "Adler Furtado")) jobs.push((async () => {
    let q = constrain(ops.from("client_contract_status").select("*")).order("days_remaining", { ascending: true });
    pack.contracts = compact(await run("contracts", () => q.limit(client ? 30 : 260)), ["client_id","display_name","document_name","document_status","is_finished","contract_start_date","contract_end_date","days_remaining","contract_state","renewal_pending","tasks_last_30d","last_task_at","inconsistency"], client ? 30 : 260);
  })());

  await Promise.all(jobs);
  pack.coverage = coverage;
  pack.data_gaps = {
    google_sheets_direct: "NOT_CONNECTED — não há credencial Google/Sheets configurada no backend; perguntas de aderência diária à planilha só podem usar mensagens/relatórios já ingeridos.",
    legacy_sales_linkage: "Os eventos antigos de venda do CRM sem client_id são ignorados para atribuição por cliente. Só eventos vinculados entram como fato do cliente.",
    structured_traffic_experiments: Array.isArray(pack.traffic_experiments) && pack.traffic_experiments.length === 0 ? "EMPTY — sem experimentos estruturados; causalidade de mudanças de mídia deve ser tratada como indício temporal, não prova." : "AVAILABLE_OR_NOT_REQUESTED",
  };
  return { pack, wanted, client, mentionedPerson };
}

function promptFor(question: string, person: string, role: string, evidence: any, previous: any) {
  let context = JSON.stringify(evidence);
  if (context.length > MAX_CONTEXT) context = `${context.slice(0, MAX_CONTEXT)}\n[CONTEXTO TRUNCADO]`;
  const prior = previous?.question ? `Pergunta anterior: ${clip(previous.question, 500)}\nResposta anterior: ${clip(previous.answer, 900)}` : "Sem contexto anterior relevante.";
  return `Você é o OpsQuestion v4, copiloto de gestão operacional da Leonardo Imobi. Responda com inteligência baseada em evidências e indique o próximo passo quando houver decisão operacional.\n\nREGRAS:\n1. Cruze todas as fontes presentes. Nunca conclua pela ausência em uma única fonte.\n2. Em perguntas de antes/depois, piora, melhora, churn, troca de responsável ou mudança de campanha, reconstrua a sequência temporal antes de concluir.\n3. Causalidade tem três níveis: CONFIRMADO (evidência explícita/experimento), INDÍCIO FORTE (sequência temporal + múltiplas evidências coerentes) e HIPÓTESE (coincidência plausível). Não trate correlação como prova.\n4. Vendas: para quantidade use relatório comercial ou evento de venda vinculado ao cliente. Mensagem explícita pode confirmar ocorrência, mas não conte comemorações repetidas. Nunca atribua venda ao tráfego sem evidência de origem.\n5. Diferencie lead Meta, lead disparado, lead recebido/trabalhado, visita, proposta e venda.\n6. Se o destinatário do lead estiver identificado apenas por telefone, não invente nome de corretor.\n7. Meta: compare janelas equivalentes e não recomende pausar/aumentar orçamento por um único dia. Considere tendência de CPL/CTR/frequência, volume e resultado comercial.\n8. Atendimento: tempo de resposta sozinho não mede qualidade. Cruze reclamações, pergunta aberta, promessa, retorno e reincidência.\n9. Performance: volume de tasks sozinho não mede produtividade. Cruze prazo, atraso, carga, retrabalho e contexto da função.\n10. Retrabalho: diferencie erro interno, mudança de opinião do cliente, pedido estético e briefing/informação incompleta. Não atribua culpa sem evidência.\n11. Previsão: fale em risco/tendência, nunca em certeza. Cite sinais antecedentes.\n12. Se fontes divergirem, mostre a divergência e explique qual fonte serve melhor à pergunta.\n13. Se faltar dado essencial, responda o máximo possível e diga exatamente o que falta. Não invente.\n14. Não exponha nomes técnicos de tabelas, schemas ou campos.\n15. Datas relativas usam America/Sao_Paulo.\n16. Para perguntas simples, seja curto. Comparações e diagnósticos podem usar bullets.\n17. Quando houver evidência literal decisiva, cite um trecho curto, autor e data.\n18. Perguntas de gestão/diagnóstico devem terminar com “Próximos passos” com 1 a 3 ações concretas, em ordem, indicando responsável provável e motivo. Se não houver nome comprovado, use a função (CS, GT, Designer, Operações).\n19. O sistema é SOMENTE LEITURA: próximos passos são recomendações. Nunca diga que criou task, enviou mensagem, pausou campanha ou alterou dado.\n20. Se a pergunta for “se você fosse o Adler”, priorize impacto no cliente, churn, SLA, resultado, receita e capacidade da equipe.\n21. Se a confiança não for alta, finalize com “Confiança: média” ou “Confiança: baixa” e uma frase explicando por quê.\n\nUsuário: ${person} (${role})\n${prior}\n\nPERGUNTA:\n${question}\n\nEVIDÊNCIAS:\n${context}\n\nResponda apenas o necessário e proponha próximos passos quando aplicável.`;
}

async function callAi(ops: any, prompt: string, question: string, person: string, role: string, requestId: string) {
  const [{ data: endpointRow }, { data: secretRow }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);
  const endpoint = typeof endpointRow?.value === "string" ? endpointRow.value : null;
  const secret = typeof secretRow?.value === "string" ? secretRow.value : null;
  if (!endpoint || !secret) throw new Error("direct_ai_not_configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": secret },
      body: JSON.stringify({
        question: prompt,
        original_question: question,
        source: "OpsQuestionCausalV4",
        request_id: requestId,
        user: { person, role, scope: "causal_evidence_read_only" },
        constraints: { read_only: true, timezone: "America/Sao_Paulo", no_invention: true, cross_source_reasoning: true, temporal_reasoning: true, causal_labels: true, action_plan: true },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: any = null; try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) throw new Error(`direct_ai_${response.status}:${clip(raw, 180)}`);
    const answer = safeAnswer(parsed, raw);
    if (!answer) throw new Error("direct_ai_empty");
    return answer;
  } finally { clearTimeout(timeout); }
}

async function proxyV3(supabaseUrl: string, anonKey: string, authorization: string, body: any) {
  const response = await fetch(`${supabaseUrl}${V3_PATH}`, {
    method: "POST",
    headers: { Authorization: authorization, apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, raw: await response.text() };
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
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }, { data: roster }, { data: clients }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
    ops.from("team_roster").select("person,role,access_level,clickup_user,email,is_former").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,entrada,saida").in("lifecycle", ["ACTIVE","ONBOARDING","CHURNED"]).order("display_name").limit(600),
  ]);
  const person = pref?.collaborator_person ?? null;
  const member = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !member || !(approvals ?? []).length) return json({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  const role = String(member.role || "");
  const accessLevel = String(member.access_level || "RESTRICTED");
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const { data: previousRows } = await ops.from("opsquestion_interactions").select("question,answer,created_at").eq("user_key", user.id).eq("status", "SUCCESS").order("created_at", { ascending: false }).limit(1);
  const previous = previousRows?.[0] ?? null;

  try {
    const { pack, wanted, client, mentionedPerson } = await buildEvidence(ops, role, String(person), question, clients ?? [], roster ?? []);
    const answer = await callAi(ops, promptFor(question, String(person), role, pack, previous), question, String(person), role, requestId);
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "SUCCESS", source: "CAUSAL_EVIDENCE_V4", answer: answer.slice(0, 20000), request_id: requestId, latency_ms: latency, answered_at: new Date().toISOString() });
    return json({ ok: true, name: "OpsQuestion", answer, source: "Base operacional · inteligência causal", read_only: true, mode: "CAUSAL_EVIDENCE_V4", intent: [...wanted].join(","), client: client?.display_name ?? null, person_mentioned: mentionedPerson?.person ?? null, coverage: pack.coverage, data_gaps: pack.data_gaps, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
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
