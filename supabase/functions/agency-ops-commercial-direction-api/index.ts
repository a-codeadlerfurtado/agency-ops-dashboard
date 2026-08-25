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
const ts = (value: unknown) => value ? new Date(String(value)).getTime() : NaN;
const daysSince = (value: unknown) => Number.isFinite(ts(value)) ? Math.max(0, Math.floor((Date.now() - ts(value)) / 86400000)) : null;
const hoursSince = (value: unknown) => Number.isFinite(ts(value)) ? Math.max(0, Number(((Date.now() - ts(value)) / 3600000).toFixed(1))) : null;
const ownerLabel = (email: unknown) => {
  const key = norm(email);
  if (key === "lakassessoriadigital@gmail.com") return "Leonardo Augusto";
  if (key === "feitozaluizvitor@gmail.com") return "Vitor Feitoza";
  if (!key) return "Não atribuído";
  return String(email).split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};
const stageWeight: Record<string, number> = { novo: .10, qualificacao: .25, reuniao: .45, proposta: .65, negociacao: .80, fechado: 1, perdido: 0 };
const stageRank: Record<string, number> = { negociacao: 0, proposta: 1, reuniao: 2, qualificacao: 3, novo: 4, fechado: 5, perdido: 6 };
const commercialMeetingOwners = new Set(["leonardo augusto", "vitor feitoza", "luiz vitor feitoza"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
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
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).length) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "forbidden" }, 403);
  const isAdler = person === "Adler Furtado";
  if (!isAdler && !(person === "Leonardo Augusto" && String(roster.role) === "COMMERCIAL")) return reply({ error: "forbidden" }, 403);

  const { data: crmProfiles, error: profileError } = await db.from("profiles").select("id,email,sees_all_leads").eq("sees_all_leads", true);
  if (profileError) return reply({ error: "crm_profiles_failed", detail: profileError.message }, 500);
  const realOwners = (crmProfiles || []).map((row: any) => String(row.id));
  const ownerMap = new Map((crmProfiles || []).map((row: any) => [String(row.id), ownerLabel(row.email)]));

  const leadQuery = realOwners.length
    ? crm.from("leads").select("id,owner_id,name,company,stage,estimated_value,source,created_at,updated_at,closed_at,days_in_stage,last_interaction,next_action_at,next_action,closed_monthly_value,closed_setup_value,closed_term_months,closed_monthly_first_month,closed_setup_first_month,closed_setup_payment,closed_setup_installment_values").in("owner_id", realOwners).order("updated_at", { ascending: false }).limit(2000)
    : Promise.resolve({ data: [], error: null });

  const [leadResult, goalResult, clientResult, campaignResult, meetingResult] = await Promise.all([
    leadQuery,
    realOwners.length
      ? crm.from("closer_goals").select("owner_id,ano,mes,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id", realOwners).order("ano", { ascending: false }).order("mes", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,cs_owner,gt_owner").order("entrada", { ascending: false }).limit(1200),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,active_campaigns,spend,leads,ctr,cost_per_result").in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("spend", { ascending: false }).limit(1200),
    ops.from("meeting_transcripts").select("id,meeting_started_at,ingested_at,client_id,match_status,participants,summary,metadata").order("ingested_at", { ascending: false }).limit(800),
  ]);
  const failed = [leadResult, goalResult, clientResult, campaignResult, meetingResult].find((result: any) => result?.error);
  if (failed?.error) return reply({ error: "query_failed", detail: failed.error.message }, 500);

  const leads = (leadResult.data || []).map((row: any) => {
    const stage = norm(row.stage) || "novo";
    const estimated = n(row.estimated_value);
    return {
      id: row.id,
      owner_id: row.owner_id,
      owner_name: ownerMap.get(String(row.owner_id)) || "Não atribuído",
      name: row.name,
      company: row.company,
      stage,
      estimated_value: estimated,
      weighted_value: Number((estimated * (stageWeight[stage] ?? .1)).toFixed(2)),
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      days_in_stage: row.days_in_stage,
      last_interaction: row.last_interaction,
      next_action_at: row.next_action_at,
      next_action: row.next_action,
      closed_at: row.closed_at,
      closed_monthly_value: row.closed_monthly_value,
      closed_setup_value: row.closed_setup_value,
      closed_term_months: row.closed_term_months,
      closed_monthly_first_month: row.closed_monthly_first_month,
      closed_setup_first_month: row.closed_setup_first_month,
      closed_setup_payment: row.closed_setup_payment,
      closed_setup_installment_values: row.closed_setup_installment_values,
    };
  }).sort((a: any, b: any) => (stageRank[a.stage] ?? 9) - (stageRank[b.stage] ?? 9) || ts(b.updated_at) - ts(a.updated_at));

  const openLeads = leads.filter((row: any) => !["fechado", "perdido"].includes(row.stage));
  const advancedLeads = openLeads.filter((row: any) => ["reuniao", "proposta", "negociacao"].includes(row.stage));
  const won30d = leads.filter((row: any) => row.stage === "fechado" && (daysSince(row.closed_at || row.updated_at) ?? 999) <= 30);

  const performanceMap = new Map<string, any>();
  for (const profile of crmProfiles || []) performanceMap.set(String(profile.id), {
    owner_id: profile.id,
    owner_name: ownerLabel(profile.email),
    open_leads: 0,
    meetings: 0,
    proposals: 0,
    negotiations: 0,
    won: 0,
    won_30d: 0,
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
    if (lead.stage === "fechado" && (daysSince(lead.closed_at || lead.updated_at) ?? 999) <= 30) bucket.won_30d += 1;
    if (!["fechado", "perdido"].includes(lead.stage)) bucket.weighted_value += n(lead.weighted_value);
  }
  const performance = [...performanceMap.values()].map((row: any) => ({ ...row, weighted_value: Number(row.weighted_value.toFixed(2)) }));
  const stageSummary = Object.values(openLeads.reduce((acc: Record<string, any>, row: any) => {
    acc[row.stage] ||= { stage: row.stage, count: 0, informed_value: 0, weighted_value: 0 };
    acc[row.stage].count += 1;
    acc[row.stage].informed_value += n(row.estimated_value);
    acc[row.stage].weighted_value += n(row.weighted_value);
    return acc;
  }, {})).map((row: any) => ({ ...row, informed_value: Number(row.informed_value.toFixed(2)), weighted_value: Number(row.weighted_value.toFixed(2)) }))
    .sort((a: any, b: any) => (stageRank[a.stage] ?? 9) - (stageRank[b.stage] ?? 9));

  const campaigns = campaignResult.data || [];
  const campaignByClient = new Map(campaigns.map((row: any) => [String(row.client_id), row]));
  const portfolioClients = (clientResult.data || []).map((row: any) => {
    const campaign: any = campaignByClient.get(String(row.id));
    const start = ts(row.entrada);
    const end = row.lifecycle === "CHURNED" && row.saida ? ts(row.saida) : Date.now();
    return {
      client_id: row.id,
      display_name: row.display_name,
      lifecycle: row.lifecycle,
      service: row.service,
      entrada: row.entrada,
      saida: row.saida,
      cs_owner: row.cs_owner,
      gt_owner: row.gt_owner,
      client_days: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 86400000)) : null,
      campaign: campaign ? {
        latest_date: campaign.latest_date,
        active_campaigns: campaign.active_campaigns,
        spend: campaign.spend,
        leads: campaign.leads,
        ctr: campaign.ctr,
        cost_per_result: campaign.cost_per_result,
      } : null,
    };
  });
  const clientName = new Map(portfolioClients.map((row: any) => [String(row.client_id), row.display_name]));

  const meetings = (meetingResult.data || []).filter((row: any) => commercialMeetingOwners.has(norm(row.metadata?.mcp_owner_person))).map((row: any) => ({
    id: row.id,
    title: row.metadata?.donnah_title || row.metadata?.tipo_reuniao || "Reunião comercial",
    summary: row.metadata?.donnah_summary || row.summary || "Sem resumo disponível.",
    type: row.metadata?.tipo_reuniao || null,
    owner: row.metadata?.mcp_owner_person || null,
    participants: Array.isArray(row.participants) ? row.participants : [],
    client_id: row.client_id || null,
    client_name: row.client_id ? clientName.get(String(row.client_id)) || null : null,
    match_status: row.match_status,
    meeting_started_at: row.meeting_started_at,
    ingested_at: row.ingested_at,
  }));
  const meetings7d = meetings.filter((row: any) => (daysSince(row.meeting_started_at || row.ingested_at) ?? 999) <= 7).length;

  const currentMonth = new Date();
  const goals = (goalResult.data || []).filter((row: any) => Number(row.ano) === currentMonth.getFullYear() && Number(row.mes) === currentMonth.getMonth() + 1).map((row: any) => ({
    ...row,
    owner_name: ownerMap.get(String(row.owner_id)) || "Comercial",
  }));

  const latestCrm = leads.map((row: any) => row.updated_at).filter(Boolean).sort().at(-1) || null;
  const latestMeeting = meetings.map((row: any) => row.ingested_at).filter(Boolean).sort().at(-1) || null;
  const latestCampaignDate = campaigns.map((row: any) => row.latest_date).filter(Boolean).sort().at(-1) || null;
  const campaignReference = latestCampaignDate ? `${latestCampaignDate}T23:59:59-03:00` : null;

  return reply({
    profile: { person, role: roster.role, display_role: "Direção Comercial", access_level: "COMMERCIAL_READ_ONLY", read_only: true },
    summary: {
      open_leads: openLeads.length,
      new_7d: openLeads.filter((row: any) => (daysSince(row.created_at) ?? 999) <= 7).length,
      advanced_opportunities: advancedLeads.length,
      meetings_7d: meetings7d,
      won_30d: won30d.length,
      won_monthly_30d: Number(won30d.reduce((sum: number, row: any) => sum + n(row.closed_monthly_value), 0).toFixed(2)),
      won_setup_30d: Number(won30d.reduce((sum: number, row: any) => sum + n(row.closed_setup_value), 0).toFixed(2)),
      informed_pipeline_value: Number(openLeads.reduce((sum: number, row: any) => sum + n(row.estimated_value), 0).toFixed(2)),
      weighted_forecast_value: Number(openLeads.reduce((sum: number, row: any) => sum + n(row.weighted_value), 0).toFixed(2)),
      active_clients: portfolioClients.filter((row: any) => ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle))).length,
      active_campaigns: campaigns.reduce((sum: number, row: any) => sum + n(row.active_campaigns), 0),
    },
    leads,
    stage_summary: stageSummary,
    performance,
    goals,
    campaigns,
    portfolio_clients: portfolioClients,
    meetings,
    sources: {
      crm: { updated_at: latestCrm, age_hours: hoursSince(latestCrm), stale: (hoursSince(latestCrm) ?? 9999) > 48 },
      meetings: { updated_at: latestMeeting, age_hours: hoursSince(latestMeeting), stale: (hoursSince(latestMeeting) ?? 9999) > 24 },
      campaigns: { updated_at: latestCampaignDate, age_hours: hoursSince(campaignReference), stale: (hoursSince(campaignReference) ?? 9999) > 72 },
    },
    data_quality: {
      real_crm_owners: realOwners.length,
      crm_leads: leads.length,
      note: "Fonte comercial única: CRM para funil, campanhas ativas e carteira básica. Nenhum dado de WhatsApp, saúde, ClickUp, alertas, compromissos ou onboarding é retornado.",
    },
    generated_at: new Date().toISOString(),
  });
});
