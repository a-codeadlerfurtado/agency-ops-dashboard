import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Reason = { code: string; tone: "bad" | "warn" | "good" | "info"; points: number; text: string; action?: string };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const PREVIEW_BUCKET = "agency-meta-creative-previews";
const SIGNED_SECONDS = 6 * 60 * 60;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const finite = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (a: unknown, b: unknown) => { const x = finite(a), y = finite(b); return x === null || y === null || y === 0 ? null : ((x - y) / Math.abs(y)) * 100; };
const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const shift = (day: string, delta: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); };

function creativeSignals(rows: Row[]) {
  const sorted = [...rows].sort((a,b) => (finite(b.results)||0)-(finite(a.results)||0) || (finite(a.cost_per_result ?? a.cpl) ?? 1e12)-(finite(b.cost_per_result ?? b.cpl) ?? 1e12) || (finite(b.spend)||0)-(finite(a.spend)||0));
  const resultRows = sorted.filter(r => (finite(r.results)||0) > 0);
  const best = resultRows[0] || sorted[0] || null;
  const costs = resultRows.map(r => finite(r.cost_per_result ?? r.cpl)).filter((n): n is number => n !== null && n > 0);
  const med = median(costs);
  const wasteThreshold = Math.max(20, med || 0);
  const waste = sorted.filter(r => (finite(r.results)||0) <= 0 && (finite(r.spend)||0) >= wasteThreshold).sort((a,b)=>(finite(b.spend)||0)-(finite(a.spend)||0));
  const fatigue = sorted.filter(r => (finite(r.frequency)||0) >= 3 && (finite(r.impressions)||0) >= 500).sort((a,b)=>(finite(b.frequency)||0)-(finite(a.frequency)||0));
  const scale = resultRows.filter(r => (finite(r.results)||0) >= 3 && med !== null && (finite(r.cost_per_result ?? r.cpl) ?? 1e12) <= med).sort((a,b)=>(finite(b.results)||0)-(finite(a.results)||0));
  const totalResults = sorted.reduce((s,r)=>s+(finite(r.results)||0),0);
  const bestShare = best && totalResults > 0 ? ((finite(best.results)||0)/totalResults)*100 : null;
  return { best, waste, fatigue, scale, median_cost: med, total_results: totalResults, best_share: bestShare };
}

function aggregateBalance(rows: Row[]) {
  if (!rows.length) return null;
  const days = rows.map(r=>finite(r.days_remaining)).filter((n):n is number=>n!==null);
  const active = rows.reduce((s,r)=>s+(finite(r.active_campaigns)||0),0);
  return {
    accounts: rows.length,
    days_remaining: days.length ? Math.min(...days) : null,
    available_balance: rows.reduce((s,r)=>s+(finite(r.available_balance)||0),0),
    spend_7d: rows.reduce((s,r)=>s+(finite(r.spend_7d)||0),0),
    avg_daily_spend: rows.reduce((s,r)=>s+(finite(r.avg_daily_spend)||0),0),
    active_campaigns: active,
    account_disabled: rows.some(r => finite(r.account_status) !== null && finite(r.account_status) !== 1),
    checked_at: rows.map(r=>r.checked_at).filter(Boolean).sort().at(-1) || null,
    run_statuses: [...new Set(rows.map(r=>String(r.run_status||"")).filter(Boolean))],
  };
}

function taskStats(rows: Row[]) {
  const now = Date.now();
  const endToday = new Date(); endToday.setHours(23,59,59,999);
  const overdue = rows.filter(r => r.due_date && new Date(r.due_date).getTime() < now);
  const dueToday = rows.filter(r => r.due_date && new Date(r.due_date).getTime() >= now && new Date(r.due_date).getTime() <= endToday.getTime());
  return { open: rows.length, overdue: overdue.length, due_today: dueToday.length, overdue_items: overdue.slice(0,5), due_today_items: dueToday.slice(0,5) };
}

function dailySeries(rows: Row[]) {
  const map = new Map<string, Row>();
  for (const r of rows) {
    const day = String(r.date_start || ""); if (!day) continue;
    const x = map.get(day) || { date:day, spend:0, results:0, impressions:0, clicks:0, frequency_num:0, frequency_den:0 };
    x.spend += finite(r.spend)||0; x.results += finite(r.result_count)||0; x.impressions += finite(r.impressions)||0; x.clicks += finite(r.clicks)||0;
    const imp = finite(r.impressions)||0, fr = finite(r.frequency); if (fr !== null && imp > 0) { x.frequency_num += fr*imp; x.frequency_den += imp; }
    map.set(day,x);
  }
  return [...map.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))).map(x=>({
    date:x.date, spend:x.spend, results:x.results, impressions:x.impressions, clicks:x.clicks,
    ctr:x.impressions>0?x.clicks/x.impressions*100:null, cpr:x.results>0?x.spend/x.results:null,
    frequency:x.frequency_den>0?x.frequency_num/x.frequency_den:null,
  }));
}

function changesFor(current7: Row | null, previous7: Row | null, current3: Row | null, creatives: Row[], daily: Row[]) {
  const changes: Row[] = [];
  const cpl = pct(current7?.cpl, previous7?.cpl); if (cpl !== null && Math.abs(cpl) >= 15) changes.push({ tone:cpl>0?"bad":"good", kind:"CPL", text:`CPL ${cpl>0?"subiu":"caiu"} ${Math.abs(cpl).toFixed(0)}% vs. semana anterior`, value:cpl });
  const ctr = pct(current7?.ctr, previous7?.ctr); if (ctr !== null && Math.abs(ctr) >= 20) changes.push({ tone:ctr<0?"bad":"good", kind:"CTR", text:`CTR ${ctr<0?"caiu":"subiu"} ${Math.abs(ctr).toFixed(0)}% vs. semana anterior`, value:ctr });
  const res = pct(current7?.results, previous7?.results); if (res !== null && Math.abs(res) >= 25) changes.push({ tone:res<0?"warn":"good", kind:"RESULTADOS", text:`Resultados ${res<0?"caíram":"subiram"} ${Math.abs(res).toFixed(0)}% vs. semana anterior`, value:res });
  const cs = creativeSignals(creatives);
  if (cs.best && cs.best_share !== null && cs.best_share >= 50 && cs.total_results >= 2) changes.push({ tone:"info", kind:"CRIATIVO", text:`${cs.best.ad_name || "Melhor criativo"} concentra ${cs.best_share.toFixed(0)}% dos resultados`, ad_id:cs.best.ad_id });
  if (cs.waste[0]) changes.push({ tone:"bad", kind:"DESPERDÍCIO", text:`${cs.waste[0].ad_name || "Criativo"} gastou R$ ${(finite(cs.waste[0].spend)||0).toFixed(2).replace(".",",")} sem resultado`, ad_id:cs.waste[0].ad_id });
  if ((finite(current7?.frequency)||0) >= 3 && (finite(previous7?.frequency)||0) < 3) changes.push({ tone:"warn", kind:"FREQUÊNCIA", text:`Frequência passou de 3 e está em ${(finite(current7?.frequency)||0).toFixed(2)}` });
  const recent = daily.filter(d=>finite(d.ctr)!==null).slice(-4);
  if (recent.length === 4 && recent.every((d,i)=>i===0 || (finite(d.ctr)||0) < (finite(recent[i-1].ctr)||0))) changes.push({ tone:"warn", kind:"TENDÊNCIA", text:"CTR caiu por 4 medições consecutivas" });
  if ((finite(current3?.spend)||0) <= 0 && (finite(current7?.active_campaigns)||0) > 0) changes.push({ tone:"bad", kind:"ENTREGA", text:"Campanhas ativas sem entrega nos últimos 3 dias" });
  return changes.slice(0,6);
}

function evaluate(client: Row, current7: Row | null, previous7: Row | null, current3: Row | null, creatives: Row[], tasks: Row[], balanceRows: Row[], daily: Row[]) {
  const reasons: Reason[] = [];
  const balance = aggregateBalance(balanceRows); const ts = taskStats(tasks); const cs = creativeSignals(creatives);
  const add = (r: Reason) => reasons.push(r);
  if (client.waiting_direction === "CLIENT_WAITING_AGENCY") add({code:"CLIENT_WAITING",tone:"bad",points:4,text:"Cliente aguardando a agência",action:`Responder a pendência de ${client.current_subject || "atendimento"} e registrar o próximo passo.`});
  if ((finite(client.overdue_commitments)||0) > 0) add({code:"OVERDUE_COMMITMENT",tone:"bad",points:3,text:`${client.overdue_commitments} compromisso(s) vencido(s)`,action:"Resolver o compromisso vencido antes de abrir novas frentes."});
  if ((finite(client.open_complaints)||0) > 0) add({code:"COMPLAINT",tone:"bad",points:3,text:`${client.open_complaints} reclamação(ões) aberta(s)`,action:"Tratar a reclamação e alinhar expectativa com o cliente."});
  if ((finite(client.blockers)||0) > 0) add({code:"BLOCKER",tone:"warn",points:2,text:`${client.blockers} bloqueio(s) operacional(is)`,action:client.next_step || "Remover o bloqueio operacional antes de avançar."});
  if (ts.overdue > 0) add({code:"TASK_OVERDUE",tone:"bad",points:Math.min(4,2+ts.overdue),text:`${ts.overdue} task(s) vencida(s) no ClickUp`,action:`Atacar primeiro: ${ts.overdue_items[0]?.name || "task vencida"}.`});
  else if (ts.due_today > 0) add({code:"TASK_TODAY",tone:"warn",points:1,text:`${ts.due_today} task(s) vence(m) hoje`,action:`Concluir hoje: ${ts.due_today_items[0]?.name || "task pendente"}.`});
  if (balance?.account_disabled) add({code:"META_DISABLED",tone:"bad",points:4,text:"Conta Meta com status de bloqueio/desativação",action:"Revisar imediatamente a conta de anúncios e a forma de pagamento."});
  else if (balance?.days_remaining !== null && balance?.days_remaining <= 1) add({code:"BALANCE_CRITICAL",tone:"bad",points:4,text:`Saldo estimado para ${Math.max(0,balance.days_remaining).toFixed(1)} dia`,action:"Solicitar/confirmar recarga de saldo antes de perder entrega."});
  else if (balance?.days_remaining !== null && balance?.days_remaining <= 3) add({code:"BALANCE_LOW",tone:"warn",points:2,text:`Saldo estimado para ${balance.days_remaining.toFixed(1)} dias`,action:"Antecipar recarga de saldo com o cliente."});
  const status = String(current7?.data_status || "");
  if (["API_ERROR","NO_META_ACCOUNT"].includes(status)) add({code:"META_DATA",tone:"bad",points:3,text:status==="NO_META_ACCOUNT"?"Sem conta Meta reconciliada":"Erro de leitura da Meta",action:"Corrigir cobertura/acesso Meta antes de interpretar performance."});
  if (status === "NO_DELIVERY" || ((finite(current3?.spend)||0) <= 0 && (finite(current7?.active_campaigns)||0) > 0)) add({code:"NO_DELIVERY",tone:"bad",points:4,text:"Campanhas sem entrega recente",action:"Verificar saldo, status das campanhas, anúncios e bloqueios da conta."});
  const cplDelta = pct(current7?.cpl, previous7?.cpl); if (cplDelta !== null && cplDelta >= 40) add({code:"CPL_SPIKE",tone:"bad",points:3,text:`CPL subiu ${cplDelta.toFixed(0)}%`,action:"Revisar campanha e criativos antes de aumentar verba."}); else if (cplDelta !== null && cplDelta >= 20) add({code:"CPL_UP",tone:"warn",points:2,text:`CPL subiu ${cplDelta.toFixed(0)}%`,action:"Acompanhar CPL e identificar campanha/criativo responsável pela alta."});
  if (cs.waste.length) add({code:"CREATIVE_WASTE",tone:"bad",points:2,text:`${cs.waste.length} criativo(s) gastando sem resultado`,action:`Revisar ${cs.waste[0].ad_name || "o criativo sem resultado"}${cs.best?.ad_name?` e considerar realocar para ${cs.best.ad_name}`:""}.`});
  if (cs.fatigue.length) add({code:"CREATIVE_FATIGUE",tone:"warn",points:2,text:`${cs.fatigue.length} criativo(s) com possível fadiga`,action:`Preparar novas variações inspiradas em ${cs.best?.ad_name || "o melhor criativo atual"}.`});
  if (client.priority === "ATTENTION" && !reasons.some(r=>r.code==="CLIENT_WAITING")) add({code:"OPS_ATTENTION",tone:"warn",points:1,text:"Operação marcou cliente em atenção",action:client.next_step || "Revisar o contexto operacional do cliente."});
  const score = reasons.reduce((s,r)=>s+r.points,0);
  const critical = reasons.some(r=>["CLIENT_WAITING","BALANCE_CRITICAL","META_DISABLED","NO_DELIVERY"].includes(r.code));
  const band = critical || score >= 5 ? "ACTION_NOW" : score >= 2 ? "FOLLOW_UP" : "HEALTHY";
  reasons.sort((a,b)=>b.points-a.points);
  const changes = changesFor(current7, previous7, current3, creatives, daily);
  const nextAction = reasons[0]?.action || (cs.scale[0] ? `Manter ${cs.scale[0].ad_name || "o melhor criativo"} e avaliar escala gradual.` : client.next_step || "Manter acompanhamento normal da conta.");
  return { score, band, reasons:reasons.slice(0,5), next_action:nextAction, creative_signals:cs, balance, tasks:ts, changes };
}

async function signed(db: any, rows: Row[]) {
  const paths = [...new Set(rows.map(r=>String(r.preview_storage_path || r.metadata?.preview_storage_path || "")).filter(Boolean))];
  if (!paths.length) return rows;
  const { data, error } = await db.storage.from(PREVIEW_BUCKET).createSignedUrls(paths, SIGNED_SECONDS);
  if (error || !Array.isArray(data)) return rows;
  const map = new Map<string,string>(); data.forEach((x:any,i:number)=>{const p=String(x?.path||paths[i]||"");const u=String(x?.signedUrl||"");if(p&&u)map.set(p,u);});
  return rows.map(r=>{const p=String(r.preview_storage_path || r.metadata?.preview_storage_path || "");const u=map.get(p);return u?{...r,preview_url:u,thumbnail_url:u,image_url:u}:r;});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
  if (req.method !== "GET") return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"), anonKey=Deno.env.get("SUPABASE_ANON_KEY"), serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceRole)return json({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||""; if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);
  const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}}}); const {data:authData,error:authError}=await auth.auth.getUser(); if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}); const ops=db.schema("agency_ops");
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",authData.user.id).maybeSingle(); const person=String(pref?.collaborator_person||"").trim();
  const {data:roster}=await ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle(); const role=String(roster?.role||"").toUpperCase();
  if(!person||!roster||!["MGMT","GT","DESIGN"].includes(role))return json({error:"not_found"},404);
  const profile={person,role,scope:role==="GT"?"WALLET":role==="DESIGN"?"CREATIVE_INTELLIGENCE":"ALL"};
  const url=new URL(req.url); if(url.searchParams.get("probe")==="1")return json({ok:true,profile});
  const requestedGt=String(url.searchParams.get("gt")||"").trim();

  try {
    if(role==="DESIGN" || url.searchParams.get("view")==="designer"){
      if(role!=="DESIGN"&&role!=="MGMT")return json({error:"not_found"},404);
      const since=shift(localDate(),-30);
      let q=ops.from("meta_creative_history").select("*").gte("snapshot_date",since).eq("period_days",7).order("snapshot_date",{ascending:false}).limit(4000);
      if(role==="MGMT"&&requestedGt)q=q.eq("gt_owner",requestedGt);
      const {data,error}=await q; if(error)throw error;
      const latest=new Map<string,Row>(); for(const r of data||[]){const k=`${r.client_id}:${r.ad_id}`;if(!latest.has(k))latest.set(k,r);}
      let rows=[...latest.values()].filter(r=>(finite(r.spend)||0)>0).sort((a,b)=>(finite(b.results)||0)-(finite(a.results)||0)||((finite(a.cost_per_result??a.cpl)??1e12)-(finite(b.cost_per_result??b.cpl)??1e12))).slice(0,60);
      rows=await signed(db,rows);
      const days=[...new Set((data||[]).map((r:Row)=>r.snapshot_date))].length;
      return json({profile,view:"designer",coverage_days:days,creative_count:latest.size,top_creatives:rows,generated_at:new Date().toISOString()});
    }

    const {data:runs,error:runsError}=await ops.from("meta_performance_runs").select("id,snapshot_date,status,finished_at").in("status",["COMPLETED","COMPLETED_WITH_ERRORS"]).order("snapshot_date",{ascending:false}).limit(2); if(runsError)throw runsError;
    const currentRun=runs?.[0], previousRun=runs?.[1]; if(!currentRun)return json({error:"no_performance_run"},404);
    let clientsQ=ops.from("dashboard_client_overview").select("*").eq("lifecycle","ACTIVE").order("display_name",{ascending:true});
    const selectedGt=role==="GT"?person:(requestedGt||""); if(selectedGt)clientsQ=clientsQ.eq("gt_owner",selectedGt);
    const {data:clients,error:clientsError}=await clientsQ.limit(500); if(clientsError)throw clientsError;
    const ids=(clients||[]).map((c:Row)=>String(c.client_id)); if(!ids.length)return json({profile,selected_gt:selectedGt,clients:[],summary:{action_now:0,follow_up:0,healthy:0},generated_at:new Date().toISOString()});

    const clientId=String(url.searchParams.get("client_id")||"").trim(); if(clientId&&!ids.includes(clientId))return json({error:"client_not_found"},404);
    if(clientId){
      const client=(clients||[]).find((c:Row)=>String(c.client_id)===clientId)!;
      const since=shift(localDate(),-14);
      const [perfRes,prevRes,creativeRes,historyRes,balanceRes,taskRes,dailyRes]=await Promise.all([
        ops.from("meta_performance_snapshots").select("*").eq("run_id",currentRun.id).eq("client_id",clientId).order("period_days"),
        previousRun?ops.from("meta_performance_snapshots").select("*").eq("run_id",previousRun.id).eq("client_id",clientId).order("period_days"):Promise.resolve({data:[],error:null} as any),
        ops.from("meta_creative_snapshots").select("*").eq("client_id",clientId).eq("period_days",7).order("results",{ascending:false}),
        ops.from("meta_creative_history").select("*").eq("client_id",clientId).eq("period_days",7).gte("snapshot_date",shift(localDate(),-90)).order("snapshot_date",{ascending:false}).limit(1000),
        ops.from("client_balance_overview").select("*").eq("client_id",clientId),
        ops.from("clickup_tasks").select("task_id,name,status,due_date,url,assignee_names,date_updated").eq("client_id",clientId).eq("is_closed",false).order("due_date",{ascending:true}).limit(100),
        ops.from("meta_campaign_insights").select("client_id,campaign_name,date_start,spend,impressions,clicks,reach,frequency,result_count,cost_per_result").eq("client_id",clientId).gte("date_start",since).order("date_start",{ascending:true}).limit(1000),
      ]);
      const currentMap=new Map((perfRes.data||[]).map((r:Row)=>[Number(r.period_days),r])), prevMap=new Map((prevRes.data||[]).map((r:Row)=>[Number(r.period_days),r]));
      const currentCreatives=await signed(db,(creativeRes.data||[]).map((r:Row)=>({...r,preview_storage_path:r.metadata?.preview_storage_path||null})));
      const historyAll=historyRes.data||[]; const currentIds=new Set((creativeRes.data||[]).map((r:Row)=>String(r.ad_id)));
      const previousUnique=new Map<string,Row>(); for(const r of historyAll){if(currentIds.has(String(r.ad_id)))continue;if(!previousUnique.has(String(r.ad_id)))previousUnique.set(String(r.ad_id),r);} const previousCreatives=await signed(db,[...previousUnique.values()].slice(0,30));
      const evaluation=evaluate(client,currentMap.get(7)||null,prevMap.get(7)||null,currentMap.get(3)||null,creativeRes.data||[],taskRes.data||[],balanceRes.data||[],dailyRes.data||[]);
      const best=evaluation.creative_signals.best; const briefReason=evaluation.creative_signals.fatigue.length?"fadiga":evaluation.creative_signals.waste.length?"gasto sem resultado":"necessidade de renovação";
      const briefing={
        needed:evaluation.creative_signals.fatigue.length>0||evaluation.creative_signals.waste.length>0,
        title:`Novos criativos — ${client.display_name}`,
        reason:briefReason,
        best_creative:best?{ad_id:best.ad_id,ad_name:best.ad_name,results:best.results,cost_per_result:best.cost_per_result??best.cpl}:null,
        suggestion:`Criar 2 novas variações${best?.ad_name?` mantendo o ângulo vencedor de ${best.ad_name}`:""}. Evitar copiar a peça; preservar a promessa/abordagem que gerou resultado e variar abertura, imagem e hierarquia.`,
        target_person:client.designer_owner||null,
      };
      return json({profile,selected_run:currentRun,previous_run:previousRun||null,client,windows:Object.fromEntries(currentMap),previous_windows:Object.fromEntries(prevMap),evaluation,current_creatives:currentCreatives,previous_creatives:previousCreatives,daily_series:dailySeries(dailyRes.data||[]),open_tasks:taskRes.data||[],briefing,creative_history_days:[...new Set(historyAll.map((r:Row)=>r.snapshot_date))].length,generated_at:new Date().toISOString()});
    }

    const since=shift(localDate(),-8);
    const [perfRes,prevRes,creativeRes,balanceRes,taskRes,dailyRes]=await Promise.all([
      ops.from("meta_performance_snapshots").select("*").eq("run_id",currentRun.id).in("client_id",ids).in("period_days",[3,7]).limit(1500),
      previousRun?ops.from("meta_performance_snapshots").select("*").eq("run_id",previousRun.id).in("client_id",ids).eq("period_days",7).limit(1000):Promise.resolve({data:[],error:null} as any),
      ops.from("meta_creative_snapshots").select("*").in("client_id",ids).eq("period_days",7).limit(4000),
      ops.from("client_balance_overview").select("*").in("client_id",ids).limit(1000),
      ops.from("clickup_tasks").select("client_id,task_id,name,status,due_date,url,assignee_names,date_updated").in("client_id",ids).eq("is_closed",false).limit(3000),
      ops.from("meta_campaign_insights").select("client_id,campaign_name,date_start,spend,impressions,clicks,reach,frequency,result_count,cost_per_result").in("client_id",ids).gte("date_start",since).limit(5000),
    ]);
    for(const r of [perfRes,prevRes,creativeRes,balanceRes,taskRes,dailyRes])if(r.error)throw r.error;
    const perf=new Map<string,Row>(); for(const r of perfRes.data||[])perf.set(`${r.client_id}:${r.period_days}`,r);
    const prev=new Map<string,Row>(); for(const r of prevRes.data||[])prev.set(String(r.client_id),r);
    const byCreative=new Map<string,Row[]>(),byBalance=new Map<string,Row[]>(),byTask=new Map<string,Row[]>(),byDaily=new Map<string,Row[]>();
    for(const r of creativeRes.data||[]){const k=String(r.client_id);if(!byCreative.has(k))byCreative.set(k,[]);byCreative.get(k)!.push(r);} for(const r of balanceRes.data||[]){const k=String(r.client_id);if(!byBalance.has(k))byBalance.set(k,[]);byBalance.get(k)!.push(r);} for(const r of taskRes.data||[]){const k=String(r.client_id);if(!byTask.has(k))byTask.set(k,[]);byTask.get(k)!.push(r);} for(const r of dailyRes.data||[]){const k=String(r.client_id);if(!byDaily.has(k))byDaily.set(k,[]);byDaily.get(k)!.push(r);}
    const evaluated=(clients||[]).map((c:Row)=>{const id=String(c.client_id),current7=perf.get(`${id}:7`)||null,current3=perf.get(`${id}:3`)||null,e=evaluate(c,current7,prev.get(id)||null,current3,byCreative.get(id)||[],byTask.get(id)||[],byBalance.get(id)||[],byDaily.get(id)||[]);return {client_id:id,client_name:c.display_name,gt_owner:c.gt_owner,cs_owner:c.cs_owner,designer_owner:c.designer_owner,client_days:c.client_days,meta:current7?{spend:current7.spend,results:current7.results,cpl:current7.cpl,ctr:current7.ctr,frequency:current7.frequency,data_status:current7.data_status,active_campaigns:current7.active_campaigns}:null,creative_coverage:(byCreative.get(id)||[]).length,evaluation:e};}).sort((a:any,b:any)=>{const rank:any={ACTION_NOW:0,FOLLOW_UP:1,HEALTHY:2};return rank[a.evaluation.band]-rank[b.evaluation.band]||b.evaluation.score-a.evaluation.score||String(a.client_name).localeCompare(String(b.client_name),"pt-BR");});
    const gtOptions=role==="MGMT"?[...new Set((clients||[]).map((c:Row)=>String(c.gt_owner||"")).filter(Boolean))].sort():[person];
    const summary={action_now:evaluated.filter((x:any)=>x.evaluation.band==="ACTION_NOW").length,follow_up:evaluated.filter((x:any)=>x.evaluation.band==="FOLLOW_UP").length,healthy:evaluated.filter((x:any)=>x.evaluation.band==="HEALTHY").length,total:evaluated.length,creative_covered:evaluated.filter((x:any)=>x.creative_coverage>0).length};
    const changes=evaluated.flatMap((x:any)=>x.evaluation.changes.map((ch:Row)=>({...ch,client_id:x.client_id,client_name:x.client_name,gt_owner:x.gt_owner}))).sort((a:any,b:any)=>({bad:0,warn:1,good:2,info:3}[a.tone]??4)-({bad:0,warn:1,good:2,info:3}[b.tone]??4)).slice(0,80);
    return json({profile,selected_gt:selectedGt,gt_options:gtOptions,selected_run:currentRun,previous_run:previousRun||null,summary,clients:evaluated,changes,generated_at:new Date().toISOString()});
  } catch(error){return json({error:"radar_failed",detail:String(error instanceof Error?error.message:error)},500);}
});
