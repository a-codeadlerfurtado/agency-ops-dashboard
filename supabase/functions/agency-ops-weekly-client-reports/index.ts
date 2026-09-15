import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Action = { action_type: string; value: string };

const JOB_NAME = "weekly_client_reports";
const GRAPH_VERSION = "v25.0";
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;
const BATCH_SIZE = 2;
const PREVIEW_BUCKET = "agency-meta-creative-previews";
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
let cachedSecret: string | null = null;

const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
const nullable = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const div = (a: number, b: number) => b > 0 ? a / b : null;
const pct = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
const shift = (day: string, delta: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
const dateOnly = (value: unknown) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value ?? "");
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw new Error(`invalid_report_date:${raw}`);
};

async function secret() {
  if (cachedSecret) return cachedSecret;
  const rows = await sql`select agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET') secret`;
  cachedSecret = rows.length ? String(rows[0].secret || "") : null;
  return cachedSecret;
}
function exact(actions: Action[] | undefined, type: string) {
  const row = (actions || []).find((item) => item.action_type.toLowerCase() === type.toLowerCase());
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? { value, source: row.action_type } : null;
}
function contains(actions: Action[] | undefined, needle: string) {
  let best: { value: number; source: string } | null = null;
  for (const row of (actions || []).filter((item) => item.action_type.toLowerCase().includes(needle.toLowerCase()))) {
    const value = Number(row.value);
    if (Number.isFinite(value) && (!best || value > best.value)) best = { value, source: row.action_type };
  }
  return best;
}
function canonical(adName: string | null, actions: Action[] | undefined) {
  const lead = exact(actions, "lead") ?? exact(actions, "onsite_conversion.lead_grouped") ?? exact(actions, "offsite_complete_registration_add_meta_leads");
  const message = contains(actions, "messaging_conversation_started") ?? contains(actions, "total_messaging_connection");
  const byName = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test(String(adName || "").toLowerCase());
  const useMessage = byName || (!lead && Boolean(message));
  const result = useMessage ? message : lead;
  return { results: result?.value ?? 0, result_type: result ? (useMessage ? "MENSAGEM" : "LEAD") : null };
}
async function graph(url: string, retries = 3): Promise<any> {
  let last = "Meta API error";
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (response.ok && body && !body.error) return body;
    last = String(body?.error?.message || `HTTP ${response.status}`).slice(0, 500);
    if (![429, 500, 502, 503, 504].includes(response.status) || i === retries - 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, i)));
  }
  throw new Error(last);
}
async function paged(url: string) {
  const rows: any[] = [];
  let next: string | null = url;
  while (next) {
    const body = await graph(next);
    rows.push(...(body.data || []));
    next = body.paging?.next || null;
    if (rows.length >= 1000) break;
  }
  return rows;
}


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

function extension(contentType: string) {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}
async function mirrorPreview(db: any, clientId: string, weekEnd: string, adId: string, urls: string[]) {
  for (const source of [...new Set(urls.map(String).filter(Boolean))]) {
    try {
      const response = await fetch(source, { redirect: "follow" });
      if (!response.ok) continue;
      const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) continue;
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_PREVIEW_BYTES) continue;
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > MAX_PREVIEW_BYTES) continue;
      const path = `weekly/${clientId}/${weekEnd}/${adId}.${extension(contentType)}`;
      const { error } = await db.storage.from(PREVIEW_BUCKET).upload(path, new Uint8Array(buffer), { contentType, cacheControl: "31536000", upsert: true });
      if (!error) return path;
    } catch { }
  }
  return null;
}

function previousFrom14(current: Row, fourteen: Row | null) {
  if (!fourteen) return null;
  const spend = Math.max(0, n(fourteen.spend) - n(current.spend));
  const results = Math.max(0, n(fourteen.results) - n(current.results));
  const impressions = Math.max(0, n(fourteen.impressions) - n(current.impressions));
  const clicks = Math.max(0, n(fourteen.clicks) - n(current.clicks));
  return { spend, results, impressions, clicks, ctr: impressions > 0 ? clicks / impressions * 100 : null, cpr: results > 0 ? spend / results : null };
}
function trend(current: number | null, previous: number | null) {
  const delta = pct(current, previous);
  return { current, previous, delta };
}
function campaignPrevious(current: Row, fourteen: Row | null) {
  if (!fourteen) return null;
  const spend = Math.max(0, n(fourteen.spend) - n(current.spend));
  const results = Math.max(0, n(fourteen.results) - n(current.results));
  const impressions = Math.max(0, n(fourteen.impressions) - n(current.impressions));
  const clicks = Math.max(0, n(fourteen.clicks) - n(current.clicks));
  return { spend, results, impressions, clicks, ctr: impressions > 0 ? clicks / impressions * 100 : null, cpr: results > 0 ? spend / results : null };
}

async function captureTopCreatives(db:any,clientId:string,weekStart:string,weekEnd:string,token:string,allowedCampaignIds:Set<string>){
  const integrations=await sql`select distinct meta_ad_account_id::text account_id from agency_ops.client_integrations where client_id=${clientId}::uuid and system='META_BM' and meta_ad_account_id is not null order by meta_ad_account_id`;const all:Row[]=[];
  for(const integration of integrations){const account=String(integration.account_id||"");if(!account)continue;const fields=["ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","spend","impressions","clicks","reach","frequency","actions"].join(",");const range=encodeURIComponent(JSON.stringify({since:weekStart,until:weekEnd}));const rows=await paged(`${GRAPH_ROOT}/act_${account}/insights?level=ad&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`);for(const row of rows){if(!allowedCampaignIds.has(String(row.campaign_id||"")))continue;const metric=canonical(row.ad_name||null,row.actions);const spend=n(row.spend),impressions=n(row.impressions),clicks=n(row.clicks),reach=n(row.reach);if(spend<=0&&impressions<=0&&metric.results<=0)continue;all.push({ad_id:String(row.ad_id||""),ad_name:row.ad_name||null,campaign_id:row.campaign_id||null,campaign_name:row.campaign_name||null,spend,results:metric.results,impressions,clicks,reach,ctr:impressions>0?clicks/impressions*100:null,frequency:nullable(row.frequency)??div(impressions,reach),cpr:metric.results>0?spend/metric.results:null,result_type:metric.result_type});}}
  if(!all.length)return[];const successful=all.filter((r)=>n(r.results)>0&&nullable(r.cpr)!==null).sort((a,b)=>n(a.cpr)-n(b.cpr));const medianCpr=successful.length?n(successful[Math.floor(successful.length/2)].cpr):0;const waste=all.filter((r)=>n(r.results)<=0&&n(r.spend)>=Math.max(20,medianCpr)).sort((a,b)=>n(b.spend)-n(a.spend))[0]||null;const ranked=[...all].filter((r)=>n(r.results)>0).sort((a,b)=>n(b.results)-n(a.results)||n(a.cpr)-n(b.cpr));const selected:Row[]=[];if(ranked[0])selected.push({...ranked[0],badge:"Destaque da semana",tone:"good"});const efficient=ranked.slice(1).sort((a,b)=>n(a.cpr)-n(b.cpr))[0];if(efficient)selected.push({...efficient,badge:"Boa eficiência",tone:"info"});if(waste&&!selected.some((r)=>r.ad_id===waste.ad_id))selected.push({...waste,badge:"Ponto de atenção",tone:"warn"});for(const row of ranked){if(selected.length>=3)break;if(!selected.some((x)=>x.ad_id===row.ad_id))selected.push({...row,badge:"Em destaque",tone:"info"});}
  for(const creative of selected.slice(0,3)){try{const ad=await graph(`${GRAPH_ROOT}/${creative.ad_id}?fields=${encodeURIComponent("id,name,status,effective_status,creative{id,name}")}&access_token=${encodeURIComponent(token)}`);const creativeId=String(ad?.creative?.id||"");let meta:Row=ad?.creative||{};if(creativeId)meta=await graph(`${GRAPH_ROOT}/${creativeId}?thumbnail_width=900&thumbnail_height=900&fields=${encodeURIComponent("id,name,thumbnail_url,image_url,effective_object_story_id")}&access_token=${encodeURIComponent(token)}`);creative.preview_storage_path=await mirrorPreview(db,clientId,weekEnd,creative.ad_id,[meta.thumbnail_url,meta.image_url]);creative.ad_status=ad?.effective_status||ad?.status||null;}catch{creative.preview_storage_path=null;}}
  return selected.slice(0,3);
}

function clientNarrative(current: Row, previous: Row | null, campaigns: Row[], creatives: Row[]) {
  const spend = n(current.spend), results = n(current.results), cpr = nullable(current.cost_per_result ?? current.cpl), ctr = nullable(current.ctr);
  const dResults = pct(results, previous?.results ?? null), dCpr = pct(cpr, previous?.cpr ?? null), dCtr = pct(ctr, previous?.ctr ?? null), dSpend = pct(spend, previous?.spend ?? null);
  let headline = "Semana de performance estável, com pontos claros para acompanhar.";
  if (dResults !== null && dCpr !== null && dResults >= 15 && dCpr <= -10) headline = "Semana de avanço: mais resultados com melhora de eficiência.";
  else if (dResults !== null && dCpr !== null && dResults <= -15 && dCpr >= 15) headline = "Semana de atenção: houve perda de volume e de eficiência.";
  else if (dResults !== null && dResults >= 15) headline = "A semana ganhou volume de resultados e pede acompanhamento da eficiência.";
  else if (dResults !== null && dResults <= -15) headline = "O volume caiu e o próximo ciclo deve atacar a principal fonte dessa perda.";

  const bestCampaign = [...campaigns].sort((a,b)=>n(b.results)-n(a.results) || n(a.cpr)-n(b.cpr))[0] || null;
  const attention = [...campaigns].filter((c)=>c.previous && ((pct(nullable(c.cpr), nullable(c.previous.cpr)) ?? 0) >= 30 || (pct(n(c.results), n(c.previous.results)) ?? 0) <= -30)).sort((a,b)=>n(b.spend)-n(a.spend))[0] || null;
  const bestCreative = creatives.find((c)=>c.tone === "good") || creatives[0] || null;
  const wasteCreative = creatives.find((c)=>c.tone === "warn") || null;

  const body = `Foram ${results.toLocaleString("pt-BR",{maximumFractionDigits:0})} resultados com R$ ${spend.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})} investidos${cpr !== null ? `, a R$ ${cpr.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})} por resultado` : ""}. ${bestCampaign ? `A campanha ${bestCampaign.campaign_name} concentrou o maior volume do período.` : ""}`.trim();
  const keyInsight = attention
    ? `O principal ponto de atenção está em ${attention.campaign_name}: a eficiência piorou em relação à semana anterior e merece revisão antes de ganhar mais verba.`
    : bestCampaign
      ? `${bestCampaign.campaign_name} foi o principal motor de resultado da semana e deve orientar as próximas decisões de mídia.`
      : "A leitura seguirá focada em preservar eficiência e estabilidade da entrega.";
  const actions: string[] = [];
  if (attention) actions.push(`Revisar ${attention.campaign_name} antes de ampliar investimento.`);
  if (bestCreative) actions.push(`Preservar o aprendizado do criativo ${bestCreative.ad_name || "de melhor desempenho"} nas próximas variações.`);
  if (wasteCreative) actions.push(`Reavaliar ${wasteCreative.ad_name || "o criativo em atenção"}, que consumiu verba sem retorno proporcional.`);
  actions.push("Acompanhar resultados, custo por resultado e CTR no próximo ciclo antes de escalar orçamento.");
  return { headline, body, key_insight: keyInsight, next_steps: actions.slice(0,4), deltas: { spend:dSpend, results:dResults, cpr:dCpr, ctr:dCtr } };
}

async function processReport(report:Row,token:string,db:any){
  const weekStart=dateOnly(report.week_start),weekEnd=dateOnly(report.week_end);
  const perf=await sql`select * from agency_ops.meta_performance_snapshots where run_id=${report.meta_run_id}::uuid and client_id=${report.client_id}::uuid and period_days in (7,14) order by period_days`;const base=perf.find((r:Row)=>Number(r.period_days)===7);
  const campaignRows=await sql`select * from agency_ops.meta_campaign_performance_snapshots where run_id=${report.meta_run_id}::uuid and client_id=${report.client_id}::uuid and period_days in (7,14)`;
  const seven=campaignRows.filter((r:Row)=>Number(r.period_days)===7&&n(r.spend)>0);const accountIds=[...new Set(seven.map((r:Row)=>String(r.meta_ad_account_id||"")).filter(Boolean))];await syncMetaCampaignCreationScope(String(report.client_id),accountIds,token);
  const decisions=new Map<string,any>();for(const row of seven){const key=String(row.campaign_id);if(!decisions.has(key))decisions.set(key,await campaignScopeDecision(String(report.client_id),String(row.meta_ad_account_id||""),key,String(row.campaign_name||key)));}
  const eligible=seven.filter((row:Row)=>decisions.get(String(row.campaign_id))?.include);const allowedIds=new Set(eligible.map((r:Row)=>String(r.campaign_id)));const excluded=seven.filter((r:Row)=>!allowedIds.has(String(r.campaign_id))).map((r:Row)=>({campaign_id:r.campaign_id,campaign_name:r.campaign_name,spend:n(r.spend),results:n(r.results),...(decisions.get(String(r.campaign_id))||{})}));
  const spend=eligible.reduce((s:number,r:Row)=>s+n(r.spend),0),results=eligible.reduce((s:number,r:Row)=>s+n(r.results),0),impressions=eligible.reduce((s:number,r:Row)=>s+n(r.impressions),0),clicks=eligible.reduce((s:number,r:Row)=>s+n(r.clicks),0),reach=eligible.reduce((s:number,r:Row)=>s+n(r.reach),0);
  if(!base||!eligible.length||spend<=0){return{status:"REVIEW_REQUIRED",snapshot:{version:2,client_name:report.client_name,week_start:weekStart,week_end:weekEnd,coverage:{status:"NO_AGENCY_MANAGED_DELIVERY"},ownership_scope:{mode:"AGENCY_ONLY",included_campaigns:[],excluded_campaigns:excluded},message:"Não houve entrega de campanha comprovadamente criada ou operada pela agência nesta semana."}};}
  const by14=new Map<string,Row>();for(const row of campaignRows.filter((r:Row)=>Number(r.period_days)===14))by14.set(String(row.campaign_id),row);
  const campaigns=eligible.map((row:Row)=>({campaign_id:row.campaign_id,campaign_name:row.campaign_name,campaign_status:row.campaign_status,objective:row.objective,spend:n(row.spend),results:n(row.results),impressions:n(row.impressions),clicks:n(row.clicks),reach:n(row.reach),ctr:nullable(row.ctr),cpr:nullable(row.cost_per_result??row.cpl),frequency:nullable(row.frequency),previous:campaignPrevious(row,by14.get(String(row.campaign_id))||null),ownership:decisions.get(String(row.campaign_id))||null})).sort((a:Row,b:Row)=>n(b.results)-n(a.results)||n(b.spend)-n(a.spend)).slice(0,8);
  const previousPieces=campaigns.map((r:Row)=>r.previous).filter(Boolean);const previousSpend=previousPieces.reduce((s:number,r:Row)=>s+n(r.spend),0),previousResults=previousPieces.reduce((s:number,r:Row)=>s+n(r.results),0),previousImpressions=previousPieces.reduce((s:number,r:Row)=>s+n(r.impressions),0),previousClicks=previousPieces.reduce((s:number,r:Row)=>s+n(r.clicks),0);const previous={spend:previousSpend,results:previousResults,impressions:previousImpressions,clicks:previousClicks,ctr:previousImpressions>0?previousClicks/previousImpressions*100:null,cpr:div(previousSpend,previousResults)};
  const current={spend,results,impressions,reach,clicks,ctr:impressions>0?clicks/impressions*100:null,cpr:div(spend,results),frequency:div(impressions,reach),active_campaigns:eligible.filter((r:Row)=>String(r.campaign_status||"").toUpperCase()==="ACTIVE").length};const creatives=await captureTopCreatives(db,String(report.client_id),weekStart,weekEnd,token,allowedIds);const narrative=clientNarrative(current,previous,campaigns,creatives);
  const snapshot={version:2,client_name:report.client_name,week_start:weekStart,week_end:weekEnd,generated_at:new Date().toISOString(),coverage:{data_status:base.data_status,requested_days:base.requested_period_days,available_days:base.available_period_days,is_partial:Boolean(base.is_partial_period),scope:"AGENCY_ONLY"},ownership_scope:{mode:"AGENCY_ONLY",included_campaigns:campaigns.map((r:Row)=>({campaign_id:r.campaign_id,campaign_name:r.campaign_name,ownership:r.ownership})),excluded_campaigns:excluded},current,previous,trends:{spend:trend(current.spend,previous.spend),results:trend(current.results,previous.results),cpr:trend(current.cpr,previous.cpr),ctr:trend(current.ctr,previous.ctr)},narrative,campaigns,creatives,disclaimer:"Este relatório considera somente campanhas com evidência de criação ou operação pela agência. Campanhas próprias do cliente sem atuação comprovada da equipe são excluídas."};return{status:"READY",snapshot};
}

async function invokeWork(metaRunId: string) {
  const s = await secret();
  if (!s) return;
  const promise = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/agency-ops-weekly-client-reports`, {
    method:"POST", headers:{"content-type":"application/json","x-meta-campaign-secret":s}, body:JSON.stringify({mode:"work",meta_run_id:metaRunId}),
  }).catch(()=>null);
  const runtime=(globalThis as any).EdgeRuntime;
  if(runtime?.waitUntil) runtime.waitUntil(promise); else await promise;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") return out({ok:true,service:JOB_NAME,version:2,batch_size:BATCH_SIZE});
  if (req.method !== "POST") return out({error:"method_not_allowed"},405);
  const s = await secret().catch(()=>null);
  if (!s || req.headers.get("x-meta-campaign-secret") !== s) return out({error:"unauthorized"},401);
  const body = await req.json().catch(()=>({}));
  const mode = String(body?.mode || "start").toLowerCase();
  const metaRunId = String(body?.meta_run_id || "").trim();
  if (!metaRunId) return out({error:"meta_run_id_required"},400);
  const token = Deno.env.get("META_SYSTEM_USER_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !supabaseUrl || !serviceRole) return out({error:"server_configuration"},500);
  const db = createClient(supabaseUrl, serviceRole, { auth:{persistSession:false,autoRefreshToken:false} });

  try {
    if (mode === "start") {
      const runs = await sql`select id::text,snapshot_date::text,window_end::text,status from agency_ops.meta_performance_runs where id=${metaRunId}::uuid limit 1`;
      if (!runs.length) return out({error:"meta_run_not_found"},404);
      if (!["COMPLETED","COMPLETED_WITH_ERRORS"].includes(String(runs[0].status))) return out({error:"meta_run_not_completed"},409);
      const weekEnd = String(runs[0].window_end), weekStart = shift(weekEnd,-6);
      await sql`
        insert into agency_ops.weekly_client_reports(meta_run_id,client_id,client_name,gt_owner,week_start,week_end,status,updated_at)
        select ${metaRunId}::uuid,p.client_id,p.client_name,p.gt_owner,${weekStart}::date,${weekEnd}::date,'PENDING',now()
        from agency_ops.meta_performance_snapshots p
        join agency_ops.clients c on c.id=p.client_id and c.lifecycle='ACTIVE'
        where p.run_id=${metaRunId}::uuid and p.period_days=7 and p.active_campaigns>0
        on conflict(client_id,week_end) do update set meta_run_id=excluded.meta_run_id,client_name=excluded.client_name,gt_owner=excluded.gt_owner,status=case when agency_ops.weekly_client_reports.status='READY' then agency_ops.weekly_client_reports.status else 'PENDING' end,updated_at=now()`;
      await sql`update agency_ops.weekly_client_reports set status='PENDING',locked_at=null,updated_at=now() where meta_run_id=${metaRunId}::uuid and status='RUNNING' and locked_at<now()-interval '20 minutes'`;
      const count = await sql`select count(*)::int total from agency_ops.weekly_client_reports where meta_run_id=${metaRunId}::uuid`;
      await invokeWork(metaRunId);
      return out({ok:true,mode:"start",meta_run_id:metaRunId,week_start:weekStart,week_end:weekEnd,queued:Number(count[0]?.total||0)});
    }

    if (mode === "work") {
      await sql`update agency_ops.weekly_client_reports set status='PENDING',locked_at=null,updated_at=now() where meta_run_id=${metaRunId}::uuid and status='RUNNING' and locked_at<now()-interval '20 minutes'`;
      const claimed = await sql`
        update agency_ops.weekly_client_reports r set status='RUNNING',attempts=r.attempts+1,locked_at=now(),updated_at=now()
        where r.id in (
          select id from agency_ops.weekly_client_reports where meta_run_id=${metaRunId}::uuid and (status='PENDING' or (status='ERROR' and attempts<3)) order by id limit ${BATCH_SIZE} for update skip locked
        ) returning r.*`;
      for (const report of claimed) {
        try {
          const result = await processReport(report, token, db);
          await sql`update agency_ops.weekly_client_reports set status=${result.status},snapshot=${sql.json(result.snapshot)},last_error=null,generated_at=now(),locked_at=null,updated_at=now() where id=${report.id}::uuid`;
        } catch (error) {
          await sql`update agency_ops.weekly_client_reports set status='ERROR',last_error=${String(error instanceof Error?error.message:error).slice(0,900)},locked_at=null,updated_at=now() where id=${report.id}::uuid`;
        }
      }
      const statsRows = await sql`select count(*)::int total,count(*) filter(where status='READY')::int ready,count(*) filter(where status='REVIEW_REQUIRED')::int review,count(*) filter(where status='ERROR' and attempts>=3)::int errors,count(*) filter(where status in ('PENDING','RUNNING') or(status='ERROR' and attempts<3))::int pending,max(week_end)::text week_end from agency_ops.weekly_client_reports where meta_run_id=${metaRunId}::uuid`;
      const stats = statsRows[0];
      if (Number(stats.pending||0) > 0) await invokeWork(metaRunId);
      else {
        const groups = await sql`select gt_owner,count(*) filter(where status='READY')::int ready,count(*) filter(where status='REVIEW_REQUIRED')::int review from agency_ops.weekly_client_reports where meta_run_id=${metaRunId}::uuid and gt_owner is not null group by gt_owner`;
        for (const g of groups) {
          const gt = String(g.gt_owner||""); if (!gt) continue;
          await sql`insert into agency_ops.platform_notifications(event_key,type,level,title,description,source,actor,occurred_at,metadata) values(${`weekly_reports:${stats.week_end}:${gt}`},'WEEKLY_CLIENT_REPORTS','INFO','Relatórios semanais prontos',${`${Number(g.ready||0)} relatório(s) pronto(s) para compartilhar${Number(g.review||0)>0?` · ${Number(g.review)} para revisar`:''}.`},'weekly_reports','Sistema',now(),${sql.json({private_to_person:true,target_person:gt,target_role:'GT',button_label:'Abrir relatórios',route:'/'})}) on conflict(event_key) do nothing`;
        }
        await sql`insert into agency_ops.job_runs(job_name,started_at,finished_at,status,events_processed,error,duration_ms) values(${JOB_NAME},now(),now(),${Number(stats.errors||0)>0?'ERROR':'SUCCESS'},${Number(stats.ready||0)+Number(stats.review||0)},${Number(stats.errors||0)>0?`${Number(stats.errors)} erro(s)`:null},0)`;
      }
      return out({ok:true,mode:"work",meta_run_id:metaRunId,claimed:claimed.length,...stats});
    }
    return out({error:"invalid_mode"},400);
  } catch (error) {
    return out({error:"weekly_report_worker_failed",detail:String(error instanceof Error?error.message:error).slice(0,1000)},500);
  }
});
