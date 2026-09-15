import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const PREVIEW_BUCKET = "agency-meta-creative-previews";
const APPROVAL_CHAT_ID = "120363405788325807-group";
const SIGNED_SECONDS = 6 * 60 * 60;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const finite = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const pctChange = (current: unknown, previous: unknown) => {
  const c = finite(current), p = finite(previous);
  return c === null || p === null || p === 0 ? null : ((c - p) / Math.abs(p)) * 100;
};
const normalize = (value: unknown) => String(value || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("pt-BR")
  .replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["criativos","criativo","ajuste","campanha","nova","novo","novos","form","forms","venda","lead","leads","anuncio","ad01","ad02","ad03","imagem","video","marketing","imoveis","imovel","para","com","dos","das","uma","the"]);
const tokens = (value: unknown) => [...new Set(normalize(value).split(/\s+/).filter((x) => x.length >= 3 && !STOP.has(x)))];
const tokenScore = (a: unknown, b: unknown) => {
  const aa = tokens(a), bb = new Set(tokens(b));
  if (!aa.length || !bb.size) return 0;
  const hit = aa.filter((x) => bb.has(x)).length;
  return hit / Math.max(aa.length, Math.min(6, bb.size));
};
const median = (values: Array<number | null>) => {
  const xs = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a,b) => a-b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m-1] + xs[m]) / 2;
};
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
const shift = (day: string, delta: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); };

async function signPreviews(db: any, rows: Row[]) {
  const paths = [...new Set(rows.map((r) => String(r.preview_storage_path || r.metadata?.preview_storage_path || "")).filter(Boolean))];
  if (!paths.length) return rows;
  const { data, error } = await db.storage.from(PREVIEW_BUCKET).createSignedUrls(paths, SIGNED_SECONDS);
  if (error || !Array.isArray(data)) return rows;
  const map = new Map<string,string>();
  data.forEach((x:any, i:number) => { const p = String(x?.path || paths[i] || ""), u = String(x?.signedUrl || ""); if (p && u) map.set(p,u); });
  return rows.map((r) => {
    const p = String(r.preview_storage_path || r.metadata?.preview_storage_path || "");
    const u = map.get(p);
    return u ? { ...r, preview_url:u, image_url:u, thumbnail_url:u } : r;
  });
}

function designerFromText(value: unknown, designers: string[]) {
  const n = normalize(value);
  if (!n) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const person of designers) {
    const pn = normalize(person);
    const first = pn.split(" ")[0] || "";
    let score = 0;
    if (pn && n.includes(pn)) score = 1;
    else if (first.length >= 4 && n.includes(first)) score = .8;
    if (score > bestScore) { best = person; bestScore = score; }
  }
  return best;
}

function deriveFormat(r: Row) {
  const n = normalize(`${r.ad_name || ""} ${r.creative_name || ""}`);
  if (/\bvideo\b|\breels\b|\bstory video\b/.test(n)) return "VÍDEO";
  if (/carrossel|carousel/.test(n)) return "CARROSSEL";
  return "ESTÁTICO";
}

function tagCreative(r: Row) {
  const text = `${r.ad_name || ""} ${r.creative_name || ""}`;
  const n = normalize(text);
  const out: string[] = [];
  if (/r\$|\bpreco\b|\bvalor\b|\bmil\b|\bentrada\b/.test(String(text).toLocaleLowerCase("pt-BR"))) out.push("PREÇO/CONDIÇÃO");
  if (/financi|caixa|fgts/.test(n)) out.push("FINANCIAMENTO");
  if (/dorm|quarto|suite|sacada|vaga|m2|m²/.test(n)) out.push("ATRIBUTOS");
  if (/invest|renda|loca|rentab|valoriz/.test(n)) out.push("INVESTIMENTO");
  if (/casa|apartamento|apto|studio|terreno|lote/.test(n)) out.push("PRODUTO");
  return out.slice(0,4);
}

function performanceStatus(row: Row, baseline: Row, history: Row[]) {
  const results = finite(row.results) || 0;
  const spend = finite(row.spend) || 0;
  const cpr = finite(row.cost_per_result ?? row.cpl);
  const ctr = finite(row.ctr);
  const frequency = finite(row.frequency) || 0;
  const baseCpr = finite(baseline.median_cpr);
  const baseCtr = finite(baseline.median_ctr);
  const uplift = cpr !== null && baseCpr !== null && baseCpr > 0 ? ((baseCpr - cpr) / baseCpr) * 100 : null;
  const ctrUplift = ctr !== null && baseCtr !== null && baseCtr > 0 ? ((ctr - baseCtr) / baseCtr) * 100 : null;
  const ordered = [...history].sort((a,b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)));
  const earliest = ordered[0] || null;
  const cprTrend = earliest && String(earliest.snapshot_date) !== String(row.snapshot_date) ? pctChange(cpr, earliest.cost_per_result ?? earliest.cpl) : null;
  const ctrTrend = earliest && String(earliest.snapshot_date) !== String(row.snapshot_date) ? pctChange(ctr, earliest.ctr) : null;
  const fatigue = frequency >= 3 && ((cprTrend !== null && cprTrend >= 25) || (ctrTrend !== null && ctrTrend <= -20));
  let proof = "AMOSTRA_INSUFICIENTE";
  if (results >= 8 && spend >= 50) proof = "VENCEDOR_COMPROVADO";
  else if (results >= 4 && spend >= 30) proof = "FORTE_CANDIDATO";
  else if (results >= 2) proof = "ACIMA_DA_MEDIA";
  if (fatigue) proof = "EM_FADIGA";

  const maxResults = Math.max(1, finite(baseline.max_results) || 1);
  const efficiency = uplift === null ? 12 : clamp(15 + uplift * .35, 0, 30);
  const volume = clamp((results / maxResults) * 25, 0, 25);
  const clickQuality = ctrUplift === null ? 7 : clamp(8 + ctrUplift * .12, 0, 15);
  const leadRate = (finite(row.clicks) || 0) > 0 ? results / (finite(row.clicks) || 1) * 100 : null;
  const conversion = leadRate === null ? 5 : clamp(leadRate * 1.2, 0, 15);
  const consistency = fatigue ? 2 : ((cprTrend === null || cprTrend <= 20) && (ctrTrend === null || ctrTrend >= -15) ? 10 : 5);
  const sample = results >= 8 ? 5 : results >= 4 ? 4 : results >= 2 ? 2 : 1;
  const score = Math.round(clamp(efficiency + volume + clickQuality + conversion + consistency + sample));

  const reasons: string[] = [];
  if (uplift !== null) reasons.push(`CPR ${Math.abs(uplift).toFixed(0)}% ${uplift >= 0 ? "melhor" : "pior"} que a mediana do cliente`);
  reasons.push(`${results.toLocaleString("pt-BR")} resultado(s) com R$ ${spend.toFixed(2).replace(".",",")} de investimento`);
  if (ctrUplift !== null) reasons.push(`CTR ${Math.abs(ctrUplift).toFixed(0)}% ${ctrUplift >= 0 ? "acima" : "abaixo"} da mediana do cliente`);
  if (fatigue) reasons.unshift("Sinais de fadiga: frequência alta acompanhada de deterioração de CTR/CPR");

  return { proof, score, uplift, ctr_uplift:ctrUplift, cpr_trend:cprTrend, ctr_trend:ctrTrend, fatigue, lead_rate:leadRate, reasons:reasons.slice(0,4) };
}

function attributionFor(row: Row, tasks: Row[], approvals: Row[], designers: string[]) {
  const identity = `${row.ad_name || ""} ${row.campaign_name || ""} ${row.creative_name || ""}`;
  const clientNorm = normalize(row.client_name);
  const clientFirst = clientNorm.split(" ")[0] || "";
  const relatedTasks = tasks.filter((t) => String(t.client_id) === String(row.client_id));
  let taskBest: Row | null = null, taskBestScore = 0;
  for (const t of relatedTasks) {
    const person = designerFromText(t.assignee_names, designers);
    if (!person) continue;
    const sim = tokenScore(identity, t.name);
    const creativeHint = /criativ|campanha|ajuste/i.test(String(t.name || "")) ? .18 : 0;
    const score = sim + creativeHint;
    if (score > taskBestScore) { taskBest = { ...t, designer:person }; taskBestScore = score; }
  }

  let approvalBest: Row | null = null, approvalBestScore = 0;
  for (const a of approvals) {
    const text = `${a.text_body || ""} ${a.caption || ""}`;
    const nt = normalize(text);
    const person = designerFromText(a.sender_name, designers);
    if (!person) continue;
    const clientHit = clientNorm.length >= 4 && nt.includes(clientNorm) ? .55 : (clientFirst.length >= 4 && nt.includes(clientFirst) ? .32 : 0);
    if (!clientHit) continue;
    const sim = tokenScore(identity, text);
    const score = clientHit + sim * .7;
    if (score > approvalBestScore) { approvalBest = { ...a, designer:person }; approvalBestScore = score; }
  }

  const td = taskBest?.designer || null, ad = approvalBest?.designer || null;
  if (td && ad && td === ad) return {
    designer:td, confidence:96, level:"CONFIRMADO", method:"CLICKUP+APROVACOES",
    evidences:[
      { source:"CLICKUP", label:taskBest?.name, url:taskBest?.url || null, at:taskBest?.date_updated || taskBest?.date_created || null },
      { source:"APROVACOES", label:String(approvalBest?.text_body || approvalBest?.caption || "").slice(0,180), at:approvalBest?.event_at || null },
    ],
  };
  if (ad && (!td || approvalBestScore >= taskBestScore + .15)) return {
    designer:ad, confidence:Math.round(clamp(78 + approvalBestScore * 8, 78, 91)), level:"FORTE", method:"APROVACOES",
    evidences:[{ source:"APROVACOES", label:String(approvalBest?.text_body || approvalBest?.caption || "").slice(0,180), at:approvalBest?.event_at || null }],
  };
  if (td) return {
    designer:td, confidence:Math.round(clamp(68 + taskBestScore * 12, 68, 86)), level:ad && ad !== td ? "CONFLITO" : "PROVAVEL", method:"CLICKUP",
    evidences:[{ source:"CLICKUP", label:taskBest?.name, url:taskBest?.url || null, at:taskBest?.date_updated || taskBest?.date_created || null }, ...(ad && ad !== td ? [{source:"APROVACOES_CONFLITO",label:`Aprovação enviada por ${ad}`,at:approvalBest?.event_at || null}] : [])],
  };
  return { designer:null, confidence:0, level:"NAO_IDENTIFICADO", method:null, evidences:[] };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
  if (req.method !== "GET") return json({error:"method_not_allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"), anonKey=Deno.env.get("SUPABASE_ANON_KEY"), serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceRole)return json({error:"server_configuration"},500);
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);
  const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}}});
  const {data:authData,error:authError}=await auth.auth.getUser();
  if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const {data:pref}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",authData.user.id).maybeSingle();
  const person=String(pref?.collaborator_person||"").trim();
  const {data:roster}=await ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle();
  const role=String(roster?.role||"").toUpperCase();
  if(!person||!roster||!["MGMT","DESIGN","CS"].includes(role))return json({error:"not_found"},404);

  try {
    const today=localDate(), since=shift(today,-90), approvalSince=`${shift(today,-180)}T00:00:00-03:00`;
    const [{data:clients,error:clientsError},{data:designRoster,error:designError}] = await Promise.all([
      ops.from("clients").select("id,display_name,lifecycle,gt_owner,designer_owner").in("lifecycle",["ACTIVE","ONBOARDING"]).limit(500),
      ops.from("team_roster").select("person,role,is_former").eq("role","DESIGN").eq("is_former",false).limit(100),
    ]);
    if(clientsError)throw clientsError; if(designError)throw designError;
    const clientIds=(clients||[]).map((c:Row)=>String(c.id));
    const designers=(designRoster||[]).map((r:Row)=>String(r.person)).filter(Boolean);
    if(!clientIds.length)return json({profile:{person,role},summary:{mapped:0},creatives:[],designers:[],learnings:[],opportunities:[],generated_at:new Date().toISOString()});

    const [historyRes,taskRes,approvalRes]=await Promise.all([
      ops.from("meta_creative_history").select("*").in("client_id",clientIds).eq("period_days",7).gte("snapshot_date",since).order("snapshot_date",{ascending:false}).limit(9000),
      ops.from("clickup_tasks").select("client_id,task_id,name,status,is_closed,date_created,date_updated,date_closed,url,assignee_names").in("client_id",clientIds).gte("date_updated",`${shift(today,-180)}T00:00:00-03:00`).limit(5000),
      ops.from("whatsapp_messages").select("event_at,sender_name,text_body,caption").eq("chat_id",APPROVAL_CHAT_ID).gte("event_at",approvalSince).order("event_at",{ascending:false}).limit(2500),
    ]);
    if(historyRes.error)throw historyRes.error; if(taskRes.error)throw taskRes.error; if(approvalRes.error)throw approvalRes.error;
    const history:Row[]=historyRes.data||[], tasks:Row[]=taskRes.data||[], approvals:Row[]=approvalRes.data||[];

    const clientMap=new Map((clients||[]).map((c:Row)=>[String(c.id),c]));
    const latestMap=new Map<string,Row>();
    const historyByAd=new Map<string,Row[]>();
    for(const r of history){
      const key=`${r.client_id}:${r.ad_id}`;
      if(!latestMap.has(key))latestMap.set(key,r);
      if(!historyByAd.has(key))historyByAd.set(key,[]);
      historyByAd.get(key)!.push(r);
    }
    let latest=[...latestMap.values()].filter((r)=>finite(r.spend)!==null && (finite(r.spend)||0)>0);
    const byClient=new Map<string,Row[]>();
    for(const r of latest){const k=String(r.client_id);if(!byClient.has(k))byClient.set(k,[]);byClient.get(k)!.push(r);}
    const baselines=new Map<string,Row>();
    for(const [clientId,rows] of byClient){
      const resultRows=rows.filter((r)=>(finite(r.results)||0)>0 && (finite(r.spend)||0)>=10);
      baselines.set(clientId,{
        median_cpr:median(resultRows.map((r)=>finite(r.cost_per_result??r.cpl))),
        median_ctr:median(rows.filter((r)=>(finite(r.impressions)||0)>=300).map((r)=>finite(r.ctr))),
        max_results:Math.max(0,...rows.map((r)=>finite(r.results)||0)),
        total_results:rows.reduce((s,r)=>s+(finite(r.results)||0),0),
        creative_count:rows.length,
      });
    }

    const enriched:Row[]=[];
    for(const r of latest){
      const client=clientMap.get(String(r.client_id))||{};
      const baseline=baselines.get(String(r.client_id))||{};
      const historyRows=historyByAd.get(`${r.client_id}:${r.ad_id}`)||[];
      const perf=performanceStatus(r,baseline,historyRows);
      const attribution=attributionFor({...r,client_name:r.client_name||client.display_name},tasks,approvals,designers);
      enriched.push({
        ...r,
        client_name:r.client_name||client.display_name||"Cliente",
        gt_owner:r.gt_owner||client.gt_owner||null,
        portfolio_designer:client.designer_owner||null,
        format:deriveFormat(r),
        tags:tagCreative(r),
        baseline,
        performance:perf,
        attribution,
        history_points:historyRows.length,
        first_seen_at:[...historyRows].sort((a,b)=>String(a.snapshot_date).localeCompare(String(b.snapshot_date)))[0]?.snapshot_date||null,
      });
    }
    enriched.sort((a,b)=>Number(b.performance?.score||0)-Number(a.performance?.score||0)||(finite(b.results)||0)-(finite(a.results)||0));
    const signed=await signPreviews(db,enriched.slice(0,120));

    const dMap=new Map<string,Row>();
    for(const r of signed){
      const d=String(r.attribution?.designer||""); if(!d)continue;
      const x=dMap.get(d)||{designer:d,pieces:0,proven:0,rising:0,fatigue:0,results:0,spend:0,uplifts:[],confidence:[]};
      x.pieces++; x.results+=(finite(r.results)||0); x.spend+=(finite(r.spend)||0); x.uplifts.push(finite(r.performance?.uplift)); x.confidence.push(finite(r.attribution?.confidence));
      if(r.performance?.proof==="VENCEDOR_COMPROVADO")x.proven++;
      if(r.performance?.proof==="FORTE_CANDIDATO")x.rising++;
      if(r.performance?.proof==="EM_FADIGA")x.fatigue++;
      dMap.set(d,x);
    }
    const designerSummary=[...dMap.values()].map((x)=>({
      designer:x.designer,pieces:x.pieces,proven:x.proven,rising:x.rising,fatigue:x.fatigue,results:x.results,spend:x.spend,
      avg_uplift:median(x.uplifts),avg_confidence:median(x.confidence),winner_rate:x.pieces?x.proven/x.pieces*100:0,
    })).sort((a,b)=>b.proven-a.proven||b.results-a.results);

    const proven=signed.filter((r)=>r.performance?.proof==="VENCEDOR_COMPROVADO");
    const fatigue=signed.filter((r)=>r.performance?.proof==="EM_FADIGA");
    const rising=signed.filter((r)=>r.performance?.proof==="FORTE_CANDIDATO");
    const insufficient=signed.filter((r)=>r.performance?.proof==="AMOSTRA_INSUFICIENTE");
    const learnings:Row[]=[];
    if(proven.length){
      const betterCtr=proven.filter((r)=>(finite(r.performance?.ctr_uplift)||0)>0).length;
      learnings.push({title:"Vencedor não é só CTR",statement:`${proven.length} criativo(s) têm amostra forte e eficiência comprovada. ${betterCtr} também superam a mediana de CTR do próprio cliente.`,sample:proven.length,confidence:proven.length>=8?"ALTA":"MÉDIA"});
    }
    const staticRows=signed.filter((r)=>r.format==="ESTÁTICO"&&(finite(r.results)||0)>0), videoRows=signed.filter((r)=>r.format==="VÍDEO"&&(finite(r.results)||0)>0);
    if(staticRows.length>=3&&videoRows.length>=3){
      const s=median(staticRows.map((r)=>finite(r.cost_per_result??r.cpl))),v=median(videoRows.map((r)=>finite(r.cost_per_result??r.cpl)));
      if(s!==null&&v!==null)learnings.push({title:"Estático x vídeo na amostra atual",statement:`CPR mediano: estático R$ ${s.toFixed(2).replace(".",",")} (${staticRows.length} peças) vs vídeo R$ ${v.toFixed(2).replace(".",",")} (${videoRows.length} peças).`,sample:staticRows.length+videoRows.length,confidence:"MÉDIA"});
    }
    const attributed=signed.filter((r)=>r.attribution?.designer).length;
    learnings.push({title:"Cobertura de autoria",statement:`${attributed} de ${signed.length} criativos exibidos têm designer atribuído por evidência de ClickUp e/ou grupo de aprovações.`,sample:signed.length,confidence:"OPERACIONAL"});

    const opportunities:Row[]=[];
    fatigue.slice(0,12).forEach((r)=>opportunities.push({kind:"FADIGA",priority:"ALTA",client_id:r.client_id,client_name:r.client_name,ad_id:r.ad_id,ad_name:r.ad_name,designer:r.attribution?.designer||null,title:"Vencedor entrando em fadiga",action:"Criar nova execução mantendo o conceito vencedor; variar abertura, imagem e hierarquia.",evidence:r.performance?.reasons?.[0]||null}));
    proven.filter((r)=>Number(r.baseline?.creative_count||0)<=2).slice(0,10).forEach((r)=>opportunities.push({kind:"VARIACAO",priority:"MÉDIA",client_id:r.client_id,client_name:r.client_name,ad_id:r.ad_id,ad_name:r.ad_name,designer:r.attribution?.designer||null,title:"Vencedor com pouca cobertura de variações",action:"Transformar a peça em família criativa antes de perder eficiência.",evidence:`Score ${r.performance?.score}/100 · ${r.results} resultados`}));
    rising.slice(0,10).forEach((r)=>opportunities.push({kind:"ASCENSAO",priority:"MÉDIA",client_id:r.client_id,client_name:r.client_name,ad_id:r.ad_id,ad_name:r.ad_name,designer:r.attribution?.designer||null,title:"Criativo em ascensão",action:"Manter entrega e acompanhar até atingir amostra de vencedor comprovado.",evidence:r.performance?.reasons?.[0]||null}));

    return json({
      profile:{person,role},
      summary:{mapped:latestMap.size,shown:signed.length,proven:proven.length,rising:rising.length,fatigue:fatigue.length,insufficient:insufficient.length,attributed,coverage_days:[...new Set(history.map((r)=>r.snapshot_date))].length},
      creatives:signed,
      designers:designerSummary,
      learnings,
      opportunities:opportunities.slice(0,30),
      methodology:{baseline:"mediana dos criativos do próprio cliente com entrega no período",proof:"volume + investimento + eficiência relativa; nenhuma peça é vencedora só por CTR ou por 1 lead barato",attribution:"ClickUp + mensagens do grupo [APROVAÇÕES] - Design, com nível de confiança explícito"},
      generated_at:new Date().toISOString(),
    });
  } catch(error){return json({error:"creative_intelligence_failed",detail:String(error instanceof Error?error.message:error)},500);}
});
