"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { buildMonthlyStories, duration, type MonthlyStory } from "../monthly-story";
import "../monthly-report.css";

type Row=Record<string,any>;
const API="https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-monthly-report-public-api";
const SPEEDS=[0.75,1,1.25,1.5];
const money=(v:unknown)=>Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const number=(v:unknown,d=0)=>Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:d});
const shortDate=(v:unknown)=>v?new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",timeZone:"UTC"}).format(new Date(`${String(v)}T12:00:00Z`)):"—";

export default function MonthlyPublicPage(){
  const params=useParams<{token:string}>();const[body,setBody]=useState<Row|null>(null),[error,setError]=useState("");
  const[index,setIndex]=useState(0),[paused,setPaused]=useState(false),[progress,setProgress]=useState(0),[speed,setSpeed]=useState(1),[controls,setControls]=useState(true);
  const hideTimer=useRef<number|null>(null);
  useEffect(()=>{const token=String(params?.token||"");if(!token)return;let alive=true;fetch(`${API}?token=${encodeURIComponent(token)}`,{cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(!alive)return;if(!r.ok||!b.ok)throw new Error("Relatório mensal indisponível.");setBody(b);}).catch(e=>alive&&setError(e instanceof Error?e.message:"Relatório mensal indisponível."));return()=>{alive=false;};},[params?.token]);
  const stories=useMemo(()=>body?buildMonthlyStories(body):[],[body]),story=stories[index]||null;
  const go=useCallback((next:number)=>{setProgress(0);setIndex(Math.max(0,Math.min(next,Math.max(0,stories.length-1))));},[stories.length]);
  const next=useCallback(()=>{if(index>=stories.length-1){setPaused(true);setProgress(1);return;}go(index+1);},[go,index,stories.length]);
  const previous=useCallback(()=>go(index-1),[go,index]);
  useEffect(()=>{if(!story||paused)return;const total=duration(story)/speed;const timer=window.setInterval(()=>setProgress(current=>{const updated=current+50/total;if(updated>=1){window.clearInterval(timer);window.setTimeout(next,0);return 1;}return updated;}),50);return()=>window.clearInterval(timer);},[story?.id,paused,speed,next]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.code==="Space"){e.preventDefault();setPaused(v=>!v);}else if(["ArrowRight","ArrowDown"].includes(e.key)){e.preventDefault();next();}else if(["ArrowLeft","ArrowUp"].includes(e.key)){e.preventDefault();previous();}else if(e.key==="Escape"&&document.fullscreenElement)void document.exitFullscreen();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[next,previous]);
  useEffect(()=>{const reveal=()=>{setControls(true);if(hideTimer.current)window.clearTimeout(hideTimer.current);if(!paused)hideTimer.current=window.setTimeout(()=>setControls(false),2600);};window.addEventListener("mousemove",reveal);window.addEventListener("touchstart",reveal,{passive:true});reveal();return()=>{window.removeEventListener("mousemove",reveal);window.removeEventListener("touchstart",reveal);if(hideTimer.current)window.clearTimeout(hideTimer.current);};},[paused]);
  const cycleSpeed=()=>setSpeed(SPEEDS[(SPEEDS.indexOf(speed)+1)%SPEEDS.length]);
  const fullscreen=()=>document.fullscreenElement?void document.exitFullscreen():void document.documentElement.requestFullscreen?.();
  if(error)return <main className="mpr-state"><h1>Relatório indisponível</h1><p>{error}</p></main>;
  if(!body||!story)return <main className="mpr-state"><span className="mpr-spinner"/><p>Montando apresentação mensal…</p></main>;
  const tone=story.tone||"blue",seconds=Math.max(1,Math.ceil(duration(story)*(1-progress)/speed/1000));
  return <main className={`mpr-shell tone-${tone}${paused?" is-paused":""}`}>
    <div className="mpr-bg" aria-hidden="true"><i/><i/><i/><i/></div>
    <div className="mpr-progress">{stories.map((item,pos)=><span key={item.id} className={pos<index?"done":pos===index?"current":""}><i style={{transform:`scaleX(${pos<index?1:pos===index?progress:0})`}}/></span>)}</div>
    <header className={`mpr-top ${controls||paused?"show":""}`}><div><b>LEONARDO IMOBI</b><span>{body.client_name}</span></div><div><span>{String(index+1).padStart(2,"0")} / {String(stories.length).padStart(2,"0")}</span><button onClick={fullscreen}>⛶</button></div></header>
    <section className="mpr-stage" key={story.id}>
      <div className="mpr-story"><div className="mpr-kicker">{story.kicker}</div><h1>{story.title}</h1>{story.value&&<div className="mpr-value">{story.value}</div>}{story.subtitle&&<p className="mpr-subtitle">{story.subtitle}</p>}
        {story.stats?.length?<div className="mpr-stats">{story.stats.map((s,i)=><article key={`${s.label}-${i}`}><small>{s.label}</small><b>{s.value}</b>{s.delta&&<em className={s.cls||""}>{s.delta}</em>}</article>)}</div>:null}
        {story.weeks?.length?<div className="mpr-weeks">{story.weeks.map((w:any)=><article key={w.index}><small>SEMANA {w.index}</small><b>{number(w.results)} resultados</b><span>{money(w.spend)} investidos</span><dl><div><dt>CPR</dt><dd>{w.cpr==null?"—":money(w.cpr)}</dd></div><div><dt>CTR</dt><dd>{w.ctr==null?"—":`${number(w.ctr,2)}%`}</dd></div></dl><em>{shortDate(w.period_start)} → {shortDate(w.period_end)}</em></article>)}</div>:null}
        {story.campaigns?.length?<div className="mpr-campaigns">{story.campaigns.slice(0,5).map((c:any,i:number)=><article key={`${c.campaign_id||c.campaign_name}-${i}`}><em>{String(i+1).padStart(2,"0")}</em><span><b>{c.campaign_name}</b><small>{money(c.spend)} investidos</small></span><strong>{number(c.results)}<small>resultados</small></strong><strong>{c.cpr==null?"—":money(c.cpr)}<small>CPR</small></strong></article>)}</div>:null}
        {story.creatives?.length?<div className="mpr-creatives">{story.creatives.slice(0,6).map((c:any,i:number)=><article key={`${c.ad_id||i}`}><div>{c.image_url?<img src={c.image_url} alt={c.ad_name||"Criativo"}/>:<span>Prévia indisponível</span>}<em>{c.badge||"Destaque"}</em></div><footer><b>{c.ad_name||"Criativo"}</b><small>{c.campaign_name||""}</small><dl><div><dt>Resultados</dt><dd>{number(c.results)}</dd></div><div><dt>CPR</dt><dd>{c.cpr==null?"—":money(c.cpr)}</dd></div></dl></footer></article>)}</div>:null}
        {story.steps?.length?<ol className="mpr-steps">{story.steps.map((s,i)=><li key={i}><em>{String(i+1).padStart(2,"0")}</em><span>{s}</span></li>)}</ol>:null}
        {story.note&&<p className="mpr-note">{story.note}</p>}
      </div>
    </section>
    <footer className={`mpr-controls ${controls||paused?"show":""}`}><button onClick={previous} disabled={index===0}>←</button><button className="play" onClick={()=>setPaused(v=>!v)}>{paused?"▶":"Ⅱ"}</button><button onClick={next} disabled={index===stories.length-1}>→</button><button className="speed" onClick={cycleSpeed}>{speed}×</button><span>{paused?"Pausado":`${seconds}s`}</span><span className={`coverage ${String(body.audit_status||"").toLowerCase()}`}>{body.audit_status==="PASS"?"4 SEMANAS AUDITADAS":"COBERTURA PARCIAL"}</span></footer>
    <button className="mpr-hit prev" onClick={previous}/><button className="mpr-hit next" onClick={next}/>
  </main>;
}
