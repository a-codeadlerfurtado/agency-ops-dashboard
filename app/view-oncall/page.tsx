"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";
import "./view-oncall.css";

type Broker = { id:string; name:string; display_name?:string|null; phone_e164?:string|null; oncall_eligible?:boolean|null };
type Shift = { shift_id:string; shift_date:string; broker_name:string; starts_at?:string|null; ends_at?:string|null; checkin_status?:string|null; scheduled_send_at?:string|null; sent_at?:string|null; responded_at?:string|null; leads_received?:number|null; visits_scheduled?:number|null; proposals?:number|null; sales?:number|null; source_type?:string|null };
type Config = { config_key:string; config_value:unknown };
type Payload = { brokers:Broker[]; shifts:Shift[]; config:Config[]; template:string };

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-view-oncall-api`;

function fmt(value?:string|null){
  if(!value)return "—";
  const d=new Date(value); if(Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short",timeZone:"America/Sao_Paulo"}).format(d);
}

export default function ViewOncallPage(){
  const [session,setSession]=useState<Session|null>(null);
  const [ready,setReady]=useState(false);
  const [data,setData]=useState<Payload|null>(null);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");
  const [brokerName,setBrokerName]=useState("");
  const [date,setDate]=useState(()=>new Date().toISOString().slice(0,10));
  const [start,setStart]=useState("");
  const [end,setEnd]=useState("");
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);if(!data.session)window.location.replace("/");});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>{setSession(next);if(!next)window.location.replace("/");});
    return()=>subscription.unsubscribe();
  },[]);

  const load=useCallback(async()=>{
    if(!session?.access_token)return;
    setLoading(true); setMessage("");
    try{
      const r=await fetch(API_URL,{headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"});
      const b=await r.json().catch(()=>({}));
      if(r.status===403){window.location.replace("/");return;}
      if(!r.ok)throw new Error(b.error||`API ${r.status}`);
      setData(b);
      if(!brokerName && b.brokers?.length) setBrokerName(b.brokers[0].name);
    }catch(e){setMessage(e instanceof Error?e.message:"Falha ao carregar.");}
    finally{setLoading(false);}
  },[session?.access_token,brokerName]);

  useEffect(()=>{if(session?.access_token)load();},[session?.access_token]);

  const config=useMemo(()=>Object.fromEntries((data?.config||[]).map(x=>[x.config_key,x.config_value])),[data]);
  const automationEnabled=config.automation_enabled===true;
  const eligible=(data?.brokers||[]).filter(b=>b.oncall_eligible!==false);
  const upcoming=(data?.shifts||[]).filter(s=>s.shift_date>=new Date().toISOString().slice(0,10));
  const answered=(data?.shifts||[]).filter(s=>s.checkin_status==="ANSWERED").length;

  async function api(body:Record<string,unknown>){
    if(!session?.access_token)throw new Error("Sessão ausente");
    const r=await fetch(API_URL,{method:"POST",headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY,"content-type":"application/json"},body:JSON.stringify(body)});
    const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b.error||`API ${r.status}`); return b;
  }

  async function createShift(e:FormEvent){
    e.preventDefault(); if(!brokerName||!date||!end)return;
    setSaving(true);setMessage("");
    try{
      const startIso=start?new Date(start).toISOString():null;
      const endIso=new Date(end).toISOString();
      await api({action:"sync_shifts",shifts:[{broker_name:brokerName,shift_date:date,starts_at:startIso,ends_at:endIso,source_type:"MANUAL",sync_key:`manual:${date}:${brokerName}:${startIso||""}:${endIso}`} ]});
      setMessage("Plantão cadastrado. A automação continua desligada até os números serem vinculados.");
      setStart("");setEnd("");await load();
    }catch(e){setMessage(e instanceof Error?e.message:"Falha ao cadastrar plantão.");}
    finally{setSaving(false);}
  }

  if(!ready)return <main className="voc-loading">Validando acesso…</main>;
  if(!session)return null;

  return <main className="voc-shell">
    <header className="voc-head">
      <div><span>VIEW IMÓVEIS · ACOMPANHAMENTO DE PLANTÃO</span><h1>Central de Plantões</h1><p>Sem dependência de DOC: a escala pode ser lançada manualmente por enquanto. Quando os telefones chegarem, vinculamos e liberamos o disparo.</p></div>
      <button onClick={load} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button>
    </header>

    <section className="voc-kpis">
      <article><small>CORRETORES</small><b>{eligible.length}</b><span>aptos ou não bloqueados</span></article>
      <article><small>PRÓXIMOS PLANTÕES</small><b>{upcoming.length}</b><span>cadastrados manualmente</span></article>
      <article><small>CHECK-INS RESPONDIDOS</small><b>{answered}</b><span>histórico carregado</span></article>
      <article className={automationEnabled?"ok":"warn"}><small>AUTOMAÇÃO</small><b>{automationEnabled?"ON":"OFF"}</b><span>{automationEnabled?"disparos liberados":"segura até termos os números"}</span></article>
    </section>

    {message&&<div className="voc-message">{message}</div>}

    <section className="voc-grid">
      <form className="voc-card" onSubmit={createShift}>
        <div className="voc-card-head"><div><small>ESCALA MANUAL</small><h2>Novo plantão</h2></div><span>V1 sem DOC</span></div>
        <label>Corretor<select value={brokerName} onChange={e=>setBrokerName(e.target.value)}>{eligible.map(b=><option key={b.id} value={b.name}>{b.display_name||b.name}</option>)}</select></label>
        <div className="voc-two"><label>Data<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>Início<input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/></label></div>
        <label>Fim do plantão<input required type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}/></label>
        <p className="voc-help">O check-in fica programado para alguns minutos depois do fim do plantão. Sem telefone, nada é enviado.</p>
        <button className="voc-primary" disabled={saving}>{saving?"Salvando…":"Cadastrar plantão"}</button>
      </form>

      <section className="voc-card voc-wide">
        <div className="voc-card-head"><div><small>AGENDA</small><h2>Plantões cadastrados</h2></div><span>{upcoming.length} próximos</span></div>
        <div className="voc-table-wrap"><table><thead><tr><th>Data</th><th>Corretor</th><th>Fim</th><th>Check-in</th><th>Resumo</th></tr></thead><tbody>
          {(data?.shifts||[]).map(s=><tr key={s.shift_id}><td>{s.shift_date.split("-").reverse().join("/")}</td><td><b>{s.broker_name}</b>{s.source_type==="FIXTURE"&&<small className="voc-fixture">FICTICIO</small>}</td><td>{fmt(s.ends_at)}</td><td><span className={`voc-pill ${(s.checkin_status||"PENDING").toLowerCase()}`}>{s.checkin_status||"PENDING"}</span></td><td>{s.checkin_status==="ANSWERED"?`${s.leads_received??0} leads · ${s.visits_scheduled??0} visitas · ${s.proposals??0} propostas · ${s.sales??0} vendas`:s.scheduled_send_at?`previsto ${fmt(s.scheduled_send_at)}`:"aguardando horário"}</td></tr>)}
          {!data?.shifts?.length&&<tr><td colSpan={5} className="voc-empty">Nenhum plantão cadastrado ainda.</td></tr>}
        </tbody></table></div>
      </section>
    </section>

    <section className="voc-card voc-template">
      <div className="voc-card-head"><div><small>CHECK-IN</small><h2>Mensagem preparada</h2></div><span>WhatsApp · Z-API</span></div>
      <pre>{data?.template||""}</pre>
    </section>
  </main>;
}
