import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Action = { action_type: string; value: string };
type CanonicalResult = { results: number; result_type: string | null; result_source: string | null };

const GRAPH_VERSION = "v25.0";
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PREVIEW_BUCKET = "agency-meta-creative-previews";
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const BATCH_SIZE = 2;
const MAX_PERIOD_DAYS = 90;
const TZ = "America/Sao_Paulo";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
let cachedSecret: string | null = null;

const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const n = (value: unknown) => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
const nullable = (value: unknown) => { if (value === null || value === undefined || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const div = (a: number, b: number) => b > 0 ? a / b : null;
const pct = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (day: string, delta: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + delta); return date.toISOString().slice(0, 10); };
const inclusiveDays = (from: string, to: string) => Math.floor((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000) + 1;
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

async function secret() { if (cachedSecret) return cachedSecret; const rows = await sql`select agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET') secret`; cachedSecret = rows.length ? String(rows[0].secret || "") : null; return cachedSecret; }
function exact(actions: Action[] | undefined, type: string) { const row = (actions || []).find((item) => item.action_type.toLowerCase() === type.toLowerCase()); if (!row) return null; const value = Number(row.value); return Number.isFinite(value) ? { value, source: row.action_type } : null; }
function contains(actions: Action[] | undefined, needle: string) { let best: { value: number; source: string } | null = null; for (const row of (actions || []).filter((item) => item.action_type.toLowerCase().includes(needle.toLowerCase()))) { const value = Number(row.value); if (Number.isFinite(value) && (!best || value > best.value)) best = { value, source: row.action_type }; } return best; }
function canonical(name: string | null, actions: Action[] | undefined): CanonicalResult { const lead = exact(actions, "lead") ?? exact(actions, "onsite_conversion.lead_grouped") ?? exact(actions, "offsite_complete_registration_add_meta_leads"); const message = contains(actions, "messaging_conversation_started") ?? contains(actions, "total_messaging_connection"); const messageByName = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test(String(name || "").toLowerCase()); const useMessage = messageByName || (!lead && Boolean(message)); const result = useMessage ? message : lead; return { results: result?.value ?? 0, result_type: result ? (useMessage ? "MENSAGEM" : "LEAD") : null, result_source: result?.source ?? null }; }

async function graph(url: string, retries = 3): Promise<any> { let lastError = "Meta API error"; for (let attempt = 0; attempt < retries; attempt += 1) { const response = await fetch(url); const body = await response.json().catch(() => null); if (response.ok && body && !body.error) return body; lastError = String(body?.error?.message || `HTTP ${response.status}`).slice(0, 500); if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries - 1) break; await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt))); } throw new Error(lastError); }
async function paged(url: string) { const rows: any[] = []; let next: string | null = url; while (next) { const body = await graph(next); rows.push(...(body.data || [])); next = body.paging?.next || null; if (rows.length >= 1500) break; } return rows; }
async function accountInsight(account: string, token: string, from: string, to: string) { const fields = "spend,impressions,clicks,reach,frequency,actions"; const range = encodeURIComponent(JSON.stringify({ since: from, until: to })); const rows = await paged(`${GRAPH_ROOT}/act_${account}/insights?level=account&time_range=${range}&limit=50&fields=${fields}&access_token=${encodeURIComponent(token)}`); return rows[0] || null; }
async function campaignInventory(account: string, token: string) { const rows = await paged(`${GRAPH_ROOT}/act_${account}/campaigns?fields=id,name,status,objective&limit=500&access_token=${encodeURIComponent(token)}`); return new Map<string, Row>(rows.map((row: Row) => [String(row.id), row])); }
async function campaignInsights(account: string, token: string, from: string, to: string) { const fields = "campaign_id,campaign_name,spend,impressions,clicks,reach,frequency,actions"; const range = encodeURIComponent(JSON.stringify({ since: from, until: to })); return await paged(`${GRAPH_ROOT}/act_${account}/insights?level=campaign&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`); }
async function adInsights(account: string, token: string, from: string, to: string) { const fields = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,reach,frequency,actions"; const range = encodeURIComponent(JSON.stringify({ since: from, until: to })); return await paged(`${GRAPH_ROOT}/act_${account}/insights?level=ad&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`); }


function scopeNorm(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function activityExtra(value: unknown): Row {
  if (!value) return {};
  if (typeof value === "object") return value as Row;
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
async function syncMetaCampaignCreationScope(clientId: string, accountIds: string[], token: string) {
  try {
    const clients = await sql`select entrada::text as entrada from agency_ops.clients where id=${clientId}::uuid limit 1`;
    const entry = String(clients[0]?.entrada || "");
    if (!entry) return;
    const roster = await sql`select person from agency_ops.team_roster`;
    const aliases = await sql`select meta_actor_name,person from agency_ops.campaign_report_actor_aliases where active=true`;
    const agencyActors = new Map<string,string>();
    for (const row of roster) agencyActors.set(scopeNorm(row.person), String(row.person));
    for (const row of aliases) agencyActors.set(scopeNorm(row.meta_actor_name), String(row.person));
    const fields = encodeURIComponent("actor_id,actor_name,event_time,event_type,extra_data,object_id,object_name,object_type,translated_event_type");
    const since = encodeURIComponent(`${entry}T00:00:00+00:00`);
    const until = encodeURIComponent(new Date().toISOString());
    for (const accountId of [...new Set(accountIds.map(String).filter(Boolean))]) {
      let activities: Row[] = [];
      try { activities = await paged(`${GRAPH_ROOT}/act_${accountId}/activities?since=${since}&until=${until}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`); }
      catch { continue; }
      const best = new Map<string,Row>();
      for (const activity of activities) {
        const eventType = String(activity.event_type || "").toLowerCase();
        if (!eventType.startsWith("create_campaign")) continue;
        const extra = activityExtra(activity.extra_data);
        const campaignId = String(extra.campaign_id || (/campaign/i.test(String(activity.object_type || "")) ? activity.object_id : "") || "");
        if (!campaignId) continue;
        const actorRaw = String(activity.actor_name || "").trim();
        const actorPerson = agencyActors.get(scopeNorm(actorRaw)) || null;
        const candidate = { ...activity, campaign_id: campaignId, actor_raw: actorRaw, actor_person: actorPerson };
        const existing = best.get(campaignId);
        if (!existing || (actorPerson && !existing.actor_person)) best.set(campaignId, candidate);
      }
      for (const evidence of best.values()) {
        const isAgency = Boolean(evidence.actor_person);
        await sql`
insert into agency_ops.campaign_report_scope(
  client_id,account_id,campaign_id,campaign_name,ownership_status,include_in_reports,
  evidence_source,evidence_actor,evidence_event_type,evidence_at,evidence,last_checked_at,updated_at
) values (
  ${clientId}::uuid,${accountId},${String(evidence.campaign_id)},${String(evidence.object_name || "") || null},
  ${isAgency ? "AGENCY_CREATED" : "EXTERNAL"},${isAgency},'META_ACTIVITY',${String(evidence.actor_person || evidence.actor_raw || "") || null},
  ${String(evidence.event_type || "CREATE_CAMPAIGN")},${String(evidence.event_time || "") || null}::timestamptz,
  ${sql.json({ actor_id:evidence.actor_id || null, actor_name:evidence.actor_raw || null, object_id:evidence.object_id || null, object_type:evidence.object_type || null, translated_event_type:evidence.translated_event_type || null, extra_data:activityExtra(evidence.extra_data) })},now(),now()
)
on conflict(client_id,account_id,campaign_id) do update set
  campaign_name=coalesce(nullif(excluded.campaign_name,''),agency_ops.campaign_report_scope.campaign_name),
  ownership_status=case when agency_ops.campaign_report_scope.include_in_reports then agency_ops.campaign_report_scope.ownership_status else excluded.ownership_status end,
  include_in_reports=agency_ops.campaign_report_scope.include_in_reports or excluded.include_in_reports,
  evidence_source=case when excluded.include_in_reports or not agency_ops.campaign_report_scope.include_in_reports then excluded.evidence_source else agency_ops.campaign_report_scope.evidence_source end,
  evidence_actor=case when excluded.include_in_reports or not agency_ops.campaign_report_scope.include_in_reports then excluded.evidence_actor else agency_ops.campaign_report_scope.evidence_actor end,
  evidence_event_type=case when excluded.include_in_reports or not agency_ops.campaign_report_scope.include_in_reports then excluded.evidence_event_type else agency_ops.campaign_report_scope.evidence_event_type end,
  evidence_at=case when excluded.include_in_reports or not agency_ops.campaign_report_scope.include_in_reports then excluded.evidence_at else agency_ops.campaign_report_scope.evidence_at end,
  evidence=case when excluded.include_in_reports or not agency_ops.campaign_report_scope.include_in_reports then excluded.evidence else agency_ops.campaign_report_scope.evidence end,
  last_checked_at=now(),updated_at=now()
where not agency_ops.campaign_report_scope.manual_override`;
      }
    }
  } catch { /* ownership discovery is fail-closed; resolver keeps unknown campaigns out */ }
}
async function campaignScopeDecision(clientId: string, accountId: string, campaignId: string, campaignName: string) {
  const rows = await sql`select * from agency_ops.resolve_campaign_report_scope(${clientId}::uuid,${accountId},${campaignId},${campaignName})`;
  const row = rows[0] || {};
  return { include:Boolean(row.include_in_reports), ownership_status:String(row.ownership_status || "UNKNOWN"), evidence_source:row.evidence_source || null, evidence_actor:row.evidence_actor || null, evidence_event_type:row.evidence_event_type || null, evidence_at:row.evidence_at || null };
}


function previewExtension(contentType: string) { const type = contentType.toLowerCase().split(";")[0].trim(); if (type === "image/png") return "png"; if (type === "image/webp") return "webp"; if (type === "image/gif") return "gif"; return "jpg"; }
async function mirrorPreview(db: any, clientId: string, periodEnd: string, adId: string, sources: string[]) { for (const source of [...new Set(sources.map(String).filter(Boolean))]) { try { const response = await fetch(source, { redirect: "follow" }); if (!response.ok) continue; const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(); if (!contentType.startsWith("image/")) continue; const declared = Number(response.headers.get("content-length") || 0); if (declared > MAX_PREVIEW_BYTES) continue; const buffer = await response.arrayBuffer(); if (!buffer.byteLength || buffer.byteLength > MAX_PREVIEW_BYTES) continue; const path = `reports/${clientId}/${periodEnd}/${adId}.${previewExtension(contentType)}`; const { error } = await db.storage.from(PREVIEW_BUCKET).upload(path, new Uint8Array(buffer), { contentType, cacheControl: "31536000", upsert: true }); if (!error) return path; } catch {} } return null; }

function buildNarrative(current: Row, previous: Row | null, campaigns: Row[], creatives: Row[]) { const dResults = pct(nullable(current.results), nullable(previous?.results)); const dCpr = pct(nullable(current.cpr), nullable(previous?.cpr)); const dCtr = pct(nullable(current.ctr), nullable(previous?.ctr)); const dSpend = pct(nullable(current.spend), nullable(previous?.spend)); let headline = "Período estável, com pontos objetivos para acompanhar."; if (dResults !== null && dCpr !== null && dResults >= 15 && dCpr <= -10) headline = "O período avançou em volume e eficiência."; else if (dResults !== null && dCpr !== null && dResults <= -15 && dCpr >= 15) headline = "O período pede atenção: houve perda de volume e eficiência."; else if (dResults !== null && dResults >= 15) headline = "O período ganhou volume de resultados; agora é preciso preservar a eficiência."; else if (dResults !== null && dResults <= -15) headline = "O volume caiu e a próxima decisão deve atacar a principal fonte da perda."; const bestCampaign = [...campaigns].sort((a, b) => n(b.results) - n(a.results) || n(a.cpr) - n(b.cpr))[0] || null; const attention = [...campaigns].filter((campaign) => campaign.previous && ((pct(nullable(campaign.cpr), nullable(campaign.previous.cpr)) ?? 0) >= 30 || (pct(nullable(campaign.results), nullable(campaign.previous.results)) ?? 0) <= -30)).sort((a, b) => n(b.spend) - n(a.spend))[0] || null; const bestCreative = creatives.find((creative) => creative.tone === "good") || creatives[0] || null; const warningCreative = creatives.find((creative) => creative.tone === "warn") || null; const body = `Foram ${n(current.results).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} resultados com R$ ${n(current.spend).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} investidos${nullable(current.cpr) !== null ? `, a R$ ${n(current.cpr).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por resultado` : ""}. ${bestCampaign ? `A campanha ${bestCampaign.campaign_name} concentrou o maior volume do período.` : ""}`.trim(); const keyInsight = attention ? `O principal ponto de atenção está em ${attention.campaign_name}: a eficiência piorou em relação ao período anterior de mesma duração.` : bestCampaign ? `${bestCampaign.campaign_name} foi o principal motor de resultado do período.` : "A leitura permanece focada em eficiência e consistência da entrega."; const nextSteps: string[] = []; if (attention) nextSteps.push(`Revisar ${attention.campaign_name} antes de ampliar investimento.`); if (bestCreative) nextSteps.push(`Preservar o aprendizado do criativo ${bestCreative.ad_name || "de melhor desempenho"} nas próximas variações.`); if (warningCreative) nextSteps.push(`Reavaliar ${warningCreative.ad_name || "o criativo em atenção"} antes de concentrar mais verba.`); nextSteps.push("Acompanhar resultados, custo por resultado e CTR antes de escalar orçamento."); return { headline, body, key_insight: keyInsight, next_steps: nextSteps.slice(0, 4), deltas: { spend: dSpend, results: dResults, cpr: dCpr, ctr: dCtr } }; }

async function selectCreatives(db: any, clientId: string, periodEnd: string, ads: Row[], token: string) { const successful = ads.filter((row) => n(row.results) > 0 && nullable(row.cpr) !== null); const costs = successful.map((row) => n(row.cpr)).sort((a, b) => a - b); const medianCost = costs.length ? costs[Math.floor(costs.length / 2)] : 0; const ranked = [...successful].sort((a, b) => n(b.results) - n(a.results) || n(a.cpr) - n(b.cpr)); const waste = ads.filter((row) => n(row.results) <= 0 && n(row.spend) >= Math.max(20, medianCost)).sort((a, b) => n(b.spend) - n(a.spend))[0] || null; const selected: Row[] = []; if (ranked[0]) selected.push({ ...ranked[0], badge: "Destaque do período", tone: "good" }); const efficient = ranked.slice(1).sort((a, b) => n(a.cpr) - n(b.cpr))[0]; if (efficient) selected.push({ ...efficient, badge: "Boa eficiência", tone: "info" }); if (waste && !selected.some((row) => row.ad_id === waste.ad_id)) selected.push({ ...waste, badge: "Ponto de atenção", tone: "warn" }); for (const row of ranked) { if (selected.length >= 3) break; if (!selected.some((item) => item.ad_id === row.ad_id)) selected.push({ ...row, badge: "Em destaque", tone: "info" }); } for (const row of selected.slice(0, 3)) { try { const ad = await graph(`${GRAPH_ROOT}/${row.ad_id}?fields=${encodeURIComponent("id,name,status,effective_status,creative{id,name}")}&access_token=${encodeURIComponent(token)}`); const creativeId = String(ad?.creative?.id || ""); let creative: Row = ad?.creative || {}; if (creativeId) creative = await graph(`${GRAPH_ROOT}/${creativeId}?thumbnail_width=900&thumbnail_height=900&fields=${encodeURIComponent("id,name,thumbnail_url,image_url,effective_object_story_id")}&access_token=${encodeURIComponent(token)}`); row.preview_storage_path = await mirrorPreview(db, clientId, periodEnd, row.ad_id, [creative.thumbnail_url, creative.image_url]); row.ad_status = ad?.effective_status || ad?.status || null; } catch { row.preview_storage_path = null; } } return selected.slice(0, 3); }

async function collectClient(clientId: string, from: string, to: string, token: string, db: any) {
  const integrations = await sql`select distinct meta_ad_account_id::text account_id from agency_ops.client_integrations where client_id=${clientId}::uuid and system='META_BM' and meta_ad_account_id is not null order by meta_ad_account_id`;
  const accountIds = integrations.map((row) => String(row.account_id || "")).filter(Boolean);
  if (!accountIds.length) return { status:"REVIEW_REQUIRED", audit_status:"FAIL", snapshot:{ coverage:{status:"NO_META_ACCOUNT"}, audit:{status:"FAIL",reason:"NO_META_ACCOUNT"}, message:"Sem conta Meta reconciliada para este cliente." } };
  const periodDays=inclusiveDays(from,to), previousTo=shift(from,-1), previousFrom=shift(previousTo,-(periodDays-1)), partialCurrentDay=to===localDate();
  let accountSpend=0,accountImpressions=0,accountClicks=0;
  const campaigns:Row[]=[], previousCampaigns:Row[]=[], ads:Row[]=[], accountErrors:string[]=[];
  for (const accountId of accountIds) {
    try {
      const [inventory,currentAccount,currentCampaigns,previousRows,currentAds]=await Promise.all([campaignInventory(accountId,token),accountInsight(accountId,token,from,to),campaignInsights(accountId,token,from,to),campaignInsights(accountId,token,previousFrom,previousTo),adInsights(accountId,token,from,to)]);
      accountSpend+=n(currentAccount?.spend); accountImpressions+=n(currentAccount?.impressions); accountClicks+=n(currentAccount?.clicks);
      for(const row of currentCampaigns){const campaignId=String(row.campaign_id||"");if(!campaignId)continue;const meta=inventory.get(campaignId)||{};const result=canonical(row.campaign_name??meta.name??null,row.actions);const spend=n(row.spend),impressions=n(row.impressions),clicks=n(row.clicks),reach=n(row.reach);campaigns.push({account_id:accountId,campaign_id:campaignId,campaign_name:row.campaign_name??meta.name??campaignId,campaign_status:meta.status??null,objective:meta.objective??null,spend,results:result.results,impressions,clicks,reach,ctr:impressions>0?clicks/impressions*100:null,frequency:nullable(row.frequency)??div(impressions,reach),cpr:div(spend,result.results),result_type:result.result_type,result_source:result.result_source});}
      for(const row of previousRows){const campaignId=String(row.campaign_id||"");if(!campaignId)continue;const result=canonical(row.campaign_name||null,row.actions);const spend=n(row.spend),impressions=n(row.impressions),clicks=n(row.clicks),reach=n(row.reach);previousCampaigns.push({account_id:accountId,campaign_id:campaignId,campaign_name:row.campaign_name||campaignId,spend,results:result.results,impressions,clicks,reach,ctr:impressions>0?clicks/impressions*100:null,cpr:div(spend,result.results)});}
      for(const row of currentAds){const adId=String(row.ad_id||"");if(!adId)continue;const result=canonical(row.ad_name||null,row.actions);const spend=n(row.spend),impressions=n(row.impressions),clicks=n(row.clicks),reach=n(row.reach);if(spend<=0&&impressions<=0&&result.results<=0)continue;ads.push({account_id:accountId,ad_id:adId,ad_name:row.ad_name||adId,adset_id:row.adset_id||null,adset_name:row.adset_name||null,campaign_id:row.campaign_id||null,campaign_name:row.campaign_name||null,spend,results:result.results,impressions,clicks,reach,ctr:impressions>0?clicks/impressions*100:null,frequency:nullable(row.frequency)??div(impressions,reach),cpr:div(spend,result.results),result_type:result.result_type});}
    } catch(error){accountErrors.push(`${accountId}: ${String(error instanceof Error?error.message:error).slice(0,300)}`);}
  }
  if(accountErrors.length===accountIds.length)return {status:"REVIEW_REQUIRED",audit_status:"FAIL",snapshot:{coverage:{status:"API_ERROR",account_errors:accountErrors},audit:{status:"FAIL",reason:"ALL_ACCOUNTS_FAILED"},message:"A Meta não devolveu dados suficientes para gerar este relatório."}};

  await syncMetaCampaignCreationScope(clientId,accountIds,token);
  const decisions=new Map<string,any>();
  for(const campaign of campaigns){const key=`${campaign.account_id}:${campaign.campaign_id}`;if(!decisions.has(key))decisions.set(key,await campaignScopeDecision(clientId,String(campaign.account_id),String(campaign.campaign_id),String(campaign.campaign_name||campaign.campaign_id)));}
  const scopedCampaigns=campaigns.filter((row)=>decisions.get(`${row.account_id}:${row.campaign_id}`)?.include);
  const scopedIds=new Set(scopedCampaigns.map((row)=>`${row.account_id}:${row.campaign_id}`));
  const scopedPrevious=previousCampaigns.filter((row)=>scopedIds.has(`${row.account_id}:${row.campaign_id}`));
  const scopedAds=ads.filter((row)=>scopedIds.has(`${row.account_id}:${row.campaign_id}`));
  const excluded=campaigns.filter((row)=>!scopedIds.has(`${row.account_id}:${row.campaign_id}`)).map((row)=>({campaign_id:row.campaign_id,campaign_name:row.campaign_name,spend:row.spend,results:row.results,...(decisions.get(`${row.account_id}:${row.campaign_id}`)||{})}));
  const campaignSpend=scopedCampaigns.reduce((s,r)=>s+n(r.spend),0), campaignImpressions=scopedCampaigns.reduce((s,r)=>s+n(r.impressions),0), campaignClicks=scopedCampaigns.reduce((s,r)=>s+n(r.clicks),0), campaignReach=scopedCampaigns.reduce((s,r)=>s+n(r.reach),0), results=scopedCampaigns.reduce((s,r)=>s+n(r.results),0);
  if(campaignSpend<=0&&campaignImpressions<=0&&results<=0)return {status:"REVIEW_REQUIRED",audit_status:"PASS",snapshot:{version:4,period_start:from,period_end:to,coverage:{status:"NO_AGENCY_MANAGED_DELIVERY"},ownership_scope:{mode:"AGENCY_ONLY",included_campaigns:[],excluded_campaigns:excluded},message:"Não houve entrega de campanha comprovadamente criada ou operada pela agência neste período."}};

  const adSpend=scopedAds.reduce((s,r)=>s+n(r.spend),0),adImpressions=scopedAds.reduce((s,r)=>s+n(r.impressions),0),adClicks=scopedAds.reduce((s,r)=>s+n(r.clicks),0);
  const spendPass=Math.abs(campaignSpend-adSpend)<=0.10,impressionsPass=Math.abs(campaignImpressions-adImpressions)<=1,clicksPass=Math.abs(campaignClicks-adClicks)<=1,auditPass=spendPass&&impressionsPass&&clicksPass;
  const audit={status:auditPass?"PASS":"FAIL",source:"META_MARKETING_API_AGENCY_SCOPED",graph_api_version:GRAPH_VERSION,period:{from,to},previous_period:{from:previousFrom,to:previousTo},partial_current_day:partialCurrentDay,accounts:accountIds,account_count:accountIds.length,account_errors:accountErrors,scope:"AGENCY_ONLY",checks:{spend:{pass:spendPass,campaign_sum:campaignSpend,ad_sum:adSpend},impressions:{pass:impressionsPass,campaign_sum:campaignImpressions,ad_sum:adImpressions},clicks:{pass:clicksPass,campaign_sum:campaignClicks,ad_sum:adClicks}},account_reference:{spend:accountSpend,impressions:accountImpressions,clicks:accountClicks},excluded_spend:Math.max(0,accountSpend-campaignSpend),reach_aggregation:"SUM_ELIGIBLE_CAMPAIGN_RANGES",audited_at:new Date().toISOString()};
  const previousSpend=scopedPrevious.reduce((s,r)=>s+n(r.spend),0),previousResults=scopedPrevious.reduce((s,r)=>s+n(r.results),0),previousImpressions=scopedPrevious.reduce((s,r)=>s+n(r.impressions),0),previousClicks=scopedPrevious.reduce((s,r)=>s+n(r.clicks),0);
  const previous={spend:previousSpend,results:previousResults,impressions:previousImpressions,clicks:previousClicks,ctr:previousImpressions>0?previousClicks/previousImpressions*100:null,cpr:div(previousSpend,previousResults)};
  const previousMap=new Map(scopedPrevious.map((row)=>[`${row.account_id}:${row.campaign_id}`,row]));
  const finalCampaigns=scopedCampaigns.map((row)=>({...row,previous:previousMap.get(`${row.account_id}:${row.campaign_id}`)||null,ownership:decisions.get(`${row.account_id}:${row.campaign_id}`)||null})).sort((a,b)=>n(b.results)-n(a.results)||n(b.spend)-n(a.spend)).slice(0,8);
  const current={spend:campaignSpend,results,impressions:campaignImpressions,clicks:campaignClicks,reach:campaignReach,ctr:campaignImpressions>0?campaignClicks/campaignImpressions*100:null,cpr:div(campaignSpend,results),frequency:div(campaignImpressions,campaignReach),active_campaigns:scopedCampaigns.filter((row)=>String(row.campaign_status||"").toUpperCase()==="ACTIVE").length};
  const creatives=await selectCreatives(db,clientId,to,scopedAds,token),narrative=buildNarrative(current,previous,finalCampaigns,creatives);
  return {status:auditPass?"READY":"REVIEW_REQUIRED",audit_status:auditPass?"PASS":"FAIL",snapshot:{version:4,period_start:from,period_end:to,generated_at:new Date().toISOString(),partial_current_day:partialCurrentDay,coverage:{status:accountErrors.length?"API_PARTIAL":"OK",account_count:accountIds.length},provenance:{source:"META_MARKETING_API_AGENCY_SCOPED",graph_api_version:GRAPH_VERSION,account_ids:accountIds},ownership_scope:{mode:"AGENCY_ONLY",included_campaigns:finalCampaigns.map((row)=>({campaign_id:row.campaign_id,campaign_name:row.campaign_name,ownership:row.ownership})),excluded_campaigns:excluded},current,previous,trends:{spend:{current:current.spend,previous:previous.spend,delta:pct(current.spend,previous.spend)},results:{current:current.results,previous:previous.results,delta:pct(current.results,previous.results)},cpr:{current:current.cpr,previous:previous.cpr,delta:pct(current.cpr,previous.cpr)},ctr:{current:current.ctr,previous:previous.ctr,delta:pct(current.ctr,previous.ctr)}},narrative,campaigns:finalCampaigns,creatives,audit,disclaimer:partialCurrentDay?"Este relatório inclui o dia atual e considera somente campanhas com evidência de criação ou operação pela agência. Os dados são parciais até o momento da geração.":"Este relatório considera somente campanhas com evidência de criação ou operação pela agência. Campanhas próprias do cliente sem atuação comprovada da equipe são excluídas."}};
}

async function invokeWork(batchId: string) { const sharedSecret = await secret(); if (!sharedSecret) return; const promise = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/agency-ops-weekly-client-reports-custom`, { method: "POST", headers: { "content-type": "application/json", "x-meta-campaign-secret": sharedSecret }, body: JSON.stringify({ mode: "work", batch_id: batchId }) }).catch(() => null); const runtime = (globalThis as any).EdgeRuntime; if (runtime?.waitUntil) runtime.waitUntil(promise); else await promise; }

Deno.serve(async (req: Request) => {
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") return out({ ok: true, service: "weekly_client_reports_custom", version: 3, batch_size: BATCH_SIZE, max_period_days: MAX_PERIOD_DAYS, current_day_supported: true });
  if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  const sharedSecret = await secret().catch(() => null); if (!sharedSecret || req.headers.get("x-meta-campaign-secret") !== sharedSecret) return out({ error: "unauthorized" }, 401);
  const token = Deno.env.get("META_SYSTEM_USER_TOKEN"), supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (!token || !supabaseUrl || !serviceRole) return out({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } }), body = await req.json().catch(() => ({})), mode = String(body?.mode || "start").toLowerCase();
  try {
    if (mode === "start") {
      const from = String(body?.date_from || ""), to = String(body?.date_to || ""), scope = String(body?.scope_type || "ALL").toUpperCase(), scopeValue = String(body?.scope_value || "").trim(), requestedBy = String(body?.requested_by || "").trim();
      if (!isDate(from) || !isDate(to) || from > to) return out({ error: "invalid_period" }, 400); const periodDays = inclusiveDays(from, to); if (periodDays < 1 || periodDays > MAX_PERIOD_DAYS) return out({ error: "period_too_large", max_days: MAX_PERIOD_DAYS }, 400); if (to > localDate()) return out({ error: "period_cannot_be_future" }, 400); if (!["ALL", "GT", "CLIENT"].includes(scope)) return out({ error: "invalid_scope" }, 400); if ((scope === "GT" || scope === "CLIENT") && !scopeValue) return out({ error: "scope_value_required" }, 400);
      const partialCurrentDay = to === localDate();
      const batchRows = await sql`insert into agency_ops.weekly_report_batches(period_start,period_end,report_kind,generation_source,scope_type,scope_value,requested_by,automatic,status,metadata) values(${from}::date,${to}::date,'CUSTOM','META_DIRECT',${scope},${scopeValue || null},${requestedBy || null},false,'RUNNING',${sql.json({ period_days: periodDays, graph_api_version: GRAPH_VERSION, partial_current_day: partialCurrentDay })}) returning id::text`; const batchId = String(batchRows[0].id); let clients: Row[] = [];
      if (scope === "CLIENT") clients = await sql`select id::text,display_name,gt_owner from agency_ops.clients where lifecycle='ACTIVE' and id=${scopeValue}::uuid`; else if (scope === "GT") clients = await sql`select id::text,display_name,gt_owner from agency_ops.clients where lifecycle='ACTIVE' and gt_owner=${scopeValue} order by display_name`; else clients = await sql`select id::text,display_name,gt_owner from agency_ops.clients where lifecycle='ACTIVE' order by display_name`;
      for (const client of clients) { const versions = await sql`select coalesce(max(report_version),0)::int version from agency_ops.weekly_client_reports where client_id=${String(client.id)}::uuid and period_start=${from}::date and period_end=${to}::date`; const version = Number(versions[0]?.version || 0) + 1; await sql`insert into agency_ops.weekly_client_reports(meta_run_id,client_id,client_name,gt_owner,week_start,week_end,period_start,period_end,report_kind,generation_source,generation_batch_id,requested_by,requested_scope,report_version,status,audit_status,updated_at) values(null,${String(client.id)}::uuid,${String(client.display_name)},${client.gt_owner || null},${from}::date,${to}::date,${from}::date,${to}::date,'CUSTOM','META_DIRECT',${batchId}::uuid,${requestedBy || null},${scope},${version},'PENDING','NOT_RUN',now())`; }
      await sql`update agency_ops.weekly_report_batches set total_reports=${clients.length} where id=${batchId}::uuid`; if (clients.length) await invokeWork(batchId); else await sql`update agency_ops.weekly_report_batches set status='COMPLETED',finished_at=now() where id=${batchId}::uuid`; return out({ ok: true, batch_id: batchId, queued: clients.length, date_from: from, date_to: to, scope_type: scope, partial_current_day: partialCurrentDay });
    }
    if (mode === "work") {
      const batchId = String(body?.batch_id || "").trim(); if (!batchId) return out({ error: "batch_id_required" }, 400); await sql`update agency_ops.weekly_client_reports set status='PENDING',locked_at=null,updated_at=now() where generation_batch_id=${batchId}::uuid and status='RUNNING' and locked_at<now()-interval '20 minutes'`;
      const claimed = await sql`update agency_ops.weekly_client_reports r set status='RUNNING',attempts=r.attempts+1,locked_at=now(),updated_at=now() where r.id in (select id from agency_ops.weekly_client_reports where generation_batch_id=${batchId}::uuid and (status='PENDING' or (status='ERROR' and attempts<3)) order by id limit ${BATCH_SIZE} for update skip locked) returning r.id::text,r.client_id::text,r.client_name,r.gt_owner,r.period_start::text as period_start,r.period_end::text as period_end,r.attempts`;
      for (const report of claimed) { try { const result = await collectClient(String(report.client_id), String(report.period_start), String(report.period_end), token, db); await sql`update agency_ops.weekly_client_reports set status=${result.status},audit_status=${result.audit_status},snapshot=${sql.json(result.snapshot)},last_error=null,generated_at=now(),locked_at=null,updated_at=now() where id=${String(report.id)}::uuid`; } catch (error) { await sql`update agency_ops.weekly_client_reports set status='ERROR',audit_status='FAIL',last_error=${String(error instanceof Error ? error.message : error).slice(0, 900)},locked_at=null,updated_at=now() where id=${String(report.id)}::uuid`; } }
      const rows = await sql`select count(*)::int total,count(*) filter(where status='READY')::int ready,count(*) filter(where status='REVIEW_REQUIRED')::int review,count(*) filter(where status='ERROR' and attempts>=3)::int errors,count(*) filter(where status in('PENDING','RUNNING') or(status='ERROR' and attempts<3))::int pending from agency_ops.weekly_client_reports where generation_batch_id=${batchId}::uuid`; const stats = rows[0]; if (Number(stats.pending || 0) > 0) await invokeWork(batchId); else await sql`update agency_ops.weekly_report_batches set status=${Number(stats.errors || 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'},ready_reports=${Number(stats.ready || 0)},review_reports=${Number(stats.review || 0)},error_reports=${Number(stats.errors || 0)},finished_at=now() where id=${batchId}::uuid`; return out({ ok: true, batch_id: batchId, claimed: claimed.length, ...stats });
    }
    return out({ error: "invalid_mode" }, 400);
  } catch (error) { return out({ error: "custom_report_worker_failed", detail: String(error instanceof Error ? error.message : error).slice(0, 1000) }, 500); }
});
