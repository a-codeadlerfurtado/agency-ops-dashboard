import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const GRAPH_API_VERSION = "v21.0";
const JOB_NAME = "weekly_traffic_reports_monday";
const TZ = "America/Sao_Paulo";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
let cachedSecret: string | null = null;

type Action = { action_type: string; value: string };
type InsightRow = {
  campaign_id: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  actions?: Action[];
};

type Integration = { client_id: string; meta_ad_account_id: string; external_name: string | null };

async function getSecret() {
  if (cachedSecret) return cachedSecret;
  const rows = await sql`select value #>> '{}' as secret from agency_ops.automation_settings where key='META_CAMPAIGN_SYNC_SECRET'`;
  cachedSecret = rows.length ? String(rows[0].secret || "") : null;
  return cachedSecret;
}
function n(value: unknown) { const x = Number(value ?? 0); return Number.isFinite(x) ? x : 0; }
function exact(actions: Action[] | undefined, type: string) {
  const row = (actions ?? []).find((item) => item.action_type.toLowerCase() === type.toLowerCase());
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? { value, source: row.action_type } : null;
}
function contains(actions: Action[] | undefined, needle: string) {
  let best: { value: number; source: string } | null = null;
  for (const row of (actions ?? []).filter((item) => item.action_type.toLowerCase().includes(needle.toLowerCase()))) {
    const value = Number(row.value);
    if (Number.isFinite(value) && (!best || value > best.value)) best = { value, source: row.action_type };
  }
  return best;
}
function canonical(name: string | null, actions: Action[] | undefined) {
  const lead = exact(actions, "lead") ?? exact(actions, "onsite_conversion.lead_grouped") ?? exact(actions, "offsite_complete_registration_add_meta_leads");
  const message = contains(actions, "messaging_conversation_started") ?? contains(actions, "total_messaging_connection");
  const messagingByName = /(^|[^a-z])(wpp|whats|whatsapp|mensagem)([^a-z]|$)/i.test((name ?? "").toLowerCase());
  const useMessage = messagingByName || (!lead && !!message);
  const result = useMessage ? message : lead;
  return { leads: lead?.value ?? 0, result_count: result?.value ?? 0, result_type: result ? (useMessage ? "MENSAGEM" : "LEAD") : null, result_source: result?.source ?? null };
}
function ymdParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}
function iso(date: Date) { return date.toISOString().slice(0, 10); }
function shift(day: string, delta: number) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return iso(d); }
function latestSunday() {
  const p = ymdParts();
  const local = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = local.getUTCDay();
  const daysBack = dow === 0 ? 7 : dow;
  return iso(new Date(local.getTime() - daysBack * 86_400_000));
}
function ddmm(day: string) { const [,m,d] = day.split("-"); return `${d}/${m}`; }
function brNum(value: number) { return Math.round(value).toLocaleString("pt-BR"); }
function brMoney(value: number) { return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function codeFrom(metadata: any) {
  for (const value of [metadata?.weekly_report_code, metadata?.client_code, metadata?.account_code]) {
    const text = String(value || "").trim().toUpperCase();
    if (text && text.length <= 20) return text;
  }
  return null;
}
function objectiveLabel(row: any) {
  if (row.result_type === "MENSAGEM") return "GERAÇÃO DE CONVERSAS";
  if (row.result_type === "LEAD") return "GERAÇÃO DE LEADS";
  const objective = String(row.objective || "").toUpperCase();
  if (objective.includes("LEAD")) return "GERAÇÃO DE LEADS";
  if (objective.includes("MESSAGE") || objective.includes("ENGAGEMENT")) return "GERAÇÃO DE CONVERSAS";
  return objective ? objective.replace(/^OUTCOME_/, "").replaceAll("_", " ") : "META ADS";
}
function analysis(row: any, avgCpa: number | null) {
  const results = n(row.result_count), spend = n(row.spend), impressions = n(row.impressions);
  const cpa = results > 0 ? spend / results : null;
  const active = String(row.campaign_status || "").toUpperCase() === "ACTIVE";
  const noun = row.result_type === "MENSAGEM" ? "conversas" : "leads";
  if (results > 0 && cpa != null && avgCpa != null && cpa <= avgCpa * .8 && results >= 8) return `A campanha foi um dos destaques da conta, gerando ${brNum(results)} ${noun} com custo bastante competitivo. Os dados mostram boa eficiência na captação e bom aproveitamento do orçamento no período.`;
  if (results > 0 && cpa != null && avgCpa != null && cpa <= avgCpa) return `A campanha apresentou bom desempenho, gerando ${brNum(results)} ${noun} com custo dentro de um patamar saudável para a conta. Seguimos acompanhando para sustentar a eficiência e ampliar o volume.`;
  if (results > 0 && cpa != null && avgCpa != null && cpa > avgCpa * 1.25) return `A campanha gerou ${brNum(results)} ${noun}, porém com custo acima da média observada na conta nesta semana. Seguimos com otimizações para buscar mais eficiência sem perder volume de entrega.`;
  if (results > 0) return `A campanha manteve entrega consistente e gerou ${brNum(results)} ${noun} no período. Seguimos monitorando os indicadores e realizando otimizações para ampliar o volume mantendo a eficiência da captação.`;
  if (!active && (spend > 0 || impressions > 0)) return "A campanha teve entrega limitada e não registrou conversões no período. A estrutura aparece inativa/pausada no momento, interrompendo novos gastos.";
  if (active && spend > 0) return "A campanha teve entrega no período, mas ainda não registrou conversões. Seguimos acompanhando a distribuição e realizando ajustes para buscar geração de resultados.";
  return "A campanha não registrou conversões no período e apresentou volume reduzido de entrega. Seguimos acompanhando a estrutura para validar a necessidade de novos ajustes.";
}
function buildMessage(client: any, start: string, end: string, campaigns: any[]) {
  const code = codeFrom(client.metadata);
  const header = code ? `${code} — ${client.display_name}` : client.display_name;
  const spend = campaigns.reduce((sum,row)=>sum+n(row.spend),0);
  const results = campaigns.reduce((sum,row)=>sum+n(row.result_count),0);
  const avgCpa = results > 0 ? spend / results : null;
  const blocks = campaigns.map((row) => {
    const cpa = n(row.result_count) > 0 ? n(row.spend) / n(row.result_count) : null;
    return [
      `${row.campaign_name} – ${objectiveLabel(row)}`,
      `📈 Leads/Conversas: ${brNum(n(row.result_count))}`,
      `Valor usado: ${brMoney(n(row.spend))}`,
      `💰 CPA: ${cpa == null ? "Não calculado — sem conversões" : brMoney(cpa)}`,
      `Impressões: ${brNum(n(row.impressions))}`,
      `Alcance: ${brNum(n(row.reach))}`,
      "",
      `➡️ ${analysis(row, avgCpa)}`,
    ].join("\n");
  });
  return ["Bom dia, time! Ótima semana 🚀","",header,"",`Segue relatório de tráfego do dia ${ddmm(start)} a ${ddmm(end)}:`,"",blocks.length ? blocks.join("\n\n") : "Não houve entrega registrada nas campanhas Meta Ads durante o período."].join("\n");
}
async function fetchInsights(accountId: string, token: string, since: string, until: string) {
  const fields = ["campaign_id","campaign_name","spend","impressions","clicks","ctr","cpc","cpm","reach","frequency","actions"].join(",");
  const rows: InsightRow[] = [];
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  let url: string | null = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights?level=campaign&time_range=${range}&limit=500&fields=${fields}&access_token=${encodeURIComponent(token)}`;
  while (url) {
    const response = await fetch(url), body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    for (const row of body.data ?? []) rows.push(row as InsightRow);
    url = body.paging?.next ?? null;
  }
  return rows;
}
async function batches<T,R>(items:T[],size:number,fn:(item:T)=>Promise<R>){const out:R[]=[];for(let i=0;i<items.length;i+=size)out.push(...await Promise.all(items.slice(i,i+size).map(fn)));return out;}
async function logRun(started: Date, generated: number, error: string | null) {
  const finished = new Date();
  await sql`insert into agency_ops.job_runs(job_name,started_at,finished_at,status,events_processed,error,duration_ms) values(${JOB_NAME},${started.toISOString()},${finished.toISOString()},${error ? "ERROR" : "SUCCESS"},${generated},${error},${finished.getTime()-started.getTime()})`;
  if (error) await sql`insert into agency_ops.automation_health(job_name,last_error_at,last_error,updated_at) values(${JOB_NAME},now(),${error},now()) on conflict(job_name) do update set last_error_at=excluded.last_error_at,last_error=excluded.last_error,updated_at=now()`;
  else await sql`insert into agency_ops.automation_health(job_name,last_success_at,last_error,updated_at) values(${JOB_NAME},now(),null,now()) on conflict(job_name) do update set last_success_at=excluded.last_success_at,last_error=null,updated_at=now()`;
}

Deno.serve(async (req) => {
  const secret = await getSecret().catch(() => null);
  if (!secret || req.headers.get("x-meta-campaign-secret") !== secret) return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), { status:401, headers:{"content-type":"application/json"} });
  const token = Deno.env.get("META_SYSTEM_USER_TOKEN");
  if (!token) return new Response(JSON.stringify({ ok:false, error:"META_SYSTEM_USER_TOKEN ausente" }), { status:500, headers:{"content-type":"application/json"} });
  const started = new Date();
  try {
    const body = await req.json().catch(() => ({}));
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.week_end || "")) ? String(body.week_end) : latestSunday();
    const start = shift(end,-6);
    const clients = await sql`select id::text,display_name,gt_owner,metadata from agency_ops.clients where lifecycle='ACTIVE' order by display_name`;
    const integrations = await sql<Integration[]>`select client_id::text,meta_ad_account_id::text,external_name from agency_ops.client_integrations where system='META_BM' and meta_ad_account_id is not null`;
    const inventory = await sql`select client_id::text,campaign_id::text,campaign_name,campaign_status,objective from agency_ops.meta_campaign_inventory`;
    const inv = new Map<string,any>(); for (const row of inventory) inv.set(`${row.client_id}:${row.campaign_id}`,row);
    const accountResults = await batches(integrations,8,async (integration) => { try { return {ok:true,integration,rows:await fetchInsights(integration.meta_ad_account_id,token,start,end),error:null}; } catch(e){return {ok:false,integration,rows:[] as InsightRow[],error:String(e instanceof Error?e.message:e).slice(0,300)};} });
    const byClient = new Map<string,any[]>(), errors = new Map<string,string[]>();
    for (const result of accountResults) {
      const cid=String(result.integration.client_id);
      if(!result.ok){errors.set(cid,[...(errors.get(cid)||[]),String(result.error)]);continue;}
      for(const insight of result.rows){const metric=canonical(insight.campaign_name??null,insight.actions),meta=inv.get(`${cid}:${insight.campaign_id}`)||{};const row={campaign_id:insight.campaign_id,campaign_name:insight.campaign_name??meta.campaign_name??insight.campaign_id,campaign_status:meta.campaign_status??null,objective:meta.objective??null,spend:n(insight.spend),impressions:n(insight.impressions),clicks:n(insight.clicks),ctr:n(insight.ctr),cpc:n(insight.cpc),cpm:n(insight.cpm),reach:n(insight.reach),frequency:n(insight.frequency),leads:metric.leads,result_count:metric.result_count,result_type:metric.result_type,result_source:metric.result_source,cost_per_result:metric.result_count>0?n(insight.spend)/metric.result_count:null};if(row.spend>0||row.impressions>0||row.result_count>0)byClient.set(cid,[...(byClient.get(cid)||[]),row]);}
    }
    let generated=0;
    for(const client of clients){const cid=String(client.id),accounts=integrations.filter(row=>String(row.client_id)===cid),campaigns=(byClient.get(cid)||[]).sort((a,b)=>n(b.result_count)-n(a.result_count)||n(b.spend)-n(a.spend)||String(a.campaign_name).localeCompare(String(b.campaign_name),"pt-BR")),errs=errors.get(cid)||[];const summary={spend:Number(campaigns.reduce((s,r)=>s+n(r.spend),0).toFixed(2)),results:campaigns.reduce((s,r)=>s+n(r.result_count),0),leads:campaigns.reduce((s,r)=>s+n(r.leads),0),impressions:campaigns.reduce((s,r)=>s+n(r.impressions),0),reach_sum:campaigns.reduce((s,r)=>s+n(r.reach),0),clicks:campaigns.reduce((s,r)=>s+n(r.clicks),0),campaigns_with_delivery:campaigns.length,queried_accounts:accounts.length,account_errors:errs,graph_api_version:GRAPH_API_VERSION,source:"META_MARKETING_API_LIVE_WEEKLY"};let dataStatus="READY";if(!accounts.length)dataStatus="NO_META_ACCOUNT";else if(!campaigns.length&&errs.length>=accounts.length)dataStatus="ERROR";else if(errs.length)dataStatus="PARTIAL";else if(!campaigns.length)dataStatus="NO_ACTIVITY";const code=codeFrom(client.metadata),report=buildMessage(client,start,end,campaigns);await sql`insert into agency_ops.weekly_traffic_reports(client_id,week_start,week_end,client_name,client_code,gt_owner,report_text,campaigns,summary,data_status,generated_at,updated_at) values(${cid}::uuid,${start}::date,${end}::date,${client.display_name},${code},${client.gt_owner},${report},${sql.json(campaigns)},${sql.json(summary)},${dataStatus},now(),now()) on conflict(client_id,week_end) do update set week_start=excluded.week_start,client_name=excluded.client_name,client_code=excluded.client_code,gt_owner=excluded.gt_owner,report_text=excluded.report_text,campaigns=excluded.campaigns,summary=excluded.summary,data_status=excluded.data_status,generated_at=excluded.generated_at,updated_at=now()`;generated++;}
    await logRun(started,generated,null).catch(()=>{});
    return new Response(JSON.stringify({ok:true,week_start:start,week_end:end,generated,accounts:integrations.length}),{headers:{"content-type":"application/json"}});
  } catch (e) {
    const message=String(e instanceof Error?e.message:e).slice(0,1000);await logRun(started,0,message).catch(()=>{});return new Response(JSON.stringify({ok:false,error:message}),{status:500,headers:{"content-type":"application/json"}});
  }
});
