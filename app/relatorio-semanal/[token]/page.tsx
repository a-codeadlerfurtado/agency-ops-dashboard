"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../report.css";

type Row=Record<string,any>;
const API="https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-weekly-report-public-api";
const money=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n.toLocaleString("pt-BR",{style:"currency",currency:"BRL"}):"—";};
const number=(v:unknown,d=0)=>{const n=Number(v);return Number.isFinite(n)?n.toLocaleString("pt-BR",{maximumFractionDigits:d}):"—";};
const delta=(v:unknown,inverse=false)=>{const n=Number(v);if(!Number.isFinite(n))return {text:"sem comparação",cls:"muted"};const good=inverse?n<0:n>0;const bad=inverse?n>0:n<0;return{text:`${n>0?"↑":n<0?"↓":"="} ${Math.abs(n).toFixed(0)}% vs. semana anterior`,cls:good?"good":bad?"bad":"muted"};};
const date=(v:unknown)=>v?new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"long"}).format(new Date(`${String(v)}T12:00:00`)):"—";

export default function WeeklyReportPublicPage(){
  const params=useParams<{token:string}>();
  const[body,setBody]=useState<Row|null>(null),[error,setError]=useState("");
  useEffect(()=>{const token=String(params?.token||"");if(!token)return;let alive=true;fetch(`${API}?token=${encodeURIComponent(token)}`,{cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(!alive)return;if(!r.ok)throw new Error("Relatório indisponível.");setBody(b);}).catch(e=>alive&&setError(e instanceof Error?e.message:"Relatório indisponível."));return()=>{alive=false;};},[params?.token]);
  if(error)return <main className="public-report-state"><h1>Relatório indisponível</h1><p>O link pode ter expirado ou ainda não está liberado para compartilhamento.</p></main>;
  if(!body)return <main className="public-report-state"><div className="public-loader"/><p>Carregando relatório semanal…</p></main>;
  const r=body.report||{},current=r.current||{},trends=r.trends||{},campaigns:Row[]=r.campaigns||[],creatives:Row[]=r.creatives||[],narrative=r.narrative||{};
  const resultTrend=delta(trends.results?.delta),cprTrend=delta(trends.cpr?.delta,true),spendTrend=delta(trends.spend?.delta,true),ctrTrend=delta(trends.ctr?.delta);
  return <main className="public-report-page">
    <header className="pr-top"><div><span>Relatório semanal de performance</span><h1>{body.client_name}</h1><p>Meta Ads · leitura executiva da semana</p></div><div className="pr-period"><b>{date(body.week_start)} → {date(body.week_end)}</b><small>Snapshot semanal fechado</small></div></header>

    <section className="pr-hero"><div><span>Resumo da semana</span><h2>{narrative.headline||"Leitura consolidada da semana"}</h2><p>{narrative.body}</p></div><aside><small>Principal leitura</small><b>{narrative.key_insight}</b></aside></section>

    <section className="pr-kpis">
      <article><small>Investimento</small><b>{money(current.spend)}</b><em className={spendTrend.cls}>{spendTrend.text}</em></article>
      <article><small>Resultados</small><b>{number(current.results)}</b><em className={resultTrend.cls}>{resultTrend.text}</em></article>
      <article><small>Custo por resultado</small><b>{money(current.cpr)}</b><em className={cprTrend.cls}>{cprTrend.text}</em></article>
      <article><small>CTR</small><b>{current.ctr==null?"—":`${number(current.ctr,2)}%`}</b><em className={ctrTrend.cls}>{ctrTrend.text}</em></article>
    </section>

    <section className="pr-section"><div className="pr-heading"><div><span>Campanhas</span><h3>Onde o resultado aconteceu</h3></div><small>comparação com a semana anterior</small></div><div className="pr-card pr-campaigns">{campaigns.slice(0,6).map(c=>{const dc=delta(c.previous?.cpr==null?null:((Number(c.cpr)-Number(c.previous.cpr))/Math.abs(Number(c.previous.cpr)))*100,true);return <article key={c.campaign_id}><div><h4>{c.campaign_name}</h4><small>{String(c.campaign_status||"").toUpperCase()==="ACTIVE"?"Ativa":"Status: "+String(c.campaign_status||"—")}</small></div><dl><div><dt>Investimento</dt><dd>{money(c.spend)}</dd></div><div><dt>Resultados</dt><dd>{number(c.results)}</dd></div><div><dt>CPR</dt><dd>{money(c.cpr)}</dd><em className={dc.cls}>{dc.text}</em></div><div><dt>CTR</dt><dd>{c.ctr==null?"—":`${number(c.ctr,2)}%`}</dd></div></dl></article>;})}</div></section>

    <section className="pr-section"><div className="pr-heading"><div><span>Criativos</span><h3>Peças em destaque na semana</h3></div><small>{creatives.length} selecionado{creatives.length===1?"":"s"}</small></div><div className="pr-creatives">{creatives.map(c=><article className="pr-card" key={c.ad_id}><div className="pr-image">{c.image_url?<img src={c.image_url} alt=""/>:<span>Prévia indisponível</span>}<em className={c.tone||"info"}>{c.badge||"Em destaque"}</em></div><div className="pr-creative-copy"><h4>{c.ad_name||"Criativo"}</h4><small>{c.campaign_name}</small><dl><div><dt>Resultados</dt><dd>{number(c.results)}</dd></div><div><dt>CPR</dt><dd>{money(c.cpr)}</dd></div><div><dt>CTR</dt><dd>{c.ctr==null?"—":`${number(c.ctr,2)}%`}</dd></div></dl></div></article>)}</div></section>

    <section className="pr-section pr-actions"><article className="pr-card"><span>O que os dados estão dizendo</span><h3>{narrative.key_insight}</h3><p>Frequência da conta no período: <b>{number(current.frequency,2)}</b>. A leitura considera o conjunto de resultados, custo por resultado, CTR, campanhas e criativos do recorte.</p></article><article className="pr-card"><span>Próximos passos</span><h3>Plano para o próximo ciclo</h3><ol>{(narrative.next_steps||[]).map((x:string,i:number)=><li key={i}>{x}</li>)}</ol></article></section>

    <footer><p>{r.disclaimer}</p><small>Relatório gerado automaticamente a partir do snapshot semanal da conta.</small></footer>
  </main>;
}
