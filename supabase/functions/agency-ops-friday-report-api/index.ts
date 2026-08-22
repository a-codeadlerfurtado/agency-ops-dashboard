import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const TZ = "America/Sao_Paulo";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const bodyOf = (row: any) => String(row.text_body || row.caption || "").trim();
const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

function ymdParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}
function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
function reportWindow(now = new Date()) {
  const p = ymdParts(now);
  const local = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = local.getUTCDay();
  const daysSinceFriday = (dow - 5 + 7) % 7;
  const end = new Date(local.getTime() - daysSinceFriday * 86_400_000);
  const start = new Date(end.getTime() - 6 * 86_400_000);
  const previousEnd = new Date(end.getTime() - 7 * 86_400_000);
  return {
    releaseOpen: dow === 5,
    weekStart: isoDate(start),
    weekEnd: isoDate(end),
    previousWeekEnd: isoDate(previousEnd),
    startIso: `${isoDate(start)}T00:00:00-03:00`,
    endExclusiveIso: `${isoDate(new Date(end.getTime() + 86_400_000))}T00:00:00-03:00`,
  };
}
function metric(body: string, label: string) {
  const match = body.match(new RegExp(`${label}\\?[^0-9]{0,35}([0-9]+)`, "i"));
  return match ? Number(match[1]) : null;
}
function referenceLabel(body: string, eventAt: string) {
  const normalized = norm(body);
  const ref = normalized.match(/numeros ref\.?\s*\*?([^\n]+)/i)?.[1]?.replace(/\*/g, "").trim();
  if (ref) return ref.slice(0, 80);
  const generic = normalized.match(/essas metricas sao referentes aos dados de\s+([^\n\]]+)/i)?.[1]?.trim();
  if (generic) return generic.slice(0, 80);
  return String(eventAt || "").slice(0, 10);
}
function parseCommercial(row: any, client: any) {
  const raw = bodyOf(row);
  const body = norm(raw);
  if (!body.includes("quantos leads receberam")) return null;
  const leads = metric(body, "quantos leads receberam");
  if (leads == null) return null;
  return {
    message_id: row.id,
    client_id: client?.client_id || null,
    client_name: client?.display_name || row.chat_name || "Cliente",
    reporter: row.sender_name || "Não identificado",
    event_at: row.event_at,
    reference_label: referenceLabel(raw, row.event_at),
    is_aggregate: /mes de julho|mes de agosto|dados da semana|dados de julho|dados de agosto/.test(body),
    leads_received: leads,
    calls_made: metric(body, "quantas ligacoes efetuadas") ?? 0,
    calls_answered: metric(body, "quantas ligacoes atendidas") ?? 0,
    conversations: metric(body, "em conversa") ?? 0,
    visits_scheduled: metric(body, "quantas visitas agendadas") ?? 0,
    visits_completed: metric(body, "quantas visitas realizadas") ?? 0,
    proposals: metric(body, "quantas propostas emitidas") ?? 0,
    evidence: raw.slice(0, 1800),
  };
}
function dedupeReports(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.client_id}|${norm(row.reporter)}|${norm(row.reference_label)}`;
    const current = map.get(key);
    if (!current || new Date(row.event_at).getTime() > new Date(current.event_at).getTime()) map.set(key, row);
  }
  return [...map.values()];
}

type Sale = { client_id: string | null; quantity: number; event_at: string; sale_key: string; };
function saleFromMessage(row: any, client: any): Sale | null {
  const raw = bodyOf(row);
  const body = norm(raw);
  if (!/(venda|vendid|negocio fechado|vendemos|fechamos)/.test(body)) return null;
  if (/boas vendas|queremos?\s+vendas|gerar vendas|aumentar.*vendas|sera nossa.*venda|expectativa.*venda|campanha.*\[venda\]|\[vendas\]/.test(body)) return null;
  if (/por terceiros?|pela concorrencia|outra corretora|pelo proprietario|comprou direto|fechou negocio em outro lugar/.test(body)) return null;
  let quantity = 0;
  let saleKey = "";
  let match = body.match(/fechamos\s+(\d+)\s+vendas?/);
  if (match) { quantity = Number(match[1]); saleKey = `summary-${String(row.event_at).slice(0, 10)}-${quantity}`; }
  if (!quantity && (match = body.match(/resultado\s*[:\-]?\s*(\d+)\s+vendas?/))) { quantity = Number(match[1]); saleKey = `summary-${String(row.event_at).slice(0, 10)}-${quantity}`; }
  if (!quantity && (match = body.match(/(\d+)\s+vendas?\s+concluidas?/))) { quantity = Number(match[1]); saleKey = `summary-${String(row.event_at).slice(0, 10)}-${quantity}`; }
  if (!quantity && /\b1\s+venda\b/.test(body) && /(parab|concluid|resultado|fech|venda !!!|venda!)/.test(body)) { quantity = 1; saleKey = `single-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /saiu uma venda|fechamos uma venda|primeira venda ganha|unico negocio fechado|vendemos!!!|comemorando sua venda|parabens pela venda|cliente que fechou da campanha/.test(body)) { quantity = 1; saleKey = `single-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /(casa|apto|apartamento|unidade|imovel)[^.!\n]{0,80}\bvendid[oa]\b/.test(body)) { quantity = 1; saleKey = `property-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /foi vendido|foi vendida|vendida\. pode parar|vendido\. pode parar/.test(body)) { quantity = 1; saleKey = `property-${String(row.event_at).slice(0, 10)}`; }
  return quantity ? { client_id: client?.client_id || null, quantity, event_at: row.event_at, sale_key: saleKey } : null;
}
function dedupeSales(rows: Sale[]) {
  const out: Sale[] = [];
  for (const row of [...rows].sort((a, b) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime())) {
    const t = new Date(row.event_at).getTime();
    const duplicate = out.find((item) => item.client_id === row.client_id && (item.sale_key === row.sale_key || (row.quantity === 1 && item.quantity === 1 && Math.abs(t - new Date(item.event_at).getTime()) <= 36 * 60 * 60 * 1000)));
    if (!duplicate) out.push(row);
  }
  return out;
}
function rate(value: number, base: number) {
  return base > 0 ? Number(((value / base) * 100).toFixed(1)) : null;
}
function pct(value: number | null) {
  return value == null ? "dados insuficientes" : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function ppContext(current: number | null, previous: unknown) {
  const prev = previous === null || previous === undefined ? null : Number(previous);
  if (current == null || prev == null || !Number.isFinite(prev)) return "sem base comparável da semana anterior";
  const delta = Number((current - prev).toFixed(1));
  if (Math.abs(delta) < 0.1) return "estável em relação à semana anterior";
  return `${delta > 0 ? "subiu" : "caiu"} ${Math.abs(delta).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p. em relação à semana anterior`;
}
function sumReports(reports: any[]) {
  return reports.reduce((acc, row) => {
    for (const key of ["leads_received","calls_made","calls_answered","conversations","visits_scheduled","visits_completed","proposals"]) acc[key] += n(row[key]);
    return acc;
  }, { leads_received: 0, calls_made: 0, calls_answered: 0, conversations: 0, visits_scheduled: 0, visits_completed: 0, proposals: 0 });
}
function metricsFrom(base: any, sales: number) {
  const m = { ...base, sales };
  return {
    ...m,
    attempt_rate: rate(m.calls_made, m.leads_received),
    answer_lead_rate: rate(m.calls_answered, m.leads_received),
    answer_attempt_rate: rate(m.calls_answered, m.calls_made),
    conversation_answer_rate: rate(m.conversations, m.calls_answered),
    visit_schedule_rate: rate(m.visits_scheduled, m.conversations),
    visit_completion_rate: rate(m.visits_completed, m.visits_scheduled),
    proposal_rate: rate(m.proposals, m.visits_completed),
    sale_proposal_rate: rate(m.sales, m.proposals),
    sale_lead_rate: rate(m.sales, m.leads_received),
  };
}
function metricContexts(metrics: any, previous: any) {
  const labels: Record<string,string> = {
    attempt_rate: "Tentativas / leads", answer_lead_rate: "Contatos atendidos / leads", answer_attempt_rate: "Contatos atendidos / tentativas",
    conversation_answer_rate: "Em conversa / contatos", visit_schedule_rate: "Visitas agendadas / conversas", visit_completion_rate: "Visitas realizadas / agendadas",
    proposal_rate: "Propostas / visitas realizadas", sale_proposal_rate: "Vendas / propostas", sale_lead_rate: "Vendas / leads",
  };
  const out: Record<string, any> = {};
  for (const [key, label] of Object.entries(labels)) out[key] = { label, value: metrics[key], context: ppContext(metrics[key], previous?.[key]) };
  return out;
}
function bottleneck(contexts: Record<string, any>) {
  const candidates = Object.values(contexts).filter((item: any) => item.value != null && ["conversation_answer_rate","visit_schedule_rate","visit_completion_rate","proposal_rate","sale_proposal_rate"].includes(Object.keys(contexts).find((key) => contexts[key] === item) || ""));
  if (!candidates.length) return "Ainda não há dados suficientes para identificar um gargalo de conversão.";
  candidates.sort((a: any, b: any) => a.value - b.value);
  const first: any = candidates[0];
  return `Menor conversão observada: ${first.label} em ${pct(first.value)}.`;
}
function reporterSummary(reports: any[]) {
  const map = new Map<string, any>();
  for (const row of reports) {
    const key = String(row.reporter || "Não identificado");
    const item = map.get(key) || { reporter: key, reports: 0, leads_received: 0, calls_made: 0, calls_answered: 0, conversations: 0, visits_scheduled: 0, visits_completed: 0, proposals: 0 };
    item.reports += 1;
    for (const field of ["leads_received","calls_made","calls_answered","conversations","visits_scheduled","visits_completed","proposals"]) item[field] += n(row[field]);
    map.set(key, item);
  }
  return [...map.values()].map((row) => ({ ...row, ...metricsFrom(row, 0) })).sort((a, b) => b.visits_completed - a.visits_completed || b.proposals - a.proposals || b.calls_answered - a.calls_answered || b.leads_received - a.leads_received);
}
function metaCross(commercialLeads: number, metaRows: any[], weekEnd: string, gtOwner: string) {
  if (!metaRows.length) return {
    meta_leads: null, meta_source: null, meta_cross_status: "META_UNAVAILABLE", meta_difference: null, meta_difference_pct: null, confidence_level: "BAIXA",
    warning: `Este relatório foi elaborado exclusivamente com os dados encontrados no grupo comercial. Não foi possível consultar o volume de leads do Meta Ads para todo o período. Antes de enviar ao cliente, consulte ${gtOwner || "o Gestor de Tráfego responsável"} e confirme quantos leads foram efetivamente gerados pelas campanhas; depois cruze esse total com o comercial para verificar se não há leads faltando no reporte.`,
  };
  const latest = metaRows.map((row) => String(row.date)).sort().at(-1) || "";
  const metaLeads = metaRows.reduce((sum, row) => sum + n(row.leads), 0);
  if (latest < weekEnd) return {
    meta_leads: metaLeads, meta_source: "meta_api_daily_sync", meta_cross_status: "META_PARTIAL", meta_difference: null, meta_difference_pct: null, confidence_level: "BAIXA",
    warning: `O Meta foi consultado, mas os dados diários disponíveis vão somente até ${latest.split("-").reverse().join("/")}; portanto o cruzamento da semana ainda está incompleto. Antes de enviar ao cliente, consulte ${gtOwner || "o Gestor de Tráfego responsável"} e confirme o total real do período.`,
  };
  const difference = commercialLeads - metaLeads;
  const differencePct = metaLeads ? Number((Math.abs(difference) / metaLeads * 100).toFixed(1)) : (commercialLeads ? 100 : 0);
  if (difference === 0) return { meta_leads: metaLeads, meta_source: "meta_api_daily_sync", meta_cross_status: "MATCH", meta_difference: 0, meta_difference_pct: 0, confidence_level: "ALTA", warning: "Meta Ads e grupo comercial conferem para o volume de leads do período." };
  const status = difference < 0 ? "DIVERGENCE_META_HIGHER" : "DIVERGENCE_COMMERCIAL_HIGHER";
  const confidence = differencePct <= 5 ? "MEDIA" : differencePct > 20 ? "CRITICA" : "BAIXA";
  const warning = difference < 0
    ? `O Meta Ads registra ${metaLeads} leads, enquanto o comercial reporta ${commercialLeads}. Há ${Math.abs(difference)} lead(s) a menos no reporte comercial (${differencePct.toLocaleString("pt-BR")}%). Antes de enviar ao cliente, valide com ${gtOwner || "o GT responsável"} se todos os leads chegaram e foram reportados.`
    : `O comercial reporta ${commercialLeads} leads, enquanto o Meta Ads registra ${metaLeads}. Há ${difference} lead(s) adicionais no comercial. Eles podem vir de Google, orgânico, portais, indicação ou outra fonte; confirme a origem antes de atribuir todo o volume ao Meta.`;
  return { meta_leads: metaLeads, meta_source: "meta_api_daily_sync", meta_cross_status: status, meta_difference: difference, meta_difference_pct: differencePct, confidence_level: confidence, warning };
}
function buildMessage(client: any, weekStart: string, weekEnd: string, metrics: any, contexts: any, reporters: any[], cross: any) {
  const fmt = (date: string) => date.split("-").reverse().join("/");
  const lines: string[] = [`Pessoal, passando com o fechamento comercial da semana de ${fmt(weekStart)} a ${fmt(weekEnd)}.`];
  if (cross.meta_cross_status === "MATCH") lines.push(`O Meta registrou ${cross.meta_leads} leads no período e esse volume confere com o total reportado pelo comercial.`);
  else lines.push(`Nos dados comerciais disponíveis, foram reportados ${metrics.leads_received} leads no período.`);
  lines.push("");
  lines.push(`• Tentativas de contato: ${metrics.calls_made} — ${pct(metrics.attempt_rate)} dos leads; ${contexts.attempt_rate.context}.`);
  lines.push(`• Contatos atendidos: ${metrics.calls_answered} — ${pct(metrics.answer_lead_rate)} dos leads e ${pct(metrics.answer_attempt_rate)} das tentativas; ${contexts.answer_attempt_rate.context}.`);
  lines.push(`• Leads em conversa: ${metrics.conversations} — ${pct(metrics.conversation_answer_rate)} dos contatos atendidos; ${contexts.conversation_answer_rate.context}.`);
  lines.push(`• Visitas agendadas: ${metrics.visits_scheduled} — ${pct(metrics.visit_schedule_rate)} dos leads em conversa; ${contexts.visit_schedule_rate.context}.`);
  lines.push(`• Visitas realizadas: ${metrics.visits_completed} — ${pct(metrics.visit_completion_rate)} das visitas agendadas; ${contexts.visit_completion_rate.context}.`);
  lines.push(`• Propostas: ${metrics.proposals} — ${pct(metrics.proposal_rate)} das visitas realizadas; ${contexts.proposal_rate.context}.`);
  if (metrics.sales > 0 || metrics.proposals > 0) lines.push(`• Vendas identificadas: ${metrics.sales} — ${pct(metrics.sale_proposal_rate)} das propostas e ${pct(metrics.sale_lead_rate)} dos leads; ${contexts.sale_lead_rate.context}.`);
  lines.push("");
  lines.push(bottleneck(contexts));
  if (reporters.length) {
    const top = reporters[0];
    lines.push(`Destaque da semana: ${top.reporter}, com ${top.visits_completed} visita(s) realizada(s), ${top.proposals} proposta(s) e ${top.calls_answered} contato(s) atendido(s).`);
    lines.push("");
    lines.push("Resumo por corretor:");
    for (const row of reporters) {
      lines.push(`• ${row.reporter}: ${row.leads_received} leads; ${row.calls_made} tentativas (${pct(row.attempt_rate)}); ${row.calls_answered} atendidos (${pct(row.answer_attempt_rate)} das tentativas); ${row.conversations} em conversa; ${row.visits_scheduled} visitas agendadas; ${row.visits_completed} realizadas; ${row.proposals} propostas.`);
    }
  }
  lines.push("");
  lines.push("Na próxima semana, vamos acompanhar principalmente o ponto de menor conversão do funil e a evolução dessas taxas em relação a esta base.");
  return lines.join("\n");
}
async function fetchPages(queryFactory: (from: number, to: number) => any, pageSize = 1000) {
  const all: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return all;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return reply({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user?.id) return reply({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = authData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person || pref?.name || null;
  if (!person || !(approvals || []).length) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster || !["CS","MGMT"].includes(String(roster.role))) return reply({ error: "forbidden", detail: "Relatórios de sexta são liberados para CS e gestão." }, 403);

  const window = reportWindow();
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const { data: clients, error: clientsError } = await ops.from("dashboard_client_overview")
    .select("client_id,display_name,lifecycle,gt_owner,cs_owner")
    .in("lifecycle", ["ACTIVE","ONBOARDING"]).order("display_name");
  if (clientsError) return reply({ error: "clients_query_failed", detail: clientsError.message }, 500);
  const clientRows = clients || [];
  const clientIds = clientRows.map((row: any) => String(row.client_id));
  const clientMap = new Map(clientRows.map((row: any) => [String(row.client_id), row]));

  if (window.releaseOpen && (refresh || true) && clientIds.length) {
    const { data: groups, error: groupError } = await ops.from("whatsapp_group_registry").select("chat_id,chat_name,client_id,group_kind").in("client_id", clientIds);
    if (groupError) return reply({ error: "groups_query_failed", detail: groupError.message }, 500);
    const commercialGroups = (groups || []).filter((row: any) => row.group_kind === "COMERCIAL");
    const commercialIds = commercialGroups.map((row: any) => row.chat_id);
    const groupMap = new Map(commercialGroups.map((row: any) => [String(row.chat_id), row]));
    let messages: any[] = [];
    if (commercialIds.length) messages = await fetchPages((from, to) => ops.from("whatsapp_messages")
      .select("id,chat_id,chat_name,event_at,sender_name,text_body,caption")
      .in("chat_id", commercialIds).gte("event_at", window.startIso).lt("event_at", window.endExclusiveIso)
      .order("event_at", { ascending: true }).range(from, to));
    const parsed = dedupeReports(messages.map((row) => {
      const group: any = groupMap.get(String(row.chat_id));
      return parseCommercial(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name });
    }).filter(Boolean));
    const saleRows = dedupeSales(messages.map((row) => {
      const group: any = groupMap.get(String(row.chat_id));
      return saleFromMessage(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name });
    }).filter(Boolean) as Sale[]);
    const { data: media } = await ops.from("media_metrics_daily").select("client_id,date,leads,spend,source")
      .in("client_id", clientIds).gte("date", window.weekStart).lte("date", window.weekEnd).eq("source", "meta_api_daily_sync");
    const { data: previousRows } = await ops.from("weekly_commercial_reports").select("client_id,metrics").eq("week_end", window.previousWeekEnd);
    const previousMap = new Map((previousRows || []).map((row: any) => [String(row.client_id), row.metrics || {}]));

    for (const client of clientRows) {
      const cid = String(client.client_id);
      const all = parsed.filter((row: any) => String(row.client_id) === cid);
      const nonAggregate = all.filter((row: any) => !row.is_aggregate);
      const effective = nonAggregate.length ? nonAggregate : all;
      const base = sumReports(effective);
      const clientSales = saleRows.filter((row) => String(row.client_id) === cid).reduce((sum, row) => sum + n(row.quantity), 0);
      const metrics = metricsFrom(base, clientSales);
      const previous = previousMap.get(cid) || {};
      const contexts = metricContexts(metrics, previous);
      const reporters = reporterSummary(effective);
      const clientMedia = (media || []).filter((row: any) => String(row.client_id) === cid);
      const cross = metaCross(metrics.leads_received, clientMedia, window.weekEnd, String(client.gt_owner || ""));
      const message = buildMessage(client, window.weekStart, window.weekEnd, metrics, contexts, reporters, cross);
      const sourceSummary = cross.meta_cross_status === "MATCH" ? "Grupo Comercial + Meta API diário (conferidos)" : cross.meta_cross_status === "META_UNAVAILABLE" ? "Somente Grupo Comercial; Meta não disponível" : cross.meta_cross_status === "META_PARTIAL" ? "Grupo Comercial + Meta parcial; cruzamento incompleto" : "Grupo Comercial + Meta API diário; divergência identificada";
      const { error: upsertError } = await ops.from("weekly_commercial_reports").upsert({
        client_id: cid, week_start: window.weekStart, week_end: window.weekEnd, cs_owner: client.cs_owner, gt_owner: client.gt_owner,
        commercial_leads: metrics.leads_received, meta_leads: cross.meta_leads, meta_source: cross.meta_source,
        meta_cross_status: cross.meta_cross_status, meta_difference: cross.meta_difference, meta_difference_pct: cross.meta_difference_pct,
        confidence_level: cross.confidence_level, metrics, previous_metrics: previous, reporters,
        context: { rate_contexts: contexts, bottleneck: bottleneck(contexts), commercial_reports_used: effective.length, aggregate_fallback: !nonAggregate.length && all.length > 0 },
        client_message: message, internal_warning: cross.warning, source_summary: sourceSummary, generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "client_id,week_end" });
      if (upsertError) return reply({ error: "report_upsert_failed", client_id: cid, detail: upsertError.message }, 500);
    }
  }

  const { data: history, error: historyError } = await ops.from("weekly_commercial_reports").select("*").order("week_end", { ascending: false }).order("client_id").limit(1200);
  if (historyError) return reply({ error: "history_query_failed", detail: historyError.message }, 500);
  const current = (history || []).filter((row: any) => String(row.week_end) === window.weekEnd);
  return reply({
    profile: { person, role: roster.role }, release_open: window.releaseOpen,
    current_week: { start: window.weekStart, end: window.weekEnd }, current_reports: current,
    history: history || [], generated_at: new Date().toISOString(),
  });
});
