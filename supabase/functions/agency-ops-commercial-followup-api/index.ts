import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const TZ = "America/Sao_Paulo";
const METRIC_LABELS: Record<string,string> = {
  leads_received:"Leads recebidos", leads_contacted:"Leads acionados",
  leads_in_conversation:"Leads em conversa", calls_made:"Ligações feitas",
  calls_answered:"Ligações atendidas", visits_scheduled:"Visitas agendadas",
  visits_completed:"Visitas realizadas", proposals:"Propostas",
  sales:"Vendas", properties_prospected:"Imóveis captados",
  properties_listed:"Imóveis cadastrados", notes:"Observações",
};

function json(body: unknown, status = 200, origin?: string | null) {
  const h: Record<string,string> = {"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-headers":"authorization,apikey,content-type,x-automation-secret","access-control-allow-methods":"GET,POST,OPTIONS"};
  if (origin && ORIGINS.has(origin)) { h["access-control-allow-origin"] = origin; h.vary = "Origin"; }
  return new Response(JSON.stringify(body), { status, headers:h });
}
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const randomSecret = () => { const a=new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a).map(x=>x.toString(36)).join("").slice(0,18)+"Aa1!"; };
const sha256 = async (value:string) => { const b=new TextEncoder().encode(value); const d=await crypto.subtle.digest("SHA-256",b); return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join(""); };
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const localDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
const localWeekday = (d = new Date()) => Number(new Intl.DateTimeFormat("en-US", {timeZone:TZ,weekday:"short"}).format(d) === "Sun" ? 0 : ["Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(new Intl.DateTimeFormat("en-US", {timeZone:TZ,weekday:"short"}).format(d)) + 1);
const shiftDate = (day:string, delta:number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); };
const reportPeriodForCollectionDay = (today:string, dow:number) => { if(dow===1) return {start:shiftDate(today,-3),end:shiftDate(today,-1)}; const d=shiftDate(today,-1); return {start:d,end:d}; };
const collectionPeriodForClient = (client:Row, today:string, dow:number) => {
  const mode=String(client?.source_config?.collection_schedule||"WEEKDAYS").toUpperCase();
  if(mode==="WEEKLY_MONDAY") return dow===1?{start:shiftDate(today,-7),end:shiftDate(today,-1)}:null;
  return [1,2,3,4,5].includes(dow)?reportPeriodForCollectionDay(today,dow):null;
};
const periodLabel = (start?:string|null,end?:string|null) => { const a=String(start||end||"").slice(0,10), b=String(end||start||"").slice(0,10); const fmt=(x:string)=>x.split("-").reverse().join("/"); return a&&b&&a!==b?`${fmt(a)} a ${fmt(b)}`:fmt(a||b); };
const atLocal = (day:string, time:string) => new Date(`${day}T${String(time).slice(0,8)}-03:00`).toISOString();

async function zapiSend(db:any, target:string, message:string, mentioned:string[] = []) {
  const {data:creds,error} = await db.schema("agency_ops").rpc("view_oncall_zapi_credentials");
  if (error) throw new Error(`zapi_credentials:${error.message}`);
  const instance=String(creds?.instance_id||""), token=String(creds?.instance_token||""), clientToken=String(creds?.client_token||"");
  if (!instance || !token || !clientToken) throw new Error("zapi_configuration_missing");
  const payload:Row = { phone:target, message, delayTyping:5 };
  if (mentioned.length) payload.mentioned = mentioned.map(phone => ({phone:digits(phone)}));
  const r=await fetch(`https://api.z-api.io/instances/${instance}/token/${token}/send-text`,{method:"POST",headers:{"content-type":"application/json","Client-Token":clientToken},body:JSON.stringify(payload)});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`zapi_${r.status}:${JSON.stringify(body)}`);
  return {message_id:body.messageId||body.id||body.zaapId||null,instance_id:instance};
}

const MONTH_NAMES = ["","JANEIRO","FEVEREIRO","MARCO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];
const isSheetMode = (client:Row) => String(client?.collection_mode||"").toUpperCase()==="PLANILHA";
const brokerKey = (value:unknown) => norm(value).replace(/^sdr\s+/,"").trim();
function decodeHtml(value:string){
  return value.replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
async function fetchText(url:string, timeout=10000){
  const r=await fetch(url,{signal:AbortSignal.timeout(timeout),headers:{"user-agent":"Mozilla/5.0"}});
  if(!r.ok) throw new Error(`fetch_${r.status}:${url}`);
  return await r.text();
}
async function publicDriveItems(folderId:string){
  const html=await fetchText(`https://drive.google.com/drive/folders/${folderId}`);
  const out:Row[]=[]; const seen=new Set<string>();
  const rx=/aria-label="([^"]+?) (Shared folder|Google Sheets Shared)"[\s\S]{0,1800}?data-id="([A-Za-z0-9_-]{20,})"/g;
  for(const m of html.matchAll(rx)){ const id=m[3]; if(seen.has(id))continue; seen.add(id); out.push({id,name:decodeHtml(m[1]),kind:m[2]==="Shared folder"?"folder":"sheet"}); }
  return out;
}
function parseCsv(text:string){
  const rows:string[][]=[]; let row:string[]=[], cell="", quoted=false;
  for(let i=0;i<text.length;i++){ const ch=text[i]; if(quoted){ if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;} else if(ch==='"')quoted=false; else cell+=ch; }
    else if(ch==='"')quoted=true; else if(ch===','){row.push(cell);cell="";} else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell="";} else cell+=ch; }
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);} return rows;
}


function parsePtDate(value:string){
  const m=String(value||"").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(!m)return null;
  const y=Number(m[3]),mo=Number(m[2]),d=Number(m[1]); const dt=new Date(Date.UTC(y,mo-1,d));
  if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;
  return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function metricKey(header:unknown){
  const h=norm(header); if(h.includes("leads novos"))return "leads_received"; if(h.includes("leads acionados"))return "leads_contacted";
  if(h.includes("leads em conversa"))return "leads_in_conversation"; if(h.includes("ligacoes feitas")||h.includes("ligacao feita"))return "calls_made";
  if(h.includes("ligacoes atend")||h.includes("ligacao atend"))return "calls_answered"; if(h.includes("visitas agend")||h.includes("visita agend"))return "visits_scheduled";
  if(h.includes("visitas feitas")||h.includes("visitas realiz"))return "visits_completed"; if(h.includes("propostas emit")||h==="propostas")return "proposals";
  if(h.includes("vendas fech")||h==="vendas")return "sales"; return null;
}
async function readSheetSnapshot(sheetId:string){
  const csv=await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
  const rows=parseCsv(csv); const headerIndex=rows.findIndex(r=>norm(r[0])==="data"); const headers=headerIndex>=0?rows[headerIndex]:[];
  let lastDate:string|null=null,lastRow:string[]|null=null;
  for(const row of rows.slice(Math.max(0,headerIndex+1))){ const d=parsePtDate(row[0]); if(!d||!row.slice(2).some(v=>String(v??"").trim()!==""))continue; if(!lastDate||d>lastDate){lastDate=d;lastRow=row;} }
  const metrics:Row={}; if(lastRow) headers.forEach((h,i)=>{const k=metricKey(h);if(!k)return;const raw=String(lastRow![i]??"").trim().replace(',','.');if(raw!==""&&!Number.isNaN(Number(raw)))metrics[k]=Number(raw);});
  return {sheet_id:sheetId,last_date:lastDate,metrics};
}
async function sheetIdsUnder(folderId:string){
  const items=await publicDriveItems(folderId); const ids=items.filter(x=>x.kind==="sheet").map(x=>String(x.id));
  if(ids.length)return ids; const month=MONTH_NAMES[Number(localDate().slice(5,7))]||"";
  const child=items.find(x=>x.kind==="folder"&&norm(x.name)===norm(month)); if(!child)return [];
  return (await publicDriveItems(String(child.id))).filter(x=>x.kind==="sheet").map(x=>String(x.id));
}
function readNum(t:string, patterns:RegExp[], zero:RegExp[] = []) {
  for (const rx of zero) if (rx.test(t)) return 0;
  for (const rx of patterns) { const m=t.match(rx); if(m){ const n=Number(m[1]); if(Number.isFinite(n)&&n>=0) return n; } }
  return null;
}
function parseMetrics(raw:string) {
  const t=norm(raw).replace(/\s+/g," ");
  const m:Row={};
  m.leads_received=readNum(t,[/recebi\s+(\d+)\s+leads?/,/(\d+)\s+leads?\s+(?:recebidos?|entraram?)/,/leads?\s+recebidos?\D{0,8}(\d+)/]);
  m.leads_contacted=readNum(t,[/(?:acionei|atendi|contatei)\s+(\d+)(?:\s+leads?)?/,/(\d+)\s+leads?\s+(?:acionados?|atendidos?|contatados?)/],[/nenhum\s+lead\s+(?:acionado|atendido|contatado)/]);
  m.leads_in_conversation=readNum(t,[/(\d+)\s+leads?\s+(?:em\s+)?conversa/,/(?:conversando|em conversa)\s+com\s+(\d+)/],[/nenhum\s+(?:em\s+)?conversa/]);
  m.calls_made=readNum(t,[/(?:fiz|efetuei)\s+(\d+)\s+liga/,/(\d+)\s+ligacoes?\s+(?:feitas|efetuadas)/,/(\d+)\s+ligacoes?/]);
  m.calls_answered=readNum(t,[/(\d+)\s+(?:ligacoes?\s+)?(?:atendidas|atenderam)/,/liga(?:cao|coes)\s+atendidas?\D{0,8}(\d+)/],[/nenhuma\s+ligacao\s+atendida/]);
  m.visits_scheduled=readNum(t,[/(?:marquei|agendei)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:agendadas|marcadas)/],[/nenhuma\s+visita\s+(?:agendada|marcada)/]);
  m.visits_completed=readNum(t,[/(?:realizei|fiz)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:realizadas|feitas)/],[/nenhuma\s+visita\s+(?:realizada|feita)/]);
  m.proposals=readNum(t,[/(?:fiz|enviei|emiti)\s+(\d+)\s+propostas?/,/(\d+)\s+propostas?/],[/nenhuma\s+proposta/,/sem\s+proposta/]);
  m.sales=readNum(t,[/(?:vendi|fechei)\s+(\d+)/,/(\d+)\s+vendas?/],[/nenhuma\s+venda/,/sem\s+venda/]);
  m.properties_prospected=readNum(t,[/(?:captei|prospectei)\s+(\d+)/,/(\d+)\s+(?:captacoes?|imoveis?\s+(?:captados|prospectados))/],[/nenhuma\s+captacao/,/sem\s+captacao/]);
  m.properties_listed=readNum(t,[/cadastrei\s+(\d+)/,/(\d+)\s+(?:cadastros?|imoveis?\s+cadastrados)/],[/nenhum\s+cadastro/,/sem\s+cadastro/]);
  const numeric=Object.keys(m).filter(k=>m[k]!==null);
  return {metrics:m,found:numeric.length,confidence:Math.min(1,numeric.length/6)};
}


async function resolveSheetReport(client:Row){
  const root=String(client?.source_config?.drive_folder_id||"");
  if(!root)throw new Error("drive_folder_missing");
  const layout=String(client?.source_config?.drive_layout||"MONTH_SUBFOLDER").toUpperCase();
  const month=MONTH_NAMES[Number(localDate().slice(5,7))]||"";
  const rootItems=await publicDriveItems(root); const sources:Row[]=[];
  if(layout==="BROKER_FOLDERS"){
    for(const item of rootItems.filter(x=>x.kind==="folder")){
      const ids=await sheetIdsUnder(String(item.id));
      sources.push({name:String(item.name).replace(/^SDR\s+/i,""),folder_id:item.id,sheet_ids:ids});
    }
  }else{
    const monthFolder=rootItems.find(x=>x.kind==="folder"&&norm(x.name)===norm(month));
    const folderId=monthFolder?String(monthFolder.id):root;
    const items=monthFolder?await publicDriveItems(folderId):rootItems;
    for(const item of items.filter(x=>x.kind==="sheet")) sources.push({name:String(item.name),sheet_ids:[String(item.id)]});
  }

  return await Promise.all(sources.map(async(src)=>{
    const snaps=await Promise.all((src.sheet_ids||[]).map((id:string)=>readSheetSnapshot(id).catch(()=>({sheet_id:id,last_date:null,metrics:{}}))));
    const best=[...snaps].sort((a,b)=>String(b.last_date||"").localeCompare(String(a.last_date||"")))[0]||{sheet_id:null,last_date:null,metrics:{}};
    return {...src,last_date:best.last_date||null,metrics:best.metrics||{},sheet_id:best.sheet_id||src.sheet_ids?.[0]||null};
  }));
}
function sheetStatusMessage(rows:Row[]){
  const lines=[...rows].sort((a,b)=>norm(a.name).localeCompare(norm(b.name))).map(r=>
    r.last_date?`${String(r.name).toUpperCase()} Ãºltima atualizaÃ§Ã£o ${periodLabel(r.last_date,r.last_date)}`:`${String(r.name).toUpperCase()} nÃ£o atualizou a planilha`
  );
  return `Bom dia a todos time!\nSegue o relatÃ³rio das Ãºltimas atualizaÃ§Ãµes:\n\n${lines.join("\n")}`;
}

async function syncSheetBrokers(ops:any,client:Row,rows:Row[]){
  const {data:existing}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",client.id);
  const out:Row[]=[];
  for(const row of rows){
    const key=brokerKey(row.name); let broker=(existing||[]).find((b:Row)=>brokerKey(b.display_name)===key)||null;
    const meta={...(broker?.metadata||{}),source:"google_sheet",drive_folder_id:row.folder_id||null,sheet_id:row.sheet_id||null,sheet_ids:row.sheet_ids||[],last_sheet_sync_at:new Date().toISOString()};
    if(broker){
      const u=await ops.from("commercial_followup_brokers").update({active:true,legacy_last_reported_on:row.last_date,metadata:meta,updated_at:new Date().toISOString()}).eq("id",broker.id).select("*").single();
      broker=u.data||broker;
    }else{
      const i=await ops.from("commercial_followup_brokers").insert({followup_client_id:client.id,display_name:String(row.name).replace(/^SDR\s+/i,""),active:true,legacy_last_reported_on:row.last_date,metadata:meta}).select("*").single();
      broker=i.data;
    }
    if(broker)out.push({...broker,sheet_row:row});
  }
  return out;
}
function anomalies(metrics:Row) {
  const out:Row[]=[];
  const flag=(code:string,msg:string)=>out.push({code,severity:"REVISAR",message:msg});
  if(metrics.calls_answered!=null&&metrics.calls_made!=null&&metrics.calls_answered>metrics.calls_made) flag("CALLS_OVER_MADE","Ligações atendidas acima das ligações feitas.");
  if(metrics.visits_completed!=null&&metrics.visits_scheduled!=null&&metrics.visits_completed>metrics.visits_scheduled) flag("VISITS_OVER_SCHEDULED","Visitas realizadas acima das agendadas no mesmo reporte; pode incluir agenda anterior.");
  if(metrics.sales!=null&&metrics.proposals!=null&&metrics.sales>metrics.proposals) flag("SALES_OVER_PROPOSALS","Vendas acima das propostas no mesmo reporte; revisar janela temporal.");
  if(metrics.leads_contacted!=null&&metrics.leads_received!=null&&metrics.leads_contacted>metrics.leads_received) flag("CONTACTED_OVER_RECEIVED","Acionados acima dos leads recebidos; pode incluir carteira antiga.");
  return out;
}
function questionMessage(client:Row, periodStart:string, periodEnd:string, brokers:Row[]) {
  const q:string[]=Array.isArray(client.questions)?client.questions:[];
  const lines=q.filter(k=>k!=="notes").map((k,i)=>`${i+1}. ${METRIC_LABELS[k]||k}?`);
  if(q.includes("notes")) lines.push(`${lines.length+1}. Alguma observação importante?`);
  const names=brokers.map(b=>b.display_name).join(", ");
  return `Bom dia, time! 👋\n\nVamos fechar o acompanhamento comercial de *${periodLabel(periodStart,periodEnd)}*.\n\n${lines.join("\n")}\n\nCada corretor pode responder aqui no grupo, do seu jeito mesmo.\n\nAguardando: ${names}.`;
}

function fmtMetric(v:unknown){ return v===null||v===undefined||v===""?"não informado":String(v); }
function consolidatedMessage(client:Row, day:Row, entries:Row[]) {
  const q:string[]=Array.isArray(client.questions)?client.questions:[];
  const date=periodLabel(day.period_start||day.report_date,day.period_end||day.report_date);
  const blocks=entries.map(e=>{
    const b=e.commercial_followup_brokers||e.broker||{};
    if(e.status==="JUSTIFICADO") return `*${b.display_name||"Corretor"}* 🟦\nJustificado${e.notes?`: ${e.notes}`:""}`;
    if(e.status==="NAO_RESPONDEU"||e.status==="AGUARDANDO") return `*${b.display_name||"Corretor"}* ⚠️\nNão informou os dados dentro da janela.`;
    const metrics=e.metrics||{};
    const rows=q.filter(k=>k!=="notes").map(k=>`${METRIC_LABELS[k]||k}: ${fmtMetric(metrics[k])}`);
    return `*${b.display_name||"Corretor"}* ${e.status==="RESPONDIDO"?"✅":"🟡"}\n${rows.join(" | ")}`;
  });
  const responded=entries.filter(e=>e.status==="RESPONDIDO").length;
  const partial=entries.filter(e=>e.status==="PARCIAL").length;
  const expected=entries.filter(e=>e.status!=="JUSTIFICADO").length;
  const adherence=expected?Math.round((responded/expected)*100):100;
  return `📊 *Fechamento Comercial — ${client.display_name} | ${date}*\n\n${blocks.join("\n\n")}\n\n*Resumo do time*\nRespondidos: ${responded}/${expected}\nParciais: ${partial}\nAdesão: *${adherence}%*\n\nDados não informados não são tratados como zero.`;
}
async function ensureDays(ops:any) {
  const today=localDate(), dow=localWeekday(), nowIso=new Date().toISOString();
  const {data:clients}=await ops.from("commercial_followup_clients").select("*").eq("automation_enabled",true).neq("collection_mode","PLANTAO");
  const created:Row[]=[];
  for(const c of clients||[]){
    if(isSheetMode(c)) continue;
    const period=collectionPeriodForClient(c,today,dow); if(!period) continue;
    const reportDate=period.end;
    const goLive=String(c.source_config?.go_live||"");
    if(goLive&&today<goLive) continue;
    const {data:existing}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",c.id).eq("report_date",reportDate).maybeSingle();
    let day=existing;
    if(!day){
      const insert=await ops.from("commercial_followup_days").insert({followup_client_id:c.id,report_date:reportDate,period_start:period.start,period_end:period.end,scheduled_at:atLocal(today,String(c.checkin_time||"08:15")),source_payload:{generated_by:"daily_engine",generated_at:nowIso}}).select("*").single();
      day=insert.data;
      if(insert.error||!day) continue;
      created.push(day);
    }
    const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",c.id).eq("active",true);
    for(const b of brokers||[]){
      if(b.paused_until&&new Date(b.paused_until).getTime()>Date.now()) continue;
      await ops.from("commercial_followup_entries").upsert({followup_day_id:day.id,broker_id:b.id,status:"AGUARDANDO",updated_at:nowIso},{onConflict:"followup_day_id,broker_id",ignoreDuplicates:true});
    }
  }
  return created;
}


async function ensureClientDay(ops:any, slug:string) {
  const today=localDate(), dow=localWeekday();
  const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("slug",slug).maybeSingle();
  if(!c||!c.automation_enabled||c.collection_mode==="PLANTAO") return {skipped:"inactive"};
  const period=collectionPeriodForClient(c,today,dow); if(!period) return {skipped:"outside_schedule"};
  const goLive=String(c.source_config?.go_live||""); if(goLive&&today<goLive) return {skipped:"before_go_live"};
  const reportDate=period.end;
  let {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",c.id).eq("report_date",reportDate).maybeSingle();
  if(!day){ const x=await ops.from("commercial_followup_days").insert({followup_client_id:c.id,report_date:reportDate,period_start:period.start,period_end:period.end,scheduled_at:atLocal(today,String(c.checkin_time||"08:15")),source_payload:{generated_by:"event_scheduler",generated_at:new Date().toISOString()}}).select("*").single(); day=x.data; if(x.error||!day) return {skipped:"day_create_failed",error:x.error?.message}; }
  else if(!day.period_start||!day.period_end) await ops.from("commercial_followup_days").update({period_start:period.start,period_end:period.end,updated_at:new Date().toISOString()}).eq("id",day.id);
  const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",c.id).eq("active",true);
  const active=(brokers||[]).filter((b:Row)=>!b.paused_until||new Date(b.paused_until).getTime()<=Date.now());
  for(const b of active) await ops.from("commercial_followup_entries").upsert({followup_day_id:day.id,broker_id:b.id,status:"AGUARDANDO",updated_at:new Date().toISOString()},{onConflict:"followup_day_id,broker_id",ignoreDuplicates:true});
  return {client:c,day:{...day,period_start:day.period_start||period.start,period_end:day.period_end||period.end},brokers:active};
}

async function dispatchDue(db:any,ops:any) {
  const now=new Date().toISOString();
  const {data:days}=await ops.from("commercial_followup_days").select("*,commercial_followup_clients(*)").eq("status","SCHEDULED").lte("scheduled_at",now).order("scheduled_at").limit(20);
  const results:Row[]=[];
  for(const day of days||[]){
    const c=Array.isArray(day.commercial_followup_clients)?day.commercial_followup_clients[0]:day.commercial_followup_clients;
    if(!c?.automation_enabled||c.collection_mode==="PLANTAO"||isSheetMode(c)||!c.group_chat_id){ results.push({day_id:day.id,skipped:"not_ready"}); continue; }
    const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",c.id).eq("active",true);
    const active=(brokers||[]).filter((b:Row)=>!b.paused_until||new Date(b.paused_until).getTime()<=Date.now());
    if(!active.length){ results.push({day_id:day.id,skipped:"no_brokers"}); continue; }
    try{
      const sent=await zapiSend(db,c.group_chat_id,questionMessage(c,String(day.period_start||day.report_date),String(day.period_end||day.report_date),active));
      await ops.from("commercial_followup_days").update({status:"ASKED",asked_at:now,outbound_message_id:sent.message_id,updated_at:now}).eq("id",day.id);
      await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,event_type:"GROUP_CHECKIN_SENT",actor:"AUTOMATION",message_id:sent.message_id,payload:{group_chat_id:c.group_chat_id}});
      results.push({day_id:day.id,sent:true,message_id:sent.message_id});
    }catch(e){
      await ops.from("commercial_followup_days").update({status:"FAILED",source_payload:{...(day.source_payload||{}),dispatch_error:String(e)},updated_at:now}).eq("id",day.id);
      results.push({day_id:day.id,sent:false,error:String(e)});
    }
  }
  return results;
}


async function dispatchSheetClient(db:any,ops:any,client:Row,force=false){
  if(!client?.automation_enabled)return {skipped:"inactive"};
  if(!client.group_chat_id)return {skipped:"missing_group"};
  const today=localDate(), dow=localWeekday();
  if(![1,2,3,4,5].includes(dow))return {skipped:"outside_schedule"};
  const start=atLocal(today,"00:00:00");
  if(!force){
    const {data:prior}=await ops.from("commercial_followup_events").select("id").eq("followup_client_id",client.id).eq("event_type","SHEET_STATUS_SENT").gte("created_at",start).limit(1);
    if((prior||[]).length)return {skipped:"already_dispatched"};
  }
  const rows=await resolveSheetReport(client);
  if(!rows.length)return {skipped:"no_sheet_sources"};
  const brokers=await syncSheetBrokers(ops,client,rows);
  let {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",client.id).eq("report_date",today).maybeSingle();
  if(!day){
    const x=await ops.from("commercial_followup_days").insert({followup_client_id:client.id,report_date:today,period_start:today,period_end:today,scheduled_at:new Date().toISOString(),source_payload:{generated_by:"google_sheets_status",generated_at:new Date().toISOString()}}).select("*").single();
    day=x.data;
  }

  for(const b of brokers){
    if(!day)break;
    const r=b.sheet_row||{}; const provenance:Row={}; for(const k of Object.keys(r.metrics||{}))provenance[k]={source:"PLANILHA_GOOGLE",sheet_id:r.sheet_id,reported_on:r.last_date};
    await ops.from("commercial_followup_entries").upsert({followup_day_id:day.id,broker_id:b.id,status:r.last_date?"RESPONDIDO":"NAO_RESPONDEU",responded_at:r.last_date?`${r.last_date}T12:00:00-03:00`:null,metrics:r.metrics||{},provenance,notes:r.last_date?`Ãšltima atualizaÃ§Ã£o da planilha: ${periodLabel(r.last_date,r.last_date)}`:"Planilha sem preenchimento identificado",updated_at:new Date().toISOString()},{onConflict:"followup_day_id,broker_id"});
  }
  const message=sheetStatusMessage(rows); const sent=await zapiSend(db,client.group_chat_id,message); const now=new Date().toISOString();
  if(day)await ops.from("commercial_followup_days").update({status:"CLOSED",asked_at:now,closed_at:now,outbound_message_id:sent.message_id,consolidated_message_id:sent.message_id,source_payload:{...(day.source_payload||{}),sheet_rows:rows,source:"GOOGLE_SHEETS"},updated_at:now}).eq("id",day.id);
  await ops.from("commercial_followup_events").insert({followup_client_id:client.id,followup_day_id:day?.id||null,event_type:"SHEET_STATUS_SENT",actor:"AUTOMATION",message_id:sent.message_id,payload:{group_chat_id:client.group_chat_id,rows:rows.map(r=>({name:r.name,last_date:r.last_date,sheet_id:r.sheet_id}))}});
  return {sent:true,message_id:sent.message_id,day_id:day?.id||null,rows,message};
}
async function dispatchClient(db:any,ops:any,slug:string) {
  const {data:sheetClient}=await ops.from("commercial_followup_clients").select("*").eq("slug",slug).maybeSingle();
  if(sheetClient&&isSheetMode(sheetClient)) return await dispatchSheetClient(db,ops,sheetClient);
  const prepared:any=await ensureClientDay(ops,slug); if(prepared.skipped) return prepared;
  const {client:c,day,brokers}=prepared; if(!c.group_chat_id) return {skipped:"missing_group"};
  if(["ASKED","CLOSED"].includes(String(day.status))) return {skipped:"already_dispatched",day_id:day.id};
  const {data:priorSends}=await ops.from("commercial_followup_events").select("id").eq("followup_day_id",day.id).eq("event_type","GROUP_CHECKIN_SENT").limit(1);
  if((priorSends||[]).length) return {skipped:"already_dispatched",day_id:day.id};
  if(!brokers.length) return {skipped:"no_brokers",day_id:day.id};
  const sent=await zapiSend(db,c.group_chat_id,questionMessage(c,String(day.period_start||day.report_date),String(day.period_end||day.report_date),brokers));
  const now=new Date().toISOString();
  await ops.from("commercial_followup_days").update({status:"ASKED",asked_at:now,outbound_message_id:sent.message_id,updated_at:now}).eq("id",day.id);
  await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,event_type:"GROUP_CHECKIN_SENT",actor:"SCHEDULE",message_id:sent.message_id,payload:{group_chat_id:c.group_chat_id}});
  try{ await ops.rpc("schedule_commercial_followup_day_followups",{p_day_id:day.id}); }catch{}
  return {sent:true,day_id:day.id,message_id:sent.message_id,period_start:day.period_start,period_end:day.period_end};
}
async function openDayForClient(ops:any,slug:string) {
  const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("slug",slug).maybeSingle(); if(!c) return {skipped:"client_not_found"};
  const {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",c.id).eq("status","ASKED").order("asked_at",{ascending:false}).limit(1).maybeSingle();
  return day?{client:c,day}:{skipped:"no_open_day"};
}


async function ingestMessage(ops:any,messageId:string) {
  if(!messageId) return {skipped:"message_id_required"};
  const {data:rows}=await ops.from("whatsapp_messages").select("message_id,chat_id,event_at,sender_name,sender_phone,participant_phone,text_body,caption,from_me,is_group").eq("message_id",messageId).order("event_at",{ascending:false}).limit(1);
  const msg=rows?.[0]; if(!msg||msg.from_me||!msg.is_group) return {skipped:"irrelevant_message"};
  const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("group_chat_id",msg.chat_id).eq("automation_enabled",true).neq("collection_mode","PLANTAO").neq("collection_mode","PLANILHA").maybeSingle();
  if(!c) return {skipped:"group_not_configured"};
  const {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",c.id).eq("status","ASKED").lte("asked_at",msg.event_at).order("asked_at",{ascending:false}).limit(1).maybeSingle();
  if(!day) return {skipped:"no_open_day"};
  const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",c.id).eq("active",true);
  const senderPhone=digits(msg.participant_phone||msg.sender_phone); let broker=(brokers||[]).find((b:Row)=>digits(b.phone_e164)===senderPhone)||null;
  if(!broker){ const sn=norm(msg.sender_name); const matches=(brokers||[]).filter((b:Row)=>{const bn=norm(b.display_name),first=bn.split(" ")[0];return bn&&sn&&(sn.includes(bn)||(first.length>=4&&sn.includes(first)));}); if(matches.length===1) broker=matches[0]; }
  if(!broker) { await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,event_type:"UNMAPPED_GROUP_REPLY",actor:msg.sender_name||"UNKNOWN",message_id:msg.message_id,payload:{sender_phone:senderPhone}}); return {skipped:"broker_unmapped"}; }
  const {data:entry}=await ops.from("commercial_followup_entries").select("*").eq("followup_day_id",day.id).eq("broker_id",broker.id).maybeSingle(); if(!entry) return {skipped:"entry_not_found"};
  const ids=Array.isArray(entry.response_message_ids)?entry.response_message_ids:[]; if(ids.includes(msg.message_id)) return {skipped:"duplicate"};
  const raw=String(msg.text_body||msg.caption||"").trim(); if(!raw) return {skipped:"empty"};


  const parsed=parseMetrics(raw), merged={...(entry.metrics||{})}, provenance={...(entry.provenance||{})};
  for(const [k,v] of Object.entries(parsed.metrics)) if(v!==null){ merged[k]=v; provenance[k]={source:"DECLARADO_WHATSAPP",message_id:msg.message_id,at:msg.event_at}; }
  const required=(Array.isArray(c.questions)?c.questions:[]).filter((k:string)=>k!=="notes");
  const have=required.filter((k:string)=>merged[k]!==undefined&&merged[k]!==null).length;
  const complete=required.length?have>=Math.max(2,Math.ceil(required.length*.6)):parsed.found>=2;
  const update:Row={status:complete?"RESPONDIDO":"PARCIAL",first_response_at:entry.first_response_at||msg.event_at,responded_at:complete?msg.event_at:entry.responded_at,raw_response:[entry.raw_response,raw].filter(Boolean).join("\n---\n"),response_message_ids:[...ids,msg.message_id],metrics:merged,provenance,anomalies:anomalies(merged),notes:parsed.found===0?[entry.notes,raw].filter(Boolean).join(" | "):entry.notes,updated_at:new Date().toISOString()};
  await ops.from("commercial_followup_entries").update(update).eq("id",entry.id);
  if(!broker.phone_e164&&senderPhone.length>=10) await ops.from("commercial_followup_brokers").update({phone_e164:senderPhone,metadata:{...(broker.metadata||{}),phone_learned_from_group:true,phone_learned_at:msg.event_at},updated_at:new Date().toISOString()}).eq("id",broker.id);
  await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,broker_id:broker.id,event_type:complete?"BROKER_RESPONDED":"BROKER_PARTIAL",actor:broker.display_name,message_id:msg.message_id,payload:{found:parsed.found,confidence:parsed.confidence,metrics:parsed.metrics,source:"WHATSAPP_TRIGGER"}});
  return {processed:true,client:c.slug,broker:broker.display_name,status:update.status,message_id:msg.message_id};
}

async function ingestReplies(ops:any) {
  const {data:days}=await ops.from("commercial_followup_days").select("*,commercial_followup_clients(*)").eq("status","ASKED").gte("asked_at",new Date(Date.now()-48*3600000).toISOString());
  const results:Row[]=[];
  for(const day of days||[]){
    const c=Array.isArray(day.commercial_followup_clients)?day.commercial_followup_clients[0]:day.commercial_followup_clients;
    if(isSheetMode(c)||!c?.group_chat_id||!day.asked_at) continue;
    const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",c.id).eq("active",true);
    const {data:entries}=await ops.from("commercial_followup_entries").select("*").eq("followup_day_id",day.id);
    const byPhone=new Map<string,Row>();
    for(const b of brokers||[]) if(digits(b.phone_e164)) byPhone.set(digits(b.phone_e164),b);
    const {data:msgs}=await ops.from("whatsapp_messages").select("message_id,event_at,sender_name,sender_phone,participant_phone,text_body,caption,from_me").eq("chat_id",c.group_chat_id).eq("is_group",true).eq("from_me",false).gte("event_at",day.asked_at).order("event_at").limit(300);
    for(const msg of msgs||[]){
      const raw=String(msg.text_body||msg.caption||"").trim();
      if(!raw||!msg.message_id) continue;
      const senderPhone=digits(msg.participant_phone||msg.sender_phone);
      let broker=byPhone.get(senderPhone)||null;
      if(!broker){
        const sn=norm(msg.sender_name);
        const candidates=(brokers||[]).filter((b:Row)=>{ const bn=norm(b.display_name); const first=bn.split(" ")[0]; return bn&&sn&&(sn.includes(bn)||(first.length>=4&&sn.includes(first))); });
        if(candidates.length===1) broker=candidates[0];
      }
      if(!broker) continue;
      const entry=(entries||[]).find((e:Row)=>e.broker_id===broker.id);
      if(!entry) continue;
      const ids=Array.isArray(entry.response_message_ids)?entry.response_message_ids:[];
      if(ids.includes(msg.message_id)) continue;
      const parsed=parseMetrics(raw), merged={...(entry.metrics||{})}, provenance={...(entry.provenance||{})};
      for(const [k,v] of Object.entries(parsed.metrics)) if(v!==null){ merged[k]=v; provenance[k]={source:"DECLARADO_WHATSAPP",message_id:msg.message_id,at:msg.event_at}; }
      const required=(Array.isArray(c.questions)?c.questions:[]).filter((k:string)=>k!=="notes");
      const have=required.filter((k:string)=>merged[k]!==undefined&&merged[k]!==null).length;
      const complete=required.length ? have>=Math.max(2,Math.ceil(required.length*.6)) : parsed.found>=2;
      const currentRaw=[entry.raw_response,raw].filter(Boolean).join("\n---\n");
      const update:Row={status:complete?"RESPONDIDO":"PARCIAL",first_response_at:entry.first_response_at||msg.event_at,responded_at:complete?msg.event_at:entry.responded_at,raw_response:currentRaw,response_message_ids:[...ids,msg.message_id],metrics:merged,provenance,anomalies:anomalies(merged),notes:parsed.found===0?[entry.notes,raw].filter(Boolean).join(" | "):entry.notes,updated_at:new Date().toISOString()};
      await ops.from("commercial_followup_entries").update(update).eq("id",entry.id);
      if(!broker.phone_e164&&senderPhone.length>=10) await ops.from("commercial_followup_brokers").update({phone_e164:senderPhone,metadata:{...(broker.metadata||{}),phone_learned_from_group:true,phone_learned_at:msg.event_at},updated_at:new Date().toISOString()}).eq("id",broker.id);
      await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,broker_id:broker.id,event_type:complete?"BROKER_RESPONDED":"BROKER_PARTIAL",actor:broker.display_name,message_id:msg.message_id,payload:{found:parsed.found,confidence:parsed.confidence,metrics:parsed.metrics}});
      Object.assign(entry,update); results.push({client:c.slug,broker:broker.display_name,status:update.status,message_id:msg.message_id});
    }
  }
  return results;
}
async function sendReminders(db:any,ops:any,onlySlug?:string) {
  const {data:days}=await ops.from("commercial_followup_days").select("*,commercial_followup_clients(*)").eq("status","ASKED").is("reminder_message_id",null).not("asked_at","is",null);
  const out:Row[]=[];
  for(const day of days||[]){
    const c=Array.isArray(day.commercial_followup_clients)?day.commercial_followup_clients[0]:day.commercial_followup_clients;
    if(isSheetMode(c)) continue;
    if(onlySlug&&c?.slug!==onlySlug) continue;
    const cutoff=new Date(day.asked_at).getTime()+Number(c?.reminder_after_minutes||120)*60000;
    if(Date.now()<cutoff||!c?.group_chat_id) continue;
    const {data:entries}=await ops.from("commercial_followup_entries").select("status,commercial_followup_brokers(display_name,phone_e164)").eq("followup_day_id",day.id).in("status",["AGUARDANDO","PARCIAL"]);
    const pending=(entries||[]).map((e:Row)=>Array.isArray(e.commercial_followup_brokers)?e.commercial_followup_brokers[0]:e.commercial_followup_brokers).filter(Boolean);
    if(!pending.length){ await ops.from("commercial_followup_days").update({reminder_at:new Date().toISOString(),reminder_message_id:"NOT_NEEDED",updated_at:new Date().toISOString()}).eq("id",day.id); continue; }
    const names=pending.map((b:Row)=>b.display_name).join(", ");
    const message=`⏰ Pessoal, ainda faltam os retornos de *${names}* para fecharmos o acompanhamento comercial de ${periodLabel(day.period_start||day.report_date,day.period_end||day.report_date)}.\n\nQuem já começou a responder e ficou com dados parciais pode completar aqui mesmo.`;
    try{
      const sent=await zapiSend(db,c.group_chat_id,message,pending.map((b:Row)=>b.phone_e164).filter(Boolean));
      const now=new Date().toISOString();
      await ops.from("commercial_followup_days").update({reminder_at:now,reminder_message_id:sent.message_id,updated_at:now}).eq("id",day.id);
      await ops.from("commercial_followup_entries").update({reminder_sent_at:now,updated_at:now}).eq("followup_day_id",day.id).in("status",["AGUARDANDO","PARCIAL"]);
      await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,event_type:"GROUP_REMINDER_SENT",actor:"AUTOMATION",message_id:sent.message_id,payload:{pending:names}});
      out.push({day_id:day.id,sent:true,pending:names});
    }catch(e){ out.push({day_id:day.id,sent:false,error:String(e)}); }
  }
  return out;
}

async function closeDue(db:any,ops:any,onlySlug?:string) {
  const {data:days}=await ops.from("commercial_followup_days").select("*,commercial_followup_clients(*)").eq("status","ASKED").not("asked_at","is",null);
  const out:Row[]=[];
  for(const day of days||[]){
    const c=Array.isArray(day.commercial_followup_clients)?day.commercial_followup_clients[0]:day.commercial_followup_clients;
    if(isSheetMode(c)) continue;
    if(onlySlug&&c?.slug!==onlySlug) continue;
    const cutoff=new Date(day.asked_at).getTime()+Number(c?.close_after_minutes||240)*60000;
    if(Date.now()<cutoff) continue;
    const now=new Date().toISOString();
    await ops.from("commercial_followup_entries").update({status:"NAO_RESPONDEU",updated_at:now}).eq("followup_day_id",day.id).eq("status","AGUARDANDO");
    await ops.from("commercial_followup_days").update({status:"CLOSED",closed_at:now,updated_at:now}).eq("id",day.id);
    await ops.from("commercial_followup_events").insert({followup_client_id:c?.id||null,followup_day_id:day.id,event_type:"DAY_CLOSED_SILENT",actor:"AUTOMATION",payload:{automatic_message_sent:false}});
    out.push({day_id:day.id,closed:true,silent:true});
  }
  return out;
}

function weeklyText(client:Row, rows:Row[], from:string, to:string) {
  const keys=(Array.isArray(client.questions)?client.questions:[]).filter((k:string)=>k!=="notes");
  const totals:Row={}; for(const k of keys) totals[k]=0;
  const brokerMap=new Map<string,Row>();
  for(const e of rows){
    const b=e.commercial_followup_brokers||{}; const name=b.display_name||"Corretor";
    const s=brokerMap.get(name)||{name,expected:0,responded:0,metrics:{}};
    if(e.status!=="JUSTIFICADO") s.expected++;
    if(e.status==="RESPONDIDO") s.responded++;
    for(const k of keys){ const v=Number(e.metrics?.[k]); if(Number.isFinite(v)){ totals[k]=(totals[k]||0)+v; s.metrics[k]=(s.metrics[k]||0)+v; } }
    brokerMap.set(name,s);
  }
  const teamRows=keys.map(k=>`${METRIC_LABELS[k]||k}: ${totals[k]||0}`);
  const brokers=[...brokerMap.values()].sort((a,b)=>((b.responded/Math.max(1,b.expected))-(a.responded/Math.max(1,a.expected))));
  const adherence=brokers.map(b=>`${b.name}: ${b.expected?Math.round(100*b.responded/b.expected):100}%`).join(" | ");
  const ratios:Row[]=[];
  const pushRatio=(label:string,a:string,b:string)=>{ const den=Number(totals[b]||0), num=Number(totals[a]||0); if(den>0) ratios.push({label,value:num/den}); };
  pushRatio("Acionamento","leads_contacted","leads_received"); pushRatio("Atendimento de ligações","calls_answered","calls_made");
  pushRatio("Lead → visita","visits_scheduled","leads_contacted"); pushRatio("Visita → proposta","proposals","visits_completed"); pushRatio("Proposta → venda","sales","proposals");
  const bottleneck=ratios.sort((a,b)=>a.value-b.value)[0];
  const ranking=client.expose_ranking&&brokers.length?`\n\n*Adesão ao reporte*\n${adherence}`:"";
  const gap=bottleneck?`\n\n*Gargalo principal detectado*\n${bottleneck.label}: ${Math.round(bottleneck.value*100)}%`:"";
  return `📈 *Resumo semanal — ${client.display_name}*\n${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")}\n\n*Totais do time*\n${teamRows.join("\n")}${ranking}${gap}\n\nOrigem: respostas comerciais registradas no acompanhamento. Dados não informados não entram como zero individual.`;
}

async function sendWeekly(db:any,ops:any,onlySlug?:string) {
  const today=localDate(), dow=localWeekday();
  const {data:clients}=await ops.from("commercial_followup_clients").select("*").eq("automation_enabled",true).neq("collection_mode","PLANTAO");
  const out:Row[]=[];
  for(const c of clients||[]){
    if(isSheetMode(c)) continue;
    if(onlySlug&&c.slug!==onlySlug) continue;
    if(Number(c.weekly_report_dow)!==dow||!c.group_chat_id) continue;
    if(Date.now()<new Date(atLocal(today,String(c.weekly_report_time||"17:30"))).getTime()) continue;
    const {data:events}=await ops.from("commercial_followup_events").select("id,payload,created_at").eq("followup_client_id",c.id).eq("event_type","WEEKLY_REPORT_SENT").gte("created_at",atLocal(today,"00:00:00"));
    if((events||[]).length) continue;
    const from=shiftDate(today,-6);
    const {data:days}=await ops.from("commercial_followup_days").select("id").eq("followup_client_id",c.id).gte("report_date",from).lte("report_date",today);
    const ids=(days||[]).map((d:Row)=>d.id); if(!ids.length) continue;
    const {data:entries}=await ops.from("commercial_followup_entries").select("status,metrics,commercial_followup_brokers(display_name)").in("followup_day_id",ids);
    if(!(entries||[]).length) continue;
    try{ const sent=await zapiSend(db,c.group_chat_id,weeklyText(c,entries||[],from,today)); await ops.from("commercial_followup_events").insert({followup_client_id:c.id,event_type:"WEEKLY_REPORT_SENT",actor:"AUTOMATION",message_id:sent.message_id,payload:{week_start:from,week_end:today}}); out.push({client:c.slug,sent:true}); }
    catch(e){ out.push({client:c.slug,sent:false,error:String(e)}); }
  }
  return out;
}
async function dashboardPayload(ops:any) {
  const since=shiftDate(localDate(),-30);
  const [clients,brokers,days,viewCfg,viewMonitor]=await Promise.all([
    ops.from("commercial_followup_clients").select("*").order("display_name"),
    ops.from("commercial_followup_brokers").select("*").order("display_name"),
    ops.from("commercial_followup_days").select("*").gte("report_date",since).order("report_date",{ascending:false}).limit(300),
    ops.from("view_oncall_config").select("config_key,config_value"),
    ops.from("view_oncall_response_monitor").select("*").gte("shift_date",shiftDate(localDate(),-14)).order("sent_at",{ascending:false,nullsFirst:false}).limit(300),
  ]);
  const dayIds=(days.data||[]).map((d:Row)=>d.id);
  let entries:Row[]=[];
  if(dayIds.length){ const r=await ops.from("commercial_followup_entries").select("*,commercial_followup_brokers(display_name,phone_e164,paused_until,pause_reason,legacy_last_reported_on)").in("followup_day_id",dayIds).order("updated_at",{ascending:false}); entries=r.data||[]; }
  const events=await ops.from("commercial_followup_events").select("*").gte("created_at",new Date(Date.now()-30*86400000).toISOString()).order("created_at",{ascending:false}).limit(300);
  const portalAccess=await ops.from("commercial_portal_access").select("id,auth_user_id,followup_client_id,broker_id,portal_role,display_name,email,active,created_at,updated_at").order("created_at",{ascending:false});
  return {clients:clients.data||[],brokers:brokers.data||[],days:days.data||[],entries,events:events.data||[],portal_access:portalAccess.data||[],view_adapter:{config:Object.fromEntries((viewCfg.data||[]).map((x:Row)=>[x.config_key,x.config_value])),monitor:viewMonitor.data||[]}};
}

async function runTick(db:any,ops:any) {
  const created=await ensureDays(ops);
  const dispatched=await dispatchDue(db,ops);
  const ingested=await ingestReplies(ops);
  const closed=await closeDue(db,ops);
  return {created:created.length,dispatched,ingested,reminders:[],closed,weekly:[]};
}

Deno.serve(async(req)=>{
  const origin=req.headers.get("origin");
  if(req.method==="OPTIONS") return json({ok:true},200,origin);
  if(origin&&!ORIGINS.has(origin)) return json({error:"origin_not_allowed"},403,origin);
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const autoSecret=Deno.env.get("VIEW_ONCALL_AUTOMATION_SECRET")||Deno.env.get("OPS_AUDIT_SECRET")||Deno.env.get("DASHBOARD_SECRET");
  if(!url||!anon||!service) return json({error:"server_configuration"},500,origin);
  const authHeader=req.headers.get("authorization")||"";
  const automation=authHeader===`Bearer ${service}`||!!autoSecret&&req.headers.get("x-automation-secret")===autoSecret;
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}), ops=db.schema("agency_ops");
  let actor="AUTOMATION", role="AUTOMATION";
  if(!automation){
    if(!authHeader.startsWith("Bearer ")) return json({error:"unauthorized"},401,origin);
    const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}}); const {data:u}=await auth.auth.getUser();
    if(!u?.user) return json({error:"unauthorized"},401,origin);
    const {data:p}=await ops.from("user_preferences").select("collaborator_person").eq("user_key",u.user.id).maybeSingle(); actor=String(p?.collaborator_person||"");
    const {data:r}=await ops.from("team_roster").select("role,is_former").eq("person",actor).maybeSingle(); role=String(r?.role||"").toUpperCase();
    if(!actor||!r||r.is_former||!["MGMT","CS"].includes(role)) return json({error:"forbidden"},403,origin);
  }
  if(req.method==="GET") return json({ok:true,actor,role,...await dashboardPayload(ops)},200,origin);
  if(req.method!=="POST") return json({error:"method_not_allowed"},405,origin);
  const body=await req.json().catch(()=>({})), action=String(body.action||"");
  if(action==="preview_sheet_client"){
    if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin);
    const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("slug",String(body.slug||"")).maybeSingle();
    if(!c||!isSheetMode(c)) return json({error:"sheet_client_not_found"},404,origin);
    const rows=await resolveSheetReport(c); return json({ok:true,client:c.slug,rows,message:sheetStatusMessage(rows)},200,origin);
  }
  if(action==="dispatch_client"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,...await dispatchClient(db,ops,String(body.slug||""))},200,origin); }
  if(action==="remind_client"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,results:await sendReminders(db,ops,String(body.slug||""))},200,origin); }
  if(action==="close_client"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,results:await closeDue(db,ops,String(body.slug||""))},200,origin); }
  if(action==="weekly_client"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,results:await sendWeekly(db,ops,String(body.slug||""))},200,origin); }
  if(action==="ingest_message"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,...await ingestMessage(ops,String(body.message_id||""))},200,origin); }
  if(action==="tick"){ if(!automation&&role!=="MGMT") return json({error:"forbidden"},403,origin); return json({ok:true,...await runTick(db,ops)},200,origin); }
  if(action==="set_automation"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const id=String(body.id||""); if(!id) return json({error:"id_required"},400,origin);
    const enabled=body.enabled===true;
    const {data:current,error:readError}=await ops.from("commercial_followup_clients").select("*").eq("id",id).maybeSingle();
    if(readError||!current) return json({error:readError?.message||"client_not_found"},404,origin);
    if(enabled&&["GRUPO_MANUAL","PLANILHA"].includes(current.collection_mode)&&!current.group_chat_id) return json({error:"commercial_group_required"},409,origin);
    const now=new Date().toISOString();
    const {data,error}=await ops.from("commercial_followup_clients").update({automation_enabled:enabled,updated_at:now}).eq("id",id).select("*").maybeSingle();
    if(error||!data) return json({error:error?.message||"automation_update_failed"},400,origin);
    if(data.slug==="view-imoveis"){
      const {error:viewError}=await ops.from("view_oncall_config").upsert({config_key:"automation_enabled",config_value:enabled,updated_at:now},{onConflict:"config_key"});
      if(viewError){
        await ops.from("commercial_followup_clients").update({automation_enabled:current.automation_enabled,updated_at:new Date().toISOString()}).eq("id",id);
        return json({error:`view_automation_sync_failed:${viewError.message}`},500,origin);
      }
    }else{
      try{ await ops.rpc("sync_commercial_followup_schedule",{p_client_id:id}); }catch{}
    }
    try{ await ops.from("commercial_followup_events").insert({followup_client_id:id,event_type:enabled?"AUTOMATION_ENABLED":"AUTOMATION_DISABLED",actor,payload:{source:"dashboard",enabled}}); }catch{}
    return json({ok:true,client:data,automation_enabled:enabled},200,origin);
  }

  if(action==="update_client"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const id=String(body.id||""); if(!id) return json({error:"id_required"},400,origin);
    const allowed=["collection_mode","automation_enabled","group_chat_id","group_chat_name","checkin_time","reminder_after_minutes","close_after_minutes","weekly_report_dow","weekly_report_time","expose_individual_metrics","expose_ranking","questions","portal_enabled","portal_settings","portal_brand"];
    const patch:Row={updated_at:new Date().toISOString()}; for(const k of allowed) if(body[k]!==undefined) patch[k]=body[k];
    if(patch.automation_enabled===true){ const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("id",id).maybeSingle(); const mode=patch.collection_mode||c?.collection_mode, group=patch.group_chat_id??c?.group_chat_id; if(["GRUPO_MANUAL","PLANILHA"].includes(mode)&&!group) return json({error:"commercial_group_required"},409,origin); }
    const {data,error}=await ops.from("commercial_followup_clients").update(patch).eq("id",id).select("*").maybeSingle();
    if(!error&&data){ try{ await ops.rpc("sync_commercial_followup_schedule",{p_client_id:id}); }catch{} }
    return error?json({error:error.message},400,origin):json({ok:true,client:data},200,origin);
  }

  if(action==="upsert_broker"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const followup_client_id=String(body.followup_client_id||""), display_name=String(body.display_name||"").trim();
    if(!followup_client_id||!display_name) return json({error:"client_and_name_required"},400,origin);
    let phone=digits(body.phone_e164); if(phone.length===11&&!phone.startsWith("55")) phone=`55${phone}`;
    const payload:Row={followup_client_id,display_name,phone_e164:phone||null,active:body.active!==false,external_crm_id:body.external_crm_id||null,metadata:body.metadata||{},updated_at:new Date().toISOString()};
    const {data,error}=await ops.from("commercial_followup_brokers").upsert(payload,{onConflict:"followup_client_id,display_name"}).select("*").single();
    return error?json({error:error.message},400,origin):json({ok:true,broker:data},200,origin);
  }

  if(action==="pause_broker"){
    if(!["MGMT","CS"].includes(role)&&!automation) return json({error:"forbidden"},403,origin);
    const id=String(body.id||""); if(!id) return json({error:"id_required"},400,origin);
    const until=body.paused_until?new Date(body.paused_until).toISOString():null, reason=String(body.pause_reason||"").trim()||null;
    const {data,error}=await ops.from("commercial_followup_brokers").update({paused_until:until,pause_reason:reason,updated_at:new Date().toISOString()}).eq("id",id).select("*").maybeSingle();
    return error?json({error:error.message},400,origin):json({ok:true,broker:data},200,origin);
  }

  if(action==="justify_entry"){
    if(!["MGMT","CS"].includes(role)&&!automation) return json({error:"forbidden"},403,origin);
    const id=String(body.id||""), notes=String(body.notes||"").trim(); if(!id||!notes) return json({error:"id_and_notes_required"},400,origin);
    const {data,error}=await ops.from("commercial_followup_entries").update({status:"JUSTIFICADO",notes,updated_at:new Date().toISOString()}).eq("id",id).select("*").maybeSingle();
    return error?json({error:error.message},400,origin):json({ok:true,entry:data},200,origin);
  }
  if(action==="manual_entry"){
    if(!["MGMT","CS"].includes(role)&&!automation) return json({error:"forbidden"},403,origin);
    const id=String(body.id||""); if(!id) return json({error:"id_required"},400,origin);
    const {data:current}=await ops.from("commercial_followup_entries").select("*").eq("id",id).maybeSingle(); if(!current) return json({error:"entry_not_found"},404,origin);
    const metrics={...(current.metrics||{}),...(body.metrics||{})}, provenance={...(current.provenance||{})};
    for(const k of Object.keys(body.metrics||{})) provenance[k]={source:"AJUSTE_MANUAL",actor,at:new Date().toISOString()};
    const {data,error}=await ops.from("commercial_followup_entries").update({metrics,provenance,anomalies:anomalies(metrics),status:body.status||"RESPONDIDO",notes:body.notes??current.notes,responded_at:current.responded_at||new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).select("*").maybeSingle();
    await ops.from("commercial_followup_events").insert({followup_day_id:current.followup_day_id,broker_id:current.broker_id,event_type:"MANUAL_ENTRY_UPDATED",actor,payload:{metrics:body.metrics||{},notes:body.notes||null}});
    return error?json({error:error.message},400,origin):json({ok:true,entry:data},200,origin);
  }

  if(action==="create_client"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const display_name=String(body.display_name||"").trim(), slug=norm(body.slug||display_name).replace(/\s+/g,"-");
    if(!display_name||!slug) return json({error:"name_required"},400,origin);
    const payload={client_id:body.client_id||null,slug,display_name,collection_mode:body.collection_mode||"GRUPO_MANUAL",automation_enabled:false,group_chat_id:body.group_chat_id||null,group_chat_name:body.group_chat_name||null,connected_phone:"5513988051839",checkin_time:body.checkin_time||"09:00",questions:Array.isArray(body.questions)?body.questions:Object.keys(METRIC_LABELS),source_config:{created_from_dashboard:true}};
    const {data,error}=await ops.from("commercial_followup_clients").insert(payload).select("*").single();
    return error?json({error:error.message},400,origin):json({ok:true,client:data},201,origin);
  }

  if(action==="send_group_now"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const clientId=String(body.followup_client_id||""); const reportDate=String(body.report_date||shiftDate(localDate(),-1)); const periodStart=String(body.period_start||reportDate), periodEnd=String(body.period_end||reportDate);
    const {data:c}=await ops.from("commercial_followup_clients").select("*").eq("id",clientId).maybeSingle(); if(!c?.group_chat_id) return json({error:"commercial_group_required"},409,origin);
    if(isSheetMode(c)) return json({ok:true,...await dispatchSheetClient(db,ops,c,true)},200,origin);
    const {data:brokers}=await ops.from("commercial_followup_brokers").select("*").eq("followup_client_id",clientId).eq("active",true);
    let {data:day}=await ops.from("commercial_followup_days").select("*").eq("followup_client_id",clientId).eq("report_date",reportDate).maybeSingle();
    if(!day){ const x=await ops.from("commercial_followup_days").insert({followup_client_id:clientId,report_date:reportDate,period_start:periodStart,period_end:periodEnd,scheduled_at:new Date().toISOString()}).select("*").single(); day=x.data; }
    for(const b of brokers||[]) await ops.from("commercial_followup_entries").upsert({followup_day_id:day.id,broker_id:b.id,status:"AGUARDANDO",updated_at:new Date().toISOString()},{onConflict:"followup_day_id,broker_id",ignoreDuplicates:true});
    const sent=await zapiSend(db,c.group_chat_id,questionMessage(c,periodStart,periodEnd,brokers||[])); const now=new Date().toISOString();
    await ops.from("commercial_followup_days").update({status:"ASKED",asked_at:now,outbound_message_id:sent.message_id,updated_at:now}).eq("id",day.id);
    try{ await ops.rpc("schedule_commercial_followup_day_followups",{p_day_id:day.id}); }catch{}
    return json({ok:true,sent:true,message_id:sent.message_id,day_id:day.id},200,origin);
  }
  if(action==="resend_summary"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const dayId=String(body.day_id||""); if(!dayId) return json({error:"day_id_required"},400,origin);
    const {data:day}=await ops.from("commercial_followup_days").select("*,commercial_followup_clients(*)").eq("id",dayId).maybeSingle();
    const c=Array.isArray(day?.commercial_followup_clients)?day.commercial_followup_clients[0]:day?.commercial_followup_clients;
    if(!day||!c?.group_chat_id) return json({error:"day_or_group_not_found"},404,origin);
    const {data:entries}=await ops.from("commercial_followup_entries").select("*,commercial_followup_brokers(display_name,phone_e164)").eq("followup_day_id",day.id).order("created_at");
    const sent=await zapiSend(db,c.group_chat_id,consolidatedMessage(c,day,entries||[]));
    await ops.from("commercial_followup_days").update({consolidated_message_id:sent.message_id,updated_at:new Date().toISOString()}).eq("id",day.id);
    await ops.from("commercial_followup_events").insert({followup_client_id:c.id,followup_day_id:day.id,event_type:"GROUP_SUMMARY_RESENT",actor,message_id:sent.message_id,payload:{}});
    return json({ok:true,sent:true,message_id:sent.message_id},200,origin);
  }

  if(action==="provision_portal_user"){
    if(role!=="MGMT"&&!automation) return json({error:"forbidden"},403,origin);
    const clientId=String(body.followup_client_id||""), email=String(body.email||"").trim().toLowerCase(), portalRole=String(body.portal_role||"MANAGER").toUpperCase();
    if(!clientId||!email||!["OWNER","MANAGER","BROKER"].includes(portalRole)) return json({error:"invalid_portal_user"},400,origin);
    const brokerId=body.broker_id?String(body.broker_id):null;
    if(portalRole==="BROKER"&&!brokerId) return json({error:"broker_required"},400,origin);
    const password=String(body.password||randomSecret());
    let authUser:any=null, createdNew=false;
    const created=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{commercial_portal:true,followup_client_id:clientId,portal_role:portalRole}});
    if(!created.error&&created.data.user){authUser=created.data.user;createdNew=true;}
    else {
      const listed=await db.auth.admin.listUsers({page:1,perPage:1000});
      authUser=(listed.data?.users||[]).find((u:any)=>String(u.email||"").toLowerCase()===email)||null;
      if(!authUser) return json({error:created.error?.message||"auth_user_create_failed"},400,origin);
    }
    const payload={auth_user_id:authUser.id,followup_client_id:clientId,broker_id:brokerId,portal_role:portalRole,display_name:String(body.display_name||authUser.email||"Usuário"),email,active:true,updated_at:new Date().toISOString()};
    const {data:access,error}=await ops.from("commercial_portal_access").upsert(payload,{onConflict:"auth_user_id,followup_client_id"}).select("*").single();
    if(error)return json({error:error.message},400,origin);
    return json({ok:true,access,created_new:createdNew,temporary_password:createdNew?password:null,portal_url:`https://agency-ops-dashboard.lakassessoriadigital.workers.dev/commercial-portal?client=${clientId}`},200,origin);
  }

  if(action==="generate_magic_link"){
    if(!["MGMT","CS"].includes(role)&&!automation) return json({error:"forbidden"},403,origin);
    const clientId=String(body.followup_client_id||""), brokerId=String(body.broker_id||"");
    if(!clientId||!brokerId)return json({error:"client_and_broker_required"},400,origin);
    const {data:b}=await ops.from("commercial_followup_brokers").select("id").eq("id",brokerId).eq("followup_client_id",clientId).maybeSingle();
    if(!b)return json({error:"broker_not_found"},404,origin);
    const rawBytes=new Uint8Array(24);crypto.getRandomValues(rawBytes);
    const token=btoa(String.fromCharCode(...rawBytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
    const hash=await sha256(token), reportDate=String(body.report_date||reportPeriodForCollectionDay(localDate(),localWeekday()).end).slice(0,10);
    const expiresAt=new Date(Date.now()+Number(body.expires_hours||72)*3600000).toISOString();
    const {data:link,error}=await ops.from("commercial_portal_magic_links").insert({token_hash:hash,followup_client_id:clientId,broker_id:brokerId,report_date:reportDate,expires_at:expiresAt,created_by:actor,metadata:{source:"dashboard"}}).select("id,report_date,expires_at").single();
    if(error)return json({error:error.message},400,origin);
    return json({ok:true,link,portal_url:`https://agency-ops-dashboard.lakassessoriadigital.workers.dev/commercial-portal?t=${token}`},200,origin);
  }

  if(action==="set_portal_access_active"){
    if(role!=="MGMT"&&!automation)return json({error:"forbidden"},403,origin);
    const id=String(body.id||"");if(!id)return json({error:"id_required"},400,origin);
    const {data:access,error}=await ops.from("commercial_portal_access").update({active:body.active===true,updated_at:new Date().toISOString()}).eq("id",id).select("*").maybeSingle();
    return error?json({error:error.message},400,origin):json({ok:true,access},200,origin);
  }

  return json({error:"unknown_action"},400,origin);
});
