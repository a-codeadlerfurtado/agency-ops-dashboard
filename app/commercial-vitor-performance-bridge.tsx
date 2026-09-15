"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_URL, authenticatedFetch } from "./shared";

type Row=Record<string,any>;
const API=`${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const isVitor=(v:unknown)=>["vitor feitoza","luiz vitor feitoza"].includes(norm(v));
const num=(v:unknown)=>Number(v||0).toLocaleString("pt-BR");
const money=(v:unknown)=>Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const pct=(v:number)=>`${v.toLocaleString("pt-BR",{maximumFractionDigits:1})}%`;
const recent=(v:unknown,days:number)=>{const t=new Date(String(v||"")).getTime();return Number.isFinite(t)&&t>=Date.now()-days*86400000;};
const spDay=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

function Analysis({payload}:{payload:Row}){
  const data=useMemo(()=>{
    const leads:Row[]=(payload.leads||[]).filter((r:Row)=>isVitor(r.owner_name));
    const meetings:Row[]=(payload.meetings||[]).filter((r:Row)=>isVitor(r.owner));
    const open=leads.filter(r=>!["fechado","perdido"].includes(norm(r.stage)));
    const cohort30=leads.filter(r=>recent(r.created_at,30));
    const closed30=leads.filter(r=>norm(r.stage)==="fechado"&&recent(r.closed_at,30));
    const meetings30=meetings.filter(r=>recent(r.meeting_started_at,30));
    const advanced=open.filter(r=>["reuniao","proposta","negociacao"].includes(norm(r.stage)));
    const overdue=open.filter(r=>r.followup_overdue);
    const noActivity=open.filter(r=>r.no_activity);
    const forecast=open.reduce((s,r)=>s+Number(r.weighted_value||0),0);
    const ym=spDay().slice(0,7);
    const wonMonth=leads.filter(r=>norm(r.stage)==="fechado"&&String(r.closed_at||"").slice(0,7)===ym);
    const monthly=wonMonth.reduce((s,r)=>s+Number(r.closed_monthly_value||0),0);
    const setup=wonMonth.reduce((s,r)=>s+Number(r.closed_setup_value||0),0);
    const [year,month]=ym.split("-").map(Number);
    const goal=(payload.goals||[]).find((g:Row)=>isVitor(g.owner_name)&&Number(g.ano)===year&&Number(g.mes)===month)||null;
    const conversion=cohort30.length?100*cohort30.filter(r=>norm(r.stage)==="fechado").length/cohort30.length:0;
    const overdueRate=open.length?100*overdue.length/open.length:0;
    const noActivityRate=open.length?100*noActivity.length/open.length:0;
    const afterMeeting=leads.filter(r=>["proposta","negociacao","fechado"].includes(norm(r.stage))).length;
    let diagnosis="O funil do Vitor não apresenta um gargalo dominante com a base atual.";
    if(overdueRate>=15) diagnosis=`O principal sinal está no follow-up: ${pct(overdueRate)} das oportunidades abertas têm ação vencida. Isso pode travar avanço mesmo com geração de reuniões.`;
    else if(noActivityRate>=10) diagnosis=`O ponto de atenção é higiene de CRM: ${pct(noActivityRate)} das oportunidades abertas ainda não têm atividade útil registrada.`;
    else if(meetings30.length>=5&&afterMeeting<Math.max(2,Math.floor(meetings30.length*.25))) diagnosis=`Há volume de reuniões, mas pouca progressão registrada depois delas. Vale revisar qualificação, proposta e registro de avanço no CRM.`;
    else if(advanced.length>0) diagnosis=`O pipeline avançado está ativo, com ${advanced.length} oportunidade(s) entre reunião, proposta e negociação. O foco deve ser conversão e cadência de follow-up.`;
    return {leads,open,cohort30,closed30,meetings30,advanced,overdue,noActivity,forecast,wonMonth,monthly,setup,goal,conversion,diagnosis};
  },[payload]);
  const goal=data.goal||{};
  const progress=(current:number,target:unknown)=>Number(target)>0?Math.min(100,100*current/Number(target)):null;
  const bars=[
    {label:"Clientes fechados no mês",value:data.wonMonth.length,target:goal.meta_clientes,display:`${num(data.wonMonth.length)} / ${num(goal.meta_clientes||0)}`},
    {label:"Mensalidade vendida",value:data.monthly,target:goal.meta_mensalidade,display:`${money(data.monthly)} / ${money(goal.meta_mensalidade||0)}`},
    {label:"Implementação vendida",value:data.setup,target:goal.meta_implementacao,display:`${money(data.setup)} / ${money(goal.meta_implementacao||0)}`},
  ];
  return <section className="cvp-card">
    <style>{styles}</style>
    <div className="cvp-head"><div><span>ANÁLISE DO CLOSER</span><h2>Vitor Feitoza</h2><p>Leitura comercial com CRM + Donnah + metas. Sem usar produtividade operacional, ClickUp ou tarefas da operação.</p></div><div className="cvp-score"><b>{pct(data.conversion)}</b><small>conversão da safra de leads dos últimos 30 dias já marcada como fechada</small></div></div>
    <div className="cvp-kpis">
      <article><small>LEADS · 30D</small><b>{num(data.cohort30.length)}</b><span>novos no CRM</span></article>
      <article><small>REUNIÕES · 30D</small><b>{num(data.meetings30.length)}</b><span>Donnah</span></article>
      <article><small>PIPELINE AVANÇADO</small><b>{num(data.advanced.length)}</b><span>reunião + proposta + negociação</span></article>
      <article><small>FECHADOS · 30D</small><b>{num(data.closed30.length)}</b><span>CRM</span></article>
      <article><small>FORECAST ATUAL</small><b>{money(data.forecast)}</b><span>valor ponderado por estágio</span></article>
      <article className={data.overdue.length?"warn":""}><small>FOLLOW-UPS VENCIDOS</small><b>{num(data.overdue.length)}</b><span>{num(data.open.length)} oportunidades abertas</span></article>
    </div>
    <div className="cvp-bottom"><div className="cvp-goals"><h3>Meta do mês</h3>{goal.meta_clientes||goal.meta_mensalidade||goal.meta_implementacao?bars.map(row=>{const p=progress(row.value,row.target);return <div className="cvp-progress" key={row.label}><div><span>{row.label}</span><b>{row.display}</b></div><i><em style={{width:`${p??0}%`}}/></i><small>{p==null?"meta não cadastrada":`${pct(p)} da meta`}</small></div>}):<p className="cvp-empty">Não existe meta mensal cadastrada para o Vitor neste mês.</p>}</div><div className="cvp-diagnosis"><span>LEITURA DO FUNIL</span><h3>O que os dados estão dizendo</h3><p>{data.diagnosis}</p><footer><b>{num(data.noActivity.length)}</b> sem atividade · <b>{num(data.overdue.length)}</b> follow-ups vencidos · <b>{num(data.advanced.length)}</b> oportunidades avançadas</footer></div></div>
  </section>;
}

export default function CommercialVitorPerformanceBridge(){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  const [payload,setPayload]=useState<Row|null>(null);
  useEffect(()=>{
    if(window.location.pathname!=="/commercial-direction")return;
    let active=true;
    authenticatedFetch(API,{cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(active&&r.ok)setPayload(b);}).catch(()=>{});
    return()=>{active=false};
  },[]);
  useEffect(()=>{
    if(window.location.pathname!=="/commercial-direction")return;
    const find=()=>{
      const grids=[...document.querySelectorAll<HTMLElement>(".cd-grid.two")];
      const grid=grids.find(node=>node.textContent?.includes("TIME COMERCIAL"))||null;
      if(!grid){setTarget(null);return;}
      let host=grid.parentElement?.querySelector<HTMLElement>(":scope > [data-vitor-performance-host]")||null;
      if(!host){host=document.createElement("div");host.dataset.vitorPerformanceHost="true";grid.insertAdjacentElement("afterend",host);}
      setTarget(host);
    };
    find();const obs=new MutationObserver(find);obs.observe(document.body,{childList:true,subtree:true});return()=>{obs.disconnect();document.querySelectorAll("[data-vitor-performance-host]").forEach(n=>n.remove());};
  },[]);
  if(!target||!payload)return null;
  return createPortal(<Analysis payload={payload}/>,target);
}

const styles=`
.cvp-card{width:min(1440px,calc(100% - 44px));margin:0 auto 12px;border:1px solid #244238;border-radius:15px;background:linear-gradient(145deg,#10231c,#0b1613);padding:18px;color:#e9f5ef;font-family:Inter,system-ui,sans-serif}.cvp-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.cvp-head span,.cvp-diagnosis>span{font-size:9px;letter-spacing:.14em;color:#6fb391;font-weight:850}.cvp-head h2{font:800 24px/1.1 'Inter Tight',Inter,sans-serif;margin:4px 0 6px}.cvp-head p{margin:0;color:#789388;font-size:10px}.cvp-score{text-align:right;max-width:260px}.cvp-score b{display:block;color:#8be4b6;font:800 28px/1 'Inter Tight',Inter,sans-serif}.cvp-score small{display:block;color:#6f887e;font-size:9px;line-height:1.4;margin-top:5px}.cvp-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:16px}.cvp-kpis article{border:1px solid #20382f;border-radius:11px;background:#0a1512;padding:11px}.cvp-kpis small{display:block;color:#68857a;font-size:8px;letter-spacing:.08em}.cvp-kpis b{display:block;font:800 18px/1.1 'Inter Tight',Inter,sans-serif;margin:8px 0 4px}.cvp-kpis span{font-size:8px;color:#667f75}.cvp-kpis article.warn b{color:#f3c96f}.cvp-bottom{display:grid;grid-template-columns:1.3fr 1fr;gap:10px;margin-top:10px}.cvp-goals,.cvp-diagnosis{border:1px solid #20382f;border-radius:11px;background:#0a1512;padding:13px}.cvp-goals h3,.cvp-diagnosis h3{font-size:12px;margin:0 0 10px}.cvp-progress{display:grid;grid-template-columns:1fr 120px auto;gap:8px;align-items:center;border-top:1px solid #182b24;padding:9px 0}.cvp-progress:first-of-type{border-top:0}.cvp-progress>div span,.cvp-progress>div b{display:block;font-size:9px}.cvp-progress>div span{color:#728b81}.cvp-progress>div b{margin-top:2px;color:#dcebe4}.cvp-progress i{height:5px;border-radius:999px;background:#162820;overflow:hidden}.cvp-progress em{display:block;height:100%;background:#58ca93;border-radius:999px}.cvp-progress small{font-size:8px;color:#6f897e;white-space:nowrap}.cvp-diagnosis p{font-size:10px;line-height:1.55;color:#9bb0a7;margin:8px 0}.cvp-diagnosis footer{border-top:1px solid #1a2d26;padding-top:9px;color:#6f887e;font-size:8px}.cvp-diagnosis footer b{color:#dbeae3}.cvp-empty{color:#71897f;font-size:10px;margin:0}@media(max-width:1100px){.cvp-kpis{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.cvp-card{width:calc(100% - 24px)}.cvp-head{flex-direction:column}.cvp-score{text-align:left}.cvp-kpis{grid-template-columns:repeat(2,1fr)}.cvp-bottom{grid-template-columns:1fr}.cvp-progress{grid-template-columns:1fr 90px}.cvp-progress small{grid-column:1/-1}}
`;
