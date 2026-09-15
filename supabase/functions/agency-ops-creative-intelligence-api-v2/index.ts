import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Designer = { person:string; clickup_user:string; can_video:boolean; aliases:string[] };

const BUCKET = "agency-meta-creative-previews";
const SIGNED_SECONDS = 6 * 60 * 60;
const CORS = {
  "access-control-allow-origin":"*",
  "access-control-allow-headers":"content-type,authorization,apikey",
  "access-control-allow-methods":"GET,POST,OPTIONS",
  "access-control-max-age":"86400",
};
const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit",
});
const json = (body:unknown,status=200) => new Response(JSON.stringify(body), {
  status,
  headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
});
const finite = (v:unknown) => {
  if(v===null||v===undefined||v==="") return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
};
const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const normalize=(v:unknown)=>String(v||"")
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g," ").trim();

const STOP = new Set([
  "criativos","criativo","ajuste","ajustes","campanha","nova","novo","novos",
  "form","forms","venda","lead","leads","anuncio","anuncios","imagem","imagens",
  "video","videos","reels","marketing","imoveis","imovel","para","com","dos",
  "das","uma","the","ativo","pausado","feed","story","stories","meta","ads",
  "ad01","ad02","ad03","ad04","ad05","ad06","ad07","ad08","ad09","ad10"
]);
const toks=(v:unknown)=>[...new Set(normalize(v).split(/\s+/).filter(x=>x.length>=3&&!STOP.has(x)))];
function similarity(a:unknown,b:unknown){
  const aa=toks(a),bb=toks(b);
  if(!aa.length||!bb.length)return 0;
  const set=new Set(bb);
  const hits=aa.filter(x=>set.has(x)).length;
  return hits/Math.max(1,Math.min(aa.length,bb.length));
}
function median(values:Array<number|null>){
  const xs=values.filter((x):x is number=>x!==null&&Number.isFinite(x)).sort((a,b)=>a-b);
  if(!xs.length)return null;
  const m=Math.floor(xs.length/2);
  return xs.length%2?xs[m]:(xs[m-1]+xs[m])/2;
}
function localDate(value:unknown){
  if(!value)return "";
  const d=new Date(String(value));
  return Number.isNaN(d.getTime())?"":DATE_FMT.format(d);
}
function entryDate(client:Row|undefined){return String(client?.entrada||"").slice(0,10);}
function onOrAfter(value:unknown,entry:string){const d=localDate(value);return Boolean(entry&&d&&d>=entry);}
function designTask(raw:unknown){
  return /\]\s*-\s*(criativos|v[ií]deo|ajustes?\s+(?:no|nos)\s+criativos)\s*-/i.test(String(raw||""));
}
function taskSubject(raw:unknown){
  return String(raw||"")
    .replace(/^.*?\]\s*-\s*(?:criativos|v[ií]deo|ajustes?\s+(?:no|nos)\s+criativos)\s*-\s*/i,"")
    .trim();
}
async function loadPaged(make:()=>any,max=12000,batch=1000){
  const out:Row[]=[];
  for(let from=0;from<max;from+=batch){
    const {data,error}=await make().range(from,from+batch-1);
    if(error)throw error;
    const rows=data||[];
    out.push(...rows);
    if(rows.length<batch)break;
  }
  return out;
}
async function signRows(db:any,rows:Row[]){
  const paths=[...new Set(rows.map(r=>String(r.preview_storage_path||"")).filter(Boolean))];
  if(!paths.length)return rows;
  const map=new Map<string,string>();
  for(let i=0;i<paths.length;i+=100){
    const chunk=paths.slice(i,i+100);
    const {data,error}=await db.storage.from(BUCKET).createSignedUrls(chunk,SIGNED_SECONDS);
    if(error||!Array.isArray(data))continue;
    data.forEach((x:any,j:number)=>{
      const p=String(x?.path||chunk[j]||""),u=String(x?.signedUrl||"");
      if(p&&u)map.set(p,u);
    });
  }
  return rows.map(r=>{
    const u=map.get(String(r.preview_storage_path||""));
    return u?{...r,preview_url:u,image_url:u,thumbnail_url:u}:r;
  });
}
function buildDesigners(roster:Row[],caps:Row[]):Designer[]{
  const capMap=new Map(caps.map(r=>[String(r.person),Boolean(r.can_video)]));
  const base=roster.map(r=>({
    person:String(r.person),
    clickup_user:String(r.clickup_user||r.person||""),
    can_video:Boolean(capMap.get(String(r.person))),
    aliases:[] as string[],
  }));
  const tokenOwners=new Map<string,Set<string>>();
  for(const d of base){
    for(const token of toks(d.person)){
      if(token.length<5)continue;
      if(!tokenOwners.has(token))tokenOwners.set(token,new Set());
      tokenOwners.get(token)!.add(d.person);
    }
  }
  for(const d of base){
    const aliases=new Set<string>([normalize(d.person),normalize(d.clickup_user)]);
    for(const token of toks(d.person)){
      if(token.length>=5&&tokenOwners.get(token)?.size===1)aliases.add(token);
    }
    d.aliases=[...aliases].filter(Boolean);
  }
  return base;
}
function assigneeDesigners(value:unknown,designers:Designer[]){
  const n=normalize(value);
  if(!n)return[];
  return designers.filter(d=>{
    const names=[normalize(d.person),normalize(d.clickup_user),...d.aliases].filter(Boolean);
    return names.some(a=>a.length>=5&&(n===a||n.includes(a)));
  });
}
function compatible(d:Designer|null,format:string){
  return Boolean(d)&&!(format==="VÍDEO"&&!d!.can_video);
}
function performance(row:Row,baseline:Row){
  const results=finite(row.results_7d)||0;
  const spend=finite(row.spend_7d)||0;
  const cpr=finite(row.cost_per_result_7d);
  const ctr=finite(row.ctr_7d);
  const freq=finite(row.frequency_7d)||0;
  const baseCpr=finite(baseline.median_cpr);
  const baseCtr=finite(baseline.median_ctr);
  const uplift=cpr!==null&&baseCpr!==null&&baseCpr>0?(baseCpr-cpr)/baseCpr*100:null;
  const ctrUplift=ctr!==null&&baseCtr!==null&&baseCtr>0?(ctr-baseCtr)/baseCtr*100:null;
  const fatigue=spend>=20&&freq>=3.5&&ctr!==null&&baseCtr!==null&&ctr<baseCtr*.75;

  let proof="SEM_DADOS_7D";
  if(spend>0||results>0)proof="AMOSTRA_INSUFICIENTE";
  if(results>=2)proof="ACIMA_DA_MEDIA";
  if(results>=4&&spend>=30)proof="FORTE_CANDIDATO";
  if(results>=8&&spend>=50)proof="VENCEDOR_COMPROVADO";
  if(fatigue)proof="EM_FADIGA";

  const maxResults=Math.max(1,finite(baseline.max_results)||1);
  const efficiency=uplift===null?12:clamp(15+uplift*.35,0,30);
  const volume=clamp(results/maxResults*25,0,25);
  const click=ctrUplift===null?7:clamp(8+ctrUplift*.12,0,15);
  const conversion=(finite(row.clicks_7d)||0)>0?clamp(results/(finite(row.clicks_7d)||1)*100*1.2,0,15):5;
  const sample=results>=8?15:results>=4?11:results>=2?6:spend>0?2:0;
  const score=Math.round(clamp(efficiency+volume+click+conversion+sample));

  return {
    proof,score,uplift,ctr_uplift:ctrUplift,fatigue,
    reasons:[
      uplift!==null?`CPR ${Math.abs(uplift).toFixed(0)}% ${uplift>=0?"melhor":"pior"} que a mediana do cliente`:null,
      `${results} resultado(s) nos últimos 7 dias`,
      fatigue?"Frequência alta com CTR abaixo da referência do cliente":null,
    ].filter(Boolean),
  };
}
function buildTaskIndex(clients:Row[],tasks:Row[],designers:Designer[]){
  const clientMap=new Map(clients.map(c=>[String(c.id),c]));
  const byClient=new Map<string,Row[]>();
  for(const t of tasks){
    const cid=String(t.client_id||"");
    const client=clientMap.get(cid);
    const entry=entryDate(client);
    if(!cid||!entry||!designTask(t.name))continue;
    const evidenceAt=t.date_created||t.date_updated||t.date_closed;
    if(!onOrAfter(evidenceAt,entry))continue;
    const ds=assigneeDesigners(t.assignee_names,designers);
    if(ds.length!==1)continue;
    const row={...t,designer:ds[0].person,designer_can_video:ds[0].can_video,subject:taskSubject(t.name)};
    if(!byClient.has(cid))byClient.set(cid,[]);
    byClient.get(cid)!.push(row);
  }
  return byClient;
}
function attribution(row:Row,tasksByClient:Map<string,Row[]>,designers:Designer[]){
  const identity=`${row.campaign_name||""} ${row.ad_name||""} ${row.creative_name||""}`;
  const format=String(row.creative_format||"");
  const candidates:Row[]=[];
  const warnings:string[]=[];

  for(const t of tasksByClient.get(String(row.client_id))||[]){
    const d=designers.find(x=>x.person===String(t.designer))||null;
    if(!compatible(d,format)){
      if(format==="VÍDEO")warnings.push(`Task incompatível com vídeo: ${String(t.designer||t.assignee_names||"")}`);
      continue;
    }
    const subject=String(t.subject||"");
    const sim=similarity(identity,subject);
    if(sim<.40)continue;
    const ni=normalize(identity),ns=normalize(subject);
    const contains=ns.length>=5&&(ni.includes(ns)||ns.includes(ni));
    const score=sim+(contains?.20:0);
    candidates.push({...t,_score:score,_sim:sim});
  }

  candidates.sort((a,b)=>(finite(b._score)||0)-(finite(a._score)||0));
  const best=candidates[0]||null;
  const second=candidates[1]||null;
  if(!best){
    return {
      designer:null,confidence:0,
      level:warnings.length?"FORMATO_INCOMPATIVEL":"NAO_IDENTIFICADO",
      method:null,trusted:false,warnings:[...new Set(warnings)].slice(0,3),evidences:[],
    };
  }

  const bestScore=finite(best._score)||0;
  const secondScore=finite(second?._score)||0;
  const sameDesigner=second&&String(second.designer)===String(best.designer);
  const margin=bestScore-secondScore;
  if(second&&!sameDesigner&&margin<.12){
    return {
      designer:null,confidence:0,level:"CONFLITO",method:"CLICKUP_AMBIGUO",trusted:false,
      warnings:[...new Set([...warnings,"Duas tasks de designers diferentes têm correspondência muito próxima para este anúncio."])].slice(0,3),
      evidences:[
        {source:"CLICKUP",label:best.name,url:best.url||null,at:best.date_updated||best.date_created||null},
        {source:"CLICKUP",label:second.name,url:second.url||null,at:second.date_updated||second.date_created||null},
      ],
    };
  }

  const trusted=bestScore>=.65;
  const confirmed=bestScore>=.90;
  const confidence=trusted?Math.round(Math.min(98,82+Math.max(0,bestScore-.65)*45)):Math.round(Math.min(79,55+bestScore*30));
  return {
    designer:String(best.designer),
    confidence,
    level:confirmed?"CONFIRMADO":trusted?"FORTE":"PROVAVEL",
    method:confirmed?"CLICKUP_EXATO":trusted?"CLICKUP_FORTE":"CLICKUP",
    trusted,
    warnings:[...new Set(warnings)].slice(0,3),
    evidences:[{source:"CLICKUP",label:best.name,url:best.url||null,at:best.date_updated||best.date_created||null}],
  };
}
function buildRanking(rows:Row[],designers:Designer[]){
  const groups=new Map<string,Row>();
  for(const d of designers){
    groups.set(d.person,{
      designer:d.person,pieces:0,proven:0,rising:0,above:0,fatigue:0,
      results:0,spend:0,scores:[],uplifts:[],conf:[],piece_keys:new Set<string>(),
    });
  }
  for(const r of rows){
    if(!r.attribution?.trusted||!r.attribution?.designer)continue;
    if((finite(r.spend_7d)||0)<=0&&(finite(r.results_7d)||0)<=0)continue;
    const x=groups.get(String(r.attribution.designer));
    if(!x)continue;
    const key=String(r.creative_id||r.ad_id);
    if(x.piece_keys.has(key))continue;
    x.piece_keys.add(key);
    x.pieces++;
    x.results+=finite(r.results_7d)||0;
    x.spend+=finite(r.spend_7d)||0;
    x.scores.push(finite(r.performance?.score)||0);
    x.uplifts.push(finite(r.performance?.uplift));
    x.conf.push(finite(r.attribution?.confidence)||0);
    if(r.performance?.proof==="VENCEDOR_COMPROVADO")x.proven++;
    if(r.performance?.proof==="FORTE_CANDIDATO")x.rising++;
    if(r.performance?.proof==="ACIMA_DA_MEDIA")x.above++;
    if(r.performance?.proof==="EM_FADIGA")x.fatigue++;
  }
  const out=[...groups.values()].map(x=>{
    const avg=x.scores.length?x.scores.reduce((a:number,b:number)=>a+b,0)/x.scores.length:0;
    const winner=x.pieces?x.proven/x.pieces*100:0;
    const consistency=x.pieces?100-x.fatigue/x.pieces*100:100;
    const rankingScore=x.pieces?Math.round(clamp(avg*.55+winner*.30+consistency*.15)):0;
    return {
      designer:x.designer,pieces:x.pieces,proven:x.proven,rising:x.rising,above:x.above,
      fatigue:x.fatigue,results:x.results,spend:x.spend,avg_score:avg,
      avg_uplift:median(x.uplifts),avg_confidence:median(x.conf),
      winner_rate:winner,ranking_score:rankingScore,
      ranking_confidence:x.pieces>=8?"ALTA":x.pieces>=3?"MÉDIA":x.pieces?"BAIXA":"SEM_AMOSTRA",
    };
  }).sort((a,b)=>b.ranking_score-a.ranking_score||b.proven-a.proven||b.results-a.results);
  let rank=0;
  return out.map(x=>({...x,rank:x.pieces?++rank:null}));
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return json({error:"method_not_allowed"},405);

  const url=Deno.env.get("SUPABASE_URL");
  const anon=Deno.env.get("SUPABASE_ANON_KEY");
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!anon||!service)return json({error:"server_configuration"},500);

  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"unauthorized"},401);

  const auth=createClient(url,anon,{global:{headers:{Authorization:authHeader}}});
  const {data:authData,error:authError}=await auth.auth.getUser();
  if(authError||!authData?.user?.id)return json({error:"unauthorized"},401);

  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const {data:pref}=await ops.from("user_preferences")
    .select("collaborator_person").eq("user_key",authData.user.id).maybeSingle();
  const person=String(pref?.collaborator_person||"").trim();
  const {data:roster}=await ops.from("team_roster")
    .select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle();
  const role=String(roster?.role||"").toUpperCase();
  const allowed=role==="MGMT"||role==="DESIGN"||["Joel Antoniete","Gustavo Lima","Leonardo Augusto"].includes(person);
  if(!allowed)return json({error:"not_found"},404);

  const incoming=new URL(req.url);
  if(incoming.searchParams.get("probe")==="1")return json({profile:{person,role},access:true,version:"lean-post-entry-v1"});

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    if(body?.action!=="refresh_catalog")return json({error:"invalid_action"},400);
    const {data,error}=await ops.rpc("enqueue_meta_creative_catalog_sync",{
      p_limit:Math.max(1,Math.min(30,Number(body?.limit||12))),
      p_stale_hours:0,
    });
    if(error)return json({error:"refresh_queue_failed",detail:error.message},500);
    return json({ok:true,queued:Number(data||0)});
  }

  try{
    const page=Math.max(1,Number(incoming.searchParams.get("page")||1));
    const pageSize=Math.max(24,Math.min(96,Number(incoming.searchParams.get("page_size")||72)));
    const q=normalize(incoming.searchParams.get("q")||"");
    const clientFilter=String(incoming.searchParams.get("client")||"");
    const campaignFilter=String(incoming.searchParams.get("campaign")||"");
    const formatFilter=String(incoming.searchParams.get("format")||"");
    const designerFilter=String(incoming.searchParams.get("designer")||"");
    const proofFilter=String(incoming.searchParams.get("proof")||"");
    const statusFilter=String(incoming.searchParams.get("status")||"");

    const [clients,designRoster,caps,capturedCatalog,tasks,syncStates,integrations]=await Promise.all([
      loadPaged(()=>ops.from("clients")
        .select("id,display_name,lifecycle,designer_owner,entrada")
        .in("lifecycle",["ACTIVE","ONBOARDING"]).order("display_name"),1000),
      loadPaged(()=>ops.from("team_roster")
        .select("person,role,is_former,clickup_user")
        .eq("role","DESIGN").eq("is_former",false),200),
      loadPaged(()=>ops.from("creative_designer_capabilities").select("person,can_video"),200),
      loadPaged(()=>ops.from("meta_creative_catalog").select("*").eq("is_current",true),12000),
      loadPaged(()=>ops.from("clickup_tasks")
        .select("client_id,task_id,name,status,date_created,date_updated,date_closed,url,assignee_names")
        .or("name.ilike.%] - Criativos - %,name.ilike.%] - Vídeo - %,name.ilike.%] - Video - %,name.ilike.%] - Ajuste no Criativos - %,name.ilike.%] - Ajustes nos Criativos - %"),6000),
      loadPaged(()=>ops.from("meta_creative_catalog_sync_state")
        .select("client_id,status,ad_count,account_count,last_error,finished_at"),1000),
      loadPaged(()=>ops.from("client_integrations")
        .select("client_id,meta_ad_account_id").eq("system","META_BM")
        .not("meta_ad_account_id","is",null),2000),
    ]);

    const designers=buildDesigners(designRoster,caps);
    const clientMap=new Map(clients.map(c=>[String(c.id),c]));
    const tasksByClient=buildTaskIndex(clients,tasks,designers);

    const eligible=capturedCatalog.filter(r=>{
      const c=clientMap.get(String(r.client_id));
      const entry=entryDate(c);
      return Boolean(entry&&r.ad_created_at&&onOrAfter(r.ad_created_at,entry));
    });

    const byClient=new Map<string,Row[]>();
    for(const r of eligible){
      const k=String(r.client_id);
      if(!byClient.has(k))byClient.set(k,[]);
      byClient.get(k)!.push(r);
    }
    const baselines=new Map<string,Row>();
    for(const [cid,rows] of byClient){
      const resultRows=rows.filter(r=>(finite(r.results_7d)||0)>0&&(finite(r.spend_7d)||0)>=10);
      baselines.set(cid,{
        median_cpr:median(resultRows.map(r=>finite(r.cost_per_result_7d))),
        median_ctr:median(rows.filter(r=>(finite(r.impressions_7d)||0)>=300).map(r=>finite(r.ctr_7d))),
        max_results:Math.max(0,...rows.map(r=>finite(r.results_7d)||0)),
      });
    }

    const enriched:Row[]=[];
    for(const r of eligible){
      const c=clientMap.get(String(r.client_id))||{};
      const perf=performance(r,baselines.get(String(r.client_id))||{});
      const attr=attribution({...r,client_name:r.client_name||c.display_name},tasksByClient,designers);
      enriched.push({
        ...r,
        client_name:r.client_name||c.display_name||"Cliente",
        lifecycle:r.lifecycle||c.lifecycle||null,
        portfolio_designer:c.designer_owner||null,
        client_entry_date:c.entrada||null,
        agency_evidence:true,
        performance:perf,
        attribution:attr,
      });
    }

    const ranking=buildRanking(enriched,designers);

    let filtered=enriched.filter(r=>{
      if(clientFilter&&String(r.client_id)!==clientFilter)return false;
      if(campaignFilter&&String(r.campaign_id)!==campaignFilter)return false;
      if(formatFilter&&String(r.creative_format)!==formatFilter)return false;
      if(designerFilter&&String(r.attribution?.designer||"")!==designerFilter)return false;
      if(proofFilter&&String(r.performance?.proof||"")!==proofFilter)return false;
      if(statusFilter&&!String(r.campaign_status||r.ad_status||"").includes(statusFilter))return false;
      if(q){
        const hay=normalize([r.client_name,r.campaign_name,r.adset_name,r.ad_name,r.creative_name,r.attribution?.designer].join(" "));
        if(!hay.includes(q))return false;
      }
      return true;
    });

    filtered.sort((a,b)=>
      (finite(b.performance?.score)||0)-(finite(a.performance?.score)||0)||
      (finite(b.results_7d)||0)-(finite(a.results_7d)||0)||
      String(a.client_name).localeCompare(String(b.client_name),"pt-BR")
    );

    const total=filtered.length;
    const pages=Math.max(1,Math.ceil(total/pageSize));
    const safePage=Math.min(page,pages);
    const start=(safePage-1)*pageSize;
    const signed=await signRows(db,filtered.slice(start,start+pageSize));

    const metaClientIds=new Set(integrations.map(r=>String(r.client_id)));
    const operationalMetaClients=clients.filter(c=>metaClientIds.has(String(c.id)));
    const okStates=syncStates.filter(s=>s.status==="OK"&&metaClientIds.has(String(s.client_id)));
    const errors=syncStates.filter(s=>s.status==="ERROR"&&metaClientIds.has(String(s.client_id)));
    const pending=syncStates.filter(s=>["QUEUED","RUNNING"].includes(String(s.status))&&metaClientIds.has(String(s.client_id)));

    const campaigns=[...new Map(eligible.filter(r=>r.campaign_id).map(r=>[
      String(r.campaign_id),
      {campaign_id:r.campaign_id,campaign_name:r.campaign_name||r.campaign_id,client_id:r.client_id,client_name:r.client_name},
    ])).values()].sort((a,b)=>
      String(a.client_name).localeCompare(String(b.client_name),"pt-BR")||
      String(a.campaign_name).localeCompare(String(b.campaign_name),"pt-BR")
    );

    const trusted=enriched.filter(r=>r.attribution?.trusted).length;
    const videos=enriched.filter(r=>r.creative_format==="VÍDEO").length;

    return json({
      profile:{person,role},
      summary:{
        catalog_total:eligible.length,
        captured_total:capturedCatalog.length,
        filtered_total:total,
        clients_covered:new Set(eligible.map(r=>String(r.client_id))).size,
        campaigns_covered:new Set(eligible.map(r=>String(r.campaign_id||"")).filter(Boolean)).size,
        operational_meta_clients:operationalMetaClients.length,
        synced_clients:okStates.length,
        sync_pending:pending.length,
        sync_errors:errors.length,
        trusted_attribution:trusted,
        unattributed:eligible.length-trusted,
        videos,
        excluded_pre_entry:capturedCatalog.length-eligible.length,
      },
      page:safePage,page_size:pageSize,pages,
      creatives:signed,
      ranking,
      filters:{
        clients:operationalMetaClients.map(c=>({client_id:c.id,client_name:c.display_name,lifecycle:c.lifecycle})),
        campaigns,
        designers:designers.map(d=>d.person),
        formats:["ESTÁTICO","VÍDEO","CARROSSEL"],
        proofs:["VENCEDOR_COMPROVADO","FORTE_CANDIDATO","ACIMA_DA_MEDIA","EM_FADIGA","AMOSTRA_INSUFICIENTE","SEM_DADOS_7D"],
      },
      sync:{states:syncStates,errors:errors.slice(0,20)},
      methodology:{
        attribution:"Autoria é atribuída apenas por task de produção criativa do mesmo cliente com correspondência forte de produto/campanha. Tasks de Campanha e Ajuste na campanha são ignoradas. Vídeo só pode ser atribuído a designer com capacidade de vídeo registrada.",
        ranking:"Ranking usa somente autorias FORTE/CONFIRMADA e apenas peças com entrega nos últimos 7 dias. Score combina performance, taxa de vencedores e consistência.",
        catalog:"A captura bruta continua completa, mas esta tela exibe somente anúncios cuja data real de criação na Meta é igual ou posterior à data de entrada do cliente na agência.",
      },
      generated_at:new Date().toISOString(),
      version:"lean-post-entry-v1",
    });
  }catch(error){
    let detail="";
    try{detail=error instanceof Error?error.message:JSON.stringify(error);}catch{detail=String(error);}
    return json({error:"creative_intelligence_v2_failed",detail},500);
  }
});
