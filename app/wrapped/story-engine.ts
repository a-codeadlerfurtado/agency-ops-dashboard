export type WrappedMode = "summary" | "full" | "mgmt";
export type WrappedStory = {
  id: string;
  chapter: string;
  kicker?: string;
  title: string;
  value?: string;
  subtitle?: string;
  note?: string;
  tone?: "blue" | "green" | "orange" | "purple" | "red" | "dark";
  stats?: Array<{ label: string; value: string; delta?: string }>;
  ranking?: Array<{ name: string; value: string; meta?: string }>;
  modes?: WrappedMode[];
};

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const n = (v: any) => Number(v ?? 0);
const pct = (v: any) => v == null ? "â€”" : `${nf.format(n(v))}%`;
const num = (v: any) => nf.format(n(v));
const brl = (v: any) => money.format(n(v));
const delta = (current: any, previous: any, suffix = "%") => {
  const a = n(current), b = n(previous);
  if (!b) return "sem base anterior";
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? "â–²" : "â–¼"} ${nf.format(Math.abs(d))}${suffix} vs mÃªs anterior`;
};
const rank = (rows: any[] = [], field: string, suffix = "") => rows.slice(0, 5).map((r) => ({
  name: String(r.person || "â€”"), value: `${num(r[field])}${suffix}`,
  meta: r.is_former ? "atuava na agÃªncia neste perÃ­odo" : String(r.role || ""),
}));export function storyDuration(story: WrappedStory) {
  const words = [story.kicker, story.title, story.value, story.subtitle, story.note,
    ...(story.stats || []).flatMap((s) => [s.label, s.value, s.delta]),
    ...(story.ranking || []).flatMap((r) => [r.name, r.value, r.meta])]
    .filter(Boolean).join(" ").trim().split(/\s+/).filter(Boolean).length;
  const complexity = (story.stats?.length || 0) * 420 + (story.ranking?.length || 0) * 520;
  return Math.max(4200, Math.min(14500, 2800 + words * 185 + complexity));
}

export function buildStories(p: any, mode: WrappedMode): WrappedStory[] {
  const pf = p.portfolio || {}, prev = p.previous || {}, tasks = p.tasks || {};
  const finance = p.finance || {}, meta = p.meta || {}, weekly = p.weekly_gt || {};
  const sourceRaw = p.sources || {};
  const sources = Object.fromEntries(Object.entries(sourceRaw).filter(([key]) => !["work_items","work_events"].includes(key)));
  const rankings = p.rankings || {};
  const monthName = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${p.month_key}-01T12:00:00Z`));
  const coverage = p.coverage_tier === "FULL" ? "Cobertura completa" : p.coverage_tier === "PARTIAL_STRONG" ? "Cobertura histÃ³rica forte" : "Cobertura histÃ³rica parcial";
  const all: WrappedStory[] = [
    { id:"intro", chapter:"ABERTURA", kicker:"LEONARDO IMOBI", title:`Foi assim que ${monthName} aconteceu.`, subtitle:p.is_open_month ? "MÃªs ainda em andamento Â· nÃºmeros podem mudar atÃ© o fechamento." : "Um mÃªs inteiro contado pelos dados da operaÃ§Ã£o.", tone:"blue" },
    { id:"coverage", chapter:"DADOS", kicker:"ANTES DE COMEÃ‡AR", title:coverage, value:p.coverage_tier.replace("_"," "), subtitle:"O Wrapped sÃ³ usa fontes confiÃ¡veis disponÃ­veis naquele perÃ­odo. A Central de Trabalho Ã© desconsiderada por polÃ­tica de qualidade; ausÃªncia de dado nunca vira zero.", tone:"purple", stats:[
      {label:"ClickUp",value:num(tasks.completed)}, {label:"WhatsApp",value:num(sources.whatsapp)}, {label:"TaskLog",value:num(sources.tasklog)}, {label:"Ajustes",value:num(sources.adjustments)}] },
    { id:"clients", chapter:"A AGÃŠNCIA", kicker:"A BASE", title:"Clientes no fim do mÃªs", value:num(pf.active_clients), subtitle:`${num(pf.entries)} chegaram Â· ${num(pf.churns)} churnaram`, tone:"green", stats:[
      {label:"Entradas",value:`+${num(pf.entries)}`,delta:delta(pf.entries,prev.entries)}, {label:"Churns",value:`-${num(pf.churns)}`,delta:delta(pf.churns,prev.churns)}, {label:"Saldo lÃ­quido",value:`${n(pf.client_balance)>=0?"+":""}${num(pf.client_balance)}`} ] },
  ];  all.push(
    { id:"retention", chapter:"A AGÃŠNCIA", kicker:"RETENÃ‡ÃƒO", title:"Quanto tempo a base fica com a gente?", value:`${num(pf.ltv_months)} meses`, subtitle:"LTV mÃ©dio da carteira ativa", tone:"blue", stats:[
      {label:"LTV",value:`${num(pf.ltv_months)}m`,delta:delta(pf.ltv_months,prev.ltv_months)},
      {label:"TPC dos churns",value:pf.tpc_months==null?"â€”":`${num(pf.tpc_months)}m`,delta:prev.tpc_months==null?"sem base anterior":delta(pf.tpc_months,prev.tpc_months)},
      {label:"Taxa de churn",value:pct(pf.churn_rate),delta:prev.churn_rate==null?"sem base anterior":delta(pf.churn_rate,prev.churn_rate)}] },
    { id:"finance", chapter:"A AGÃŠNCIA", kicker:"CRESCIMENTO CONHECIDO", title:n(finance.mrr_net_known)>=0?"A receita contratada conhecida cresceu.":"A receita contratada conhecida encolheu.", value:`${n(finance.mrr_net_known)>=0?"+":""}${brl(finance.mrr_net_known)}`, subtitle:`${brl(finance.mrr_added_known)} de MRR conhecido entrou Â· ${brl(finance.mrr_lost_known)} saiu`, note:`Cobertura financeira conhecida: ${pct(finance.coverage_pct)} dos clientes considerados. NÃ£o Ã© lucro nem caixa: Ã© saldo de mensalidade conhecida.`, tone:n(finance.mrr_net_known)>=0?"green":"red", modes:["full","mgmt"] },
    { id:"tasks", chapter:"A OPERAÃ‡ÃƒO", kicker:"O MÃŠS EM MOVIMENTO", title:"Tasks concluÃ­das", value:num(tasks.completed), subtitle:`${num(tasks.created)} novas tasks foram criadas no mesmo perÃ­odo`, tone:"orange", stats:[
      {label:"Criadas",value:num(tasks.created)}, {label:"ConcluÃ­das",value:num(tasks.completed)}, {label:"Ciclo mediano",value:tasks.cycle_median_hours==null?"â€”":`${num(tasks.cycle_median_hours)}h`}] },
    { id:"taskmix", chapter:"A OPERAÃ‡ÃƒO", kicker:"PARA ONDE FOI O TRABALHO?", title:"O volume se dividiu assim.", tone:"purple", stats:[
      {label:"TrÃ¡fego",value:num(tasks.traffic)}, {label:"Design",value:num(tasks.design)}, {label:"Copy / Roteiro",value:num(tasks.copy)}, {label:"Outros",value:num(Math.max(0,n(tasks.completed)-n(tasks.traffic)-n(tasks.design)-n(tasks.copy)))}] },
    { id:"task-sla", chapter:"A OPERAÃ‡ÃƒO", kicker:"PONTUALIDADE JUSTA", title:"Tasks dentro do prazo real", value:pct(tasks.on_time_rate), subtitle:`${num(tasks.on_time)} de ${num(tasks.due_real)} tasks com prazo posterior Ã  criaÃ§Ã£o`, note:`${num(tasks.born_overdue)} tasks nasceram vencidas e foram excluÃ­das da cobranÃ§a individual.`, tone:"blue", modes:["full","mgmt"] }
  );  if (rankings.tasks_created?.length) all.push({ id:"creator", chapter:"AS PESSOAS", kicker:"QUEM MAIS GEROU DEMANDA", title:"CampeÃ£o de tasks criadas", value:rankings.tasks_created[0].person, subtitle:`${num(rankings.tasks_created[0].tasks_created)} tasks criadas`, tone:"orange", ranking:rank(rankings.tasks_created,"tasks_created"), modes:["full","mgmt"] });
  if (rankings.tasks_completed?.length) all.push({ id:"productive", chapter:"AS PESSOAS", kicker:"PRODUTIVIDADE", title:"Quem mais concluiu", value:rankings.tasks_completed[0].person, subtitle:`${num(rankings.tasks_completed[0].tasks_completed)} tasks concluÃ­das`, tone:"green", ranking:rank(rankings.tasks_completed,"tasks_completed") });
  if (rankings.traffic?.length) all.push({ id:"traffic", chapter:"TRÃFEGO", kicker:"VOLUME DE EXECUÃ‡ÃƒO", title:"Quem mais concluiu trabalho de TrÃ¡fego", value:rankings.traffic[0].person, subtitle:`${num(rankings.traffic[0].tasks)} tasks relacionadas a trÃ¡fego`, tone:"blue", ranking:rank(rankings.traffic,"tasks") });
  if (rankings.design?.length) all.push({ id:"design", chapter:"DESIGN", kicker:"VOLUME CRIATIVO", title:"Quem mais concluiu trabalho de Design", value:rankings.design[0].person, subtitle:`${num(rankings.design[0].tasks)} tasks relacionadas a Design`, tone:"purple", ranking:rank(rankings.design,"tasks") });
  if (rankings.task_sla?.length) all.push({ id:"sla-champion", chapter:"AS PESSOAS", kicker:"SLA DE TASK", title:"Melhor pontualidade do mÃªs", value:rankings.task_sla[0].person, subtitle:`${pct(rankings.task_sla[0].rate)} Â· ${num(rankings.task_sla[0].due_real)} tasks elegÃ­veis`, note:"SÃ³ entra no ranking quem teve pelo menos 10 tasks com prazo real.", tone:"green", ranking:rank(rankings.task_sla,"rate","%"), modes:["full","mgmt"] });
  const cs = (rankings.response_speed || []).filter((r:any)=>r.role==="CS");
  const gt = (rankings.response_speed || []).filter((r:any)=>r.role==="GT");
  if (cs.length) all.push({ id:"cs-response", chapter:"CS", kicker:"WHATSAPP Â· MINUTOS ÃšTEIS", title:"Resposta mais rÃ¡pida entre CS", value:cs[0].person, subtitle:`mediana de ${num(cs[0].median_minutes)} min Â· ${num(cs[0].replies)} respostas`, note:`P90: ${num(cs[0].p90_minutes)} min. Uma sequÃªncia de mensagens do cliente conta como uma Ãºnica espera.`, tone:"green", ranking:cs.map((r:any)=>({name:r.person,value:`${num(r.median_minutes)} min`,meta:`${num(r.replies)} respostas Â· P90 ${num(r.p90_minutes)} min`})) });
  if (gt.length) all.push({ id:"gt-response", chapter:"TRÃFEGO", kicker:"WHATSAPP Â· RESPOSTA DIRETA", title:"Tempo de resposta dos GTs", value:gt[0].person, subtitle:`mediana de ${num(gt[0].median_minutes)} min Â· ${num(gt[0].replies)} respostas`, note:"Esta mÃ©trica mede respostas diretamente atribuÃ­das ao GT. O SLA causal de demandas que dependiam do GT Ã© separado e nÃ£o Ã© inferido sem evidÃªncia de handoff.", tone:"blue", ranking:gt.map((r:any)=>({name:r.person,value:`${num(r.median_minutes)} min`,meta:`${num(r.replies)} respostas Â· P90 ${num(r.p90_minutes)} min`})) , modes:["full","mgmt"] });  if (n(sources.gt_weekly)>0 || n(sources.gt_analyses)>0) all.push({ id:"weekly", chapter:"TRÃFEGO", kicker:"AS QUINTAS-FEIRAS", title:"AnÃ¡lises semanais viraram dado operacional.", value:num(weekly.analyses), subtitle:`anÃ¡lises de clientes Â· ${num(weekly.submissions)} entregas consolidadas`, tone:"orange", stats:[
    {label:"Com diagnÃ³stico",value:num(weekly.with_diagnosis)}, {label:"Com hipÃ³tese",value:num(weekly.with_hypothesis)}, {label:"Com decisÃ£o",value:num(weekly.with_decision)}, {label:"Com prÃ³xima validaÃ§Ã£o",value:num(weekly.with_validation)}], modes:["full","mgmt"] });
  if (n(sources.meta)>0) all.push({ id:"meta", chapter:"TRÃFEGO", kicker:"META ADS", title:"MÃ­dia acompanhada no mÃªs", value:brl(meta.spend), subtitle:`${num(meta.leads)} leads Â· CPL ${meta.cpl==null?"â€”":brl(meta.cpl)}`, tone:"blue", stats:[
    {label:"Clientes",value:num(meta.clients)}, {label:"Campanhas",value:num(meta.campaigns)}, {label:"Linhas histÃ³ricas",value:num(sources.meta)}], modes:["full","mgmt"] });
  if (mode === "mgmt") all.push({ id:"sources", chapter:"MGMT", kicker:"RAIO-X DA EVIDÃŠNCIA", title:"O que sustentou este Wrapped", value:num(Object.values(sources).reduce((a:any,b:any)=>n(a)+n(b),0)), subtitle:"eventos/linhas operacionais disponÃ­veis nas fontes modernas", tone:"dark", stats:Object.entries(sources).filter(([,v])=>n(v)>0).sort((a:any,b:any)=>n(b[1])-n(a[1])).slice(0,6).map(([k,v])=>({label:k.replaceAll("_"," "),value:num(v)})) });
  all.push({ id:"final", chapter:"FECHAMENTO", kicker:"LEONARDO IMOBI", title:`${monthName} ficou registrado.`, value:`${num(tasks.completed)} tasks`, subtitle:`${num(pf.active_clients)} clientes Â· ${pct(tasks.on_time_rate)} de pontualidade nas tasks elegÃ­veis`, note:p.is_open_month?"Este mÃªs ainda estÃ¡ aberto. O fechamento oficial serÃ¡ congelado apÃ³s virar o mÃªs.":"Este Ã© o snapshot oficial disponÃ­vel para este fechamento.", tone:"blue" });
  return all.filter((s) => !s.modes || s.modes.includes(mode));
}
