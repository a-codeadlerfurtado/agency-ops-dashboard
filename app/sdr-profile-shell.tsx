"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

import { RelatoPairingCard } from "./relato-pairing-card";
import { DailyReflection } from "./daily-reflection";

type Row = Record<string, any>;

type View = "calls" | "meetings" | "notifications";
const API = SUPABASE_URL + "/functions/v1/agency-ops-sdr-api";
const views: Array<[View,string]> = [["calls","Minhas ligações"],["meetings","Minhas reuniões"],["notifications","Notificações"]];
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const text=(v:unknown,fallback="—")=>String(v??"").trim()||fallback;
const dateTime=(v:unknown)=>{
  if(!v)return "—";
  const d=new Date(String(v));
  return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",dateStyle:"short",timeStyle:"short"}).format(d);
};
const duration=(seconds:unknown)=>{
  const n=Math.max(0,Number(seconds||0));
  if(!n)return "—";
  const m=Math.floor(n/60),s=Math.floor(n%60);
  return m?(m+"m "+s+"s"):(s+"s");
};
const phone=(value:unknown)=>{
  const digits=String(value??"").replace(/\D/g,"");
  if(!digits)return "Número não identificado";
  if(digits.length===13&&digits.startsWith("55"))return "+"+digits.slice(0,2)+" ("+digits.slice(2,4)+") "+digits.slice(4,9)+"-"+digits.slice(9);
  if(digits.length===12&&digits.startsWith("55"))return "+"+digits.slice(0,2)+" ("+digits.slice(2,4)+") "+digits.slice(4,8)+"-"+digits.slice(8);
  return "+"+digits;
};
const timestamp=(ms:unknown)=>{
  const total=Math.max(0,Math.floor(Number(ms||0)/1000));
  const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),sec=total%60;
  return h?[h,m,sec].map(v=>String(v).padStart(2,"0")).join(":"):[m,sec].map(v=>String(v).padStart(2,"0")).join(":");
};
const dayKey=(v:unknown)=>{
  const d=v instanceof Date?v:new Date(String(v||""));
  if(Number.isNaN(d.getTime()))return "";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const map=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return map.year+"-"+map.month+"-"+map.day;
};
const pct=(n:number,d:number)=>d?Math.round((n/d)*100):0;
const callOutcomeLabel=(value:unknown)=>{
  const key=String(value||"UNKNOWN").toUpperCase();
  if(key.startsWith("ANSWERED"))return "Atendida";
  if(key==="NO_ANSWER")return "Não atendida";
  return "Atendimento não confirmado";
};
const reviewLabel=(value:unknown)=>{
  const key=String(value||"").toUpperCase();
  const labels:Record<string,string>={
    CLIENT_CALL:"Cliente",COMMERCIAL_PROSPECT:"Prospect",COMMERCIAL_SCHEDULING:"Agendamento comercial",
    COMMERCIAL_PROSPECT_AUDIO_REJECTED:"Prospect · áudio insuficiente",INTERNAL_TEAM_CALL:"Equipe interna",
    NON_COMMERCIAL_CALL:"Não comercial",NO_TRANSCRIPT:"Sem transcrição",UNUSABLE_AUDIO:"Áudio insuficiente",
    REVIEWED_UNRESOLVED:"Identidade não confirmada",TEST_OR_INTERNAL_CALL:"Teste / interno",
    TEST_OR_NOISY_CALL:"Teste / ruído"
  };
  return labels[key]||String(value||"");
};
const unidentifiedLabel=(row:Row)=>{
  const key=String(row.review_classification||"").toUpperCase();
  if(key==="NO_TRANSCRIPT")return "Contato não identificado · sem transcrição";
  if(key==="UNUSABLE_AUDIO")return "Contato não identificado · áudio insuficiente";
  if(key==="REVIEWED_UNRESOLVED")return "Contato não identificado · revisado";
  if(key==="TEST_OR_NOISY_CALL")return "Chamada de teste / ruído";
  if(key==="TEST_OR_INTERNAL_CALL")return "Chamada de teste / interna";
  return "Contato não identificado";
};
const nameSourceLabel=(value:unknown)=>{
  const key=String(value||"").toUpperCase();
  return ({WHATSAPP:"WhatsApp",CRM:"CRM",POST_CALL:"Pós-call do SDR",TRANSCRIPT:"Transcrição",LEGACY:"Histórico"} as Record<string,string>)[key]||"";
};
function Empty({children}:{children:React.ReactNode}) {
  return <div className="sdr-empty">{children}</div>;
}

function SyncedCallPlayer({
  audio,segments,rawTranscript,coachingPoints=[],canCoach=false,sessionId,initialTimestampMs=0
}:{audio:Row[];segments:Row[];rawTranscript?:unknown;coachingPoints?:Row[];canCoach?:boolean;sessionId?:string;initialTimestampMs?:number}) {
  const preferred=useMemo(()=>audio.find(row=>row.role==="mixed"&&row.play_url)||audio.find(row=>row.play_url)||audio[0]||null,[audio]);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const transcriptRef=useRef<HTMLDivElement|null>(null);
  const rowRefs=useRef(new Map<number,HTMLElement>());
  const [playing,setPlaying]=useState(false);
  const [current,setCurrent]=useState(0);
  const [total,setTotal]=useState(0);
  const [rate,setRate]=useState(1);
  const [points,setPoints]=useState<Row[]>(Array.isArray(coachingPoints)?coachingPoints:[]);
  const [composerOpen,setComposerOpen]=useState(false);
  const [note,setNote]=useState("");
  const [kind,setKind]=useState("IMPROVEMENT");
  const [saving,setSaving]=useState(false);
  const [coachingError,setCoachingError]=useState("");

  useEffect(()=>setPoints(Array.isArray(coachingPoints)?coachingPoints:[]),[coachingPoints]);

  const activeIndex=useMemo(()=>{
    if(!segments.length)return -1;
    const ms=current*1000;
    let found=-1;
    for(let i=0;i<segments.length;i++){
      const start=Math.max(0,Number(segments[i]?.started_ms||0));
      const next=i+1<segments.length?Math.max(start,Number(segments[i+1]?.started_ms||0)):Number.POSITIVE_INFINITY;
      const end=Number(segments[i]?.ended_ms||0)>start?Number(segments[i].ended_ms):next;
      if(ms>=start&&ms<end){found=i;break;}
      if(ms>=start)found=i;
    }
    return found;
  },[segments,current]);

  useEffect(()=>{
    const el=audioRef.current;
    if(!el)return;
    el.pause();el.currentTime=0;
    setCurrent(0);setTotal(0);setPlaying(false);setRate(1);setComposerOpen(false);setNote("");setCoachingError("");
  },[preferred?.play_url]);

  useEffect(()=>{
    if(activeIndex<0||!playing)return;
    const row=rowRefs.current.get(activeIndex),list=transcriptRef.current;
    if(!row||!list)return;
    const top=row.offsetTop,bottom=top+row.offsetHeight;
    if(top<list.scrollTop+24||bottom>list.scrollTop+list.clientHeight-24)
      row.scrollIntoView({behavior:"smooth",block:"center"});
  },[activeIndex,playing]);

  const toggle=async()=>{const el=audioRef.current;if(!el)return;if(el.paused){try{await el.play();}catch{}}else el.pause();};
  const seek=(seconds:number,autoplay=false)=>{const el=audioRef.current;if(!el)return;const max=Number.isFinite(el.duration)&&el.duration>0?el.duration:seconds;const next=Math.max(0,Math.min(max,seconds));el.currentTime=next;setCurrent(next);if(autoplay)el.play().catch(()=>{});};
  const clock=(seconds:number)=>{const value=Math.max(0,Math.floor(seconds||0));const h=Math.floor(value/3600),m=Math.floor((value%3600)/60),ss=value%60;return h?[h,m,ss].map(v=>String(v).padStart(2,"0")).join(":"):[m,ss].map(v=>String(v).padStart(2,"0")).join(":");};
  const kindLabel=(value:unknown)=>({IMPROVEMENT:"Melhoria",PRAISE:"Acerto",OBSERVATION:"Observação"} as Record<string,string>)[String(value||"").toUpperCase()]||"Feedback";

  const savePoint=async()=>{
    if(!canCoach||!sessionId||note.trim().length<2||saving)return;
    setSaving(true);setCoachingError("");
    try{
      const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
        action:"coaching_point_create",session_id:sessionId,timestamp_ms:Math.max(0,Math.round(current*1000)),kind,note:note.trim()
      })});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      if(body?.coaching_point)setPoints(prev=>[...prev,body.coaching_point].sort((a,b)=>Number(a.timestamp_ms||0)-Number(b.timestamp_ms||0)));
      setNote("");setKind("IMPROVEMENT");setComposerOpen(false);
    }catch(error){setCoachingError(error instanceof Error?error.message:"Não foi possível salvar o feedback.");}
    finally{setSaving(false);}
  };

  const deletePoint=async(point:Row)=>{
    if(!canCoach||!sessionId||!point?.id||saving)return;
    setSaving(true);setCoachingError("");
    try{
      const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
        action:"coaching_point_delete",session_id:sessionId,coaching_point_id:point.id
      })});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      setPoints(prev=>prev.filter(row=>String(row.id)!==String(point.id)));
    }catch(error){setCoachingError(error instanceof Error?error.message:"Não foi possível remover o feedback.");}
    finally{setSaving(false);}
  };

  if(!preferred)return <p>Nenhuma gravação disponível ainda.</p>;
  const src=String(preferred.play_url||"");
  const downloadUrl=String(preferred.download_url||preferred.play_url||"");
  const isMp3=String(preferred.mime_type||"").includes("mpeg")||String(preferred.path||"").toLowerCase().endsWith(".mp3");

  return <div className="sdr-sync-player">
    <audio key={src} ref={audioRef} preload="metadata" src={src} playsInline
      onLoadedMetadata={e=>{const d=Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:0;setTotal(d);if(initialTimestampMs>0){const next=Math.max(0,Math.min(d||initialTimestampMs/1000,initialTimestampMs/1000));e.currentTarget.currentTime=next;setCurrent(next);}}}
      onDurationChange={e=>setTotal(Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:0)}
      onTimeUpdate={e=>setCurrent(e.currentTarget.currentTime||0)}
      onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)}/>
    <div className="sdr-player-shell">
      <button type="button" className="sdr-play-button" onClick={toggle} aria-label={playing?"Pausar":"Reproduzir"}>{playing?"Ⅱ":"▶"}</button>
      <div className="sdr-player-main">
        <div className="sdr-player-head"><b>{preferred.role==="mixed"?"Gravação completa":preferred.role==="remote"?"Outro lado":"Minha voz"}</b><span>{clock(current)} / {clock(total)}</span></div>
        <div className="sdr-timeline-wrap">
          <input className="sdr-player-range" type="range" min="0" max={Math.max(total,0.01)} step="0.05" value={Math.min(current,Math.max(total,0.01))} onChange={e=>seek(Number(e.target.value))}/>
          {total>0&&points.map((point:Row)=><button key={String(point.id)} type="button" className={"sdr-coaching-marker "+String(point.kind||"IMPROVEMENT").toLowerCase()}
            style={{left:String(Math.max(0,Math.min(100,(Number(point.timestamp_ms||0)/1000)/total*100)))+"%"}}
            title={clock(Number(point.timestamp_ms||0)/1000)+" · "+kindLabel(point.kind)+" · "+text(point.note,"")}
            onClick={()=>seek(Number(point.timestamp_ms||0)/1000,true)} aria-label={"Ir para feedback em "+clock(Number(point.timestamp_ms||0)/1000)}/>)}
        </div>
      </div>
      <select className="sdr-player-rate" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);if(audioRef.current)audioRef.current.playbackRate=value;}} aria-label="Velocidade">
        <option value={0.75}>0,75×</option><option value={1}>1×</option><option value={1.25}>1,25×</option><option value={1.5}>1,5×</option><option value={2}>2×</option>
      </select>
      <a className="sdr-player-download" href={downloadUrl} download={String(preferred.download_name||("relato-ligacao."+(isMp3?"mp3":"wav")))}>{isMp3?"Baixar MP3":"Baixar áudio"}</a>
    </div>

    <div className="sdr-player-reading"><span>LEITURA SINCRONIZADA</span><small>A fala atual acompanha o áudio. Clique em qualquer trecho para ouvir dali.</small></div>

    <section className="sdr-coaching-panel">
      <div className="sdr-coaching-head"><div><span>COACHING NA TIMELINE</span><b>Feedback do gestor</b><small>{points.length?(String(points.length)+" ponto"+(points.length===1?"":"s")+" marcado"+(points.length===1?"":"s")+" nesta call"):"Nenhum feedback marcado ainda"}</small></div>
        {canCoach&&<button type="button" onClick={()=>{setComposerOpen(v=>!v);setCoachingError("");}}>Pontuar este momento · {clock(current)}</button>}
      </div>
      {composerOpen&&canCoach&&<div className="sdr-coaching-composer">
        <div><label><span>Tipo</span><select value={kind} onChange={e=>setKind(e.target.value)}><option value="IMPROVEMENT">Melhoria</option><option value="PRAISE">Acerto</option><option value="OBSERVATION">Observação</option></select></label>
          <div className="sdr-coaching-time"><span>Momento marcado</span><b>{clock(current)}</b></div></div>
        <textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} placeholder="Ex.: aqui você interrompeu o prospect. Deixa ele terminar e depois aprofunda a dor."/>
        <footer><small>{note.length}/2000</small><div><button type="button" className="ghost" onClick={()=>{setComposerOpen(false);setNote("");}}>Cancelar</button><button type="button" onClick={savePoint} disabled={saving||note.trim().length<2}>{saving?"Salvando…":"Salvar feedback"}</button></div></footer>
      </div>}
      {coachingError&&<div className="sdr-coaching-error">{coachingError}</div>}
      {points.length>0&&<div className="sdr-coaching-list">{points.map((point:Row)=><article key={String(point.id)}>
        <button type="button" className="sdr-coaching-time-btn" onClick={()=>seek(Number(point.timestamp_ms||0)/1000,true)}>{clock(Number(point.timestamp_ms||0)/1000)}</button>
        <div><span className={"sdr-coaching-kind "+String(point.kind||"IMPROVEMENT").toLowerCase()}>{kindLabel(point.kind)}</span><p>{text(point.note,"")}</p>
          {point.context_excerpt&&<small className="sdr-coaching-context">Trecho: {text(point.context_excerpt,"")}</small>}
          <small>{text(point.author_person,"Gestor")} · {dateTime(point.created_at)}</small></div>
        {canCoach&&<button type="button" className="sdr-coaching-delete" onClick={()=>deletePoint(point)} disabled={saving}>Excluir</button>}
      </article>)}</div>}
    </section>

    {segments.length>0?<div ref={transcriptRef} className="sdr-transcript-list sdr-transcript-synced">{segments.map((segment:Row,index:number)=>
      <article key={String(segment.sequence_no??index)} ref={node=>{if(node)rowRefs.current.set(index,node);else rowRefs.current.delete(index);}} className={activeIndex===index?"active":""} onClick={()=>seek(Math.max(0,Number(segment.started_ms||0))/1000,true)}>
        <time>{timestamp(segment.started_ms)}</time><div><b>{text(segment.speaker_name,"Participante")}</b><p>{text(segment.text,"")}</p></div>
      </article>)}</div>:<div className="sdr-transcript-raw">{text(rawTranscript,"Transcrição ainda indisponível.")}</div>}
  </div>;
}

export function CallsView({data,managerMode=false,focus,onFocusConsumed}:{data:Row;managerMode?:boolean;focus?:Row|null;onFocusConsumed?:()=>void}) {
  const [query,setQuery]=useState("");
  const [sdrPerson,setSdrPerson]=useState("all");
  const [period,setPeriod]=useState("30d");
  const [dateFrom,setDateFrom]=useState("");
  const [dateTo,setDateTo]=useState("");
  const [status,setStatus]=useState("all");
  const [identity,setIdentity]=useState("all");
  const [transcript,setTranscript]=useState("all");
  const [recording,setRecording]=useState("all");
  const [durationBand,setDurationBand]=useState("all");
  const [channel,setChannel]=useState("all");
  const [detail,setDetail]=useState<Row|null>(null);
  const [detailSeekMs,setDetailSeekMs]=useState(0);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detailError,setDetailError]=useState("");
  const [reviewBusy,setReviewBusy]=useState("");
  const [reviewError,setReviewError]=useState("");
  const [reviewOverrides,setReviewOverrides]=useState<Record<string,boolean>>({});
  const calls:Row[]=data.calls||[];
  const sdrOptions=useMemo(()=>Array.from(new Set(calls.map(row=>String(row.sdr_person||row.owner_person||"").trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"pt-BR")),[calls]);

  const visible=useMemo(()=>calls.filter(row=>{
    const rowSdr=String(row.sdr_person||row.owner_person||"").trim();
    if(managerMode&&sdrPerson!=="all"&&rowSdr!==sdrPerson)return false;
    const q=norm(query);
    if(q&&!norm(String(rowSdr)+" "+String(row.prospect_name||"")+" "+String(row.whatsapp_name||"")+" "+String(row.post_call_name||"")+" "+String(row.crm_name||"")+" "+String(row.auto_identified_name||"")+" "+String(row.remote_name||"")+" "+String(row.remote_phone||"")+" "+String(row.notes||"")+" "+String(row.stage||"")).includes(q))return false;

    const when=Date.parse(String(row.created_at||""));
    if(period==="today"&&dayKey(row.created_at)!==dayKey(new Date()))return false;
    if(period==="7d"&&(!Number.isFinite(when)||when<Date.now()-7*86400000))return false;
    if(period==="30d"&&(!Number.isFinite(when)||when<Date.now()-30*86400000))return false;
    if(period==="custom"){
      const key=dayKey(row.created_at);
      if(dateFrom&&key<dateFrom)return false;
      if(dateTo&&key>dateTo)return false;
    }

    const state=String(row.state||"").toUpperCase();
    if(status==="ready"&&!["READY","CAPTURED"].includes(state))return false;
    if(status==="processing"&&!["PROCESSING","QUEUED","CAPTURING","FINISHING"].includes(state))return false;
    if(status==="problem"&&!["UPLOAD_FAILED","NEEDS_REVIEW","FAILED","ERROR"].some(v=>state.includes(v)))return false;

    const identified=Boolean(row.prospect_identified||row.prospect_name);
    if(identity==="yes"&&!identified)return false;
    if(identity==="no"&&identified)return false;

    const hasTranscript=Boolean(row.has_transcript||row.transcript_id);
    if(transcript==="yes"&&!hasTranscript)return false;
    if(transcript==="no"&&hasTranscript)return false;

    const hasAudio=Boolean(row.has_audio||["READY","STORED","PROCESSING"].includes(String(row.audio_status||"").toUpperCase()));
    if(recording==="yes"&&!hasAudio)return false;
    if(recording==="no"&&hasAudio)return false;

    const sec=Math.max(0,Number(row.duration_seconds||0));
    if(durationBand==="lt1"&&sec>=60)return false;
    if(durationBand==="1to5"&&(sec<60||sec>300))return false;
    if(durationBand==="gt5"&&sec<=300)return false;

    const mode=String(row.capture_mode||row.channel||"").toUpperCase();
    if(channel==="desktop"&&!mode.includes("DESKTOP"))return false;
    if(channel==="web"&&!mode.includes("WEB"))return false;
    return true;
  }),[calls,query,period,dateFrom,dateTo,status,identity,transcript,recording,durationBand,channel,managerMode,sdrPerson]);

  const metrics=useMemo(()=>{
    const answeredRows=visible.filter(r=>r.answered===true||String(r.call_outcome||"").toUpperCase().startsWith("ANSWERED"));
    const attempts=visible.filter(r=>String(r.call_outcome||"").toUpperCase()==="NO_ANSWER").length;
    const secs=answeredRows.map(r=>Math.max(0,Number(r.duration_seconds||0))).filter(n=>n>0);
    const total=secs.reduce((a,b)=>a+b,0);
    const uniqueProspects=new Set(answeredRows.map(r=>String(r.prospect_lead_id||r.prospect_name||r.remote_phone||"")).filter(Boolean)).size;
    const activeDays=new Set(answeredRows.map(r=>dayKey(r.created_at)).filter(Boolean)).size;
    return {
      calls:answeredRows.length,
      attempts,
      avgDuration:secs.length?total/secs.length:0,
      totalDuration:total,
      avgPerDay:activeDays?answeredRows.length/activeDays:0,
      transcriptPct:pct(answeredRows.filter(r=>r.has_transcript||r.transcript_id).length,answeredRows.length),
      recordingPct:pct(answeredRows.filter(r=>r.has_audio||["READY","STORED","PROCESSING"].includes(String(r.audio_status||"").toUpperCase())).length,answeredRows.length),
      identifiedPct:pct(answeredRows.filter(r=>r.prospect_identified||r.prospect_name).length,answeredRows.length),
      uniqueProspects
    };
  },[visible]);

  const clearFilters=()=>{setQuery("");setSdrPerson("all");setPeriod("30d");setDateFrom("");setDateTo("");setStatus("all");setIdentity("all");setTranscript("all");setRecording("all");setDurationBand("all");setChannel("all");};

  const openDetail=async(row:Row,seekMs=0)=>{
    setDetailLoading(true);setDetailError("");setDetailSeekMs(Math.max(0,Number(seekMs||0)));
    try{
      const response=await authenticatedFetch(API+"?session_id="+encodeURIComponent(String(row.session_id||row.id)),{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      setDetail(body.call||row);
    }catch(error){setDetailError(error instanceof Error?error.message:"Não foi possível abrir a ligação.");}
    finally{setDetailLoading(false);}
  };
  const reviewedFor=(row:Row)=>{
    const id=String(row.session_id||row.id||"");
    return Object.prototype.hasOwnProperty.call(reviewOverrides,id)?Boolean(reviewOverrides[id]):Boolean(row.manager_reviewed);
  };
  const toggleReviewed=async(row:Row)=>{
    const id=String(row.session_id||row.id||"");
    if(!id||reviewBusy===id)return;
    const next=!reviewedFor(row);
    setReviewBusy(id);setReviewError("");
    setReviewOverrides(current=>({...current,[id]:next}));
    try{
      const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"call_review_set",session_id:id,reviewed:next})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
    }catch(error){
      setReviewOverrides(current=>({...current,[id]:!next}));
      setReviewError(error instanceof Error?error.message:"Não foi possível salvar o check.");
    }finally{setReviewBusy("");}
  };

  useEffect(()=>{
    const sessionId=String(focus?.session_id||focus?.sessionId||"").trim();
    if(!sessionId)return;
    void openDetail({id:sessionId,session_id:sessionId},Number(focus?.timestamp_ms||focus?.timestampMs||0));
    onFocusConsumed?.();
  },[focus?.session_id,focus?.sessionId,focus?.timestamp_ms,focus?.timestampMs]);

  return <section className="sdr-card">
    <header className="sdr-section-head"><div><span>RELATO AI · SDR</span><h2>{managerMode?"Calls SDR":"Minhas ligações"}</h2>
      <p>{managerMode?"Acompanhe as ligações dos SDRs, marque melhorias no segundo exato e deixe o coaching visível para o SDR.":"Volume, duração, identificação, transcrição, gravação e feedback do gestor nas suas calls."}</p></div><b>{visible.length} exibidas</b></header>

    <div className="sdr-call-kpis">
      <article><span>Ligações atendidas</span><b>{metrics.calls}</b><small>Não inclui tentativas sem atendimento</small></article>
      <article><span>Não atendidas</span><b>{metrics.attempts}</b><small>Tentativas registradas separadamente</small></article>
      <article><span>Duração média</span><b>{duration(metrics.avgDuration)}</b><small>Por ligação com duração</small></article>
      <article><span>Tempo total</span><b>{duration(metrics.totalDuration)}</b><small>Tempo falado</small></article>
      <article><span>Média / dia ativo</span><b>{metrics.avgPerDay.toFixed(1)}</b><small>Ligações por dia com atividade</small></article>
      <article><span>Transcritas</span><b>{metrics.transcriptPct}%</b><small>Com transcrição</small></article>
      <article><span>Gravadas</span><b>{metrics.recordingPct}%</b><small>Com áudio salvo</small></article>
      <article><span>Identificadas</span><b>{metrics.identifiedPct}%</b><small>Com nome/prospect</small></article>
      <article><span>Prospects únicos</span><b>{metrics.uniqueProspects}</b><small>Nome, lead ou telefone único</small></article>
    </div>

    <div className="sdr-filter-panel">
      <div className="sdr-filter-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={managerMode?"Buscar SDR, prospect, telefone, etapa ou anotação":"Buscar prospect, telefone, etapa ou anotação"}/></div>
      {managerMode&&<label><span>SDR</span><select value={sdrPerson} onChange={e=>setSdrPerson(e.target.value)}><option value="all">Todos os SDRs</option>{sdrOptions.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}
      <label><span>Período</span><select value={period} onChange={e=>setPeriod(e.target.value)}>
        <option value="today">Hoje</option><option value="7d">Últimos 7 dias</option><option value="30d">Últimos 30 dias</option><option value="all">Tudo</option><option value="custom">Personalizado</option>
      </select></label>
      {period==="custom"&&<><label><span>De</span><input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label><label><span>Até</span><input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label></>}
      <label><span>Status</span><select value={status} onChange={e=>setStatus(e.target.value)}>
        <option value="all">Todos</option><option value="ready">Concluídas</option><option value="processing">Processando</option><option value="problem">Com problema</option>
      </select></label>
      <label><span>Prospect</span><select value={identity} onChange={e=>setIdentity(e.target.value)}>
        <option value="all">Todos</option><option value="yes">Identificado</option><option value="no">Não identificado</option>
      </select></label>
      <label><span>Transcrição</span><select value={transcript} onChange={e=>setTranscript(e.target.value)}>
        <option value="all">Todas</option><option value="yes">Com transcrição</option><option value="no">Sem transcrição</option>
      </select></label>
      <label><span>Gravação</span><select value={recording} onChange={e=>setRecording(e.target.value)}>
        <option value="all">Todas</option><option value="yes">Com gravação</option><option value="no">Sem gravação</option>
      </select></label>
      <label><span>Duração</span><select value={durationBand} onChange={e=>setDurationBand(e.target.value)}>
        <option value="all">Qualquer</option><option value="lt1">Menos de 1 min</option><option value="1to5">1 a 5 min</option><option value="gt5">Mais de 5 min</option>
      </select></label>
      <label><span>Origem</span><select value={channel} onChange={e=>setChannel(e.target.value)}>
        <option value="all">Todas</option><option value="desktop">WhatsApp Desktop</option><option value="web">WhatsApp Web</option>
      </select></label>
      <button className="sdr-clear-filters" type="button" onClick={clearFilters}>Limpar filtros</button>
    </div>

    <div className="sdr-list">{visible.map(row=><article className="sdr-item" key={row.id}>
      <div className="sdr-item-top"><div><span>{managerMode?text(row.sdr_person||row.owner_person,"SDR"):text(row.channel,"Ligação")}</span><h3>{text(row.prospect_name||row.remote_name,unidentifiedLabel(row))}</h3>{managerMode&&<small className="sdr-call-channel">{text(row.channel,"Ligação")}</small>}</div>
      <time>{dateTime(row.created_at)}</time></div>
      <div className="sdr-call-facts">
        <span><b>Outro número</b>{phone(row.remote_phone)}</span>
        <span><b>Duração</b>{duration(row.duration_seconds)}</span>
        <span><b>Atendimento</b>{callOutcomeLabel(row.call_outcome)}</span>
        <span><b>Processamento</b>{text(row.state)}</span>
        {row.review_classification&&<span><b>Classificação</b>{reviewLabel(row.review_classification)}</span>}
      </div>
      <p>{text(row.transcript_summary||row.notes,"Sem resumo disponível ainda.")}</p>
      <footer><button className="sdr-detail-btn" type="button" onClick={()=>openDetail(row,0)} disabled={detailLoading}>Ver transcrição e gravação</button>
      {managerMode&&<label className={"sdr-review-check "+(reviewedFor(row)?"checked":"")}><input type="checkbox" checked={reviewedFor(row)} disabled={reviewBusy===String(row.session_id||row.id||"")} onChange={()=>void toggleReviewed(row)}/><span>{reviewedFor(row)?"Ouvida / revisada":"Marcar como ouvida"}</span></label>}
      {row.prospect_name_source&&<b>Nome: {nameSourceLabel(row.prospect_name_source)}</b>}
      {row.stage&&<b>Etapa: {text(row.stage)}</b>}
      {row.prospect_lead_id&&<b>Prospect no CRM</b>}{Number(row.coaching_count||0)>0&&<b>Coaching: {Number(row.coaching_count)} ponto{Number(row.coaching_count)===1?"":"s"}</b>}
      {row.review_reason&&<b title={String(row.review_reason)}>Revisado pelo backfill</b>}
      {row.next_step&&<b>Próximo passo: {row.next_step}{row.next_step_at?(" · "+dateTime(row.next_step_at)):""}</b>}</footer>
    </article>)}</div>{!visible.length&&<Empty>Nenhuma ligação encontrada com esses filtros.</Empty>}
    {reviewError&&<div className="sdr-error">{reviewError}</div>}
    {detailError&&<div className="sdr-error">{detailError}</div>}
    {detail&&<div className="sdr-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setDetail(null);}}>
      <section className="sdr-modal" role="dialog" aria-modal="true" aria-label="Detalhes da ligação">
        <header><div><span>RELATO AI · LIGAÇÃO</span><h2>{text(detail.prospect_name||detail.remote_name||detail.contact_name,unidentifiedLabel(detail))}</h2></div><button type="button" onClick={()=>setDetail(null)}>Fechar</button></header>
        <div className="sdr-detail-grid">
          <article><span>Outro número</span><b>{phone(detail.remote_phone)}</b></article>
          <article><span>Duração</span><b>{duration(detail.duration_seconds)}</b></article>
          <article><span>Início</span><b>{dateTime(detail.started_at)}</b></article>
          <article><span>Atendimento</span><b>{callOutcomeLabel(detail.call_outcome)}</b></article>
          <article><span>Processamento</span><b>{text(detail.state)}</b></article>
          {detail.prospect_name_source&&<article><span>Nome exibido</span><b>{text(detail.prospect_name)} · {nameSourceLabel(detail.prospect_name_source)}</b></article>}
          {detail.whatsapp_name&&<article><span>Nome do WhatsApp</span><b>{text(detail.whatsapp_name)}</b></article>}
          {detail.post_call_name&&<article><span>Nome informado no pós-call</span><b>{text(detail.post_call_name)}</b></article>}
          {detail.crm_name&&<article><span>Nome no CRM</span><b>{text(detail.crm_name)}</b></article>}
          {detail.auto_identified_name&&<article><span>Nome inferido da transcrição</span><b>{text(detail.auto_identified_name)}</b></article>}
          {detail.review_classification&&<article><span>Classificação</span><b>{reviewLabel(detail.review_classification)}</b></article>}
        </div>
        {detail.review_reason&&<div className="sdr-note"><b>Revisão do histórico</b><span>{text(detail.review_reason)}</span></div>}
        <div className="sdr-detail-section"><h3>Gravação + transcrição</h3>
          {Array.isArray(detail.audio)&&detail.audio.length>0
            ?<SyncedCallPlayer audio={detail.audio} segments={Array.isArray(detail.segments)?detail.segments:[]} rawTranscript={detail.transcript_text}
              coachingPoints={Array.isArray(detail.coaching_points)?detail.coaching_points:[]} canCoach={managerMode&&Boolean(detail.coaching_can_write)}
              sessionId={String(detail.session_id||detail.id||"")} initialTimestampMs={detailSeekMs}/>
            :<p>{detail.audio_status?("Áudio: "+detail.audio_status):"Nenhuma gravação disponível ainda."}</p>}
        </div>
      </section>
    </div>}
  </section>;
}
function NotificationsView({data,onOpenCall,refresh}:{data:Row;onOpenCall:(item:Row)=>void;refresh:()=>Promise<void>}) {
  const notifications:Row[]=Array.isArray(data.notifications)?data.notifications:[];
  const [filter,setFilter]=useState<"all"|"unread">("all");
  const [busy,setBusy]=useState("");
  const unread=notifications.filter(row=>!row.read_at).length;
  const visible=filter==="unread"?notifications.filter(row=>!row.read_at):notifications;
  const kindLabel=(value:unknown)=>({IMPROVEMENT:"Melhoria",PRAISE:"Acerto",OBSERVATION:"Observação"} as Record<string,string>)[String(value||"").toUpperCase()]||"Feedback";
  const markRead=async(item:Row)=>{
    if(item.read_at)return;
    const id=String(item.id||""); if(!id)return;
    setBusy(id);
    try{
      const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"notification_read",notification_id:id})});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body?.detail||body?.error||("API "+response.status));}
      await refresh();
    }finally{setBusy("");}
  };
  const markAll=async()=>{
    setBusy("all");
    try{
      const response=await authenticatedFetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"notifications_read_all"})});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body?.detail||body?.error||("API "+response.status));}
      await refresh();
    }finally{setBusy("");}
  };
  const open=async(item:Row)=>{
    try{await markRead(item);}catch{}
    onOpenCall(item);
  };
  return <section className="sdr-card sdr-notification-center">
    <header className="sdr-section-head"><div><span>RELATO AI · FEEDBACK</span><h2>Central de notificações</h2>
      <p>Todo ponto marcado pelo Leonardo em uma call aparece aqui e leva você direto ao segundo do feedback.</p></div><b>{unread} não lida{unread===1?"":"s"}</b></header>
    <div className="sdr-notif-toolbar">
      <div><button className={filter==="all"?"active":""} onClick={()=>setFilter("all")}>Todas <b>{notifications.length}</b></button>
      <button className={filter==="unread"?"active":""} onClick={()=>setFilter("unread")}>Não lidas <b>{unread}</b></button></div>
      {unread>0&&<button className="sdr-notif-read-all" disabled={busy==="all"} onClick={()=>void markAll()}>{busy==="all"?"Salvando…":"Marcar todas como lidas"}</button>}
    </div>
    <div className="sdr-notif-list">{visible.map(item=>{
      const meta=item.metadata||{};
      const at=timestamp(meta.timestamp_ms);
      return <article key={String(item.id)} className={item.read_at?"":"unread"}>
        <button className="sdr-notif-open" type="button" onClick={()=>void open(item)} disabled={busy===String(item.id)}>
          <div className="sdr-notif-icon">{String(meta.kind||"").toUpperCase()==="PRAISE"?"✓":String(meta.kind||"").toUpperCase()==="OBSERVATION"?"i":"!"}</div>
          <div className="sdr-notif-copy"><div><span>{kindLabel(meta.kind)} · {at}</span><time>{dateTime(item.occurred_at)}</time></div>
            <h3>{text(item.title,"Novo feedback do Leonardo")}</h3><p>{text(item.description,"O Leonardo pontuou um trecho da sua call.")}</p>
            {meta.context_excerpt&&<small>Trecho: {text(meta.context_excerpt)}</small>}
          </div>
          <strong>Ver na call →</strong>
        </button>
      </article>;
    })}</div>
    {!visible.length&&<Empty>{filter==="unread"?"Você não tem notificações novas.":"Nenhum feedback do Leonardo chegou ainda."}</Empty>}
  </section>;
}

function MeetingsView({data}:{data:Row}) {
  const [query,setQuery]=useState("");
  const meetings:Row[]=data.meetings||[];
  const visible=useMemo(()=>meetings.filter(row=>{
    const q=norm(query);
    return !q||norm(String(row.title||"")+" "+(row.participants||[]).join(" ")+" "+String(row.summary||"")).includes(q);
  }),[meetings,query]);
  return <section className="sdr-card">
    <header className="sdr-section-head"><div><span>RELATO AI · SDR</span><h2>Minhas reuniões</h2>
      <p>Reuniões gravadas e transcritas no seu perfil.</p></div><b>{visible.length}</b></header>
    <div className="sdr-filter"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar reunião ou participante"/></div>
    <div className="sdr-list">{visible.map(row=><article className="sdr-item" key={row.id}>
      <div className="sdr-item-top"><div><span>REUNIÃO</span><h3>{text(row.title)}</h3></div>
      <time>{dateTime(row.started_at)}</time></div>
      <p>{text(row.summary,"Sem resumo disponível ainda.")}</p>
      <footer><span>{duration(row.duration_seconds)}</span><span>{(row.participants||[]).join(" · ")||"Participantes não informados"}</span></footer>
      {Array.isArray(row.commitments)&&row.commitments.length>0&&<div className="sdr-note"><b>Compromissos</b>{row.commitments.slice(0,5).map((x:any,i:number)=><span key={i}>{text(typeof x==="string"?x:x?.text||x?.title)}</span>)}</div>}
    </article>)}</div>{!visible.length&&<Empty>Nenhuma reunião encontrada.</Empty>}
  </section>;
}
export default function SdrProfileShell() {
  const [session,setSession]=useState<Session|null>(null);
  const [role,setRole]=useState("");
  const [person,setPerson]=useState("");
  const [view,setView]=useState<View>("calls");
  const [callFocus,setCallFocus]=useState<Row|null>(null);
  const [data,setData]=useState<Row>({});
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
    return ()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!session?.access_token){setRole("");setPerson("");return;}
    let active=true;
    loadProfileLite().then(body=>{
      if(active){setRole(String(body?.profile?.role||"").toUpperCase());setPerson(String(body?.profile?.person||""));}
    }).catch(()=>{if(active){setRole("");setPerson("");}});
    return ()=>{active=false;};
  },[session?.access_token]);

  const load=useCallback(async()=>{
    if(!session?.access_token||role!=="SDR")return;
    setLoading(true);setError("");
    try{
      const response=await authenticatedFetch(API,{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      setData(body||{});
    }catch(error){
      setError(error instanceof Error?error.message:"Não foi possível carregar seu Relato.");
    }finally{setLoading(false);}
  },[session?.access_token,role]);
  useEffect(()=>{
    if(role!=="SDR")return;
    load();
    const timer=window.setInterval(load,60_000);
    return()=>window.clearInterval(timer);
  },[role,load]);

  const loadNotifications=useCallback(async()=>{
    if(!session?.access_token||role!=="SDR")return;
    try{
      const response=await authenticatedFetch(API+"?notifications_only=1",{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)return;
      setData(prev=>({...prev,notifications:Array.isArray(body.notifications)?body.notifications:[],summary:{...(prev.summary||{}),notifications_unread:Number(body.unread||0)}}));
    }catch{}
  },[session?.access_token,role]);
  useEffect(()=>{
    if(role!=="SDR")return;
    void loadNotifications();
    const timer=window.setInterval(()=>void loadNotifications(),12_000);
    const onFocus=()=>void loadNotifications();
    window.addEventListener("focus",onFocus);
    return()=>{window.clearInterval(timer);window.removeEventListener("focus",onFocus);};
  },[role,loadNotifications]);

  if(role!=="SDR"||!session)return null;
  const displayName=data.profile?.person||person||"SDR";
  const unreadNotifications=Number(data.summary?.notifications_unread||0);
  const openNotificationCall=(item:Row)=>{
    const meta=item.metadata||{};
    const sessionId=String(meta.session_id||"").trim();
    if(!sessionId)return;
    setCallFocus({sessionId,timestampMs:Number(meta.timestamp_ms||0),notificationId:item.id});
    setView("calls");
    window.scrollTo({top:0,behavior:"smooth"});
  };
  return <div className="sdr-root"><style>{sdrSharedStyles}</style>
    <aside className="sdr-sidebar"><div className="sdr-brand"><BrandMark/><div><b>Leonardo Imobi</b><span>Relato AI · SDR</span></div></div>
      <nav>{views.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>setView(key)}><span>{label}</span>{key==="notifications"&&unreadNotifications>0&&<b className="sdr-nav-badge">{unreadNotifications>99?"99+":unreadNotifications}</b>}</button>)}</nav>
      <div className="sdr-profile"><span>Perfil</span><b>{displayName}</b><small>SDR · atividade própria</small></div>
    </aside>
    <main className="sdr-main"><header className="sdr-top"><div><span>ORGANIZAÇÃO COMERCIAL</span><h1>{views.find(([k])=>k===view)?.[1]}</h1>
      <p>{view==="notifications"?"Feedbacks do Leonardo sobre suas calls.":"Você vê somente suas próprias ligações e reuniões."}</p></div>
      <div className="sdr-actions"><span>{loading?"Atualizando…":error?"Falha na atualização":("Atualizado "+dateTime(data.generated_at))}</span>
      <button onClick={load} disabled={loading}>Atualizar</button><button className="ghost" onClick={()=>supabase.auth.signOut({scope:"local"})}>Sair</button></div></header>
      {error&&<div className="sdr-error">{error}</div>}
      <section className="sdr-content">
        <DailyReflection token={session.access_token}/>
        {view!=="notifications"&&<><RelatoPairingCard/>
        <div className="sdr-kpis"><article><span>Ligações</span><b>{Number(data.summary?.calls||0)}</b></article>
        <article><span>Reuniões</span><b>{Number(data.summary?.meetings||0)}</b></article></div></>}
        {view==="calls"
          ?<CallsView data={data} focus={callFocus} onFocusConsumed={()=>setCallFocus(null)}/>
          :view==="meetings"
            ?<MeetingsView data={data}/>
            :<NotificationsView data={data} onOpenCall={openNotificationCall} refresh={loadNotifications}/>}
      </section>
    </main>
  </div>;
}
export const sdrSharedStyles = [
".sdr-root{position:fixed;inset:0;z-index:9000;display:grid;grid-template-columns:220px minmax(0,1fr);background:#071015;color:#eaf2ef;font-family:Inter,system-ui,sans-serif}",
".sdr-sidebar{display:flex;flex-direction:column;border-right:1px solid #203137;background:#091417;padding:18px 12px}.sdr-brand{display:flex;align-items:center;gap:10px;padding:8px 8px 22px}.sdr-brand svg{width:30px;color:#f47b43}.sdr-brand div{display:flex;flex-direction:column}.sdr-brand b{font-size:13px}.sdr-brand span,.sdr-profile span{font-size:8px;color:#78908c;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}",
".sdr-sidebar nav{display:grid;gap:5px}.sdr-sidebar nav button{border:1px solid transparent;background:transparent;color:#8ca39e;text-align:left;border-radius:9px;padding:11px 12px;font:700 11px Inter;cursor:pointer}.sdr-sidebar nav button.active{background:#142b25;border-color:#285043;color:#bdf4d8}.sdr-profile{margin-top:auto;border-top:1px solid #1b2c31;padding:15px 9px 4px;display:flex;flex-direction:column}.sdr-profile b{font-size:11px;margin-top:5px}.sdr-profile small{font-size:9px;color:#708783;margin-top:3px}",
".sdr-main{height:100vh;overflow:auto}.sdr-top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:20px 26px;border-bottom:1px solid #203137;background:rgba(7,16,21,.96)}.sdr-top span,.sdr-section-head span{font-size:9px;color:#62cca0;font-weight:800;letter-spacing:.12em}.sdr-top h1{margin:4px 0;font-size:26px}.sdr-top p,.sdr-section-head p{margin:0;color:#78918c;font-size:11px}",
".sdr-actions{display:flex;gap:8px;align-items:center}.sdr-actions>span{color:#708783;font-size:9px;letter-spacing:0}.sdr-actions button{border:1px solid #2b4941;background:#10231f;color:#d9f5e9;border-radius:9px;padding:9px 11px;font:700 10px Inter;cursor:pointer}.sdr-actions .ghost{background:transparent}",
".sdr-content{padding:22px 26px 60px;max-width:1250px;margin:auto}.sdr-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,220px));gap:9px;margin-bottom:12px}.sdr-kpis article,.sdr-card{border:1px solid #203338;background:#0b171b;border-radius:14px}.sdr-kpis article{padding:14px}.sdr-kpis span{display:block;font-size:8px;color:#738b86;text-transform:uppercase}.sdr-kpis b{display:block;font-size:24px;margin-top:6px}.sdr-card{padding:17px}.sdr-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}.sdr-section-head h2{margin:4px 0;font-size:22px}.sdr-section-head>b{font-size:11px;color:#a8c7be}.sdr-filter{margin:14px 0}.sdr-filter input{width:min(430px,100%);border:1px solid #263a3f;background:#081317;color:#cfe0dc;border-radius:9px;padding:10px;font:600 10px Inter}",
".sdr-list{display:grid;gap:9px}.sdr-item{border:1px solid #1d3135;background:#091519;border-radius:12px;padding:14px}.sdr-item-top{display:flex;justify-content:space-between;gap:12px}.sdr-item-top span{font-size:8px;color:#62cca0;font-weight:800}.sdr-item h3{font-size:13px;margin:4px 0}.sdr-item time{font-size:9px;color:#6f8882}.sdr-item p{font-size:10px;color:#8ca49e;line-height:1.55}.sdr-item footer{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid #182b2e;padding-top:9px}.sdr-item footer>*{font-size:9px;color:#76908a}.sdr-note{display:grid;gap:4px;margin-top:10px;border-top:1px solid #182b2e;padding-top:9px}.sdr-note b{font-size:9px}.sdr-note span{font-size:9px;color:#8ca49e}.sdr-empty{padding:24px;text-align:center;color:#657f79;font-size:10px}.sdr-error{margin:14px 26px 0;border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:10px;padding:10px 12px;font-size:10px}",
".sdr-call-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.sdr-call-kpis article{border:1px solid #203338;background:#091519;border-radius:10px;padding:11px}.sdr-call-kpis span{display:block;font-size:7px;color:#6e8882;text-transform:uppercase;letter-spacing:.08em}.sdr-call-kpis b{display:block;margin-top:5px;font-size:17px}.sdr-call-kpis small{display:block;margin-top:3px;font-size:7px;color:#58716c}.sdr-filter-panel{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:14px 0;padding:12px;border:1px solid #203338;background:#081317;border-radius:11px}.sdr-filter-panel label{display:grid;gap:4px}.sdr-filter-panel label>span{font-size:7px;color:#6f8983;text-transform:uppercase;font-weight:800;letter-spacing:.08em}.sdr-filter-panel input,.sdr-filter-panel select{height:34px;border:1px solid #263a3f;background:#0a171b;color:#cfe0dc;border-radius:8px;padding:0 9px;font:600 9px Inter}.sdr-filter-search{flex:1 1 260px}.sdr-filter-search input{width:100%}.sdr-clear-filters{height:34px;border:1px solid #32494b;background:transparent;color:#8fa7a1;border-radius:8px;padding:0 10px;font:800 8px Inter;cursor:pointer}",
".sdr-call-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0}.sdr-call-facts>span{display:flex;flex-direction:column;gap:3px;padding:8px;border:1px solid #1c3034;border-radius:8px;background:#081216;font-size:9px;color:#9ab0aa}.sdr-call-facts b{font-size:7px;color:#607b75;text-transform:uppercase;letter-spacing:.08em}.sdr-detail-btn{border:1px solid #285043;background:#10231f;color:#bdf4d8;border-radius:8px;padding:7px 9px;font:800 9px Inter;cursor:pointer}.sdr-review-check{display:inline-flex!important;align-items:center;gap:6px;border:1px solid #32494b;background:#0a171b;border-radius:8px;padding:7px 9px;cursor:pointer;font:800 9px Inter;color:#90aaa3}.sdr-review-check input{width:14px;height:14px;accent-color:#62cca0;cursor:pointer}.sdr-review-check.checked{border-color:#3d725f;background:#143326;color:#c9f8df}.sdr-review-check input:disabled{cursor:wait}.sdr-modal-backdrop{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:24px}.sdr-modal{width:min(920px,96vw);max-height:90vh;overflow:auto;border:1px solid #28413f;background:#081216;border-radius:16px;padding:18px;box-shadow:0 30px 100px rgba(0,0,0,.55)}.sdr-modal>header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:1px solid #1d3034;padding-bottom:12px}.sdr-modal>header span{font-size:8px;color:#62cca0;font-weight:900;letter-spacing:.12em}.sdr-modal>header h2{margin:4px 0 0;font-size:21px}.sdr-modal>header button{border:1px solid #33484b;background:#101c20;color:#dbe7e3;border-radius:8px;padding:8px 10px;font:700 9px Inter;cursor:pointer}.sdr-detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.sdr-detail-grid article{border:1px solid #1d3034;background:#0b171b;border-radius:9px;padding:10px}.sdr-detail-grid span{display:block;font-size:7px;color:#637c76;text-transform:uppercase}.sdr-detail-grid b{display:block;margin-top:5px;font-size:10px}.sdr-detail-section{margin-top:14px}.sdr-detail-section h3{font-size:11px;margin:0 0 8px;color:#b9d6ce}.sdr-audio-list{display:grid;gap:8px}.sdr-audio-list article{border:1px solid #1d3034;background:#0b171b;border-radius:10px;padding:10px;display:grid;gap:8px}.sdr-audio-list article>div{display:flex;justify-content:space-between}.sdr-audio-list b{font-size:10px}.sdr-audio-list span{font-size:8px;color:#6f8983}.sdr-audio-list audio{width:100%;height:36px}.sdr-audio-list a{width:max-content;color:#82d8b3;font-size:9px;font-weight:800;text-decoration:none}.sdr-transcript-list{display:grid;gap:6px;max-height:42vh;overflow:auto}.sdr-transcript-list article{display:grid;grid-template-columns:50px minmax(0,1fr);gap:8px;border:1px solid #1a2c30;background:#091519;border-radius:8px;padding:8px}.sdr-transcript-list time{font:800 9px ui-monospace,SFMono-Regular,Menlo,monospace;color:#63cca1}.sdr-transcript-list b{font-size:9px;color:#e0eee9}.sdr-transcript-list p{margin:3px 0 0;font-size:10px;color:#94aaa4}.sdr-transcript-raw{white-space:pre-wrap;border:1px solid #1a2c30;background:#091519;border-radius:8px;padding:10px;font-size:10px;line-height:1.55;color:#94aaa4}",
".sdr-sync-player{display:grid;gap:10px}.sdr-sync-player>audio{display:none}.sdr-player-shell{display:grid;grid-template-columns:42px minmax(0,1fr) auto auto;gap:10px;align-items:center;border:1px solid #28423b;background:linear-gradient(135deg,#0c1b1b,#0b151a);border-radius:13px;padding:12px}.sdr-play-button{width:42px;height:42px;border-radius:50%;border:1px solid #3d725f;background:#17352b;color:#d8ffec;font:900 15px Inter;cursor:pointer}.sdr-player-main{min-width:0}.sdr-player-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.sdr-player-head b{font-size:10px}.sdr-player-head span{font:800 9px ui-monospace,SFMono-Regular,Menlo,monospace;color:#86a99f}.sdr-player-range{width:100%;accent-color:#62cca0;cursor:pointer}.sdr-player-rate{height:34px;border:1px solid #2e4a43;background:#0d1b1b;color:#cfe8df;border-radius:8px;padding:0 7px;font:800 9px Inter}.sdr-player-download{white-space:nowrap;border:1px solid #3b765e;background:#143326;color:#bff8da;border-radius:8px;padding:9px 10px;font:900 9px Inter;text-decoration:none}.sdr-player-reading{display:flex;justify-content:space-between;gap:12px;align-items:center}.sdr-player-reading span{font-size:8px;color:#62cca0;font-weight:900;letter-spacing:.12em}.sdr-player-reading small{font-size:8px;color:#6e8781}.sdr-transcript-synced article{cursor:pointer;transition:border-color .16s,background .16s,transform .16s}.sdr-transcript-synced article:hover{border-color:#2d5146}.sdr-transcript-synced article.active{border-color:#5ed29f;background:#123027;box-shadow:0 0 0 1px rgba(94,210,159,.12);transform:translateX(2px)}.sdr-transcript-synced article.active p{color:#d7eee6}",
".sdr-timeline-wrap{position:relative;padding:7px 0 2px}.sdr-coaching-marker{position:absolute;top:2px;transform:translateX(-50%);width:9px;height:9px;border-radius:50%;border:2px solid #071015;background:#f59e0b;z-index:3;cursor:pointer;padding:0}.sdr-coaching-marker.praise{background:#62cca0}.sdr-coaching-marker.observation{background:#60a5fa}.sdr-coaching-panel{border:1px solid #28413f;background:#0a171b;border-radius:12px;padding:12px;display:grid;gap:10px}.sdr-coaching-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.sdr-coaching-head>div{display:flex;flex-direction:column;gap:2px}.sdr-coaching-head span{font-size:7px;color:#f3b35f;font-weight:900;letter-spacing:.13em}.sdr-coaching-head b{font-size:11px}.sdr-coaching-head small{font-size:8px;color:#6f8983}.sdr-coaching-head>button,.sdr-coaching-composer button{border:1px solid #875c27;background:#342311;color:#ffd99e;border-radius:8px;padding:8px 10px;font:800 9px Inter;cursor:pointer}.sdr-coaching-composer{border:1px solid #3a3225;background:#15130f;border-radius:10px;padding:10px;display:grid;gap:8px}.sdr-coaching-composer>div:first-child{display:flex;gap:10px;align-items:end}.sdr-coaching-composer label{display:grid;gap:4px}.sdr-coaching-composer label span,.sdr-coaching-time span{font-size:7px;color:#8d8171;text-transform:uppercase;letter-spacing:.08em}.sdr-coaching-composer select{height:32px;border:1px solid #4b4234;background:#0d1517;color:#dfe9e5;border-radius:7px;padding:0 8px;font:700 9px Inter}.sdr-coaching-time{display:grid;gap:4px}.sdr-coaching-time b{font:900 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#f6c67d}.sdr-coaching-composer textarea{min-height:84px;resize:vertical;border:1px solid #4b4234;background:#0b1214;color:#e8efec;border-radius:8px;padding:9px;font:600 10px/1.5 Inter}.sdr-coaching-composer footer{display:flex;justify-content:space-between;align-items:center}.sdr-coaching-composer footer small{font-size:8px;color:#766f65}.sdr-coaching-composer footer>div{display:flex;gap:7px}.sdr-coaching-composer button.ghost{background:transparent;border-color:#4a4a43;color:#a8ada9}.sdr-coaching-composer button:disabled{opacity:.45;cursor:not-allowed}.sdr-coaching-error{border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:8px;padding:8px;font-size:9px}.sdr-coaching-list{display:grid;gap:7px}.sdr-coaching-list article{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:start;border:1px solid #24383b;background:#081317;border-radius:9px;padding:9px}.sdr-coaching-time-btn{border:1px solid #875c27;background:#241a0f;color:#ffd291;border-radius:7px;padding:6px 8px;font:900 9px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}.sdr-coaching-list article>div{display:grid;gap:4px}.sdr-coaching-list p{margin:0;color:#d7e4df;font-size:10px;line-height:1.5}.sdr-coaching-list small{font-size:8px;color:#708783}.sdr-coaching-kind{width:max-content;border-radius:999px;padding:3px 6px;background:#3a260d;color:#f7c87d;font-size:7px!important;font-weight:900!important;letter-spacing:.08em}.sdr-coaching-kind.praise{background:#123125;color:#9ce3c1}.sdr-coaching-kind.observation{background:#132a3a;color:#9ed4fb}.sdr-coaching-context{color:#8ea69f!important;font-style:italic}.sdr-coaching-delete{border:0;background:transparent;color:#b9756f;font:800 8px Inter;cursor:pointer;padding:5px}.sdr-coaching-delete:disabled{opacity:.4}",
".sdr-sidebar nav button{display:flex;align-items:center;justify-content:space-between;gap:8px}.sdr-nav-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#f08b45;color:#160b05;font:900 8px Inter}.sdr-notification-center{display:grid;gap:14px}.sdr-notif-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center}.sdr-notif-toolbar>div{display:flex;gap:7px}.sdr-notif-toolbar button{border:1px solid #29413f;background:#0a171b;color:#8ea59f;border-radius:8px;padding:8px 10px;font:800 9px Inter;cursor:pointer}.sdr-notif-toolbar button.active{border-color:#3e8067;background:#123027;color:#c9f6df}.sdr-notif-toolbar button b{margin-left:4px;color:#62cca0}.sdr-notif-read-all{color:#f4c987!important;border-color:#5d4829!important;background:#241b10!important}.sdr-notif-read-all:disabled{opacity:.5}.sdr-notif-list{display:grid;gap:8px}.sdr-notif-list article{border:1px solid #203338;background:#091519;border-radius:11px;overflow:hidden}.sdr-notif-list article.unread{border-color:#4b6f62;box-shadow:inset 3px 0 #62cca0;background:linear-gradient(90deg,rgba(98,204,160,.08),#091519 42%)}.sdr-notif-open{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:13px;cursor:pointer}.sdr-notif-open:disabled{opacity:.6}.sdr-notif-icon{width:34px;height:34px;border-radius:10px;border:1px solid #3b604f;background:#11271f;color:#8de2b7;display:grid;place-items:center;font:900 13px Inter}.sdr-notif-copy{min-width:0}.sdr-notif-copy>div{display:flex;justify-content:space-between;gap:10px;align-items:center}.sdr-notif-copy span{font-size:8px;color:#f0b86c;font-weight:900;text-transform:uppercase;letter-spacing:.08em}.sdr-notif-copy time{font-size:8px;color:#607a74}.sdr-notif-copy h3{margin:5px 0 3px;font-size:11px}.sdr-notif-copy p{margin:0;color:#8fa49f;font-size:9px;line-height:1.5}.sdr-notif-copy small{display:block;margin-top:6px;color:#718a84;font-size:8px;font-style:italic}.sdr-notif-open>strong{white-space:nowrap;color:#8de2b7;font-size:9px}",
"@media(max-width:760px){.sdr-player-shell{grid-template-columns:42px minmax(0,1fr)}.sdr-coaching-head{align-items:flex-start;flex-direction:column}.sdr-coaching-head>button{width:100%}.sdr-coaching-list article{grid-template-columns:auto minmax(0,1fr)}.sdr-coaching-delete{grid-column:2;justify-self:start}.sdr-coaching-composer>div:first-child{align-items:flex-start;flex-direction:column}.sdr-player-reading{align-items:flex-start;flex-direction:column}.sdr-call-kpis{grid-template-columns:1fr 1fr}.sdr-filter-panel{display:grid;grid-template-columns:1fr 1fr}.sdr-filter-search{grid-column:1/-1}.sdr-call-facts,.sdr-detail-grid{grid-template-columns:1fr 1fr}.sdr-modal-backdrop{padding:8px}.sdr-modal{max-height:95vh;padding:12px}.sdr-root{display:block;overflow:auto}.sdr-sidebar{height:auto;position:sticky;top:0;z-index:8}.sdr-brand,.sdr-profile{display:none}.sdr-sidebar nav{display:flex;overflow:auto}.sdr-sidebar nav button{white-space:nowrap}.sdr-notif-toolbar{align-items:stretch;flex-direction:column}.sdr-notif-toolbar>div{display:grid;grid-template-columns:1fr 1fr}.sdr-notif-open{grid-template-columns:34px minmax(0,1fr)}.sdr-notif-open>strong{grid-column:2}.sdr-main{height:auto}.sdr-top{position:relative;align-items:flex-start;flex-direction:column;padding:16px}.sdr-content{padding:14px 12px 70px}.sdr-kpis{grid-template-columns:1fr 1fr}.sdr-actions{flex-wrap:wrap}}"
].join("");
