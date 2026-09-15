import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const MAX_PROMPT_CONTEXT_CHARS = 90000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();
const clip = (value: unknown, max = 280) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const safeAnswer = (body: any, raw: string) => {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (!body && raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
};
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const isUuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));

function resolveClient(question: string, clients: any[], aliases: any[] = []) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  const names = [
    ...clients.map((client) => ({ client_id: client.id, text: client.display_name, weight: 1000 })),
    ...aliases.map((alias) => ({ client_id: alias.client_id, text: alias.alias_raw || alias.alias_normalized, weight: 900 })),
  ];
  for (const item of names) {
    const name = norm(item.text);
    if (!name || name.length < 3) continue;
    let current = 0;
    if (q.includes(` ${name} `)) current = item.weight + name.length;
    else {
      const parts = name.split(" ").filter((part) => part.length >= 4);
      const partial = parts.filter((part) => q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
      if (partial >= Math.max(5, Math.floor(name.length * 0.5))) current = partial;
    }
    if (current > score) {
      best = clients.find((client) => client.id === item.client_id) ?? null;
      score = current;
    }
  }
  return best;
}

function resolvePerson(question: string, roster: any[]) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const member of roster) {
    const name = norm(member.person);
    if (!name) continue;
    let current = q.includes(` ${name} `) ? 1000 + name.length : 0;
    if (!current) {
      const parts = name.split(" ").filter((part) => part.length >= 3);
      current = parts.filter((part) => q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
    }
    if (current > score) { best = member; score = current; }
  }
  return best;
}

function domains(question: string, hasClient: boolean) {
  const q = norm(question);
  const set = new Set<string>();
  if (hasClient || /\b(aconteceu|historico|historia|ultima coisa|ultimos dias|prometemos|promessa|solicitacao|cobrou|desde quando|mudou)\b/.test(q)) set.add("history");
  if (/\b(whatsapp|wpp|mensagem|mensagens|resposta|responder|conversa|conversas|pergunta|reclam|elog|clima|esperando resposta|aguardando resposta)\b/.test(q)) set.add("conversation");
  if (/\b(venda|vendas|vendeu|venderam|comercial|corretor|corretores|visita|visitas|proposta|propostas|funil|planilha|atualizacao|atualizou|leads recebidos|converte)\b/.test(q)) set.add("commercial");
  if (/\b(meta|campanha|campanhas|cpl|cpa|ctr|cpc|orcamento|budget|gasto|investimento|anuncio|anuncios|lead|leads|trafego|entrega)\b/.test(q)) set.add("media");
  if (/\b(onboarding|integracao|reuniao|material|materiais|sla|gt definido|campanha no ar)\b/.test(q)) set.add("onboarding");
  if (/\b(criativo|criativos|design|designer|ajuste|ajustes|logo|cor|layout|revisao|revisoes|reprov|identidade visual)\b/.test(q)) set.add("creative");
  if (/\b(equipe|colaborador|colaboradores|gt|cs|designer|task|tasks|tarefa|tarefas|produtiv|carga|gargalo|performance|desempenho|atrasad|capacidade)\b/.test(q)) set.add("team");
  if (/\b(contrato|contratos|renovacao|renovar|vencimento|vigencia|assinatura)\b/.test(q)) set.add("contract");
  if (/\b(risco|churn|atencao|prioridade|resolver hoje|tres coisas|3 coisas|problema repet|retrabalho|perdendo dinheiro|saudavel|insatisfeito|mudou na operacao|coisas importantes|nao percebi|gargalo)\b/.test(q)) set.add("management");
  if (!set.size) {
    set.add("management");
    set.add("history");
  }
  return set;
}

function allowedClients(role: string, person: string, clients: any[]) {
  if (role === "GT") return clients.filter((client) => client.gt_owner === person);
  if (role === "DESIGN") return clients.filter((client) => client.designer_owner === person);
  return clients;
}

function compactRows(rows: any[], fields: string[], max = 100) {
  return (rows ?? []).slice(0, max).map((row) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const value = row?.[field];
      if (value === undefined || value === null || value === "") continue;
      result[field] = typeof value === "string" ? clip(value, 500) : value;
    }
    return result;
  });
}

function aggregateMedia(rows: any[], clientMap: Map<string, string>) {
  const today = Date.now();
  const result = new Map<string, any>();
  for (const row of rows ?? []) {
    const id = row.client_id;
    if (!id) continue;
    if (!result.has(id)) result.set(id, { client_id: id, client: clientMap.get(id) || id, d7: { spend: 0, leads: 0, clicks: 0, impressions: 0 }, p7: { spend: 0, leads: 0, clicks: 0, impressions: 0 }, d30: { spend: 0, leads: 0, clicks: 0, impressions: 0 } });
    const item = result.get(id);
    const age = Math.floor((today - new Date(`${row.date}T12:00:00Z`).getTime()) / 86400000);
    const add = (bucket: any) => {
      bucket.spend += Number(row.spend || 0); bucket.leads += Number(row.leads || 0); bucket.clicks += Number(row.clicks || 0); bucket.impressions += Number(row.impressions || 0);
    };
    if (age >= 0 && age < 7) add(item.d7);
    if (age >= 7 && age < 14) add(item.p7);
    if (age >= 0 && age < 30) add(item.d30);
  }
  return [...result.values()].map((item) => {
    for (const key of ["d7", "p7", "d30"]) {
      item[key].spend = Number(item[key].spend.toFixed(2));
      item[key].cpl = item[key].leads > 0 ? Number((item[key].spend / item[key].leads).toFixed(2)) : null;
    }
    item.lead_change_7d_pct = item.p7.leads > 0 ? Number((((item.d7.leads - item.p7.leads) / item.p7.leads) * 100).toFixed(1)) : null;
    item.cpl_change_7d_pct = item.p7.cpl && item.d7.cpl ? Number((((item.d7.cpl - item.p7.cpl) / item.p7.cpl) * 100).toFixed(1)) : null;
    return item;
  });
}

function aggregateTasks(closedRows: any[], overdueRows: any[]) {
  const people = new Map<string, any>();
  const ensure = (name: string) => {
    if (!people.has(name)) people.set(name, { person: name, closed_7d: 0, closed_30d: 0, overdue_open: 0, on_time_closed_30d: 0, closed_with_due_30d: 0 });
    return people.get(name);
  };
  const now = Date.now();
  for (const row of closedRows ?? []) {
    const age = Math.floor((now - new Date(row.date_closed).getTime()) / 86400000);
    const names = String(row.assignee_names || "Sem responsável").split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of names) {
      const item = ensure(name);
      if (age < 7) item.closed_7d++;
      if (age < 30) {
        item.closed_30d++;
        if (row.due_date) {
          item.closed_with_due_30d++;
          if (new Date(row.date_closed).getTime() <= new Date(row.due_date).getTime()) item.on_time_closed_30d++;
        }
      }
    }
  }
  for (const row of overdueRows ?? []) {
    const names = String(row.assignee_names || "Sem responsável").split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of names) ensure(name).overdue_open++;
  }
  return [...people.values()].map((item) => ({ ...item, on_time_rate_30d: item.closed_with_due_30d ? Number((100 * item.on_time_closed_30d / item.closed_with_due_30d).toFixed(1)) : null })).sort((a, b) => b.closed_30d - a.closed_30d);
}

function aggregateCommercial(rows: any[], clientMap: Map<string, string>) {
  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    if (!grouped.has(row.client_id)) grouped.set(row.client_id, []);
    grouped.get(row.client_id)!.push(row);
  }
  return [...grouped.entries()].map(([id, items]) => {
    items.sort((a, b) => String(b.week_end).localeCompare(String(a.week_end)) || String(b.generated_at).localeCompare(String(a.generated_at)));
    const unique: any[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = String(item.week_end);
      if (seen.has(key)) continue;
      seen.add(key); unique.push(item);
      if (unique.length >= 6) break;
    }
    return {
      client_id: id,
      client: clientMap.get(id) || id,
      weeks: unique.map((item) => ({
        week_start: item.week_start, week_end: item.week_end, confidence: item.confidence_level,
        commercial_leads: item.commercial_leads, meta_leads: item.meta_leads, cross_status: item.meta_cross_status,
        sales: Number(item.metrics?.sales || 0), proposals: Number(item.metrics?.proposals || 0),
        visits_scheduled: Number(item.metrics?.visits_scheduled || 0), visits_completed: Number(item.metrics?.visits_completed || 0),
        contacts: Number(item.metrics?.contacts || item.metrics?.conversations || 0), reporters: item.reporters,
        warning: clip(item.internal_warning, 300), source_summary: clip(item.source_summary, 250),
      })),
    };
  });
}

function aggregateCreative(adjustments: any[], clientMap: Map<string, string>) {
  const grouped = new Map<string, any>();
  for (const row of adjustments ?? []) {
    const id = row.client_id || "none";
    if (!grouped.has(id)) grouped.set(id, { client_id: row.client_id, client: clientMap.get(row.client_id) || "Sem cliente", total: 0, recurrent: 0, open: 0, severities: {}, latest: [] });
    const item = grouped.get(id); item.total++;
    if (row.is_recurrent) item.recurrent++;
    if (!["DONE", "RESOLVED", "CLOSED"].includes(String(row.status || "").toUpperCase())) item.open++;
    const severity = String(row.severity || "UNKNOWN"); item.severities[severity] = (item.severities[severity] || 0) + 1;
    if (item.latest.length < 5) item.latest.push({ at: row.occurred_at || row.created_at, tipo: row.tipo, category: row.category_code, description: clip(row.descricao || row.reason, 220), responsible_area: row.responsible_area, status: row.status });
  }
  return [...grouped.values()].sort((a, b) => b.total - a.total);
}

async function fetchEvidencePack(ops: any, role: string, person: string, clients: any[], client: any, question: string) {
  const domain = domains(question, Boolean(client));
  const scoped = allowedClients(role, person, clients);
  const allowedIds = scoped.map((row) => row.id).filter(isUuid);
  const unrestricted = ["MGMT", "AI", "CS"].includes(role);
  const clientMap = new Map(clients.map((row) => [row.id, row.display_name]));
  const scopeIds = client ? [client.id] : allowedIds;
  const coverage: Record<string, any> = {};
  const pack: Record<string, any> = {
    question_domains: [...domain],
    resolved_client: client ? { id: client.id, name: client.display_name, lifecycle: client.lifecycle, gt_owner: client.gt_owner, cs_owner: client.cs_owner, designer_owner: client.designer_owner } : null,
    scope: { role, person, unrestricted, client_count: scoped.length },
    clients: compactRows(scoped, ["id", "display_name", "lifecycle", "gt_owner", "cs_owner", "designer_owner", "entrada", "saida"], 500),
  };
  const run = async (name: string, fn: () => Promise<any>) => {
    try {
      const value = await fn();
      const rows = value?.data ?? value ?? [];
      if (value?.error) throw value.error;
      coverage[name] = { ok: true, rows: Array.isArray(rows) ? rows.length : 1 };
      return rows;
    } catch (error) {
      coverage[name] = { ok: false, error: clip(error instanceof Error ? error.message : error, 180) };
      return [];
    }
  };
  const constrain = (query: any, ids = scopeIds) => {
    if (client) return query.eq("client_id", client.id);
    if (!unrestricted) return ids.length ? query.in("client_id", ids) : query.eq("client_id", "00000000-0000-0000-0000-000000000000");
    return query;
  };

  const jobs: Promise<void>[] = [];

  if (domain.has("management") || domain.has("history") || domain.has("conversation")) jobs.push((async () => {
    const rows = await run("health", () => constrain(ops.from("client_health_board").select("*")).limit(client ? 5 : 180));
    pack.health = compactRows(rows, ["client_id","display_name","lifecycle","priority","gt_owner","cs_owner","internal_score","internal_band","external_health_status","external_health_score","external_risk_level","external_summary","external_recommended_action","sentimento","sinais_alerta","sinais_positivos","reclamacoes","responsavel_acao","crosscheck_status","prioridade"], client ? 5 : 180);
  })());

  if (domain.has("history") || domain.has("management")) jobs.push((async () => {
    let query = ops.from("client_timeline").select("client_id,event_type,at,detail,source").order("at", { ascending: false });
    query = constrain(query);
    if (!client) query = query.gte("at", daysAgo(45));
    const rows = await run("timeline", () => query.limit(client ? 120 : 350));
    pack.timeline = compactRows(rows, ["client_id","event_type","at","detail","source"], client ? 120 : 350);
  })());

  if (domain.has("conversation") || domain.has("management") || domain.has("history")) jobs.push((async () => {
    let stateQ = ops.from("conversation_state").select("*").order("updated_at", { ascending: false });
    stateQ = constrain(stateQ);
    const states = await run("conversation_state", () => stateQ.limit(client ? 80 : 300));
    const chatIds = states.map((row: any) => row.chat_id).filter(Boolean).slice(0, 300);
    let semantics: any[] = [];
    if (chatIds.length) semantics = await run("conversation_semantic", () => ops.from("conversation_semantic_state").select("*").in("chat_id", chatIds).order("updated_at", { ascending: false }).limit(client ? 80 : 300));
    const semanticMap = new Map(semantics.map((row: any) => [row.chat_id, row]));
    pack.conversations = states.map((row: any) => {
      const sem = semanticMap.get(row.chat_id) || {};
      return {
        client_id: row.client_id, client: clientMap.get(row.client_id) || row.client_id, chat_id: row.chat_id,
        status: row.conversation_status, waiting_for_agency: row.waiting_for_agency, waiting_since: row.waiting_since,
        waiting_for_client: row.waiting_for_client, open_question: row.open_question, sla_level: row.sla_level,
        last_client_message_at: row.last_client_message_at, last_team_message_at: row.last_team_message_at,
        last_intent: row.last_intent, last_summary: clip(row.last_summary, 300), priority: sem.priority,
        current_subject: clip(sem.current_subject, 180), summary: clip(sem.today_summary, 320),
        client_requests: sem.client_requests, pending_items: sem.pending_items, blockers: sem.blockers,
        complaints: sem.complaints, promises: sem.promises, next_steps: sem.next_steps, confidence: sem.confidence,
      };
    }).slice(0, client ? 80 : 300);
  })());

  if (domain.has("management") || domain.has("history") || domain.has("team")) jobs.push((async () => {
    let query = ops.from("work_items").select("*").order("updated_at", { ascending: false });
    query = constrain(query);
    const rows = await run("work_items", () => query.limit(client ? 120 : 400));
    pack.work_items = compactRows(rows, ["id","client_id","type","status","priority","title","description","source","created_by_person","target_role","target_person","due_at","snoozed_until","started_at","completed_at","completed_by","resolution","created_at","updated_at"], client ? 120 : 400);
  })());

  if (domain.has("media") || domain.has("commercial") || domain.has("management") || Boolean(client)) jobs.push((async () => {
    let currentQ = ops.from("campaign_client_latest").select("*").order("display_name");
    currentQ = constrain(currentQ);
    const current = await run("campaign_current", () => currentQ.limit(client ? 20 : 300));
    pack.campaigns = compactRows(current, ["client_id","display_name","gt_owner","configured_accounts","latest_date","campaign_count","active_campaigns","paused_campaigns","spend","impressions","clicks","results","leads","result_types","ctr","cpc","cpm","cost_per_result","age_days","delivery_status"], client ? 20 : 300);
    let mediaQ = ops.from("media_metrics_daily").select("client_id,date,spend,impressions,clicks,leads,cpl,source").eq("source", "meta_api_daily_sync").gte("date", daysAgo(35).slice(0,10)).order("date", { ascending: false });
    mediaQ = constrain(mediaQ);
    const media = await run("media_daily", () => mediaQ.limit(client ? 1500 : 5000));
    pack.media_trends = aggregateMedia(media, clientMap);
  })());

  if (domain.has("commercial") || domain.has("media") || domain.has("management") || Boolean(client)) jobs.push((async () => {
    let query = ops.from("weekly_commercial_reports").select("*").order("week_end", { ascending: false }).order("generated_at", { ascending: false });
    query = constrain(query);
    const rows = await run("commercial_reports", () => query.limit(client ? 80 : 1000));
    pack.commercial = aggregateCommercial(rows, clientMap);
  })());

  if (domain.has("onboarding") || domain.has("management") || Boolean(client)) jobs.push((async () => {
    let workQ = ops.from("gt_onboarding_worklist").select("*").order("display_name");
    workQ = constrain(workQ);
    const work = await run("onboarding", () => workQ.limit(client ? 10 : 250));
    pack.onboarding = compactRows(work, ["client_id","display_name","lifecycle","entrada","gt_owner","onboarding_risk","current_stage","next_action","next_action_due","integration_status","integration_started_at","integration_due_at","integration_completed_at","integration_notes","access_status","access_due_at","integration_bucket","integration_attempt_count","last_attempt_outcome","last_attempt_reason_code","last_attempt_reason_detail","last_attempt_rescheduled_for","integration_meet_scheduled_for"], client ? 10 : 250);
    let slaQ = ops.from("onboarding_sla_board").select("*").order("due_at", { ascending: true });
    slaQ = constrain(slaQ);
    const sla = await run("onboarding_sla", () => slaQ.limit(client ? 40 : 300));
    pack.onboarding_sla = compactRows(sla, ["client_id","display_name","event_type","status","responsible_role","responsible_person","started_at","due_at","completed_at","source_type","evidence","sla_status","overdue_minutes"], client ? 40 : 300);
  })());

  if (domain.has("creative") || domain.has("management") || Boolean(client)) jobs.push((async () => {
    let adjQ = ops.from("client_adjustments").select("*").gte("created_at", daysAgo(90)).order("created_at", { ascending: false });
    adjQ = constrain(adjQ);
    const adjustments = await run("creative_adjustments", () => adjQ.limit(client ? 250 : 1000));
    pack.creative_adjustments = aggregateCreative(adjustments, clientMap);
    let rulesQ = ops.from("creative_client_rules").select("*").order("observed_at", { ascending: false });
    rulesQ = constrain(rulesQ);
    const rules = await run("creative_rules", () => rulesQ.limit(client ? 120 : 500));
    pack.creative_rules = compactRows(rules, ["client_id","classification","rule_kind","rule_text","product_scope","status","confidence","source_type","source_ref","observed_at","last_confirmed_at"], client ? 120 : 500);
  })());

  if (domain.has("team") || domain.has("management")) jobs.push((async () => {
    let closedQ = ops.from("clickup_tasks").select("task_id,client_id,name,date_closed,due_date,assignee_names,is_closed,status,list_name,folder_name").eq("is_closed", true).gte("date_closed", daysAgo(30)).order("date_closed", { ascending: false });
    let overdueQ = ops.from("clickup_tasks").select("task_id,client_id,name,due_date,assignee_names,is_closed,status,list_name,folder_name").eq("is_closed", false).not("due_date", "is", null).lt("due_date", new Date().toISOString()).order("due_date", { ascending: true });
    if (client) { closedQ = closedQ.eq("client_id", client.id); overdueQ = overdueQ.eq("client_id", client.id); }
    else if (!unrestricted) { closedQ = allowedIds.length ? closedQ.in("client_id", allowedIds) : closedQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); overdueQ = allowedIds.length ? overdueQ.in("client_id", allowedIds) : overdueQ.eq("client_id", "00000000-0000-0000-0000-000000000000"); }
    const [closed, overdue] = await Promise.all([
      run("clickup_closed", () => closedQ.limit(3000)),
      run("clickup_overdue", () => overdueQ.limit(1500)),
    ]);
    pack.team_performance = aggregateTasks(closed, overdue);
    pack.overdue_tasks = compactRows(overdue, ["task_id","client_id","name","due_date","assignee_names","status","list_name","folder_name"], 250);
  })());

  if ((domain.has("contract") || Boolean(client)) && (role === "MGMT" || person === "Adler Furtado")) jobs.push((async () => {
    let query = ops.from("client_contract_status").select("*").order("days_remaining", { ascending: true });
    query = constrain(query);
    const rows = await run("contracts", () => query.limit(client ? 20 : 250));
    pack.contracts = compactRows(rows, ["client_id","display_name","lifecycle","cs_owner","gt_owner","document_name","document_status","is_finished","contract_start_date","contract_end_date","days_remaining","contract_state","renewal_pending","tasks_last_30d","last_task_at","inconsistency"], client ? 20 : 250);
  })());

  if (client && (domain.has("history") || domain.has("conversation") || domain.has("commercial"))) jobs.push((async () => {
    const chats = await run("client_chats", () => ops.from("whatsapp_chat_registry").select("chat_id,chat_name,scope,client_id,confidence,last_seen_at,message_count").eq("client_id", client.id).order("last_seen_at", { ascending: false }).limit(100));
    pack.chats = chats;
    const chatIds = chats.map((row: any) => row.chat_id).filter(Boolean);
    if (chatIds.length) {
      const raw = await run("client_whatsapp", () => ops.from("whatsapp_messages").select("message_id,chat_id,chat_name,sender_name,sender_phone,from_me,event_at,message_type,text_body,caption").in("chat_id", chatIds).gte("event_at", daysAgo(120)).order("event_at", { ascending: false }).limit(350));
      pack.whatsapp_recent = compactRows(raw, ["message_id","chat_id","chat_name","sender_name","from_me","event_at","message_type","text_body","caption"], 350);
    }
  })());

  if (!client && domain.has("commercial")) jobs.push((async () => {
    const registry = await run("commercial_chats", () => ops.from("whatsapp_chat_registry").select("chat_id,chat_name,scope,client_id,confidence,last_seen_at").order("last_seen_at", { ascending: false }).limit(1000));
    const commercialChats = registry.filter((row: any) => {
      const text = norm(`${row.scope || ""} ${row.chat_name || ""}`);
      if (!/comercial/.test(text)) return false;
      if (!unrestricted && !allowedIds.includes(row.client_id)) return false;
      return true;
    }).slice(0, 120);
    pack.commercial_chats = commercialChats;
    const chatIds = commercialChats.map((row: any) => row.chat_id).filter(Boolean);
    if (chatIds.length) {
      const raw = await run("commercial_whatsapp", () => ops.from("whatsapp_messages").select("message_id,chat_id,chat_name,sender_name,event_at,text_body,caption").in("chat_id", chatIds).gte("event_at", daysAgo(60)).order("event_at", { ascending: false }).limit(1200));
      pack.commercial_whatsapp_recent = compactRows(raw, ["message_id","chat_id","chat_name","sender_name","event_at","text_body","caption"], 1200);
    }
  })());

  await Promise.all(jobs);
  pack.coverage = coverage;
  pack.data_limits = {
    google_sheets_direct: false,
    note: "Planilhas Google dos corretores ainda não são uma fonte direta desta função. Quando existirem mensagens do acompanhamento comercial no WhatsApp, elas aparecem como evidência; não trate isso como leitura completa da planilha.",
  };
  return pack;
}

function promptFor(question: string, person: string, role: string, mentioned: any, evidence: any, previous: any) {
  let evidenceJson = JSON.stringify(evidence);
  if (evidenceJson.length > MAX_PROMPT_CONTEXT_CHARS) evidenceJson = `${evidenceJson.slice(0, MAX_PROMPT_CONTEXT_CHARS)}\n[CONTEXTO TRUNCADO POR LIMITE]`;
  const previousText = previous?.question ? `Pergunta anterior: ${clip(previous.question, 500)}\nResposta anterior: ${clip(previous.answer, 900)}` : "sem contexto anterior";
  const mentionedText = mentioned ? `${mentioned.person} (${mentioned.role})` : "ninguém específico";
  return `Você é o OpsQuestion, copiloto operacional interno da Leonardo Imobi. Responda em português do Brasil, direto, natural e decisório.\n\nREGRAS ABSOLUTAS:\n1. Responda a pergunta atual usando TODO o pacote de evidências relevante, não apenas uma tabela. Cruze WhatsApp, comercial, Meta, ClickUp, onboarding, saúde, criativos, contratos e histórico quando presentes.\n2. Diferencie FATO CONFIRMADO de INFERÊNCIA. Se for inferência, diga claramente.\n3. Nunca transforme menção genérica, comemoração ou duplicata em contagem. Para quantidade/ranking de vendas, priorize dados comerciais estruturados. Uma mensagem explícita pode confirmar que houve venda, mas não necessariamente quantas ou se veio do tráfego.\n4. Nunca diga que algo não aconteceu apenas porque uma fonte está vazia. Diga que não encontrou evidência suficiente e cite quais fontes foram consultadas.\n5. Se as fontes divergirem, mostre a divergência e diga qual fonte é mais apropriada para aquela pergunta.\n6. Para Meta x Comercial, não confunda lead gerado no Meta com lead trabalhado, visita, proposta ou venda.\n7. Para WhatsApp, priorize estado semântico e mensagens literais recentes. Não considere “boas vendas”, nome de campanha com [VENDA] ou “bora vender” como venda realizada.\n8. Para recomendações como “pausar campanha”, “onde agir” ou “top 3 prioridades”, explique em uma frase o critério usado. Trate como recomendação, não fato.\n9. Para produtividade, considere volume, prazo, atraso e carteira; não conclua desempenho só por quantidade de tasks.\n10. Para perguntas sobre corretores/planilhas, a planilha Google ainda não é lida diretamente por esta função. Use relatórios comerciais e mensagens do grupo quando existirem e deixe a limitação explícita.\n11. Se faltar uma fonte essencial, responda o que é possível e diga exatamente o dado que falta. Não invente.\n12. Não mostre nomes técnicos de tabelas/schemas para o usuário. Use nomes humanos: WhatsApp, Meta, ClickUp, acompanhamento comercial, onboarding etc.\n13. Datas e “hoje/ontem” usam America/Sao_Paulo.\n14. Mantenha a resposta curta para perguntas simples; use bullets somente quando houver comparação, ranking ou plano de ação.\n15. Se houver uma evidência literal decisiva, cite um trecho curto, autor e data.\n\nUsuário: ${person} (${role})\nPessoa mencionada: ${mentionedText}\nContexto anterior: ${previousText}\n\nPERGUNTA ATUAL:\n${question}\n\nPACOTE DE EVIDÊNCIAS OPERACIONAIS:\n${evidenceJson}\n\nResponda apenas o necessário para a pergunta. Se a confiança não for alta, finalize com “Confiança: média” ou “Confiança: baixa” e o motivo em uma frase.`;
}

async function callDirectAi(ops: any, prompt: string, originalQuestion: string, person: string, role: string, requestId: string) {
  const [{ data: endpointCfg }, { data: secretCfg }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);
  const endpoint = typeof endpointCfg?.value === "string" ? endpointCfg.value : null;
  const secret = typeof secretCfg?.value === "string" ? secretCfg.value : null;
  if (!endpoint || !secret) throw new Error("direct_ai_not_configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": secret },
      body: JSON.stringify({
        question: prompt,
        original_question: originalQuestion,
        source: "OpsQuestionEvidenceV3",
        request_id: requestId,
        user: { person, role, scope: "evidence_pack_read_only" },
        constraints: { read_only: true, timezone: "America/Sao_Paulo", no_invention: true, cross_source_reasoning: true, distinguish_fact_from_inference: true },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) throw new Error(`direct_ai_http_${response.status}:${clip(raw, 200)}`);
    const answer = safeAnswer(body, raw);
    if (!answer) throw new Error("direct_ai_empty");
    return answer;
  } finally { clearTimeout(timeout); }
}

async function callCloudflareAi(authorization: string, prompt: string) {
  let conversationId = "";
  const post = async (path: string, body: any) => {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, { method: "POST", headers: { Authorization: authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
    const raw = await response.text(); let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || !parsed?.ok) throw new Error(`cloudflare_${response.status}:${clip(parsed?.detail || parsed?.error || raw, 200)}`);
    return parsed;
  };
  try {
    const created = await post("/conversations/create", { client_id: null, title: "OpsQuestion · evidence v3" });
    conversationId = String(created?.conversation?.id || "");
    if (!conversationId) throw new Error("cloudflare_conversation_missing");
    const result = await post("/chat", { conversation_id: conversationId, message: prompt });
    const answer = safeAnswer({ answer: result?.assistant_message?.content }, "");
    if (!answer) throw new Error("cloudflare_empty");
    return answer;
  } finally {
    if (conversationId) { try { await post("/conversations/delete", { conversation_id: conversationId }); } catch {} }
  }
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
  const [{ data: pref }, { data: roster }, { data: clients }, { data: aliases }, { data: previousRows }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,access_level,clickup_user").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,entrada,saida").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).order("display_name").limit(600),
    ops.from("client_name_aliases").select("client_id,alias_raw,alias_normalized").limit(3000),
    ops.from("opsquestion_interactions").select("question,answer,created_at").eq("user_key", user.id).eq("status", "SUCCESS").order("created_at", { ascending: false }).limit(1),
  ]);
  const person = pref?.collaborator_person ?? null;
  const member = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !member) return json({ ok: false, error: "OpsQuestion indisponível: colaborador não está ativo." }, 403);
  const role = String(member.role ?? "");
  const scoped = allowedClients(role, String(person), clients ?? []);
  const client = resolveClient(question, clients ?? [], aliases ?? []);
  if (client && !["MGMT", "AI", "CS"].includes(role) && !scoped.some((row: any) => row.id === client.id)) {
    return json({ ok: true, name: "OpsQuestion", answer: "Esse cliente está fora do seu escopo de acesso.", source: "Base operacional · escopo", read_only: true, mode: "SCOPE_GUARD", latency_ms: 0, generated_at: new Date().toISOString() });
  }
  const mentioned = resolvePerson(question, roster ?? []);
  const previous = previousRows?.[0] ?? null;
  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const evidence = await fetchEvidencePack(ops, role, String(person), clients ?? [], client, question);
    const prompt = promptFor(question, String(person), role, mentioned, evidence, previous);
    let answer: string | null = null;
    let mode = "DIRECT_EVIDENCE_AI";
    let primaryError: string | null = null;
    try { answer = await callDirectAi(ops, prompt, question, String(person), role, requestId); }
    catch (error) { primaryError = clip(error instanceof Error ? error.message : error, 300); }
    if (!answer) {
      try { answer = await callCloudflareAi(authorization, prompt); mode = "CLOUDFLARE_EVIDENCE_AI"; }
      catch (error) { primaryError = `${primaryError || ""} | ${clip(error instanceof Error ? error.message : error, 300)}`.slice(0, 500); }
    }
    if (!answer) {
      const core = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask-team-v2`, { method: "POST", headers: { Authorization: authorization, apikey: anonKey, "content-type": "application/json" }, body: JSON.stringify(body) });
      const raw = await core.text();
      return new Response(raw, { status: core.status, headers: { ...CORS, "content-type": core.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").insert({
      user_key: user.id, person, role, access_level: String(member.access_level ?? "RESTRICTED"), question,
      status: "SUCCESS", source: mode, answer: answer.slice(0, 20000), request_id: requestId, latency_ms: latency,
      error: primaryError && mode === "CLOUDFLARE_EVIDENCE_AI" ? `primary_failed:${primaryError}`.slice(0, 500) : null,
      answered_at: new Date().toISOString(),
    });
    return json({ ok: true, name: "OpsQuestion", answer, source: "Base operacional · análise cruzada", read_only: true, mode, intent: "cross_source_evidence", latency_ms: latency, generated_at: new Date().toISOString(), evidence_domains: [...domains(question, Boolean(client))] });
  } catch (error) {
    console.error("[opsquestion-v3]", error);
    const core = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask-team-v2`, { method: "POST", headers: { Authorization: authorization, apikey: anonKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    const raw = await core.text();
    return new Response(raw, { status: core.status, headers: { ...CORS, "content-type": core.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
});
