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
  return String(email).split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
    ? crm.from("leads").select("id,owner_id,name,company,email,phone,stage,estimated_value,source,utm_source,utm_medium,utm_campaign,utm_content,utm_term,notes,lost_reason,created_at,updated_at,closed_at,closed_monthly_value,closed_setup_value,closed_term_months,closed_monthly_first_month,closed_setup_first_month,closed_setup_payment,instagram,orcamento_mkt,atuacao,ticket_medio,archived_at,archive_reason").in("owner_id", realOwners).order("updated_at", { ascending: false }).limit(1500)
    : Promise.resolve({ data: [], error: null });

  const [leadResult, goalResult, clientResult, campaignResult, healthResult, onboardingResult, briefingResult, churnResult, weeklyResult, meetingResult] = await Promise.all([
    leadQuery,
    realOwners.length ? crm.from("closer_goals").select("owner_id,ano,mes,meta_primeira_fatura,meta_clientes,meta_mensalidade,meta_implementacao,updated_at").in("owner_id", realOwners).order("ano", { ascending: false }).order("mes", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ops.from("clients").select("id,display_name,lifecycle,service,crm_lead_id,entrada,saida,cs_owner,gt_owner,designer_owner,source,metadata,updated_at").order("entrada", { ascending: false }).limit(1000),
    ops.from("campaign_client_latest").select("client_id,display_name,lifecycle,gt_owner,latest_date,checked_at,campaign_count,active_campaigns,paused_campaigns,spend,impressions,clicks,leads,ctr,cpc,cpm,cost_per_result,age_days,delivery_status").in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("spend", { ascending: false }).limit(1000),
    ops.from("client_health_board").select("client_id,display_name,lifecycle,priority,gt_owner,cs_owner,internal_score,internal_band,external_health_status,external_health_score,external_risk_level,external_satisfaction_avg,external_risk_avg,external_summary,external_recommended_action,sentimento,sinais_alerta,reclamacoes,crosscheck_status,prioridade").in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("prioridade", { ascending: false }).limit(1000),
    ops.from("onboarding_cases").select("id,client_id,opened_at,closed_at,status,current_stage,onboarding_risk,blocked_by,next_action,next_action_due,created_at,updated_at").order("updated_at", { ascending: false }).limit(1000),
    ops.from("closer_briefing_jobs").select("id,client_id,won_event_id,status,processed_at,notion_page_url,briefing_title,evidence_meeting_count,last_error,created_at,updated_at").order("updated_at", { ascending: false }).limit(500),
    ops.from("client_churn_log").select("id,client_id,client_name,entrada,saida,permanencia_dias,qualidade,motivo,sector,confirmed,source,tipo,gt_owner,cs_owner,created_at").order("saida", { ascending: false }).limit(500),
    ops.from("weekly_commercial_reports").select("id,client_id,week_start,week_end,cs_owner,gt_owner,commercial_leads,meta_leads,meta_source,meta_cross_status,meta_difference,meta_difference_pct,confidence_level,metrics,reporters,context,internal_warning,source_summary,generated_at").order("week_end", { ascending: false }).limit(800),
    ops.from("meeting_transcripts").select("id,source_system,source_file_name,source_url,meeting_code,meeting_started_at,client_id,client_name_raw,match_status,match_confidence,participants,summary,decisions,commitments,ai_signals,ingested_at,processed_at,metadata").order("ingested_at", { ascending: false }).limit(500),
  ]);

  const failed = [leadResult, goalResult, clientResult, campaignResult, healthResult, onboardingResult, briefingResult, churnResult, weeklyResult, meetingResult].find((result: any) => result?.error);
  if (failed?.error) return reply({ error: "query_failed", detail: failed.error.message }, 500);

  const rawLeads = (leadResult.data || []).filter((row: any) => !row.archived_at);
  const leadIds = rawLeads.map((row: any) => String(row.id));
  const activityResult = leadIds.length
    ? await crm.from("lead_activities").select("id,lead_id,author_id,type,content,due_at,done,created_at").in("lead_id", leadIds).order("created_at", { ascending: false }).limit(4000)
    : { data: [], error: null };
  if (activityResult.error) return reply({ error: "activities_failed", detail: activityResult.error.message }, 500);

  const activitiesByLead = new Map<string, any[]>();
  for (const activity of activityResult.data || []) {
    const key = String(activity.lead_id);
    activitiesByLead.set(key, [...(activitiesByLead.get(key) || []), activity]);
  }

  const leads = rawLeads.map((row: any) => {
    const owner = ownerMap.get(String(row.owner_id));
    const activities = activitiesByLead.get(String(row.id)) || [];
    const latest = activities[0] || null;
    const nextTask = activities
      .filter((item: any) => item.type === "tarefa" && item.done !== true && item.due_at)
      .sort((a: any, b: any) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())[0] || null;
    const age = daysSince(row.created_at);
    const stageAge = daysSince(latest?.created_at || row.updated_at || row.created_at);
    const stage = norm(row.stage) || "novo";
    const estimated = n(row.estimated_value);
    return {
      ...row,
      owner_name: owner?.name || "Não atribuído",
      owner_email: owner?.email || null,
      age_days: age,
      stage_age_days: stageAge,
      last_activity_at: latest?.created_at || null,
      last_activity_type: latest?.type || null,
      last_activity: latest?.content || null,
      next_action_at: nextTask?.due_at || null,
      next_action: nextTask?.content || null,
      followup_overdue: Boolean(nextTask?.due_at && new Date(nextTask.due_at).getTime() < Date.now()),
      no_activity: activities.length === 0,
      stage_weight: stageWeight[stage] ?? 0.1,
      weighted_value: Number((estimated * (stageWeight[stage] ?? 0.1)).toFixed(2)),
      activity_count: activities.length,
    };
  }).sort((a: any, b: any) => (stageRank[norm(a.stage)] ?? 9) - (stageRank[norm(b.stage)] ?? 9) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const clientRows = clientResult.data || [];
  const clientById = new Map(clientRows.map((row: any) => [String(row.id), row]));
  const clientByLead = new Map(clientRows.filter((row: any) => row.crm_lead_id).map((row: any) => [String(row.crm_lead_id), row]));
  const campaignByClient = new Map((campaignResult.data || []).map((row: any) => [String(row.client_id), row]));
  const onboardingByClient = new Map<string, any>();
  for (const row of onboardingResult.data || []) if (!onboardingByClient.has(String(row.client_id))) onboardingByClient.set(String(row.client_id), row);
  const briefingByClient = new Map<string, any>();
  for (const row of briefingResult.data || []) if (!briefingByClient.has(String(row.client_id))) briefingByClient.set(String(row.client_id), row);

  const handoffs = clientRows
    .filter((client: any) => client.crm_lead_id || (client.lifecycle === "ONBOARDING" && (daysSince(client.entrada) ?? 999) <= 90))
    .map((client: any) => {
      const lead = client.crm_lead_id ? leads.find((row: any) => String(row.id) === String(client.crm_lead_id)) || null : null;
      const onboarding = onboardingByClient.get(String(client.id)) || null;
      const campaign = campaignByClient.get(String(client.id)) || null;
      const briefing = briefingByClient.get(String(client.id)) || null;
      return {
        client_id: client.id,
        display_name: client.display_name,
        lifecycle: client.lifecycle,
        entrada: client.entrada,
        service: client.service,
        cs_owner: client.cs_owner,
        gt_owner: client.gt_owner,
        crm_lead_id: client.crm_lead_id,
        crm_lead_name: lead?.name || lead?.company || null,
        commercial_owner: lead?.owner_name || null,
        closed_at: lead?.closed_at || null,
        onboarding,
        campaign,
        briefing,
        handoff_status: campaign?.active_campaigns > 0 ? "CAMPAIGN_LIVE" : onboarding?.status === "CLOSED" ? "ONBOARDING_DONE" : onboarding ? "ONBOARDING" : "WAITING_ONBOARDING",
      };
    })
    .sort((a: any, b: any) => new Date(String(b.entrada || 0)).getTime() - new Date(String(a.entrada || 0)).getTime());

  const wonClients = leads.filter((row: any) => norm(row.stage) === "fechado").map((lead: any) => ({
    ...lead,
    client: clientByLead.get(String(lead.id)) || null,
  }));

  const meetings = (meetingResult.data || [])
    .filter((row: any) => commercialMeetingOwners.has(norm(row.metadata?.mcp_owner_person)))
    .map((row: any) => {
      const owner = row.metadata?.mcp_owner_person || "Comercial";
      const title = row.metadata?.donnah_title || row.source_file_name || "Reunião comercial";
      const haystack = norm(`${title} ${(row.participants || []).join(" ")}`);
      let crmLead: any = null;
      for (const lead of leads) {
        const name = norm(lead.name);
        const company = norm(lead.company);
        if ((name.length >= 4 && haystack.includes(name)) || (company.length >= 4 && haystack.includes(company))) { crmLead = lead; break; }
      }
      const linkedClient = row.client_id ? clientById.get(String(row.client_id)) || null : null;
      return {
        id: row.id,
        owner,
        meeting_started_at: row.meeting_started_at || row.ingested_at,
        title,
        meeting_code: row.meeting_code,
        participants: row.participants || [],
        topic: row.metadata?.tipo_reuniao || null,
        summary: row.metadata?.donnah_summary || row.summary || null,
        decisions: row.decisions || [],
        commitments: row.commitments || [],
        ai_signals: row.ai_signals || {},
        crm_lead_id: crmLead?.id || null,
        crm_lead_name: crmLead ? (crmLead.company || crmLead.name) : null,
        crm_stage: crmLead?.stage || null,
        client_id: row.client_id,
        client_name: linkedClient?.display_name || row.client_name_raw || null,
        match_status: row.match_status,
        match_confidence: row.match_confidence,
        source_url: row.source_url,
      };
    })
    .sort((a: any, b: any) => new Date(b.meeting_started_at).getTime() - new Date(a.meeting_started_at).getTime());

  const openLeads = leads.filter((row: any) => !["fechado", "perdido"].includes(norm(row.stage)));
  const advancedLeads = openLeads.filter((row: any) => ["reuniao", "proposta", "negociacao"].includes(norm(row.stage)));
  const staleLeads = openLeads.filter((row: any) => (row.stage_age_days ?? 0) >= (norm(row.stage) === "novo" ? 3 : 5));
  const noActivity = openLeads.filter((row: any) => row.no_activity);
  const overdueFollowups = openLeads.filter((row: any) => row.followup_overdue);
  const forecastValue = openLeads.reduce((sum: number, row: any) => sum + n(row.weighted_value), 0);
  const informedPipelineValue = openLeads.reduce((sum: number, row: any) => sum + n(row.estimated_value), 0);

  const performanceMap = new Map<string, any>();
  for (const profile of crmProfiles || []) performanceMap.set(String(profile.id), {
    owner_id: profile.id,
    owner_name: ownerLabel(profile.email),
    email: profile.email,
    leads: 0, new_leads: 0, qualification: 0, meetings: 0, proposals: 0, negotiations: 0, won: 0, lost: 0,
    overdue_followups: 0, no_activity: 0, weighted_value: 0, informed_value: 0, monthly_value_won: 0, setup_value_won: 0,
  });
  for (const lead of leads) {
    const bucket = performanceMap.get(String(lead.owner_id)); if (!bucket) continue;
    bucket.leads += 1;
    const stage = norm(lead.stage);
    if (stage === "novo") bucket.new_leads += 1;
    if (stage === "qualificacao") bucket.qualification += 1;
    if (stage === "reuniao") bucket.meetings += 1;
    if (stage === "proposta") bucket.proposals += 1;
    if (stage === "negociacao") bucket.negotiations += 1;
    if (stage === "fechado") bucket.won += 1;
    if (stage === "perdido") bucket.lost += 1;
    if (lead.followup_overdue) bucket.overdue_followups += 1;
    if (lead.no_activity) bucket.no_activity += 1;
    bucket.weighted_value += n(lead.weighted_value);
    bucket.informed_value += n(lead.estimated_value);
    if (stage === "fechado") {
      bucket.monthly_value_won += n(lead.closed_monthly_value);
      bucket.setup_value_won += n(lead.closed_setup_value);
    }
  }
  const performance = [...performanceMap.values()].map((row: any) => ({
    ...row,
    close_rate: row.won + row.lost ? Number((100 * row.won / (row.won + row.lost)).toFixed(1)) : null,
    weighted_value: Number(row.weighted_value.toFixed(2)),
    informed_value: Number(row.informed_value.toFixed(2)),
  }));

  const stageSummary = Object.entries(openLeads.reduce((acc: Record<string, any>, row: any) => {
    const key = norm(row.stage) || "novo";
    acc[key] ||= { stage: key, count: 0, informed_value: 0, weighted_value: 0 };
    acc[key].count += 1;
    acc[key].informed_value += n(row.estimated_value);
    acc[key].weighted_value += n(row.weighted_value);
    return acc;
  }, {})).map(([, row]: any) => ({ ...row, informed_value: Number(row.informed_value.toFixed(2)), weighted_value: Number(row.weighted_value.toFixed(2)) }))
    .sort((a: any, b: any) => (stageRank[a.stage] ?? 9) - (stageRank[b.stage] ?? 9));

  const recentMeetings7d = meetings.filter((row: any) => (daysSince(row.meeting_started_at) ?? 999) <= 7);
  const healthRows = healthResult.data || [];
  const highRisk = healthRows.filter((row: any) => ["CRÍTICO", "CRITICO", "HIGH", "CRITICAL"].includes(String(row.internal_band || row.external_risk_level || "").toUpperCase()) || n(row.external_risk_avg) >= 60 || String(row.sentimento || "").toLowerCase().includes("crít"));
  const inactiveCampaigns = (campaignResult.data || []).filter((row: any) => ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle)) && n(row.active_campaigns) <= 0);
  const blockedHandoffs = handoffs.filter((row: any) => row.onboarding?.blocked_by || row.onboarding?.onboarding_risk === "HIGH" || row.handoff_status === "WAITING_ONBOARDING");

  const recentWeekly = new Map<string, any>();
  for (const row of weeklyResult.data || []) if (!recentWeekly.has(String(row.client_id))) recentWeekly.set(String(row.client_id), row);
  const leadQualityClients = [...recentWeekly.values()].map((row: any) => ({
    ...row,
    client_name: clientById.get(String(row.client_id))?.display_name || null,
  }));

  const churns = (churnResult.data || []).filter((row: any) => row.confirmed !== false).map((row: any) => ({
    ...row,
    crm_lead_id: clientById.get(String(row.client_id))?.crm_lead_id || null,
  }));
  const churnReasons = Object.entries(churns.reduce((acc: Record<string, number>, row: any) => {
    const key = String(row.motivo || "Não informado").trim() || "Não informado";
    acc[key] = (acc[key] || 0) + 1; return acc;
  }, {})).map(([reason, count]) => ({ reason, count })).sort((a: any, b: any) => b.count - a.count);

  const executiveAlerts = [
    ...overdueFollowups.slice(0, 8).map((row: any) => ({ type: "FOLLOWUP_OVERDUE", severity: "HIGH", title: `${row.company || row.name} com follow-up vencido`, detail: row.next_action || "Ação comercial vencida", owner: row.owner_name, lead_id: row.id })),
    ...advancedLeads.filter((row: any) => (row.stage_age_days ?? 0) >= 5).slice(0, 8).map((row: any) => ({ type: "DEAL_STALLED", severity: "HIGH", title: `${row.company || row.name} parado em ${row.stage}`, detail: `${row.stage_age_days} dias sem avanço identificado`, owner: row.owner_name, lead_id: row.id })),
    ...blockedHandoffs.slice(0, 6).map((row: any) => ({ type: "HANDOFF_BLOCKED", severity: "HIGH", title: `${row.display_name} com handoff pendente`, detail: row.onboarding?.blocked_by || row.onboarding?.next_action || "Onboarding ainda não avançou", client_id: row.client_id })),
    ...inactiveCampaigns.slice(0, 6).map((row: any) => ({ type: "NO_ACTIVE_CAMPAIGN", severity: "MEDIUM", title: `${row.display_name} sem campanha ativa`, detail: "Cliente ativo/onboarding sem campanha ativa no snapshot atual", client_id: row.client_id })),
    ...highRisk.slice(0, 6).map((row: any) => ({ type: "CLIENT_RISK", severity: "HIGH", title: `${row.display_name} em risco`, detail: row.external_recommended_action || row.external_summary || row.sinais_alerta || "Saúde do cliente exige atenção", client_id: row.client_id })),
  ].slice(0, 24);

  const currentMonth = new Date();
  const currentGoals = (goalResult.data || []).filter((row: any) => Number(row.ano) === currentMonth.getFullYear() && Number(row.mes) === currentMonth.getMonth() + 1).map((row: any) => ({
    ...row,
    owner_name: ownerMap.get(String(row.owner_id))?.name || "Comercial",
  }));

  return reply({
    profile: { person, role: roster.role, display_role: pref?.metadata?.display_role || "Direção Comercial", read_only: true },
    summary: {
      open_leads: openLeads.length,
      new_7d: openLeads.filter((row: any) => (daysSince(row.created_at) ?? 999) <= 7).length,
      advanced_opportunities: advancedLeads.length,
      meetings_7d: recentMeetings7d.length,
      overdue_followups: overdueFollowups.length,
      no_activity: noActivity.length,
      stale_leads: staleLeads.length,
      informed_pipeline_value: Number(informedPipelineValue.toFixed(2)),
      weighted_forecast_value: Number(forecastValue.toFixed(2)),
      clients_onboarding: handoffs.filter((row: any) => row.lifecycle === "ONBOARDING" || row.onboarding?.status === "OPEN").length,
      campaigns_inactive: inactiveCampaigns.length,
      clients_high_risk: highRisk.length,
      churns_90d: churns.filter((row: any) => (daysSince(row.saida) ?? 999) <= 90).length,
    },
    leads,
    stage_summary: stageSummary,
    performance,
    goals: currentGoals,
    meetings,
    campaigns: campaignResult.data || [],
    lead_quality: {
      stale_leads: staleLeads,
      no_activity: noActivity,
      overdue_followups: overdueFollowups,
      client_crosscheck: leadQualityClients,
    },
    won_clients: wonClients,
    handoffs,
    retention: { high_risk_clients: highRisk, churns, churn_reasons: churnReasons },
    executive_alerts: executiveAlerts,
    data_quality: {
      real_crm_owners: realOwners.length,
      crm_leads: leads.length,
      activities: (activityResult.data || []).length,
      commercial_meetings: meetings.length,
      linked_handoffs: handoffs.filter((row: any) => row.crm_lead_id).length,
      note: "CRM considera apenas responsáveis reais marcados com sees_all_leads=true; contas de teste ficam fora dos indicadores.",
    },
    generated_at: new Date().toISOString(),
  });
});
