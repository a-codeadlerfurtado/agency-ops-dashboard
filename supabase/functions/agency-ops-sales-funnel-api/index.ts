import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const bodyOf = (row: any) => String(row.text_body || row.caption || "").trim();

function metric(body: string, label: string) {
  const match = body.match(new RegExp(`${label}\\?[^0-9]{0,35}([0-9]+)`, "i"));
  return match ? Number(match[1]) : null;
}
function referenceLabel(body: string, eventAt: string) {
  const normalized = norm(body);
  return normalized.match(/numeros ref\.?\s*\*?([^\n]+)/i)?.[1]?.replace(/\*/g, "").trim().slice(0, 80)
    || normalized.match(/essas metricas sao referentes aos dados de\s+([^\n\]]+)/i)?.[1]?.trim().slice(0, 80)
    || String(eventAt || "").slice(0, 10);
}
function parseCommercial(row: any, client: any) {
  const raw = bodyOf(row), body = norm(raw);
  if (!body.includes("quantos leads receberam")) return null;
  const leads = metric(body, "quantos leads receberam");
  if (leads == null) return null;
  return {
    message_id: row.id, client_id: client?.client_id || null, client_name: client?.display_name || row.chat_name || "Cliente",
    reporter: row.sender_name || "Não identificado", event_at: row.event_at, reference_label: referenceLabel(raw, row.event_at),
    is_aggregate: /mes de julho|mes de agosto|dados da semana|dados de julho|dados de agosto/.test(body),
    leads_received: leads, calls_made: metric(body, "quantas ligacoes efetuadas") ?? 0,
    calls_answered: metric(body, "quantas ligacoes atendidas") ?? 0, conversations: metric(body, "em conversa") ?? 0,
    visits_scheduled: metric(body, "quantas visitas agendadas") ?? 0, visits_completed: metric(body, "quantas visitas realizadas") ?? 0,
    proposals: metric(body, "quantas propostas emitidas") ?? 0, source: "COMERCIAL", evidence: raw.slice(0, 1800),
  };
}
function maxMatches(body: string, patterns: RegExp[]) {
  let best = 0;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of body.matchAll(re)) best = Math.max(best, Number(match[1] || 0));
  }
  return best;
}
function whatsappEvidence(row: any, client: any) {
  const raw = bodyOf(row), body = norm(raw);
  const base = {
    message_id: Number(row.id), client_id: client?.client_id || null, client_name: client?.display_name || row.chat_name || "Cliente",
    event_at: row.event_at, sender_name: row.sender_name || "Não identificado", source: "WHATSAPP", evidence: raw.slice(0, 1800),
  };
  const out: any[] = [];
  const scheduled = maxMatches(body, [/(\d+)\s+visitas?\s+(?:agendadas|marcadas)/i, /visitas?\s+(?:agendadas|marcadas)\s*[:\-]?\s*(\d+)/i]);
  if (scheduled) out.push({ ...base, stage: "VISIT_SCHEDULED", quantity: scheduled, confidence: "HIGH" });
  const completed = maxMatches(body, [/(\d+)\s+visitas?\s+(?:realizadas|feitas|concluidas)/i, /(?:tivemos|foram)\s+(\d+)\s+visitas\b/i]);
  if (completed) out.push({ ...base, stage: "VISIT_COMPLETED", quantity: completed, confidence: "HIGH" });
  let proposals = maxMatches(body, [/(\d+)\s+propostas?\s+(?:emitidas|enviadas|feitas|realizadas|apresentadas)/i]);
  if (!proposals && /(?:saiu|teve|tivemos)\s+(?:uma|1)\s+proposta|uma proposta que era/.test(body)) proposals = 1;
  if (proposals) out.push({ ...base, stage: "PROPOSAL", quantity: proposals, confidence: "HIGH" });
  const docs = Math.max(
    maxMatches(body, [/(\d+)\s+clientes?\s+enviaram\s+documentacao/i]),
    maxMatches(body, [/(\d+)\s+documentacoes?\s+(?:enviadas|aprovadas|condicionadas)/i]),
  );
  if (docs) out.push({ ...base, stage: "DOCUMENT", quantity: docs, confidence: "HIGH" });
  return out;
}
function dedupeReports(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.client_id}|${norm(row.reporter)}|${norm(row.reference_label)}`;
    const current = map.get(key);
    if (!current || new Date(row.event_at).getTime() > new Date(current.event_at).getTime()) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => new Date(b.event_at).getTime() - new Date(a.event_at).getTime());
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
function canonicalSale(row: any, client: any) {
  const effective = row.sale_date
    ? `${row.sale_date}T12:00:00-03:00`
    : row.sale_period_end
      ? `${row.sale_period_end}T12:00:00-03:00`
      : row.reported_at || row.occurred_at;
  const source = ["DONNAH", "DRIVE_TRANSCRIPT"].includes(String(row.source_system)) ? "TRANSCRIPT"
    : row.source_system === "WHATSAPP" ? "WHATSAPP" : String(row.source_system || "REGISTRO");
  return {
    id: row.id, message_id: row.source_system === "WHATSAPP" ? Number(row.source_record_id) || row.id : row.id,
    client_id: row.client_id, client_name: client?.display_name || "Cliente",
    event_at: effective, reported_at: row.reported_at || row.occurred_at,
    sale_date: row.sale_date, sale_period_start: row.sale_period_start, sale_period_end: row.sale_period_end,
    date_precision: row.date_precision || "UNKNOWN", quantity: Number(row.quantity || 1),
    attribution: row.attribution || "UNKNOWN", source, source_system: row.source_system,
    evidence: row.source_excerpt || "", sale_key: row.dedupe_key, confidence_score: row.confidence_score,
    property_reference: row.property_reference, vgv: row.vgv, metadata: row.metadata || {},
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person || pref?.name || null;
  if (!person || !(approvals || []).length) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster || !["MGMT", "CS", "GT", "AI"].includes(String(roster.role))) return reply({ error: "forbidden" }, 403);

  const { data: clientRows, error: clientsError } = await ops.from("dashboard_client_overview")
    .select("client_id,display_name,lifecycle,gt_owner,cs_owner,priority")
    .in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name");
  if (clientsError) return reply({ error: "clients_query_failed", detail: clientsError.message }, 500);
  const scopedClients = (clientRows || []).filter((row: any) => roster.role !== "GT" || row.gt_owner === person);
  const allowedIds = scopedClients.map((row: any) => String(row.client_id));
  const clientMap = new Map(scopedClients.map((row: any) => [String(row.client_id), row]));
  if (!allowedIds.length) return reply({
    profile: { person, role: roster.role, scope: roster.role === "GT" ? "OWN_WALLET" : "ALL_CLIENTS" },
    clients: [], commercial_reports: [], marketing_evidence: [], sales: [], media: [],
    coverage: { clients: 0, linked_groups: 0, canonical_sale_events: 0, sale_candidates_review: 0 },
    generated_at: new Date().toISOString(),
  });

  const [{ data: groups, error: groupsError }, { data: links, error: linksError }] = await Promise.all([
    ops.from("whatsapp_group_registry").select("chat_id,chat_name,client_id,group_kind").in("client_id", allowedIds),
    ops.from("conversation_state").select("chat_id,client_id").in("client_id", allowedIds),
  ]);
  if (groupsError || linksError) return reply({ error: "groups_query_failed", detail: groupsError?.message || linksError?.message }, 500);

  const commercialGroups = (groups || []).filter((row: any) => row.group_kind === "COMERCIAL");
  const commercialIds = [...new Set(commercialGroups.map((row: any) => String(row.chat_id)))];
  const linkedMap = new Map<string, string>();
  for (const row of links || []) if (row.chat_id && row.client_id) linkedMap.set(String(row.chat_id), String(row.client_id));
  for (const row of groups || []) if (row.chat_id && row.client_id) linkedMap.set(String(row.chat_id), String(row.client_id));
  const linkedIds = [...linkedMap.keys()];

  let commercialMessages: any[] = [];
  let stageMessages: any[] = [];
  try {
    if (commercialIds.length) commercialMessages = await fetchPages((from, to) => ops.from("whatsapp_messages")
      .select("id,chat_id,chat_name,event_at,sender_name,text_body,caption")
      .in("chat_id", commercialIds).order("event_at", { ascending: true }).range(from, to));
    if (linkedIds.length) stageMessages = await fetchPages((from, to) => ops.from("whatsapp_messages")
      .select("id,chat_id,chat_name,event_at,sender_name,text_body,caption")
      .in("chat_id", linkedIds)
      .or("text_body.ilike.%visita%,text_body.ilike.%proposta%,text_body.ilike.%documenta%,caption.ilike.%visita%,caption.ilike.%proposta%,caption.ilike.%documenta%")
      .order("event_at", { ascending: true }).range(from, to));
  } catch (error: any) {
    return reply({ error: "messages_query_failed", detail: error?.message || String(error) }, 500);
  }

  const commercialMap = new Map((commercialGroups || []).map((row: any) => [String(row.chat_id), row]));
  const reports = dedupeReports(commercialMessages.map((row) => {
    const group: any = commercialMap.get(String(row.chat_id));
    return parseCommercial(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name });
  }).filter(Boolean));

  const evidence = stageMessages.flatMap((row) => {
    const clientId = linkedMap.get(String(row.chat_id));
    return whatsappEvidence(row, clientMap.get(String(clientId)) || { client_id: clientId, display_name: row.chat_name });
  }).sort((a, b) => new Date(b.event_at).getTime() - new Date(a.event_at).getTime());

  const [
    { data: saleRows, error: salesError },
    { count: candidateCount, error: candidateError },
    { data: media },
    { data: transcriptHealth },
  ] = await Promise.all([
    ops.from("client_won_events")
      .select("id,dedupe_key,client_id,occurred_at,quantity,sale_date,sale_period_start,sale_period_end,date_precision,reported_at,source_system,source_record_id,source_excerpt,attribution,confidence_score,event_status,property_reference,vgv,metadata")
      .in("client_id", allowedIds).eq("event_status", "CONFIRMED").order("reported_at", { ascending: false }),
    ops.from("sales_event_candidates").select("id", { count: "exact", head: true }).in("client_id", allowedIds).eq("status", "NEEDS_REVIEW").gte("confidence_score", 0.5),
    ops.from("campaign_client_latest").select("client_id,display_name,gt_owner,latest_date,leads,spend,active_campaigns,cost_per_result").in("client_id", allowedIds),
    ops.from("transcript_ingestion_health").select("*").maybeSingle(),
  ]);
  if (salesError || candidateError) return reply({ error: "sales_query_failed", detail: salesError?.message || candidateError?.message }, 500);

  const sales = (saleRows || []).map((row: any) => canonicalSale(row, clientMap.get(String(row.client_id))));

  return reply({
    profile: { person, role: roster.role, scope: roster.role === "GT" ? "OWN_WALLET" : "ALL_CLIENTS" },
    clients: scopedClients,
    commercial_reports: reports,
    marketing_evidence: evidence,
    sales,
    media: media || [],
    transcript_health: transcriptHealth || null,
    coverage: {
      clients: scopedClients.length,
      linked_groups: linkedIds.length,
      commercial_groups: commercialGroups.length,
      commercial_messages: commercialMessages.length,
      whatsapp_stage_candidate_messages: stageMessages.length,
      canonical_sale_events: sales.length,
      sale_candidates_review: candidateCount || 0,
      transcript_status: transcriptHealth?.health_status || "UNKNOWN",
      transcript_rows: Number(transcriptHealth?.transcript_rows || 0),
      transcript_last_ingest: transcriptHealth?.last_ingest_at || null,
    },
    generated_at: new Date().toISOString(),
  });
});