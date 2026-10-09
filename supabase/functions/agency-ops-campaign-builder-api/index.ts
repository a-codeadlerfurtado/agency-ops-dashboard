// agency-ops-campaign-builder-api
// GT escreve um pedido em texto livre; a IA transforma em plano estruturado de
// campanha Meta; o GT revisa o preview e confirma; a function cria campanha,
// conjunto, criativo e anúncio SEMPRE PAUSADOS via Marketing API, com
// verificação, rollback e auditoria em agency_ops.campaign_build_requests.
//
// Actions (POST, JSON salvo UPLOAD_CREATIVE que é multipart):
//   BOOTSTRAP        -> perfil, clientes no escopo com ativos Meta, histórico
//   UPLOAD_CREATIVE  -> sobe imagem/vídeo para o bucket privado
//   DRAFT            -> prompt -> plano estruturado (preview), grava DRAFTED
//   EXECUTE          -> cria as entidades pausadas na Meta a partir do plano
//   DISCARD          -> descarta um rascunho
// GET ?health=1      -> healthcheck

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SERVICE = "agency-ops-campaign-builder-api";
const SERVICE_VERSION = "v1.1.0";
const GRAPH = "v21.0";
const BUCKET = "agency-ai-private";
const DRAFT_TTL_MS = 45 * 60_000;
const MAX_FILE_MB = 25;
const MAX_CREATIVES = 10;
const DRAFT_RATE_PER_HOUR = 30;
const EXECUTE_RATE_PER_HOUR = 10;

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,GET,OPTIONS",
  "access-control-max-age": "86400",
};

type Row = Record<string, any>;
type TokenCandidate = { token: string; source: string };

function clean(value: unknown, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}
function numericId(value: unknown) {
  const v = clean(value, 40).replace(/^act_/, "");
  return /^\d{5,30}$/.test(v) ? v : "";
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseJsonText(text: string): any {
  return JSON.parse(String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "") || "{}");
}

async function metaJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.error_user_msg || body?.error?.message || `Meta HTTP ${response.status}`);
    (error as any).metaCode = body?.error?.code ?? response.status;
    (error as any).metaSubcode = body?.error?.error_subcode ?? null;
    throw error;
  }
  return body;
}
function graphUrl(path: string, params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `https://graph.facebook.com/${GRAPH}/${path}?${search.toString()}`;
}
async function metaPost(path: string, token: string, fields: Record<string, string>) {
  const body = new URLSearchParams({ access_token: token, ...fields });
  return await metaJson(`https://graph.facebook.com/${GRAPH}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
async function metaDelete(path: string, token: string) {
  const body = new URLSearchParams({ access_token: token });
  return await metaJson(`https://graph.facebook.com/${GRAPH}/${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
async function adsManagementGranted(token: string) {
  const body = await metaJson(graphUrl("me/permissions", { access_token: token }));
  return (body?.data || []).some((item: Row) => item.permission === "ads_management" && item.status === "granted");
}

async function tokenCandidates(db: any): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const { data, error } = await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vault = !error && typeof data === "string" ? data.trim() : "";
  if (vault) out.push({ token: vault, source: "SUPABASE_VAULT" });
  const env = clean(Deno.env.get("META_SYSTEM_USER_TOKEN"), 1000);
  if (env && !out.some((item) => item.token === env)) out.push({ token: env, source: "EDGE_ENV" });
  return out;
}

async function resolveWriteToken(db: any, accountId: string) {
  const candidates = await tokenCandidates(db);
  if (!candidates.length) return { error: "meta_token_missing" as const };
  let anyGranted = false;
  for (const candidate of candidates) {
    let granted = false;
    try { granted = await adsManagementGranted(candidate.token); } catch { continue; }
    if (!granted) continue;
    anyGranted = true;
    try {
      const account = await metaJson(graphUrl(`act_${accountId}`, {
        fields: "id,name,account_status,currency",
        access_token: candidate.token,
      }));
      return { candidate, account };
    } catch { continue; }
  }
  return { error: anyGranted ? "meta_account_access_missing" as const : "meta_write_permission_missing" as const };
}

// ---------------------------------------------------------------------------
// Plano estruturado: contrato que a IA preenche e o EXECUTE consome
// ---------------------------------------------------------------------------

const OBJECTIVES = ["OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_SALES", "OUTCOME_AWARENESS"] as const;
const DESTINATIONS = ["WHATSAPP", "SITE", "LEAD_FORM"] as const;

const PLAN_PROMPT = [
  "Você é o planejador de campanhas Meta Ads da Leonardo Imobi, agência de marketing imobiliário no Brasil.",
  "O gestor de tráfego (GT) descreveu, em texto livre, a campanha que quer criar para um cliente imobiliário.",
  "Sua tarefa: transformar o pedido em um plano estruturado de campanha Meta (campanha + conjunto + anúncio).",
  "",
  "REGRAS",
  "1. Responda SOMENTE com JSON válido no formato do exemplo ao final. Sem comentários.",
  "2. objective deve ser um de: " + OBJECTIVES.join(", ") + ". Imobiliária captando contatos = OUTCOME_LEADS.",
  "3. destination.type deve ser um de: " + DESTINATIONS.join(", ") + ".",
  "   - WHATSAPP: anúncio que abre conversa no WhatsApp do cliente (padrão do mercado imobiliário quando o GT não especifica).",
  "   - SITE: tráfego/conversão para uma URL. Só use se o GT deu a URL ou ela está no contexto.",
  "   - LEAD_FORM: formulário nativo da Meta. Só use se o GT mencionou formulário; exige lead_form_id que o GT fornece depois.",
  "4. daily_budget_brl: número em reais. Se o GT deu valor mensal, divida por 30,4 e arredonde. Se não deu orçamento, use 0 e pergunte em questions.",
  "5. geo.cities: nomes de cidades/regiões do Brasil citadas ou implícitas no pedido (ex.: cidade do cliente). geo.radius_km opcional (padrão da plataforma se ausente).",
  "6. age_min >= 18 (imóveis: padrão 25), age_max <= 65 (padrão 65). genders: 'all' salvo pedido explícito.",
  "7. Textos do anúncio em português do Brasil, tom do mercado imobiliário, sem emojis em excesso, sem promessas de retorno financeiro garantido, sem 'renda garantida'. primary_text até 500 caracteres, headline até 40, description até 30.",
  "8. names: padrão '[OBJETIVO] Nome curto — detalhe' (ex.: '[LEADS] Lançamento Vista Mar — WhatsApp'). Não inclua o nome do cliente no nome da campanha.",
  "9. questions: liste SOMENTE o que impede a criação (ex.: orçamento ausente, URL ausente para SITE, lead_form ausente para LEAD_FORM). Não pergunte o que já dá para assumir.",
  "10. assumptions: tudo que você assumiu sem o GT dizer (público, idade, raio, datas).",
  "11. cta: um de LEARN_MORE, CONTACT_US, WHATSAPP_MESSAGE, SIGN_UP, GET_OFFER, SUBSCRIBE. WHATSAPP_MESSAGE somente quando destination.type=WHATSAPP.",
  "12. start: 'NOW' ou data ISO (YYYY-MM-DD) se o GT pediu data. end: null ou data ISO se o GT pediu término.",
  "13. Se o CONTEXTO indicar modo=TURBINAR, o GT está turbinando uma publicação existente: objective deve ser OUTCOME_ENGAGEMENT (ou OUTCOME_TRAFFIC apenas se o GT pediu cliques para um link), os textos do anúncio (primary_text, headline, description) devem ficar vazios porque a publicação já tem o conteúdo, e names seguem o padrão '[TURBINAR] resumo da publicação'.",
  "",
  "FORMATO EXATO:",
  JSON.stringify({
    campaign: { name: "", objective: "OUTCOME_LEADS" },
    adset: {
      name: "",
      daily_budget_brl: 0,
      geo: { cities: [""], radius_km: null },
      age_min: 25,
      age_max: 65,
      genders: "all",
      destination: { type: "WHATSAPP", url: null, lead_form_id: null },
      start: "NOW",
      end: null,
    },
    ad: { name: "", primary_text: "", headline: "", description: "", cta: "WHATSAPP_MESSAGE" },
    questions: [""],
    assumptions: [""],
  }),
].join("\n");

function normalizePlan(raw: any) {
  const plan: Row = {
    campaign: {
      name: clean(raw?.campaign?.name, 120) || "Campanha sem nome",
      objective: OBJECTIVES.includes(raw?.campaign?.objective) ? raw.campaign.objective : "OUTCOME_LEADS",
    },
    adset: {
      name: clean(raw?.adset?.name, 120) || "Conjunto principal",
      daily_budget_brl: Math.max(0, Math.round(Number(raw?.adset?.daily_budget_brl) || 0)),
      geo: {
        cities: Array.isArray(raw?.adset?.geo?.cities)
          ? raw.adset.geo.cities.map((c: unknown) => clean(c, 80)).filter(Boolean).slice(0, 10)
          : [],
        radius_km: Number(raw?.adset?.geo?.radius_km) > 0 ? Math.min(80, Math.round(Number(raw.adset.geo.radius_km))) : null,
      },
      age_min: Math.min(64, Math.max(18, Math.round(Number(raw?.adset?.age_min) || 25))),
      age_max: Math.min(65, Math.max(19, Math.round(Number(raw?.adset?.age_max) || 65))),
      genders: ["all", "male", "female"].includes(raw?.adset?.genders) ? raw.adset.genders : "all",
      destination: {
        type: DESTINATIONS.includes(raw?.adset?.destination?.type) ? raw.adset.destination.type : "WHATSAPP",
        url: clean(raw?.adset?.destination?.url, 500) || null,
        lead_form_id: numericId(raw?.adset?.destination?.lead_form_id) || null,
      },
      start: clean(raw?.adset?.start, 20) || "NOW",
      end: clean(raw?.adset?.end, 20) || null,
    },
    ad: {
      name: clean(raw?.ad?.name, 120) || "Anúncio 01",
      primary_text: clean(raw?.ad?.primary_text, 900),
      headline: clean(raw?.ad?.headline, 60),
      description: clean(raw?.ad?.description, 60),
      cta: ["LEARN_MORE", "CONTACT_US", "WHATSAPP_MESSAGE", "SIGN_UP", "GET_OFFER", "SUBSCRIBE"].includes(raw?.ad?.cta) ? raw.ad.cta : "LEARN_MORE",
    },
    questions: Array.isArray(raw?.questions) ? raw.questions.map((q: unknown) => clean(q, 300)).filter(Boolean).slice(0, 8) : [],
    assumptions: Array.isArray(raw?.assumptions) ? raw.assumptions.map((a: unknown) => clean(a, 300)).filter(Boolean).slice(0, 10) : [],
  };
  if (plan.adset.age_max <= plan.adset.age_min) plan.adset.age_max = Math.min(65, plan.adset.age_min + 10);
  return plan;
}

async function callPlanner(ops: any, prompt: string, context: Row) {
  const { data: vaultKey } = await ops.rpc("get_secret", { p_name: "OPENAI_API_KEY" });
  // O projeto também pode configurar a chave como Secret da Edge Function.
  const key = typeof vaultKey === "string" && vaultKey.trim()
    ? vaultKey.trim() : clean(Deno.env.get("OPENAI_API_KEY"), 2000);
  if (!key) throw new Error("planner_not_configured");
  const { data: modelSetting } = await ops.from("automation_settings").select("value").eq("key", "CAMPAIGN_BUILDER_MODEL").maybeSingle();
  const model = clean(modelSetting?.value, 60) || clean(Deno.env.get("CAMPAIGN_BUILDER_MODEL"), 60) || "gpt-5-mini";
  // Nunca converter uma resposta vazia ou incompleta da IA em uma campanha "padrão".
  // Isso gerava rascunhos com orçamento 0, nome genérico e destino WhatsApp.
  const validate = (rawPlan: any): boolean => {
    if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) return false;
    const campaign = rawPlan.campaign;
    const adset = rawPlan.adset;
    const ad = rawPlan.ad;
    if (!campaign || !adset || !ad || typeof campaign !== "object" || typeof adset !== "object" || typeof ad !== "object") return false;
    if (clean(campaign.name, 120).length < 3 || !OBJECTIVES.includes(campaign.objective)) return false;
    if (clean(adset.name, 120).length < 3 || !DESTINATIONS.includes(adset.destination?.type)) return false;
    if (!Array.isArray(adset.geo?.cities) || !Number.isFinite(Number(adset.daily_budget_brl))) return false;
    if (clean(ad.name, 120).length < 3) return false;
    if (context?.modo !== "TURBINAR" && (!clean(ad.primary_text, 900) || !clean(ad.headline, 60))) return false;
    // Respeita os requisitos explícitos do pedido, em vez de mascarar a omissão.
    if (/formul[aá]rio\s+(?:instant[aâ]neo|nativo|de leads)|lead\s*form/i.test(prompt) &&
      adset.destination.type !== "LEAD_FORM" && context?.modo !== "TURBINAR") return false;
    if (/(?:or[çc]amento[^.\n]{0,70}R\$\s*\d+|R\$\s*\d+[^.\n]{0,70}(?:por dia|di[aá]ri[oa]|\/dia))/i.test(prompt)
      && Number(adset.daily_budget_brl) <= 0) return false;
    return true;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload: Row = {
      model,
      response_format: { type: "json_object" },
      max_completion_tokens: attempt === 0 ? 6500 : 8500,
      messages: [
        { role: "system", content: PLAN_PROMPT },
        { role: "user", content: `CONTEXTO DO CLIENTE:\n${JSON.stringify(context)}\n\nPEDIDO DO GT:\n${prompt}` },
      ],
    };
    if (/^gpt-5/i.test(model)) payload.reasoning_effort = "low";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(80000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`openai ${response.status}: ${raw.slice(0, 220)}`);
    let parsedResponse: any;
    try { parsedResponse = JSON.parse(raw); } catch { parsedResponse = null; }
    const content = parsedResponse?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) continue;
    let rawPlan: any;
    try { rawPlan = parseJsonText(content); } catch { continue; }
    if (validate(rawPlan)) return { plan: normalizePlan(rawPlan), model };
  }
  throw new Error("planner_incomplete");
}

async function resolveGeo(token: string, cities: string[]) {
  const resolved: Row[] = [];
  const unresolved: string[] = [];
  for (const city of cities.slice(0, 10)) {
    try {
      const body = await metaJson(graphUrl("search", {
        type: "adgeolocation",
        q: city,
        location_types: JSON.stringify(["city", "region", "geo_market"]),
        country_code: "BR",
        limit: "3",
        access_token: token,
      }));
      const hit = (body?.data || [])[0];
      if (hit?.key) {
        resolved.push({ query: city, key: hit.key, name: hit.name, type: hit.type, region: hit.region || null });
      } else {
        unresolved.push(city);
      }
    } catch {
      unresolved.push(city);
    }
  }
  return { resolved, unresolved };
}

function buildTargeting(plan: Row, geoResolved: Row[]) {
  const targeting: Row = {
    age_min: plan.adset.age_min,
    age_max: plan.adset.age_max,
    geo_locations: { location_types: ["home", "recent"] },
    targeting_automation: { advantage_audience: 1 },
  };
  if (plan.adset.genders === "male") targeting.genders = [1];
  if (plan.adset.genders === "female") targeting.genders = [2];
  const cities = geoResolved.filter((g) => g.type === "city");
  const regions = geoResolved.filter((g) => g.type === "region");
  const markets = geoResolved.filter((g) => g.type === "geo_market");
  if (cities.length) {
    targeting.geo_locations.cities = cities.map((g) => {
      const entry: Row = { key: g.key };
      if (plan.adset.geo.radius_km) {
        entry.radius = plan.adset.geo.radius_km;
        entry.distance_unit = "kilometer";
      }
      return entry;
    });
  }
  if (regions.length) targeting.geo_locations.regions = regions.map((g) => ({ key: g.key }));
  if (markets.length) targeting.geo_locations.geo_markets = markets.map((g) => ({ key: g.key }));
  if (!cities.length && !regions.length && !markets.length) {
    targeting.geo_locations.countries = ["BR"];
  }
  return targeting;
}

function adsetFields(plan: Row, campaignId: string, targeting: Row, boostMode: boolean) {
  const dest = plan.adset.destination;
  const fields: Row = {
    name: plan.adset.name,
    campaign_id: campaignId,
    status: "PAUSED",
    daily_budget: String(plan.adset.daily_budget_brl * 100),
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: JSON.stringify(targeting),
  };
  if (boostMode) {
    fields.optimization_goal = plan.campaign.objective === "OUTCOME_TRAFFIC" ? "LINK_CLICKS" : "POST_ENGAGEMENT";
  } else if (dest.type === "WHATSAPP") {
    fields.optimization_goal = "CONVERSATIONS";
    fields.destination_type = "WHATSAPP";
  } else if (dest.type === "LEAD_FORM") {
    fields.optimization_goal = "LEAD_GENERATION";
    fields.destination_type = "ON_AD";
  } else {
    fields.optimization_goal = "LINK_CLICKS";
  }
  if (plan.adset.start && plan.adset.start !== "NOW" && /^\d{4}-\d{2}-\d{2}$/.test(plan.adset.start)) {
    fields.start_time = `${plan.adset.start}T08:00:00-03:00`;
  }
  if (plan.adset.end && /^\d{4}-\d{2}-\d{2}$/.test(plan.adset.end)) {
    fields.end_time = `${plan.adset.end}T23:59:00-03:00`;
  }
  return fields;
}

function creativeSpec(plan: Row, pageId: string, instagramId: string | null, imageHash: string | null, video: { id: string; thumb: string } | null) {
  const dest = plan.adset.destination;
  const link = dest.type === "SITE" && dest.url ? dest.url : "https://api.whatsapp.com/send";
  const cta: Row = { type: plan.ad.cta };
  if (dest.type === "WHATSAPP") cta.type = "WHATSAPP_MESSAGE";
  if (dest.type === "LEAD_FORM" && dest.lead_form_id) {
    cta.type = "SIGN_UP";
    cta.value = { lead_gen_form_id: dest.lead_form_id };
  } else if (dest.type !== "LEAD_FORM") {
    cta.value = { link };
  }
  const spec: Row = { page_id: pageId };
  if (instagramId) spec.instagram_actor_id = instagramId;
  if (video) {
    spec.video_data = {
      video_id: video.id,
      image_url: video.thumb,
      message: plan.ad.primary_text,
      title: plan.ad.headline || undefined,
      link_description: plan.ad.description || undefined,
      call_to_action: cta,
    };
  } else {
    spec.link_data = {
      link,
      message: plan.ad.primary_text,
      name: plan.ad.headline || undefined,
      description: plan.ad.description || undefined,
      image_hash: imageHash || undefined,
      call_to_action: cta,
    };
  }
  return spec;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return reply({ ok: true, service: SERVICE, version: SERVICE_VERSION });
  }
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = clean(Deno.env.get("SUPABASE_URL"), 200);
  const anonKey = clean(Deno.env.get("SUPABASE_ANON_KEY"), 400);
  const serviceRole = clean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), 400);
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  // --- autenticação e perfil (mesmo padrão do campaign-inline-action-v2) ---
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  const user = userData?.user;
  if (authError || !user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name, 120);
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former) return reply({ error: "inactive_profile" }, 403);
  const role = clean(roster.role, 30).toUpperCase();
  const isAdler = person === "Adler Furtado";
  const elevated = (approvals || []).some((row: Row) => row.kind === "ELEVATION");
  if (!(role === "GT" || role === "MGMT" || isAdler)) return reply({ error: "forbidden" }, 403);

  const inScope = (client: Row) => isAdler || elevated || role === "MGMT" || (role === "GT" && clean(client.gt_owner, 120) === person);

  const loadScopedClient = async (clientName: string) => {
    const { data: clients, error } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle").eq("display_name", clientName).limit(4);
    if (error) return { error: reply({ error: "query_failed" }, 500) };
    if (!(clients || []).length) return { error: reply({ error: "client_not_found" }, 404) };
    const scoped = (clients || []).filter(inScope);
    if (!scoped.length) return { error: reply({ error: "forbidden" }, 403) };
    if (scoped.length !== 1) return { error: reply({ error: "client_ambiguous" }, 409) };
    const client = scoped[0];
    if (clean(client.lifecycle, 30).toUpperCase() === "CHURNED") return { error: reply({ error: "client_churned" }, 409) };
    return { client };
  };

  const loadAssets = async (clientId: string) => {
    const [{ data: assets }, { data: integrations }, { data: terms }] = await Promise.all([
      ops.from("client_meta_assets").select("meta_ad_account_id,meta_page_id,meta_instagram_id,meta_pixel_dataset_id").eq("client_id", clientId).maybeSingle(),
      ops.from("client_integrations").select("external_id,external_name,is_primary,meta_ad_account_id").eq("client_id", clientId).eq("system", "META_BM"),
      ops.from("client_private_commercial_terms").select("minimum_ad_budget").eq("client_id", clientId).maybeSingle(),
    ]);
    let accountId = numericId(assets?.meta_ad_account_id);
    if (!accountId) {
      const rows = integrations || [];
      const primary = rows.find((r: Row) => r.is_primary) || (rows.length === 1 ? rows[0] : null);
      accountId = numericId(primary?.meta_ad_account_id || primary?.external_id);
    }
    return {
      account_id: accountId || null,
      account_ambiguous: !accountId && (integrations || []).length > 1,
      page_id: numericId(assets?.meta_page_id) || null,
      instagram_id: numericId(assets?.meta_instagram_id) || null,
      pixel_id: numericId(assets?.meta_pixel_dataset_id) || null,
      minimum_ad_budget: terms?.minimum_ad_budget ?? null,
    };
  };

  const rateLimited = async (statuses: string[], limit: number) => {
    const oneHourAgo = new Date(Date.now() - 36e5).toISOString();
    const { count } = await ops.from("campaign_build_requests")
      .select("id", { count: "exact", head: true })
      .eq("actor_user_id", user.id).in("status", statuses).gte("created_at", oneHourAgo);
    return Number(count || 0) >= limit;
  };

  const contentType = req.headers.get("content-type") || "";

  // --- UPLOAD_CREATIVE (multipart) ---
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    if (clean(form.get("action"), 40).toUpperCase() !== "UPLOAD_CREATIVE") return reply({ error: "invalid_action" }, 400);
    const clientName = clean(form.get("client_name"), 160);
    const file = form.get("file");
    if (!clientName || !(file instanceof File)) return reply({ error: "client_and_file_required" }, 400);
    const scoped = await loadScopedClient(clientName);
    if ("error" in scoped) return scoped.error;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) return reply({ error: "unsupported_file_type" }, 415);
    if (file.size > MAX_FILE_MB * 1024 * 1024) return reply({ error: "file_too_large", max_mb: MAX_FILE_MB }, 413);
    const ext = (file.name.split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const path = `campaign-builder/${scoped.client.id}/${crypto.randomUUID()}.${ext}`;
    const up = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) return reply({ error: "upload_failed", detail: clean(up.error.message, 200) }, 500);
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
    return reply({
      ok: true,
      creative: { bucket: BUCKET, path, type: isImage ? "IMAGE" : "VIDEO", file_name: clean(file.name, 200), preview_url: signed?.signedUrl || null },
    });
  }

  const body = await req.json().catch(() => ({}));
  const action = clean(body?.action, 40).toUpperCase();

  // --- LIST_POSTS: publicações recentes da Página/Instagram para turbinar ---
  if (action === "LIST_POSTS") {
    const clientName = clean(body?.client_name, 160);
    if (!clientName) return reply({ error: "client_required" }, 400);
    const scoped = await loadScopedClient(clientName);
    if ("error" in scoped) return scoped.error;
    const assets = await loadAssets(scoped.client.id);
    const tokens = await tokenCandidates(db);
    if (!tokens.length) return reply({ error: "meta_token_missing" }, 503);
    const token = tokens[0].token;
    const out: Row = { facebook: [], instagram: [], errors: {} };
    if (assets.page_id) {
      try {
        const posts = await metaJson(graphUrl(`${assets.page_id}/posts`, {
          fields: "id,message,created_time,permalink_url,full_picture",
          limit: "12",
          access_token: token,
        }));
        out.facebook = (posts?.data || []).map((p: Row) => ({
          source: "FACEBOOK",
          post_id: clean(p.id, 80),
          caption: clean(p.message, 240),
          permalink: clean(p.permalink_url, 500),
          picture: clean(p.full_picture, 1000) || null,
          created_at: p.created_time || null,
        }));
      } catch (error) {
        out.errors.facebook = clean((error as Error)?.message, 200);
      }
    } else {
      out.errors.facebook = "Página não cadastrada em Ativos Meta.";
    }
    if (assets.instagram_id) {
      try {
        const media = await metaJson(graphUrl(`${assets.instagram_id}/media`, {
          fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
          limit: "12",
          access_token: token,
        }));
        out.instagram = (media?.data || []).map((m: Row) => ({
          source: "INSTAGRAM",
          post_id: clean(m.id, 80),
          caption: clean(m.caption, 240),
          permalink: clean(m.permalink, 500),
          picture: clean(m.thumbnail_url || m.media_url, 1000) || null,
          created_at: m.timestamp || null,
          media_type: clean(m.media_type, 20),
        }));
      } catch (error) {
        out.errors.instagram = clean((error as Error)?.message, 200);
      }
    } else {
      out.errors.instagram = "Instagram não cadastrado em Ativos Meta.";
    }
    return reply({ ok: true, ...out });
  }



  // --- CHECK_META_ACCESS ---
  // Read-only diagnosis, scoped to clients that the logged-in GT can see.
  // Having an ID registered is not evidence of Meta Page/Ad Account rights.
  if (action === "CHECK_META_ACCESS") {
    const scoped = await loadScopedClient(clean(body?.client_name,160));
    if ("error" in scoped) return scoped.error;
    const assets = await loadAssets(scoped.client.id);
    const pageId = numericId(assets.page_id);
    const accountId = numericId(assets.account_id);
    const tokens = await tokenCandidates(db);
    if (!tokens.length) return reply({ ok: true, page_id: pageId, account_id: accountId,
      page_access: false, account_access: false, ready: false,
      reason: "Nenhuma credencial Meta disponível." });
    let pageAccess = false, accountAccess = false, sameToken = false;
    let pageError = "", accountError = "";
    for (const candidate of tokens) {
      let page = false, account = false;
      const [pageResult, accountResult] = await Promise.allSettled([
        pageId ? metaJson(graphUrl(`${pageId}/leadgen_forms`, {
          fields: "id", limit: "1", access_token: candidate.token,
        })) : Promise.reject(new Error("Página não cadastrada")),
        accountId ? metaJson(graphUrl(`act_${accountId}`, {
          fields: "id,name", access_token: candidate.token,
        })) : Promise.reject(new Error("Conta de anúncio não cadastrada")),
      ]);
      if (pageResult.status === "fulfilled") page = pageAccess = true;
      else pageError = clean((pageResult.reason as Error)?.message,160);
      if (accountResult.status === "fulfilled") account = accountAccess = true;
      else accountError = clean((accountResult.reason as Error)?.message,160);
      if (page && account) { sameToken = true; break; }
    }
    return reply({ ok: true, page_id: pageId, account_id: accountId,
      page_access: pageAccess, account_access: accountAccess,
      ready: sameToken, page_error: pageAccess ? null : pageError,
      account_error: accountAccess ? null : accountError });
  }

  // --- LIST_LEAD_FORMS ---
  // Lists only forms from this client's configured Facebook Page.
  if (action === "LIST_LEAD_FORMS") {
    const scoped = await loadScopedClient(clean(body?.client_name, 160));
    if ("error" in scoped) return scoped.error;
    const assets = await loadAssets(scoped.client.id);
    if (!assets.page_id) return reply({ error: "lead_form_page_missing" }, 409);
    let reason = "meta_lead_form_permission";
    for (const candidate of await tokenCandidates(db)) {
      try {
        const forms = await metaJson(graphUrl(`${assets.page_id}/leadgen_forms`, {
          fields: "id,name,status,created_time",limit: "75",access_token: candidate.token,
        }));
        return reply({ ok: true, page_id: assets.page_id, page_url: `https://www.facebook.com/${assets.page_id}`, forms: (forms?.data || [])
          .filter((item: Row) => numericId(item.id))
          .map((item: Row) => ({ id: numericId(item.id), name: clean(item.name, 160),
            status: clean(item.status, 30), created_at: item.created_time || null })) });
      } catch (err) { reason = clean((err as Error)?.message, 220); }
    }
    return reply({ error: "meta_lead_form_permission", detail: reason }, 403);
  }

  // --- CREATE_LEAD_FORM ---
  // Publishes a native Facebook Page form only after an explicit authenticated click.
  // Does not create a campaign or enable ads; one form per campaign draft (idempotent).
  if (action === "CREATE_LEAD_FORM") {
    const requestId = clean(body?.request_id, 60);
    const { data: row } = await ops.from("campaign_build_requests")
      .select("id,actor_user_id,client_id,status,expires_at,meta_page_id,plan,request_metadata")
      .eq("id", requestId).maybeSingle();
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id || row.status !== "DRAFTED") return reply({ error: "forbidden" }, 403);
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return reply({ error: "draft_expired" }, 409);
    const { data: clientRow } = await ops.from("clients")
      .select("id,display_name,gt_owner,lifecycle").eq("id", row.client_id).maybeSingle();
    if (!clientRow || !inScope(clientRow) || clientRow.lifecycle === "CHURNED") return reply({ error: "forbidden" }, 403);
    if (row.plan?.adset?.destination?.type !== "LEAD_FORM") return reply({ error: "lead_form_not_applicable" }, 409);
    const assets = await loadAssets(row.client_id);
    const pageId = numericId(row.meta_page_id);
    if (!pageId || pageId !== numericId(assets.page_id)) return reply({ error: "lead_form_page_missing" }, 409);
    const existingId = numericId(row.request_metadata?.created_lead_form_id);
    if (existingId) return reply({ ok: true, form_id: existingId, page_id: pageId, reused: true });

    const form = body?.form;
    if (!form || typeof form !== "object" || Array.isArray(form)) return reply({ error: "lead_form_invalid" }, 400);
    const name = clean(form.name, 120);
    const privacy = clean(form.privacy_policy_url, 500);
    const followUp = clean(form.follow_up_action_url, 500);
    if (name.length < 5) return reply({ error: "lead_form_invalid" }, 400);
    try {
      // Accept any public web URL, including Facebook/Instagram and matching URLs.
      // Meta makes the final decision about whether the privacy policy is suitable.
      const links = [new URL(privacy), new URL(followUp)];
      if (links.some(url =>
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname || url.username || url.password ||
        ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname.toLowerCase())
      )) return reply({ error: "lead_form_links_required" }, 400);
    } catch { return reply({ error: "lead_form_links_required" }, 400); }
    const rawQuestions = Array.isArray(form.questions) ? form.questions : [];
    if (rawQuestions.length > 8) return reply({ error: "lead_form_invalid" }, 400);
    const customQuestions: Row[] = [];
    for (const raw of rawQuestions) {
      const label = clean(raw?.label, 160);
      const options = Array.isArray(raw?.options) ?
        raw.options.map((option: unknown) => clean(option, 90)).filter(Boolean) : [];
      if (label.length < 8 || options.length < 2 || options.length > 8 ||
          new Set(options.map((option: string) => option.toLowerCase())).size !== options.length) {
        return reply({ error: "lead_form_invalid" }, 400);
      }
      customQuestions.push({ type: "CUSTOM", label,
        options: options.map((value: string, idx: number) => ({ key: String(idx + 1), value })) });
    }
    if (!customQuestions.length) return reply({ error: "lead_form_invalid" }, 400);
    const fields = [
      { type: "FULL_NAME" }, { type: "PHONE" }, { type: "EMAIL" }, ...customQuestions,
    ];
    let reason = "meta_lead_form_permission";
    for (const candidate of await tokenCandidates(db)) {
      try {
        // The Page access token is preferred, where Meta exposes it to this integration.
        let pageToken = candidate.token;
        // Page token lookup can fail for system-user tokens, even if they can
        // publish a form. Let Meta check permissions at the actual POST.
        try {
          const page = await metaJson(graphUrl(pageId, {
            fields: "id,name,access_token", access_token: candidate.token,
          }));
          if (numericId(page?.id) !== pageId) continue;
          pageToken = clean(page?.access_token, 2000) || candidate.token;
        } catch { /* fallback to configured system-user token */ }
        const created = await metaPost(`${pageId}/leadgen_forms`, pageToken, {
          name,locale: "PT_BR",
          privacy_policy: JSON.stringify({ url: privacy, link_text: "Política de privacidade" }),
          follow_up_action_url: followUp,
          is_optimized_for_quality: clean(form.higher_intent, 10) === "false" ? "false" : "true",
          question_page_custom_headline: clean(form.headline, 100) || "Conte um pouco sobre você",
          questions: JSON.stringify(fields),
        });
        const formId = numericId(created?.id);
        if (!formId) throw new Error("A Meta não devolveu ID de formulário.");
        const updateMeta = { ...(row.request_metadata || {}), created_lead_form_id: formId,
          created_lead_form_page_id: pageId, created_lead_form_name: name,
          created_lead_form_at: new Date().toISOString(), created_lead_form_by: person };
        const { error: saveError } = await ops.from("campaign_build_requests")
          .update({ request_metadata: updateMeta }).eq("id", requestId).eq("status", "DRAFTED");
        if (saveError) return reply({ error: "lead_form_audit_failed", form_id: formId }, 502);
        return reply({ ok: true, form_id: formId, page_id: pageId, form_name: name });
      } catch (err) {
        reason = clean((err as Error)?.message, 350);
        return reply({ error: "lead_form_create_failed", detail: reason,
          meta_code: (err as any)?.metaCode || null,
          meta_subcode: (err as any)?.metaSubcode || null }, 502);
      }
    }
    return reply({ error: "meta_lead_form_permission", detail: reason }, 403);
  }

  // --- BOOTSTRAP ---
  if (action === "BOOTSTRAP") {
    const { data: clients } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle").neq("lifecycle", "CHURNED").order("display_name");
    const scoped = (clients || []).filter(inScope);
    const ids = scoped.map((c: Row) => c.id);
    const [{ data: assetRows }, { data: integrationRows }, { data: history }] = await Promise.all([
      ids.length ? ops.from("client_meta_assets").select("client_id,meta_ad_account_id,meta_page_id").in("client_id", ids) : Promise.resolve({ data: [] }),
      ids.length ? ops.from("client_integrations").select("client_id,external_id,is_primary,meta_ad_account_id").eq("system", "META_BM").in("client_id", ids) : Promise.resolve({ data: [] }),
      ops.from("campaign_build_requests")
        .select("id,client_id,actor_person,actor_user_id,prompt,status,plan,plan_warnings,created_campaign_id,created_adset_id,created_ad_id,error,executed_at,created_at,expires_at,creative_type,creative_file_name")
        .in("client_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
        .order("created_at", { ascending: false }).limit(25),
    ]);
    const assetMap = new Map((assetRows || []).map((r: Row) => [r.client_id, r]));
    const integrationMap = new Map<string, Row[]>();
    for (const row of integrationRows || []) {
      const list = integrationMap.get(row.client_id) || [];
      list.push(row);
      integrationMap.set(row.client_id, list);
    }
    const clientsOut = scoped.map((c: Row) => {
      const assets = assetMap.get(c.id) as Row | undefined;
      let accountId = numericId(assets?.meta_ad_account_id);
      if (!accountId) {
        const rows = integrationMap.get(c.id) || [];
        const primary = rows.find((r: Row) => r.is_primary) || (rows.length === 1 ? rows[0] : null);
        accountId = numericId(primary?.meta_ad_account_id || primary?.external_id);
      }
      return {
        id: c.id,
        display_name: c.display_name,
        lifecycle: c.lifecycle,
        has_ad_account: Boolean(accountId),
        has_page: Boolean(numericId(assets?.meta_page_id)),
      };
    });
    const nameById = new Map(scoped.map((c: Row) => [c.id, c.display_name]));
    const { data: plannerVaultKey } = await ops.rpc("get_secret", { p_name: "OPENAI_API_KEY" });
    const plannerConfigured = Boolean(
      (typeof plannerVaultKey === "string" && plannerVaultKey.trim()) || Deno.env.get("OPENAI_API_KEY")
    );
    return reply({
      ok: true,
      profile: { person, role, is_adler: isAdler },
      planner_configured: plannerConfigured,
      clients: clientsOut,
      history: (history || []).map((h: Row) => ({ ...h, client_name: nameById.get(h.client_id) || null })),
    });
  }

  // --- DRAFT ---
  if (action === "DRAFT") {
    const clientName = clean(body?.client_name, 160);
    const prompt = clean(body?.prompt, 4000);
    if (!clientName || prompt.length < 15) return reply({ error: "prompt_too_short" }, 400);
    if (await rateLimited(["DRAFTED", "EXECUTING", "CREATED", "FAILED", "DISCARDED"], DRAFT_RATE_PER_HOUR)) return reply({ error: "rate_limited" }, 429);
    const scoped = await loadScopedClient(clientName);
    if ("error" in scoped) return scoped.error;
    const assets = await loadAssets(scoped.client.id);

    const inputs = Array.isArray(body?.creatives)
      ? body.creatives : (body?.creative ? [body.creative] : []);
    if (inputs.length > MAX_CREATIVES) return reply({ error: "too_many_creatives", max: MAX_CREATIVES }, 400);
    const creatives: Row[] = inputs.map((item: Row) => ({
      bucket: clean(item?.bucket, 80) === BUCKET ? BUCKET : null,
      path: clean(item?.path, 300) || null,
      type: ["IMAGE", "VIDEO"].includes(clean(item?.type, 10)) ? clean(item.type, 10) : null,
      file_name: clean(item?.file_name, 200) || null,
    }));
    const paths = creatives.map((item) => item.path);
    const creativeValid = creatives.length > 0 && creatives.every((item) =>
      item.bucket === BUCKET && item.path?.startsWith(`campaign-builder/${scoped.client.id}/`) &&
      item.type && item.file_name
    ) && new Set(paths).size === paths.length;
    if (creatives.length && !creativeValid) return reply({ error: "creative_missing" }, 400);
    const creative = creatives[0] || null;


    let guided: Row | null = null;
    if (body?.guided != null) {
      const g=body.guided;
      if (!g || typeof g!=="object" || Array.isArray(g)) return reply({error:"guided_invalid"},400);
      const objective=clean(g.objective,24),destination=clean(g.destination,16);
      const budget=Number(g.budget), radius=g.radius?Number(g.radius):null;
      const cities=clean(g.cities,300).split(/[;\n]+/).map((s:string)=>s.trim()).filter(Boolean).slice(0,10);
      const formId=clean(g.formId,40),url=clean(g.siteUrl,500),start=clean(g.start,10),end=clean(g.end,10);
      if (clean(g.product,120).length<3 || !Number.isFinite(budget) || budget<1 || budget>100000 ||
          !cities.length || (radius!==null && (!Number.isFinite(radius)||radius<1||radius>80)) ||
          !((objective==="OUTCOME_LEADS"&&["LEAD_FORM","WHATSAPP"].includes(destination)) ||
            (objective==="OUTCOME_TRAFFIC"&&destination==="SITE")) ||
          (destination==="SITE"&&!/^https:\/\//.test(url)) || (formId&&!/^\d{5,30}$/.test(formId)) ||
          (start&&!/^\d{4}-\d{2}-\d{2}$/.test(start)) || (end&&!/^\d{4}-\d{2}-\d{2}$/.test(end)) ||
          (start&&end&&start>end))return reply({error:"guided_invalid"},400);
      guided={objective,destination,budget:Math.round(budget),radius,cities,
        formId:formId||null,url:url||null,start:start||"NOW",end:end||null,
        name:clean(g.campaignName,120),text:clean(g.text,900),headline:clean(g.headline,60)};
    }
    // Turbinar: publicação existente no lugar do criativo
    const boost = body?.boost && typeof body.boost === "object" ? {
      source: ["FACEBOOK", "INSTAGRAM"].includes(clean(body.boost.source, 12)) ? clean(body.boost.source, 12) : null,
      post_id: clean(body.boost.post_id, 80) || null,
      permalink: clean(body.boost.permalink, 500) || null,
      caption: clean(body.boost.caption, 300) || null,
    } : null;
    const boostValid = Boolean(boost?.source && boost?.post_id && /^[\d_]{5,80}$/.test(boost.post_id || ""));

    let planned: { plan: Row; model: string };
    try {
      planned = await callPlanner(ops, prompt, {
        cliente: scoped.client.display_name,
        segmento: "imobiliário",
        modo: boostValid ? "TURBINAR" : "CAMPANHA_NOVA",
        publicacao_turbinada: boostValid ? { rede: boost?.source, legenda: boost?.caption || "(sem legenda)" } : null,
        tem_pagina_cadastrada: Boolean(assets.page_id),
        tem_pixel: Boolean(assets.pixel_id),
        criativos_anexados: creativeValid ? creatives.map((item) => ({ tipo: item.type, nome: item.file_name })) : [],
      });
    } catch (error) {
      const reason = clean((error as Error)?.message, 300);
      if (reason === "planner_not_configured") return reply({ error: "planner_not_configured" }, 503);
      if (reason === "planner_incomplete") return reply({ error: "planner_incomplete" }, 502);
      return reply({ error: "planner_failed", detail: reason }, 502);
    }
    const plan = planned.plan;
    if (boostValid) {
      if (plan.campaign.objective !== "OUTCOME_TRAFFIC") plan.campaign.objective = "OUTCOME_ENGAGEMENT";
      plan.adset.destination = { type: "POST", url: null, lead_form_id: null };
      plan.boost = boost;
    }


    // As escolhas feitas pelo GT são autoritativas: a IA não pode alterar orçamento ou destino.
    if (guided&&!boostValid) {
      plan.campaign.objective=guided.objective;
      if (guided.name) plan.campaign.name=guided.name;
      plan.adset.daily_budget_brl=guided.budget;
      plan.adset.geo.cities=guided.cities;
      plan.adset.geo.radius_km=guided.radius;
      plan.adset.age_min=18;plan.adset.age_max=65;plan.adset.genders="all";
      plan.adset.start=guided.start;plan.adset.end=guided.end;
      plan.adset.destination={type:guided.destination,url:guided.destination==="SITE"?guided.url:null,
        lead_form_id:guided.destination==="LEAD_FORM"?guided.formId:null};
      if(guided.text)plan.ad.primary_text=guided.text;
      if(guided.headline)plan.ad.headline=guided.headline;
      plan.ad.cta=guided.destination==="LEAD_FORM"?"SIGN_UP":guided.destination==="WHATSAPP"?"WHATSAPP_MESSAGE":"LEARN_MORE";
    }
    // Resolve geolocalização com o token de leitura/escrita disponível
    let geo: { resolved: Row[]; unresolved: string[] } = { resolved: [], unresolved: plan.adset.geo.cities };
    const tokens = await tokenCandidates(db);
    if (tokens.length && plan.adset.geo.cities.length) {
      geo = await resolveGeo(tokens[0].token, plan.adset.geo.cities);
    }

    const warnings: string[] = [];
    if (!assets.account_id) warnings.push(assets.account_ambiguous ? "Cliente tem mais de uma conta de anúncio e nenhuma marcada como principal. Ajuste em Ativos Meta." : "Cliente sem conta de anúncio cadastrada. Preencha em Ativos Meta.");
    if (boostValid) {
      if (boost?.source === "INSTAGRAM" && !assets.instagram_id) warnings.push("Turbinar publicação do Instagram exige o Instagram cadastrado em Ativos Meta.");
      if (boost?.source === "FACEBOOK" && !assets.page_id) warnings.push("Turbinar publicação do Facebook exige a Página cadastrada em Ativos Meta.");
    } else {
      if (!assets.page_id) warnings.push("Cliente sem Página do Facebook cadastrada em Ativos Meta. Sem ela não dá para criar o anúncio.");
      if (!creativeValid) warnings.push("Nenhum criativo anexado. Anexe a arte ou o vídeo antes de criar.");
      if (plan.adset.destination.type === "SITE" && !plan.adset.destination.url) warnings.push("Destino SITE sem URL definida.");
      if (plan.adset.destination.type === "LEAD_FORM" && !plan.adset.destination.lead_form_id) warnings.push("Destino formulário nativo exige o ID do formulário (crie na página do cliente e informe no pedido).");
    }
    if (plan.adset.daily_budget_brl <= 0) warnings.push("Orçamento diário não definido no pedido.");
    if (geo.unresolved.length) warnings.push(`Localizações não encontradas na Meta: ${geo.unresolved.join(", ")}.`);
    if (assets.minimum_ad_budget && plan.adset.daily_budget_brl > 0) {
      const monthly = plan.adset.daily_budget_brl * 30.4;
      if (monthly < Number(assets.minimum_ad_budget)) warnings.push(`Orçamento mensal estimado (R$ ${Math.round(monthly)}) abaixo do mínimo contratado (R$ ${assets.minimum_ad_budget}).`);
    }

    const planHash = await sha256(JSON.stringify({ actor: user.id, client: scoped.client.id, plan, geo: geo.resolved, creatives: creativeValid ? creatives.map((c) => c.path) : [] }));
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
    const { data: inserted, error: insertError } = await ops.from("campaign_build_requests").insert({
      client_id: scoped.client.id,
      actor_user_id: user.id,
      actor_person: person,
      actor_role: role,
      prompt,
      status: "DRAFTED",
      plan: { ...plan, geo_resolved: geo.resolved },
      plan_hash: planHash,
      plan_warnings: warnings,
      meta_ad_account_id: assets.account_id,
      meta_page_id: assets.page_id,
      creative_bucket: !boostValid && creativeValid ? creative?.bucket : null,
      creative_path: !boostValid && creativeValid ? creative?.path : null,
      creative_type: !boostValid && creativeValid ? creative?.type : null,
      creative_file_name: !boostValid && creativeValid ? creative?.file_name : null,
      expires_at: expiresAt,
      request_metadata: { source: "CAMPAIGN_BUILDER_V2", input_mode: guided ? "GUIDED" : "PROMPT", mode: boostValid ? "BOOST" : "NEW", model: planned.model, instagram_id: assets.instagram_id, pixel_id: assets.pixel_id, geo_unresolved: geo.unresolved, creatives: !boostValid && creativeValid ? creatives : [] },
    }).select("id").single();
    if (insertError || !inserted?.id) return reply({ error: "audit_store_failed" }, 500);

    return reply({
      ok: true,
      request_id: inserted.id,
      client: { id: scoped.client.id, display_name: scoped.client.display_name },
      plan: { ...plan, geo_resolved: geo.resolved },
      warnings,
      expires_at: expiresAt,
      assets: { account_id: assets.account_id, page_id: assets.page_id, instagram_id: assets.instagram_id },
      mode: boostValid ? "BOOST" : "NEW",
      can_execute: Boolean(assets.account_id && plan.adset.daily_budget_brl > 0 && (boostValid
        ? (boost?.source === "INSTAGRAM" ? assets.instagram_id : assets.page_id)
        : (assets.page_id && creativeValid &&
          !(plan.adset.destination.type === "SITE" && !plan.adset.destination.url) &&
          !(plan.adset.destination.type === "LEAD_FORM" && !plan.adset.destination.lead_form_id)))),
    });
  }


  // --- RESUME_DRAFT ---
  if (action === "RESUME_DRAFT") {
    const requestId = clean(body?.request_id, 60);
    if (!requestId) return reply({ error: "request_required" }, 400);
    const { data: row, error: readError } = await ops.from("campaign_build_requests")
      .select("*").eq("id", requestId).maybeSingle();
    if (readError) return reply({ error: "query_failed" }, 500);
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id) return reply({ error: "forbidden" }, 403);
    if (row.status !== "DRAFTED") return reply({ error: "request_not_draft" }, 409);
    if (row.created_campaign_id || row.created_adset_id || row.created_ad_id)
      return reply({ error: "request_already_executed" }, 409);
    const { data: clientRow } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle")
      .eq("id", row.client_id).maybeSingle();
    if (!clientRow || !inScope(clientRow) || clientRow.lifecycle === "CHURNED")
      return reply({ error: "forbidden" }, 403);
    const assets = await loadAssets(row.client_id);
    if (!assets.account_id || assets.account_id !== numericId(row.meta_ad_account_id))
      return reply({ error: "assets_changed", detail: "A conta de anúncios mudou." }, 409);
    if (row.request_metadata?.mode !== "BOOST" && assets.page_id !== numericId(row.meta_page_id))
      return reply({ error: "assets_changed", detail: "A Página da Meta mudou." }, 409);
    const creatives: Row[] = Array.isArray(row.request_metadata?.creatives) &&
      row.request_metadata.creatives.length ? row.request_metadata.creatives :
      row.creative_path ? [{ bucket: row.creative_bucket, path: row.creative_path,
        type: row.creative_type, file_name: row.creative_file_name }] : [];
    if (row.request_metadata?.mode !== "BOOST") {
      if (!creatives.length || creatives.length > MAX_CREATIVES || !creatives.every((item) =>
        item.bucket === BUCKET && typeof item.path === "string" &&
        item.path.startsWith(`campaign-builder/${row.client_id}/`) &&
        ["IMAGE","VIDEO"].includes(item.type))) return reply({ error: "creative_missing" }, 409);
      const exists = await Promise.all(creatives.map(async (item) => {
        const path = String(item.path), slash = path.lastIndexOf("/");
        const { data, error } = await db.storage.from(BUCKET).list(path.slice(0, slash),
          { search: path.slice(slash + 1), limit: 30 });
        return !error && (data || []).some((file: Row) => file.name === path.slice(slash + 1));
      }));
      if (exists.some((present) => !present)) return reply({ error: "creative_missing",
        detail: "Um ou mais arquivos do rascunho não estão mais disponíveis." }, 409);
    }
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
    const { data: renewed, error: saveError } = await ops.from("campaign_build_requests")
      .update({ expires_at: expiresAt }).eq("id", requestId).eq("status", "DRAFTED")
      .select("id").maybeSingle();
    if (saveError) return reply({ error: "query_failed" }, 500);
    if (!renewed?.id) return reply({ error: "request_not_draft" }, 409);
    return reply({ ok: true, request_id: requestId, plan: row.plan, prompt: row.prompt,
      client: { id: clientRow.id, display_name: clientRow.display_name },
      mode: row.request_metadata?.mode === "BOOST" ? "BOOST" : "NEW",
      creatives, warnings: row.plan_warnings || [], expires_at: expiresAt,
      assets: { account_id: assets.account_id, page_id: assets.page_id,
        instagram_id: assets.instagram_id } });
  }

  // --- DISCARD ---
  if (action === "DISCARD") {
    const requestId = clean(body?.request_id, 60);
    if (!requestId) return reply({ error: "request_required" }, 400);
    const { data: row } = await ops.from("campaign_build_requests").select("id,actor_user_id,status").eq("id", requestId).maybeSingle();
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id && !isAdler && role !== "MGMT") return reply({ error: "forbidden" }, 403);
    if (row.status !== "DRAFTED") return reply({ error: "request_not_draft" }, 409);
    const { data: changed, error: updateError } = await ops.from("campaign_build_requests")
      .update({ status: "DISCARDED" }).eq("id", requestId).eq("status", "DRAFTED")
      .select("id").maybeSingle();
    if (updateError) return reply({ error: "query_failed" }, 500);
    if (!changed?.id) return reply({ error: "request_not_draft" }, 409);
    return reply({ ok: true, request_id: requestId, status: "DISCARDED" });
  }

  // --- EXECUTE ---
  if (action === "EXECUTE") {
    const requestId = clean(body?.request_id, 60);
    if (!requestId) return reply({ error: "request_required" }, 400);
    if (clean(body?.confirmation, 20).toUpperCase() !== "CRIAR") return reply({ error: "confirmation_required" }, 400);
    if (await rateLimited(["EXECUTING", "CREATED", "FAILED"], EXECUTE_RATE_PER_HOUR)) return reply({ error: "rate_limited" }, 429);

    const { data: row } = await ops.from("campaign_build_requests").select("*").eq("id", requestId).maybeSingle();
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id) return reply({ error: "forbidden" }, 403);
    if (row.status !== "DRAFTED") return reply({ error: "request_not_draft", status: row.status }, 409);
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return reply({ error: "draft_expired" }, 409);

    // escopo revalidado pelo client_id do rascunho, não pelo nome:
    const { data: clientRow } = await ops.from("clients").select("id,display_name,gt_owner,lifecycle").eq("id", row.client_id).maybeSingle();
    if (!clientRow || !inScope(clientRow)) return reply({ error: "forbidden" }, 403);
    if (clean(clientRow.lifecycle, 30).toUpperCase() === "CHURNED") return reply({ error: "client_churned" }, 409);

    const plan = row.plan as Row;
    if (!plan?.campaign || !plan?.adset || !plan?.ad ||
        clean(plan.campaign.name,120) === "Campanha sem nome" ||
        !clean(plan.campaign.name,120) || !clean(plan.adset.name,120) ||
        Number(plan.adset.daily_budget_brl) <= 0 ||
        (row.request_metadata?.mode !== "BOOST" &&
          (!clean(plan.ad.primary_text,900) || !clean(plan.ad.headline,60))))
      return reply({ error: "draft_incomplete" }, 409);
    const boostMode = clean(row.request_metadata?.mode, 10) === "BOOST" && Boolean(plan?.boost?.post_id);
    const creativeRows: Row[] = Array.isArray(row.request_metadata?.creatives) && row.request_metadata.creatives.length
      ? row.request_metadata.creatives
      : row.creative_path ? [{ bucket: row.creative_bucket, path: row.creative_path, type: row.creative_type, file_name: row.creative_file_name }] : [];
    const validCreativeRows = creativeRows.length > 0 && creativeRows.length <= MAX_CREATIVES &&
      new Set(creativeRows.map((c) => c.path)).size === creativeRows.length &&
      creativeRows.every((c) =>
        c.bucket === BUCKET && typeof c.path === "string" &&
        c.path.startsWith(`campaign-builder/${row.client_id}/`) &&
        ["IMAGE", "VIDEO"].includes(c.type)
      );
    const accountId = numericId(row.meta_ad_account_id);
    const pageId = numericId(row.meta_page_id);
    const instagramId = numericId(row.request_metadata?.instagram_id) || null;
    if (!accountId) return reply({ error: "assets_missing" }, 409);
    if (boostMode) {
      if (plan.boost.source === "INSTAGRAM" && !instagramId) return reply({ error: "assets_missing" }, 409);
      if (plan.boost.source === "FACEBOOK" && !pageId) return reply({ error: "assets_missing" }, 409);
    } else {
      if (!pageId) return reply({ error: "assets_missing" }, 409);
      if (!validCreativeRows) return reply({ error: "creative_missing" }, 409);
    }
    if (!plan?.adset?.daily_budget_brl || plan.adset.daily_budget_brl <= 0) return reply({ error: "budget_missing" }, 409);

    // Overrides limitados vindos do preview (nomes, textos, orçamento)
    const overrides = body?.overrides && typeof body.overrides === "object" ? body.overrides : null;
    if (overrides) {
      if (clean(overrides.campaign_name, 120)) plan.campaign.name = clean(overrides.campaign_name, 120);
      if (clean(overrides.adset_name, 120)) plan.adset.name = clean(overrides.adset_name, 120);
      if (clean(overrides.ad_name, 120)) plan.ad.name = clean(overrides.ad_name, 120);
      if (clean(overrides.primary_text, 900)) plan.ad.primary_text = clean(overrides.primary_text, 900);
      if (clean(overrides.headline, 60)) plan.ad.headline = clean(overrides.headline, 60);
      if (Number(overrides.daily_budget_brl) > 0) plan.adset.daily_budget_brl = Math.round(Number(overrides.daily_budget_brl));
      if (clean(overrides.site_url, 500) && plan.adset.destination.type === "SITE") plan.adset.destination.url = clean(overrides.site_url, 500);
      if (numericId(overrides.lead_form_id) && plan.adset.destination.type === "LEAD_FORM") plan.adset.destination.lead_form_id = numericId(overrides.lead_form_id);
    }
    if (!boostMode && plan.adset.destination.type === "SITE" && !plan.adset.destination.url) return reply({ error: "site_url_missing" }, 409);
    if (!boostMode && plan.adset.destination.type === "LEAD_FORM" && !plan.adset.destination.lead_form_id) return reply({ error: "lead_form_missing" }, 409);

    await ops.from("campaign_build_requests").update({ status: "EXECUTING", overrides, executed_at: new Date().toISOString() }).eq("id", requestId);
    const fail = async (stage: string, error: unknown, created: Row) => {
      const message = clean((error as Error)?.message || error, 500);
      // rollback: apaga o que já foi criado, na ordem inversa
      const rollback: Row = {};
      rollback.ads = [];
      for (const id of [...(created.ad_ids || [])].reverse()) {
        try { await metaDelete(id, created.token); rollback.ads.push({ id, deleted: true }); }
        catch { rollback.ads.push({ id, deleted: false }); }
      }
      rollback.creatives = [];
      for (const id of [...(created.creative_ids || [])].reverse()) {
        try { await metaDelete(id, created.token); rollback.creatives.push({ id, deleted: true }); }
        catch { rollback.creatives.push({ id, deleted: false }); }
      }
      for (const id of [...(created.video_ids || [])].reverse()) {
        try { await metaDelete(id, created.token); } catch { /* a video upload may remain for inspection */ }
      }
      try { if (created.adset_id) { await metaDelete(created.adset_id, created.token); rollback.adset = true; } } catch { rollback.adset = false; }
      try { if (created.campaign_id) { await metaDelete(created.campaign_id, created.token); rollback.campaign = true; } } catch { rollback.campaign = false; }
      await ops.from("campaign_build_requests").update({
        status: "FAILED",
        error: `${stage}: ${message}`,
        request_metadata: { ...(row.request_metadata || {}), rollback, failed_stage: stage },
      }).eq("id", requestId);
      return reply({ error: "execution_failed", stage, detail: message, request_id: requestId }, 502);
    };

    const created: Row = {};
    try {
      // token com ads_management e acesso à conta
      const resolved = await resolveWriteToken(db, accountId);
      if ("error" in resolved && resolved.error) return await fail("token", new Error(resolved.error), created);
      const token = (resolved as any).candidate.token as string;
      created.token = token;

      // campanha
      const campaign = await metaPost(`act_${accountId}/campaigns`, token, {
        name: plan.campaign.name,
        objective: plan.campaign.objective,
        status: "PAUSED",
        special_ad_categories: "[]",
        buying_type: "AUCTION",
      });
      created.campaign_id = clean(campaign?.id, 40);
      if (!created.campaign_id) return await fail("campaign_create", new Error("Meta não devolveu o ID da campanha."), created);

      // conjunto
      const targeting = buildTargeting(plan, plan.geo_resolved || []);
      const adset = await metaPost(`act_${accountId}/adsets`, token, adsetFields(plan, created.campaign_id, targeting, boostMode) as Record<string, string>);
      created.adset_id = clean(adset?.id, 40);
      if (!created.adset_id) return await fail("adset_create", new Error("Meta não devolveu o ID do conjunto."), created);

      // Um anúncio pausado por criativo, todos no mesmo conjunto e mesma campanha.
      created.ad_ids = [];
      created.creative_ids = [];
      created.video_ids = [];
      for (let index = 0; index < (boostMode ? 1 : creativeRows.length); index++) {
        const item = boostMode ? null : creativeRows[index];
        let imageHash: string | null = null;
        let video: { id: string; thumb: string } | null = null;
        if (item) {
          const { data: fileData, error: downloadError } = await db.storage.from(item.bucket).download(item.path);
          if (downloadError || !fileData) return await fail(`creative_download_${index + 1}`, downloadError || new Error("empty_file"), created);
          if (item.type === "IMAGE") {
            const form = new FormData();
            form.set("access_token", token);
            form.set("source", new File([fileData], item.file_name || "creative.jpg", { type: fileData.type || "image/jpeg" }));
            const uploaded = await metaJson(`https://graph.facebook.com/${GRAPH}/act_${accountId}/adimages`, { method: "POST", body: form });
            const images = uploaded?.images || {};
            imageHash = images[Object.keys(images)[0]]?.hash || null;
            if (!imageHash) return await fail(`image_upload_${index + 1}`, new Error("Meta não devolveu image_hash."), created);
          } else {
            const form = new FormData();
            form.set("access_token", token);
            form.set("source", new File([fileData], item.file_name || "creative.mp4", { type: fileData.type || "video/mp4" }));
            const uploaded = await metaJson(`https://graph.facebook.com/${GRAPH}/act_${accountId}/advideos`, { method: "POST", body: form });
            const videoId = clean(uploaded?.id, 40);
            if (!videoId) return await fail(`video_upload_${index + 1}`, new Error("Meta não devolveu o ID do vídeo."), created);
            created.video_ids.push(videoId);
            let thumb = "";
            for (let attempt = 0; attempt < 12; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 5000));
              try {
                const status = await metaJson(graphUrl(videoId, { fields: "status", access_token: token }));
                if (clean(status?.status?.video_status, 40).toLowerCase() === "ready") {
                  const thumbs = await metaJson(graphUrl(`${videoId}/thumbnails`, { access_token: token }));
                  thumb = clean((thumbs?.data || []).find((t: Row) => t.is_preferred)?.uri || thumbs?.data?.[0]?.uri, 1000);
                  break;
                }
              } catch { /* tenta de novo */ }
            }
            if (!thumb) return await fail(`video_processing_${index + 1}`, new Error("Vídeo ainda em processamento na Meta. Tente de novo em alguns minutos."), created);
            video = { id: videoId, thumb };
          }
        }
        const itemName = (boostMode ? plan.ad.name : `${plan.ad.name} — ${index + 1}/${creativeRows.length}`).slice(0, 120);
        let creativeFields: Record<string, string>;
        if (boostMode && plan.boost.source === "FACEBOOK") {
          creativeFields = { name: `${itemName} — turbinar`, object_story_id: plan.boost.post_id };
        } else if (boostMode) {
          const igFields: Row = { name: `${itemName} — turbinar`, instagram_user_id: instagramId, source_instagram_media_id: plan.boost.post_id };
          if (pageId) igFields.object_id = pageId;
          creativeFields = igFields as Record<string, string>;
        } else {
          creativeFields = {
            name: `${itemName} — criativo`,
            object_story_spec: JSON.stringify(creativeSpec(plan, pageId, instagramId, imageHash, video)),
          };
        }
        const creative = await metaPost(`act_${accountId}/adcreatives`, token, creativeFields);
        const creativeId = clean(creative?.id, 40);
        if (!creativeId) return await fail(`creative_create_${index + 1}`, new Error("Meta não devolveu o ID do criativo."), created);
        created.creative_ids.push(creativeId);

        const ad = await metaPost(`act_${accountId}/ads`, token, {
          name: itemName,
          adset_id: created.adset_id,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
        });
        const adId = clean(ad?.id, 40);
        if (!adId) return await fail(`ad_create_${index + 1}`, new Error("Meta não devolveu o ID do anúncio."), created);
        created.ad_ids.push(adId);
      }
      created.ad_id = created.ad_ids[0] || null;
      created.creative_id = created.creative_ids[0] || null;

      // verificação: campanha existe e está pausada
      const live = await metaJson(graphUrl(created.campaign_id, { fields: "id,name,status,effective_status", access_token: token }));
      if (clean(live?.status, 20).toUpperCase() !== "PAUSED") {
        return await fail("verification", new Error(`Campanha criada mas com status inesperado: ${live?.status}.`), created);
      }
      for (const adId of created.ad_ids) {
        const adCheck = await metaJson(graphUrl(adId, { fields: "id,status", access_token: token }));
        if (clean(adCheck?.status, 20).toUpperCase() !== "PAUSED") {
          return await fail("verification_ads", new Error(`Anúncio ${adId} não está pausado.`), created);
        }
      }

      await ops.from("campaign_build_requests").update({
        status: "CREATED",
        created_campaign_id: created.campaign_id,
        created_adset_id: created.adset_id,
        created_creative_id: created.creative_id,
        created_ad_id: created.ad_id,
        error: null,
        plan,
        request_metadata: { ...(row.request_metadata || {}), token_source: (resolved as any).candidate.source, account_name: (resolved as any).account?.name || null, created_ad_ids: created.ad_ids, created_creative_ids: created.creative_ids },
      }).eq("id", requestId);

      // inventário canônico fica coerente sem esperar o próximo sync
      await ops.from("meta_campaign_inventory").upsert({
        client_id: row.client_id,
        account_key: accountId,
        meta_ad_account_id: accountId,
        campaign_id: created.campaign_id,
        campaign_name: plan.campaign.name,
        campaign_status: "PAUSED",
        objective: plan.campaign.objective,
        checked_at: new Date().toISOString(),
      }, { onConflict: "client_id,campaign_id" });

      return reply({
        ok: true,
        status: "CREATED",
        request_id: requestId,
        campaign_id: created.campaign_id,
        adset_id: created.adset_id,
        ad_id: created.ad_id,
        ad_ids: created.ad_ids,
        creative_ids: created.creative_ids,
        campaign_name: plan.campaign.name,
        note: "Tudo criado PAUSADO. Revise no Gerenciador de Anúncios e ative por lá ou pela Central de Tráfego.",
      });
    } catch (error) {
      return await fail("unexpected", error, created);
    }
  }

  return reply({ error: "invalid_action" }, 400);
});
