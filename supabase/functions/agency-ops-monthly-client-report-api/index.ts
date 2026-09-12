import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const TZ = "America/Sao_Paulo";
const EXPECTED_WEEKS = 4;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
const nullable = (v: unknown) => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const div = (a: number, b: number) => b > 0 ? a / b : null;
const pct = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
const isMonth = (v: string) => /^2026-(0[1-9]|1[0-2])$/.test(v);
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function monthBounds(key: string) {
  const [year, month] = key.split("-").map(Number);
  const start = `${key}-01`;
  const next = new Date(Date.UTC(year, month, 1));
  const end = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
  const prevDate = new Date(Date.UTC(year, month - 2, 1));
  const prevKey = prevDate.toISOString().slice(0, 7);
  const prevNext = new Date(Date.UTC(prevDate.getUTCFullYear(), prevDate.getUTCMonth() + 1, 1));
  const prevEnd = new Date(prevNext.getTime() - 86400000).toISOString().slice(0, 10);
  return { key, start, end, prevKey, prevStart: `${prevKey}-01`, prevEnd };
}
async function identify(req: Request, url: string, anon: string, service: string) {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data } = await auth.auth.getUser(); if (!data.user) return null;
  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", data.user.id).maybeSingle();
  const person = String(pref?.collaborator_person || "").trim(); if (!person) return null;
  const { data: roster } = await ops.from("team_roster").select("role,access_level,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster || !["GT","MGMT"].includes(String(roster.role))) return null;
  return { db, ops, person, role: String(roster.role), access: String(roster.access_level || "") };
}
const days = (a: string, b: string) => Math.floor((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000) + 1;
async function sourceWeeks(ops: any, clientId: string, start: string, end: string) {
  const { data, error } = await ops.from("weekly_client_reports")
    .select("id,period_start,period_end,week_start,week_end,report_kind,report_version,snapshot,generated_at")
    .eq("client_id", clientId).eq("status", "READY").eq("audit_status", "PASS")
    .gte("period_end", start).lte("period_end", end).order("period_end", { ascending: true });
  if (error) throw error;
  const rows = (data || []).filter((r: Row) => {
    const a = String(r.period_start || r.week_start || ""), b = String(r.period_end || r.week_end || "");
    return a && b && days(a, b) >= 5 && days(a, b) <= 8 && r.snapshot?.current;
  });
  const byPeriod = new Map<string, Row>();
  for (const row of rows) {
    const a = String(row.period_start || row.week_start), b = String(row.period_end || row.week_end), key = `${a}:${b}`;
    const old = byPeriod.get(key); const score = (row.report_kind === "WEEKLY" ? 1000 : 0) + n(row.report_version);
    const oldScore = old ? (old.report_kind === "WEEKLY" ? 1000 : 0) + n(old.report_version) : -1;
    if (!old || score >= oldScore) byPeriod.set(key, row);
  }
  const unique = [...byPeriod.values()].sort((a, b) => String(a.period_end || a.week_end).localeCompare(String(b.period_end || b.week_end)));
  const weekly = unique.filter((r) => r.report_kind === "WEEKLY");
  if (weekly.length >= EXPECTED_WEEKS) return weekly.slice(-EXPECTED_WEEKS);
  const chosen = [...weekly];
  for (const row of unique.filter((r) => r.report_kind !== "WEEKLY")) {
    const endKey = String(row.period_end || row.week_end); if (chosen.some((x) => String(x.period_end || x.week_end) === endKey)) continue;
    chosen.push(row); if (chosen.length >= EXPECTED_WEEKS) break;
  }
  return chosen.sort((a, b) => String(a.period_end || a.week_end).localeCompare(String(b.period_end || b.week_end)));
}
function aggregate(rows: Row[]) {
  const totals = rows.reduce((acc, row) => {
    const cur = row.snapshot?.current || {};
    acc.spend += n(cur.spend); acc.results += n(cur.results); acc.impressions += n(cur.impressions);
    acc.clicks += n(cur.clicks); acc.reach += n(cur.reach); return acc;
  }, { spend: 0, results: 0, impressions: 0, clicks: 0, reach: 0 });
  return { ...totals, cpr: div(totals.spend, totals.results), ctr: div(totals.clicks * 100, totals.impressions), frequency: div(totals.impressions, totals.reach) };
}
function trend(current: Row, previous: Row) {
  return {
    spend: { current: current.spend, previous: previous.spend, delta: pct(nullable(current.spend), nullable(previous.spend)) },
    results: { current: current.results, previous: previous.results, delta: pct(nullable(current.results), nullable(previous.results)) },
    cpr: { current: current.cpr, previous: previous.cpr, delta: pct(nullable(current.cpr), nullable(previous.cpr)) },
    ctr: { current: current.ctr, previous: previous.ctr, delta: pct(nullable(current.ctr), nullable(previous.ctr)) },
  };
}
function weekRows(rows: Row[]) {
  return rows.map((row, index) => {
    const cur = row.snapshot?.current || {}, before = index ? rows[index - 1].snapshot?.current || {} : null;
    return {
      index: index + 1, period_start: row.period_start || row.week_start, period_end: row.period_end || row.week_end,
      spend: n(cur.spend), results: n(cur.results), cpr: nullable(cur.cpr), ctr: nullable(cur.ctr),
      impressions: n(cur.impressions), clicks: n(cur.clicks), reach: n(cur.reach),
      vs_previous_week: before ? trend(cur, before) : null,
      headline: row.snapshot?.narrative?.headline || null, key_insight: row.snapshot?.narrative?.key_insight || null,
    };
  });
}
function aggregateCampaigns(rows: Row[], previousRows: Row[]) {
  const collect = (input: Row[]) => {
    const map = new Map<string, Row>();
    for (const report of input) for (const c of Array.isArray(report.snapshot?.campaigns) ? report.snapshot.campaigns : []) {
      const key = `${c.account_id || ""}:${c.campaign_id || c.campaign_name}`;
      const item = map.get(key) || { account_id:c.account_id||null,campaign_id:c.campaign_id||null,campaign_name:c.campaign_name||"Campanha",campaign_status:c.campaign_status||null,spend:0,results:0,impressions:0,clicks:0,reach:0 };
      item.spend += n(c.spend); item.results += n(c.results); item.impressions += n(c.impressions); item.clicks += n(c.clicks); item.reach += n(c.reach);
      item.campaign_status = c.campaign_status || item.campaign_status; map.set(key, item);
    }
    return map;
  };
  const current = collect(rows), previous = collect(previousRows);
  return [...current.entries()].map(([key, c]) => ({
    ...c, cpr: div(c.spend, c.results), ctr: div(c.clicks * 100, c.impressions),
    previous: previous.has(key) ? { ...previous.get(key), cpr: div(n(previous.get(key)?.spend), n(previous.get(key)?.results)), ctr: div(n(previous.get(key)?.clicks) * 100, n(previous.get(key)?.impressions)) } : null,
  })).sort((a,b) => n(b.results)-n(a.results) || n(b.spend)-n(a.spend)).slice(0,8);
}
function aggregateCreatives(rows: Row[]) {
  const map = new Map<string, Row>();
  for (const report of rows) for (const c of Array.isArray(report.snapshot?.creatives) ? report.snapshot.creatives : []) {
    const key = String(c.ad_id || c.preview_storage_path || c.ad_name || ""); if (!key) continue;
    const item = map.get(key) || { ...c, spend:0, results:0, impressions:0, clicks:0, reach:0 };
    item.spend += n(c.spend); item.results += n(c.results); item.impressions += n(c.impressions); item.clicks += n(c.clicks); item.reach += n(c.reach);
    if (c.preview_storage_path) item.preview_storage_path = c.preview_storage_path; map.set(key, item);
  }
  const all = [...map.values()].map((c) => ({ ...c, cpr:div(n(c.spend),n(c.results)), ctr:div(n(c.clicks)*100,n(c.impressions)) }));
  return all.sort((a,b)=>n(b.results)-n(a.results)||n(a.cpr)-n(b.cpr)).slice(0,6).map((c,i)=>({...c,badge:i===0?"Destaque do mês":i===1?"Boa eficiência":c.badge||"Em destaque",tone:i===0?"good":c.tone||"info"}));
}
function buildNarrative(current: Row, previous: Row, weeks: Row[], campaigns: Row[], sourceRows: Row[]) {
  const dResults=pct(nullable(current.results),nullable(previous.results)), dCpr=pct(nullable(current.cpr),nullable(previous.cpr));
  let headline="Um mês de evolução acompanhado semana a semana.";
  if(dResults!==null&&dCpr!==null&&dResults>=15&&dCpr<=-10)headline="O mês avançou em volume e eficiência.";
  else if(dResults!==null&&dCpr!==null&&dResults<=-15&&dCpr>=15)headline="O mês fechou com perda de volume e eficiência.";
  else if(dResults!==null&&dResults>=15)headline="O mês ganhou volume de resultados.";
  else if(dResults!==null&&dResults<=-15)headline="O mês perdeu volume e pede uma correção objetiva.";
  const bestWeek=[...weeks].sort((a,b)=>n(b.results)-n(a.results)||n(a.cpr)-n(b.cpr))[0]||null;
  const bestCampaign=campaigns[0]||null;
  const steps:string[]=[];
  for(const report of [...sourceRows].reverse()) for(const step of (report.snapshot?.narrative?.next_steps||[])) {
    const text=String(step||"").trim(); if(text&&!steps.some((x)=>x.toLowerCase()===text.toLowerCase()))steps.push(text);
  }
  return {
    headline,
    body:`Foram ${Math.round(n(current.results)).toLocaleString("pt-BR")} resultados com ${n(current.spend).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} investidos no consolidado das semanas do mês.`,
    key_insight:bestCampaign?`${bestCampaign.campaign_name} foi o principal motor de resultado do mês.`:bestWeek?`A semana ${bestWeek.index} concentrou o maior volume de resultados.`:"O mês foi consolidado a partir dos fechamentos semanais auditados.",
    best_week:bestWeek, next_steps:steps.slice(0,4),
    deltas:{spend:pct(nullable(current.spend),nullable(previous.spend)),results:dResults,cpr:dCpr,ctr:pct(nullable(current.ctr),nullable(previous.ctr))},
  };
}
async function buildMonthly(ops:any, client:Row, bounds:ReturnType<typeof monthBounds>) {
  const currentRows=await sourceWeeks(ops,String(client.id),bounds.start,bounds.end);
  const previousRows=await sourceWeeks(ops,String(client.id),bounds.prevStart,bounds.prevEnd);
  const current=aggregate(currentRows), previous=aggregate(previousRows), weeks=weekRows(currentRows);
  const campaigns=aggregateCampaigns(currentRows,previousRows), creatives=aggregateCreatives(currentRows);
  const auditStatus=currentRows.length>=EXPECTED_WEEKS&&previousRows.length>=EXPECTED_WEEKS?"PASS":currentRows.length?"PARTIAL":"FAIL";
  const isFinal=bounds.end<localToday()&&currentRows.length>=EXPECTED_WEEKS;
  const narrative=buildNarrative(current,previous,weeks,campaigns,currentRows);
  const snapshot={
    version:1,report_kind:"MONTHLY",month_key:bounds.key,month_start:bounds.start,month_end:bounds.end,
    generated_at:new Date().toISOString(),current,previous,trends:trend(current,previous),weeks,campaigns,creatives,narrative,
    coverage:{status:auditStatus,current_week_count:currentRows.length,previous_week_count:previousRows.length,expected_weeks:EXPECTED_WEEKS,is_final:isFinal},
    provenance:{source:"AUDITED_WEEKLY_CLIENT_REPORTS",source_report_ids:currentRows.map((r)=>r.id),previous_source_report_ids:previousRows.map((r)=>r.id)},
    disclaimer:"O fechamento mensal consolida os relatórios semanais auditados da operação Meta Ads da agência. Quando a cobertura semanal histórica é incompleta, a apresentação sinaliza o comparativo como parcial.",
  };
  return { snapshot,currentRows,previousRows,auditStatus,isFinal,status:currentRows.length?"READY":"REVIEW_REQUIRED" };
}
async function saveMonthly(ops:any,client:Row,bounds:ReturnType<typeof monthBounds>){
  const built=await buildMonthly(ops,client,bounds);
  const row={client_id:client.id,client_name:client.display_name,gt_owner:client.gt_owner||null,month_start:bounds.start,month_end:bounds.end,status:built.status,audit_status:built.auditStatus,is_final:built.isFinal,snapshot:built.snapshot,source_report_ids:built.currentRows.map((r)=>r.id),previous_source_report_ids:built.previousRows.map((r)=>r.id),generated_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  const {data,error}=await ops.from("monthly_client_reports").upsert(row,{onConflict:"client_id,month_start"}).select("*").single();
  if(error)throw error; return data;
}
function availableMonths(){
  const now=localToday().slice(0,7),out:string[]=[];let cursor=new Date(Date.UTC(2026,7,1));
  while(cursor.toISOString().slice(0,7)<=now){out.push(cursor.toISOString().slice(0,7));cursor=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,1));}
  return out.reverse();
}
function defaultMonth(){const d=new Date(`${localToday()}T12:00:00Z`);d.setUTCDate(0);return d.toISOString().slice(0,7);}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  const url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!anon||!service)return json({error:"server_configuration"},500);
  const ctx=await identify(req,url,anon,service);if(!ctx)return json({error:"forbidden"},403);
  try{
    if(req.method==="GET"){
      const requested=String(new URL(req.url).searchParams.get("month")||defaultMonth());
      if(!isMonth(requested)||!availableMonths().includes(requested))return json({error:"invalid_month"},400);
      const bounds=monthBounds(requested);
      let q=ctx.ops.from("clients").select("id,display_name,gt_owner,lifecycle,entrada,saida").lte("entrada",bounds.end).or(`saida.is.null,saida.gte.${bounds.start}`).order("display_name");
      if(ctx.role==="GT")q=q.eq("gt_owner",ctx.person);
      const {data:clients,error:clientError}=await q;if(clientError)throw clientError;
      const ids=(clients||[]).map((c:Row)=>c.id);let reports:Row[]=[];
      if(ids.length){const {data,error}=await ctx.ops.from("monthly_client_reports").select("id,client_id,client_name,gt_owner,month_start,month_end,public_token,status,audit_status,is_final,snapshot,generated_at,shared_at").eq("month_start",bounds.start).in("client_id",ids);if(error)throw error;reports=data||[];}
      return json({ok:true,profile:{person:ctx.person,role:ctx.role},month:requested,months:availableMonths(),clients:clients||[],reports});
    }
    if(req.method==="POST"){
      const body=await req.json().catch(()=>({}));const action=String(body.action||"generate"),clientId=String(body.client_id||""),month=String(body.month||defaultMonth());
      if(!clientId||!isMonth(month)||!availableMonths().includes(month))return json({error:"invalid_request"},400);
      const {data:client,error:clientError}=await ctx.ops.from("clients").select("id,display_name,gt_owner,lifecycle,entrada,saida").eq("id",clientId).maybeSingle();
      if(clientError)throw clientError;if(!client)return json({error:"client_not_found"},404);
      if(ctx.role==="GT"&&String(client.gt_owner||"")!==ctx.person)return json({error:"forbidden"},403);
      if(action==="generate"||action==="regenerate"){
        const report=await saveMonthly(ctx.ops,client,monthBounds(month));
        return json({ok:true,report,public_path:`/relatorio-mensal/${report.public_token}`});
      }
      if(action==="mark_shared"){
        const {data:report,error}=await ctx.ops.from("monthly_client_reports").update({shared_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("client_id",clientId).eq("month_start",`${month}-01`).select("*").single();
        if(error)throw error;return json({ok:true,report});
      }
      return json({error:"invalid_action"},400);
    }
    return json({error:"method_not_allowed"},405);
  }catch(error){console.error("[monthly-client-report]",error);return json({error:"monthly_report_failed",detail:String(error instanceof Error?error.message:error)},500);}
});
