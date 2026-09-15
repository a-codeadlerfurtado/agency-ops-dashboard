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
const pct = (v: any) => v == null ? "—" : `${nf.format(n(v))}%`;
const num = (v: any) => nf.format(n(v));
const brl = (v: any) => money.format(n(v));
const delta = (current: any, previous: any, suffix = "%") => {
  const a = n(current), b = n(previous);
  if (!b) return "sem base anterior";
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? "▲" : "▼"} ${nf.format(Math.abs(d))}${suffix} vs mês anterior`;
};
const rank = (rows: any[] = [], field: string, suffix = "") => rows.slice(0, 5).map((r) => ({
  name: String(r.person || "—"), value: `${num(r[field])}${suffix}`,
  meta: r.is_former ? "atuava na agência neste período" : String(r.role || ""),
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
  const sources = p.sources || {}, rankings = p.rankings || {};
  const monthName = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${p.month_key}-01T12:00:00Z`));
  const coverage = p.coverage_tier === "FULL" ? "Cobertura completa" : p.coverage_tier === "PARTIAL_STRONG" ? "Cobertura histórica forte" : "Cobertura histórica parcial";
  const all: WrappedStory[] = [
    { id:"intro", chapter:"ABERTURA", kicker:"LEONARDO IMOBI", title:`Foi assim que ${monthName} aconteceu.`, subtitle:p.is_open_month ? "Mês ainda em andamento · números podem mudar até o fechamento." : "Um mês inteiro contado pelos dados da operação.", tone:"blue" },
    { id:"coverage", chapter:"DADOS", kicker:"ANTES DE COMEÇAR", title:coverage, value:p.coverage_tier.replace("_"," "), subtitle:"O Wrapped só usa uma métrica quando a fonte existia naquele período. Ausência de dado nunca vira zero.", tone:"purple", stats:[
      {label:"ClickUp",value:num(tasks.completed)}, {label:"WhatsApp",value:num(sources.whatsapp)}, {label:"TaskLog",value:num(sources.tasklog)}, {label:"Ajustes",value:num(sources.adjustments)}] },
    { id:"clients", chapter:"A AGÊNCIA", kicker:"A BASE", title:"Clientes no fim do mês", value:num(pf.active_clients), subtitle:`${num(pf.entries)} chegaram · ${num(pf.churns)} churnaram`, tone:"green", stats:[
      {label:"Entradas",value:`+${num(pf.entries)}`,delta:delta(pf.entries,prev.entries)}, {label:"Churns",value:`-${num(pf.churns)}`,delta:delta(pf.churns,prev.churns)}, {label:"Saldo líquido",value:`${n(pf.client_balance)>=0?"+":""}${num(pf.client_balance)}`} ] },
  ];  all.push(
    { id:"retention", chapter:"A AGÊNCIA", kicker:"RETENÇÃO", title:"Quanto tempo a base fica com a gente?", value:`${num(pf.ltv_months)} meses`, subtitle:"LTV médio da carteira ativa", tone:"blue", stats:[
      {label:"LTV",value:`${num(pf.ltv_months)}m`,delta:delta(pf.ltv_months,prev.ltv_months)},
      {label:"TPC dos churns",value:pf.tpc_months==null?"—":`${num(pf.tpc_months)}m`,delta:prev.tpc_months==null?"sem base anterior":delta(pf.tpc_months,prev.tpc_months)},
      {label:"Taxa de churn",value:pct(pf.churn_rate),delta:prev.churn_rate==null?"sem base anterior":delta(pf.churn_rate,prev.churn_rate)}] },
    { id:"finance", chapter:"A AGÊNCIA", kicker:"CRESCIMENTO CONHECIDO", title:n(finance.mrr_net_known)>=0?"A receita contratada conhecida cresceu.":"A receita contratada conhecida encolheu.", value:`${n(finance.mrr_net_known)>=0?"+":""}${brl(finance.mrr_net_known)}`, subtitle:`${brl(finance.mrr_added_known)} de MRR conhecido entrou · ${brl(finance.mrr_lost_known)} saiu`, note:`Cobertura financeira conhecida: ${pct(finance.coverage_pct)} dos clientes considerados. Não é lucro nem caixa: é saldo de mensalidade conhecida.`, tone:n(finance.mrr_net_known)>=0?"green":"red", modes:["full","mgmt"] },
    { id:"tasks", chapter:"A OPERAÇÃO", kicker:"O MÊS EM MOVIMENTO", title:"Tasks concluídas", value:num(tasks.completed), subtitle:`${num(tasks.created)} novas tasks foram criadas no mesmo período`, tone:"orange", stats:[
      {label:"Criadas",value:num(tasks.created)}, {label:"Concluídas",value:num(tasks.completed)}, {label:"Ciclo mediano",value:tasks.cycle_median_hours==null?"—":`${num(tasks.cycle_median_hours)}h`}] },
    { id:"taskmix", chapter:"A OPERAÇÃO", kicker:"PARA ONDE FOI O TRABALHO?", title:"O volume se dividiu assim.", tone:"purple", stats:[
      {label:"Tráfego",value:num(tasks.traffic)}, {label:"Design",value:num(tasks.design)}, {label:"Copy / Roteiro",value:num(tasks.copy)}, {label:"Outros",value:num(Math.max(0,n(tasks.completed)-n(tasks.traffic)-n(tasks.design)-n(tasks.copy)))}] },
    { id:"task-sla", chapter:"A OPERAÇÃO", kicker:"PONTUALIDADE JUSTA", title:"Tasks dentro do prazo real", value:pct(tasks.on_time_rate), subtitle:`${num(tasks.on_time)} de ${num(tasks.due_real)} tasks com prazo posterior à criação`, note:`${num(tasks.born_overdue)} tasks nasceram vencidas e foram excluídas da cobrança individual.`, tone:"blue", modes:["full","mgmt"] }
  );  if (rankings.tasks_created?.length) all.push({ id:"creator", chapter:"AS PESSOAS", kicker:"QUEM MAIS GEROU DEMANDA", title:"Campeão de tasks criadas", value:rankings.tasks_created[0].person, subtitle:`${num(rankings.tasks_created[0].tasks_created)} tasks criadas`, tone:"orange", ranking:rank(rankings.tasks_created,"tasks_created"), modes:["full","mgmt"] });
  if (rankings.tasks_completed?.length) all.push({ id:"productive", chapter:"AS PESSOAS", kicker:"PRODUTIVIDADE", title:"Quem mais concluiu", value:rankings.tasks_completed[0].person, subtitle:`${num(rankings.tasks_completed[0].tasks_completed)} tasks concluídas`, tone:"green", ranking:rank(rankings.tasks_completed,"tasks_completed") });
  if (rankings.traffic?.length) all.push({ id:"traffic", chapter:"TRÁFEGO", kicker:"VOLUME DE EXECUÇÃO", title:"Quem mais concluiu trabalho de Tráfego", value:rankings.traffic[0].person, subtitle:`${num(rankings.traffic[0].tasks)} tasks relacionadas a tráfego`, tone:"blue", ranking:rank(rankings.traffic,"tasks") });
  if (rankings.design?.length) all.push({ id:"design", chapter:"DESIGN", kicker:"VOLUME CRIATIVO", title:"Quem mais concluiu trabalho de Design", value:rankings.design[0].person, subtitle:`${num(rankings.design[0].tasks)} tasks relacionadas a Design`, tone:"purple", ranking:rank(rankings.design,"tasks") });
  if (rankings.task_sla?.length) all.push({ id:"sla-champion", chapter:"AS PESSOAS", kicker:"SLA DE TASK", title:"Melhor pontualidade do mês", value:rankings.task_sla[0].person, subtitle:`${pct(rankings.task_sla[0].rate)} · ${num(rankings.task_sla[0].due_real)} tasks elegíveis`, note:"Só entra no ranking quem teve pelo menos 10 tasks com prazo real.", tone:"green", ranking:rank(rankings.task_sla,"rate","%"), modes:["full","mgmt"] });
  const cs = (rankings.response_speed || []).filter((r:any)=>r.role==="CS");
  const gt = (rankings.response_speed || []).filter((r:any)=>r.role==="GT");
  if (cs.length) all.push({ id:"cs-response", chapter:"CS", kicker:"WHATSAPP · MINUTOS ÚTEIS", title:"Resposta mais rápida entre CS", value:cs[0].person, subtitle:`mediana de ${num(cs[0].median_minutes)} min · ${num(cs[0].replies)} respostas`, note:`P90: ${num(cs[0].p90_minutes)} min. Uma sequência de mensagens do cliente conta como uma única espera.`, tone:"green", ranking:cs.map((r:any)=>({name:r.person,value:`${num(r.median_minutes)} min`,meta:`${num(r.replies)} respostas · P90 ${num(r.p90_minutes)} min`})) });
  if (gt.length) all.push({ id:"gt-response", chapter:"TRÁFEGO", kicker:"WHATSAPP · RESPOSTA DIRETA", title:"Tempo de resposta dos GTs", value:gt[0].person, subtitle:`mediana de ${num(gt[0].median_minutes)} min · ${num(gt[0].replies)} respostas`, note:"Esta métrica mede respostas diretamente atribuídas ao GT. O SLA causal de demandas que dependiam do GT é separado e não é inferido sem evidência de handoff.", tone:"blue", ranking:gt.map((r:any)=>({name:r.person,value:`${num(r.median_minutes)} min`,meta:`${num(r.replies)} respostas · P90 ${num(r.p90_minutes)} min`})) , modes:["full","mgmt"] });  if (n(sources.gt_weekly)>0 || n(sources.gt_analyses)>0) all.push({ id:"weekly", chapter:"TRÁFEGO", kicker:"AS QUINTAS-FEIRAS", title:"Análises semanais viraram dado operacional.", value:num(weekly.analyses), subtitle:`análises de clientes · ${num(weekly.submissions)} entregas consolidadas`, tone:"orange", stats:[
    {label:"Com diagnóstico",value:num(weekly.with_diagnosis)}, {label:"Com hipótese",value:num(weekly.with_hypothesis)}, {label:"Com decisão",value:num(weekly.with_decision)}, {label:"Com próxima validação",value:num(weekly.with_validation)}], modes:["full","mgmt"] });
  if (n(sources.meta)>0) all.push({ id:"meta", chapter:"TRÁFEGO", kicker:"META ADS", title:"Mídia acompanhada no mês", value:brl(meta.spend), subtitle:`${num(meta.leads)} leads · CPL ${meta.cpl==null?"—":brl(meta.cpl)}`, tone:"blue", stats:[
    {label:"Clientes",value:num(meta.clients)}, {label:"Campanhas",value:num(meta.campaigns)}, {label:"Linhas históricas",value:num(sources.meta)}], modes:["full","mgmt"] });
  if (mode === "mgmt") all.push({ id:"sources", chapter:"MGMT", kicker:"RAIO-X DA EVIDÊNCIA", title:"O que sustentou este Wrapped", value:num(Object.values(sources).reduce((a:any,b:any)=>n(a)+n(b),0)), subtitle:"eventos/linhas operacionais disponíveis nas fontes modernas", tone:"dark", stats:Object.entries(sources).filter(([,v])=>n(v)>0).sort((a:any,b:any)=>n(b[1])-n(a[1])).slice(0,6).map(([k,v])=>({label:k.replaceAll("_"," "),value:num(v)})) });
  all.push({ id:"final", chapter:"FECHAMENTO", kicker:"LEONARDO IMOBI", title:`${monthName} ficou registrado.`, value:`${num(tasks.completed)} tasks`, subtitle:`${num(pf.active_clients)} clientes · ${pct(tasks.on_time_rate)} de pontualidade nas tasks elegíveis`, note:p.is_open_month?"Este mês ainda está aberto. O fechamento oficial será congelado após virar o mês.":"Este é o snapshot oficial disponível para este fechamento.", tone:"blue" });
  return all.filter((s) => !s.modes || s.modes.includes(mode));
}
