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
import { normalizeWhatsAppRecipient, provisionMakeLeads, type LeadQuestion } from "./make-leads.ts";

const SERVICE = "agency-ops-campaign-builder-api";
const SERVICE_VERSION = "v1.3.0";
// Marketing API v26.0 e a versao vigente para novas operacoes em outubro de 2026.
const GRAPH = "v26.0";
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

/**
 * Campaign payload (ABO: the budget lives on the ad set).
 * Meta Marketing API v24+ rejects campaigns without campaign budget unless
 * is_adset_budget_sharing_enabled is explicit (error 100 / subcode 4834011).
 * "false" keeps the exact daily budget the GT approved on each ad set.
 */
function campaignFields(plan: any) {
  return {
    name: String(plan.campaign.name),
    objective: String(plan.campaign.objective),
    status: "PAUSED",
    special_ad_categories: "[]",
    buying_type: "AUCTION",
    is_adset_budget_sharing_enabled: "false",
  };
}

/**
 * A FAILED job may be retried only when Meta provably holds nothing from it:
 * a token failure before any mutation, a definitive validation error
 * (Meta code 100) on campaign_create, or a code-100 failure in a later stage
 * whose rollback completed (all created objects deleted).
 */
function safeRetryEligible(row: any) {
  if (!row || row.status !== "FAILED") return false;
  if (row.created_campaign_id || row.created_adset_id || row.created_ad_id) return false;
  const md = row.request_metadata || {};
  if (md.rollback_incomplete) return false;
  // IDs recorded before a completed rollback were deleted from Meta.
  if (((md.created_ad_ids || []).length || (md.created_creative_ids || []).length) && md.rollback_incomplete !== false) return false;
  const err = String(row.error || "").trim();
  if (/^token:\s*(meta_account_access_missing|meta_write_permission_missing|meta_token_missing)$/.test(err)) return true;
  if (md.failed_stage === "campaign_create" && Number(md.meta_code) === 100 && /^campaign_create:/.test(err)) return true;
  // Later stages: only a definitive Meta validation error (code 100) whose
  // rollback finished cleanly (rollback_incomplete explicitly false).
  return Number(md.meta_code) === 100 && md.rollback_incomplete === false &&
    typeof md.failed_stage === "string" && err.startsWith(`${md.failed_stage}:`);
}

/** Drops failure fields left by earlier attempts once a run succeeds. */
function successMetadata(md: any) {
  const out = { ...(md || {}) };
  for (const key of ["failed_stage", "meta_code", "meta_subcode", "rollback", "rollback_incomplete"]) delete out[key];
  return out;
}

async function tokenCandidates(db: any): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  // Preferred: imobi-board system user (app Imobi-Board, Live mode). Apps in
  // development mode cannot create ad creatives (Meta 100/1885183).
  const { data: builderToken, error: builderError } = await db.schema("agency_ops")
    .rpc("get_secret", { p_name: "META_CAMPAIGN_BUILDER_TOKEN" });
  const builder = !builderError && typeof builderToken === "string" ? builderToken.trim() : "";
  if (builder) out.push({ token: builder, source: "CAMPAIGN_BUILDER_VAULT" });
  const { data, error } = await db.schema("agency_ops").rpc("get_meta_system_user_token");
  const vault = !error && typeof data === "string" ? data.trim() : "";
  if (vault && !out.some((item) => item.token === vault)) out.push({ token: vault, source: "SUPABASE_VAULT" });
  const env = clean(Deno.env.get("META_SYSTEM_USER_TOKEN"), 1000);
  if (env && !out.some((item) => item.token === env)) out.push({ token: env, source: "EDGE_ENV" });
  return out;
}


/**
 * Resolve a Page-scoped credential only for NC Imóveis.
 * Meta leadgen_forms requires a Page token, not a system-user token.
 * Never return, log, or persist this derived credential.
 */
async function resolveNcPageToken(systemToken: string, pageId: string): Promise<string | null> {
  if (pageId !== "132141753324688") return null;
  const pages = await metaJson(graphUrl("me/accounts", {
    fields: "id,tasks,access_token", limit: "100", access_token: systemToken,
  }));
  const page = (pages?.data || []).find((item: Row) =>
    numericId(item?.id) === pageId &&
    Array.isArray(item?.tasks) && item.tasks.includes("MANAGE_LEADS") &&
    item.tasks.includes("ADVERTISE")
  );
  return page ? clean(page.access_token, 3000) || null : null;
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

const VISION_PAIR_PROMPT = `Voce recebe artes de anuncios imobiliarios. As marcadas F1, F2... sao versoes FEED (1:1 ou 4:5) e as marcadas S1, S2... sao versoes STORY (9:16).
A producao entrega cada peca nas duas versoes: mesma foto ou cena principal, mesmo titulo, mesma oferta, mesmo preco e mesma identidade visual, apenas diagramada em outra proporcao.
Tarefa: dizer qual STORY e a mesma peca de qual FEED.
Regras:
- So pareie quando tiver certeza de que e a MESMA peca. Pecas diferentes do mesmo imovel (titulo, oferta, preco ou chamada diferentes) NAO sao a mesma peca.
- Variacoes costumam ter os MESMOS textos e trocar so as fotos. Por isso compare primeiro as fotos: a mesma peca usa as mesmas fotos, na mesma ordem e posicao relativa (o que esta em cima no feed continua em cima no story). Se a foto principal for outra ou a ordem das fotos mudar, NAO e a mesma peca, mesmo com textos iguais.
- Nao force um par so porque existe um unico F e um unico S.
- Cada F e cada S aparece no maximo uma vez. Pode sobrar F ou S sem par.
- confidence de 0 a 1. Use menos de 0.8 quando houver qualquer duvida.
Responda somente JSON: {"pairs":[{"feed":"F1","story":"S2","confidence":0.95,"reason":"curto"}]}`;

/** Fallback do pareamento por nome: a IA olha as artes e sugere os pares feed + story. */
async function visionPairCreatives(ops: any, feedUrls: string[], storyUrls: string[]) {
  const { data: vaultKey } = await ops.rpc("get_secret", { p_name: "OPENAI_API_KEY" });
  const key = typeof vaultKey === "string" && vaultKey.trim() ? vaultKey.trim() : clean(Deno.env.get("OPENAI_API_KEY"), 2000);
  if (!key) throw new Error("vision_not_configured");
  const { data: modelSetting } = await ops.from("automation_settings").select("value").eq("key", "CAMPAIGN_BUILDER_VISION_MODEL").maybeSingle();
  const model = clean(modelSetting?.value, 60) || clean(Deno.env.get("CAMPAIGN_BUILDER_VISION_MODEL"), 60) || "gpt-5-mini";
  const content: Row[] = [{ type: "text", text: VISION_PAIR_PROMPT }];
  feedUrls.forEach((url, i) => { content.push({ type: "text", text: `F${i + 1}` }); content.push({ type: "image_url", image_url: { url, detail: "high" } }); });
  storyUrls.forEach((url, i) => { content.push({ type: "text", text: `S${i + 1}` }); content.push({ type: "image_url", image_url: { url, detail: "high" } }); });
  const payload: Row = { model, response_format: { type: "json_object" }, max_completion_tokens: 3000, messages: [{ role: "user", content }] };
  if (/^gpt-5/i.test(model)) payload.reasoning_effort = "low";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`openai ${response.status}: ${raw.slice(0, 200)}`);
  const text = JSON.parse(raw)?.choices?.[0]?.message?.content;
  return { model, result: parseJsonText(String(text || "{}")) };
}

// Siglas e nomes de estados aceitos como sufixo ("Caraguatatuba, SP",
// "Santos - São Paulo", "Ubatuba (SP)"). A busca da Meta não entende o
// sufixo e devolvia vazio, e o conjunto acabava criado para o Brasil inteiro.
const BR_STATES: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará",
  DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão",
  MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará",
  PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
function foldText(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function stateFromSuffix(raw: string): { uf: string; name: string } | null {
  const text = raw.trim();
  const match = text.match(/^(.*?)\s*(?:,|-|–|\/|\()\s*([^,()\-–/]+?)\s*\)?\s*$/u);
  if (!match) return null;
  const tail = match[2].trim();
  const byUf = BR_STATES[tail.toUpperCase()];
  if (byUf && match[1].trim().length >= 3) return { uf: tail.toUpperCase(), name: byUf };
  const byName = Object.entries(BR_STATES).find(([, name]) => foldText(name) === foldText(tail));
  if (byName && match[1].trim().length >= 3) return { uf: byName[0], name: byName[1] };
  return null;
}
type GeoQueryPlan = {
  // Formas tentadas em ordem até a primeira que a Meta reconhece.
  attempts: Array<{ q: string; state: string | null }>;
  // Partes separadas por vírgula ("Santos, Praia Grande"): cada uma vira um local.
  parts: string[];
};
function geoQueryPlan(raw: string): GeoQueryPlan {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { attempts: [], parts: [] };
  const state = stateFromSuffix(text);
  const attempts: Array<{ q: string; state: string | null }> = [];
  if (state) {
    const base = text.replace(/\s*(?:,|-|–|\/|\()\s*[^,()\-–/]+?\s*\)?\s*$/u, "").trim();
    if (base.length >= 3) attempts.push({ q: base, state: state.name });
  }
  attempts.push({ q: text, state: null });
  const parts = !state && text.includes(",")
    ? text.split(",").map((p) => p.trim()).filter((p) => p.length >= 3) : [];
  return { attempts, parts: parts.length > 1 ? parts : [] };
}
async function searchGeo(token: string, q: string, state: string | null): Promise<Row | null> {
  const body = await metaJson(graphUrl("search", {
    type: "adgeolocation",
    q,
    location_types: JSON.stringify(["city", "region", "geo_market"]),
    country_code: "BR",
    limit: "5",
    access_token: token,
  }));
  const hits: Row[] = (body?.data || []).filter((h: Row) => h?.key);
  const hit = state
    ? hits.find((h) => foldText(String(h.region || "")).includes(foldText(state)))
    : hits[0];
  return hit?.key ? hit : null;
}
async function resolveGeo(token: string, cities: string[]) {
  const resolved: Row[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const push = (query: string, hit: Row) => {
    if (seen.has(String(hit.key))) return;
    seen.add(String(hit.key));
    resolved.push({ query, key: hit.key, name: hit.name, type: hit.type, region: hit.region || null });
  };
  for (const city of cities.slice(0, 10)) {
    const plan = geoQueryPlan(city);
    let found = false;
    for (const attempt of plan.attempts) {
      try {
        const hit = await searchGeo(token, attempt.q, attempt.state);
        if (hit) { push(city, hit); found = true; break; }
      } catch { /* tenta a próxima forma */ }
    }
    if (!found && plan.parts.length) {
      const missing: string[] = [];
      for (const part of plan.parts) {
        try {
          const hit = await searchGeo(token, part, null);
          if (hit) { push(part, hit); found = true; } else missing.push(part);
        } catch { missing.push(part); }
      }
      if (missing.length) unresolved.push(...missing);
      continue;
    }
    if (!found) unresolved.push(city);
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

function adsetFields(plan: Row, campaignId: string, targeting: Row, boostMode: boolean, pageId: string) {
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
    // Formulario instantaneo necessita vincular a pagina ao conjunto.
    fields.promoted_object = JSON.stringify({ page_id: pageId });
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

/**
 * Lead ads must link to external content (Meta 100 / subcode 1815316 rejects
 * a link to the Facebook Page). Picks the first http(s) URL that is not a
 * Meta-owned domain, e.g. from the Page "website" field.
 */
function externalLeadLink(raw: unknown): string | null {
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) continue;
      if (/(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|whatsapp\.com|wa\.me|messenger\.com)$/i.test(url.hostname)) continue;
      return url.toString();
    } catch { continue; }
  }
  return null;
}

function creativeSpec(plan: Row, pageId: string, instagramId: string | null, imageHash: string | null, video: { id: string; thumb: string } | null, leadLink: string | null = null) {
  const dest = plan.adset.destination;
  // Formularios: a Meta exige link externo (site do anunciante), nunca a Pagina.
  const link = dest.type === "LEAD_FORM" ? (leadLink || `https://www.facebook.com/${pageId}`) :
    dest.type === "SITE" && dest.url ? dest.url : "https://api.whatsapp.com/send";
  const cta: Row = { type: plan.ad.cta };
  if (dest.type === "WHATSAPP") cta.type = "WHATSAPP_MESSAGE";
  if (dest.type === "LEAD_FORM" && dest.lead_form_id) {
    cta.type = "SIGN_UP";
    cta.value = { lead_gen_form_id: dest.lead_form_id };
  } else if (dest.type !== "LEAD_FORM") {
    cta.value = { link };
  }
  const spec: Row = { page_id: pageId };
  if (instagramId) spec.instagram_user_id = instagramId;
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

// --- Feed x Story -----------------------------------------------------------
// A producao entrega cada variacao em dois formatos (feed 1:1/4:5 e story 9:16).
// Cada par vira UM anuncio com personalizacao de posicionamento (asset_feed_spec),
// em vez de dois anuncios separados.

/** Largura/altura reais lidas do arquivo (PNG, JPEG com EXIF, WebP, GIF, MP4/MOV). */
function mediaDimensions(bytes: Uint8Array, kind: string): { width: number; height: number } | null {
  const n = bytes.length;
  const u16 = (o: number) => (bytes[o] << 8) | bytes[o + 1];
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const s32 = (o: number) => (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
  const ascii = (o: number, len: number) => String.fromCharCode(...bytes.subarray(o, o + len));
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 20000 && h < 20000 ? { width: w, height: h } : null);
  if (kind === "IMAGE") {
    if (n > 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return ok(u32(16), u32(20));
    if (n > 10 && ascii(0, 3) === "GIF") return ok(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8));
    if (n > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      const chunk = ascii(12, 4);
      if (chunk === "VP8X") return ok(1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)));
      if (chunk === "VP8 ") return ok((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
      if (chunk === "VP8L") return ok(1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)));
      return null;
    }
    if (n > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let o = 2, rotate = false;
      while (o + 9 < n) {
        if (bytes[o] !== 0xff) { o++; continue; }
        const marker = bytes[o + 1];
        if (marker === 0xff) { o++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
        const len = u16(o + 2);
        if (marker === 0xe1 && ascii(o + 4, 4) === "Exif") {
          const t = o + 10, le = ascii(t, 2) === "II";
          const r16 = (p: number) => le ? bytes[p] | (bytes[p + 1] << 8) : u16(p);
          const r32 = (p: number) => le ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0 : u32(p);
          const ifd = t + r32(t + 4), count = ifd + 2 < n ? r16(ifd) : 0;
          for (let i = 0; i < count && ifd + 2 + i * 12 + 10 < n; i++) {
            const e = ifd + 2 + i * 12;
            if (r16(e) === 0x0112) { rotate = r16(e + 8) >= 5 && r16(e + 8) <= 8; break; }
          }
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = u16(o + 5), w = u16(o + 7);
          return rotate ? ok(h, w) : ok(w, h);
        }
        if (len < 2) return null;
        o += 2 + len;
      }
    }
    return null;
  }
  // MP4/MOV: maior trilha de video em 'tkhd' (respeitando rotacao da matriz).
  let best: { width: number; height: number } | null = null;
  for (let i = 4; i + 100 < n; i++) {
    if (bytes[i] !== 0x74 || bytes[i + 1] !== 0x6b || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue;
    const start = i - 4, version = bytes[i + 4];
    if (version > 1) continue;
    const wOff = start + (version === 1 ? 96 : 84);
    if (wOff + 8 > n) continue;
    let w = Math.round(u32(wOff) / 65536), h = Math.round(u32(wOff + 4) / 65536);
    const a = s32(wOff - 36), b = s32(wOff - 32);
    if (Math.abs(b) > Math.abs(a)) [w, h] = [h, w];
    const dims = ok(w, h);
    if (dims && (!best || dims.width * dims.height > best.width * best.height)) best = dims;
  }
  return best;
}

/** FEED (1:1, 4:5, paisagem) ou STORY (9:16). Sem dimensao, usa pistas do nome do arquivo. */
function creativeOrientation(item: { width?: unknown; height?: unknown; file_name?: unknown }): "FEED" | "STORY" | null {
  const w = Number(item?.width), h = Number(item?.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h <= 0.7 ? "STORY" : "FEED";
  const name = String(item?.file_name || "").toLowerCase();
  if (/(stor(y|ies)|reels?|vertical|9\s*[x:×_-]\s*16|1080\s*[x×]\s*1920)/.test(name)) return "STORY";
  if (/(feed|quadrad|square|4\s*[x:×_-]\s*5|1\s*[x:×_-]\s*1(?!\d)|1080\s*[x×]\s*(1350|1080))/.test(name)) return "FEED";
  return null;
}

/** Nome da variacao sem extensao, medidas e palavras de formato. "Criativo 1 - Story.mp4" -> "criativo 1". */
function creativeBaseName(name: unknown): string {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/\d{3,4}\s*[x×]\s*\d{3,4}/g, " ")
    .replace(/(^|[^0-9])(9\s*[x:×_-]\s*16|4\s*[x:×_-]\s*5|1\s*[x:×_-]\s*1|16\s*[x:×_-]\s*9)(?![0-9])/g, "$1 ")
    .replace(/stories|story|reels?|vertical|feed|quadrado|square|copia|copy/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Agrupa os criativos em unidades de anuncio. Um par = feed + story do mesmo tipo
 * (imagem com imagem, video com video). Prioridade: (1) mesmo nome de variacao;
 * (2) pares sugeridos pela IA de visao (hints), so se o formato real confirmar.
 * Nunca pareia "no chute" pela ordem de envio. O que sobrar vira anuncio unico.
 */
function pairCreatives(items: Array<{ type?: unknown; file_name?: unknown; orientation?: unknown }>,
  hints: Array<{ feed: number; story: number }> = []): Array<{ feed?: number; story?: number; single?: number; via?: string }> {
  const units: Array<{ feed?: number; story?: number; single?: number; via?: string; order: number }> = [];
  const used = new Set<number>();
  for (const kind of ["IMAGE", "VIDEO"]) {
    const feeds = items.map((it, i) => ({ it, i })).filter(({ it }) => it?.type === kind && it?.orientation === "FEED").map(({ i }) => i);
    const stories = items.map((it, i) => ({ it, i })).filter(({ it }) => it?.type === kind && it?.orientation === "STORY").map(({ i }) => i);
    for (const s of stories) {
      const base = creativeBaseName(items[s]?.file_name);
      if (!base) continue;
      const f = feeds.find((idx) => !used.has(idx) && creativeBaseName(items[idx]?.file_name) === base);
      if (f === undefined) continue;
      used.add(f); used.add(s);
      units.push({ feed: f, story: s, via: "NAME", order: Math.min(f, s) });
    }
  }
  for (const h of hints || []) {
    const f = Number(h?.feed), s = Number(h?.story);
    if (!Number.isInteger(f) || !Number.isInteger(s) || f === s || used.has(f) || used.has(s)) continue;
    if (!items[f] || !items[s] || items[f].type !== items[s].type) continue;
    if (items[f].orientation !== "FEED" || items[s].orientation !== "STORY") continue;
    used.add(f); used.add(s);
    units.push({ feed: f, story: s, via: "AI", order: Math.min(f, s) });
  }
  items.forEach((_, i) => { if (!used.has(i)) units.push({ single: i, order: i }); });
  return units.sort((a, b) => a.order - b.order).map(({ order: _order, ...unit }) => unit);
}

/** Feeds e stories de imagem que o nome nao conseguiu parear (candidatos para a IA). */
function unpairedForVision(items: Array<{ type?: unknown; file_name?: unknown; orientation?: unknown }>) {
  const units = pairCreatives(items);
  const singles = units.filter((u) => u.single !== undefined).map((u) => u.single!);
  const feeds = singles.filter((i) => items[i]?.type === "IMAGE" && items[i]?.orientation === "FEED");
  const stories = singles.filter((i) => items[i]?.type === "IMAGE" && items[i]?.orientation === "STORY");
  // Com um unico feed e um unico story a IA nao tem com o que comparar e tende a forcar o par
  // (testado com variacoes que so trocam a ordem das fotos). Nesse caso nao pareia.
  return feeds.length >= 2 && stories.length >= 2 ? { feeds, stories } : null;
}

/** Valida a resposta da IA: so pares 1 para 1, com confianca alta, entre candidatos validos. */
function parseVisionPairs(raw: unknown, feeds: number[], stories: number[]) {
  const out: Array<{ feed: number; story: number; confidence: number }> = [];
  const usedF = new Set<number>(), usedS = new Set<number>();
  const pairs = Array.isArray((raw as any)?.pairs) ? (raw as any).pairs : [];
  for (const p of pairs) {
    const fi = Number(String(p?.feed || "").replace(/\D/g, "")) - 1;
    const si = Number(String(p?.story || "").replace(/\D/g, "")) - 1;
    const confidence = Number(p?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.9) continue;
    const f = feeds[fi], s = stories[si];
    if (f === undefined || s === undefined || usedF.has(f) || usedS.has(s)) continue;
    usedF.add(f); usedS.add(s);
    out.push({ feed: f, story: s, confidence: Math.round(confidence * 100) / 100 });
  }
  return out;
}

/** Interseccao das duas leituras da IA: mesmo feed com o mesmo story, confianca minima. */
function agreedVisionPairs(a: Array<{ feed: number; story: number; confidence: number }>, b: Array<{ feed: number; story: number; confidence: number }>) {
  return a.filter((x) => b.some((y) => y.feed === x.feed && y.story === x.story))
    .map((x) => ({ feed: x.feed, story: x.story, confidence: Math.min(x.confidence, b.find((y) => y.feed === x.feed && y.story === x.story)!.confidence) }));
}

/** Converte os pares salvos no rascunho (por caminho do arquivo) em indices da lista atual. */
function hintsFromStored(items: Array<{ path?: unknown }>, stored: unknown) {
  const list = Array.isArray(stored) ? stored : [];
  const index = new Map(items.map((it, i) => [String(it?.path || ""), i]));
  return list.map((h: any) => ({ feed: index.get(String(h?.feed_path || "")), story: index.get(String(h?.story_path || "")) }))
    .filter((h) => h.feed !== undefined && h.story !== undefined) as Array<{ feed: number; story: number }>;
}

/** Criativo unico com versao feed e versao story (Personalizacao de posicionamento da Meta). */
function placementCreativeSpec(plan: Row, pageId: string, instagramId: string,
  feed: { hash?: string | null; video?: { id: string; thumb: string } | null },
  story: { hash?: string | null; video?: { id: string; thumb: string } | null },
  leadLink: string | null, labelPrefix: string) {
  const dest = plan.adset.destination;
  const link = dest.type === "LEAD_FORM" ? (leadLink || `https://www.facebook.com/${pageId}`) :
    dest.type === "SITE" && dest.url ? dest.url : "https://api.whatsapp.com/send";
  const feedLabel = `${labelPrefix}_feed`, storyLabel = `${labelPrefix}_story`;
  const isVideo = Boolean(feed.video && story.video);
  const spec: Row = {
    bodies: [{ text: plan.ad.primary_text }],
    titles: [{ text: plan.ad.headline }],
    link_urls: [{ website_url: link }],
    ad_formats: [isVideo ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
    optimization_type: "PLACEMENT",
    asset_customization_rules: [
      { priority: 1, [isVideo ? "video_label" : "image_label"]: { name: storyLabel },
        customization_spec: { publisher_platforms: ["facebook", "instagram", "messenger"],
          facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels", "ig_search"],
          messenger_positions: ["story"] } },
      // Regra "pega tudo" para os demais posicionamentos, igual ao Gerenciador. Com
      // publisher_platforms aqui a Meta conta 0 regras para feed/marketplace/etc. e o
      // anuncio NAO veicula nesses posicionamentos (validado na conta NC em 11/10/2026).
      { priority: 2, [isVideo ? "video_label" : "image_label"]: { name: feedLabel },
        customization_spec: { age_min: 13, age_max: 65 } },
    ],
  };
  if (plan.ad.description) spec.descriptions = [{ text: plan.ad.description }];
  if (isVideo) {
    spec.videos = [
      { video_id: feed.video!.id, thumbnail_url: feed.video!.thumb, adlabels: [{ name: feedLabel }] },
      { video_id: story.video!.id, thumbnail_url: story.video!.thumb, adlabels: [{ name: storyLabel }] },
    ];
  } else {
    spec.images = [{ hash: feed.hash, adlabels: [{ name: feedLabel }] }, { hash: story.hash, adlabels: [{ name: storyLabel }] }];
  }
  if (dest.type === "LEAD_FORM" && dest.lead_form_id) {
    spec.call_to_action_types = ["SIGN_UP"];
    spec.call_to_actions = [{ type: "SIGN_UP", value: { lead_gen_form_id: String(dest.lead_form_id) } }];
  } else if (dest.type === "WHATSAPP") {
    // Mesmo formato que o Gerenciador grava em anuncios de clique para WhatsApp com posicionamento.
    spec.call_to_action_types = ["WHATSAPP_MESSAGE"];
    spec.additional_data = { is_click_to_message: true };
  } else {
    spec.call_to_action_types = [plan.ad.cta || "LEARN_MORE"];
  }
  return { object_story_spec: { page_id: pageId, instagram_user_id: instagramId }, asset_feed_spec: spec };
}

/** Resumo para o preview: quantos anuncios e quais pares feed+story. */
function adUnitsSummary(items: Row[], hints: Array<{ feed: number; story: number }> = []) {
  // Rascunhos antigos nao tem medidas: arquivo sem pista no nome, com o mesmo nome
  // de variacao de um story/feed, e tratado como o formato complementar (so no preview;
  // na criacao as medidas reais do arquivo decidem).
  const known = items.map((it) => ({ ...it }));
  for (const it of known) {
    if (it.orientation) continue;
    const base = creativeBaseName(it.file_name);
    const twin = known.find((o) => o !== it && o.type === it.type && o.orientation && creativeBaseName(o.file_name) === base);
    if (base && twin) it.orientation = twin.orientation === "STORY" ? "FEED" : "STORY";
  }
  items = known;
  const units = pairCreatives(items, hints);
  return units.map((u) => u.single !== undefined
    ? { kind: "SINGLE", files: [items[u.single]?.file_name || null], orientation: items[u.single]?.orientation || null }
    : { kind: "FEED_STORY", via: u.via || "NAME", files: [items[u.feed!]?.file_name || null, items[u.story!]?.file_name || null] });
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
    const kind = isImage ? "IMAGE" : "VIDEO";
    let dims: { width: number; height: number } | null = null;
    try { dims = mediaDimensions(new Uint8Array(await file.arrayBuffer()), kind); } catch { dims = null; }
    const described = { type: kind, file_name: clean(file.name, 200), width: dims?.width ?? null, height: dims?.height ?? null };
    return reply({
      ok: true,
      creative: { bucket: BUCKET, path, ...described, orientation: creativeOrientation(described), preview_url: signed?.signedUrl || null },
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
    const diagnostics: Row[] = [];
    for (const candidate of tokens) {
      let page = false, account = false;
      let actor: Row | null = null;
      let granted: string[] = [];
      if (isAdler) {
        const [identity, permissions] = await Promise.allSettled([
          metaJson(graphUrl("me", { fields: "id,name", access_token: candidate.token })),
          metaJson(graphUrl("me/permissions", { access_token: candidate.token })),
        ]);
        if (identity.status === "fulfilled") {
          actor = { id: clean(identity.value?.id, 40), name: clean(identity.value?.name, 100) };
        }
        if (permissions.status === "fulfilled") {
          granted = (permissions.value?.data || []).filter((item:Row) => item.status === "granted")
            .map((item:Row) => clean(item.permission, 60));
        }
      }
      // Leitura da conta nao significa permissao para CRIAR anuncios.
      const adsWritable = await adsManagementGranted(candidate.token).catch(() => false);
      const [pageResult, accountResult] = await Promise.allSettled([
        pageId ? (async () => {
          const pageToken = await resolveNcPageToken(candidate.token, pageId);
          return await metaJson(graphUrl(`${pageId}/leadgen_forms`, {
            fields: "id", limit: "1", access_token: pageToken || candidate.token,
          }));
        })() : Promise.reject(new Error("Página não cadastrada")),
        accountId ? metaJson(graphUrl(`act_${accountId}`, {
          fields: "id,name", access_token: candidate.token,
        })) : Promise.reject(new Error("Conta de anúncio não cadastrada")),
      ]);
      if (pageResult.status === "fulfilled") page = pageAccess = true;
      else pageError = clean((pageResult.reason as Error)?.message,160);
      if (accountResult.status === "fulfilled" && adsWritable) account = accountAccess = true;
      else accountError = !adsWritable ? "Token sem permissao ads_management para criar campanhas." :
        clean((accountResult as PromiseRejectedResult).reason?.message,160);
      if (isAdler) diagnostics.push({
        source: candidate.source, actor, permissions: granted,
        page_access: page, account_access: account,
        ads_management_granted: adsWritable,
        page_error: pageResult.status === "rejected" ?
          clean((pageResult.reason as Error)?.message, 200) : null,
        page_code: pageResult.status === "rejected" ?
          ((pageResult.reason as any)?.metaCode ?? null) : null,
        account_error: !account ? accountError : null,
        account_code: accountResult.status === "rejected" ?
          ((accountResult.reason as any)?.metaCode ?? null) : null,
      });
      if (page && account) { sameToken = true; break; }
    }
    return reply({ ok: true, page_id: pageId, account_id: accountId,
      page_access: pageAccess, account_access: accountAccess,
      ready: sameToken, page_error: pageAccess ? null : pageError,
      account_error: accountAccess ? null : accountError,
      diagnostics: isAdler ? diagnostics : undefined });
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
        const pageToken = await resolveNcPageToken(candidate.token, assets.page_id);
        const forms = await metaJson(graphUrl(`${assets.page_id}/leadgen_forms`, {
          fields: "id,name,status,created_time",limit: "75",
          access_token: pageToken || candidate.token,
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
        // Resolve the exact Page token required by Meta for NC Imóveis.
        let pageToken = await resolveNcPageToken(candidate.token, pageId) || candidate.token;
        // Page token lookup can fail for system-user tokens, even if they can
        // publish a form. Let Meta check permissions at the actual POST.
        if (pageToken === candidate.token) {
          try {
            const page = await metaJson(graphUrl(pageId, {
              fields: "id,name,access_token", access_token: candidate.token,
            }));
            if (numericId(page?.id) !== pageId) continue;
            pageToken = clean(page?.access_token, 3000) || candidate.token;
          } catch { /* Meta decides access at the actual POST. */ }
        }
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
        .select("id,client_id,actor_person,actor_user_id,prompt,status,plan,plan_warnings,created_campaign_id,created_adset_id,created_ad_id,error,executed_at,created_at,expires_at,creative_type,creative_file_name,request_metadata")
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
    const { data: makeVaultKey } = await ops.rpc("get_secret", { p_name: "MAKE_API_TOKEN" });
    const makeReady = Boolean(
      clean(Deno.env.get("MAKE_API_TOKEN"), 4000) ||
      (typeof makeVaultKey === "string" && makeVaultKey.trim())
    ) && Number(Deno.env.get("MAKE_FB_LEADS_CONNECTION_ID")) > 0;
    return reply({
      ok: true,
      profile: { person, role, is_adler: isAdler },
      make_delivery_available: makeReady,
      planner_configured: plannerConfigured,
      clients: clientsOut,
      history: (history || []).map((h: Row) => {
        const { request_metadata, ...safe } = h;
        return { ...safe, client_name: nameById.get(h.client_id) || null,
          activation_verified_at: request_metadata?.activation_verified_at || null,
          make_delivery: request_metadata?.make_delivery
            ? { enabled: true, status: request_metadata.make_delivery.status,
                recipient: request_metadata.make_delivery.recipient,
                mode: request_metadata.make_delivery.mode || "SINGLE",
                recipients: request_metadata.make_delivery.recipients || [],
                scenario_id: request_metadata.make_delivery.scenario_id || null } : null,
          safe_retry_eligible: safeRetryEligible(h) };
      }),
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
    const dim = (value: unknown) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) && n > 0 && n < 20000 ? n : null;
    };
    const creatives: Row[] = inputs.map((item: Row) => {
      const described: Row = {
        bucket: clean(item?.bucket, 80) === BUCKET ? BUCKET : null,
        path: clean(item?.path, 300) || null,
        type: ["IMAGE", "VIDEO"].includes(clean(item?.type, 10)) ? clean(item.type, 10) : null,
        file_name: clean(item?.file_name, 200) || null,
        width: dim(item?.width),
        height: dim(item?.height),
      };
      described.orientation = creativeOrientation(described);
      return described;
    });
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

    // Pareamento feed + story: o nome tem prioridade; a IA de visao so entra para
    // as imagens que o nome nao conseguiu parear. Falha da IA nunca bloqueia o rascunho.
    let pairingHints: Array<{ feed: number; story: number; confidence?: number }> = [];
    let pairingAi: Row | null = null;
    if (!boostValid && creativeValid) {
      const pending = unpairedForVision(creatives);
      if (pending) {
        try {
          const sign = async (i: number) => (await db.storage.from(BUCKET).createSignedUrl(creatives[i].path, 900)).data?.signedUrl || "";
          const feedUrls = await Promise.all(pending.feeds.map(sign));
          const storyUrls = await Promise.all(pending.stories.map(sign));
          if (feedUrls.every(Boolean) && storyUrls.every(Boolean)) {
            // Duas leituras independentes, com as artes em ordens diferentes. So vale o par
            // que as duas leituras confirmarem (evita "par forcado" entre variacoes parecidas).
            const rev = <T,>(list: T[]) => [...list].reverse();
            const [first, second] = await Promise.all([
              visionPairCreatives(ops, feedUrls, storyUrls),
              visionPairCreatives(ops, rev(feedUrls), rev(storyUrls)),
            ]);
            const a = parseVisionPairs(first.result, pending.feeds, pending.stories);
            const b = parseVisionPairs(second.result, rev(pending.feeds), rev(pending.stories));
            pairingHints = agreedVisionPairs(a, b);
            pairingAi = { model: first.model, pairs: pairingHints, first: a, second: b, at: new Date().toISOString() };
          }
        } catch (err) {
          pairingAi = { error: clean((err as Error)?.message, 200), at: new Date().toISOString() };
        }
      }
    }
    const pairingStored = pairingHints.map((h) => ({ feed_path: creatives[h.feed].path, story_path: creatives[h.story].path, confidence: h.confidence ?? null }));
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
      request_metadata: { source: "CAMPAIGN_BUILDER_V2", input_mode: guided ? "GUIDED" : "PROMPT", mode: boostValid ? "BOOST" : "NEW", model: planned.model, instagram_id: assets.instagram_id, pixel_id: assets.pixel_id, geo_unresolved: geo.unresolved, creatives: !boostValid && creativeValid ? creatives : [], pairing_hints: pairingStored, pairing_ai: pairingAi },
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
      ad_units: !boostValid && creativeValid ? adUnitsSummary(creatives, pairingHints) : [],
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
    // Allow retry only when Meta provably created nothing (see safeRetryEligible):
    // Other FAILED jobs may have partially created Meta objects and must never
    // be silently resumed because that could duplicate paid campaigns.
    const recoverableFailure = safeRetryEligible(row);
    if (row.status !== "DRAFTED" && !recoverableFailure)
      return reply({ error: "request_not_resumable" }, 409);
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
      .update({
        expires_at: expiresAt,
        ...(recoverableFailure ? {
          status: "DRAFTED", error: null, executed_at: null,
          request_metadata: { ...(row.request_metadata || {}),
            safe_retry_count: Number(row.request_metadata?.safe_retry_count || 0) + 1,
            safe_retry_at: new Date().toISOString(),
            safe_retry_original_error: String(row.error || "").slice(0, 160),
          },
        } : {}),
      })
      .eq("id", requestId).eq("status", row.status)
      .select("id").maybeSingle();
    if (saveError) return reply({ error: "query_failed" }, 500);
    if (!renewed?.id) return reply({ error: "request_not_draft" }, 409);
    return reply({ ok: true, request_id: requestId, plan: row.plan, prompt: row.prompt,
      client: { id: clientRow.id, display_name: clientRow.display_name },
      mode: row.request_metadata?.mode === "BOOST" ? "BOOST" : "NEW",
      creatives, warnings: row.plan_warnings || [], expires_at: expiresAt,
      ad_units: row.request_metadata?.mode === "BOOST" ? [] : adUnitsSummary(creatives.map((c) => ({ ...c, orientation: c.orientation || creativeOrientation(c) })), hintsFromStored(creatives, row.request_metadata?.pairing_hints)),
      // Preserva o formulario selecionado no plano; nao troca pelo ultimo formulario criado incidentalmente.
      existing_form_id: numericId(row.plan?.adset?.destination?.lead_form_id) || numericId(row.request_metadata?.created_lead_form_id),
      resumed_failed_token_attempt: recoverableFailure,
      assets: { account_id: assets.account_id, page_id: assets.page_id,
        instagram_id: assets.instagram_id } });
  }

  // --- ACTIVATE_CREATED ---
  // O construtor cria os tres niveis PAUSADOS. Ativar somente a campanha
  // deixaria conjuntos/anuncios parados. Esta acao usa exclusivamente IDs
  // persistidos no pedido, confere o vinculo real na Meta e audita cada clique.
  if (action === "ACTIVATE_CREATED") {
    const requestId = clean(body?.request_id, 60);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return reply({ error: "request_required" }, 400);
    if (clean(body?.confirmation, 20).toUpperCase() !== "ATIVAR")
      return reply({ error: "activation_confirmation_required" }, 400);

    const { data: row, error: rowError } = await ops.from("campaign_build_requests")
      .select("*").eq("id", requestId).maybeSingle();
    if (rowError) return reply({ error: "query_failed" }, 500);
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id && !isAdler && role !== "MGMT")
      return reply({ error: "forbidden" }, 403);
    if (row.status !== "CREATED") return reply({ error: "campaign_not_created" }, 409);
    if (row.request_metadata?.make_delivery?.enabled &&
        row.request_metadata.make_delivery.status !== "READY") {
      return reply({ error: "make_delivery_not_ready" }, 409);
    }

    const { data: clientRow } = await ops.from("clients")
      .select("id,display_name,gt_owner,lifecycle").eq("id", row.client_id).maybeSingle();
    if (!clientRow || !inScope(clientRow)) return reply({ error: "forbidden" }, 403);
    if (clean(clientRow.lifecycle, 30).toUpperCase() === "CHURNED")
      return reply({ error: "client_churned" }, 409);

    const campaignId = numericId(row.created_campaign_id);
    const adsetId = numericId(row.created_adset_id);
    const accountId = numericId(row.meta_ad_account_id);
    const savedAds = Array.isArray(row.request_metadata?.created_ad_ids)
      ? row.request_metadata.created_ad_ids : [row.created_ad_id];
    const adIds = [...new Set(savedAds.map((value: unknown) => numericId(value)).filter(Boolean))] as string[];
    if (!campaignId || !adsetId || !accountId || !adIds.length ||
        adIds.length > MAX_CREATIVES || adIds.length !== savedAds.length ||
        (row.created_ad_id && !adIds.includes(numericId(row.created_ad_id))))
      return reply({ error: "activation_ids_missing" }, 409);

    // Bloquear ativacao de ativos que foram trocados de cliente/conta.
    const assets = await loadAssets(clientRow.id);
    if (assets.account_id !== accountId) return reply({ error: "assets_changed" }, 409);
    const expectedBudget = Math.round(Number(row.plan?.adset?.daily_budget_brl) * 100);
    if (!Number.isSafeInteger(expectedBudget) || expectedBudget <= 0)
      return reply({ error: "budget_missing" }, 409);

    const resolved = await resolveWriteToken(db, accountId);
    if ("error" in resolved) return reply({ error: resolved.error }, 403);
    if (clean(resolved.account?.currency).toUpperCase() !== "BRL")
      return reply({ error: "currency_mismatch" }, 409);
    if (Number(resolved.account?.account_status) !== 1)
      return reply({ error: "meta_account_not_active" }, 409);
    const token = resolved.candidate.token;
    const getStates = async () => {
      const [campaign, adset, ...ads] = await Promise.all([
        metaJson(graphUrl(campaignId, { fields: "id,name,account_id,status,effective_status", access_token: token })),
        metaJson(graphUrl(adsetId, { fields: "id,campaign_id,status,daily_budget,end_time", access_token: token })),
        ...adIds.map(id => metaJson(graphUrl(id, { fields: "id,adset_id,status", access_token: token }))),
      ]);
      return { campaign, adset, ads };
    };
    let before: Awaited<ReturnType<typeof getStates>>;
    try { before = await getStates(); }
    catch { return reply({ error: "meta_read_failed" }, 502); }

    const statesLinked = (snapshot: Awaited<ReturnType<typeof getStates>>) =>
      numericId(snapshot.campaign?.id) === campaignId &&
      numericId(snapshot.campaign?.account_id) === accountId &&
      numericId(snapshot.adset?.id) === adsetId &&
      numericId(snapshot.adset?.campaign_id) === campaignId &&
      snapshot.ads.every((ad: Row, i: number) => numericId(ad.id) === adIds[i] && numericId(ad.adset_id) === adsetId);
    const objectStates = (snapshot: Awaited<ReturnType<typeof getStates>>) =>
      [snapshot.campaign.status, snapshot.adset.status, ...snapshot.ads.map((ad: Row) => ad.status)]
        .map(status => clean(status, 25).toUpperCase());
    if (!statesLinked(before)) return reply({ error: "activation_link_mismatch" }, 409);
    // A ativacao da campanha pode liberar objetos adicionados depois no
    // Gerenciador. Nunca ativar estruturas que nao pertencam a este pedido.
    try {
      const [campaignSets, setAds] = await Promise.all([
        metaJson(graphUrl(`${campaignId}/adsets`, { fields: "id", limit: "100", access_token: token })),
        metaJson(graphUrl(`${adsetId}/ads`, { fields: "id", limit: "100", access_token: token })),
      ]);
      const liveAdsets = (campaignSets?.data || []).map((item: Row) => numericId(item.id));
      const liveAds = (setAds?.data || []).map((item: Row) => numericId(item.id));
      if (campaignSets?.paging?.next || setAds?.paging?.next ||
          liveAdsets.length !== 1 || liveAdsets[0] !== adsetId ||
          liveAds.length !== adIds.length || liveAds.some((id: string) => !adIds.includes(id)))
        return reply({ error: "activation_untracked_objects" }, 409);
    } catch {
      return reply({ error: "activation_structure_check_failed" }, 502);
    }
    if (objectStates(before).some(status => !["ACTIVE", "PAUSED"].includes(status)))
      return reply({ error: "campaign_state_not_toggleable" }, 409);
    if (Number(before.adset.daily_budget) !== expectedBudget)
      return reply({ error: "activation_budget_changed", budget_brl: Number(before.adset.daily_budget) / 100 }, 409);
    if (before.adset.end_time && Date.parse(before.adset.end_time) <= Date.now())
      return reply({ error: "activation_end_date_passed" }, 409);

    const beforeState = [
      { id: campaignId, kind: "CAMPAIGN", status: before.campaign.status },
      { id: adsetId, kind: "ADSET", status: before.adset.status },
      ...before.ads.map((ad: Row) => ({ id: ad.id, kind: "AD", status: ad.status })),
    ];
    const now = new Date().toISOString();
    const hash = await sha256(JSON.stringify({ user: user.id, requestId, beforeState, action: "ACTIVATE_CREATED" }));
    const { data: audit, error: auditError } = await ops.from("safe_action_requests").insert({
      actor_user_id: user.id, actor_person: person, actor_role: role,
      client_id: clientRow.id, action_type: "META_RESUME_CAMPAIGNS",
      target_ids: [campaignId, adsetId, ...adIds],
      preview_state: beforeState, preview_hash: hash, before_state: beforeState,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: "EXECUTING", confirmed_at: now,
      request_metadata: { source: "CAMPAIGN_BUILDER", request_id: requestId, account_id: accountId, expected_daily_budget_brl: expectedBudget / 100 },
    }).select("id").single();
    if (auditError || !audit?.id) return reply({ error: "audit_store_failed" }, 500);

    try {
      // Meta pode aceitar o POST e depois rejeitar a publicacao do anuncio.
      // Por isso todos os IDs e estados sao lidos novamente antes de confirmar.
      for (let i = 0; i < adIds.length; i++) {
        if (clean(before.ads[i].status).toUpperCase() !== "ACTIVE")
          await metaPost(adIds[i], token, { status: "ACTIVE" });
      }
      if (clean(before.adset.status).toUpperCase() !== "ACTIVE")
        await metaPost(adsetId, token, { status: "ACTIVE" });
      if (clean(before.campaign.status).toUpperCase() !== "ACTIVE")
        await metaPost(campaignId, token, { status: "ACTIVE" });

      const after = await getStates();
      if (!statesLinked(after) || objectStates(after).some(status => status !== "ACTIVE"))
        throw new Error("activation_verification_failed");
      const afterState = [
        { id: campaignId, kind: "CAMPAIGN", status: after.campaign.status, effective_status: after.campaign.effective_status },
        { id: adsetId, kind: "ADSET", status: after.adset.status },
        ...after.ads.map((ad: Row) => ({ id: ad.id, kind: "AD", status: ad.status })),
      ];
      const verifiedAt = new Date().toISOString();
      await ops.from("safe_action_requests").update({
        status: "VERIFIED", executed_at: verifiedAt, after_state: afterState,
        verification: { verified: true, verified_at: verifiedAt, configured_status: "ACTIVE" },
      }).eq("id", audit.id);
      await ops.from("campaign_build_requests").update({
        request_metadata: { ...(row.request_metadata || {}), activation_verified_at: verifiedAt, activation_audit_id: audit.id },
      }).eq("id", requestId).eq("status", "CREATED");
      await ops.from("meta_campaign_inventory").update({
        campaign_status: "ACTIVE", checked_at: verifiedAt,
      }).eq("client_id", clientRow.id).eq("campaign_id", campaignId);
      return reply({ ok: true, status: "VERIFIED", campaign_id: campaignId, adset_id: adsetId,
        ad_ids: adIds, audit_id: audit.id, verified_at: verifiedAt,
        note: "Status ACTIVE confirmado nos objetos. A entrega depende da revisao da Meta, saldo e configuracao da conta." });
    } catch (error) {
      // Pausar a campanha PRIMEIRO limita gasto durante recuperacao de falha parcial.
      // Depois restaura os estados originais dos conjuntos e anuncios.
      let rollbackOk = true;
      try { await metaPost(campaignId, token, { status: "PAUSED" }); } catch { rollbackOk = false; }
      for (const state of beforeState.filter(s => s.kind !== "CAMPAIGN")) {
        try { await metaPost(state.id, token, { status: state.status }); } catch { rollbackOk = false; }
      }
      // Nao restaurar uma campanha originalmente ativa se a restauracao dos
      // objetos filhos falhou: o fail-safe e mantê-la PAUSADA.
      if (rollbackOk) {
        try { await metaPost(campaignId, token, { status: before.campaign.status }); }
        catch { rollbackOk = false; }
      }
      try {
        const restored = await getStates();
        rollbackOk = rollbackOk && statesLinked(restored) &&
          objectStates(restored).every((state, i) => state === objectStates(before)[i]);
      } catch { rollbackOk = false; }
      await ops.from("safe_action_requests").update({
        status: rollbackOk ? "ROLLED_BACK" : "FAILED",
        executed_at: new Date().toISOString(),
        error: clean((error as Error)?.message, 380),
        verification: { verified: false, rollback_attempted: true, rollback_ok: rollbackOk },
      }).eq("id", audit.id);
      return reply({ error: "activation_failed", detail: clean((error as Error)?.message, 180),
        rollback_ok: rollbackOk, audit_id: audit.id }, 502);
    }
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

  // --- CONFIGURE_MAKE_DELIVERY ---
  // Only a CREATED, PAUSED campaign with a previously selected recipient may
  // provision Make. Fail closed; never pretend that a missing connection worked.
  if (action === "CONFIGURE_MAKE_DELIVERY") {
    const requestId = clean(body?.request_id, 60);
    const { data: row } = await ops.from("campaign_build_requests")
      .select("*").eq("id", requestId).maybeSingle();
    if (!row) return reply({ error: "request_not_found" }, 404);
    if (row.actor_user_id !== user.id && !isAdler && role !== "MGMT")
      return reply({ error: "forbidden" }, 403);
    if (row.status !== "CREATED") return reply({ error: "campaign_not_created" }, 409);
    const saved = row.request_metadata?.make_delivery;
    if (!saved?.enabled || !saved.recipient) return reply({ error: "make_delivery_not_requested" }, 409);
    if (saved.status === "READY" && saved.scenario_id)
      return reply({ ok: true, status: "READY", scenario_id: saved.scenario_id, reused: true });
    if (saved.scenario_id || saved.hook_id || saved.data_store_id)
      return reply({ error: "make_delivery_manual_recovery_required",
        scenario_id: saved.scenario_id || null }, 409);
    const { data: clientRow } = await ops.from("clients")
      .select("id,display_name,gt_owner,lifecycle").eq("id", row.client_id).maybeSingle();
    if (!clientRow || !inScope(clientRow) || clientRow.lifecycle === "CHURNED")
      return reply({ error: "forbidden" }, 403);
    const formId = numericId(row.plan?.adset?.destination?.lead_form_id);
    const pageId = numericId(row.meta_page_id);
    const assets = await loadAssets(row.client_id);
    if (!formId || !pageId || pageId !== numericId(assets.page_id) ||
        pageId !== numericId(saved.page_id) || formId !== numericId(saved.form_id))
      return reply({ error: "make_delivery_form_changed" }, 409);

    const { data: existingRows } = await ops.from("campaign_build_requests")
      .select("id,request_metadata").eq("client_id", row.client_id).eq("status", "CREATED")
      .neq("id", requestId).limit(100);
    const already = (existingRows || []).map((x: Row) => x.request_metadata?.make_delivery)
      .find((x: Row) => x?.status === "READY" && numericId(x.form_id) === formId &&
        numericId(x.page_id) === pageId);
    if (already) {
      if (already.recipient !== saved.recipient ||
          JSON.stringify(already.recipients || []) !== JSON.stringify(saved.recipients || []))
        return reply({ error: "make_delivery_form_already_routed" }, 409);
      const linked = { ...saved, status: "READY", scenario_id: already.scenario_id,
        hook_id: already.hook_id, reused: true, configured_at: new Date().toISOString() };
      await ops.from("campaign_build_requests").update({
        request_metadata: { ...row.request_metadata, make_delivery: linked },
      }).eq("id", requestId).eq("status", "CREATED");
      return reply({ ok: true, status: "READY", scenario_id: already.scenario_id, reused: true });
    }
    const { data: makeVaultKey } = await ops.rpc("get_secret", { p_name: "MAKE_API_TOKEN" });
    const makeToken = clean(Deno.env.get("MAKE_API_TOKEN"), 4000) ||
      (typeof makeVaultKey === "string" ? makeVaultKey.trim() : "");
    const facebookConnectionId = Number(Deno.env.get("MAKE_FB_LEADS_CONNECTION_ID") || 0);
    const zapiConnectionId = Number(Deno.env.get("MAKE_ZAPI_ADMIN_CONNECTION_ID") || 4651755);
    const teamId = Number(Deno.env.get("MAKE_TEAM_ID") || 600315);
    if (!makeToken || !Number.isInteger(facebookConnectionId) || facebookConnectionId <= 0)
      return reply({ error: "make_delivery_not_configured" }, 503);
    let lastFailure = "make_form_fields_unavailable";
    let candidateForm: Row | null = null;
    for (const tk of await tokenCandidates(db)) {
      try {
        const pt = await resolveNcPageToken(tk.token, pageId);
        const form = await metaJson(graphUrl(formId, {
          fields: "id,page_id,status,questions", access_token: pt || tk.token,
        }));
        if (numericId(form?.id) === formId && numericId(form?.page_id) === pageId &&
            clean(form?.status, 30).toUpperCase() === "ACTIVE") {
          candidateForm = form;
          break;
        }
      } catch (err) { lastFailure = clean((err as Error).message, 150); }
    }
    if (!candidateForm) return reply({ error: "make_delivery_form_unavailable", detail: lastFailure }, 409);
    const questions = (candidateForm.questions?.data || []) as Row[];
    if (!Array.isArray(questions) || questions.length < 3)
      return reply({ error: "make_form_questions_missing" }, 409);
    const mapped: LeadQuestion[] = questions.map((q: Row) => ({
      key: clean(q.key, 180), label: clean(q.label || q.key, 180),
      type: clean(q.type, 40),
    }));
    const lockedMetadata = { ...row.request_metadata, make_delivery:
      { ...saved, status: "PROVISIONING", started_at: new Date().toISOString() } };
    const { data: claimed, error: claimErr } = await ops.from("campaign_build_requests")
      .update({ request_metadata: lockedMetadata })
      .eq("id", requestId).eq("status", "CREATED")
      .filter("request_metadata->make_delivery->>status", "eq", saved.status)
      .select("id").maybeSingle();
    if (claimErr || !claimed?.id)
      return reply({ error: "make_delivery_already_processing" }, 409);
    row.request_metadata = lockedMetadata;
    try {
      const configured = await provisionMakeLeads({
        token: makeToken, teamId, facebookConnectionId, zapiConnectionId,
        requestId, pageId, formId, recipient: saved.recipient,
        clientName: clientRow.display_name, product: saved.product,
        recipients: saved.mode === "ROUND_ROBIN" ? saved.recipients : undefined,
        questions: mapped,
      });
      const next = { ...saved, status: "READY", scenario_id: configured.scenarioId,
        hook_id: configured.hookId, data_store_id: configured.dataStoreId || null,
        configured_at: new Date().toISOString() };
      const { error: saveErr } = await ops.from("campaign_build_requests")
        .update({ request_metadata: { ...row.request_metadata, make_delivery: next } })
        .eq("id", requestId).eq("status", "CREATED");
      if (saveErr) return reply({ error: "make_delivery_audit_failed",
        scenario_id: configured.scenarioId }, 502);
      return reply({ ok: true, status: "READY", scenario_id: configured.scenarioId,
        page_id: pageId, form_id: formId, recipient: saved.recipient });
    } catch (err) {
      const next = { ...saved, status: "ERROR",
        error: clean((err as Error).message, 140),
        failed_at: new Date().toISOString(),
        // IDs ficam preenchidos somente quando a limpeza automática falhou;
        // aí a retentativa pelo histórico exige conferência manual no Make.
        scenario_id: (err as any).scenarioId || null,
        hook_id: (err as any).hookId || null,
        data_store_id: (err as any).dataStoreId || null,
        cleanup: (err as any).cleanup || null };
      await ops.from("campaign_build_requests").update({
        request_metadata: { ...row.request_metadata, make_delivery: next },
      }).eq("id", requestId).eq("status", "CREATED");
      return reply({ error: "make_delivery_provision_failed", detail: next.error,
        scenario_id: next.scenario_id }, 502);
    }
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
    // Orçamento e formulario sao validados DEPOIS dos overrides do preview.

    // Overrides limitados vindos do preview (nomes, textos, orçamento)
    const overrides = body?.overrides && typeof body.overrides === "object" ? body.overrides : null;
    const deliveryEnabled = overrides?.make_delivery?.enabled === true;
    let makeRecipient = "";
    if (deliveryEnabled) {
      if (boostMode || plan.adset.destination.type !== "LEAD_FORM")
        return reply({ error: "make_delivery_requires_form" }, 409);
      if (clean(overrides.make_delivery.product, 110).length < 3)
        return reply({ error: "make_product_required" }, 400);
      try { makeRecipient = normalizeWhatsAppRecipient(overrides.make_delivery.recipient_phone); }
      catch { return reply({ error: "make_recipient_invalid" }, 400); }
      if (overrides.make_delivery.mode === "ROUND_ROBIN") {
        const candidates = overrides.make_delivery.recipients;
        if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 25)
          return reply({ error: "make_roleta_recipients_invalid" }, 400);
        try {
          const phones = candidates.map((r: Row) => normalizeWhatsAppRecipient(r.phone));
          if (phones.length !== new Set(phones).size ||
              candidates.some((r: Row) => clean(r.name, 80).length < 2))
            return reply({ error: "make_roleta_recipients_invalid" }, 400);
        } catch { return reply({ error: "make_roleta_recipients_invalid" }, 400); }
      }
      const { data: makeVaultKey } = await ops.rpc("get_secret", { p_name: "MAKE_API_TOKEN" });
      const hasToken = Boolean(clean(Deno.env.get("MAKE_API_TOKEN"), 4000) ||
        (typeof makeVaultKey === "string" && makeVaultKey.trim()));
      if (!hasToken || Number(Deno.env.get("MAKE_FB_LEADS_CONNECTION_ID")) <= 0)
        return reply({ error: "make_delivery_not_configured" }, 503);
    }
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
    // Validar o plano FINAL, depois de aplicar os ajustes do preview.
    const finalBudget = Number(plan.adset.daily_budget_brl);
    if (!Number.isFinite(finalBudget) || finalBudget < 1 || finalBudget > 100000)
      return reply({ error: "budget_missing" }, 409);
    if (!boostMode && plan.adset.destination.type === "SITE" && !plan.adset.destination.url) return reply({ error: "site_url_missing" }, 409);
    if (!boostMode && plan.adset.destination.type === "LEAD_FORM" && !numericId(plan.adset.destination.lead_form_id)) return reply({ error: "lead_form_missing" }, 409);
    // Fail-closed: o GT pediu cidades e nenhuma foi reconhecida pela Meta.
    // Sem este bloqueio o conjunto seria criado para o Brasil inteiro.
    const requestedCities = Array.isArray(plan.adset?.geo?.cities)
      ? plan.adset.geo.cities.map((c: unknown) => clean(c, 120)).filter(Boolean) : [];
    if (requestedCities.length && !(Array.isArray(plan.geo_resolved) && plan.geo_resolved.length))
      return reply({ error: "geo_unresolved", cities: requestedCities,
        detail: "Nenhuma das cidades informadas foi reconhecida pela Meta. Corrija as cidades (ex.: \"Caraguatatuba; São Sebastião\") e gere o plano de novo." }, 409);

    // Nunca consumir o rascunho por falta de acesso: o cliente pode liberar
    // a conta na Meta e clicar novamente, sem subir os criativos outra vez.
    const resolved = await resolveWriteToken(db, accountId);
    if ("error" in resolved && resolved.error)
      return reply({ error: resolved.error, account_id: accountId,
        detail: "A credencial Meta precisa ter ads_management e acesso a esta conta de anuncios." }, 403);

    const account = (resolved as any).account as Row;
    if (Number(account?.account_status) !== 1)
      return reply({ error: "meta_account_not_active", account_id: accountId }, 409);
    if (clean(account?.currency, 8).toUpperCase() !== "BRL")
      return reply({ error: "currency_mismatch", account_currency: clean(account?.currency, 8) }, 409);
    // Verifica formulario e propriedade ANTES de criar a campanha na Meta.
    let leadLink: string | null = null;
    if (!boostMode && plan.adset.destination.type === "LEAD_FORM") {
      const formId = numericId(plan.adset.destination.lead_form_id);
      const accessToken = (resolved as any).candidate.token as string;
      let liveForm: Row | null = null;
      let formError: unknown = null;
      try {
        liveForm = await metaJson(graphUrl(formId, {
          fields: "id,page_id,status", access_token: accessToken,
        }));
      } catch (err) {
        formError = err;
        // Tokens de sistema podem ler a conta mas precisar do token de pagina
        // para validar formularios instantaneos.
        try {
          const pageToken = await resolveNcPageToken(accessToken, pageId);
          if (pageToken) liveForm = await metaJson(graphUrl(formId, {
            fields: "id,page_id,status", access_token: pageToken,
          }));
        } catch (pageError) { formError = pageError; }
      }
      if (!liveForm)
        return reply({ error: "lead_form_read_denied",
          detail: clean((formError as Error)?.message, 190),
          meta_code: (formError as any)?.metaCode ?? null }, 403);
      if (numericId(liveForm.id) !== formId || numericId(liveForm.page_id) !== pageId)
        return reply({ error: "lead_form_page_mismatch", page_id: pageId, form_id: formId }, 409);
      if (clean(liveForm.status, 30).toUpperCase() !== "ACTIVE")
        return reply({ error: "lead_form_not_active", status: clean(liveForm.status, 30) }, 409);
      // Link externo obrigatorio no criativo de formulario: override do preview
      // ou o site cadastrado na Pagina. Sem ele, nada e criado na Meta.
      let pageWebsite: unknown = null;
      try {
        pageWebsite = (await metaJson(graphUrl(pageId, { fields: "website", access_token: accessToken })))?.website;
      } catch { pageWebsite = null; }
      leadLink = externalLeadLink(clean(overrides?.site_url, 500)) || externalLeadLink(pageWebsite);
      if (!leadLink)
        return reply({ error: "lead_form_external_link_missing",
          detail: "Anúncios de formulário precisam de um link externo (site do cliente). Cadastre o site na Página ou informe a URL do site no preview." }, 409);
    }

    // Compare-and-set: somente UM clique pode reivindicar o pedido.
    // Impede POSTs simultaneos de criarem campanhas duplicadas.
    const { data: claimed, error: claimError } = await ops.from("campaign_build_requests")
      .update({ status: "EXECUTING", overrides, executed_at: new Date().toISOString() })
      .eq("id", requestId).eq("status", "DRAFTED").select("id").maybeSingle();
    if (claimError) return reply({ error: "query_failed" }, 500);
    if (!claimed?.id) return reply({ error: "request_already_executed" }, 409);

    const fail = async (stage: string, error: unknown, created: Row) => {
      const message = clean((error as Error)?.message || error, 500);
      const metaCode = (error as any)?.metaCode ?? null;
      const metaSubcode = (error as any)?.metaSubcode ?? null;
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
      const rollbackIncomplete = (rollback.ads || []).some((item: Row) => !item.deleted) ||
        (rollback.creatives || []).some((item: Row) => !item.deleted) ||
        (Boolean(created.adset_id) && rollback.adset !== true) ||
        (Boolean(created.campaign_id) && rollback.campaign !== true);
      await ops.from("campaign_build_requests").update({
        status: "FAILED",
        error: `${stage}: ${message}`,
        created_campaign_id: rollbackIncomplete ? (created.campaign_id || null) : null,
        created_adset_id: rollbackIncomplete ? (created.adset_id || null) : null,
        created_ad_id: rollbackIncomplete ? (created.ad_ids?.[0] || null) : null,
        request_metadata: { ...(row.request_metadata || {}), rollback, failed_stage: stage,
          rollback_incomplete: rollbackIncomplete, meta_code: metaCode,
          meta_subcode: metaSubcode, created_ad_ids: created.ad_ids || [],
          created_creative_ids: created.creative_ids || [] },
      }).eq("id", requestId);
      return reply({ error: "execution_failed", stage, detail: message, request_id: requestId,
        meta_code: metaCode, meta_subcode: metaSubcode, rollback_incomplete: rollbackIncomplete }, 502);
    };

    const created: Row = {};
    let activeStage = "campaign_create";
    try {
      // Token ja validado antes de reivindicar o rascunho.
      const token = (resolved as any).candidate.token as string;
      created.token = token;

      // campanha
      const campaign = await metaPost(`act_${accountId}/campaigns`, token, campaignFields(plan));
      created.campaign_id = clean(campaign?.id, 40);
      if (!created.campaign_id) return await fail("campaign_create", new Error("Meta não devolveu o ID da campanha."), created);

      // conjunto
      activeStage = "adset_create";
      const targeting = buildTargeting(plan, plan.geo_resolved || []);
      const adset = await metaPost(`act_${accountId}/adsets`, token, adsetFields(plan, created.campaign_id, targeting, boostMode, pageId) as Record<string, string>);
      created.adset_id = clean(adset?.id, 40);
      if (!created.adset_id) return await fail("adset_create", new Error("Meta não devolveu o ID do conjunto."), created);

      // 1) Sobe todas as midias e mede o formato real (feed x story) de cada uma.
      // 2) Agrupa feed + story da mesma variacao em UM anuncio (personalizacao de
      //    posicionamento). Criativo sem par vira anuncio unico, como antes.
      created.ad_ids = [];
      created.creative_ids = [];
      created.video_ids = [];
      type UploadedMedia = { type: string; file_name: string; hash: string | null;
        video: { id: string; thumb: string } | null; orientation: "FEED" | "STORY" | null;
        width: number | null; height: number | null };
      const media: UploadedMedia[] = [];
      for (let index = 0; !boostMode && index < creativeRows.length; index++) {
        const item = creativeRows[index];
        activeStage = `creative_${index + 1}_upload`;
        const { data: fileData, error: downloadError } = await db.storage.from(item.bucket).download(item.path);
        if (downloadError || !fileData) return await fail(`creative_download_${index + 1}`, downloadError || new Error("empty_file"), created);
        let dims: { width: number; height: number } | null = null;
        try { dims = mediaDimensions(new Uint8Array(await fileData.arrayBuffer()), item.type); } catch { dims = null; }
        const width = dims?.width ?? (Number(item.width) || null);
        const height = dims?.height ?? (Number(item.height) || null);
        const entry: UploadedMedia = { type: item.type, file_name: item.file_name || "", hash: null, video: null,
          orientation: creativeOrientation({ width, height, file_name: item.file_name }), width, height };
        if (item.type === "IMAGE") {
          const form = new FormData();
          form.set("access_token", token);
          form.set("source", new File([fileData], item.file_name || "creative.jpg", { type: fileData.type || "image/jpeg" }));
          const uploaded = await metaJson(`https://graph.facebook.com/${GRAPH}/act_${accountId}/adimages`, { method: "POST", body: form });
          const images = uploaded?.images || {};
          entry.hash = images[Object.keys(images)[0]]?.hash || null;
          if (!entry.hash) return await fail(`image_upload_${index + 1}`, new Error("Meta não devolveu image_hash."), created);
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
          entry.video = { id: videoId, thumb };
        }
        media.push(entry);
      }

      const units: Array<{ feed?: number; story?: number; single?: number; via?: string }> = boostMode ? [{ single: -1 }] : pairCreatives(media, hintsFromStored(creativeRows, row.request_metadata?.pairing_hints));
      // A personalizacao feed/story exige a conta do Instagram no criativo.
      let placementInstagramId: string | null = instagramId;
      if (!boostMode && !placementInstagramId && units.some((u) => u.single === undefined)) {
        for (const tk of [token, await resolveNcPageToken(token, pageId).catch(() => null)]) {
          if (!tk || placementInstagramId) continue;
          try {
            const pageInfo = await metaJson(graphUrl(pageId, { fields: "instagram_business_account{id}", access_token: tk }));
            placementInstagramId = numericId(pageInfo?.instagram_business_account?.id) || null;
          } catch { /* sem Instagram vinculado */ }
        }
      }
      const placement: Row = { pairs: 0, pairs_by_ai: units.filter((x: Row) => x.via === "AI").length, fallbacks: [], instagram_id: placementInstagramId };

      const createCreativeAndAd = async (step: string, adName: string, creativeFields: Record<string, string>) => {
        activeStage = `creative_${step}_create`;
        const creative = await metaPost(`act_${accountId}/adcreatives`, token, creativeFields);
        const creativeId = clean(creative?.id, 40);
        if (!creativeId) throw new Error("Meta não devolveu o ID do criativo.");
        created.creative_ids.push(creativeId);
        activeStage = `ad_${step}_create`;
        const ad = await metaPost(`act_${accountId}/ads`, token, {
          name: adName,
          adset_id: created.adset_id,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
        });
        const adId = clean(ad?.id, 40);
        if (!adId) throw new Error("Meta não devolveu o ID do anúncio.");
        created.ad_ids.push(adId);
      };
      const singleFields = (adName: string, m: UploadedMedia): Record<string, string> => ({
        name: `${adName} — criativo`,
        object_story_spec: JSON.stringify(creativeSpec(plan, pageId, instagramId, m.hash, m.video, leadLink)),
      });

      for (let u = 0; u < units.length; u++) {
        const unit = units[u];
        const step = `${u + 1}`;
        const adName = (boostMode ? plan.ad.name : `${plan.ad.name} — ${u + 1}/${units.length}`).slice(0, 120);
        if (boostMode) {
          let creativeFields: Record<string, string>;
          if (plan.boost.source === "FACEBOOK") {
            creativeFields = { name: `${adName} — turbinar`, object_story_id: plan.boost.post_id };
          } else {
            const igFields: Row = { name: `${adName} — turbinar`, instagram_user_id: instagramId, source_instagram_media_id: plan.boost.post_id };
            if (pageId) igFields.object_id = pageId;
            creativeFields = igFields as Record<string, string>;
          }
          await createCreativeAndAd(step, adName, creativeFields);
          continue;
        }
        if (unit.single !== undefined) {
          await createCreativeAndAd(step, adName, singleFields(adName, media[unit.single]));
          continue;
        }
        const feed = media[unit.feed!], story = media[unit.story!];
        if (placementInstagramId) {
          const before = { creatives: created.creative_ids.length, ads: created.ad_ids.length };
          try {
            const label = `cb_${requestId.replace(/[^a-z0-9]/gi, "").slice(0, 10)}_${u + 1}`;
            const spec = placementCreativeSpec(plan, pageId, placementInstagramId, feed, story, leadLink, label);
            await createCreativeAndAd(step, adName, {
              name: `${adName} — feed + story`,
              object_story_spec: JSON.stringify(spec.object_story_spec),
              asset_feed_spec: JSON.stringify(spec.asset_feed_spec),
            });
            placement.pairs++;
            continue;
          } catch (err) {
            // Somente "parametro invalido" antes de existir anuncio cai no modo antigo.
            if (Number((err as any)?.metaCode) !== 100 || created.ad_ids.length > before.ads) throw err;
            while (created.creative_ids.length > before.creatives) {
              const orphan = created.creative_ids.pop();
              try { await metaDelete(String(orphan), token); } catch { /* removido no rollback se falhar depois */ created.creative_ids.push(orphan); break; }
            }
            placement.fallbacks.push({ unit: u + 1, reason: clean((err as Error)?.message, 160) });
          }
        } else {
          placement.fallbacks.push({ unit: u + 1, reason: "instagram_missing" });
        }
        await createCreativeAndAd(`${step}a`, `${adName} (feed)`.slice(0, 120), singleFields(`${adName} (feed)`, feed));
        await createCreativeAndAd(`${step}b`, `${adName} (story)`.slice(0, 120), singleFields(`${adName} (story)`, story));
      }
      created.ad_id = created.ad_ids[0] || null;
      created.creative_id = created.creative_ids[0] || null;

      // Verificar que TODAS as entidades existem, estao pausadas e vinculadas
      // aos IDs que acabamos de receber. A resposta do POST nao basta.
      activeStage = "verification";
      const live = await metaJson(graphUrl(created.campaign_id, { fields: "id,name,account_id,status,effective_status", access_token: token }));
      if (numericId(live?.id) !== numericId(created.campaign_id) ||
          numericId(live?.account_id) !== accountId ||
          clean(live?.status, 20).toUpperCase() !== "PAUSED") {
        return await fail("verification", new Error(`Campanha criada mas com status inesperado: ${live?.status}.`), created);
      }
      const adsetCheck = await metaJson(graphUrl(created.adset_id, {
        fields: "id,campaign_id,status", access_token: token,
      }));
      if (numericId(adsetCheck?.id) !== numericId(created.adset_id) ||
          numericId(adsetCheck?.campaign_id) !== numericId(created.campaign_id) ||
          clean(adsetCheck?.status, 20).toUpperCase() !== "PAUSED")
        return await fail("verification_adset", new Error("Conjunto nao confirmado na Meta."), created);
      for (const adId of created.ad_ids) {
        const adCheck = await metaJson(graphUrl(adId, { fields: "id,adset_id,status", access_token: token }));
        if (numericId(adCheck?.id) !== numericId(adId) ||
            numericId(adCheck?.adset_id) !== numericId(created.adset_id) ||
            clean(adCheck?.status, 20).toUpperCase() !== "PAUSED") {
          return await fail("verification_ads", new Error(`Anúncio ${adId} não está pausado.`), created);
        }
      }

      const { data: savedRequest, error: createdSaveError } = await ops.from("campaign_build_requests").update({
        status: "CREATED",
        created_campaign_id: created.campaign_id,
        created_adset_id: created.adset_id,
        created_creative_id: created.creative_id,
        created_ad_id: created.ad_id,
        error: null,
        plan,
        request_metadata: { ...successMetadata(row.request_metadata), token_source: (resolved as any).candidate.source, account_name: (resolved as any).account?.name || null, created_ad_ids: created.ad_ids, created_creative_ids: created.creative_ids, placement,
          ...(deliveryEnabled ? { make_delivery: { enabled: true, status: "PENDING", recipient: makeRecipient,
            mode: overrides?.make_delivery?.mode === "ROUND_ROBIN" ? "ROUND_ROBIN" : "SINGLE",
            product: clean(overrides?.make_delivery?.product, 110),
            recipients: overrides?.make_delivery?.mode === "ROUND_ROBIN" ? overrides.make_delivery.recipients.map((r: Row) => ({
              name: clean(r.name,80), phone: normalizeWhatsAppRecipient(r.phone),
            })) : [],
            page_id: pageId, form_id: numericId(plan.adset.destination.lead_form_id) } } : {}) },
      }).eq("id", requestId).eq("status", "EXECUTING").select("id").maybeSingle();
      if (createdSaveError || !savedRequest?.id) {
        // Os objetos existem na Meta, mas o registro nao confirmou: proibir
        // retry automatico para evitar uma segunda campanha.
        return reply({ error: "campaign_created_persistence_failed",
          request_id: requestId, campaign_id: created.campaign_id,
          adset_id: created.adset_id, ad_ids: created.ad_ids }, 502);
      }

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
        placement,
        make_delivery: deliveryEnabled ? { status: "PENDING", recipient: makeRecipient } : null,
        note: "Tudo criado PAUSADO. Revise no Gerenciador de Anúncios e ative por lá ou pela Central de Tráfego.",
      });
    } catch (error) {
      return await fail(activeStage, error, created);
    }
  }

  return reply({ error: "invalid_action" }, 400);
});
