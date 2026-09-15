"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../shared";
import "../view-oncall/view-oncall.css";
import "./view-oncall-dashboard.css";

type Row = Record<string, any>;
type Payload = { monitor?:Row[]; shifts?:Row[]; config?:Row[]; brokers?:Row[]; template?:string };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-view-oncall-api`;
const TZ = "America/Sao_Paulo";

function when(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit", timeZone:TZ }).format(d);
}

function elapsed(minutes: number) {
  const m = Math.max(0, Math.floor(minutes || 0));
  if (m < 1) return "agora";
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m/60)}h ${m%60}min`;
  return `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h`;
}export function ViewOncallCenter({ token }: { token:string }) {
  const [data,setData]=useState<Payload>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [,tick]=useState(0);

  const load=useCallback(async()=>{
    setLoading(true); setError("");
    try {
      const r=await fetch(API,{headers:{Authorization:`Bearer ${token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"});
      const body=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(body.error||`API ${r.status}`);
      setData(body);
    } catch(e) { setError(e instanceof Error?e.message:"Falha ao carregar plantões."); }
    finally { setLoading(false); }
  },[token]);

  useEffect(()=>{ void load(); const poll=window.setInterval(()=>void load(),60_000); return()=>window.clearInterval(poll); },[load]);
  useEffect(()=>{ const clock=window.setInterval(()=>tick(x=>x+1),30_000); return()=>window.clearInterval(clock); },[]);

  const config=useMemo(()=>Object.fromEntries((data.config||[]).map(x=>[x.config_key,x.config_value])),[data.config]);
  const waiting=useMemo(()=>(data.monitor||[]).filter(x=>x.response_state==="AGUARDANDO_RESPOSTA").sort((a,b)=>Number(b.waiting_minutes||0)-Number(a.waiting_minutes||0)),[data.monitor]);
  const overdue=waiting.filter(x=>Number(x.waiting_minutes||0)>=120);
  const answered=(data.monitor||[]).filter(x=>x.response_state==="RESPONDIDO").length;
  const next=(data.shifts||[]).filter(x=>x.ends_at && new Date(x.ends_at).getTime()>Date.now()).sort((a,b)=>new Date(a.ends_at).getTime()-new Date(b.ends_at).getTime()).slice(0,12);

  return <main className="voc-shell voc-dash">
    <header className="voc-head">
      <div><span>VIEW IMÓVEIS · ACOMPANHAMENTO COMERCIAL</span><h1>Plantões e respostas</h1><p>Escala sincronizada do Colibra. O check-in sai automaticamente após o plantão e esta tela mostra quem respondeu, quem está pendente e há quanto tempo.</p></div>
      <button onClick={()=>void load()} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button>
    </header>    <section className="voc-kpis">
      <article className={config.automation_enabled===true?"ok":"warn"}><small>AUTOMAÇÃO</small><b>{config.automation_enabled===true?"ON":"OFF"}</b><span>{config.automation_enabled===true?"check-ins liberados":"disparos pausados"}</span></article>
      <article className={waiting.length?"warn":"ok"}><small>SEM RESPOSTA</small><b>{waiting.length}</b><span>check-ins aguardando retorno</span></article>
      <article className={overdue.length?"voc-danger":"ok"}><small>+2H SEM RESPOSTA</small><b>{overdue.length}</b><span>já receberam ou aguardam lembrete</span></article>
      <article><small>RESPONDIDOS</small><b>{answered}</b><span>na janela carregada</span></article>
    </section>

    {error&&<div className="voc-message">{error}</div>}

    <section className="voc-card voc-response-panel">
      <div className="voc-card-head"><div><small>DEVOLUTIVA OPERACIONAL</small><h2>Quem ainda não respondeu</h2></div><span>{waiting.length} pendente{waiting.length===1?"":"s"}</span></div>
      {!waiting.length ? <div className="voc-all-good">✅ Nenhum corretor aguardando resposta agora.</div> : <div className="voc-response-list">
        {waiting.map(row=><article key={row.checkin_id} className={`voc-response-item ${Number(row.waiting_minutes||0)>=120?"late":""}`}>
          <div><b>{row.broker_name}</b><small>Plantão {row.shift_date?.split("-").reverse().join("/")} · enviado {when(row.sent_at)}</small></div>
          <div className="voc-wait"><strong>{elapsed(Number(row.waiting_minutes||0))}</strong><small>sem responder</small></div>
          <span className={`voc-pill ${(row.checkin_status||"sent").toLowerCase()}`}>{row.checkin_status==="REMINDER_SENT"?"LEMBRETE ENVIADO":"AGUARDANDO"}</span>
        </article>)}
      </div>}
    </section>

    <section className="voc-card voc-wide voc-next">
      <div className="voc-card-head"><div><small>COLIBRA</small><h2>Próximos plantões</h2></div><span>{next.length} exibidos</span></div>
      <div className="voc-table-wrap"><table><thead><tr><th>Corretor</th><th>Início</th><th>Fim</th><th>Check-in</th></tr></thead><tbody>
        {next.map(row=><tr key={row.shift_id}><td><b>{row.broker_name}</b></td><td>{when(row.starts_at)}</td><td>{when(row.ends_at)}</td><td>{when(row.scheduled_send_at)}</td></tr>)}
        {!next.length&&<tr><td colSpan={4} className="voc-empty">Nenhum próximo plantão carregado.</td></tr>}
      </tbody></table></div>
    </section>
  </main>;
}