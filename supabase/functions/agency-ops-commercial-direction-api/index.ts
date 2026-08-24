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
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const n = (value: unknown) => Number(value ?? 0) || 0;
const daysSince = (value: unknown) => {
  if (!value) return null;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 86400000)) : null;
};
const ownerLabel = (email: unknown) => {
  const key = norm(email);
  if (key === "lakassessoriadigital@gmail.com") return "Leonardo Augusto";
  if (key === "feitozaluizvitor@gmail.com") return "Vitor Feitoza";
  if (!key) return "Não atribuído";
  return String(email).split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};
const stageWeight: Record<string, number> = {
  novo: 0.10,
  qualificacao: 0.25,
  reuniao: 0.45,
  proposta: 0.65,
  negociacao: 0.80,
  fechado: 1,
  perdido: 0,
};
const stageRank: Record<string, number> = { negociacao: 0, proposta: 1, reuniao: 2, qualificacao: 3, novo: 4, fechado: 5, perdido: 6 };
const commercialMeetingOwners = new Set(["leonardo augusto", "vitor feitoza", "luiz vitor feitoza"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const crm = db.schema("crm");
  const userKey = userData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name,role,metadata").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person || pref?.name || null;
  if (!person || !(approvals || []).length) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "forbidden" }, 403);
  const isAdler = person === "Adler Furtado";
  if (!isAdler && String(roster.role) !== "COMMERCIAL") return reply({ error: "forbidden" }, 403);

  const { data: crmProfiles, error: profileError } = await db.from("profiles").select("id,email,sees_all_leads").eq("sees_all_leads", true);
  if (profileError) return reply({ error: "crm_profiles_failed", detail: profileError.message }, 500);
  const realOwners = (crmProfiles || []).map((row: any) => String(row.id));
  const ownerMap = new Map((crmProfiles || []).map((row: any) => [String(row.id), { email: row.email, name: ownerLabel(row.email) }]));

  const leadQuery = realOwners.length
    ? crm.from("leads").select("id,owner_id,name,company,stage,estimated_value,source,created_at,updated_at,closed_at,closed_monthly_value,closed_setup_value,archived_at").in("owner_id", realOwners).order("updated_at", { ascending: false }).limit(1500)
    : Promise.resolve({ data: [], error: null });
  const [leadResult, goalResult, clientResult, campaignResult, meetingResult] = await Promise.all([
    leadQuery,
    realOwners.length
      ? crm.from("closer_goals").select("owner_id,ano,mes,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id", realOwners).order("ano", { ascending: false }).order("mes", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("entrada", { ascending: false }).limit(1000),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle", ["ACTIVE", "ONBOARDING"]).gt("active_campaigns", 0).order("spend", { ascending: false }).limit(1000),
    ops.from("meeting_transcripts").select("meeting_started_at,ingested_at,metadata").order("ingested_at", { ascending: false }).limit(500),
  ]);
  const failed = [leadResult, goalResult, clientResult, campaignResult, meetingResult].find((result: any) => result?.error);
  if (failed?.error) return reply({ error: "query_failed", detail: failed.error.message }, 500);

  const leads = (leadResult.data || [])
    .filter((row: any) => !row.archived_at)
    .map((row: any) => {
      const stage = norm(row.stage) || "novo";
      const estimated = n(row.estimated_value);
      const owner = ownerMap.get(String(row.owner_id));
      return {
        id: row.id,
        owner_id: row.owner_id,
        owner_name: owner?.name || "Não atribuído",
        name: row.name,
        company: row.company,
        stage,
        estimated_value: estimated,
        weighted_value: Number((estimated * (stageWeight[stage] ?? 0.1)).toFixed(2)),
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
        closed_at: row.closed_at,
        closed_monthly_value: row.closed_monthly_value,
        closed_setup_value: row.closed_setup_value,
      };
    })
    .sort((a: any, b: any) => (stageRank[a.stage] ?? 9) - (stageRank[b.stage] ?? 9) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const openLeads = leads.filter((row: any) => !["fechado", "perdido"].includes(row.stage));
  const advancedLeads = openLeads.filter((row: any) => ["reuniao", "proposta", "negociacao"].includes(row.stage));
  const performanceMap = new Map<string, any>();
  for (const profile of crmProfiles || []) performanceMap.set(String(profile.id), {
    owner_id: profile.id,
    owner_name: ownerLabel(profile.email),
    open_leads: 0,
    meetings: 0,
    proposals: 0,
    negotiations: 0,
    won: 0,
    weighted_value: 0,
  });
  for (const lead of leads) {
    const bucket = performanceMap.get(String(lead.owner_id));
    if (!bucket) continue;
    if (!["fechado", "perdido"].includes(lead.stage)) bucket.open_leads += 1;
    if (lead.stage === "reuniao") bucket.meetings += 1;
    if (lead.stage === "proposta") bucket.proposals += 1;
    if (lead.stage === "negociacao") bucket.negotiations += 1;
    if (lead.stage === "fechado") bucket.won += 1;
    if (!["fechado", "perdido"].includes(lead.stage)) bucket.weighted_value += n(lead.weighted_value);
  }
  const performance = [...performanceMap.values()].map((row: any) => ({ ...row, weighted_value: Number(row.weighted_value.toFixed(2)) }));
  const stageSummary = Object.entries(openLeads.reduce((acc: Record<string, any>, row: any) => {
    acc[row.stage] ||= { stage: row.stage, count: 0, informed_value: 0, weighted_value: 0 };
    acc[row.stage].count += 1;
    acc[row.stage].informed_value += n(row.estimated_value);
    acc[row.stage].weighted_value += n(row.weighted_value);
    return acc;
  }, {})).map(([, row]: any) => ({ ...row, informed_value: Number(row.informed_value.toFixed(2)), weighted_value: Number(row.weighted_value.toFixed(2)) }))
    .sort((a: any, b: any) => (stageRank[a.stage] ?? 9) - (stageRank[b.stage] ?? 9));

  const portfolioClients = (clientResult.data || []).map((row: any) => ({
    client_id: row.id,
    display_name: row.display_name,
    lifecycle: row.lifecycle,
    service: row.service,
    entrada: row.entrada,
    saida: row.saida,
    cs_owner: row.cs_owner,
    gt_owner: row.gt_owner,
    client_days: row.entrada ? daysSince(row.lifecycle === "CHURNED" && row.saida ? row.saida : row.entrada) : null,
  }));
  for (const row of portfolioClients) {
    if (!row.entrada) continue;
    const start = new Date(String(row.entrada)).getTime();
    const end = row.lifecycle === "CHURNED" && row.saida ? new Date(String(row.saida)).getTime() : Date.now();
    row.client_days = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 86400000)) : null;
  }

  const meetings7d = (meetingResult.data || []).filter((row: any) => (
    commercialMeetingOwners.has(norm(row.metadata?.mcp_owner_person))
    && (daysSince(row.meeting_started_at || row.ingested_at) ?? 999) <= 7
  )).length;
  const currentMonth = new Date();
  const goals = (goalResult.data || []).filter((row: any) => Number(row.ano) === currentMonth.getFullYear() && Number(row.mes) === currentMonth.getMonth() + 1).map((row: any) => ({
    ...row,
    owner_name: ownerMap.get(String(row.owner_id))?.name || "Comercial",
  }));

  return reply({
    profile: { person, role: roster.role, display_role: "Direção Comercial", read_only: true },
    summary: {
      open_leads: openLeads.length,
      new_7d: openLeads.filter((row: any) => (daysSince(row.created_at) ?? 999) <= 7).length,
      advanced_opportunities: advancedLeads.length,
      meetings_7d: meetings7d,
      informed_pipeline_value: Number(openLeads.reduce((sum: number, row: any) => sum + n(row.estimated_value), 0).toFixed(2)),
      weighted_forecast_value: Number(openLeads.reduce((sum: number, row: any) => sum + n(row.weighted_value), 0).toFixed(2)),
      active_clients: portfolioClients.filter((row: any) => ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle))).length,
      active_campaigns: (campaignResult.data || []).reduce((sum: number, row: any) => sum + n(row.active_campaigns), 0),
    },
    leads,
    stage_summary: stageSummary,
    performance,
    goals,
    campaigns: campaignResult.data || [],
    portfolio_clients: portfolioClients,
    data_quality: {
      real_crm_owners: realOwners.length,
      crm_leads: leads.length,
      note: "Perfil comercial: somente CRM, campanhas ativas e carteira básica. Dados operacionais não são consultados nem retornados.",
    },
    generated_at: new Date().toISOString(),
  });
});
