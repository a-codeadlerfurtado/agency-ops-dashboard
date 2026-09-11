export type MonthlyStory={
  id:string;kicker:string;title:string;value?:string;subtitle?:string;note?:string;
  tone?:"blue"|"green"|"orange"|"purple"|"red";
  stats?:Array<{label:string;value:string;delta?:string;cls?:string}>;
  weeks?:Array<any>;campaigns?:Array<any>;creatives?:Array<any>;steps?:string[];
};
const nf=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});
const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const n=(v:any)=>Number(v??0),num=(v:any)=>nf.format(n(v)),brl=(v:any)=>money.format(n(v));
const pct=(v:any)=>v==null?"—":`${v>=0?"+":""}${nf.format(n(v))}%`;
const trend=(v:any,inverse=false)=>{const x=Number(v);if(!Number.isFinite(x))return{txt:"sem base anterior",cls:"muted"};const good=inverse?x<0:x>0;return{txt:`${x>0?"↑":x<0?"↓":"="} ${nf.format(Math.abs(x))}% vs mês anterior`,cls:good?"good":x===0?"muted":"bad"};};
const monthName=(key:string)=>{const x=new Intl.DateTimeFormat("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${key}-01T12:00:00Z`));return x.charAt(0).toUpperCase()+x.slice(1);};
export function duration(s:MonthlyStory){const words=[s.kicker,s.title,s.value,s.subtitle,s.note,...(s.steps||[]),...(s.stats||[]).flatMap(x=>[x.label,x.value,x.delta])].filter(Boolean).join(" ").split(/\s+/).length;return Math.max(4800,Math.min(15000,3000+words*190+(s.weeks?.length||0)*650+(s.campaigns?.length||0)*500+(s.creatives?.length||0)*750));}
export function buildMonthlyStories(payload:any):MonthlyStory[]{
  const p=payload?.report||payload||{},cur=p.current||{},prev=p.previous||{},tr=p.trends||{},weeks=p.weeks||[],campaigns=p.campaigns||[],creatives=p.creatives||[],narr=p.narrative||{},cov=p.coverage||{};
  const stories:MonthlyStory[]=[
    {id:"intro",kicker:"LEONARDO IMOBI · FECHAMENTO MENSAL",title:`${payload.client_name||"Seu negócio"}, este foi o seu ${monthName(p.month_key||String(payload.month_start||"").slice(0,7))}.`,subtitle:"Uma leitura consolidada das semanas, campanhas, resultados e criativos do mês.",tone:"blue"},
    {id:"headline",kicker:"RESUMO EXECUTIVO",title:narr.headline||"O mês em uma leitura.",subtitle:narr.body||"Consolidado dos relatórios semanais auditados.",note:cov.status!=="PASS"?`Cobertura histórica parcial: ${cov.current_week_count||0}/4 semanas do mês e ${cov.previous_week_count||0}/4 do mês anterior.`:undefined,tone:cov.status==="PASS"?"green":"orange"},
    {id:"numbers",kicker:"OS NÚMEROS DO MÊS",title:"Performance consolidada",value:num(cur.results),subtitle:"resultados no período",tone:"green",stats:[
      {label:"Investimento",value:brl(cur.spend),delta:trend(tr.spend?.delta,true).txt,cls:trend(tr.spend?.delta,true).cls},
      {label:"Resultados",value:num(cur.results),delta:trend(tr.results?.delta).txt,cls:trend(tr.results?.delta).cls},
      {label:"Custo por resultado",value:cur.cpr==null?"—":brl(cur.cpr),delta:trend(tr.cpr?.delta,true).txt,cls:trend(tr.cpr?.delta,true).cls},
      {label:"CTR",value:cur.ctr==null?"—":`${num(cur.ctr)}%`,delta:trend(tr.ctr?.delta).txt,cls:trend(tr.ctr?.delta).cls}]},
  ];
  if(weeks.length)stories.push({id:"weeks",kicker:"SEMANA A SEMANA",title:`${weeks.length} semanas contam a história do mês.`,subtitle:"Compare ritmo, investimento, resultado e eficiência entre os ciclos.",weeks,tone:"purple"});
  for(const w of weeks)stories.push({id:`week-${w.index}`,kicker:`SEMANA ${w.index} · ${w.period_start} → ${w.period_end}`,title:w.headline||`A semana ${w.index} em números`,value:num(w.results),subtitle:"resultados",note:w.key_insight||undefined,tone:w.index%2?"blue":"purple",stats:[
    {label:"Investimento",value:brl(w.spend)},{label:"CPR",value:w.cpr==null?"—":brl(w.cpr)},{label:"CTR",value:w.ctr==null?"—":`${num(w.ctr)}%`},{label:"Impressões",value:num(w.impressions)}]});
  if(campaigns.length)stories.push({id:"campaigns",kicker:"CAMPANHAS",title:"Onde o resultado aconteceu",subtitle:"Campanhas ordenadas pelo volume de resultados no consolidado mensal.",campaigns,tone:"orange"});
  if(creatives.length)stories.push({id:"creatives",kicker:"CRIATIVOS",title:"As peças que marcaram o mês",subtitle:"Thumbnails reais dos anúncios em destaque nos relatórios semanais auditados.",creatives,tone:"purple"});
  if(narr.key_insight)stories.push({id:"insight",kicker:"PRINCIPAL LEITURA",title:narr.key_insight,tone:"blue"});
  if(Array.isArray(narr.next_steps)&&narr.next_steps.length)stories.push({id:"next",kicker:"PRÓXIMO CICLO",title:"O que fazemos a partir daqui",steps:narr.next_steps.slice(0,4),tone:"green"});
  stories.push({id:"final",kicker:"FECHAMENTO",title:`${monthName(p.month_key||String(payload.month_start||"").slice(0,7))} ficou registrado.`,value:num(cur.results),subtitle:`resultados · ${brl(cur.spend)} investidos · CPR ${cur.cpr==null?"—":brl(cur.cpr)}`,note:cov.status==="PASS"?"Fechamento consolidado a partir dos quatro relatórios semanais auditados.":"Apresentação parcial: as semanas disponíveis foram consolidadas e a cobertura aparece sinalizada.",tone:"blue"});
  return stories;
}
