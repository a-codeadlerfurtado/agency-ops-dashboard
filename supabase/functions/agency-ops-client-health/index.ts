import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Identity = {
  person: string | null; role: string | null; accessLevel: string; elevated: boolean;
  locked: boolean; isFull: boolean; isWalletOnly: boolean; views: string[];
};

async function resolveIdentity(ops: any, authClient: any): Promise<Identity | null> {
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) return null;
  const userKey = data.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  let role: string | null = null;
  let accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops.from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
    role = roster?.role ?? null; accessLevel = roster?.access_level ?? "RESTRICTED";
  }
  const { data: decisions } = await ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED");
  const approvals = decisions ?? [];
  const accountApproved = approvals.some((row: any) => row.kind === "SIGNUP");
  const elevated = accessLevel === "RESTRICTED" && approvals.some((row: any) => row.kind === "ELEVATION");
  const locked = !accountApproved || (!person && !elevated);
  let views: string[] = [];
  if (!locked) {
    const { data: viewRows } = await ops.rpc("dashboard_allowed_views", { p_person: person, p_role: role });
    if (Array.isArray(viewRows)) views = viewRows;
  }
  return { person, role, accessLevel, elevated, locked, isFull: accessLevel === "FULL" || elevated, isWalletOnly: accessLevel === "WALLET_ONLY" && !elevated, views };
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const n = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
const daysSince = (value: unknown) => {
  if (!value) return null;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
};
function healthBand(score: number | null) {
  if (score == null) return "ATENÇÃO";
  if (score < 50) return "CRÍTICO";
  if (score < 70) return "ATENÇÃO";
  return "SAUDÁVEL";
}
function operationalHealth(snapshot: any, overdueSlas: any[]) {
  if (!snapshot && !overdueSlas.length) return { score: 100, factors: ["Sem pendência operacional crítica identificada nas fontes atuais."] };
  let score = 100;
  const factors: string[] = [];
  const overdue = Number(snapshot?.overdue_commitments || 0);
  const complaints = Number(snapshot?.open_complaints || 0);
  const blockers = Number(snapshot?.blockers || 0);
  const approvals = Number(snapshot?.pending_approvals || 0);
  if (overdue) { const p = Math.min(45, overdue * 15); score -= p; factors.push(`${overdue} compromisso(s) vencido(s) (-${p})`); }
  if (complaints) { const p = Math.min(36, complaints * 12); score -= p; factors.push(`${complaints} reclamação(ões) operacional(is) aberta(s) (-${p})`); }
  if (blockers) { const p = Math.min(45, blockers * 15); score -= p; factors.push(`${blockers} bloqueio(s) operacional(is) ativo(s) (-${p})`); }
  if (approvals) { const p = Math.min(15, approvals * 5); score -= p; factors.push(`${approvals} aprovação(ões) pendente(s) (-${p})`); }
  if (snapshot?.next_step_due && new Date(String(snapshot.next_step_due)).getTime() < Date.now()) { score -= 15; factors.push("próxima ação registrada está vencida (-15)"); }
  const idle = daysSince(snapshot?.last_activity_at);
  if (idle != null && idle > 7) { score -= 30; factors.push(`${idle} dias sem atividade identificada (-30)`); }
  else if (idle != null && idle > 3) { score -= 15; factors.push(`${idle} dias sem atividade identificada (-15)`); }
  if (overdueSlas.length) { const p = Math.min(40, overdueSlas.length * 20); score -= p; factors.push(`${overdueSlas.length} SLA(s) do onboarding vencido(s) (-${p})`); }
  if (!factors.length) factors.push("Processo operacional sem atraso, reclamação ou bloqueio relevante identificado.");
  return { score: clamp(score), factors };
}
function resultHealth(campaign: any, weekly: any) {
  if (!campaign && !weekly) return { score: null as number | null, factors: ["Sem dados suficientes de marketing/comercial para pontuar resultado."] };
  let score = 100;
  const factors: string[] = [];
  if (campaign) {
    const active = Number(campaign.active_campaigns || 0);
    const spend = Number(campaign.spend || 0);
    const leads = Number(campaign.leads || 0);
    const age = Number(campaign.age_days ?? 999);
    if (active <= 0) { score -= 30; factors.push("nenhuma campanha ativa no snapshot mais recente (-30)"); }
    if (spend > 0 && leads <= 0) { score -= 35; factors.push("houve investimento sem lead registrado no snapshot (-35)"); }
    if (age > 2) { score -= 20; factors.push(`dados de mídia estão há ${age} dias sem atualização (-20)`); }
    if (leads > 0 && campaign.cost_per_result != null) factors.push(`CPL mais recente: R$ ${Number(campaign.cost_per_result).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  if (weekly?.metrics) {
    const m = weekly.metrics;
    const answer = n(m.answer_attempt_rate);
    const visit = n(m.visit_schedule_rate);
    const completed = Number(m.visits_completed || 0);
    const proposals = Number(m.proposals || 0);
    if (answer != null && answer < 50) { score -= 15; factors.push(`taxa de contato sobre tentativas em ${answer.toFixed(1)}% (-15)`); }
    if (visit != null && visit < 20) { score -= 15; factors.push(`conversão de conversa para visita em ${visit.toFixed(1)}% (-15)`); }
    if (completed > 0 && proposals === 0) { score -= 10; factors.push(`${completed} visita(s) realizada(s) sem proposta reportada (-10)`); }
    if (weekly.meta_cross_status === "DIVERGENCE_META_HIGHER") factors.push("Meta registrou mais leads que o comercial; reporte precisa de conferência");
    if (weekly.meta_cross_status === "META_UNAVAILABLE" || weekly.meta_cross_status === "META_PARTIAL") factors.push("relatório comercial ainda não foi cruzado integralmente com Meta");
  }
  if (!factors.length) factors.push("Sem gargalo relevante de mídia/comercial identificado nas fontes atuais.");
  return { score: clamp(score), factors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return json({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const identity = await resolveIdentity(ops, authClient);
  if (!identity) return json({ error: "unauthorized" }, 401);
  if (identity.locked || !identity.views.includes("health")) return json({ error: "forbidden" }, 403);

  const { data, error } = await ops.from("client_health_board").select("*").order("prioridade", { ascending: false }).limit(400);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);
  let rows = data ?? [];
  let carteiraDe: string | null = null;
  if (identity.person) {
    const { data: carteira } = await ops.from("wallet_registry").select("carteira").eq("gt_owner", identity.person).maybeSingle();
    carteiraDe = carteira?.carteira ?? null;
  }
  if (carteiraDe) rows = rows.filter((row: any) => row.gt_owner === identity.person);

  const ids = rows.map((row: any) => String(row.client_id));
  const [snapResult, campaignResult, slaResult, weeklyResult] = ids.length ? await Promise.all([
    ops.from("client_operational_snapshot").select("*").in("client_id", ids),
    ops.from("campaign_client_latest").select("client_id,latest_date,active_campaigns,spend,leads,cost_per_result,age_days,delivery_status").in("client_id", ids),
    ops.from("onboarding_sla_board").select("client_id,event_type,status,sla_status,due_at,responsible_person").in("client_id", ids).eq("status", "OPEN"),
    ops.from("weekly_commercial_reports").select("client_id,week_end,metrics,meta_cross_status,confidence_level").in("client_id", ids).order("week_end", { ascending: false }),
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }] as any;

  const snapshots = new Map((snapResult.data || []).map((row: any) => [String(row.client_id), row]));
  const campaigns = new Map((campaignResult.data || []).map((row: any) => [String(row.client_id), row]));
  const slas = new Map<string, any[]>();
  for (const row of slaResult.data || []) { const key = String(row.client_id); slas.set(key, [...(slas.get(key) || []), row]); }
  const weekly = new Map<string, any>();
  for (const row of weeklyResult.data || []) if (!weekly.has(String(row.client_id))) weekly.set(String(row.client_id), row);

  rows = rows.map((row: any) => {
    const id = String(row.client_id);
    const overdueSlas = (slas.get(id) || []).filter((item: any) => item.sla_status === "OVERDUE");
    const op = operationalHealth(snapshots.get(id), overdueSlas);
    const result = resultHealth(campaigns.get(id), weekly.get(id));
    const overall = result.score == null ? op.score : Math.min(op.score, result.score);
    return {
      ...row,
      operational_score: op.score,
      result_score: result.score,
      health_score: overall,
      risk_score: 100 - overall,
      health_band: healthBand(overall),
      operational_factors: op.factors,
      result_factors: result.factors,
      overdue_slas: overdueSlas,
      operational_snapshot: snapshots.get(id) || null,
      campaign_snapshot: campaigns.get(id) || null,
      latest_weekly_report: weekly.get(id) || null,
    };
  }).sort((a: any, b: any) => Number(b.risk_score) - Number(a.risk_score) || Number(b.prioridade || 0) - Number(a.prioridade || 0));

  const ativos = rows.filter((row: any) => row.lifecycle === "ACTIVE" || row.lifecycle === "ONBOARDING");
  const media = (campo: string) => {
    const vals = ativos.map((r: any) => n(r[campo])).filter((v): v is number => v !== null && Number.isFinite(v));
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : null;
  };

  return json({
    clients: rows,
    resumo: {
      total: rows.length, ativos: ativos.length,
      saudaveis: ativos.filter((r: any) => r.health_band === "SAUDÁVEL").length,
      atencao: ativos.filter((r: any) => r.health_band === "ATENÇÃO").length,
      criticos: ativos.filter((r: any) => r.health_band === "CRÍTICO").length,
      risco_alto: ativos.filter((r: any) => (n(r.external_risk_avg) ?? 0) >= 50).length,
      insatisfeitos: ativos.filter((r: any) => (n(r.external_satisfaction_avg) ?? 100) < 50).length,
      sentimento_negativo: ativos.filter((r: any) => r.sentimento === "Negativo" || r.sentimento === "Crítico").length,
      divergentes: ativos.filter((r: any) => r.crosscheck_status === "CONFLICT" || r.crosscheck_status === "PARTIAL").length,
      sem_dado_externo: ativos.filter((r: any) => r.crosscheck_status === "NO_EXTERNAL").length,
      satisfacao_media: media("external_satisfaction_avg"), risco_medio: media("external_risk_avg"),
      saude_media: media("health_score"), operacional_media: media("operational_score"), resultado_media: media("result_score"),
    },
    profile: { person: identity.person, role: identity.role, access_level: identity.accessLevel, scoped: Boolean(carteiraDe), carteira: carteiraDe },
    generated_at: new Date().toISOString(),
  });
});