import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization,apikey","access-control-allow-methods":"POST,OPTIONS","access-control-max-age":"86400"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
type Row=Record<string,any>;

const FIXED_ALIASES:Record<string,string[]>={
 SALES_CONFIRMED:["venda confirmada","crm won"],OPERATIONAL_ACTIVATION:["ativacao operacional"],
 INTRO_MEETING:["primeira reuniao","1a reuniao","reuniao de apresentacao","apresentacao"],
 PRODUCT_PERSONA_MEETING:["produto e persona","produto persona","produto + persona","segunda reuniao","2a reuniao"],
 PRODUCT_FORM:["formulario produto","formulario de produto"],PERSONA_FORM:["formulario persona","formulario de persona"],
 RAW_ASSETS:["materiais brutos","materiais no drive","arquivos no drive","fotos e videos","insumos"],
 INTEGRATION_MEETING:["reuniao de integracao","integracao com gt","integracao do gt","integracao"],
 ACCESS_VALIDATION:["validacao de acessos","validacao dos acessos","acessos validados","acessos"],
 CREATIVE_PRODUCTION:["producao criativa","criativos em producao","producao de criativos"],
 CREATIVE_APPROVAL:["aprovacao de criativos","criativos aprovados","cliente aprovou os criativos","aprovacao"],
 READY_TO_LAUNCH:["pronto para lancar","pronto para campanha"],CAMPAIGN_LAUNCH:["campanha no ar","campanha publicada","campanha lancada","campanha ativa"],
 COMPLETED:["onboarding concluido","onboarding finalizado"]
};
const STAGE_STATUS:Record<string,string>={pendente:"PENDING",pending:"PENDING",andamento:"IN_PROGRESS",in_progress:"IN_PROGRESS",concluida:"DONE",concluido:"DONE",done:"DONE",bloqueada:"BLOCKED",bloqueado:"BLOCKED",blocked:"BLOCKED",pulada:"SKIPPED",pulado:"SKIPPED",skipped:"SKIPPED",mencionada:"MENTIONED",mentioned:"MENTIONED",agendada:"SCHEDULED",agendado:"SCHEDULED",scheduled:"SCHEDULED"};
const DONE_WORDS=["avancou","concluiu","concluida","concluido","finalizou","terminou","completou","ja fez","foi feita","foi feito","realizada","realizado","pode avancar","pode passar"];

function norm(v:unknown){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9._\[\]=:/-]+/g," ").trim().replace(/\s+/g," ");}
function plain(v:unknown){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");}
function scoreName(command:string,name:string){const n=plain(name);if(!n)return 0;if(command.includes(n))return 10000+n.length;const words=command.split(" ");const t=n.split(" ").filter(x=>x.length>=4);const m=t.filter(x=>words.includes(x));if(t.length&&m.length===t.length)return 5000+m.join("").length;if(m.length>=2)return 1500+m.join("").length;if(m.length===1&&m[0].length>=6)return 200+m[0].length;return 0;}
function explicitStage(command:string,defs:Row[]){let best:{code:string,len:number}|null=null;for(const d of defs){const code=String(d.code);const aliases=[...(FIXED_ALIASES[code]||[]),String(d.label||""),code.replaceAll("_"," ")];for(const a0 of aliases){const a=plain(a0);if(a&&command.includes(a)&&(!best||a.length>best.len))best={code,len:a.length};}}return best?.code||null;}
function resolveStageToken(token:string,defs:Row[]){const t=plain(token);let best:Row|null=null;let len=0;for(const d of defs){for(const a0 of [...(FIXED_ALIASES[String(d.code)]||[]),String(d.label||""),String(d.code).replaceAll("_"," ")]){const a=plain(a0);if(a&&(t===a||t.includes(a)||a.includes(t))&&a.length>len){best=d;len=a.length;}}}return best?String(best.code):null;}
function getSPNowParts(){const f=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});const p=Object.fromEntries(f.formatToParts(new Date()).map(x=>[x.type,x.value]));return {year:+p.year,month:+p.month,day:+p.day,hour:+p.hour,minute:+p.minute};}
function daysInMonth(y:number,m:number){return new Date(Date.UTC(y,m,0)).getUTCDate();}
function addDays(y:number,m:number,d:number,delta:number){let yy=y,mm=m,dd=d+delta;while(dd>daysInMonth(yy,mm)){dd-=daysInMonth(yy,mm);mm++;if(mm>12){mm=1;yy++;}}while(dd<1){mm--;if(mm<1){mm=12;yy--;}dd+=daysInMonth(yy,mm);}return {year:yy,month:mm,day:dd};}
function weekday(y:number,m:number,d:number){return new Date(Date.UTC(y,m-1,d)).getUTCDay();}
function isoSP(y:number,m:number,d:number,h:number,min:number){return `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:00-03:00`;}
function parseDateTime(raw:string){const n=plain(raw);const now=getSPNowParts();let y=now.year,m=now.month,d=now.day;let foundDate=false;let mt=raw.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);if(mt){y=+mt[1];m=+mt[2];d=+mt[3];foundDate=true;}else{mt=raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?\b/);if(mt){d=+mt[1];m=+mt[2];if(mt[3])y=mt[3].length===2?2000+(+mt[3]):+mt[3];foundDate=true;}else if(/\bamanha\b/.test(n)){({year:y,month:m,day:d}=addDays(y,m,d,1));foundDate=true;}else if(/\bhoje\b/.test(n)){foundDate=true;}else{const wd:Record<string,number>={domingo:0,segunda:1,terca:2,quarta:3,quinta:4,sexta:5,sabado:6};for(const [name,target] of Object.entries(wd)){if(new RegExp(`\\b${name}(?: feira)?\\b`).test(n)){const cur=weekday(y,m,d);let delta=(target-cur+7)%7;if(delta===0)delta=7;({year:y,month:m,day:d}=addDays(y,m,d,delta));foundDate=true;break;}}}}
 let h:number|null=null,min=0;let tm=raw.match(/(?:às|as)\s*(\d{1,2})(?::(\d{2}))?/i);if(!tm)tm=raw.match(/\b(\d{1,2})h(?:(\d{2}))?\b/i);if(tm){h=+tm[1];min=tm[2]?+tm[2]:0;}if(!foundDate&&h===null)return null;if(!foundDate&&h!==null){if(h<now.hour||(h===now.hour&&min<=now.minute))({year:y,month:m,day:d}=addDays(y,m,d,1));}if(h===null)h=9;if(m<1||m>12||d<1||d>daysInMonth(y,m)||h<0||h>23||min<0||min>59)return null;return isoSP(y,m,d,h,min);}
function extractQuotedOrRest(raw:string,label:RegExp){const m=raw.match(label);return m?String(m[1]||"").trim().replace(/^["']|["']$/g,""):null;}
function blockedType(n:string){if(/cliente|documento|material|retorno/.test(n))return "BLOCKED_CLIENT";if(/intern|equipe|agencia|cs|gt|designer/.test(n))return "BLOCKED_INTERNAL";if(/tecnic|api|meta|make|zapi|acesso|token|integracao/.test(n))return "BLOCKED_TECHNICAL";return "BLOCKED_EXTERNAL";}
function findPerson(command:string,roster:Row[],role:string){const rows=roster.filter(r=>String(r.role)===role&&!r.is_former).map(r=>({row:r,score:scoreName(command,String(r.person))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);return rows[0]?.row?.person||null;}
function setStage(stages:Row[],stageCode:string,changes:Row){const i=stages.findIndex(x=>x.stage_code===stageCode);if(i>=0)stages[i]={...stages[i],...changes};else stages.push({stage_code:stageCode,...changes});}
function parseDirect(raw:string,defs:Row[],patch:Row){let count=0;const re=/(case|client)\.([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\n]+))/gi;for(const m of raw.matchAll(re)){const section=m[1].toLowerCase();const field=m[2];const value=(m[3]??m[4]??m[5]??"").trim();patch[section]=patch[section]||{};patch[section][field]=value.toLowerCase()==="null"?null:value;count++;}
 const sre=/stage\[([^\]]+)\]\.([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\n]+))/gi;for(const m of raw.matchAll(sre)){const code=resolveStageToken(m[1],defs)||m[1].trim().toUpperCase();const field=m[2];const value=(m[3]??m[4]??m[5]??"").trim();patch.stages=patch.stages||[];let st=patch.stages.find((x:Row)=>x.stage_code===code);if(!st){st={stage_code:code};patch.stages.push(st);}st[field]=value.toLowerCase()==="null"?null:value;count++;}
 const mre=/meeting\[([^\]]+)\]\.([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\n]+))/gi;for(const m of raw.matchAll(mre)){const code=resolveStageToken(m[1],defs)||m[1].trim().toUpperCase();patch.meeting=patch.meeting||{stage_code:code};patch.meeting.stage_code=code;patch.meeting[m[2]]=(m[3]??m[4]??m[5]??"").trim();count++;}return count;}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});if(req.method!=="POST")return respond({error:"method_not_allowed"},405);
 const url=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),anon=Deno.env.get("SUPABASE_ANON_KEY");if(!url||!service||!anon)return respond({error:"server_configuration"},500);
 const ah=req.headers.get("Authorization")||"";if(!ah.startsWith("Bearer "))return respond({error:"unauthorized"},401);
 const auth=createClient(url,anon,{global:{headers:{Authorization:ah}}});const {data:ud,error:ue}=await auth.auth.getUser();if(ue||!ud?.user?.id)return respond({error:"unauthorized"},401);
 const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops"),userKey=ud.user.id;
 const [{data:pref},{data:approval}]=await Promise.all([ops.from("user_preferences").select("collaborator_person").eq("user_key",userKey).maybeSingle(),ops.from("access_requests").select("id").eq("user_key",userKey).eq("kind","SIGNUP").eq("status","APPROVED").limit(1)]);
 const person=String(pref?.collaborator_person||"");if(person!=="Adler Furtado"||!(approval||[]).length)return respond({error:"forbidden",detail:"Comando administrativo disponível apenas para Adler."},403);
 const body=await req.json().catch(()=>({}));const raw=String(body?.command||"").trim();if(raw.length<5)return respond({error:"command_too_short",detail:"Escreva o cliente e a alteração desejada."},400);if(raw.length>2000)return respond({error:"command_too_long",detail:"Comando muito longo."},400);
 const command=plain(raw);
 const [{data:defs,error:defErr},{data:cases,error:caseErr},{data:roster}]=await Promise.all([ops.from("onboarding_stage_definitions").select("code,label,ordem").order("ordem"),ops.from("onboarding_cases").select("id,client_id,status,current_stage,next_action,next_action_due,opened_at,updated_at").order("opened_at",{ascending:false}),ops.from("team_roster").select("person,role,is_former")]);
 if(defErr||caseErr)return respond({error:"load_failed",detail:defErr?.message||caseErr?.message},500);const caseRows=cases||[],clientIds=[...new Set(caseRows.map((x:Row)=>String(x.client_id)))];
 const {data:clients,error:clErr}=await ops.from("clients").select("id,display_name,lifecycle,cs_owner,gt_owner,designer_owner").in("id",clientIds);if(clErr)return respond({error:"clients_failed",detail:clErr.message},500);const cm=new Map((clients||[]).map((x:Row)=>[String(x.id),x]));
 const bestCaseByClient=new Map<string,Row>();for(const c of caseRows){const key=String(c.client_id),old=bestCaseByClient.get(key);if(!old||String(c.status)==="OPEN"&&String(old.status)!=="OPEN")bestCaseByClient.set(key,c);}
 const candidates=[...bestCaseByClient.values()].map((c:Row)=>({case:c,client:cm.get(String(c.client_id))||{},score:scoreName(command,String((cm.get(String(c.client_id))||{}).display_name||""))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
 if(!candidates.length)return respond({error:"client_not_found",detail:"Não consegui identificar com segurança qual cliente você quis alterar."},422);if(candidates.length>1&&candidates[0].score<5000&&candidates[1].score===candidates[0].score)return respond({error:"client_ambiguous",detail:"Encontrei mais de um cliente possível. Escreva o nome mais completo.",options:candidates.slice(0,4).map(x=>x.client.display_name)},409);
 const selected=candidates[0],caseRow=selected.case,client=selected.client;
 const {data:stageRows,error:stErr}=await ops.from("onboarding_stages").select("id,stage_code,status,due_at,started_at,completed_at,blocked_type,notes,applicability").eq("case_id",caseRow.id);if(stErr)return respond({error:"stages_failed",detail:stErr.message},500);
 const patch:Row={};const stagePatches:Row[]=[];patch.stages=stagePatches;let actionCount=0;let explicitCaseOverride=false;let stageCode=explicitStage(command,defs||[]);const current=String(caseRow.current_stage||"");
 const refersCurrent=/etapa atual|essa etapa|nesta etapa|nessa etapa/.test(command);if(!stageCode&&refersCurrent)stageCode=current;
 actionCount+=parseDirect(raw,defs||[],patch);if(patch.case&&Object.keys(patch.case).some(k=>["status","current_stage","next_action","next_action_due"].includes(k)))explicitCaseOverride=true;

 const dt=parseDateTime(raw);
 const goBack=/\b(volta|voltar|retorna|retornar|reabre|reabrir)\b/.test(command);
 if(goBack&&stageCode&&stageCode!=="COMPLETED"){
   const targetDef=(defs||[]).find((d:Row)=>String(d.code)===stageCode),ord=Number(targetDef?.ordem??999);for(const s of stageRows||[]){const sd=(defs||[]).find((d:Row)=>String(d.code)===String(s.stage_code));if(Number(sd?.ordem??999)>=ord)setStage(stagePatches,String(s.stage_code),{status:String(s.stage_code)===stageCode?"IN_PROGRESS":"PENDING",completed_at:null,blocked_type:null});}
   patch.case={...(patch.case||{}),status:"OPEN",closed_at:null,current_stage:stageCode,blocked_by:null,next_action:`Concluir: ${targetDef?.label||stageCode}`};patch.client={...(patch.client||{}),lifecycle:"ONBOARDING"};patch.recalculate=false;explicitCaseOverride=true;actionCount++;
 }

 const explicitStatus=Object.entries(STAGE_STATUS).find(([w])=>new RegExp(`\\b${plain(w)}\\b`).test(command));
 if(stageCode&&explicitStatus&&/marca|status|coloca|deixa|fica|esta/.test(command)){const st=explicitStatus[1];setStage(stagePatches,stageCode,{status:st,...(st==="SCHEDULED"&&dt?{due_at:dt}:{}),...(st==="BLOCKED"?{blocked_type:blockedType(command)}:{})});if(st==="SCHEDULED"&&dt){const label=(defs||[]).find((d:Row)=>String(d.code)===stageCode)?.label||stageCode;patch.case={...(patch.case||{}),status:"OPEN",current_stage:stageCode,next_action:`Concluir: ${label}`,next_action_due:dt};patch.meeting={stage_code:stageCode,scheduled_for:dt};patch.recalculate=false;explicitCaseOverride=true;}else patch.recalculate=true;actionCount++;}

 if(!goBack&&stageCode&&DONE_WORDS.some(w=>command.includes(plain(w)))){setStage(stagePatches,stageCode,{status:"DONE",completed_at:new Date().toISOString(),blocked_type:null,append_note:`Confirmação administrativa por Adler: ${raw}`});patch.recalculate=true;actionCount++;}

 const scheduling=/\b(reagenda|reagendar|agenda|agendar|agendou|remarca|remarcar|marca reuniao|marcar reuniao)\b/.test(command);
 if(scheduling){if(!stageCode)stageCode=current;if(!stageCode||!dt)return respond({error:"schedule_not_understood",detail:`Identifiquei ${client.display_name}, mas preciso da etapa e de uma data/horário. Ex.: “${client.display_name} reagenda integração para segunda 17h”.`},422);const label=(defs||[]).find((d:Row)=>String(d.code)===stageCode)?.label||stageCode;setStage(stagePatches,stageCode,{status:"SCHEDULED",due_at:dt,completed_at:null,blocked_type:null});patch.case={...(patch.case||{}),status:"OPEN",closed_at:null,current_stage:stageCode,next_action:`Concluir: ${label}`,next_action_due:dt,blocked_by:null};patch.meeting={...(patch.meeting||{}),stage_code:stageCode,scheduled_for:dt};patch.recalculate=false;explicitCaseOverride=true;actionCount++;}

 if(/\b(desbloqueia|desbloquear|tirar bloqueio|remove bloqueio)\b/.test(command)){if(!stageCode)stageCode=current;if(stageCode){setStage(stagePatches,stageCode,{status:"PENDING",blocked_type:null});patch.case={...(patch.case||{}),blocked_by:null,status:"OPEN",closed_at:null};patch.recalculate=true;actionCount++;}}
 else if(/\b(bloqueia|bloquear|bloqueado|bloqueada)\b/.test(command)&&!explicitStatus){if(!stageCode)stageCode=current;if(stageCode){const bt=blockedType(command);setStage(stagePatches,stageCode,{status:"BLOCKED",blocked_type:bt,completed_at:null});patch.case={...(patch.case||{}),blocked_by:bt,status:"OPEN",closed_at:null};patch.recalculate=true;actionCount++;}}

 const gt=findPerson(command,roster||[],"GT"),cs=findPerson(command,roster||[],"CS"),designer=findPerson(command,roster||[],"DESIGN");
 if((/\bgt\b|gestor de trafego|troca gestor|muda gestor/.test(command))&&gt){patch.client={...(patch.client||{}),gt_owner:gt};actionCount++;}
 if(/\bcs\b|customer success|troca cs|muda cs/.test(command)&&cs){patch.client={...(patch.client||{}),cs_owner:cs};actionCount++;}
 if(/designer|design/.test(command)&&designer){patch.client={...(patch.client||{}),designer_owner:designer};actionCount++;}

 const riskMatch=command.match(/risco\s+(ok|atencao|alto|critico)/);if(riskMatch){const map:Record<string,string>={ok:"OK",atencao:"ATTENTION",alto:"HIGH",critico:"CRITICAL"};patch.case={...(patch.case||{}),onboarding_risk:map[riskMatch[1]]};actionCount++;}
 const nextAction=extractQuotedOrRest(raw,/pr[oó]xima\s+a[cç][aã]o\s*(?:é|:|=|para)?\s*["']?(.+?)["']?\s*$/i);if(nextAction){patch.case={...(patch.case||{}),next_action:nextAction,...(dt?{next_action_due:dt}:{})};explicitCaseOverride=true;patch.recalculate=false;actionCount++;}
 const note=extractQuotedOrRest(raw,/(?:nota|observa[cç][aã]o)\s*(?:na\s+etapa)?\s*(?:é|:|=)?\s*["']?(.+?)["']?\s*$/i);if(note&&/\bnota\b|observacao/.test(command)){if(!stageCode)stageCode=current;if(stageCode){setStage(stagePatches,stageCode,{append_note:`Adler: ${note}`});actionCount++;}}

 const app=/nao se aplica|não se aplica/.test(raw.toLowerCase())?"NOT_APPLICABLE":/obrigatori|obrigatorio|required/.test(command)?"REQUIRED":/opcional|optional/.test(command)?"OPTIONAL":null;if(app&&stageCode){setStage(stagePatches,stageCode,{applicability:app,applicability_source:"manual_adler_command",applicability_evidence:raw,applicability_confidence:1});actionCount++;}
 const meet=raw.match(/https:\/\/meet\.google\.com\/[A-Za-z0-9-]+/i)?.[0];if(meet){if(!stageCode)stageCode=current;if(stageCode){patch.meeting={...(patch.meeting||{}),stage_code:stageCode,url:meet,provider:"google_meet",...(dt?{scheduled_for:dt}:{})};actionCount++;}}
 const creativeDue=/prazo (?:dos )?criativ|creative due|sla criativ/.test(command);if(creativeDue&&dt){patch.case={...(patch.case||{}),creative_due_at:dt};actionCount++;}

 if(/onboarding (?:esta |fica |como )?(?:concluido|finalizado|completed)/.test(command)&&!stageCode){patch.case={...(patch.case||{}),status:"COMPLETED",current_stage:"COMPLETED",closed_at:new Date().toISOString(),next_action:null,next_action_due:null,blocked_by:null};patch.client={...(patch.client||{}),lifecycle:"ACTIVE"};patch.recalculate=false;explicitCaseOverride=true;actionCount++;}
 if(/onboarding (?:esta |fica |como )?(?:aberto|reaberto|open)/.test(command)){patch.case={...(patch.case||{}),status:"OPEN",closed_at:null};patch.client={...(patch.client||{}),lifecycle:"ONBOARDING"};patch.recalculate=false;explicitCaseOverride=true;actionCount++;}
 if(/onboarding (?:esta |fica |como )?(?:abortado|cancelado|aborted)/.test(command)){patch.case={...(patch.case||{}),status:"ABORTED",closed_at:new Date().toISOString()};patch.recalculate=false;explicitCaseOverride=true;actionCount++;}

 const lc:Record<string,string>={"cliente ativo":"ACTIVE","cliente em onboarding":"ONBOARDING","cliente pausado":"PAUSED","cliente churned":"CHURNED","cliente prospect":"PROSPECT"};for(const [phrase,value] of Object.entries(lc)){if(command.includes(phrase)){patch.client={...(patch.client||{}),lifecycle:value};actionCount++;}}

 if(!stagePatches.length)delete patch.stages;if(!patch.meeting||Object.keys(patch.meeting).length<=1&&!patch.meeting.url&&!patch.meeting.scheduled_for)delete patch.meeting;if(actionCount===0)return respond({error:"action_not_understood",detail:"Identifiquei o cliente, mas não entendi a alteração. Você pode concluir/reabrir/reagendar/bloquear etapas, mudar GT/CS/designer, risco, próxima ação, datas, notas, status e demais campos do onboarding. Para casos muito específicos use, por exemplo: case.next_action=Texto; client.gt_owner=Yuri Melo; stage[INTEGRATION_MEETING].status=SCHEDULED."},422);
 if(patch.recalculate===undefined)patch.recalculate=!explicitCaseOverride&&Boolean(patch.stages?.some((s:Row)=>s.status));
 const {data:result,error:rpcErr}=await ops.rpc("apply_onboarding_admin_patch",{p_case_id:caseRow.id,p_actor_user_id:userKey,p_actor_person:person,p_command:raw,p_patch:patch});if(rpcErr)return respond({error:"update_failed",detail:rpcErr.message,patch},500);
 const after=(result as Row)?.after||{};return respond({ok:true,changed:true,audit_id:(result as Row)?.audit_id,client:client.display_name,client_id:caseRow.client_id,case_id:caseRow.id,patch,case:after.case,client_state:after.client,message:`${client.display_name}: atualização administrativa aplicada e auditada.`});
});