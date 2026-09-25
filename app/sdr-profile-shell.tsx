"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

import { RelatoPairingCard } from "./relato-pairing-card";

type Row = Record<string, any>;

type View = "calls" | "meetings";
const API = SUPABASE_URL + "/functions/v1/agency-ops-sdr-api";
const views: Array<[View,string]> = [["calls","Minhas ligações"],["meetings","Minhas reuniões"]];
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
function Empty({children}:{children:React.ReactNode}) {
  return <div className="sdr-empty">{children}</div>;
}

function CallAudioPlayer({audio}:{audio:Row}) {
  const ref=useRef<HTMLAudioElement|null>(null);
  const [playing,setPlaying]=useState(false);
  const [error,setError]=useState("");
  const src=String(audio.play_url||"").trim();
  const toggle=async()=>{
    const player=ref.current;
    if(!player||!src)return;
    setError("");
    try{
      if(player.paused){await player.play();}
      else player.pause();
    }catch(err){
      setError(err instanceof Error?err.message:"Não foi possível reproduzir o áudio.");
    }
  };
  return <article>
    <div><b>Gravação completa</b><span>{text(audio.mime_type)}</span></div>
    <audio ref={ref} preload="metadata" src={src} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onError={()=>setError("Falha ao carregar a gravação. Atualize e tente novamente.")}/>
    <div className="sdr-audio-actions">
      <button type="button" onClick={toggle} disabled={!src}>{playing?"Pausar":"Ouvir gravação"}</button>
      {src&&<a href={String(audio.download_url||src)} target="_blank" rel="noreferrer">Abrir áudio</a>}
    </div>
    {error&&<small className="sdr-audio-error">{error}</small>}
  </article>;
}

function CallsView({data}:{data:Row}) {
  const [query,setQuery]=useState("");
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
  const [detailLoading,setDetailLoading]=useState(false);
  const [detailError,setDetailError]=useState("");
  const calls:Row[]=data.calls||[];

  const visible=useMemo(()=>calls.filter(row=>{
    const q=norm(query);
    if(q&&!norm(String(row.prospect_name||"")+" "+String(row.remote_name||"")+" "+String(row.remote_phone||"")+" "+String(row.notes||"")+" "+String(row.stage||"")).includes(q))return false;

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
  }),[calls,query,period,dateFrom,dateTo,status,identity,transcript,recording,durationBand,channel]);

  const metrics=useMemo(()=>{
    const secs=visible.map(r=>Math.max(0,Number(r.duration_seconds||0))).filter(n=>n>0);
    const total=secs.reduce((a,b)=>a+b,0);
    const uniqueProspects=new Set(visible.map(r=>String(r.prospect_lead_id||r.prospect_name||r.remote_phone||"")).filter(Boolean)).size;
    const activeDays=new Set(visible.map(r=>dayKey(r.created_at)).filter(Boolean)).size;
    return {
      calls:visible.length,
      avgDuration:secs.length?total/secs.length:0,
      totalDuration:total,
      avgPerDay:activeDays?visible.length/activeDays:0,
      transcriptPct:pct(visible.filter(r=>r.has_transcript||r.transcript_id).length,visible.length),
      recordingPct:pct(visible.filter(r=>r.has_audio||["READY","STORED","PROCESSING"].includes(String(r.audio_status||"").toUpperCase())).length,visible.length),
      identifiedPct:pct(visible.filter(r=>r.prospect_identified||r.prospect_name).length,visible.length),
      uniqueProspects
    };
  },[visible]);

  const clearFilters=()=>{setQuery("");setPeriod("30d");setDateFrom("");setDateTo("");setStatus("all");setIdentity("all");setTranscript("all");setRecording("all");setDurationBand("all");setChannel("all");};

  const openDetail=async(row:Row)=>{
    setDetailLoading(true);setDetailError("");
    try{
      const response=await authenticatedFetch(API+"?session_id="+encodeURIComponent(String(row.session_id||row.id)),{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      setDetail(body.call||row);
    }catch(error){setDetailError(error instanceof Error?error.message:"Não foi possível abrir a ligação.");}
    finally{setDetailLoading(false);}
  };

  return <section className="sdr-card">
    <header className="sdr-section-head"><div><span>RELATO AI · SDR</span><h2>Minhas ligações</h2>
      <p>Volume, duração, identificação, transcrição e gravação das suas calls.</p></div><b>{visible.length} exibidas</b></header>

    <div className="sdr-call-kpis">
      <article><span>Ligações</span><b>{metrics.calls}</b><small>No filtro atual</small></article>
      <article><span>Duração média</span><b>{duration(metrics.avgDuration)}</b><small>Por ligação com duração</small></article>
      <article><span>Tempo total</span><b>{duration(metrics.totalDuration)}</b><small>Tempo falado</small></article>
      <article><span>Média / dia ativo</span><b>{metrics.avgPerDay.toFixed(1)}</b><small>Ligações por dia com atividade</small></article>
      <article><span>Transcritas</span><b>{metrics.transcriptPct}%</b><small>Com transcrição</small></article>
      <article><span>Gravadas</span><b>{metrics.recordingPct}%</b><small>Com áudio salvo</small></article>
      <article><span>Identificadas</span><b>{metrics.identifiedPct}%</b><small>Com nome/prospect</small></article>
      <article><span>Prospects únicos</span><b>{metrics.uniqueProspects}</b><small>Nome, lead ou telefone único</small></article>
    </div>

    <div className="sdr-filter-panel">
      <div className="sdr-filter-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar prospect, telefone, etapa ou anotação"/></div>
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
      <div className="sdr-item-top"><div><span>{text(row.channel,"Ligação")}</span><h3>{text(row.prospect_name||row.remote_name,"Contato não identificado")}</h3></div>
      <time>{dateTime(row.created_at)}</time></div>
      <div className="sdr-call-facts">
        <span><b>Outro número</b>{phone(row.remote_phone)}</span>
        <span><b>Duração</b>{duration(row.duration_seconds)}</span>
        <span><b>Status</b>{text(row.state)}</span>
      </div>
      <p>{text(row.transcript_summary||row.notes,"Sem resumo disponível ainda.")}</p>
      <footer><button className="sdr-detail-btn" type="button" onClick={()=>openDetail(row)} disabled={detailLoading}>Ver transcrição e gravação</button>
      {row.stage&&<b>Etapa: {text(row.stage)}</b>}
      {row.prospect_lead_id&&<b>Prospect no CRM</b>}
      {row.next_step&&<b>Próximo passo: {row.next_step}{row.next_step_at?(" · "+dateTime(row.next_step_at)):""}</b>}</footer>
    </article>)}</div>{!visible.length&&<Empty>Nenhuma ligação encontrada com esses filtros.</Empty>}
    {detailError&&<div className="sdr-error">{detailError}</div>}
    {detail&&<div className="sdr-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setDetail(null);}}>
      <section className="sdr-modal" role="dialog" aria-modal="true" aria-label="Detalhes da ligação">
        <header><div><span>RELATO AI · LIGAÇÃO</span><h2>{text(detail.prospect_name||detail.remote_name||detail.contact_name,"Contato não identificado")}</h2></div><button type="button" onClick={()=>setDetail(null)}>Fechar</button></header>
        <div className="sdr-detail-grid">
          <article><span>Outro número</span><b>{phone(detail.remote_phone)}</b></article>
          <article><span>Duração</span><b>{duration(detail.duration_seconds)}</b></article>
          <article><span>Início</span><b>{dateTime(detail.started_at)}</b></article>
          <article><span>Status</span><b>{text(detail.state)}</b></article>
        </div>
        <div className="sdr-detail-section"><h3>Gravação</h3>
          {Array.isArray(detail.audio)&&detail.audio.some((audio:Row)=>audio.role==="mixed"&&audio.play_url)
            ?<div className="sdr-audio-list">{detail.audio.filter((audio:Row)=>audio.role==="mixed"&&audio.play_url).map((audio:Row)=><CallAudioPlayer key={String(audio.role)} audio={audio}/>)}</div>
            :<p>{detail.audio_status?("Áudio: "+detail.audio_status+" · arquivo de reprodução indisponível; atualize esta ligação."):"Nenhuma gravação disponível ainda."}</p>}
        </div>
        <div className="sdr-detail-section"><h3>Transcrição</h3>
          {Array.isArray(detail.segments)&&detail.segments.length>0?<div className="sdr-transcript-list">{detail.segments.map((segment:Row,index:number)=><article key={String(segment.sequence_no??index)}>
            <time>{timestamp(segment.started_ms)}</time><div><b>{text(segment.speaker_name,"Participante")}</b><p>{text(segment.text,"")}</p></div>
          </article>)}</div>:<div className="sdr-transcript-raw">{text(detail.transcript_text,"Transcrição ainda indisponível.")}</div>}
        </div>
      </section>
    </div>}
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

  if(role!=="SDR"||!session)return null;
  const displayName=data.profile?.person||person||"SDR";
  return <div className="sdr-root"><style>{styles}</style>
    <aside className="sdr-sidebar"><div className="sdr-brand"><BrandMark/><div><b>Leonardo Imobi</b><span>Relato AI · SDR</span></div></div>
      <nav>{views.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>setView(key)}>{label}</button>)}</nav>
      <div className="sdr-profile"><span>Perfil</span><b>{displayName}</b><small>SDR · atividade própria</small></div>
    </aside>
    <main className="sdr-main"><header className="sdr-top"><div><span>ORGANIZAÇÃO COMERCIAL</span><h1>{views.find(([k])=>k===view)?.[1]}</h1>
      <p>Você vê somente suas próprias ligações e reuniões.</p></div>
      <div className="sdr-actions"><span>{loading?"Atualizando…":error?"Falha na atualização":("Atualizado "+dateTime(data.generated_at))}</span>
      <button onClick={load} disabled={loading}>Atualizar</button><button className="ghost" onClick={()=>supabase.auth.signOut({scope:"local"})}>Sair</button></div></header>
      {error&&<div className="sdr-error">{error}</div>}
      {data.agent?.update_required&&<div className="sdr-update-required">
        <div><b>Atualização obrigatória do Relato Desktop</b>
        <span>Seu agente atual é {text(data.agent?.current_version,"versão antiga")}. Instale {text(data.agent?.required_version,"desktop-0.4.7")} para capturar nome/telefone do prospect corretamente.</span></div>
        <a href={String(data.agent?.release_url||"#")} target="_blank" rel="noreferrer">Baixar atualização</a>
      </div>}
      <section className="sdr-content">
        <RelatoPairingCard/>
        <div className="sdr-kpis"><article><span>Ligações</span><b>{Number(data.summary?.calls||0)}</b></article>
        <article><span>Reuniões</span><b>{Number(data.summary?.meetings||0)}</b></article></div>
        {view==="calls"?<CallsView data={data}/>:<MeetingsView data={data}/>}
      </section>
    </main>
  </div>;
}
const styles = [
".sdr-root{position:fixed;inset:0;z-index:9000;display:grid;grid-template-columns:220px minmax(0,1fr);background:#071015;color:#eaf2ef;font-family:Inter,system-ui,sans-serif}",
".sdr-sidebar{display:flex;flex-direction:column;border-right:1px solid #203137;background:#091417;padding:18px 12px}.sdr-brand{display:flex;align-items:center;gap:10px;padding:8px 8px 22px}.sdr-brand svg{width:30px;color:#f47b43}.sdr-brand div{display:flex;flex-direction:column}.sdr-brand b{font-size:13px}.sdr-brand span,.sdr-profile span{font-size:8px;color:#78908c;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}",
".sdr-sidebar nav{display:grid;gap:5px}.sdr-sidebar nav button{border:1px solid transparent;background:transparent;color:#8ca39e;text-align:left;border-radius:9px;padding:11px 12px;font:700 11px Inter;cursor:pointer}.sdr-sidebar nav button.active{background:#142b25;border-color:#285043;color:#bdf4d8}.sdr-profile{margin-top:auto;border-top:1px solid #1b2c31;padding:15px 9px 4px;display:flex;flex-direction:column}.sdr-profile b{font-size:11px;margin-top:5px}.sdr-profile small{font-size:9px;color:#708783;margin-top:3px}",
".sdr-main{height:100vh;overflow:auto}.sdr-top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:20px 26px;border-bottom:1px solid #203137;background:rgba(7,16,21,.96)}.sdr-top span,.sdr-section-head span{font-size:9px;color:#62cca0;font-weight:800;letter-spacing:.12em}.sdr-top h1{margin:4px 0;font-size:26px}.sdr-top p,.sdr-section-head p{margin:0;color:#78918c;font-size:11px}.sdr-update-required{margin:14px 26px 0;display:flex;justify-content:space-between;gap:16px;align-items:center;border:1px solid #8b5c24;background:#2b1b0d;color:#ffd9a4;border-radius:12px;padding:12px 14px}.sdr-update-required div{display:grid;gap:3px}.sdr-update-required b{font-size:10px}.sdr-update-required span{font-size:9px;color:#d8b988}.sdr-update-required a{white-space:nowrap;border:1px solid #bd7b2d;background:#5a3512;color:#fff0d4;border-radius:8px;padding:9px 11px;font:800 9px Inter;text-decoration:none}",
".sdr-actions{display:flex;gap:8px;align-items:center}.sdr-actions>span{color:#708783;font-size:9px;letter-spacing:0}.sdr-actions button{border:1px solid #2b4941;background:#10231f;color:#d9f5e9;border-radius:9px;padding:9px 11px;font:700 10px Inter;cursor:pointer}.sdr-actions .ghost{background:transparent}",
".sdr-content{padding:22px 26px 60px;max-width:1250px;margin:auto}.sdr-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,220px));gap:9px;margin-bottom:12px}.sdr-kpis article,.sdr-card{border:1px solid #203338;background:#0b171b;border-radius:14px}.sdr-kpis article{padding:14px}.sdr-kpis span{display:block;font-size:8px;color:#738b86;text-transform:uppercase}.sdr-kpis b{display:block;font-size:24px;margin-top:6px}.sdr-card{padding:17px}.sdr-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}.sdr-section-head h2{margin:4px 0;font-size:22px}.sdr-section-head>b{font-size:11px;color:#a8c7be}.sdr-filter{margin:14px 0}.sdr-filter input{width:min(430px,100%);border:1px solid #263a3f;background:#081317;color:#cfe0dc;border-radius:9px;padding:10px;font:600 10px Inter}",
".sdr-list{display:grid;gap:9px}.sdr-item{border:1px solid #1d3135;background:#091519;border-radius:12px;padding:14px}.sdr-item-top{display:flex;justify-content:space-between;gap:12px}.sdr-item-top span{font-size:8px;color:#62cca0;font-weight:800}.sdr-item h3{font-size:13px;margin:4px 0}.sdr-item time{font-size:9px;color:#6f8882}.sdr-item p{font-size:10px;color:#8ca49e;line-height:1.55}.sdr-item footer{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid #182b2e;padding-top:9px}.sdr-item footer>*{font-size:9px;color:#76908a}.sdr-note{display:grid;gap:4px;margin-top:10px;border-top:1px solid #182b2e;padding-top:9px}.sdr-note b{font-size:9px}.sdr-note span{font-size:9px;color:#8ca49e}.sdr-empty{padding:24px;text-align:center;color:#657f79;font-size:10px}.sdr-error{margin:14px 26px 0;border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:10px;padding:10px 12px;font-size:10px}",
".sdr-call-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.sdr-call-kpis article{border:1px solid #203338;background:#091519;border-radius:10px;padding:11px}.sdr-call-kpis span{display:block;font-size:7px;color:#6e8882;text-transform:uppercase;letter-spacing:.08em}.sdr-call-kpis b{display:block;margin-top:5px;font-size:17px}.sdr-call-kpis small{display:block;margin-top:3px;font-size:7px;color:#58716c}.sdr-filter-panel{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:14px 0;padding:12px;border:1px solid #203338;background:#081317;border-radius:11px}.sdr-filter-panel label{display:grid;gap:4px}.sdr-filter-panel label>span{font-size:7px;color:#6f8983;text-transform:uppercase;font-weight:800;letter-spacing:.08em}.sdr-filter-panel input,.sdr-filter-panel select{height:34px;border:1px solid #263a3f;background:#0a171b;color:#cfe0dc;border-radius:8px;padding:0 9px;font:600 9px Inter}.sdr-filter-search{flex:1 1 260px}.sdr-filter-search input{width:100%}.sdr-clear-filters{height:34px;border:1px solid #32494b;background:transparent;color:#8fa7a1;border-radius:8px;padding:0 10px;font:800 8px Inter;cursor:pointer}",
".sdr-call-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0}.sdr-call-facts>span{display:flex;flex-direction:column;gap:3px;padding:8px;border:1px solid #1c3034;border-radius:8px;background:#081216;font-size:9px;color:#9ab0aa}.sdr-call-facts b{font-size:7px;color:#607b75;text-transform:uppercase;letter-spacing:.08em}.sdr-detail-btn{border:1px solid #285043;background:#10231f;color:#bdf4d8;border-radius:8px;padding:7px 9px;font:800 9px Inter;cursor:pointer}.sdr-modal-backdrop{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:24px}.sdr-modal{width:min(920px,96vw);max-height:90vh;overflow:auto;border:1px solid #28413f;background:#081216;border-radius:16px;padding:18px;box-shadow:0 30px 100px rgba(0,0,0,.55)}.sdr-modal>header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:1px solid #1d3034;padding-bottom:12px}.sdr-modal>header span{font-size:8px;color:#62cca0;font-weight:900;letter-spacing:.12em}.sdr-modal>header h2{margin:4px 0 0;font-size:21px}.sdr-modal>header button{border:1px solid #33484b;background:#101c20;color:#dbe7e3;border-radius:8px;padding:8px 10px;font:700 9px Inter;cursor:pointer}.sdr-detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.sdr-detail-grid article{border:1px solid #1d3034;background:#0b171b;border-radius:9px;padding:10px}.sdr-detail-grid span{display:block;font-size:7px;color:#637c76;text-transform:uppercase}.sdr-detail-grid b{display:block;margin-top:5px;font-size:10px}.sdr-detail-section{margin-top:14px}.sdr-detail-section h3{font-size:11px;margin:0 0 8px;color:#b9d6ce}.sdr-audio-list{display:grid;gap:8px}.sdr-audio-list article{border:1px solid #1d3034;background:#0b171b;border-radius:10px;padding:10px;display:grid;gap:8px}.sdr-audio-list article>div{display:flex;justify-content:space-between}.sdr-audio-list b{font-size:10px}.sdr-audio-list span{font-size:8px;color:#6f8983}.sdr-audio-list audio{display:none}.sdr-audio-actions{display:flex!important;justify-content:flex-start!important;gap:8px;align-items:center}.sdr-audio-actions button{border:1px solid #2d6b57;background:#123328;color:#c8f6e4;border-radius:8px;padding:8px 11px;font:800 9px Inter;cursor:pointer}.sdr-audio-actions button:disabled{opacity:.45;cursor:not-allowed}.sdr-audio-list a{width:max-content;color:#82d8b3;font-size:9px;font-weight:800;text-decoration:none}.sdr-audio-error{color:#ff9a9a;font-size:8px}.sdr-transcript-list{display:grid;gap:6px;max-height:42vh;overflow:auto}.sdr-transcript-list article{display:grid;grid-template-columns:50px minmax(0,1fr);gap:8px;border:1px solid #1a2c30;background:#091519;border-radius:8px;padding:8px}.sdr-transcript-list time{font:800 9px ui-monospace,SFMono-Regular,Menlo,monospace;color:#63cca1}.sdr-transcript-list b{font-size:9px;color:#e0eee9}.sdr-transcript-list p{margin:3px 0 0;font-size:10px;color:#94aaa4}.sdr-transcript-raw{white-space:pre-wrap;border:1px solid #1a2c30;background:#091519;border-radius:8px;padding:10px;font-size:10px;line-height:1.55;color:#94aaa4}",
"@media(max-width:760px){.sdr-call-kpis{grid-template-columns:1fr 1fr}.sdr-filter-panel{display:grid;grid-template-columns:1fr 1fr}.sdr-filter-search{grid-column:1/-1}.sdr-call-facts,.sdr-detail-grid{grid-template-columns:1fr 1fr}.sdr-modal-backdrop{padding:8px}.sdr-modal{max-height:95vh;padding:12px}.sdr-root{display:block;overflow:auto}.sdr-sidebar{height:auto;position:sticky;top:0;z-index:8}.sdr-brand,.sdr-profile{display:none}.sdr-sidebar nav{display:flex}.sdr-sidebar nav button{white-space:nowrap}.sdr-main{height:auto}.sdr-top{position:relative;align-items:flex-start;flex-direction:column;padding:16px}.sdr-content{padding:14px 12px 70px}.sdr-kpis{grid-template-columns:1fr 1fr}.sdr-actions{flex-wrap:wrap}}"
].join("");
