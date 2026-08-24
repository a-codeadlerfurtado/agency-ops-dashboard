import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PARENT_PAGE_ID = "2e87ee8b-5903-802d-b747-fb71c49eb832";
const NOTION_VERSION = "2022-06-28";
const CLOSER_OWNERS = new Set(["Vitor Feitoza", "Leonardo Augusto"]);
const CLOSER_SPEAKERS = new Set(["vitor feitoza", "luiz vitor feitoza", "leonardo augusto"]);
const OUT = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const GENERIC = new Set(["imoveis","imovel","imobiliaria","imobiliario","imobiliarios","corretor","corretora","negocios","consultoria","empreendimentos","residencial","ltda"]);

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: OUT });
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (v: unknown, max = 1800) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1) + "…" : s; };
const safeEqual = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i=0;i<a.length;i++) d |= a.charCodeAt(i)^b.charCodeAt(i); return d === 0; };
const coreTokens = (v: unknown) => norm(v).split(" ").filter(x => x.length >= 3 && !GENERIC.has(x));
const coreName = (v: unknown) => coreTokens(v).join(" ");
const iso = () => new Date().toISOString();

async function sha256(v: unknown) {
  const raw = new TextEncoder().encode(JSON.stringify(v));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
}
function pageMatchScore(names: string[], title: string) {
  let best = 0;
  for (const name of names) {
    const c = coreName(name), t = coreName(title); if (!c || !t) continue;
    if (c === t) best = Math.max(best,100);
    else if (c.length >= 5 && (t.includes(c) || c.includes(t))) best = Math.max(best,92);
    else {
      const a = new Set(coreTokens(name)), b = new Set(coreTokens(title));
      const inter = [...a].filter(x=>b.has(x)); const union = new Set([...a,...b]).size;
      if (inter.length >= 2 && inter.length/Math.max(1,union) >= .66) best = Math.max(best,85);
      else if (a.size === 1 && b.has([...a][0]) && [...a][0].length >= 6) best = Math.max(best,82);
    }
  }
  return best;
}
function transcriptScore(row:any, names:string[]) {
  let score = 0;
  if (row.client_id && row._clientId === row.client_id) score += 120;
  const title = norm(row.metadata?.donnah_title || row.source_file_name || "");
  const participants = norm(JSON.stringify(row.participants || []));
  const summary = norm(row.metadata?.donnah_summary || row.summary || "");
  for (const name of names) {
    const c = coreName(name); if (!c) continue;
    if (title.includes(c)) score = Math.max(score,65);
    if (participants.includes(c)) score = Math.max(score,60);
    if (summary.includes(c)) score = Math.max(score,30);
    let tokenScore = 0;
    for (const t of coreTokens(name)) {
      if (t.length < 4) continue;
      if (title.includes(t)) tokenScore += 10;
      if (participants.includes(t)) tokenScore += 10;
      if (summary.includes(t)) tokenScore += 3;
    }
    score = Math.max(score, tokenScore);
  }
  return score;
}
function parseUtterances(text:string) {
  const out:{speaker:string,text:string}[]=[];
  const re=/\[(?:\d{2}:){1,2}\d{2}\]\s*\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\n\s*\[(?:\d{2}:){1,2}\d{2}\]\s*\*\*|$)/g;
  let m:RegExpExecArray|null;
  while ((m=re.exec(text))) { const tx=clip(m[2],2200); if(tx.length>3) out.push({speaker:clip(m[1],120),text:tx}); }
  return out;
}
function cleanSpeech(v:string) { return clip(v.replace(/\b(tipo assim|tipo|cara|né|entendeu|assim)\b/gi," ").replace(/\s+/g," ").replace(/^[-–—,:; ]+|[-–—,:; ]+$/g,""),1000); }
function pick(utterances:{speaker:string,text:string}[], pattern:RegExp, max=4) {
  const seen=new Set<string>(),out:string[]=[];
  for(const u of utterances){ pattern.lastIndex=0; if(!pattern.test(norm(u.text))) continue; const c=cleanSpeech(u.text),k=norm(c).slice(0,200); if(c.length<18||seen.has(k))continue; seen.add(k);out.push(c);if(out.length>=max)break; }
  return out;
}
function classify(clientName:string, text:string) {
  const h=norm(`${clientName} ${text.slice(0,16000)}`);
  if(/\b(imobiliaria|incorporadora|construtora|equipe de corretores)\b/.test(h)) return {kind:"IMOBILIÁRIA",label:"Briefing 02 — Imobiliária"};
  if(/\bcorretora\b/.test(h)) return {kind:"CORRETORA",label:"Briefing 01 — Corretor Autônomo"};
  return {kind:"CORRETOR",label:"Briefing 01 — Corretor Autônomo"};
}
function profileFrom(client:any, meetings:any[], teamNames:Set<string>, crm:any, forms:any[]) {
  const utterances:{speaker:string,text:string}[]=[]; const summaries:string[]=[];
  for(const m of meetings){ if(m.metadata?.donnah_summary) summaries.push(clip(m.metadata.donnah_summary,800)); for(const u of parseUtterances(String(m.transcript_text||""))){const sp=norm(u.speaker);if(CLOSER_SPEAKERS.has(sp)||teamNames.has(sp))continue;utterances.push(u);} }
  const allText=utterances.map(x=>x.text).join("\n")+"\n"+summaries.join("\n"); const model=classify(client.display_name,allText);
  const company=pick(utterances,/\b(imobiliaria|empresa|operacao|equipe|socio|socios|corretor|corretores|trabalho sozinho|trabalhamos)\b/,4);
  const location=pick(utterances,/\b(cidade|regiao|bairro|atuo|atuamos|trabalho em|trabalhamos em|sou de|estado)\b/,3);
  const crmFacts=pick(utterances,/\b(crm|sistema|kommo|kenlo|jetimob|vista|imobzi|imobilead|interlis|rd station|cv crm|sienge|planilha|webhook|api)\b/,4);
  const investment=pick(utterances,/\b(invest|trafego|midia|orcamento|mensal|mensalidade|agencia|r\$|reais|cartao|pix|implementacao|comissao)\b/,5);
  const products=pick(utterances,/\b(ticket|mcmv|minha casa|minha vida|alto padrao|medio padrao|lancamento|apartamento|casa|lote|terreno|studio|milhao|empreendimento|produto|usado)\b/,5);
  const sales=pick(utterances,/\b(vendi|vendeu|vendemos|venda|vendas|vgv|fechei|fechamos|visita|visitas|lead|leads|proposta|conversao)\b/,5);
  const pains=pick(utterances,/\b(problema|dificuldade|ruim|pessimo|sem resultado|nao funciona|insatisfeito|frustr|lead ruim|lead desqualificado|curioso|perdendo|agencia anterior|gargalo)\b/,5);
  const goals=pick(utterances,/\b(quero|queremos|preciso|precisamos|meta|objetivo|crescer|escalar|contratar|pretendo|previsibilidade|aumentar|melhorar)\b/,5);
  const commercial:string[]=[];
  if(crm?.stage) commercial.push(`CRM comercial: estágio ${crm.stage}${crm.closed_at?`, fechado em ${new Date(crm.closed_at).toLocaleDateString("pt-BR")}`:""}.`);
  if(crm?.estimated_value!=null) commercial.push(`Valor estimado registrado no CRM comercial: R$ ${Number(crm.estimated_value).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})} — tratar como estimativa do CRM, não como verba confirmada.`);
  const formFacts=(forms||[]).filter((f:any)=>f.product_name).map((f:any)=>`${f.form_type}: produto informado “${clip(f.product_name,160)}”.`).slice(0,4);
  const particular:string[]=[],seen=new Set<string>();
  for(const x of [...goals,...pains,...sales,...products,...company,...summaries,...commercial,...formFacts].map(cleanSpeech).filter(x=>x.length>=20)){const k=norm(x).slice(0,190);if(seen.has(k))continue;seen.add(k);particular.push(x);if(particular.length>=10)break;}
  return {model,company,location,crm:crmFacts,investment,products,sales,pains,goals,commercial,formFacts,particular};
}
function missing(items:string[], fallback="não informado / confirmar com o cliente"){ return items.length?items.join(" "):fallback; }
function markdownFull(client:any,p:any,meetings:any[]){return [`### 📋 BRIEFING — ${String(client.display_name).toUpperCase()}`,`*Modelo aplicado: ${p.model.label} | Consolidado de ${meetings.length} reunião(ões) comercial(is) de closer*`,`---`,`**${p.model.kind==="IMOBILIÁRIA"?"IMOBILIÁRIA / EMPRESA":"CORRETOR / OPERAÇÃO"}:** ${missing(p.company,client.display_name)}`,`**LOCALIZAÇÃO DE ATUAÇÃO:** ${missing(p.location)}`,`**CRM / OPERAÇÃO:** ${missing(p.crm)}`,`**INVESTIMENTO / CONDIÇÕES COMERCIAIS:** ${missing([...p.investment,...p.commercial])}`,`**PRODUTOS / TICKET:** ${missing(p.products)}`,`**HISTÓRICO COMERCIAL:** ${missing(p.sales)}`,`**DORES / OBJEÇÕES / GARGALOS:** ${missing(p.pains)}`,`**METAS:** ${missing(p.goals)}`,`**PARTICULARIDADES:**`,...(p.particular.length?p.particular.map((x:string)=>`- ${x}`):[`- não informado / confirmar com o cliente`]),``,`*Fontes: reuniões comerciais de Vitor Feitoza e/ou Leonardo Augusto, CRM e formulários vinculados quando existentes. Estimativas permanecem identificadas como estimativas.*`].join("\n");}
function markdownEnrichment(p:any,meetings:any[]){const lines=[`### 🔄 ATUALIZAÇÃO AUTOMÁTICA — EVIDÊNCIA COMERCIAL`,`*Novas fontes consolidadas sem substituir o briefing manual: ${meetings.length} reunião(ões) nova(s).*`]; const add=(label:string,items:string[])=>{if(items.length)lines.push(`**${label}:** ${items.join(" ")}`)};add("EMPRESA / ESTRUTURA",p.company);add("LOCALIZAÇÃO",p.location);add("CRM / OPERAÇÃO",p.crm);add("INVESTIMENTO / CONDIÇÕES",[...p.investment,...p.commercial]);add("PRODUTOS / TICKET",p.products);add("HISTÓRICO COMERCIAL",p.sales);add("DORES / OBJEÇÕES",p.pains);add("METAS",p.goals);if(p.particular.length){lines.push(`**PARTICULARIDADES NOVAS:**`);for(const x of p.particular)lines.push(`- ${x}`)}return lines.join("\n");}
function rich(content:string,bold=false,italic=false){return[{type:"text",text:{content:clip(content,1900)},annotations:{bold,italic,strikethrough:false,underline:false,code:false,color:"default"}}];}
function blocksFromMarkdown(client:any,p:any,meetings:any[],enrichment=false){const blocks:any[]=[]; const add=(label:string,value:string)=>blocks.push({object:"block",type:"paragraph",paragraph:{rich_text:[...rich(`${label}: `,true),...rich(value)]}}); if(enrichment){blocks.push({object:"block",type:"heading_3",heading_3:{rich_text:rich("🔄 ATUALIZAÇÃO AUTOMÁTICA — EVIDÊNCIA COMERCIAL")}});blocks.push({object:"block",type:"paragraph",paragraph:{rich_text:rich(`Novas fontes consolidadas sem substituir o briefing manual: ${meetings.length} reunião(ões) nova(s).`,false,true)}});if(p.company.length)add("EMPRESA / ESTRUTURA",p.company.join(" "));if(p.location.length)add("LOCALIZAÇÃO",p.location.join(" "));if(p.crm.length)add("CRM / OPERAÇÃO",p.crm.join(" "));if(p.investment.length||p.commercial.length)add("INVESTIMENTO / CONDIÇÕES",[...p.investment,...p.commercial].join(" "));if(p.products.length)add("PRODUTOS / TICKET",p.products.join(" "));if(p.sales.length)add("HISTÓRICO COMERCIAL",p.sales.join(" "));if(p.pains.length)add("DORES / OBJEÇÕES",p.pains.join(" "));if(p.goals.length)add("METAS",p.goals.join(" "));if(p.particular.length){blocks.push({object:"block",type:"paragraph",paragraph:{rich_text:rich("PARTICULARIDADES NOVAS:",true)}});for(const x of p.particular)blocks.push({object:"block",type:"bulleted_list_item",bulleted_list_item:{rich_text:rich(x)}})}return blocks.slice(0,80);} blocks.push({object:"block",type:"heading_3",heading_3:{rich_text:rich(`📋 BRIEFING — ${String(client.display_name).toUpperCase()}`)}});blocks.push({object:"block",type:"paragraph",paragraph:{rich_text:rich(`Modelo aplicado: ${p.model.label} | Consolidado de ${meetings.length} reunião(ões) comercial(is) de closer`,false,true)}});blocks.push({object:"block",type:"divider",divider:{}});add(p.model.kind==="IMOBILIÁRIA"?"IMOBILIÁRIA / EMPRESA":"CORRETOR / OPERAÇÃO",missing(p.company,client.display_name));add("LOCALIZAÇÃO DE ATUAÇÃO",missing(p.location));add("CRM / OPERAÇÃO",missing(p.crm));add("INVESTIMENTO / CONDIÇÕES COMERCIAIS",missing([...p.investment,...p.commercial]));add("PRODUTOS / TICKET",missing(p.products));add("HISTÓRICO COMERCIAL",missing(p.sales));add("DORES / OBJEÇÕES / GARGALOS",missing(p.pains));add("METAS",missing(p.goals));blocks.push({object:"block",type:"paragraph",paragraph:{rich_text:rich("PARTICULARIDADES:",true)}});for(const x of(p.particular.length?p.particular:["não informado / confirmar com o cliente"]))blocks.push({object:"block",type:"bulleted_list_item",bulleted_list_item:{rich_text:rich(x)}});return blocks.slice(0,90);}

class NotionError extends Error { status:number; constructor(status:number,message:string){super(message);this.status=status;} }
async function notionCall(token:string,path:string,init:RequestInit={}){const r=await fetch(`https://api.notion.com/v1${path}`,{...init,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","Notion-Version":NOTION_VERSION,...(init.headers||{})}});const raw=await r.text();let data:any={};try{data=JSON.parse(raw)}catch{data={raw}}if(!r.ok)throw new NotionError(r.status,clip(data?.message||raw,700));return data;}
async function notionCreate(token:string,title:string,blocks:any[]){return notionCall(token,"/pages",{method:"POST",body:JSON.stringify({parent:{page_id:PARENT_PAGE_ID},properties:{title:{title:[{type:"text",text:{content:title}}]}},children:blocks})});}
async function notionAppend(token:string,pageId:string,blocks:any[]){return notionCall(token,`/blocks/${pageId}/children`,{method:"PATCH",body:JSON.stringify({children:blocks})});}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return reply({ok:false,error:"method_not_allowed"},405);
  const url=Deno.env.get("SUPABASE_URL")||"", sr=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||""; if(!url||!sr)return reply({ok:false,error:"server_configuration"},500);
  const db=createClient(url,sr,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  const [{data:expected},{data:notionToken}] = await Promise.all([ops.rpc("get_secret",{p_name:"CLOSER_BRIEFING_SYNC_SECRET"}),ops.rpc("get_secret",{p_name:"notion_api_key"})]);
  const supplied=req.headers.get("x-closer-briefing-secret")||""; if(!expected||!supplied||!safeEqual(String(expected),supplied))return reply({ok:false,error:"unauthorized"},401); if(!notionToken)return reply({ok:false,error:"notion_secret_missing"},500);
  const body=await req.json().catch(()=>({}));
  if(body?.mode==="preflight"){try{const parent=await notionCall(String(notionToken),`/pages/${PARENT_PAGE_ID}`);return reply({ok:true,mode:"preflight",parent_id:parent.id,parent_title:parent?.properties?.title?.title?.[0]?.plain_text||null});}catch(e){const ne=e as any;return reply({ok:false,mode:"preflight",error:"notion_parent_unavailable",status:ne?.status||500,detail:clip(ne?.message||e,500)},200)}}
  const limit=Math.max(1,Math.min(8,Number(body?.limit||4))),requested=body?.client_id?String(body.client_id):null;
  let q=ops.from("closer_briefing_jobs").select("*").in("status",["PENDING","ERROR","WAITING_EVIDENCE"]).lte("available_at",iso()).order("available_at").limit(limit); if(requested)q=q.eq("client_id",requested);
  const {data:jobs,error:je}=await q; if(je)return reply({ok:false,error:"jobs_query",detail:je.message},500);
  const {data:team}=await ops.from("team_roster").select("person").eq("is_former",false); const teamNames=new Set((team||[]).map((x:any)=>norm(x.person))); const results:any[]=[];
  for(const job of jobs||[]){const attempt=Number(job.attempt_count||0)+1;try{
    await ops.from("closer_briefing_jobs").update({status:"RUNNING",locked_at:iso(),attempt_count:attempt,updated_at:iso()}).eq("id",job.id);
    const {data:client,error:ce}=await ops.from("clients").select("id,display_name,lifecycle,entrada,crm_lead_id,metadata").eq("id",job.client_id).maybeSingle(); if(ce||!client)throw new Error(ce?.message||"client_not_found");
    if(!["ACTIVE","ONBOARDING"].includes(String(client.lifecycle))){await ops.from("closer_briefing_jobs").update({status:"SKIPPED",processed_at:iso(),last_error:"client_not_current",updated_at:iso()}).eq("id",job.id);results.push({client:client.display_name,status:"SKIPPED"});continue;}
    const {data:aliases}=await ops.from("client_name_aliases").select("alias_name").eq("client_id",client.id); const names=[client.display_name,...(aliases||[]).map((x:any)=>x.alias_name)].filter(Boolean);
    let {data:linked}=await ops.from("notion_briefing_pages").select("*").eq("client_id",client.id).order("updated_at",{ascending:false}).limit(1); let page=linked?.[0]||null;
    if(!page){const {data:pages}=await ops.from("notion_briefing_pages").select("*").is("client_id",null).limit(800);const candidate=(pages||[]).map((p:any)=>({...p,_score:pageMatchScore(names,p.title)})).filter((p:any)=>p._score>=85).sort((a:any,b:any)=>b._score-a._score)[0];if(candidate){await ops.from("notion_briefing_pages").update({client_id:client.id,match_status:"CONFIRMED",match_confidence:candidate._score/100,updated_at:iso()}).eq("notion_page_id",candidate.notion_page_id);page=candidate;}}
    const entrada=client.entrada?new Date(`${client.entrada}T12:00:00-03:00`):new Date(); const from=new Date(entrada.getTime()-180*86400000).toISOString(),to=new Date(entrada.getTime()+3*86400000).toISOString();
    const mq=await ops.from("meeting_transcripts").select("id,meeting_started_at,summary,participants,metadata,client_id,match_status,source_file_name").gte("meeting_started_at",from).lte("meeting_started_at",to).order("meeting_started_at",{ascending:false}).limit(1800); if(mq.error)throw new Error(mq.error.message);
    const top=(mq.data||[]).filter((m:any)=>CLOSER_OWNERS.has(String(m.metadata?.mcp_owner_person||""))).map((m:any)=>({...m,_clientId:client.id,_score:transcriptScore({...m,_clientId:client.id},names)})).filter((m:any)=>m._score>=30).sort((a:any,b:any)=>b._score-a._score||new Date(b.meeting_started_at).getTime()-new Date(a.meeting_started_at).getTime()).slice(0,6);
    const previousIds=new Set<number>([...(Array.isArray(page?.source_payload?.source_transcript_ids)?page.source_payload.source_transcript_ids:[]),...(Array.isArray(job.evidence_transcript_ids)?job.evidence_transcript_ids:[])].map(Number)); const selected=page?top.filter((x:any)=>!previousIds.has(Number(x.id))):top;
    const {data:forms}=await ops.from("form_responses").select("id,form_type,product_name,submitted_at").eq("client_id",client.id).order("submitted_at",{ascending:false}).limit(6); let crm:any=null;if(client.crm_lead_id){const r=await ops.from("crm_preclients").select("id,stage,estimated_value,closed_at,updated_at").eq("id",client.crm_lead_id).maybeSingle();crm=r.data||null;}
    const sourceHash=await sha256({transcript_ids:top.map((x:any)=>x.id).sort(),form_ids:(forms||[]).map((x:any)=>x.id).sort(),crm:crm?{id:crm.id,stage:crm.stage,estimated_value:crm.estimated_value,updated_at:crm.updated_at}:null});
    if(page && page?.source_payload?.auto_source_hash===sourceHash){await ops.from("closer_briefing_jobs").update({status:"DONE",processed_at:iso(),notion_page_id:page.notion_page_id,notion_page_url:page.page_url,briefing_title:page.title,last_error:null,metadata:{...(job.metadata||{}),reason:"idempotent_no_change",content_hash:sourceHash},updated_at:iso()}).eq("id",job.id);results.push({client:client.display_name,status:"NOOP",page:page.page_url});continue;}
    if(!top.length&&!page){await ops.from("closer_briefing_jobs").update({status:"WAITING_EVIDENCE",available_at:new Date(Date.now()+180*60000).toISOString(),last_error:"no_preclose_closer_meeting_matched",updated_at:iso()}).eq("id",job.id);results.push({client:client.display_name,status:"WAITING_EVIDENCE"});continue;}
    if(page&&!selected.length){await ops.from("notion_briefing_pages").update({source_payload:{...(page.source_payload||{}),auto_source_hash:sourceHash,last_checked_at:iso(),source_form_ids:(forms||[]).map((x:any)=>x.id)},updated_at:iso()}).eq("notion_page_id",page.notion_page_id);await ops.from("closer_briefing_jobs").update({status:"DONE",processed_at:iso(),notion_page_id:page.notion_page_id,notion_page_url:page.page_url,briefing_title:page.title,last_error:null,metadata:{...(job.metadata||{}),reason:"existing_briefing_no_new_closer_source",content_hash:sourceHash},updated_at:iso()}).eq("id",job.id);results.push({client:client.display_name,status:"EXISTING_NO_NEW_SOURCE",page:page.page_url});continue;}
    const ids=(page?selected:top).map((x:any)=>x.id);const fq=await ops.from("meeting_transcripts").select("id,meeting_started_at,transcript_text,summary,participants,metadata,client_id").in("id",ids);if(fq.error)throw new Error(fq.error.message);const byId=new Map((fq.data||[]).map((x:any)=>[Number(x.id),x]));const meetings=(page?selected:top).map((x:any)=>({...x,...(byId.get(Number(x.id))||{})})).filter((x:any)=>String(x.transcript_text||"").length>=100);if(!meetings.length&&!page)throw new Error("matched_meetings_missing_transcript_text");
    const profile=profileFrom(client,meetings,teamNames,crm,forms||[]); const owners=[...new Set(meetings.map((x:any)=>x.metadata?.mcp_owner_person).filter(Boolean))]; const dates=meetings.map((x:any)=>x.meeting_started_at).filter(Boolean); const allIds=[...new Set([...previousIds,...top.map((x:any)=>Number(x.id))])]; const now=iso();
    if(page){const md=markdownEnrichment(profile,meetings);await notionAppend(String(notionToken),page.notion_page_id,blocksFromMarkdown(client,profile,meetings,true));const payload={...(page.source_payload||{}),source:"CLOSER_MEETINGS",source_transcript_ids:allIds,source_closers:[...new Set([...(page.source_payload?.source_closers||[]),...owners])],meeting_dates:[...new Set([...(page.source_payload?.meeting_dates||[]),...dates])],source_form_ids:(forms||[]).map((x:any)=>x.id),auto_source_hash:sourceHash,last_enriched_at:now,confidence:"HIGH_WHEN_EXPLICIT__REVIEW_ESTIMATES"};await ops.from("notion_briefing_pages").update({content_markdown:[page.content_markdown,md].filter(Boolean).join("\n\n"),source_payload:payload,extracted_profile:{...(page.extracted_profile||{}),last_auto_enrichment:{model:profile.model.kind,company:profile.company,location:profile.location,crm:profile.crm,investment:profile.investment,products:profile.products,sales:profile.sales,pains:profile.pains,goals:profile.goals,at:now}},last_fetched_at:now,synced_at:now,sync_status:"PARSED",last_error:null,updated_at:now}).eq("notion_page_id",page.notion_page_id);await ops.from("closer_briefing_jobs").update({status:"DONE",notion_page_id:page.notion_page_id,notion_page_url:page.page_url,briefing_title:page.title,briefing_markdown:md,evidence_transcript_ids:allIds,evidence_meeting_count:allIds.length,model_type:profile.model.kind,processed_at:now,last_error:null,metadata:{...(job.metadata||{}),generated_by:"CLOSER_BRIEFING_V3",action:"ENRICHED",content_hash:sourceHash,source_closers:owners,meeting_dates:dates},updated_at:now}).eq("id",job.id);results.push({client:client.display_name,status:"ENRICHED",page:page.page_url,new_meetings:meetings.length});continue;}
    const title=`[${profile.model.kind}] - ${String(client.display_name).toUpperCase()}`,md=markdownFull(client,profile,meetings),notion=await notionCreate(String(notionToken),title,blocksFromMarkdown(client,profile,meetings,false));const payload={source:"CLOSER_MEETINGS",source_transcript_ids:top.map((x:any)=>x.id),source_closers:owners,meeting_dates:dates,source_form_ids:(forms||[]).map((x:any)=>x.id),auto_source_hash:sourceHash,generated_at:now,confidence:"HIGH_WHEN_EXPLICIT__REVIEW_ESTIMATES"};await ops.from("notion_briefing_pages").upsert({notion_page_id:notion.id,parent_page_id:PARENT_PAGE_ID,title,page_url:notion.url,notion_last_edited_at:notion.last_edited_time||now,discovered_at:now,last_fetched_at:now,content_markdown:md,client_id:client.id,match_status:"CONFIRMED",match_confidence:1,sync_status:"PARSED",extracted_profile:{auto_generated:true,model:profile.model.kind,company:profile.company,location:profile.location,crm:profile.crm,investment:profile.investment,products:profile.products,sales:profile.sales,pains:profile.pains,goals:profile.goals},source_payload:payload,last_error:null,synced_at:now,updated_at:now},{onConflict:"notion_page_id"});await ops.from("clients").update({metadata:{...(client.metadata||{}),notion_briefing_page_id:notion.id,notion_briefing_url:notion.url,notion_briefing_auto:true}}).eq("id",client.id);await ops.from("closer_briefing_jobs").update({status:"DONE",notion_page_id:notion.id,notion_page_url:notion.url,briefing_title:title,briefing_markdown:md,evidence_transcript_ids:top.map((x:any)=>x.id),evidence_meeting_count:top.length,model_type:profile.model.kind,processed_at:now,last_error:null,metadata:{...(job.metadata||{}),generated_by:"CLOSER_BRIEFING_V3",action:"CREATED",content_hash:sourceHash,source_closers:owners,meeting_dates:dates},updated_at:now}).eq("id",job.id);results.push({client:client.display_name,status:"CREATED",page:notion.url,meetings:meetings.length,model:profile.model.kind});
  }catch(e){const msg=clip(e instanceof Error?e.message:String(e),1000),notionStatus=e instanceof NotionError?e.status:null,accessBlocked=notionStatus===403||notionStatus===404;const dead=!accessBlocked&&attempt>=10;await ops.from("closer_briefing_jobs").update({status:dead?"DEAD_LETTER":"ERROR",available_at:new Date(Date.now()+(accessBlocked?1440:Math.min(1440,5*Math.pow(2,Math.max(0,attempt-1))))*60000).toISOString(),processed_at:dead?iso():null,last_error:accessBlocked?`notion_parent_access_blocked: ${msg}`:msg,metadata:{...(job.metadata||{}),last_retry_attempt:attempt,notion_access_blocked:accessBlocked,notion_status:notionStatus,dead_letter:dead},updated_at:iso()}).eq("id",job.id);results.push({client_id:job.client_id,status:dead?"DEAD_LETTER":"ERROR",notion_access_blocked:accessBlocked,error:msg});}
  }
  return reply({ok:results.every(x=>!["ERROR","DEAD_LETTER"].includes(x.status)),processed:results.length,results});
});