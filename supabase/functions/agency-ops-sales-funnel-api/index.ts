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
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const bodyOf = (row: any) => String(row.text_body || row.caption || "").trim();

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
  if (leads == null) return null; // pergunta vazia do CS/gestor nao e reporte
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
    source: "COMERCIAL",
    evidence: raw.slice(0, 1800),
  };
}

type Evidence = {
  message_id: number;
  client_id: string | null;
  client_name: string;
  event_at: string;
  sender_name: string;
  stage: "VISIT_SCHEDULED" | "VISIT_COMPLETED" | "PROPOSAL" | "DOCUMENT";
  quantity: number;
  source: "MARKETING";
  confidence: "HIGH" | "MEDIUM";
  evidence: string;
};

function maxMatches(body: string, patterns: RegExp[]) {
  let best = 0;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    for (const match of body.matchAll(re)) best = Math.max(best, Number(match[1] || 0));
  }
  return best;
}

function marketingEvidence(row: any, client: any): Evidence[] {
  const raw = bodyOf(row);
  const body = norm(raw);
  const base = {
    message_id: Number(row.id), client_id: client?.client_id || null,
    client_name: client?.display_name || row.chat_name || "Cliente", event_at: row.event_at,
    sender_name: row.sender_name || "Não identificado", source: "MARKETING" as const,
    evidence: raw.slice(0, 1800),
  };
  const out: Evidence[] = [];
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

type Sale = {
  message_id: number;
  client_id: string | null;
  client_name: string;
  event_at: string;
  quantity: number;
  attribution: "AGENCY" | "UNKNOWN" | "THIRD_PARTY";
  source: "MARKETING" | "COMERCIAL";
  evidence: string;
  sale_key: string;
};

function saleFromMessage(row: any, client: any, source: "MARKETING" | "COMERCIAL"): Sale | null {
  const raw = bodyOf(row);
  const body = norm(raw);
  if (!/(venda|vendid|negocio fechado|vendemos|fechamos)/.test(body)) return null;
  if (/boas vendas|queremos?\s+vendas|gerar vendas|aumentar.*vendas|sera nossa.*venda|expectativa.*venda|campanha.*\[venda\]|\[vendas\]/.test(body)) return null;

  const third = /por terceiros?|pela concorrencia|outra corretora|pelo proprietario|comprou direto|fechou negocio em outro lugar/.test(body);
  let quantity = 0;
  let saleKey = "";
  let match = body.match(/fechamos\s+(\d+)\s+vendas?/);
  if (match) { quantity = Number(match[1]); saleKey = `summary-${String(row.event_at).slice(0, 7)}-${quantity}`; }
  if (!quantity && (match = body.match(/resultado\s*[:\-]?\s*(\d+)\s+vendas?/))) { quantity = Number(match[1]); saleKey = `summary-${String(row.event_at).slice(0, 10)}-${quantity}`; }
  if (!quantity && (match = body.match(/(\d+)\s+vendas?\s+concluidas?/))) { quantity = Number(match[1]); saleKey = body.includes("julho") ? "summary-julho" : body.includes("junho") ? "summary-junho" : `summary-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /\b1\s+venda\b/.test(body) && /(parab|concluid|resultado|fech|venda !!!|venda!)/.test(body)) { quantity = 1; saleKey = `single-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /saiu uma venda|fechamos uma venda|primeira venda ganha|unico negocio fechado|vendemos!!!|comemorando sua venda|parabens pela venda/.test(body)) { quantity = 1; saleKey = `single-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /cliente que fechou da campanha/.test(body)) { quantity = 1; saleKey = `campaign-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity && /(casa|apto|apartamento|unidade|imovel)[^.!\n]{0,80}\bvendid[oa]\b/.test(body)) {
    quantity = 1;
    const property = body.match(/((?:casa|apto|apartamento|unidade|imovel|residencial)[^.!\n]{0,55})\bvendid[oa]\b/)?.[1]?.replace(/\s+/g, " ").trim();
    saleKey = property || `property-${String(row.event_at).slice(0, 10)}`;
  }
  if (!quantity && /foi vendido|foi vendida|vendida\. pode parar|vendido\. pode parar/.test(body)) { quantity = 1; saleKey = `property-${String(row.event_at).slice(0, 10)}`; }
  if (!quantity) return null;

  const agency = /do trafego|da campanha|vindo desse anuncio|lead entrou|lead nosso|conseguimos a venda/.test(body);
  return {
    message_id: Number(row.id), client_id: client?.client_id || null,
    client_name: client?.display_name || row.chat_name || "Cliente", event_at: row.event_at,
    quantity, attribution: third ? "THIRD_PARTY" : agency ? "AGENCY" : "UNKNOWN", source,
    evidence: raw.slice(0, 1800), sale_key: saleKey,
  };
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

function dedupeSales(rows: Sale[]) {
  const sorted = [...rows].sort((a, b) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime());
  const out: Sale[] = [];
  for (const row of sorted) {
    if (row.attribution === "THIRD_PARTY") { out.push(row); continue; }
    const day = new Date(row.event_at).getTime();
    const duplicate = out.find((item) => {
      if (item.client_id !== row.client_id || item.attribution === "THIRD_PARTY") return false;
      if (item.sale_key === row.sale_key) return true;
      const delta = Math.abs(day - new Date(item.event_at).getTime());
      return row.quantity === 1 && item.quantity === 1 && delta <= 36 * 60 * 60 * 1000 && (row.sale_key.startsWith("single-") || item.sale_key.startsWith("single-"));
    });
    if (!duplicate) out.push(row);
    else if (row.attribution === "AGENCY" && duplicate.attribution !== "AGENCY") duplicate.attribution = "AGENCY";
  }
  return out.sort((a, b) => new Date(b.event_at).getTime() - new Date(a.event_at).getTime());
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
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .order("display_name");
  if (clientsError) return reply({ error: "clients_query_failed", detail: clientsError.message }, 500);
  const scopedClients = (clientRows || []).filter((row: any) => roster.role !== "GT" || row.gt_owner === person);
  const allowed = new Set(scopedClients.map((row: any) => String(row.client_id)));
  const clientMap = new Map(scopedClients.map((row: any) => [String(row.client_id), row]));

  const { data: groups, error: groupsError } = await ops.from("whatsapp_group_registry")
    .select("chat_id,chat_name,client_id,group_kind")
    .in("client_id", [...allowed]);
  if (groupsError) return reply({ error: "groups_query_failed", detail: groupsError.message }, 500);
  const commercialGroups = (groups || []).filter((row: any) => row.group_kind === "COMERCIAL");
  const marketingGroups = (groups || []).filter((row: any) => String(row.chat_name || "").toUpperCase().includes("MARKETING"));
  const groupMap = new Map((groups || []).map((row: any) => [String(row.chat_id), row]));

  const commercialIds = commercialGroups.map((row: any) => row.chat_id);
  const marketingIds = marketingGroups.map((row: any) => row.chat_id);
  let commercialMessages: any[] = [];
  let marketingMessages: any[] = [];
  try {
    if (commercialIds.length) commercialMessages = await fetchPages((from, to) => ops.from("whatsapp_messages")
      .select("id,chat_id,chat_name,event_at,sender_name,text_body,caption")
      .in("chat_id", commercialIds).order("event_at", { ascending: true }).range(from, to));
    if (marketingIds.length) marketingMessages = await fetchPages((from, to) => ops.from("whatsapp_messages")
      .select("id,chat_id,chat_name,event_at,sender_name,text_body,caption")
      .in("chat_id", marketingIds)
      .or("text_body.ilike.%visita%,text_body.ilike.%proposta%,text_body.ilike.%documenta%,text_body.ilike.%venda%,text_body.ilike.%vendid%,text_body.ilike.%negócio fechado%,caption.ilike.%visita%,caption.ilike.%proposta%,caption.ilike.%documenta%,caption.ilike.%venda%,caption.ilike.%vendid%")
      .order("event_at", { ascending: true }).range(from, to));
  } catch (error: any) {
    return reply({ error: "messages_query_failed", detail: error?.message || String(error) }, 500);
  }

  const reports = dedupeReports(commercialMessages.map((row) => {
    const group: any = groupMap.get(String(row.chat_id));
    return parseCommercial(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name });
  }).filter(Boolean));

  const evidence = marketingMessages.flatMap((row) => {
    const group: any = groupMap.get(String(row.chat_id));
    return marketingEvidence(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name });
  }).sort((a, b) => new Date(b.event_at).getTime() - new Date(a.event_at).getTime());

  const saleCandidates: Sale[] = [];
  for (const row of [...commercialMessages, ...marketingMessages]) {
    const group: any = groupMap.get(String(row.chat_id));
    const sale = saleFromMessage(row, clientMap.get(String(group?.client_id)) || { client_id: group?.client_id, display_name: group?.chat_name }, group?.group_kind === "COMERCIAL" ? "COMERCIAL" : "MARKETING");
    if (sale) saleCandidates.push(sale);
  }
  const sales = dedupeSales(saleCandidates);

  const { data: media } = await ops.from("campaign_client_latest")
    .select("client_id,display_name,gt_owner,latest_date,leads,spend,active_campaigns,cost_per_result")
    .in("client_id", [...allowed]);

  return reply({
    profile: { person, role: roster.role, scope: roster.role === "GT" ? "OWN_WALLET" : "ALL_CLIENTS" },
    clients: scopedClients,
    commercial_reports: reports,
    marketing_evidence: evidence,
    sales,
    media: media || [],
    coverage: {
      clients: scopedClients.length,
      commercial_groups: commercialGroups.length,
      marketing_groups: marketingGroups.length,
      commercial_messages: commercialMessages.length,
      marketing_candidate_messages: marketingMessages.length,
    },
    generated_at: new Date().toISOString(),
  });
});